/**
 * CM-Master-Periscope-Googlesheets - Apps Script Web App
 *
 * NEW, INDEPENDENT PROJECT. It shares nothing (no Script Properties, no
 * deployment, no sheet) with the FedEx REP-1901 pipeline
 * (daralan2412/FX-periscope-googlesheets) or the old PTY wheelchair pipeline
 * (daralan2412/periscope-to-sheets). Those are left completely alone.
 *
 * Source:  Sisense/Periscope shared report "Copa - Master Report"
 *          https://app.periscopedata.com/shared/c9658b54-aaa9-43a7-afa7-de6f6c3242bb
 * Target:  Google Drive folder 1o6e1Q_zZj-Dpi8OSVnIs5kUcttGWZpEP, which holds one
 *          spreadsheet per month named "<M>_<YYYY>_CM_RD" (no zero padding:
 *          "8_2026_CM_RD", "9_2026_CM_RD", "12_2026_CM_RD"). Each file's FIRST
 *          tab holds the 35-column data with the header row below.
 *
 * Contract with the scraper (scrape_and_upload.py):
 *   GET  ?token=...                -> {success:true} health check
 *   POST ?token=...  {"rows":[[...35 cols...], ...]}
 *        Every posted row is routed to the monthly file that matches the
 *        row's own "date" column (column B) - 08/31/2026 -> 8_2026_CM_RD,
 *        09/01/2026 -> 9_2026_CM_RD - regardless of when the run happened.
 *        A monthly file that does not exist yet is created in the folder
 *        with the header row (so January 2027 needs no manual setup).
 *        Rows are UPSERTED (v4): a mission_sas_id already in the file has
 *        its row overwritten in place (freshest scrape wins), new ids are
 *        appended - so re-posting D-1/D0 four times a day never grows the
 *        file with duplicates. Then every touched file (plus the current
 *        month's file) gets a cleanup pass over columns A:B only:
 *          1. rows whose "date" belongs to a DIFFERENT month/year than the
 *             file are DELETED (per instruction: "check if a mission from
 *             other month is in the wrong file and delete");
 *          2. stray duplicate mission_sas_id rows (hand-pasted data) are
 *             collapsed to the LAST occurrence.
 *        The cleanup only writes when something has to be removed.
 *
 * Both endpoints require ?token=<AUTH_TOKEN> (Script Property, Project
 * Settings > Script Properties). Put the same value in the GitHub secret
 * WEBAPP_TOKEN.
 *
 * Deploy: Deploy > New deployment > Web app, Execute as: Me, Who has access:
 * Anyone. The /exec URL goes in the GitHub secret SHEETS_WEBAPP_URL.
 * Remember: editing this code does NOT change the live /exec until you
 * Deploy > Manage deployments > Edit > Version: New version.
 */

var FOLDER_ID = '1o6e1Q_zZj-Dpi8OSVnIs5kUcttGWZpEP';
var FILE_SUFFIX = '_CM_RD';        // file name = <month>_<year> + FILE_SUFFIX
var MISSION_ID_COL = 1;            // column A = mission_sas_id (1-based)
var DATE_COL = 2;                  // column B = date (MM/DD/YYYY text)
var TZ = 'America/Panama';         // only used when a date cell is a real Date

// Header row exactly as it exists in the monthly files today (including the
// two historical spellings "dest_cuty" and "asign_time"). Column ORDER is
// what matters - it matches the Periscope CSV export column for column.
var HEADERS = [
  'mission_sas_id', 'date', 'station', 'airline_code', 'tail_number', 'vessel_description',
  'job_name', 'mission_name', 'arr_flt', 'dep_flt', 'org_city', 'dest_cuty', 'arr_time',
  'dep_time', 'disp_name', 'agent_name', 'mission_notes', 'asign_time', 'start_time',
  'finish_time',
  'task_1', 'task_2', 'task_3', 'task_4', 'task_5', 'task_6', 'task_7', 'task_8', 'task_9',
  'task_10', 'task_11', 'task_12', 'task_13', 'task_14', 'task_15'
];

// GET ?token=...                      -> health check
// GET ?token=...&action=restore_text&file=9_2026_CM_RD
//                                     -> one-off repair (see debugRestoreTextCells)
// GET ?token=...&action=rebuild&file=9_2026_CM_RD
//                                     -> dedupe + wrong-month cleanup on one file
function doGet(e) {
  if (!checkToken_(e)) return jsonOut_({ success: false, error: 'unauthorized' });
  try {
    var action = e.parameter.action || '';
    if (action === 'restore_text') {
      var msg = debugRestoreTextCells(e.parameter.file);
      return jsonOut_({ success: true, action: action, result: msg });
    }
    if (action === 'rebuild') {
      var m = String(e.parameter.file || '').match(/^(\d{1,2})_(\d{4})_CM_RD$/);
      if (!m) return jsonOut_({ success: false, error: 'file must look like 9_2026_CM_RD' });
      var sh = findMonthSheet_(DriveApp.getFolderById(FOLDER_ID), m[1] + '_' + m[2]);
      if (!sh) return jsonOut_({ success: false, error: 'file not found' });
      return jsonOut_({ success: true, action: action, result: rebuildSheet_(sh, m[1] + '_' + m[2]) });
    }
    var folder = DriveApp.getFolderById(FOLDER_ID);
    return jsonOut_({ success: true, message: 'ok', folder: folder.getName() });
  } catch (err) {
    return jsonOut_({ success: false, error: 'doGet failed: ' + err });
  }
}

function doPost(e) {
  if (!checkToken_(e)) return jsonOut_({ success: false, error: 'unauthorized' });

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut_({ success: false, error: 'invalid JSON body: ' + err });
  }
  var rows = body.rows || [];

  // Serialize concurrent runs (a late-firing cron overlapping a manual run)
  // so two rebuilds never interleave on the same file.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) {
    return jsonOut_({ success: false, error: 'another upload is in progress (lock timeout)' });
  }

  try {
    var folder = DriveApp.getFolderById(FOLDER_ID);

    // 1. Route every row to its month by its own "date" column.
    var groups = {};           // "9_2026" -> [rows]
    var unroutable = 0;
    rows.forEach(function (row) {
      row = normalizeWidth_(row);
      var ym = monthKeyFromCell_(row[DATE_COL - 1]);
      if (!ym) { unroutable++; return; }
      (groups[ym] = groups[ym] || []).push(row);
    });

    // 2. UPSERT each group into its monthly file (creating the file if
    //    needed): a posted mission_sas_id that already exists in the file
    //    overwrites its row in place (freshest scrape wins), everything else
    //    is appended. This replaces the v1-v3 "append everything, then
    //    rewrite the whole tab to dedupe" approach, which re-read and
    //    re-wrote every cell of the month on every run (~900k cells by
    //    month end - too slow for the scraper's HTTP timeout and Apps
    //    Script's 6-minute cap).
    var touched = {};          // "9_2026" -> Sheet
    var perFile = {};          // "9_2026_CM_RD" -> stats
    Object.keys(groups).forEach(function (ym) {
      var sheet = getOrCreateMonthSheet_(folder, ym);
      var u = upsertRows_(sheet, groups[ym]);
      touched[ym] = sheet;
      perFile[ym + FILE_SUFFIX] = {
        rows_received: groups[ym].length,
        rows_updated: u.updated,
        rows_appended: u.appended
      };
    });

    // 3. Always also check the current month's file (Panama time), so the
    //    cross-month cleanup runs even on a run that posted zero rows there.
    var nowYm = monthKeyFromDate_(new Date());
    if (!touched[nowYm]) {
      var cur = findMonthSheet_(folder, nowYm);
      if (cur) touched[nowYm] = cur;
    }

    // 4. Cleanup pass on every touched file: delete rows whose date belongs
    //    to another month, and any duplicate mission_sas_id rows that were
    //    not created by this pipeline (e.g. hand-pasted data). Reads only
    //    columns A:B, and only rewrites when something has to go.
    var totalDupes = 0, totalWrongMonth = 0;
    Object.keys(touched).forEach(function (ym) {
      var r = rebuildSheet_(touched[ym], ym);
      var name = ym + FILE_SUFFIX;
      perFile[name] = perFile[name] || { rows_received: 0, rows_updated: 0, rows_appended: 0 };
      perFile[name].duplicates_removed = r.duplicates;
      perFile[name].wrong_month_removed = r.wrongMonth;
      perFile[name].total_rows = r.total;
      totalDupes += r.duplicates;
      totalWrongMonth += r.wrongMonth;
    });

    var totalUpdated = 0, totalAppended = 0;
    Object.keys(perFile).forEach(function (k) {
      totalUpdated += perFile[k].rows_updated || 0;
      totalAppended += perFile[k].rows_appended || 0;
    });

    return jsonOut_({
      success: true,
      rows_received: rows.length,
      rows_unroutable: unroutable,
      rows_updated: totalUpdated,
      rows_appended: totalAppended,
      duplicates_removed: totalDupes,
      wrong_month_removed: totalWrongMonth,
      files: perFile
    });
  } catch (err) {
    return jsonOut_({ success: false, error: 'doPost failed: ' + err });
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Month routing helpers
// ---------------------------------------------------------------------------

// "9_2026" from a date cell. Accepts the Periscope/CSV text forms
// "MM/DD/YYYY", "M/D/YYYY", "YYYY-MM-DD[ hh:mm...]" and real Date objects
// (in case a cell was ever auto-converted by Sheets). Returns null when the
// cell can't be read as a date.
function monthKeyFromCell_(v) {
  if (v === null || v === undefined || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
    return monthKeyFromDate_(v);
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);          // MM/DD/YYYY
  if (m) return parseInt(m[1], 10) + '_' + m[3];
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                // YYYY-MM-DD
  if (m) return parseInt(m[2], 10) + '_' + m[1];
  return null;
}

function monthKeyFromDate_(d) {
  return Utilities.formatDate(d, TZ, 'M') + '_' + Utilities.formatDate(d, TZ, 'yyyy');
}

function findMonthSheet_(folder, ym) {
  var name = ym + FILE_SUFFIX;
  var files = folder.getFilesByName(name);
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
      return firstDataSheet_(SpreadsheetApp.openById(f.getId()));
    }
  }
  return null;
}

function getOrCreateMonthSheet_(folder, ym) {
  var existing = findMonthSheet_(folder, ym);
  if (existing) return existing;

  var name = ym + FILE_SUFFIX;
  var ss = SpreadsheetApp.create(name);
  var file = DriveApp.getFileById(ss.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file); // move out of My Drive root
  var sheet = ss.getSheets()[0];
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.setFrozenRows(1);
  sheet.getRange(2, 1, sheet.getMaxRows() - 1, HEADERS.length).setNumberFormat('@');
  return sheet;
}

// The data lives in the first tab (named "Untitled" in the existing files).
// Prefer a tab whose A1 is mission_sas_id, fall back to the first tab, and
// write the header if the tab is empty.
function firstDataSheet_(ss) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (String(sheets[i].getRange(1, 1).getValue()).trim() === HEADERS[0]) return sheets[i];
  }
  var sheet = sheets[0];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Upsert: overwrite rows whose mission_sas_id already exists, append the rest
// ---------------------------------------------------------------------------

function upsertRows_(sheet, batch) {
  var lastRow = sheet.getLastRow();

  // Existing ids -> sheet row number (last occurrence wins if the file has
  // stray duplicates; the cleanup pass removes those separately).
  var rowById = {};
  if (lastRow >= 2) {
    var ids = sheet.getRange(2, MISSION_ID_COL, lastRow - 1, 1).getValues();
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]).trim();
      if (id) rowById[id] = i + 2;
    }
  }

  // Collapse the batch itself by id (last posted wins), then split into
  // in-place updates and appends. Rows with a blank id are always appended.
  var updates = {};      // sheet row number -> row values
  var appendsById = {};  // id -> row values (dedupe within the batch)
  var appendOrder = [];
  var blankIdRows = [];
  batch.forEach(function (row) {
    var id = String(row[MISSION_ID_COL - 1]).trim();
    if (!id) { blankIdRows.push(row); return; }
    if (rowById[id]) { updates[rowById[id]] = row; return; }
    if (!appendsById.hasOwnProperty(id)) appendOrder.push(id);
    appendsById[id] = row;
  });

  // Write updates in contiguous blocks (rows of the same day were appended
  // together by an earlier run, so a re-sync usually touches 1-3 blocks).
  var rowNums = Object.keys(updates).map(Number).sort(function (a, b) { return a - b; });
  var updated = 0;
  var b = 0;
  while (b < rowNums.length) {
    var e = b;
    while (e + 1 < rowNums.length && rowNums[e + 1] === rowNums[e] + 1) e++;
    var block = [];
    for (var r = b; r <= e; r++) block.push(updates[rowNums[r]]);
    var rng = sheet.getRange(rowNums[b], 1, block.length, HEADERS.length);
    rng.setNumberFormat('@'); // see doPost: text cells, never locale-parsed
    rng.setValues(block);
    updated += block.length;
    b = e + 1;
  }

  var appends = appendOrder.map(function (id) { return appendsById[id]; }).concat(blankIdRows);
  if (appends.length > 0) {
    var target = sheet.getRange(lastRow + 1, 1, appends.length, HEADERS.length);
    target.setNumberFormat('@');
    target.setValues(appends);
  }
  return { updated: updated, appended: appends.length };
}

// ---------------------------------------------------------------------------
// Cleanup: remove wrong-month rows + stray duplicate mission_sas_id rows
// ---------------------------------------------------------------------------

// Scans only columns A:B. When nothing has to be removed (the normal case
// now that doPost upserts) it returns without touching the sheet. When rows
// must go, it deletes them in contiguous blocks from the bottom up, or - if
// they are scattered across many blocks - falls back to one full rewrite.
function rebuildSheet_(sheet, ym) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  if (lastRow < 2) return { duplicates: 0, wrongMonth: 0, total: 0 };

  var ab = sheet.getRange(2, 1, lastRow - 1, 2).getValues();

  // Wrong-month rows first, so a stray row from another month can never
  // "win" the duplicate check against a legitimate in-month row.
  var wrong = {};
  var wrongMonth = 0;
  for (var w = 0; w < ab.length; w++) {
    var key = monthKeyFromCell_(ab[w][1]);
    if (key && key !== ym) { wrong[w] = true; wrongMonth++; }
  }

  var lastIndexById = {};
  for (var j = 0; j < ab.length; j++) {
    if (wrong[j]) continue;
    var id = String(ab[j][0]).trim();
    if (id) lastIndexById[id] = j;
  }

  var toDelete = [];   // 0-based indexes into ab
  var duplicates = 0;
  for (var i = 0; i < ab.length; i++) {
    if (wrong[i]) { toDelete.push(i); continue; }
    var idI = String(ab[i][0]).trim();
    if (idI && lastIndexById[idI] !== i) { duplicates++; toDelete.push(i); }
  }

  var total = ab.length - toDelete.length;
  if (toDelete.length === 0) return { duplicates: 0, wrongMonth: 0, total: total };

  // Group into contiguous blocks.
  var blocks = [];
  for (var k = 0; k < toDelete.length; k++) {
    if (blocks.length && toDelete[k] === blocks[blocks.length - 1].end + 1) {
      blocks[blocks.length - 1].end = toDelete[k];
    } else {
      blocks.push({ start: toDelete[k], end: toDelete[k] });
    }
  }

  if (blocks.length <= 50) {
    // Bottom-up so earlier row numbers stay valid.
    for (var bi = blocks.length - 1; bi >= 0; bi--) {
      sheet.deleteRows(blocks[bi].start + 2, blocks[bi].end - blocks[bi].start + 1);
    }
  } else {
    // Many scattered rows: one read + one write is cheaper than hundreds of
    // deleteRows calls.
    var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
    var drop = {};
    toDelete.forEach(function (x) { drop[x] = true; });
    var kept = [];
    for (var d = 0; d < data.length; d++) if (!drop[d]) kept.push(data[d]);
    sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
    if (kept.length > 0) {
      var dest = sheet.getRange(2, 1, kept.length, lastCol);
      dest.setNumberFormat('@');
      dest.setValues(kept);
    }
  }
  return { duplicates: duplicates, wrongMonth: wrongMonth, total: total };
}

// ---------------------------------------------------------------------------
// Misc
// ---------------------------------------------------------------------------

function normalizeWidth_(row) {
  row = row || [];
  if (row.length < HEADERS.length) return row.concat(new Array(HEADERS.length - row.length).fill(''));
  if (row.length > HEADERS.length) return row.slice(0, HEADERS.length);
  return row;
}

function checkToken_(e) {
  var token = PropertiesService.getScriptProperties().getProperty('AUTH_TOKEN');
  return !!token && e && e.parameter && e.parameter.token === token;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// Manual helper: run once from the editor to grant Drive/Sheets scopes and
// confirm the folder is reachable and which monthly files exist.
function debugListFolder() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFiles();
  var names = [];
  while (files.hasNext()) names.push(files.next().getName());
  Logger.log(folder.getName() + ': ' + names.sort().join(', '));
  Logger.log('current month key (' + TZ + '): ' + monthKeyFromDate_(new Date()));
}

// One-off repair helper. The v1 rebuild (before setNumberFormat('@') was
// added) rewrote 9_2026_CM_RD's legacy rows with plain setValues, and Sheets
// parsed the text dates/datetimes/numbers into real Date/number cells
// ("09/01/2026" -> 1/09/2026, "08/31/2026 13:31" -> 31/08/2026). This turns
// every non-string cell back into the original text form and marks the
// whole data range as text so it can't happen again. Safe to re-run.
var DATETIME_COLS = [13, 14, 18, 19, 20]; // arr_time, dep_time, asign_time, start_time, finish_time
function debugRestoreTextCells(fileName) {
  fileName = fileName || '9_2026_CM_RD';
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByName(fileName);
  if (!files.hasNext()) throw new Error('not found: ' + fileName);
  var ss = SpreadsheetApp.openById(files.next().getId());
  var tz = ss.getSpreadsheetTimeZone();
  var sheet = firstDataSheet_(ss);
  var lastRow = sheet.getLastRow(), lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  if (lastRow < 2) return;
  var rng = sheet.getRange(2, 1, lastRow - 1, lastCol);
  var data = rng.getValues();
  var changed = 0;
  for (var i = 0; i < data.length; i++) {
    for (var c = 0; c < data[i].length; c++) {
      var v = data[i][c];
      if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v)) {
        var fmt = DATETIME_COLS.indexOf(c + 1) >= 0 ? 'MM/dd/yyyy HH:mm' : 'MM/dd/yyyy';
        data[i][c] = Utilities.formatDate(v, tz, fmt);
        changed++;
      } else if (typeof v === 'number') {
        data[i][c] = String(v);
        changed++;
      }
    }
  }
  rng.setNumberFormat('@');
  rng.setValues(data);
  var msg = fileName + ': ' + changed + ' cells restored to text across ' + data.length + ' rows (tz ' + tz + ')';
  Logger.log(msg);
  return msg;
}

// Manual helper: run the cleanup/dedupe on every monthly file in the folder
// without posting anything (useful once after setup).
function debugRebuildAll() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var files = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (files.hasNext()) {
    var f = files.next();
    var m = f.getName().match(/^(\d{1,2})_(\d{4})_CM_RD$/);
    if (!m) continue;
    var r = rebuildSheet_(firstDataSheet_(SpreadsheetApp.openById(f.getId())), m[1] + '_' + m[2]);
    Logger.log(f.getName() + ': ' + JSON.stringify(r));
  }
}

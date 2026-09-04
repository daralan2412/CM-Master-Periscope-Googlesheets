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
 *        After appending, every touched file (plus the current month's file)
 *        is rebuilt in one pass:
 *          1. rows whose "date" belongs to a DIFFERENT month/year than the
 *             file are DELETED (per instruction: "check if a mission from
 *             other month is in the wrong file and delete");
 *          2. duplicate mission_sas_id rows are collapsed to the LAST
 *             occurrence (most recently posted = freshest scrape).
 *        The rebuild reads the whole tab once and writes it back once
 *        (clearContents + setValues) instead of deleteRow() per row, which
 *        is far faster on the ~thousands-of-rows monthly files.
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

    // 2. Append each group to its monthly file (creating the file if needed).
    var touched = {};          // "9_2026" -> Sheet
    var perFile = {};          // "9_2026_CM_RD" -> stats
    Object.keys(groups).forEach(function (ym) {
      var sheet = getOrCreateMonthSheet_(folder, ym);
      var batch = groups[ym];
      var target = sheet.getRange(sheet.getLastRow() + 1, 1, batch.length, HEADERS.length);
      // Force plain-text cells BEFORE writing. Without this, Sheets parses
      // "09/03/2026" into a real Date using the spreadsheet's locale - and
      // under a dd/mm locale that is 9 March, so the rebuild below then
      // read the freshly appended rows as "3_2026" and deleted all 1721 of
      // them as wrong-month (CI run #1, 2026-09-04). The existing rows in
      // the monthly files are text, so this also keeps the files uniform.
      target.setNumberFormat('@');
      target.setValues(batch);
      touched[ym] = sheet;
      perFile[ym + FILE_SUFFIX] = { rows_received: batch.length };
    });

    // 3. Always also check the current month's file (Panama time), so the
    //    cross-month cleanup runs even on a run that posted zero rows there.
    var nowYm = monthKeyFromDate_(new Date());
    if (!touched[nowYm]) {
      var cur = findMonthSheet_(folder, nowYm);
      if (cur) touched[nowYm] = cur;
    }

    // 4. Rebuild every touched file: drop wrong-month rows, dedupe by id.
    var totalDupes = 0, totalWrongMonth = 0;
    Object.keys(touched).forEach(function (ym) {
      var r = rebuildSheet_(touched[ym], ym);
      var name = ym + FILE_SUFFIX;
      perFile[name] = perFile[name] || { rows_received: 0 };
      perFile[name].duplicates_removed = r.duplicates;
      perFile[name].wrong_month_removed = r.wrongMonth;
      perFile[name].total_rows = r.total;
      totalDupes += r.duplicates;
      totalWrongMonth += r.wrongMonth;
    });

    return jsonOut_({
      success: true,
      rows_received: rows.length,
      rows_unroutable: unroutable,
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
// Rebuild: remove wrong-month rows + duplicate mission_sas_id rows
// ---------------------------------------------------------------------------

function rebuildSheet_(sheet, ym) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), HEADERS.length);
  if (lastRow < 2) return { duplicates: 0, wrongMonth: 0, total: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  // Pass 1: drop rows whose own date says they belong to another month's
  // file. Rows with an unreadable/blank date are kept (never guess).
  var wrongMonth = 0;
  var inMonth = [];
  for (var i = 0; i < data.length; i++) {
    var key = monthKeyFromCell_(data[i][DATE_COL - 1]);
    if (key && key !== ym) { wrongMonth++; continue; }
    inMonth.push(data[i]);
  }

  // Pass 2: keep the LAST occurrence of each non-blank mission_sas_id.
  var lastIndexById = {};
  for (var j = 0; j < inMonth.length; j++) {
    var id = String(inMonth[j][MISSION_ID_COL - 1]).trim();
    if (id) lastIndexById[id] = j;
  }
  var kept = [];
  var duplicates = 0;
  for (var k = 0; k < inMonth.length; k++) {
    var idK = String(inMonth[k][MISSION_ID_COL - 1]).trim();
    if (idK && lastIndexById[idK] !== k) { duplicates++; continue; }
    kept.push(inMonth[k]);
  }

  // Skip entirely-blank rows that can sit under the data.
  kept = kept.filter(function (r) {
    return r.some(function (c) { return c !== '' && c !== null; });
  });

  var removed = data.length - kept.length;
  if (removed > 0) {
    var whole = sheet.getRange(2, 1, lastRow - 1, lastCol);
    whole.clearContent();
    if (kept.length > 0) {
      var dest = sheet.getRange(2, 1, kept.length, lastCol);
      dest.setNumberFormat('@'); // keep text as text when rows shift upward
      dest.setValues(kept);
    }
  }
  return { duplicates: duplicates, wrongMonth: wrongMonth, total: kept.length };
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

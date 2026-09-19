# CM-Master-Periscope-Googlesheets

Pulls the Sisense/Periscope shared report **"Copa - Master Report"** into
per-month Google Sheets, four times a day, on GitHub Actions.

This is a **new, independent pipeline**. It shares nothing with
`daralan2412/FX-periscope-googlesheets` (FedEx REP-1901) or
`daralan2412/periscope-to-sheets` (PTY wheelchair) - different report,
different sheets, different Apps Script project, different secrets.

## What it does

| | |
|---|---|
| Source | https://app.periscopedata.com/shared/c9658b54-aaa9-43a7-afa7-de6f6c3242bb (widget "Data", 35 columns) |
| Window | **D0 to D-2** (today, yesterday, day before; America/Panama) on every run, **plus one older 3-day backfill chunk** that rotates with the run slot: 00:07 → D-5..D-3, 06:07 → D-8..D-6, 12:07 → D-11..D-9, 18:07 → D-14..D-12. Spec was D0-D-1; widened because the source lags and adds rows up to a week later (see below) |
| Schedule | **00:07, 06:07, 12:07, 18:07 America/Panama** (`7 5,11,17,23 * * *` UTC) + manual `workflow_dispatch`. Was :01; moved off the top of the hour on 2026-09-19 because GitHub was starting those runs 2-4 h late (see below) |
| Target | Drive folder https://drive.google.com/drive/folders/1o6e1Q_zZj-Dpi8OSVnIs5kUcttGWZpEP - one file per month, `<M>_<YYYY>_CM_RD` (`8_2026_CM_RD`, `9_2026_CM_RD`, ...), first tab |
| Routing | each row goes to the file matching **its own `date` column** - a run on 1 Sep that pulls 31 Aug + 1 Sep rows writes to `8_2026_CM_RD` **and** `9_2026_CM_RD` |
| Dedupe | **upsert** by `mission_sas_id`: an id already in the file is overwritten in place, new ids are appended (freshest scrape wins, file never grows with duplicates) |
| Cleanup | any row whose `date` is from a different month than the file it sits in is **deleted** |
| Missing file | a month file that doesn't exist yet is created in the folder with the header row |

## How it works

1. `scrape_and_upload.py` (GitHub Actions, Python 3.11 + Playwright Chromium)
   opens the report, picks **Custom Range** in the Date Range filter, types
   the window's start / end (MM/DD/YYYY), applies, waits for the Data widget
   to settle, clicks its **Download Data** CSV export and polls the
   `/download_csv/` URL until it returns 200. It does this twice per run:
   the primary D-2..D0 window and one rotating backfill chunk (each posted
   separately). The primary window failing fails the run; a backfill chunk
   failing is logged and simply comes around again the next day.
2. It POSTs `{"rows": [[...35 cols...], ...]}` to the Apps Script Web App
   (`apps-script/Code.gs`) with `?token=`.
3. The Web App groups rows by month (from column B `date`) and upserts each
   group into its monthly file (existing ids overwritten in place, new ids
   appended), then runs a cleanup over columns A:B of every touched file
   plus the current month's file: wrong-month rows and any stray duplicate
   `mission_sas_id` rows are deleted. The cleanup only writes when it finds
   something to remove.

The browser-driving code is the hardened **v4.1** logic from the FedEx
pipeline (see the module docstring for the list of Sisense traps it works
around: hidden `.error-message` placeholder, datepicker ignoring `.fill()`,
wrong breadcrumb selector, slow default "All Dates" query at scheduled hours).

## Files

- `scrape_and_upload.py` - the scraper (v1.5, 2026-09-19).
- `.github/workflows/run.yml` - schedule + manual trigger; uploads
  `debug_failure.png/.html` as artifacts when a run fails.
- `apps-script/Code.gs`, `apps-script/appsscript.json` - the Web App
  (copy of what is deployed; editing here does not redeploy it).
- `requirements.txt` - `requests`, `playwright`.

## Secrets (GitHub > Settings > Secrets and variables > Actions)

- `SHEETS_WEBAPP_URL` - the Web App `/exec` URL.
- `WEBAPP_TOKEN` - must equal the Apps Script Script Property `AUTH_TOKEN`.

## Reading a run

A green check is **not** proof of success (the script exits 0 when the
widget genuinely has no rows). Open the "Run scrape and upload" step and
look for:

```
Windows this run (America/Panama): primary D-2..D0 = 09/16/2026..09/18/2026; backfill slot 3 D-14..D-12 = 09/04/2026..09/06/2026
Pulling 'Copa - Master Report' data for 09/16/2026 to 09/18/2026 (primary D-2..D0)...
Scraped 6505 rows for 09/16/2026 to 09/18/2026.
Posted 6505 rows: 6483 updated in place, 22 appended; 0 stray duplicate row(s) removed, 0 wrong-month row(s) removed, 0 row(s) had no readable date and were skipped.
  9_2026_CM_RD: {'rows_received': 6505, 'rows_updated': 6483, 'rows_appended': 22, 'duplicates_removed': 0, 'wrong_month_removed': 0, 'total_rows': 38757}
Pulling 'Copa - Master Report' data for 09/04/2026 to 09/06/2026 (backfill slot 3 D-14..D-12)...
Scraped 6495 rows for 09/04/2026 to 09/06/2026.
Posted 6495 rows: 6495 updated in place, 0 appended; ...
```

Large "updated in place" counts are normal - every run re-posts the last
three days; "appended" is what is actually new since the previous run.
A scrape step that finishes in single-digit seconds did not do the work.

## One-off catch-up (manual backfill)

Actions > the workflow > **Run workflow** and fill `backfill_start` /
`backfill_end` (MM/DD/YYYY). The run pulls D-2..D0 as usual and then that
whole range in 3-day pieces instead of the rotating chunk. Same thing from
any machine: `BACKFILL_START=09/01/2026 BACKFILL_END=09/12/2026 python
scrape_and_upload.py`. Safe to repeat - everything is upserted.

## Admin actions (GET, token-gated)

- `?token=...` - health check.
- `?token=...&action=rebuild&file=9_2026_CM_RD` - run the dedupe +
  wrong-month cleanup on one file without posting anything.
- `?token=...&action=restore_text&file=9_2026_CM_RD` - one-off repair that
  turns any Date/number cells back into the text form (`MM/dd/yyyy`,
  `MM/dd/yyyy HH:mm`) and marks the data range as plain text.

## Lessons from the first runs (2026-09-04)

- **Write cells as plain text.** `setValues()` on automatic-format cells
  lets Sheets parse `09/03/2026` as a Date using the spreadsheet's locale
  (these files are `America/Los_Angeles` / dd-mm style), so run #1 saw all
  1721 fresh rows as March and deleted them as wrong-month. The Web App now
  calls `setNumberFormat('@')` on a range before every `setValues()`, and
  `restore_text` exists to undo the one file that was converted.
- A green Actions check is not success: run #1 was green while posting 0
  usable rows. Read the per-file line.
- **Don't rewrite the whole month every run.** v1-v3 appended everything
  and then re-read/re-wrote the entire tab to dedupe - fine at 6k rows,
  not at the ~25k rows a month reaches. v4 upserts by id and the cleanup
  reads only columns A:B.

## Why "today" is usually empty

The Periscope report does **not** have same-day rows: on 2026-09-04 at 08:55
Panama an explicit `09/04-09/04` filter returned "Query returned no matching
rows", and rows dated 09/03 were still being added 8+ hours into 09/04
(1721 at 01:19, 2122 at 08:10). The source loads with a lag of hours (and
may simply exclude the current day). So:

- the file for a day fills up during the *following* day;
- each run re-pulls D-2..D0 and the Web App upserts, so late rows are picked
  up by the next run at no cost;
- `rows_appended` in the log is the real "new since last run" number.

## Lessons from the first two weeks (2026-09-19)

- **Scheduled runs at :01 start hours late.** GitHub queues `schedule`
  events behind everything else scheduled at that minute and documents the
  start of every hour as its peak; between 09-04 and 09-18 the :01 slots
  routinely started 2-4 hours late (the 18:01 slot at 20:06), which made
  the pipeline look stuck. The crons now fire at :07. A late run still
  pulls the right days because the window is computed at run time.
- **Google intermittently 404s the Web App's reply.** Apps Script answers
  through a 302 to a one-time `script.googleusercontent.com/macros/echo?...`
  URL, and 3 of the 4 scheduled runs on 2026-09-18/19 (#61, #62, #64) died
  with `404 Client Error: Not Found for url: https://script.googleusercontent.com/macros/echo?...`.
  #61/#62 failed on the tiny health-check GET before scraping; #64 failed
  on the POST *after* the Web App had already written all 6,505 rows (the
  sheet's modified time proves it). 12 back-to-back GETs from another
  machine all returned 200 - it is a transient, not a broken deployment.
  Every Web App call now goes through `webapp_request()`, which retries
  404/408/429/5xx, connection errors, timeouts, non-JSON bodies and the
  Web App's lock-timeout message up to 4 times, 45 s apart. Re-posting is
  safe because the Web App upserts by `mission_sas_id`. A 401/403, any
  other 4xx, or an explicit `success:false` from `doGet`/`doPost` is still
  fatal on purpose - those need a human.
- **A red run is not necessarily lost data**, and a missed run is never
  lost data: every run re-pulls D-2..D0, so the next green run backfills.
- **The source keeps adding rows for about a week.** A full re-pull of
  09/01-09/18 on 2026-09-19 (six 3-day windows, 39,182 rows, zero duplicate
  ids in the export) found the sheet short by 15-23 rows on every day from
  09/01 to 09/12 (212 rows, ~1%) and exactly complete for 09/13-09/18. The
  missing rows were ordinary missions with normal same-day times, so they
  were not late *missions* - the report only exposed them ~6-7 days later,
  after the D-2..D0 window had moved on. Those 212 rows (plus 7 dated
  08/31 that belong in `8_2026_CM_RD`) were posted by hand that day, and
  every run now also re-pulls one older 3-day chunk, rotating so each day
  is re-synced at 3-5, 6-8, 9-11 and 12-14 days of age.
- **The Date Range filter is not on the `date` column.** It filters on a
  UTC timestamp (finish time): a mission dated 08/31 that finished at 19:00
  Panama (00:00 UTC 09/01) only appears in a window starting 09/01. That is
  why a 09/01-09/03 pull returns 444 rows dated 08/31 (routed to
  `8_2026_CM_RD` - correct) and why "rows received" is always a few hundred
  more than the `date` counts of the window. Harmless with the D-2 lookback.
- 6-day Sisense windows timed out three times in a row at 21:00 Panama;
  3-day windows never did. Keep chunks at 3 days.
- The scraper can be run from any machine with Python 3.11 + Playwright
  (`SHEETS_WEBAPP_URL` / `WEBAPP_TOKEN` in the environment) - that is how
  the 2026-09-19 manual catch-up was done while GitHub logs were
  unreachable; it does exactly what a scheduled run does.

## Known edge cases

- Around midnight Panama time the window still covers both days, so a
  mission logged at 23:50 is picked up by the 00:01 run.
- Periscope's `date` column decides the file, not the run time. A row dated
  08/31 pulled on 09/01 goes to `8_2026_CM_RD`.
- Rows with a blank/unreadable `date` are not written anywhere (counted as
  `rows_unroutable` in the log).
- Apps Script deployments are pinned to a version: after editing `Code.gs`
  in the Apps Script editor, **Deploy > Manage deployments > Edit > New
  version**, or the live `/exec` keeps running the old code.

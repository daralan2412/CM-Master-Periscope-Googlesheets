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
| Window | **D0 to D-1**: yesterday and today, America/Panama, computed fresh on every run |
| Schedule | **00:01, 06:01, 12:01, 18:01 America/Panama** (`1 5,11,17,23 * * *` UTC) + manual `workflow_dispatch` |
| Target | Drive folder https://drive.google.com/drive/folders/1o6e1Q_zZj-Dpi8OSVnIs5kUcttGWZpEP - one file per month, `<M>_<YYYY>_CM_RD` (`8_2026_CM_RD`, `9_2026_CM_RD`, ...), first tab |
| Routing | each row goes to the file matching **its own `date` column** - a run on 1 Sep that pulls 31 Aug + 1 Sep rows writes to `8_2026_CM_RD` **and** `9_2026_CM_RD` |
| Dedupe | by `mission_sas_id`, last-posted row wins (freshest scrape) |
| Cleanup | any row whose `date` is from a different month than the file it sits in is **deleted** |
| Missing file | a month file that doesn't exist yet is created in the folder with the header row |

## How it works

1. `scrape_and_upload.py` (GitHub Actions, Python 3.11 + Playwright Chromium)
   opens the report, picks **Custom Range** in the Date Range filter, types
   `D-1` / `D0` (MM/DD/YYYY), applies, waits for the Data widget to settle,
   clicks its **Download Data** CSV export and polls the `/download_csv/`
   URL until it returns 200.
2. It POSTs `{"rows": [[...35 cols...], ...]}` to the Apps Script Web App
   (`apps-script/Code.gs`) with `?token=`.
3. The Web App groups rows by month (from column B `date`), appends each
   group to its monthly file, then rebuilds every touched file plus the
   current month's file in a single read/write pass: wrong-month rows out,
   duplicate `mission_sas_id` rows collapsed to the last one.

The browser-driving code is the hardened **v4.1** logic from the FedEx
pipeline (see the module docstring for the list of Sisense traps it works
around: hidden `.error-message` placeholder, datepicker ignoring `.fill()`,
wrong breadcrumb selector, slow default "All Dates" query at scheduled hours).

## Files

- `scrape_and_upload.py` - the scraper (v1, 2026-09-03).
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
Pulling 'Copa - Master Report' data for 09/02/2026 to 09/03/2026 (D-1 to D0, America/Panama)...
Scraped 312 rows for 09/02/2026 to 09/03/2026.
Posted 312 rows; 290 duplicate mission_sas_id row(s) removed, 0 wrong-month row(s) removed, 0 row(s) had no readable date and were skipped.
  9_2026_CM_RD: {'rows_received': 312, 'duplicates_removed': 290, 'wrong_month_removed': 0, 'total_rows': 1180}
```

Large duplicate counts are normal - every run re-posts the last two days.
A scrape step that finishes in single-digit seconds did not do the work.

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

#!/usr/bin/env python3
"""
scrape_and_upload.py - CM-Master-Periscope-Googlesheets

NEW pipeline, independent of daralan2412/FX-periscope-googlesheets (FedEx
REP-1901) and daralan2412/periscope-to-sheets (PTY wheelchair). Both of those
are left untouched; this repo shares no secrets, sheet or Apps Script with
them.

Source: Periscope/Sisense shared report "Copa - Master Report"
        https://app.periscopedata.com/shared/c9658b54-aaa9-43a7-afa7-de6f6c3242bb
Target: one Google Sheet per month in Drive folder
        https://drive.google.com/drive/folders/1o6e1Q_zZj-Dpi8OSVnIs5kUcttGWZpEP
        named "<M>_<YYYY>_CM_RD" (8_2026_CM_RD, 9_2026_CM_RD, ...). The
        scraper does NOT pick the file - it posts every row to the Apps Script
        Web App (SHEETS_WEBAPP_URL / WEBAPP_TOKEN secrets) and the Web App
        routes each row by the row's own "date" column, so a run on
        2026-09-01 that pulls 08/31 and 09/01 rows lands them in 8_2026_CM_RD
        and 9_2026_CM_RD respectively.

Flow (runs 4x a day: 00:01, 06:01, 12:01, 18:01 America/Panama):
  1. Open the report, set the Date Range filter to a rolling "D0 to D-1"
     window (yesterday through today, America/Panama) via Custom Range with
     computed Start/End dates, then use the Data widget's own "Download Data"
     CSV export (NOT DOM scraping - the grid is virtualized, only the rows
     and columns near the viewport exist in the DOM; the CSV is generated
     server-side and is complete).
  2. POST {"rows": [[...35 cols...], ...]} to the Web App. The Web App
     appends each row to its monthly file, then rebuilds every touched file:
     rows whose "date" belongs to another month are deleted, and duplicate
     mission_sas_id rows are collapsed to the last-posted (freshest) one.
     Re-pulling D-1/D0 four times a day is therefore safe and expected -
     "N duplicates removed" in the log is the normal steady state.

The browser-driving code is the hardened v4.1 logic from the FedEx pipeline
(2026-09-02), verbatim except for the URL/timezone/window, because the two
reports are the same Sisense template with the same DOM:
  - do NOT wait for the grid / "networkidle" before applying our filter (the
    default "All Dates" query is slow at scheduled hours and we replace it);
  - "Custom Range" lives in .custom-date-option, NOT inside .radio-button-group;
  - type the dates with press_sequentially (the datepicker ignores .fill());
    no Escape (it can clear the field), no Tab; click-into-next-field commits;
  - wait for .apply-button to lose "disabled" before clicking it;
  - the real breadcrumb is ".filters-bar .filter-group .filter .label"
    (".filters-bar-label" only ever reads "Filters (N)");
  - ".error-message" is ALWAYS in the DOM (display:none) - check visibility,
    never existence, or every run silently reports "no rows";
  - whole-scrape retry with a fresh browser (SCRAPE_ATTEMPTS).
"""

import csv
import io
import json
import os
import sys
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import requests
from playwright.sync_api import sync_playwright

PERISCOPE_URL = "https://app.periscopedata.com/shared/c9658b54-aaa9-43a7-afa7-de6f6c3242bb"
LOCAL_TZ = ZoneInfo("America/Panama")  # PTY station time; UTC-5 all year (no DST).
LOOKBACK_DAYS = 1  # "D0 to D-1": yesterday and today, inclusive.
SCRAPE_ATTEMPTS = 3  # whole-scrape retries with a fresh browser (see main()).
SCRAPE_RETRY_DELAY_S = 60
WEBAPP_URL = os.environ["SHEETS_WEBAPP_URL"]
WEBAPP_TOKEN = os.environ["WEBAPP_TOKEN"]

# Column ORDER of the report's Data widget / CSV export (confirmed live
# 2026-09-03 against the grid header: mission sas id, date, station, airline
# code, tail number, vessel description, job name, mission name, arr flt,
# dep flt, org city, dest city, arr time, dep time, disp name, agent name,
# mission notes, assign time, start time, finish time, task 1..task 15).
# The NAMES below are the monthly files' existing header row (which keeps
# two historical spellings, "dest_cuty" and "asign_time"); the CSV's own
# header names may differ slightly - only the order and count matter.
HEADERS = [
    "mission_sas_id", "date", "station", "airline_code", "tail_number", "vessel_description",
    "job_name", "mission_name", "arr_flt", "dep_flt",
    "org_city", "dest_cuty", "arr_time", "dep_time", "disp_name", "agent_name", "mission_notes",
    "asign_time", "start_time", "finish_time",
    "task_1", "task_2", "task_3", "task_4", "task_5", "task_6", "task_7", "task_8", "task_9",
    "task_10", "task_11", "task_12", "task_13", "task_14", "task_15",
]


def check_token():
    """Cheap pre-flight auth check before paying for a headless-browser scrape.

    doGet() no longer decides what to pull (there's no watermark anymore),
    it's just a token/connectivity health check now.
    """
    resp = requests.get(WEBAPP_URL, params={"token": WEBAPP_TOKEN}, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"Web App auth check failed: {data}")


def compute_date_range_mmddyyyy():
    """D0 to D-1: today (America/Panama) and today minus LOOKBACK_DAYS, both
    formatted MM/DD/YYYY for Periscope's Custom Range Start/End Date inputs.
    Computed fresh on every call so the window is always "as of right now",
    not pinned to whatever day the code was last edited.
    """
    today = datetime.now(LOCAL_TZ).date()
    start = today - timedelta(days=LOOKBACK_DAYS)
    return start.strftime("%m/%d/%Y"), today.strftime("%m/%d/%Y")


def scrape_window_csv():
    """Filter the report's Data widget to a rolling D0-to-D-1 window and pull
    its CSV export.

    Uses Periscope's "Custom Range" Date Range filter with Start/End Date
    computed fresh on every run (see compute_date_range_mmddyyyy), rather
    than a built-in preset - this pins down the exact semantics ("today back
    through yesterday, inclusive") instead of relying on unclear/undocumented
    behavior of a preset like "7 Days". Verified live: filling Start/End Date
    with explicit MM/DD/YYYY values and clicking Apply correctly narrows the
    Data widget and the resulting breadcrumb to that exact range.

    Uses the widget's built-in "Download Data" export instead of scraping the
    DOM: the Data widget is a virtualized grid (rows AND columns are only
    rendered near the viewport), so a DOM scrape would silently miss most of
    a real week's rows/columns. The CSV export is generated server-side and
    is complete regardless of what happened to be scrolled into view.

    Returns the CSV text, or None if the widget shows "Query returned no
    matching rows" - Sisense doesn't even offer a "Download Data" menu item
    when there's nothing to export, so this has to be checked for explicitly
    rather than treated as a scrape failure.
    """
    start_str, end_str = compute_date_range_mmddyyyy()
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1600, "height": 1000})

        # Capture the export URL from the first matching request, then poll
        # it ourselves rather than relying on the page's own retry behavior.
        # Registered before any interaction so we can't race the request.
        export_url = {"value": None}

        def on_response(resp):
            if export_url["value"] is None and "/download_csv/" in resp.url:
                export_url["value"] = resp.url

        page.on("response", on_response)

        try:
            # "domcontentloaded" rather than "networkidle": the report's
            # default Date Range is "All Dates", so the page kicks off a
            # full-history query the moment it loads. On the scheduled
            # 7am/7pm runs that query is slow enough that "networkidle"
            # (and the old up-front wait for the grid, see below) never
            # settled in time. We don't need that unfiltered query at all
            # - we're about to replace it with our own Custom Range - so
            # don't wait on it.
            page.goto(PERISCOPE_URL, wait_until="domcontentloaded", timeout=90_000)

            # Only wait for the filters bar - that's all the next step
            # needs. NOTE: deliberately NOT waiting for ".ninja-grid" here.
            # An earlier version did, with a 30s timeout, and that is
            # exactly what every scheduled run failed on (runs #22, #23 on
            # 2026-09-01/02: "waiting for locator('.ninja-grid') to be
            # visible - Timeout 30000ms exceeded") while manual runs at
            # other times of day passed: the grid only renders once the
            # default "All Dates" query finishes, which at those hours
            # takes longer than 30s. The grid IS waited for further down,
            # after our filter is applied, with a much longer timeout.
            page.wait_for_selector(".filters-bar-label", timeout=90_000)

            # Open the report-level filters panel.
            page.locator(".filters-bar-label").first.click()
            page.wait_for_selector(".radio-button-group", timeout=30_000)
            page.wait_for_timeout(300)

            # Date Range column: select "Custom Range". Unlike the preset
            # options (Current Week, 7 Days, etc.), which live inside
            # .radio-button-group > .small-radio-button, "Custom Range" is
            # rendered in its own sibling container - .custom-date-option -
            # under .options (confirmed live via DOM inspection: a selector
            # scoped to .radio-button-group never matches it, which is why
            # an earlier version of this selector timed out in CI). It's
            # always the first item in the Date Range column, so no scroll
            # is needed to reach it. force=True because a plain click here
            # can hit a transient overlap issue while the panel settles.
            custom_range_option = page.locator(".custom-date-option .small-radio-button").first
            custom_range_option.click(force=True)
            page.wait_for_timeout(800)

            # Fill Start/End Date with the freshly computed D-1/D0 window.
            # force=True for the same transient-overlap reason as above.
            #
            # This is a jQuery UI-style datepicker (class "hasDatepicker")
            # that only registers a value in its own real filter state in
            # response to real keystrokes - a bulk .fill() (optionally
            # followed by dispatching synthetic "change"/"blur"/"focusout"
            # events) leaves the field SHOWING the right text but the
            # underlying filter state stays unset, so Apply stays disabled
            # and/or silently applies nothing (confirmed both ways in CI:
            # a bare .fill() and a .fill() + dispatch_event() combo both
            # left the Apply button with class "...apply-button disabled").
            # press_sequentially() sends one real keydown/keypress/keyup
            # per character, which is what a datepicker actually listens
            # for, and is what worked reliably in manual verification.
            start_input = page.locator(".range-start")
            end_input = page.locator(".range-end")

            # NOTE: no Escape/Tab here. Confirmed live (twice, 2026-08-31)
            # that clicking straight into the End field reliably commits
            # the Start field's typed value (it visibly reformats
            # "08/25/2026" -> "2026-08-25" the moment End gets focus), and
            # clicking Apply directly afterwards - without blurring End
            # first - still commits correctly. An earlier version of this
            # code pressed Escape after each field to close the
            # datepicker's calendar popup; that turned out to be the wrong
            # call - one live repro showed Escape leaving BOTH fields
            # empty after Apply (breadcrumb read just "Custom Range", no
            # dates, and the widget genuinely had no rows), most likely
            # because Escape is also this datepicker's "clear/cancel the
            # pending edit" shortcut, not just "close the popup".
            start_input.click(force=True)
            start_input.clear()
            start_input.press_sequentially(start_str, delay=40)

            end_input.click(force=True)
            end_input.clear()
            end_input.press_sequentially(end_str, delay=40)

            # Don't click Apply on a fixed delay - wait for the actual
            # signal that the datepicker has validated both typed dates:
            # the Apply button loses its "disabled" class. Confirmed live
            # in CI that even with real keystrokes, a short fixed wait
            # isn't always enough - the button can still read "disabled"
            # for a bit while the widget's own validation catches up, and
            # clicking (even with force=True) while it's disabled is a
            # no-op in the app's own click handler, silently applying
            # nothing. NOTE: this only proves the *button* thinks the
            # inputs are non-empty/well-formed - see below, it is NOT
            # sufficient proof the Custom Range actually got applied.
            page.wait_for_function(
                """() => {
                    const btn = document.querySelector('.apply-button');
                    return btn && !btn.classList.contains('disabled');
                }""",
                timeout=15_000,
            )

            # Apply the filter, then POLL the breadcrumb (not a fixed
            # delay) until it shows the committed "<date> to <date>" text.
            #
            # IMPORTANT: ".filters-bar-label" (used above to *open* the
            # panel) is NOT the per-filter breadcrumb - confirmed live via
            # DOM inspection that it only ever contains the generic
            # "Filters (N)" toggle text (a <div class="filters-bar-label
            # bold">Filters<span id="filter-count">(N)</span>...</div>).
            # This selector bug is why every prior CI run failed this
            # check even when the date range genuinely committed (run
            # #18, 2026-08-31: last breadcrumb text was literally
            # 'Filters (1)'). The actual per-filter readout lives in
            # ".filters-bar .filter-group .filter .label" (sibling of a
            # ".dimension-name" span reading "DateRange") - confirmed live
            # it shows "2026-08-25 to 2026-09-01" (computed dates,
            # YYYY-MM-DD) once both inputs hold a valid date, and keeps
            # showing it after Apply is clicked and the panel closes.
            apply_button = page.locator(".apply-button")
            date_range_label = page.locator(".filters-bar .filter-group .filter .label").first
            apply_button.click(force=True)
            try:
                page.wait_for_function(
                    """() => {
                        const el = document.querySelector('.filters-bar .filter-group .filter .label');
                        return !!el && el.textContent.includes(' to ');
                    }""",
                    timeout=15_000,
                )
            except Exception:
                raise RuntimeError(
                    "Custom Range Start/End Date did not commit - filter breadcrumb never "
                    "showed '<date> to <date>' after Apply (last breadcrumb text: "
                    f"{date_range_label.text_content()!r})"
                )

            # Find the "Data" widget specifically (report may gain more
            # widgets later).
            widget = page.locator(".widget-container", has=page.locator(".widget-title", has_text="Data")).first
            widget.scroll_into_view_if_needed()

            # Wait for the query that Apply just triggered to finish. The
            # widget shows a transient ".widget-loader" overlay ON TOP OF
            # its *previous* results while requerying - checking the
            # widget's contents before this resolves can observe stale
            # state. Poll (not a fixed delay) for either real grid rows or
            # a genuinely visible "no matching rows" message; also bail
            # out if the loader itself never appears/disappears within
            # the timeout, since a network hiccup here should be a clear
            # failure, not a silent "no rows".
            #
            # IMPORTANT: the ".error-message" node is ALWAYS present in
            # the widget's DOM, even when it's showing real data - it's a
            # hidden placeholder (confirmed live: display:none,
            # offsetParent:null while a fully-loaded grid with rows sat
            # right next to it). A bare `.count() > 0` check on it is
            # true unconditionally, which is why CI run #19 (2026-08-31)
            # reported "no rows" for a range that actually had data. Must
            # check visibility, not just presence.
            widget_handle = widget.element_handle()
            page.wait_for_function(
                """(el) => {
                    const loader = el.querySelector('.widget-loader');
                    if (loader && loader.offsetParent !== null) return false;
                    const err = el.querySelector('.error-message');
                    const errVisible = !!err && err.offsetParent !== null;
                    const grid = el.querySelector('.ninja-grid');
                    return errVisible || !!grid;
                }""",
                arg=widget_handle,
                # Generous: on the scheduled 7am/7pm runs Sisense has been
                # measurably slower than during ad-hoc manual runs (see
                # the ".ninja-grid" note near page.goto above), and this
                # query may also be queued behind the still-in-flight
                # default "All Dates" query the page fired on load.
                timeout=180_000,
            )

            # No rows in this date range - Sisense shows this in place of
            # the grid and doesn't offer a "Download Data" menu item at
            # all, so check for it (now that the query above has settled)
            # instead of timing out waiting for a menu that will never
            # appear.
            if widget.locator(".error-message", has_text="no matching rows").is_visible():
                browser.close()
                return None

            # Open the per-widget menu.
            widget.hover()
            page.wait_for_timeout(500)
            widget.locator(".controls .expand.button").click(force=True)
            page.wait_for_selector("text=Download Data", timeout=30_000)
            page.get_by_text("Download Data", exact=True).click()

            deadline = time.time() + 60
            while export_url["value"] is None and time.time() < deadline:
                page.wait_for_timeout(250)
            if export_url["value"] is None:
                raise RuntimeError("Did not observe a download_csv request after clicking Download Data")
        except Exception:
            try:
                page.screenshot(path="debug_failure.png", full_page=True)
                with open("debug_failure.html", "w", encoding="utf-8") as f:
                    f.write(page.content())
            except Exception as diag_err:
                print(f"(could not capture debug artifacts: {diag_err})", file=sys.stderr)
            browser.close()
            raise

        csv_text = None
        deadline = time.time() + 180
        while time.time() < deadline:
            resp = page.context.request.get(export_url["value"])
            if resp.status == 200:
                csv_text = resp.text()
                break
            page.wait_for_timeout(2000)

        browser.close()

        if csv_text is None:
            raise RuntimeError("Timed out waiting for the CSV export to become ready")
        return csv_text


def parse_csv_rows(csv_text: str):
    reader = csv.reader(io.StringIO(csv_text))
    try:
        header = next(reader)
    except StopIteration:
        return []

    if len(header) != len(HEADERS):
        print(
            f"WARNING: CSV header has {len(header)} columns, expected {len(HEADERS)}. "
            f"Got: {header}",
            file=sys.stderr,
        )
    else:
        # Names are compared loosely (the sheet header keeps two historical
        # spellings); an ORDER change upstream is what we really care about.
        norm = lambda h: h.strip().lower().replace(" ", "_")
        mism = [(i, header[i], HEADERS[i]) for i in range(len(HEADERS))
                if norm(header[i]) != norm(HEADERS[i])
                and norm(header[i]) not in ("dest_city", "assign_time")]
        if mism:
            print(f"WARNING: CSV header names differ from the sheet header at: {mism}", file=sys.stderr)

    rows = []
    for row in reader:
        # Defensive pad/truncate: never let a stray column-count mismatch
        # (a trailing blank line, a schema tweak upstream, etc.) crash the
        # whole batch - Apps Script's setValues() requires a fixed width.
        if len(row) < len(HEADERS):
            row = row + [""] * (len(HEADERS) - len(row))
        elif len(row) > len(HEADERS):
            row = row[: len(HEADERS)]
        rows.append(row)
    return rows


def post_rows(rows: list):
    # Generous timeout: the Web App upserts into a month file that grows to
    # ~25k rows; Apps Script's own hard limit is 6 minutes, so wait for it
    # rather than declaring failure while it is still writing.
    resp = requests.post(
        WEBAPP_URL,
        params={"token": WEBAPP_TOKEN},
        data=json.dumps({"rows": rows}),
        headers={"Content-Type": "application/json"},
        timeout=360,
    )
    resp.raise_for_status()
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"Web App POST failed: {data}")
    return data


def main():
    check_token()

    start_str, end_str = compute_date_range_mmddyyyy()
    print(f"Pulling 'Copa - Master Report' data for {start_str} to {end_str} (D-1 to D0, America/Panama)...")

    # Whole-scrape retry with a fresh browser. Every failure seen on the
    # scheduled runs so far has been Sisense being slow/unresponsive at
    # that hour rather than anything wrong with the page or the code, and
    # a second attempt a minute later is cheap compared to losing a whole
    # 12-hour sync window. The debug screenshot/HTML from the LAST failed
    # attempt is what ends up in the workflow's artifacts.
    csv_text = None
    last_exc = None
    for attempt in range(1, SCRAPE_ATTEMPTS + 1):
        try:
            csv_text = scrape_window_csv()
            last_exc = None
            break
        except Exception as exc:  # noqa: BLE001 - deliberately broad, see above
            last_exc = exc
            print(f"Scrape attempt {attempt}/{SCRAPE_ATTEMPTS} failed: {exc}", file=sys.stderr)
            if attempt < SCRAPE_ATTEMPTS:
                print(f"Retrying in {SCRAPE_RETRY_DELAY_S}s with a fresh browser...", file=sys.stderr)
                time.sleep(SCRAPE_RETRY_DELAY_S)
    if last_exc is not None:
        raise last_exc

    if csv_text is None:
        print(f"No rows for {start_str} to {end_str} - nothing to pull. Will retry next run.")
        return

    rows = parse_csv_rows(csv_text)
    print(f"Scraped {len(rows)} rows for {start_str} to {end_str}.")

    result = post_rows(rows)
    print(
        f"Posted {result.get('rows_received')} rows: "
        f"{result.get('rows_updated')} updated in place, {result.get('rows_appended')} appended; "
        f"{result.get('duplicates_removed')} stray duplicate row(s) removed, "
        f"{result.get('wrong_month_removed')} wrong-month row(s) removed, "
        f"{result.get('rows_unroutable')} row(s) had no readable date and were skipped."
    )
    for name, stats in sorted((result.get("files") or {}).items()):
        print(f"  {name}: {stats}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"FAILED: {exc}", file=sys.stderr)
        sys.exit(1)

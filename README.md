# Airtable archive + billing documents (live preview)

A working preview for a millwork ERP on Airtable. Phase 1: a completed job is copied to a separate archive base with its sales, estimating and production records re-linked by new IDs (original IDs kept as Source Record ID, one Project ID across the job), verified by counts and links, and only then removed (or kept as a stub). Phase 2: a G703-style continuation sheet, a G702-style summary and work-order stickers generated from the same records. All data is invented.

## Files
```
index.html               the page (Airtable style)
src/archiveEngine.js     the engine (UMD: browser + node)
data/sample.json         invented jobs, estimate lines, work orders, and one archived job
tests/verify.js          27 node tests
tests/browser-check.py   19 Playwright checks
```

## Run the tests
```
node tests/verify.js            # 27 passed, 0 failed
python3 tests/browser-check.py  # 19 passed, 0 failed
```

## How the logic works
| Step | Rule |
|---|---|
| Collect | the sales record, every estimate linked to it, every work order linked to it or to its estimates |
| Refuse | not Complete; a record also linked to another active job; already archived (Source Record ID); archive base would pass its record limit |
| Copy | sales first, then estimates, then production; each child's links rewritten to the new IDs |
| Verify | counts 1/estimates/production, link count equals the original, no link pointing outside the archive |
| Fail safe | any failed write or mismatch rolls the archive copy back; the active base is never touched |
| Finish | remove from the active base, or keep stubs marked Archived pointing to their archive copies |
| SOV | per estimate line: % complete = average of its work orders; this period = (current - previous) x scheduled value; stored materials added; retainage on completed and stored |
| Summary | earned less retainage, less previous certificates, current payment due, balance to finish including retainage; scheduled values must add up to the contract sum |

# scripts/

Diagnostics and end-to-end drivers. None of these are needed to run the app — they exist
so a failure can be reproduced in one command instead of being argued about.

Start the app first (`Run PropCo.bat`, or `npm start`); everything here talks to
`http://localhost:5173`.

## End-to-end drivers

| Script | What it proves |
|---|---|
| `e2e-api.mjs <tracker.xlsx> <channel> <out>` | Upload → generate → funnel → download. Asserts exactly one channel's sheets are written. |
| `e2e-ui.mjs <out-prefix> [tracker.xlsx]` | Drives the wizard in a real browser and screenshots the step-1 channel gate. |
| `e2e-templates.mjs <out>` | Downloads the Main Database template and uploads it back. A template the app cannot read is worse than none. |
| `e2e-comps.mjs <unused> <out>` | Transactions template → comps upload → priced lawyer letter. Checks comps are sale prices, not psf. |
| `e2e-rerun.mjs <tracker.xlsx> <limit> <out>` | Verify, then rebuild with corrected addresses. Prints the coverage sheet. |
| `e2e-rerun-upload.mjs <tracker.xlsx> <tmp> <out>` | The safe correction path: upload full addresses, rebuild, check the Address Overrides sheet. |
| `e2e-bizfile-live.mjs <jobId> [limit]` | Async BizFile run: expects 202, polls progress, reports the verdict tally. |
| `e2e-bizfile-upload.mjs <jobId> <tmp>` | The BizFile export path, exercising every verdict branch. |
| `e2e-crosscheck.mjs` | Calls the Claude cross-check directly on two synthetic rows — isolates the API call from the route. |

## Diagnostics

| Script | Use when |
|---|---|
| `bizfile-canary.mjs` | "Is bizfile.gov.sg answering today?" Exits 0 if yes, 1 if the session is gated. |
| `bizfile-probe.mjs <keyword> <out>` | The live DOM changed and the selectors need re-reading. Saves HTML, JSON and a screenshot. |
| `acra-diagnose.mjs <name>...` | An owner name won't resolve against ACRA open data. Shows which lookup strategy lands. |

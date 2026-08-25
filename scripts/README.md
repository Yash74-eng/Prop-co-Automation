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
| `e2e-outreach-picker.mjs` | The Excel-style value picker: lists the real column values with counts, then filters on the exact ones chosen. Separates "Batch 3" from "Batch 4", which a state filter cannot. |
| `e2e-selectable.mjs` | Deletes storage/ under a running server, then checks the error explains itself; each outreach state selects its own row; each pricing method gives a different range. |
| `e2e-sheet-defaults.mjs` | The two things nobody should have to know: which tab holds the owner rows, and where the comps live. |
| `e2e-outreach-default.mjs` | A tracker whose outreach column is all batch tags. The default must keep every row; exclude-contacted must still drop them all. |
| `e2e-live-comps.mjs [sheet-url]` | Live comps from Google Sheets, and the channel split: the letter is priced, the postcard has no price columns at all. |
| `e2e-comps.mjs <unused> <out>` | Transactions template → comps upload → priced lawyer letter. Checks comps are sale prices, not psf. |
| `e2e-rerun.mjs <tracker.xlsx> <limit> <out>` | Verify, then rebuild with corrected addresses. Prints the coverage sheet. |
| `e2e-rerun-upload.mjs <tracker.xlsx> <tmp> <out>` | The safe correction path: upload full addresses, rebuild, check the Address Overrides sheet. |
| `e2e-bizfile-live.mjs <jobId> [limit]` | Async BizFile run: expects 202, polls progress, reports the verdict tally. |
| `e2e-bizfile-upload.mjs <jobId> <tmp>` | The BizFile export path, exercising every verdict branch. |
| `e2e-crosscheck.mjs` | Calls the Claude cross-check directly. Rows 2–5 must produce **no** findings; rows 6–8 must all be caught. False positives are the failure that matters. |
| `e2e-crosscheck-instructions.mjs` | Proves the operator's own instructions change what Claude reports, in both directions — silencing a built-in finding and adding a new one. |
| `e2e-bizfile-inline.mjs <out-prefix>` | The correct-it-on-the-sheet loop: BizFile → verdict columns on the deliverable → type a Corrected Address → upload → applied. |
| `e2e-mailmerge-setup.mjs <out>` | Template validation, the wrong-template catch, and the script escape hatch. Needs no Word. |
| `e2e-mailmerge.mjs <out-prefix>` | The full path including PDFs: test one, run all, zip. Needs Word **and an activated Office**. |

## Deck

| Script | What it does |
|---|---|
| `capture-screens.mjs <out-dir>` | Walks the wizard and screenshots each step as a readable 3:2 frame. Runs on the Main Database template, so no real owner data lands in a file that leaves the machine. |
| `build-deck.mjs <shots-dir> <out.pptx>` | Turns those into a 16:9 deck. Verified by asking PowerPoint to open the result — a deck that needs repairing is worse than none. |

## Diagnostics

| Script | Use when |
|---|---|
| `bizfile-canary.mjs` | "Is bizfile.gov.sg answering today?" Exits 0 if yes, 1 if the session is gated. |
| `bizfile-probe.mjs <keyword> <out>` | The live DOM changed and the selectors need re-reading. Saves HTML, JSON and a screenshot. |
| `acra-diagnose.mjs <name>...` | An owner name won't resolve against ACRA open data. Shows which lookup strategy lands. |

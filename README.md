# PropCo Outreach Automation

Turns the PropCo Dealflow Tracker's **Main Database** into a mail-merge-ready sheet for
Figment's shophouse acquisition outreach — lawyer letters or postcards — with the dedupe,
comps, exclusion and verification rules from the outreach spec applied and fully audited.

The uploaded workbook is **never modified**. Every run writes a new workbook containing
your original sheet verbatim plus the generated subsheets.

---

## What it does

| Stage | What happens |
|---|---|
| 1. Read | Reads the Main Database (full 45-column export, or a trimmed sheet with just the major columns). Headers are matched on a normalised key, so casing and trailing spaces don't matter. |
| 2. Outreach filter | Filters on `Lawyer Letter Outreach` / `Postcard Outreach Date`. The column mixes real dates, batch tags and delivery-failure notes, so each value is classified rather than just tested for blank. Opt-outs and do-not-send rows are always dropped. |
| 3. Suppression | Drops anything on an uploaded compset / do-not-contact list (matched on postal code or street address). |
| 4. Explode owners | One row per (property, owner slot), across all five owner columns. Blank names, strata placeholders and un-mailable addresses are removed with a logged reason. |
| 5. Clean names | Strips aliases (`(CHEN ZHONGQIN)` and `Alias :CHEW AH KEW`), keeps company brackets intact, parses `Total 18 owners:` prefixes, and classifies each name as person / company / agency / institution. |
| 6. De-duplicate | Two-stage merge — co-owners join with `&`, then one owner's properties merge with `/` and collapsed postal codes. |
| 7. Comps & pricing | Looks up `minimum_Price`, `higher_Price` and two comparables from the Lawyer Letter Comps Benchmarks table. Falls back to GFA × neighbourhood psf when no row matches, clearly flagged. |
| 8. Write | Emits the deliverable sheet plus audit subsheets: exploded owner rows, every merge decision, every exclusion with its reason, review flags, the comps table used, and a run summary. |
| 9. Verify | Two optional, user-triggered passes: BizFile registered-address checks for corporate owners, and a Claude cross-check that reads the finished rows and reports anything wrong. |
| 10. Mail merge | Validates a Word template's merge fields against the generated headers, then emits a PowerShell script that drives Word to export PDFs. |

---

## Quick start

```bash
git clone https://github.com/Yash74-eng/Prop-co-Automation.git
cd Prop-co-Automation

npm install
npm --prefix web install
npm run web:build

cp .env.example .env        # then fill in ANTHROPIC_API_KEY if you want step 9
npm start                   # http://localhost:5173
```

Requires Node 20 or newer.

### The app

Five steps down the left, each unlocked by the one before it.

| Step | What you do |
|---|---|
| **1 · Upload** | Drop the workbook. It picks the Main Database sheet, shows how many rows parsed and which fields mapped, and previews the first rows so you can confirm the header row was read correctly. |
| **2 · Configure** | Channel, mail date, outreach filter, and the exclusion/dedupe thresholds. Optional comps-benchmark override and suppression list. Every setting says what it does and what happens if you change it. |
| **3 · Review** | Recipient count and the generated rows in a searchable, sortable grid. **Click any row** to open a drill-down showing the source rows that merged into it, the exact merge decisions taken, and every flag against it. A *Where rows went* tab shows the funnel — 6,672 source rows down to 1,452 recipients, with the drop at each stage and the reasons behind it. |
| **4 · Verify** | Run the BizFile check and the Claude cross-check. Findings appear in-app and are appended to the workbook. |
| **5 · Mail merge** | Validate a `.docx` against the generated headers and copy the command that exports the PDFs. |

The job survives a page reload, there is a dark mode, and a pre-send checklist sits on the
last step.

### Command line

```bash
npm run cli -- \
  --in "PropCo Dealflow Tracker.xlsx" \
  --channel lawyer-letter \
  --mail-date 2026-09-01 \
  --out "Lawyer Letter Sep 2026.xlsx" \
  --template "Lawyer Letter Template.docx"
```

Run `npm run cli` with no arguments for the full flag list. Common ones:

| Flag | Meaning |
|---|---|
| `--channel lawyer-letter\|postcard` | Which deliverable to build |
| `--outreach exclude-contacted\|only-tagged\|match\|all` | How to filter the outreach column |
| `--outreach-text "Batch 3"` | Substring for `--outreach match` |
| `--comps <path>` | Replacement comps benchmark workbook |
| `--suppress <path>` | Compset / do-not-contact list (all sheets read) |
| `--max-properties 5` | Remove owners holding more than N properties |
| `--max-owners 4` | Collapse to `Owners of ___` above N owners |
| `--keep-agencies` | Don't remove agencies / associations / developers |
| `--no-derive` | Leave prices blank when no comps row matches |
| `--no-audit` | Emit only the deliverable sheets |
| `--cross-check` | Run the Claude pass (needs `ANTHROPIC_API_KEY`) |

### Development

```bash
npm run dev        # API with reload, port 5173
npm run web:dev    # UI with hot reload, port 5174, proxies /api
npm test           # unit + workbook round-trip tests
npm run test:real -- "PropCo Dealflow Tracker.xlsx"   # coverage report over live data
```

---

## Output sheets

**Lawyer letter** — the `Lawyer Letter` sheet is columns A–V, headers named exactly as the
Word template's merge fields:

```
Comments · Owner No. · Target · Address · Full_Address · Neighbourhood · Land Use ·
Mail_Date · Valid_Date · Registered_Proprietor · Registered_Proprietor_mailing_address ·
Duplicate Owner / Owner Addresses · minimum_Price · higher_Price ·
Comp_Address_1 · Comp_1 · Comp_1_Date · Comp_Address_2 · Comp_2 · Comp_2_Date ·
Status · Date Responded
```

`Valid_Date` carries the live `=H2+14` formula **and** a cached value — Word's mail merge
reads the workbook over OLEDB and does not evaluate formulas, so a bare formula would
merge blank.

> **One deliberate correction.** The reference sheet spells column E `Full_Addressk`. The
> Word template's field is `«Full_Address»`, and mail merge maps strictly by header name,
> so the typo would render every address blank. This tool writes `Full_Address`. Verified
> against `Lawyer Letter Template.docx`: all 13 merge fields match.

**Postcard** — two deliverable sheets, per the spec:

- `Postcard` — Target, Address, Full Address, Neighbourhood, Land Use, Owner Name, Owner Address, Checking, Contact Name, Contact Number, Status, Updated Date
- `Postcards Final` — Owner Name, Owner Address

**Audit subsheets** (on by default, switch off with `--no-audit`):
`Source (Original)`, `Owner Rows (Exploded)`, `Dedupe Audit`, `Excluded`, `Review Flags`,
`Comps Benchmark Used`, `Run Summary`, plus `BizFile Verification` and
`Claude Cross-Check` once those steps run.

---

## The dedupe rules

Implemented as a two-stage merge, because a single-stage merge keyed only on the mailing
address fuses unrelated companies that share a corporate-secretary address onto one letter.

**Stage A — merge co-owners.** Key: Target + Neighbourhood + mailing address + property.

```
JANE XIA + LONG GAN  (same property, same mailing address)  ->  JANE XIA & LONG GAN
```

**Stage B — merge properties.** Key: Target + Neighbourhood + mailing address, then split
into clusters that share at least one owner name.

```
same street:        27 CLUB STREET SG 069413 + 29 CLUB STREET SG 069414
               ->   27 / 29 CLUB STREET SINGAPORE 069413 / 14

postal codes:       111100, 111101, 111102  ->  111100 / 01 / 02

different streets:  103 ARAB STREET SG 199799 + 72 HAJI LANE SG 189265
               ->   103 ARAB STREET SINGAPORE 199799; 72 HAJI LANE SINGAPORE 189265
```

The owner-overlap test is what makes both of these come out right:

- `JANE XIA & LONG GAN` at 27 Club St and `JANE XIA` at 29 Club St share an owner, so they
  become **one** letter covering 27 / 29 — not two letters to the same household.
- `ALPHA HOLDINGS PTE LTD` and `BETA HOLDINGS PTE LTD` share a corporate-secretary mailing
  address but no owner, so they stay **separate**.

Kept separate always: different Target, different Neighbourhood, different owner mailing
address.

`Owner No.` (column B) reproduces the tracker's TEXTJOIN/COUNTIF formula — `unique`, or
`<value> (n)` when the proprietor name or mailing address also appears on another row.

`Duplicate Owner / Owner Addresses` (column L) lists the other recipients sharing a name
or address, with the reason (`name`, `address`, `name+address`), for the step-7 review.

---

## Removed vs flagged

The spec distinguishes these, and so does the tool.

**Removed** (each with a logged reason on the `Excluded` sheet):

- Blank owner name, blank owner address
- Strata placeholders — `ALL THE REGISTERED PROPRIETORS OF ALL THE STRATA LOTS…` as a name,
  and the strata boilerplate as an address (including the tracker's `SUBSIDARY` typo)
- Owners holding more than 5 properties (configurable)
- Agencies, associations, statutory bodies, temples, clan associations, MCSTs, town councils
- Large property developers
- Anything on the uploaded suppression list
- Opt-outs and do-not-send rows

**Flagged only, never removed** — surfaced in `Comments` and on `Review Flags`:

- The institutions-to-avoid list — *"give on comment, does not directly remove"*. The list
  itself is not in this repository (see [Configuration](#configuration)); it is read from
  the uploaded workbook's own **Institutions to Avoid** sheet, so the tracker stays the
  source of truth.
- Corporate-sounding names that are usually family holding companies (`REALTY`,
  `PROPERTIES`, `INVESTMENT`, `HOLDINGS`, …). Removing these silently would drop real
  targets, so they are kept and flagged.
- Cells that may contain more than one name, overseas mailing addresses, unparseable
  addresses, derived prices, missing prices

Developer matching only applies to registered entities and only on whole words —
without both guards, `TIONG SENG` (a developer) matches `LEE TIONG SENG` (a person) and a
real target is silently dropped.

---

## Comps and pricing

Primary source is the `Lawyer Letter Comps Benchmarks` table, keyed on
(Neighbourhood, Land Use, Tenure). The tool bridges the two vocabularies:

| Main Database | Comps sheet |
|---|---|
| `Full Commercial (Dark Blue)` | `Fully Commercial` |
| `Residential with Commercial at 1st storey (Red)` | `Mixed Use` |
| `Commercial and Residential (Light Blue)` | `Mixed Use` |
| `LEASEHOLD 999 Years (10/08/1831)`, `FH`, `999 FROM 1959` | `FH / 999 years` |
| `LEASEHOLD 99 Years (22/09/1988)` | `99 years` |
| `D1 - Raffles Place, Cecil, Marina, People's Park` | `D1` |
| `Sims Avenue` | `Geylang / Sims Avenue` |

Fallback when no row matches: `GFA (sqft) × neighbourhood psf`, mirroring the tracker's own
`Benchmark` column, with the higher price at +12.5% and rounding to S$250,000. Derived rows
carry **VERIFY BEFORE SENDING** in `Comments`.

`Upper Serangoon` is deliberately *not* mapped to the comps `Serangoon` row — that row's
comparables are 563 Serangoon Road / 403 Jalan Besar, i.e. the Serangoon Road cluster in
Little India, not Upper Serangoon by Yio Chu Kang. Unmapped neighbourhoods produce a
warning rather than a wrong comparable.

---

## Configuration

This repository is public, so no Figment-specific list is hardcoded in the source. The
lists that are confidential or change often are resolved at runtime — see
[`config/README.md`](config/README.md):

| List | Resolution order |
|---|---|
| Institutions to avoid (flag only) | The uploaded workbook's **Institutions to Avoid** sheet → `config/institutions-to-avoid.json` → nothing (the Run Summary says which) |
| Large developers (removed) | `config/developers.json` → a generic built-in list of public SG developers |
| Neighbourhood → comps mapping | Built-in table, with `config/neighbourhood-map.json` merged over it |

Everything under `config/*.json` is git-ignored; only the `*.example.json` templates are
committed. The Run Summary sheet records which source each list came from, so a run with
no institutions list is obvious rather than silent.

## BizFile verification (step 6)

For every corporate owner, compares ACRA's registered office address against the mailing
address in the sheet. Verdicts: `match`, `match-building` (same postal code, different
unit), `mismatch`, `entity-inactive` (struck off / dissolved — do not send),
`inconclusive`, `not-found`.

Two resolvers, both user-triggered:

1. **Upload a BizFile export** (recommended). Search the names on
   [bizfile.gov.sg](https://www.bizfile.gov.sg/buy-info/search/results) and upload the
   result — columns like `Entity Name`, `UEN`, `Registered Office Address` are picked up
   automatically.
2. **Live lookup** via headless Chromium. Off by default. BizFile is a JavaScript app
   behind a WAF, so this is best-effort and rate-limited:
   ```bash
   npm i playwright && npx playwright install chromium
   # then set BIZFILE_ENABLED=1 in .env
   ```

---

## Claude cross-check (step 9)

Claude reads the finished rows and reports problems: malformed merged addresses, names
that read like institutions, prices that don't fit the neighbourhood, un-mailable owner
addresses, `Valid_Date` before `Mail_Date`. It **reports only** — findings land on the
`Claude Cross-Check` sheet with a suggested fix for a human to accept.

Rows go out in batches through a forced tool call, so the response is always valid JSON
against a fixed schema. The instruction block is identical for every batch and marked
`cache_control`, so batch two onwards reads the prefix from cache.

Set `ANTHROPIC_API_KEY` in `.env`. Model defaults to `claude-opus-5`
(override with `ANTHROPIC_MODEL`).

---

## Mail merge (step 8)

Upload the `.docx` and the tool extracts its `MERGEFIELD` names and checks them against
the generated headers — a mismatch here is the classic silent mail-merge failure. It then
writes a PowerShell script that drives the installed Word to run the merge and export one
PDF per record:

```powershell
powershell -File "storage\outputs\merge-abc12345.ps1"
```

Word is scripted rather than reimplemented because the templates carry headers, footers,
QR images and Chinese text that only Word renders faithfully.

---

## Verification

`npm test` — 62 tests covering the spec's examples verbatim (the ZIP/street merge cases,
the `&` join, `Owners of ___`, alias stripping) plus a workbook round-trip that builds a
file, reads it back with a different library, and asserts the merge-field headers, the
cached `Valid_Date`, and the date calendar days.

`npm run test:real -- "<tracker>.xlsx"` prints a coverage report over live data rather
than asserting, so each rule can be checked against the real sheet. Against the
6,672-row Main Database:

| Check | Result |
|---|---|
| Addresses fully parsed | 6,672 / 6,672 (100%) |
| Conservation-area names recognised | 2,560 / 2,560 (100%) |
| GFA matches `LandAreaSqM × 10.7639 × floors` | 5,884 / 5,890 (99.9%) — confirms GFA is **square feet** |
| Owner name cells classified | 8,497 across 4,642 distinct names |
| Institutions-to-avoid found | 8 / 8 entries hit, 146 rows flagged |
| Priced from comps benchmark | 69.5% |
| Derived from GFA × psf | 8.9% |
| No price (unmapped neighbourhood or blank tenure) | 21.5% |

A lawyer-letter run over that tracker (never-contacted rows only) produces **1,452
recipients** from 3,402 filtered source rows, with 624 merges, 5,166 logged exclusions and
799 review flags.

Two things worth knowing about the source data, surfaced as warnings rather than silently
absorbed:

- The comps benchmark table covers 15 neighbourhoods; the Main Database has 49. Rows in
  the other 34 get derived or blank prices.
- 682 rows have a blank `Tenure`, which blocks the comps lookup.

---

## Layout

```
src/core/       pure logic, no I/O — address parsing, name cleaning, dedupe, comps, pipeline
src/excel/      workbook read (SheetJS) and write (ExcelJS)
src/bizfile/    registered-address verification
src/verify/     Claude cross-check
src/mailmerge/  merge-field validation and the Word COM script
src/server/     Express API and job store
src/cli.ts      command-line runner
web/src/ui.tsx  UI primitives — data grid, funnel, drawer, toasts, dropzone
web/src/views/  the five steps
test/           unit tests, workbook round-trip, real-data coverage harness
```

---

## Confidentiality

Uploads and generated workbooks stay on the machine under `storage/`, which is
git-ignored, and are pruned after 72 hours. Owner names, mailing addresses, deal terms and
pricing never leave the machine except when the Claude cross-check is explicitly
triggered, which sends only the generated row fields needed to judge them. Never commit
`storage/` or `.env`.

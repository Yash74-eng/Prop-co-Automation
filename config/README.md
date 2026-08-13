# Runtime configuration

Nothing here is required — the tool runs with sensible built-in defaults and, where
possible, reads the lists straight out of the uploaded workbook.

Every `*.json` in this directory is **git-ignored**, because these lists are internal.
The `*.example.json` templates are committed so the shape is documented.

## `institutions-to-avoid.json`

Entities that should be **flagged in the `Comments` column but never removed** — a human
decides whether to send. Per the outreach spec: *"give on comment, does not directly
remove"*.

Resolution order at runtime:

1. An **"Institutions to Avoid"** sheet inside the uploaded workbook. This wins, so the
   tracker stays the source of truth and the tool can never run against a stale copy.
   Expected columns: `Institutions`, `Status`, `Remarks`.
2. This file, as an override or for uploads that don't carry the sheet.
3. Neither — nothing is flagged as an institution, and the Run Summary sheet says so.

Copy `institutions-to-avoid.example.json` to `institutions-to-avoid.json` and fill it in
if you want the list available without the sheet.

## `developers.json`

Large property developers to **remove**. A JSON array of strings; matching is on whole
words and only applies to registered entities, so a person whose name happens to contain
a developer's name is never dropped.

Supplying this file replaces the built-in list entirely.

```json
["EXAMPLE DEVELOPMENTS", "EXAMPLE LAND"]
```

## `neighbourhood-map.json`

Extra Main-Database-neighbourhood → comps-benchmark-neighbourhood mappings, merged over
the built-in table. Use this when the comps sheet gains coverage for a neighbourhood the
tool currently reports as unmapped.

```json
{
  "Macpherson": "Macpherson",
  "Outram Road": "D2"
}
```

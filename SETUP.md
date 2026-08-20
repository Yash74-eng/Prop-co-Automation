# Setting up PropCo Outreach Automation

For someone who has just been given this repo. About 10 minutes, most of it waiting for
`npm install`.

## 1. Install Node

Node 20 or newer, from [nodejs.org](https://nodejs.org). Take the LTS build and accept the
defaults. Check it worked — open PowerShell and run:

```
node --version
```

Anything starting `v20`, `v22` or `v24` is fine.

## 2. Get the code and its dependencies

```
git clone https://github.com/Yash74-eng/Prop-co-Automation.git
cd Prop-co-Automation
npm install
npm --prefix web install
npm run web:build
```

## 3. Put the .env file in place

**Ask Yash for the `.env` file and drop it into the repo folder, replacing the one there if
any.** It carries the keys and is deliberately not in the repo, so a fresh clone has no
`.env` at all and the credential-backed steps stay switched off until you add it.

It belongs at the top level, beside `package.json`:

```
Prop-co-Automation\
  .env            <-- here
  package.json
  src\
  web\
```

If you would rather set it up yourself, copy `.env.example` to `.env` and fill in the values
described under **Credentials** below. The only one that is required for the Claude
cross-check is:

```
ANTHROPIC_API_KEY=sk-ant-...
```

Everything else works with the defaults.

**Never commit `.env`.** It is gitignored, and it holds live keys — send it person to person,
not through the repo.

> Windows hides files whose name starts with a dot in some views, and File Explorer may save
> it as `.env.txt`. If the app cannot see your keys, turn on **View → File name extensions**
> and check the name is exactly `.env`.

## 4. Run it

Double-click **`Run PropCo.bat`**, or:

```
npm start
```

Then open <http://localhost:5173>. The first run creates a `storage/` folder for uploaded
and generated workbooks. That folder is gitignored: it holds real owner data and must stay
on your machine.

---

## Credentials you may need

None of these are in the repo, and none of them should ever be. Each is optional — the tool
tells you on screen when something is missing rather than failing halfway through.

### Anthropic API key — for the Claude cross-check (step 4)

Get one at <https://console.anthropic.com/settings/keys> and put it in `.env` as
`ANTHROPIC_API_KEY`. Without it every other step still works.

### Google service account — for reading the tracker live (step 1)

Only needed if you want to pull the tracker or the comps workbook straight out of Google
Sheets instead of uploading an export.

**The key is committed at `secrets/google-service-account.json`, so there is nothing to set
up.** Clone the repo and live fetch works. Leave `GOOGLE_SERVICE_ACCOUNT_JSON` empty in
`.env` — setting it overrides the committed key, which is only useful if you want to point
at your own.

Restart and the Upload step should show **"Reading as propco-sheets-reade@…"**. You do not
need the spreadsheet shared with your personal Google account — access belongs to the
service account, and that share is already in place.

This works because **the repository is private.** Read access to it is read access to that
spreadsheet, so keep it that way: do not add collaborators who should not see owner names
and mailing addresses, and do not make the repo public. The key also stays in git history
after any later deletion, so if it ever needs to be revoked, do it in Google Cloud rather
than by deleting the file.

### Rotating the key

Console → Service Accounts → `propco-sheets-reade` → Keys → delete the old key, **Add key →
JSON**. Save the download over `secrets/google-service-account.json`, commit, push. Everyone
picks it up on their next pull.

### Microsoft Word — for producing PDFs (step 5)

Mail merge is driven through the Word installed on your machine, because these templates
carry headers, footers, QR images and Chinese text that only Word renders faithfully.

Word must be **activated**. An unlicensed Office runs the merge happily and then blocks
forever when asked to save, with no error and no dialog. The app checks for this and says so
before you start a run, but if the title bar of Word ever reads *"Unlicensed Product"*, that
is why no PDF appeared.

Without Word you can still set the merge up and download the PowerShell script to run on a
machine that has it.

---

## Verifying your setup

Open <http://localhost:5173/api/health>. You should see something like:

```json
{
  "ok": true,
  "anthropicKey": true,
  "bizfileEnabled": true,
  "wordAvailable": true,
  "googleServiceAccount": "propco-sheets-reade@figment-propco.iam.gserviceaccount.com"
}
```

Any `false` or `null` there is a credential that is not set up yet, and the matching step in
the UI will explain what to do.

No tracker to hand? Every step offers a starter template with the exact column names and a
couple of worked rows — the links are on each page.

---

## Things that will bite you

**Do not commit `.env`, `storage/`, the Word templates, or any service-account key.** All of
them are gitignored already; the point is not to work around it. A service-account key in
git is a live credential to a spreadsheet of owner names and mailing addresses, and it stays
in history after any later deletion.

**The uploaded workbook is never modified.** Each run writes a new one containing your
original sheet verbatim plus the generated subsheets, so there is no way to damage the
source by re-running.

**Port 5173 already in use** means an instance is already running. Open
<http://localhost:5173> before starting another.

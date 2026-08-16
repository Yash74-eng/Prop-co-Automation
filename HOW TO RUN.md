# How to run PropCo Outreach

You do not need to know anything technical. There is one file to double-click.

---

## Windows

1. Double-click **`Run PropCo.bat`**
2. A black window opens. Leave it alone.
3. Your browser opens the app after a few seconds.

That is the whole thing.

## Mac

1. Open the folder in Finder
2. Double-click **`start-propco.sh`**
3. Your browser opens the app after a few seconds.

If double-clicking does nothing, right-click the file → **Open With** → **Terminal**.
If Mac says the file is not executable, open Terminal, type `chmod +x ` (with the space),
drag the file into the window, and press Enter. Then double-click it as normal.

---

## The first time takes longer

The first run downloads the pieces the app is built from. Expect **three to five
minutes**, and a lot of text scrolling past. That is normal — nothing is wrong.

Every run after that takes about five seconds.

If it says **Node.js is not installed**, it will open the download page for you. Click the
big green **LTS** button, run the installer, click Next until it finishes, then
double-click `Run PropCo.bat` again. Node.js is free and made by the same people behind
most business software you already use.

---

## While you are using it

**Keep the black window open.** It is the app itself, not a leftover. Minimise it if it is
in the way.

**To stop the app**, close that black window. That is the off switch.

**If the browser did not open by itself**, type this into your address bar:

```
http://localhost:5173
```

The address printed in the black window is **not clickable** — clicking it does nothing.
Type or copy it into your browser instead.

**If you closed the browser tab by accident**, the app is still running — just go to that
address again.

---

## Using the app

Five steps down the left-hand side. Each one unlocks the next.

| Step | What you do |
|---|---|
| **1 · Upload** | Choose whether you are sending **lawyer letters** or **postcards**, then drop in the tracker spreadsheet. |
| **2 · Configure** | Set the mail date and who to leave out. The defaults are fine. |
| **3 · Review** | Check the list. Click any row to see exactly where it came from. |
| **4 · Verify** | Optional checks against Singapore's company registry. |
| **5 · Mail merge** | Check your Word template, then produce the letters. |

The finished spreadsheet **downloads by itself** when step 2 finishes.

### Templates for everything

You never have to guess a column name or build a Word document from scratch. Every step
has download links:

| Step | Template | What it is |
|---|---|---|
| 1 | Main Database | The tracker itself — exact headings, two example rows |
| 2 | Comps benchmarks | Pricing table for lawyer letters |
| 2 | Do-not-contact | Addresses and owners to skip |
| 2 | Institutions to avoid | Names to flag for a human to check |
| 4 | BizFile export | For verifying and correcting owner addresses |
| 5 | **Lawyer letter (Word)** | A real `.docx` with the merge fields already in it |
| 5 | **Envelope (Word)** | Ready to merge |
| 5 | **Postcard (Word)** | Ready to merge |
| 5 | Merge field reference | Every field name, for both letters and postcards |

The three Word files are the ones that save the most trouble. Open one, replace the parts
in `[ SQUARE BRACKETS ]` with your own wording, and leave the `«Owner Name»` bits exactly
as they are — those fill themselves in.

Each spreadsheet template has a **How to use** tab explaining the rules. Delete the
example rows before you upload.

---

## Two promises worth knowing

**Your original file is never changed.** Every run creates a brand new spreadsheet
containing your original sheet untouched, plus the new sheets. You cannot break your
source data with this tool.

**Nothing leaves your computer**, except two optional checks on step 4 that look
companies up in Singapore's public registry. Your owner list is not uploaded anywhere.

---

## If something goes wrong

The black window will say what happened in plain words. Take a photo or screenshot of it
and send it to whoever set this up — that picture is genuinely all they need.

Common ones:

| It says | What to do |
|---|---|
| Node.js is not installed | It opens the download page. Install it, then try again. |
| Something went wrong while installing | Almost always no internet, or an office firewall. Check your connection and try again. |
| The app is already running | It is. The browser will open. Only one copy runs at a time. |
| The page will not load | Give it another ten seconds, then refresh. The first start is the slow one. |

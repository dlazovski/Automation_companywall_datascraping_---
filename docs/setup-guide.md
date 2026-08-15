# Setup guide — step by step

Follow this in order. It takes about 15 minutes.

**The golden rule:** you only ever edit **one node** — the one called `Config`.
Every other node is already wired up. If a field looks scary, leave it alone.

---

## Step 1 — Make the Google Sheet

1. Go to [sheets.new](https://sheets.new) to create a new spreadsheet.
2. Name it something like `CompanyWall Companies`.
3. At the bottom left, the tab is probably called `Sheet1`. Double-click it and
   rename it to **`Companies`**.
4. Click cell **A1** (the very first cell, top left).
5. Copy the block below and paste it into A1. It will spread across 18 columns
   automatically.

```
Company Name	Status	Address	Tax Number (EDB)	Registration Number (EMBS)	Employees	Revenue MKD	Phones	Emails	Owners	Managers	NKD Code	NKD Description	Date Founded	Region	Profile URL	Detail Fetched	Notes
```

> If it all lands in one cell instead of spreading out, undo (Ctrl+Z), then use
> **Edit → Paste special → Paste values only**.

6. Check that row 1 now has 18 separate headings, ending with `Notes` in
   column R.

### Get the Sheet ID (you need this in Step 5)

Look at the address bar. The ID is the long code between `/d/` and `/edit`:

```
https://docs.google.com/spreadsheets/d/1a2B3c4D5e6F7g8H9i0J/edit#gid=0
                                       └──────────────────┘
                                            this bit
```

Copy it somewhere for later.

---

## Step 2 — Import the workflow into n8n

1. Download the workflow file from GitHub:
   - Go to the repo, branch `claude/companywall-scraper-sheets-yhh8qp`
   - Open `workflows/companywall-scraper.json`
   - Click the **Download raw file** button (the ⬇ icon, top right of the file)
2. In n8n, click **Workflows** in the left sidebar.
3. Click the **⋯** (three dots) at the top right → **Import from File…**
4. Choose the file you just downloaded.

You should now see a canvas full of connected nodes, with some yellow sticky
notes explaining each part.

> Several nodes will show a red triangle ⚠. That is normal — it just means
> "no credential picked yet". Steps 3 and 4 fix that.

---

## Step 3 — Connect ScrapingBee (3 nodes)

### First, do you already have a ScrapingBee credential in n8n?

Click **Credentials** in the left sidebar and look for one. You need a
**Query Auth** credential.

**If you don't have one, make it now:**

1. **Credentials** → **Add credential** (top right)
2. Search for **`Query Auth`** and pick it
3. Fill in exactly:
   - **Name** (the parameter name field): `api_key`
   - **Value**: your ScrapingBee API key
4. At the top, rename the credential to `ScrapingBee API Key` so it's easy to find
5. **Save**

### Now attach it to the three nodes

Go back to your workflow. Do this for **each** of these three nodes:

- `Fetch Search Page`
- `Fetch Profile`
- `Fetch Lica`

For each one:

1. **Double-click** the node to open it.
2. Find the field **Credential for Query Auth** at the top.
3. Open the dropdown and pick your ScrapingBee credential.
4. Click **Back to canvas** (top left).

The red ⚠ on that node should disappear.

> **Don't change anything else in these nodes.** The URL and query parameters
> are already correct.

---

## Step 4 — Connect Google Sheets (3 nodes)

Do this for **each** of these three nodes:

- `Read Existing Sheet`
- `Write List Rows`
- `Update Company Row`

For each one:

1. **Double-click** the node.
2. At the top, in **Credential to connect with**, pick your Google Sheets
   account. (If you don't have one, choose **Create new credential** and follow
   the Google sign-in popup.)
3. **Leave the two fields below it completely alone.** They will show:
   - Document: `{{ $('Config').first().json.googleSheetId }}`
   - Sheet: `{{ $('Config').first().json.sheetName }}`

   **This is correct.** It means "use whatever is set in the Config node".
   You cannot click "From list" on these, and you don't need to — you'll set
   the sheet once in Step 5 and all three nodes follow automatically.
4. Click **Back to canvas**.

> ⚠️ **Make sure the Google account you connect has edit access to the sheet
> from Step 1.** If the sheet lives in someone else's Drive, share it with your
> account first.

---

## Step 5 — Tell it which sheet to use

1. **Double-click** the node called **`Config`**.
2. You'll see JavaScript code. Near the top, find these two lines:

```js
const googleSheetId = 'PUT_YOUR_GOOGLE_SHEET_ID_HERE';
const sheetName     = 'Companies';
```

3. Replace `PUT_YOUR_GOOGLE_SHEET_ID_HERE` with the ID you copied in Step 1.
   **Keep the quote marks.** It should end up looking like:

```js
const googleSheetId = '1a2B3c4D5e6F7g8H9i0J';
const sheetName     = 'Companies';
```

4. If you named your tab something other than `Companies`, change that too.
5. Click **Back to canvas**, then **Save** (top right).

---

## Step 6 — Do a small test run first

**Do not skip this.** It uses only 7 requests and catches problems before they
cost you thousands.

1. Double-click **`Config`** again.
2. Find these three lines and set them like this:

```js
const region       = { code: 7, name: 'Southeast' };
const maxPages     = 1;   // ← change 300 to 1
const maxCompanies = 3;   // ← change 0 to 3
```

3. **Back to canvas** → **Save**.
4. Click the big **Execute workflow** button at the bottom.
5. Wait about a minute. Nodes turn green as they finish.

### Now check it worked

**A. Look at your Google Sheet.** There should be 3 rows. Check:

- The `Employees` column shows only numbers between **1 and 5**
- `Company Name`, `Address`, `Status` look right and belong together
- `Phones`, `Emails`, `Owners`, `Managers` are filled in
- `Tax Number (EDB)` is filled on all 3 rows

**B. In n8n, double-click the `Run Summary` node** and read its output:

- `crawlErrors` should say `none`
- `fieldCoverage` should show high percentages (near 100%)
- `rowsMissingEdb` should be `0`

### If something looks wrong

- **`CLOUDFLARE_CHALLENGE` or `CAPTCHA` in the summary** → in Config, change
  `premiumProxy: false` to `premiumProxy: true`, save, run again.
- **`BLOCKED 403` or `429`** → in Config, change `waitSeconds: 4` to `8`, save,
  run again.
- **Fields empty, wrong, or shifted between companies** → stop and send me
  the output. Open the `Fetch Profile` node, copy what it returned, and paste it
  to me. I'll fix the parser.

Full detail on what to check: [`verification.md`](verification.md).

---

## Step 7 — Full run for Southeast

Once the test run looks good:

1. Double-click **`Config`**.
2. Set it back to full size:

```js
const region       = { code: 7, name: 'Southeast' };
const maxPages     = 300;  // ← back to 300
const maxCompanies = 0;    // ← back to 0 (means "all")
```

3. **Back to canvas** → **Save** → **Execute workflow**.

**This will take a long time** — possibly hours, because it waits 4 seconds
between every request on purpose, so the website doesn't block us. Leave the
browser tab open and let it run.

The 3 rows from your test run will simply be updated, not duplicated.

---

## Step 8 — Full run for East

When Step 7 finishes:

1. Double-click **`Config`**.
2. Change **only** the region line:

```js
const region = { code: 2, name: 'East' };
```

3. **Back to canvas** → **Save** → **Execute workflow**.

Done. Both regions are now in your sheet.

> **Why this is safe:** the workflow reads the sheet before it starts. Any
> company that shows up in both regions gets its existing row updated
> (`Region` becomes `Southeast + East`) instead of being added twice — and it
> won't be scraped a second time either.

---

## Quick answers

**Can I stop it in the middle?**
Yes. Just run it again later — it skips everything it already finished.

**Can I run the same region twice by accident?**
Yes, and nothing bad happens. It does nothing the second time.

**It's taking hours. Is it broken?**
Probably not. It waits 4 seconds between every request on purpose. Open the
`Run Summary` node after it finishes to see the totals.

**I want to see how many companies there are before committing to the long run.**
In Config set `fetchDetails: false`, then run. It only collects the list (fast,
1 request per page) and fills 8 of the 18 columns. Look at
`Run Summary.companiesFoundThisRegion`. Then set it back to `true` and run again
to fill in the rest.

**Something's wrong with the data in a column.**
Don't edit the code inside n8n nodes — those are generated and your changes get
wiped on the next import. Send me the page it failed on and I'll fix the parser
properly.

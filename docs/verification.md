# Verification — the trial run

The parsers in this repo have never seen companywall.com.mk's real HTML (the
build environment had no ScrapingBee key and no route to the site). This page is
how you close that gap, in 7 requests.

## Set up the trial

In the **Config** node:

```js
const region       = { code: 7, name: 'Southeast' };
const maxPages     = 1;   // one search page only
const maxCompanies = 3;   // three companies enriched
```

Execute. That is 1 search request + 3 × 2 detail requests = **7 requests**.

The 3 rows written are real and correct — the full run updates them in place, so
nothing is wasted or needs cleaning up afterwards.

---

## 1. Did ScrapingBee get through?

Open **`Run Summary`**.

- `crawlErrors` should be `none`.
- If it mentions `CLOUDFLARE_CHALLENGE` or `CAPTCHA` → set `premiumProxy: true`
  in Config and retry. It costs substantially more credits per request, so
  confirm it is actually needed first.
- If it mentions `BLOCKED 403` / `429` → raise `waitSeconds` and retry.

To see the raw response, open the `Fetch Search Page` node in the execution
view. A body of a few hundred bytes means a challenge page, not results.

---

## 2. Are the search-results fields right?

Look at the 3 rows in the sheet.

- [ ] **Every `Employees` value is between 1 and 5.** This is what confirms
      `dsm[1].Code=48` really is the employee-count filter.
- [ ] `Company Name`, `Status`, `Address` and `Revenue MKD` belong to the right
      company. **Fields shifted by one company** is the failure mode to look for
      — it means row chunking is off.
- [ ] `Tax Number (EDB)` is filled on every row —
      `Run Summary.rowsMissingEdb` should be `0`.
- [ ] `Status` is not blank.

`Run Summary.searchPagesFetched` should be `1` (the cap). If
`companiesFoundThisRegion` is far lower than the number of companies visible on
page 1 in a browser, row parsing is dropping rows.

---

## 3. Are the profile fields right?

`Run Summary.fieldCoverage` should be at or near 100% for `phone`, `email`,
`nkd` and `dateFounded`.

- [ ] `Phones` and `Emails` contain **every** value shown on the page, not just
      the first. Open the company in a browser and compare.
- [ ] `NKD Code` / `NKD Description` are the real industry, e.g.
      `62.010` / `Компјутерско програмирање`.
- [ ] `Date Founded` is populated.
- [ ] `Notes` is empty — it names anything that was not found.

### The "Прикажи ги сите" question

The brief flagged this as unresolved: does the "show all" toggle on phone/email
hide additional contacts?

Check the profile HTML for the toggle's `href`. If it points at `/lica`, it is
simply a mislabelled link to the ownership page — `/lica` has no contacts
section, so **the contacts already on the profile page are the complete list**
and there is nothing to do.

If it points elsewhere *and* the page's `mailto:` links outnumber what landed in
the `Emails` column, the extra contacts are lazy-loaded — set `renderJs: true`
in Config (costs ~5× credits) and re-run the trial to confirm before using it
for the full run.

---

## 4. Are owners and managers right?

`Run Summary.fieldCoverage.owners` / `.managers` should be near 100%.

If **both are 0%**, `Run Summary` prints `WARNING_LICA` — that means the `/lica`
parser needs tuning, not that the data is absent.

- [ ] `Owners` includes the ownership percentage, e.g.
      `Друштво БТОБЕТ Лимитед (100,00%)`.
- [ ] An owner that is a company is recorded verbatim, not treated as a person.
- [ ] `Managers` lists **all** representatives, each with position and from-date.
      A person holding two roles must appear twice.

Open the company's `/lica` page in a browser and count the `Претставник` blocks.
If the page shows 4 and the cell has 1, the parser is only catching the first.

---

## 5. If anything is wrong

Do **not** edit the Code nodes in n8n — they are generated and your edits are
lost on the next import.

1. In the n8n execution view, open the failing `Fetch …` node and copy the
   response body.
2. Save it to `tests/fixtures/` as `search-*.html`, `profile-*.html` or
   `lica-*.html`.
3. `npm test` — prints exactly what each parser extracted from your fixture.
4. Edit `lib/parsers.js`.
5. `npm run check` — rebuilds, re-tests, re-validates, re-simulates.
6. Re-import `workflows/companywall-scraper.json`.

Zero ScrapingBee credits, zero requests to the site.

---

## 6. Before the full run

- [ ] Trial rows look correct.
- [ ] `Run Summary.crawlErrors` is `none`.
- [ ] `fieldCoverage` is near 100% across the board.
- [ ] ScrapingBee credit balance covers the estimate. To get the real company
      count cheaply before committing to the detail pass, do one run with
      `fetchDetails: false` and read `companiesFoundThisRegion`.

Then set `maxPages: 300`, `maxCompanies: 0`, and run once per region.

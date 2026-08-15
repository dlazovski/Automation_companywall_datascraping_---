# Step 0 — verification checklist

Run `workflows/00-step0-recon.json` before anything else. It makes **4**
ScrapingBee requests (both region searches, one company profile, that company's
`/lica`) and reports what the parsers extracted from the real HTML.

Everything below is unverified until you run it — this repo was built without
network access to companywall.com.mk, so the parsers are written defensively
rather than tuned against real markup.

Open the **`Recon Report`** node output first. `verdict` is the go/no-go.
Then open **`Diagnose`** and walk the four probes.

---

## 1. Did ScrapingBee get through?

| Check | Where | Expected |
| --- | --- | --- |
| HTTP status | `statusCode` | `200` |
| Body size | `htmlLength` | tens of thousands, not a few hundred |
| Bot challenge | `healthFlags` | `none` |

**If `healthFlags` contains `CLOUDFLARE_CHALLENGE` or `CAPTCHA`:** set
`premiumProxy: true` in the Config node and re-run. It costs substantially more
ScrapingBee credits per request, so confirm it is actually needed first.

**If `POSSIBLE_LOGIN_WALL` appears:** you have hit a page requiring
authentication. The workflows never request `/Company/CompanyBonitet?sid=...`
(credit-rating detail, login-only) — if this fires on a `/kompanija/` or
`/lica` URL, stop and report it, because it contradicts the brief's confirmed
finding that those pages are public.

---

## 2. How big is this run really?

This is the number that decides whether Phase 2 is practical.

| Field | Meaning |
| --- | --- |
| `resultsPerPage` | rows parsed from page 1 |
| `reportedTotals` | the site's own result count per region, if it prints one |
| `estimatedPhase1Requests` | pages to crawl per region |

Phase 1 costs **1 request per results page**. Phase 2 costs **2 requests per
company** (profile + `/lica`).

At the default `waitSeconds: 4`, Phase 2 runs at roughly **10 seconds per
company**:

| Unique companies | Phase 2 requests | Phase 2 wall-clock |
| --- | --- | --- |
| 100 | 200 | ~17 min |
| 500 | 1 000 | ~1 h 25 m |
| 1 000 | 2 000 | ~2 h 45 m |
| 2 500 | 5 000 | ~7 h |

`Phase 1 Summary` computes this for your actual count. Read it before running
Phase 2 — with no industry filter, several hundred to a few thousand companies
is plausible.

---

## 3. Are the search rows parsed correctly?

On both `search` probes:

- [ ] `rowsParsed` equals the number of companies actually visible on page 1.
- [ ] `rowsWithEdb` equals `rowsParsed`. If it is much lower, row chunking is
      wrong — check `chunkingMode`.
- [ ] `firstThreeRows`: name, status, address, employees, revenue all belong to
      the right company. **Fields shifted by one company** is the failure mode
      to look for.
- [ ] Every `employees` value is between 1 and 5 — this confirms
      `dsm[1].Code=48` really is the employee filter.
- [ ] `hasNextPageLink` is `true` (a `p=2` link exists), unless the region
      genuinely fits on one page.

`chunkingMode` tells you which strategy won: `no-lookbehind` means each
company's fields follow its link; `lookbehind` means they precede it and the
parser compensated.

---

## 4. Is the profile page parsed correctly?

- [ ] `parsed.phones` and `parsed.emails` contain **every** value shown on the
      page, not just the first.
- [ ] `mailtoCount` is not greater than `parsed.emails.length`. If it is, some
      addresses are in the HTML but were not picked up — check the `Контакти`
      block structure and adjust `valuesUnderLabel` in `lib/parsers.js`.
- [ ] `parsed.nkdCode` / `nkdDesc` are the real industry, e.g.
      `62.010` / `Компјутерско програмирање`.
- [ ] `parsed.dateFounded` and `parsed.address` are populated.
- [ ] `parsed.notes` is empty (notes name whatever was not found).

### The "Прикажи ги сите" question

The brief flags this as unresolved. The probe answers it:

- `showAllToggleHref` — where the toggle actually points.
- `showAllPointsToLica` — `true` means it is just a link to the ownership
  sub-page, i.e. **mislabelled, and the contacts already on the profile page
  are the complete list**. Nothing further to do.
- If it points somewhere else *and* `mailtoCount > emails.length`, the extra
  contacts are lazy-loaded. Set `renderJs: true` in Config (costs ~5x credits)
  and re-run this probe to confirm before using it for the full run.

---

## 5. Is `/lica` parsed correctly?

- [ ] `ownersFound` + `managersFound` match what the page displays.
- [ ] Compare against `rawAnchorCounts` — if the page shows 4 `Претставник`
      blocks and `managersFound` is 1, the parser is only catching the first.
- [ ] Each manager has `name`, `position`, and `from`.
- [ ] Each owner has `name` and `share`. An owner that is a company
      (e.g. `Друштво БТОБЕТ Лимитед`) must be recorded as-is, not treated as a
      person's name.
- [ ] A person holding two roles appears as **two** entries.

---

## 6. If parsing is wrong

Do **not** edit the Code nodes in n8n — they are generated and your edits are
lost on the next import.

1. Save the offending HTML into `tests/fixtures/` (`search-*.html`,
   `profile-*.html`, `lica-*.html`).
2. `npm test` — it reports what the parsers extract from your fixtures.
3. Edit `lib/parsers.js`.
4. `npm run check` — rebuilds, re-tests, re-validates, re-simulates.
5. Re-import the workflow JSON into n8n.

This loop costs zero ScrapingBee credits and sends zero requests to the site.

---

## 7. Before the full run

- [ ] `verdict` is `LOOKS GOOD`.
- [ ] Google Sheet exists, `googleSheetId` + `sheetName` set in **every**
      workflow's Config node.
- [ ] ScrapingBee credit balance covers Phase 1 + Phase 2 (see the table above).
- [ ] Trial Phase 2 with `maxCompaniesPhase2: 25` and inspect those rows before
      committing to the full batch.

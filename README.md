# CompanyWall.mk → Google Sheets (n8n + ScrapingBee)

**One n8n workflow, run twice** — once for Југоисточен регион, once for Источен
регион. Scrapes active companies with **1–5 employees**, **all industries** (no
NKD filter), and writes them to Google Sheets.

All requests go through **ScrapingBee**. Only free, publicly visible pages are
touched — no login, no credentials, and never any `/Company/CompanyBonitet`
credit-rating URL.

The two regions together cover Штип, Радовиш, Струмица, Валандово, Богданци,
Дојран, Гевгелија, Пробиштип, Кочани, Виница, Македонска Каменица, Делчево and
Берово, so no per-town filtering is applied.

---

## ⚠️ Read this before running

**The parsers have never seen the site's real HTML.** This repo was built in an
environment with no ScrapingBee key and no network route to companywall.com.mk
(egress blocked), so nothing here has been run against the live site.

- The URL patterns, region codes and filter parameters are used exactly as
  confirmed in the brief — those are not guesses.
- The **extraction logic is unverified**. It is written defensively (layered
  fallbacks, no CSS-selector assumptions, handles both plausible markup shapes)
  and is covered by 180 offline tests, but real markup always differs.
- **Do a trial run first** — see below. Expect to tune `lib/parsers.js` once.
  That is the designed workflow, not a failure.

---

## Setup

```bash
npm run check     # build + test + validate + simulate (no network, no credits)
```

Import `workflows/companywall-scraper.json` into n8n, then:

1. **ScrapingBee credential** — on all three HTTP Request nodes, select your
   existing ScrapingBee credential. It must be a **Query Auth** credential with
   parameter name `api_key`. (The key is never embedded here; nodes ship with a
   `REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID` placeholder.)
2. **Google Sheets credential** — select it on all three Google Sheets nodes.
3. **Config node** — set `googleSheetId` and `sheetName`.

Create the sheet with a header row containing exactly these 18 columns:

```
Company Name | Status | Address | Tax Number (EDB) | Registration Number (EMBS) |
Employees | Revenue MKD | Phones | Emails | Owners | Managers | NKD Code |
NKD Description | Date Founded | Region | Profile URL | Detail Fetched | Notes
```

---

## Running

Everything is driven from the **Config node** — it is the only thing you edit.

### Step 1 — trial run (7 requests)

```js
const region       = { code: 7, name: 'Southeast' };
const maxPages     = 1;
const maxCompanies = 3;
```

Execute. Check the 3 rows in the sheet and open the **`Run Summary`** node.
Verify:

- every `Employees` value is between 1 and 5 (confirms the employee filter works)
- `Phones` / `Emails` hold **every** value shown on the page, not just the first
- `Owners` has the ownership percentage; `Managers` lists **all** representatives
  with position and from-date
- `NKD Code`, `NKD Description`, `Date Founded` are populated
- `Run Summary.crawlErrors` is `none`, and `fieldCoverage` is near 100%

If anything is wrong → [tuning](#if-parsing-is-wrong). If `Run Summary` reports
`CLOUDFLARE_CHALLENGE` or `CAPTCHA`, set `premiumProxy: true` and retry.

### Step 2 — full run, Southeast

```js
const region       = { code: 7, name: 'Southeast' };
const maxPages     = 300;
const maxCompanies = 0;
```

### Step 3 — full run, East

```js
const region = { code: 2, name: 'East' };
```

Execute again. **That's it — two runs.**

---

## Why running it twice is safe

Every run begins by reading the sheet back, so run 2 knows what run 1 wrote.
Matching is on `Profile URL`, which is always present:

- a company found in **both** regions **updates** its existing row and gets
  `Region = "Southeast + East"` — no duplicate row
- a company already enriched is **not re-scraped**, so run 2 is cheaper
- an interrupted run can simply be executed again — it picks up where it left off
- re-running a region you already did is a no-op

This is verified by simulation, including the full two-run sequence, a third
redundant run, and resuming after a cap.

---

## Cost and time

| Phase | Requests |
| --- | --- |
| Search pagination | 1 per results page |
| Detail per company | 2 (profile + `/lica`) |

At the default `waitSeconds: 4`, the detail pass runs at ~10 s per company:

| Companies | Detail requests | Wall-clock |
| --- | --- | --- |
| 100 | 200 | ~17 min |
| 500 | 1 000 | ~1 h 25 m |
| 1 000 | 2 000 | ~2 h 45 m |
| 2 500 | 5 000 | ~7 h |

With no industry filter, several hundred to a few thousand companies per region
is plausible. Two ways to keep it bounded:

- `fetchDetails: false` — list fields only, 1 request per page and nothing else.
  This still delivers 8 of the 16 fields for every company. Prune the sheet to
  the companies you care about, then set `fetchDetails: true` and run again —
  only the rows still present get enriched.
- `maxCompanies: N` — enrich N per run. Whatever is left stays pending and is
  picked up next run.

---

## Rate limiting

CompanyWall asks users not to send many search requests at once
("Не испраќајте премногу барања за пребарување одеднаш" —
[/pomos](https://www.companywall.com.mk/pomos)). The workflow:

- puts a **Wait node before every single outbound request** (`waitSeconds`,
  default 4);
- keeps **exactly one request in flight** — a single item moving through a
  sequential loop, and one region per run;
- **stops and logs on 403/429** rather than retrying, so a soft block never
  escalates into a hard one.

`npm run validate` fails the build if any HTTP node is not preceded by a Wait,
or does not route through ScrapingBee.

---

## Field coverage

| # | Field | Source |
| --- | --- | --- |
| 1 | Company name | search results |
| 2 | Status | search results |
| 3 | Address | search results |
| 4 | Tax number (ЕДБ) | search results |
| 5 | Registration number (ЕМБС) | search results / profile |
| 6 | Employees | search results |
| 7 | Revenue (MKD) | search results |
| 8, 10 | Phone number(s) — all | profile `Контакти` + `tel:` links |
| 9 | Email address(es) — all | profile `Контакти` + `mailto:` links |
| 11 | Owner(s) + ownership % | `/lica` — `Сопственик` blocks |
| 12 | Manager(s) + position + from-date | `/lica` — **all** `Претставник` blocks |
| 13 | NKD code + description | profile |
| 14 | Date founded | profile |
| 15 | Region | which run found it |
| 16 | Profile URL | search results |

Fields 1–7 and 16 come from the **search results page**, so the workflow does not
visit a profile just to get them.

Multi-value fields (phones, emails, owners, managers) are written **joined with
`; ` into one cell** — variable counts per company make fixed columns awkward.
Change `multiValueSeparator` in Config, or say the word and I'll switch it to one
column per value.

An owner may be a company rather than a person, and is recorded verbatim.
A person holding several roles produces one entry per role.

---

## Error handling

A record is **never dropped because a regex missed**. Rows always carry the
profile URL plus a `Notes` column naming what failed (`NO_PHONE_FOUND`,
`EDB_NOT_FOUND`, `LICA_BLOCKED_403`, …) so they can be reviewed by hand.

`Run Summary` reports per-field coverage percentages and flags two specific
failure patterns: requests blocked by the site, and "no owners or managers for
*any* company", which means the `/lica` parser needs tuning rather than the data
being absent.

---

## If parsing is wrong

Do **not** edit the Code nodes in n8n — they are generated from `lib/parsers.js`
and your edits are lost on the next import.

1. Save the offending HTML into `tests/fixtures/` as `search-*.html`,
   `profile-*.html` or `lica-*.html`. (Copy it from the `Fetch …` node output in
   the n8n execution view.)
2. `npm test` — reports what the parsers extract from your fixtures.
3. Edit `lib/parsers.js`.
4. `npm run check` — rebuilds, re-tests, re-validates, re-simulates.
5. Re-import the workflow.

This loop costs zero ScrapingBee credits and sends zero requests to the site.

---

## Development

Parsing logic lives in **one place**: [`lib/parsers.js`](lib/parsers.js). The
workflow JSON is generated from it — the Code nodes are build output.

```bash
npm run build      # regenerate workflows/companywall-scraper.json
npm test           # 88 unit tests + a report on any real fixtures you saved
npm run validate   # JS syntax in every Code node, graph integrity, rate-limit rule
npm run simulate   # 92 end-to-end tests executing the generated node code
npm run check      # all of the above
```

`simulate` runs the **actual generated Code nodes** against a mock n8n runtime,
a mock Google Sheet and mock HTTP responses. It covers the full two-run sequence
(including the cross-region merge and the skip-already-enriched behaviour),
pagination, stop-on-empty, the `maxPages` guard, 403 handling on both the search
and detail passes, unparseable pages, and every Config switch.

### Layout

```
lib/parsers.js            all parsing + URL building (single source of truth)
scripts/build.mjs         generates the workflow JSON
scripts/validate.mjs      structural checks on the generated JSON
scripts/simulate.mjs      end-to-end run of the generated code against mocks
scripts/test-parsers.mjs  unit tests + real-fixture report
workflows/                generated — import into n8n
docs/verification.md      what to check on the trial run
```

### Zero dependencies, deliberately

n8n Cloud Code nodes cannot `require()` external modules, and self-hosted needs
`NODE_FUNCTION_ALLOW_EXTERNAL=cheerio`. So instead of a DOM parser, the HTML is
linearised into text lines and read with small label/value state machines. This
also survives markup changes that would break CSS selectors, and it matches the
shape in which the pages were described in the brief.

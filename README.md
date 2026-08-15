# CompanyWall.mk → Google Sheets (n8n + ScrapingBee)

Scrapes active companies from [companywall.com.mk](https://www.companywall.com.mk)
filtered to **1–5 employees**, **Southeast (`r=7`) + East (`r=2`) regions**,
**all industries** (no NKD filter), and writes them to Google Sheets.

All requests go through **ScrapingBee**. Only free, publicly visible pages are
touched — no login, no credentials, and never any `/Company/CompanyBonitet`
credit-rating URL.

The two region filters together cover Штип, Радовиш, Струмица, Валандово,
Богданци, Дојран, Гевгелија, Пробиштип, Кочани, Виница, Македонска Каменица,
Делчево and Берово, so no per-town filtering is applied.

---

## ⚠️ Read this before running

**Step 0 has not been run.** This repo was built in an environment with no
ScrapingBee key and no network route to companywall.com.mk (egress blocked), so
**no parser here has ever seen the site's real HTML.**

What that means in practice:

- The URL patterns, region codes and filter parameters are used exactly as
  confirmed in the brief — those are not guesses.
- The **extraction logic is unverified**. It is written defensively (layered
  fallbacks, both markup shapes, no CSS-selector assumptions) and is covered by
  144 offline tests, but real markup always differs.
- `workflows/00-step0-recon.json` exists to resolve this in 4 requests. **Run it
  first** and work through [`docs/step0-checklist.md`](docs/step0-checklist.md).

Expect to tune `lib/parsers.js` once after Step 0. That is the designed workflow,
not a failure.

---

## Setup

```bash
npm run check     # build + test + validate + simulate (no network, no credits)
```

Then in n8n, import all three files from `workflows/`, and in **each** one:

1. **ScrapingBee credential** — on every HTTP Request node, select your existing
   ScrapingBee credential. It must be a **Query Auth** credential with parameter
   name `api_key`. (The workflows deliberately do not embed the key; nodes ship
   with a `REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID` placeholder.)
2. **Google Sheets credential** — select it on the Google Sheets nodes.
3. **Config node** — set `googleSheetId` (from the sheet URL,
   `/spreadsheets/d/<THIS>/edit`) and `sheetName`.

Create the sheet with a header row containing exactly these 18 columns:

```
Company Name | Status | Address | Tax Number (EDB) | Registration Number (EMBS) |
Employees | Revenue MKD | Phones | Emails | Owners | Managers | NKD Code |
NKD Description | Date Founded | Region | Profile URL | Detail Fetched | Notes
```

---

## Running

Run in order. Each is a Manual Trigger — this is a one-time job, nothing is
scheduled.

### `00-step0-recon.json` — verify first (4 requests)

Probes both region searches, one company profile and its `/lica` page, then runs
the real parsers against the real HTML and reports what they found. Read
`Recon Report` → `verdict`, and follow
[`docs/step0-checklist.md`](docs/step0-checklist.md).

### `01-phase1-list-scrape.json` — the cheap pass (1 request per results page)

Paginates `r=7`, then `r=2`, until a page returns nothing new. Extracts the
fields **already present in the search results** — name, status, ЕДБ, address,
employees, revenue — so no profile pages are visited. Dedupes and writes one row
per unique company.

`Phase 1 Summary` is the **checkpoint**: unique company count, per-region
breakdown, and exactly what Phase 2 will cost in requests and hours. Read it
before continuing.

### `02-phase2-detail-enrichment.json` — the expensive pass (2 requests per company)

Reads the sheet back and enriches each row with phones, emails, owners (+ %),
managers (+ position + from-date), NKD code/description and date founded — from
the profile page and its `/lica` sub-page.

**Trial it first:** set `maxCompaniesPhase2: 25` in Config, run, inspect those
rows, then set it back to `0`.

Because it reads from the sheet, the checkpoint is real: **delete rows before
running and Phase 2 only enriches what is left.**

---

## Why three workflows instead of one

The brief specifies one 14-step workflow *and* a checkpoint at step 7 that
requires confirming the company count before fetching profile pages. n8n cannot
pause mid-execution for that. Splitting at exactly that point makes the
checkpoint real rather than advisory — and Phase 2 becomes resumable and
restrictable as a side effect. Everything else follows the brief's structure.

---

## Cost and time

Phase 1 is cheap. Phase 2 dominates, at ~10 seconds of wall-clock per company
(2 requests × [4s wait + latency]):

| Unique companies | Phase 2 requests | Phase 2 wall-clock |
| --- | --- | --- |
| 100 | 200 | ~17 min |
| 500 | 1 000 | ~1 h 25 m |
| 1 000 | 2 000 | ~2 h 45 m |
| 2 500 | 5 000 | ~7 h |

With no industry filter, several hundred to a few thousand companies is
plausible — hence the checkpoint. `Phase 1 Summary` computes the real figure.

If Phase 2 is too expensive for the full set, Phase 1 alone already delivers 8
of the 16 requested fields for every company. Prune the sheet to the companies
you care about and enrich only those.

---

## Rate limiting

CompanyWall asks users not to send many search requests at once
("Не испраќајте премногу барања за пребарување одеднаш" —
[/pomos](https://www.companywall.com.mk/pomos)). The workflows:

- put a **Wait node before every single outbound request** (`waitSeconds`,
  default 4, tune in Config);
- keep **exactly one request in flight** — the crawl is a single item moving
  through a sequential loop, with regions worked through as a queue rather than
  in parallel;
- **stop and log on 403/429** rather than retrying, so a soft block never
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
| 15 | Region | which search returned it |
| 16 | Profile URL | search results |

Multi-value fields (phones, emails, owners, managers) are written **joined with
`; ` into one cell** — variable counts per company make fixed columns awkward.
Change `multiValueSeparator` in Config, or say the word and I will switch it to
one column per value.

An owner may be a company rather than a person and is recorded verbatim.
A person holding several roles produces one entry per role.

---

## Error handling

Per the brief, a record is **never dropped because a regex missed**. Rows always
carry the profile URL plus a `Notes` column naming what failed
(`NO_PHONE_FOUND`, `EDB_NOT_FOUND`, `LICA_BLOCKED_403`, …), so they can be
reviewed by hand.

`Phase 2 Summary` reports per-field coverage percentages. Low coverage across
the board means a parser needs tuning, not that the data is absent.

---

## Development

Parsing logic lives in **one place**: [`lib/parsers.js`](lib/parsers.js). The
workflow JSON is generated from it — the Code nodes are build output.

> **Do not edit Code nodes inside n8n.** Edit `lib/parsers.js`, run
> `npm run build`, re-import.

```bash
npm run build      # regenerate workflows/*.json from lib/parsers.js
npm test           # 88 unit tests + a report on any real fixtures you saved
npm run validate   # JS syntax in every Code node, graph integrity, rate-limit rule
npm run simulate   # 56 end-to-end tests executing the generated node code
npm run check      # all of the above
```

`simulate` runs the **actual generated Code nodes** against a mock n8n runtime
and mock HTTP responses, covering pagination, the region queue, stop-on-empty,
403 handling, cross-region dedupe, Phase 2 merge, resumability and the batch
limit. No network, no ScrapingBee credits.

To tune against real markup, drop pages into `tests/fixtures/` — see
[`tests/fixtures/README.md`](tests/fixtures/README.md).

### Layout

```
lib/parsers.js       all parsing + URL building (single source of truth)
scripts/build.mjs    generates workflows/*.json
scripts/validate.mjs structural checks on the generated JSON
scripts/simulate.mjs end-to-end run of the generated code against mocks
scripts/test-parsers.mjs unit tests + real-fixture report
workflows/           generated — import these into n8n
docs/step0-checklist.md
```

### Zero dependencies, deliberately

n8n Cloud Code nodes cannot `require()` external modules, and self-hosted needs
`NODE_FUNCTION_ALLOW_EXTERNAL=cheerio`. So instead of a DOM parser, the HTML is
linearised into text lines and read with small label/value state machines. This
also happens to survive markup changes that would break CSS selectors, and it
matches the shape in which the pages were described in the brief.

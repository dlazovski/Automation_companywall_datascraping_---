/**
 * Generates workflows/companywall-scraper.json from lib/parsers.js.
 *
 * One workflow, run once per region: set `region` in the Config node, execute,
 * then change it and execute again. The second run reads the sheet back first,
 * so a company found in both regions updates its existing row (Region becomes
 * "Southeast + East") instead of being written twice or re-scraped.
 *
 * Why generated rather than hand-written: the parser logic must live in exactly
 * one place. After a trial run you will tune selectors in lib/parsers.js, run
 * `npm run build`, and re-import — no copy-paste drift across Code nodes.
 *
 * Usage: node scripts/build.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'workflows');

/* ------------------------------------------------------------------ *
 * Pull the injectable region out of lib/parsers.js
 * ------------------------------------------------------------------ */

const parsersSrc = readFileSync(resolve(ROOT, 'lib/parsers.js'), 'utf8');
const START = '// #region injectable';
const END = '// #endregion injectable';
const startIdx = parsersSrc.indexOf(START);
const endIdx = parsersSrc.indexOf(END);
if (startIdx < 0 || endIdx < 0) {
  throw new Error('Could not find the injectable region markers in lib/parsers.js');
}
const LIB = parsersSrc.slice(startIdx + START.length, endIdx).trim();

const PREAMBLE = [
  '/* ===================================================================',
  ' * AUTO-GENERATED from lib/parsers.js by scripts/build.mjs.',
  ' * Do not edit inside n8n — edit lib/parsers.js and re-run `npm run build`,',
  ' * otherwise your changes are lost on the next import.',
  ' * =================================================================== */',
  ''
].join('\n');

/** Wrap node body code with the shared library. */
const code = (body) => `${PREAMBLE}${LIB}\n\n/* ---------- node logic ---------- */\n\n${body.trim()}\n`;

/* ------------------------------------------------------------------ *
 * Node factories
 * ------------------------------------------------------------------ */

let idSeq = 0;
const uid = (name) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${++idSeq}`;

function manualTrigger(name, pos) {
  return {
    parameters: {},
    id: uid(name),
    name,
    type: 'n8n-nodes-base.manualTrigger',
    typeVersion: 1,
    position: pos
  };
}

function codeNode(name, pos, body, { forEach = false } = {}) {
  const parameters = { jsCode: code(body) };
  if (forEach) parameters.mode = 'runOnceForEachItem';
  return {
    parameters,
    id: uid(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position: pos
  };
}

function waitNode(name, pos) {
  return {
    parameters: {
      amount: "={{ $('Config').first().json.waitSeconds }}",
      unit: 'seconds'
    },
    id: uid(name),
    name,
    type: 'n8n-nodes-base.wait',
    typeVersion: 1.1,
    position: pos,
    webhookId: `cw-${uid(name)}`
  };
}

/**
 * ScrapingBee GET.
 *
 * - `neverError` + `fullResponse` so a 403/429 arrives as data we can log and
 *   halt on, instead of throwing and losing the loop state.
 * - api_key is NOT set here: it comes from the httpQueryAuth credential, which
 *   is how an existing ScrapingBee key is stored in n8n.
 */
function scrapingBee(name, pos, urlExpr) {
  return {
    parameters: {
      url: 'https://app.scrapingbee.com/api/v1/',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'url', value: urlExpr },
          { name: 'render_js', value: "={{ $('Config').first().json.renderJs ? 'true' : 'false' }}" },
          { name: 'premium_proxy', value: "={{ $('Config').first().json.premiumProxy ? 'true' : 'false' }}" }
        ]
      },
      options: {
        timeout: 120000,
        response: {
          response: {
            fullResponse: true,
            neverError: true,
            responseFormat: 'text',
            outputPropertyName: 'body'
          }
        }
      }
    },
    id: uid(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: pos,
    credentials: {
      httpQueryAuth: { id: 'REPLACE_WITH_SCRAPINGBEE_CREDENTIAL_ID', name: 'ScrapingBee API Key' }
    },
    notes: 'Select your existing ScrapingBee credential here (Query Auth, param name: api_key).'
  };
}

function ifNode(name, pos, valueExpr) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [
          {
            id: uid('cond'),
            leftValue: valueExpr,
            rightValue: '',
            operator: { type: 'boolean', operation: 'true', singleValue: true }
          }
        ],
        combinator: 'and'
      },
      looseTypeValidation: true,
      options: {}
    },
    id: uid(name),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position: pos
  };
}

function splitInBatches(name, pos, size = 1) {
  return {
    parameters: { batchSize: size, options: { reset: false } },
    id: uid(name),
    name,
    type: 'n8n-nodes-base.splitInBatches',
    typeVersion: 3,
    position: pos
  };
}

function sheets(name, pos, { operation, matchingColumns }) {
  const parameters = {
    operation,
    documentId: {
      __rl: true,
      value: "={{ $('Config').first().json.googleSheetId }}",
      mode: 'id'
    },
    sheetName: {
      __rl: true,
      value: "={{ $('Config').first().json.sheetName }}",
      mode: 'name'
    },
    columns: {
      mappingMode: 'autoMapInputData',
      value: {},
      matchingColumns: matchingColumns || [],
      schema: []
    },
    options: {}
  };
  return {
    parameters,
    id: uid(name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position: pos,
    credentials: {
      googleSheetsOAuth2Api: { id: 'REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID', name: 'Google Sheets account' }
    },
    notes: 'Select your Google Sheets credential, and set googleSheetId / sheetName in the Config node.'
  };
}

function sheetsRead(name, pos) {
  return {
    parameters: {
      documentId: { __rl: true, value: "={{ $('Config').first().json.googleSheetId }}", mode: 'id' },
      sheetName: { __rl: true, value: "={{ $('Config').first().json.sheetName }}", mode: 'name' },
      options: {}
    },
    id: uid(name),
    name,
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position: pos,
    // A sheet holding only headers returns zero items, which would stall the
    // whole workflow. Always emit one (empty) item so the crawl still starts.
    alwaysOutputData: true,
    credentials: {
      googleSheetsOAuth2Api: { id: 'REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID', name: 'Google Sheets account' }
    },
    notes: 'Reads rows written by previous runs, so run 2 can merge regions and skip already-enriched companies.'
  };
}

function noOp(name, pos) {
  return {
    parameters: {},
    id: uid(name),
    name,
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position: pos
  };
}

function sticky(content, pos, size = [460, 260], color = 4) {
  return {
    parameters: { content, height: size[1], width: size[0], color },
    id: uid('note'),
    name: `Note ${++idSeq}`,
    type: 'n8n-nodes-base.stickyNote',
    typeVersion: 1,
    position: pos
  };
}

/** Build the connections map from a compact [from, to, outputIndex] list. */
function connect(edges) {
  const conns = {};
  for (const [from, to, out = 0] of edges) {
    conns[from] = conns[from] || { main: [] };
    while (conns[from].main.length <= out) conns[from].main.push([]);
    conns[from].main[out].push({ node: to, type: 'main', index: 0 });
  }
  return conns;
}

function workflow(name, nodes, edges) {
  return {
    name,
    nodes,
    connections: connect(edges),
    settings: { executionOrder: 'v1' },
    pinData: {},
    meta: { instanceId: 'companywall-scraper' }
  };
}


/* ================================================================== *
 * Config — the only node you edit between runs
 * ================================================================== */

const CONFIG_BODY = `
// ===== 1. SET THE REGION FOR THIS RUN =====================================
// Run 1 — Југоисточен регион (Southeast): { code: 7, name: 'Southeast' }
// Run 2 — Источен регион     (East):      { code: 2, name: 'East' }
//
// Change this line, save, execute again. The workflow reads the sheet back at
// the start of every run, so run 2 updates rows run 1 already wrote rather than
// duplicating them — a company found in both regions ends up with
// Region = "Southeast + East" and is not scraped twice.
const region = { code: 7, name: 'Southeast' };

// ===== 2. SET YOUR SHEET ==================================================
const googleSheetId = 'PUT_YOUR_GOOGLE_SHEET_ID_HERE'; // /spreadsheets/d/<THIS>/edit
const sheetName     = 'Companies';                     // tab name

// ===== 3. RUN SIZE ========================================================
// TRIAL RUN (do this first, before either full run):
//     maxPages: 1, maxCompanies: 3
//   -> 1 search page + 3 companies = 7 requests. Check the sheet and the
//      Run Summary node, tune lib/parsers.js if anything is wrong.
// FULL RUN:
//     maxPages: 300, maxCompanies: 0
// The search stops serving results past a certain depth (a live run capped out
// at 60 companies for a whole region). Splitting the employee filter into one
// search per value multiplies that ceiling and is why a full region comes back.
// Set to false only to reproduce the old single-query behaviour.
const splitByEmployeeCount = true;

// ===== TOWNS (optional, but this is how you get past ~300 per region) =====
// Each search shows at most ~60 results however deep you page, so a region-wide
// search caps out. One search PER TOWN per headcount keeps every search under
// that ceiling — and these are the towns you actually want anyway.
//
// To find a code: open the site's advanced search, pick the town, and read the
// c=NNN value out of the address bar. Leave the list empty to search the whole
// region (the old behaviour).
const towns = [
  // { code: '', name: 'Штип' },
  // { code: '', name: 'Струмица' },
];

// Simpler alternative to the list above: set ONE town code here and run once
// per town, changing only this line. Ignored when the towns list above is used.
const townCode = '';

const maxPages     = 300; // safety stop, per slice
const maxCompanies = 0;   // 0 = every company found; otherwise cap the detail pass
const fetchDetails = true; // false = list fields only, no profile/lica requests

return [{
  json: {
    region,
    googleSheetId,
    sheetName,
    maxPages,
    maxCompanies,
    fetchDetails,
    splitByEmployeeCount,
    towns,
    townCode,

    employeesFrom: 1,
    employeesTo: 5,

    // Rate limiting. CompanyWall asks not to send many search requests at once
    // ("Не испраќајте премногу барања за пребарување одеднаш").
    // Every outbound request is preceded by a Wait of this many seconds, and the
    // workflow keeps exactly one request in flight at a time.
    waitSeconds: 4,

    // ScrapingBee. The search and profile pages are plain server-rendered HTML,
    // so render_js is not needed. Turn premiumProxy on only if the Run Summary
    // reports CLOUDFLARE_CHALLENGE / CAPTCHA — it costs far more credits.
    renderJs: false,
    premiumProxy: false,

    // Phones, emails, owners and managers go into one cell each, joined by this.
    multiValueSeparator: '; '
  }
}];
`;

/* ================================================================== *
 * The workflow
 * ================================================================== */

function buildWorkflow() {
  const nodes = [
    manualTrigger('When clicking Execute', [-1120, 300]),
    codeNode('Config', [-900, 300], CONFIG_BODY),
    sheetsRead('Read Existing Sheet', [-680, 300]),
    codeNode('Seed State', [-460, 300], `
// Seeds the pagination crawl for the single region set in Config.
//
// The search will only page so deep before it stops serving results — a live
// run collected exactly 60 companies (3 pages x 20) for a whole region, which
// is a ceiling, not a real total. You cannot page past it, but you can go
// around it: several narrower searches each stay under the ceiling, and their
// union is the full set. The employee filter is the natural axis, since a
// company has exactly one employee count, so the slices do not overlap.
//
// Previously-written rows are NOT copied into this item — the crawl state is
// carried through every loop iteration, so it is kept small. Prepare Companies
// reads them straight from $('Read Existing Sheet') instead.
const cfg = $('Config').first().json;

const from = Number(cfg.employeesFrom);
const to   = Number(cfg.employeesTo);

// One search per (town x headcount). Both axes partition cleanly — a company
// sits in exactly one town and has exactly one headcount — so the slices never
// overlap, and their union is the whole region.
// A town with no code would search the whole region and blow past the ceiling,
// so blanks are dropped rather than silently widening the search.
let towns = (Array.isArray(cfg.towns) ? cfg.towns : [])
  .filter(t => t && String(t.code || '').trim());
if (!towns.length) towns = [{ code: '', name: '', region: cfg.region }];

const heads = [];
if (cfg.splitByEmployeeCount !== false) {
  for (let n = from; n <= to; n++) heads.push({ from: n, to: n });
} else {
  heads.push({ from: from, to: to });
}

// Each town carries its own region, so a single run can span both — the towns
// of interest are split across Southeast and East.
const slices = [];
towns.forEach(t => {
  const reg = t.region || cfg.region;
  heads.forEach(h => {
    const head = h.from === h.to ? h.from + ' employees' : h.from + '-' + h.to + ' employees';
    slices.push({
      from: h.from,
      to: h.to,
      town: t.code || '',
      regionCode: reg.code,
      regionName: reg.name,
      label: (t.name ? t.name + ', ' : '') + head
    });
  });
});

return [{
  json: {
    regionCode: cfg.region.code,
    regionName: cfg.region.name,
    slices,
    sliceIdx: 0,
    page: 1,
    companies: [],
    seen: [],
    errors: [],
    pagesFetched: 0,
    perSlice: [],
    sliceRows: 0,
    totalReported: null
  }
}];
`),
    codeNode('Build Search URL', [-240, 300], `
const cfg = $('Config').first().json;
const st = $input.item.json;
const slice = st.slices[st.sliceIdx];

// Town comes from the slice when Seed State built a town x headcount grid.
// Falling back to cfg.townCode lets a single town be driven from Config alone,
// so one town per run works without touching Seed State.
const town = slice.town || cfg.townCode || '';

// The slice's own region wins. Writing it back into the item is what lets
// Parse Search Page tag companies per town without any change of its own.
const regionCode = slice.regionCode != null ? slice.regionCode : st.regionCode;
const regionName = slice.regionName || st.regionName;

return {
  json: Object.assign({}, st, {
    regionCode,
    regionName,
    sliceLabel: slice.label + (town && !slice.town ? ' (town ' + town + ')' : ''),
    targetUrl: buildSearchUrl(regionCode, st.page, slice.from, slice.to, town)
  })
};
`, { forEach: true }),
    waitNode('Wait Before Search', [-20, 300]),
    scrapingBee('Fetch Search Page', [200, 300], '={{ $json.targetUrl }}'),
    codeNode('Parse Search Page', [420, 300], `
const cfg  = $('Config').first().json;
const st   = $('Build Search URL').item.json;
const resp = $input.item.json;

const statusCode = resp.statusCode == null ? 0 : resp.statusCode;
const html = String(resp.body == null ? (resp.data == null ? '' : resp.data) : resp.body);

const errors = (st.errors || []).slice();
const seen   = new Set(st.seen || []);
const perSlice = (st.perSlice || []).slice();
const slice = st.slices[st.sliceIdx];
let totalReported = st.totalReported == null ? null : st.totalReported;
let companies = (st.companies || []).slice();
let sliceRows = st.sliceRows || 0;
let lastEmptyDiagnostic = st.lastEmptyDiagnostic || '';
// One unproductive page used to end the crawl. Against a search that really has
// 239 pages, a single blip — a hiccup, a repeated response — would silently cost
// thousands of companies. Require a few in a row before believing it.
let emptyStreak = st.emptyStreak || 0;
const EMPTY_STREAK_LIMIT = 3;
// A block is about US, not about this slice. Continuing through the remaining
// slices would be four more requests at a site that just refused one — exactly
// the hammering the rate-limit rules forbid. Abandon the whole run instead.
let abortAll = false;

let stop = false;
let pageRows = 0;
let newRows = 0;
let healthFlags = [];

// The brief is explicit: on 403/429 stop and log. Do NOT retry in a loop —
// that is how a soft block becomes a hard one.
if (statusCode === 403 || statusCode === 429) {
  errors.push('BLOCKED ' + statusCode + ' on ' + slice.label + ' page ' + st.page + ' — abandoned the whole run rather than retry. Raise waitSeconds, or set premiumProxy: true.');
  stop = true;
  abortAll = true;
} else if (statusCode >= 400 || !html) {
  errors.push('HTTP ' + statusCode + ' on ' + slice.label + ' page ' + st.page + ' — stopped.');
  stop = true;
} else {
  healthFlags = diagnoseResponse(html);

  // Always parse. Health flags alone are NOT grounds to abort: the site loads
  // reCAPTCHA on its own login form, so challenge-looking strings appear in
  // perfectly good pages. Getting rows back is the only proof that matters, so
  // the flags are consulted below only to explain an empty result.
  const parsed = parseSearchResults(html);
  pageRows = parsed.rows.length;

  // The site prints its own result count ("Пронајдени N резултати"). Keeping it
  // is the only way to tell "the region really is this small" apart from
  // "pagination stopped early" — the two look identical from the row counts.
  if (parsed.total != null && totalReported == null) totalReported = parsed.total;

  // Keyed per slice: the stop signal is "this slice served nothing new".
  // Cross-slice duplicates are handled later by dedupeCompanies.
  const key = r => st.sliceIdx + '|' + r.profileUrl;

  const fresh = parsed.rows.filter(r => r.profileUrl && !seen.has(key(r)));
  fresh.forEach(r => {
    seen.add(key(r));
    r.region = st.regionName;
    r.regionCode = st.regionCode;
    companies.push(r);
  });
  newRows = fresh.length;
  sliceRows += newRows;

  if (pageRows && !parsed.rowsWithEdb) {
    errors.push('Page ' + st.page + ': parsed ' + pageRows + ' rows but none had a ЕДБ — row parsing needs tuning. Save the HTML into tests/fixtures/ and run npm test.');
  }

  // Exhausted only after several consecutive pages bring nothing new.
  if (newRows === 0) {
    emptyStreak += 1;
    if (emptyStreak >= EMPTY_STREAK_LIMIT) stop = true;
  } else {
    emptyStreak = 0;
  }

  // An empty slice is ordinary — no company in this region has exactly this
  // headcount. Only a challenge page is worth reporting here; "the whole region
  // came back empty" is diagnosed once, in Run Summary.
  if (st.page === 1 && pageRows === 0) {
    const blocking = healthFlags.filter(isBlockingFlag);
    if (blocking.length) {
      errors.push('CHALLENGE on ' + slice.label + ' page 1 (' + blocking.join(',') + ', ' + html.length + ' bytes) — skipping this search and carrying on. If many searches report this, set premiumProxy: true.');
    }
    lastEmptyDiagnostic = slice.label + ': HTTP 200, ' + html.length + ' bytes, flags: ' + (healthFlags.join(',') || 'none');
  }

  if (st.page >= cfg.maxPages) {
    errors.push(slice.label + ': hit maxPages (' + cfg.maxPages + ') — results may be truncated. Raise it.');
    stop = true;
  }
}

// "stop" ends the current SLICE, not the crawl. Move to the next one; the run
// is finished only when every slice is exhausted.
let sliceIdx = st.sliceIdx;
let page = st.page + 1;

if (stop) {
  perSlice.push({
    slice: slice.label,
    companies: sliceRows,
    pages: Math.max(1, st.page - emptyStreak),
    siteReportedTotal: totalReported
  });
  sliceIdx = st.sliceIdx + 1;
  page = 1;
  sliceRows = 0;
  emptyStreak = 0;
  totalReported = null; // each slice reports its own total
}

return {
  json: {
    regionCode: st.regionCode,
    regionName: st.regionName,
    slices: st.slices,
    sliceIdx,
    page,
    companies,
    seen: Array.from(seen),
    errors,
    pagesFetched: (st.pagesFetched || 0) + 1,
    perSlice,
    sliceRows,
    lastEmptyDiagnostic,
    emptyStreak,
    totalReported,
    aborted: abortAll || !!st.aborted,
    hasMore: !abortAll && sliceIdx < st.slices.length,
    lastPage: { slice: slice.label, page: st.page, rows: pageRows, newRows, statusCode, htmlLength: html.length, healthFlags }
  }
};
`, { forEach: true }),
    ifNode('More Pages?', [640, 300], '={{ $json.hasMore }}'),
    codeNode('Prepare Companies', [880, 420], `
// Runs once, when the region is fully crawled.
// Merges this run's findings with whatever a previous run already wrote, so
// that running the workflow again for the other region tops up the same rows.
const cfg = $('Config').first().json;
const st  = $input.first().json;

// Index previous rows two ways. Google Sheets matches on Profile URL, but the
// brief's dedupe key is ЕДБ — so a company that surfaced in the other region
// under a DIFFERENT profile URL must still resolve to the same row.
const byUrl = {};
const byEdb = {};
$('Read Existing Sheet').all()
  .map(i => i.json)
  .filter(r => r && r['Profile URL'])
  .forEach(r => {
    byUrl[String(r['Profile URL']).replace(/\\/+$/, '')] = r;
    const e = String(r['Tax Number (EDB)'] || '').trim();
    if (e) byEdb[e] = r; // never index on an empty ЕДБ — they would all collide
  });

// A cell is "blank" only when it holds nothing. A real 0 (revenue) is a value.
const isBlank = v => v === '' || v === null || v === undefined;

return dedupeCompanies(st.companies || []).map(c => {
  const prev = byUrl[c.profileUrl] || (c.edb ? byEdb[c.edb] : null);

  // Write against the URL the existing row already uses, so appendOrUpdate
  // updates that row rather than appending a second one for the same company.
  const prevUrl = prev && prev['Profile URL'] ? String(prev['Profile URL']).replace(/\\/+$/, '') : '';
  const rowUrl = prevUrl || c.profileUrl;

  const notes = (c.notes || []).slice();
  if (prevUrl && prevUrl !== c.profileUrl) {
    notes.push('MATCHED_BY_EDB_ALT_URL:' + c.profileUrl);
  }

  // A company can legitimately appear in both regions — keep both labels.
  let region = c.region;
  if (prev && prev['Region']) {
    const regions = String(prev['Region']).split(/\\s*\\+\\s*/).map(s => s.trim()).filter(Boolean);
    if (regions.indexOf(c.region) < 0) regions.push(c.region);
    region = regions.join(' + ');
  }

  const alreadyDetailed = !!prev && String(prev['Detail Fetched'] || '').toLowerCase() === 'yes';
  const row = buildSheetRow(
    Object.assign({}, c, { region, notes, profileUrl: rowUrl, detailFetched: alreadyDetailed }),
    cfg.multiValueSeparator
  );

  // Never blank a cell that already holds something.
  //
  // This pass only sees the search-results fields, so every column the DETAIL
  // pass fills — phones, emails, owners, managers, NKD, date founded, and ЕМБС,
  // which appears on the profile page but not in search results — would
  // otherwise be overwritten with an empty string on every subsequent run.
  // A blanket rule is used rather than a list of column names so that adding a
  // column later cannot silently reintroduce the bug. Fresh non-empty values
  // still win, so genuinely updated data is not held back.
  if (prev) {
    Object.keys(row).forEach(k => {
      if (isBlank(row[k]) && !isBlank(prev[k])) row[k] = prev[k];
    });
    if (alreadyDetailed) row['Detail Fetched'] = 'yes';
  }
  return { json: row };
});
`),
    sheets('Write List Rows', [1100, 420], {
      operation: 'appendOrUpdate',
      matchingColumns: ['Profile URL']
    }),
    codeNode('Select For Detail', [1320, 420], `
// Decides which companies still need their profile + /lica fetched.
// Always returns at least one item so the workflow can reach Run Summary even
// when there is nothing to enrich.
const cfg = $('Config').first().json;
const prepared = $('Prepare Companies').all().map(i => i.json);

if (!cfg.fetchDetails) {
  return [{ json: { __none: true, reason: 'fetchDetails is false — list fields only.' } }];
}

let pending = prepared.filter(r =>
  r['Profile URL'] && String(r['Detail Fetched'] || '').toLowerCase() !== 'yes');

const limit = Number(cfg.maxCompanies) || 0;
const skippedByLimit = limit > 0 ? Math.max(0, pending.length - limit) : 0;
if (limit > 0) pending = pending.slice(0, limit);

if (!pending.length) {
  return [{ json: { __none: true, reason: 'Every company found is already enriched from a previous run.' } }];
}

return pending.map(r => {
  const url = String(r['Profile URL']).replace(/\\/+$/, '');
  return { json: { profileUrl: url, licaUrl: url + '/lica', existing: r, skippedByLimit } };
});
`),
    ifNode('Need Details?', [1540, 420], '={{ !$json.__none }}'),
    splitInBatches('Loop Companies', [1760, 520], 1),
    waitNode('Wait Before Profile', [1980, 660]),
    scrapingBee('Fetch Profile', [2200, 660], "={{ $('Loop Companies').item.json.profileUrl }}"),
    waitNode('Wait Before Lica', [2420, 660]),
    scrapingBee('Fetch Lica', [2640, 660], "={{ $('Loop Companies').item.json.licaUrl }}"),
    codeNode('Merge Detail', [2860, 660], `
const cfg = $('Config').first().json;
const src = $('Loop Companies').item.json;
const existing = src.existing || {};

function bodyOf(resp) {
  if (!resp) return { html: '', status: 0 };
  return {
    html: String(resp.body == null ? (resp.data == null ? '' : resp.data) : resp.body),
    status: resp.statusCode == null ? 0 : resp.statusCode
  };
}

const prof = bodyOf($('Fetch Profile').item.json);
const lica = bodyOf($input.item.json);

const notes = [];
let p = { phones: [], emails: [], nkdCode: '', nkdDesc: '', dateFounded: '', address: '', name: '', edb: '', embs: '', notes: [] };
let l = { owners: [], managers: [] };

if (prof.status === 403 || prof.status === 429) notes.push('PROFILE_BLOCKED_' + prof.status);
else if (prof.status >= 400 || !prof.html) notes.push('PROFILE_HTTP_' + prof.status);
else { p = parseProfile(prof.html); notes.push.apply(notes, p.notes || []); }

if (lica.status === 403 || lica.status === 429) notes.push('LICA_BLOCKED_' + lica.status);
else if (lica.status >= 400 || !lica.html) notes.push('LICA_HTTP_' + lica.status);
else {
  l = parseLica(lica.html);
  if (!l.owners.length && !l.managers.length) notes.push('LICA_NO_PEOPLE_PARSED');
}

// The list fields came from the filtered search and win; the profile page only
// fills gaps. Detail-only fields always come from this pass.
const merged = {
  name: existing['Company Name'] || p.name,
  status: existing['Status'] || '',
  address: existing['Address'] || p.address,
  edb: existing['Tax Number (EDB)'] || p.edb,
  embs: existing['Registration Number (EMBS)'] || p.embs,
  employees: existing['Employees'] === '' || existing['Employees'] == null ? null : existing['Employees'],
  revenue: existing['Revenue MKD'] === '' || existing['Revenue MKD'] == null ? null : existing['Revenue MKD'],
  phones: p.phones,
  emails: p.emails,
  owners: l.owners,
  managers: l.managers,
  nkdCode: p.nkdCode,
  nkdDesc: p.nkdDesc,
  dateFounded: p.dateFounded,
  region: existing['Region'] || '',
  profileUrl: src.profileUrl,
  detailFetched: true,
  notes: notes
};

// Never drop a record because a regex missed — write it with blanks plus the
// profile URL and a note, so it can be reviewed by hand.
return { json: buildSheetRow(merged, cfg.multiValueSeparator) };
`, { forEach: true }),
    sheets('Update Company Row', [3080, 660], {
      operation: 'appendOrUpdate',
      matchingColumns: ['Profile URL']
    }),
    codeNode('Run Summary', [2000, 300], `
const cfg     = $('Config').first().json;
const crawl   = $('Parse Search Page').first().json;
const prepared = $('Prepare Companies').all().map(i => i.json);

// Reached either from the detail loop (enriched rows) or from the
// "nothing to enrich" branch (a single sentinel item).
let enriched = [];
let skipReason = '';
const inbound = $input.all().map(i => i.json);
if (inbound.length === 1 && inbound[0].__none) skipReason = inbound[0].reason;
else enriched = inbound.filter(r => r && r['Profile URL']);

const pct = (n, d) => d ? Math.round((n / d) * 100) + '%' : 'n/a';
const has = (rows, col) => rows.filter(r => r[col]).length;

const blocked = enriched.filter(r => /BLOCKED/.test(String(r['Notes'] || '')));
const newThisRun = prepared.filter(r => String(r['Detail Fetched'] || '').toLowerCase() !== 'yes').length;

const summary = {
  region: cfg.region.name + ' (r=' + cfg.region.code + ')',
  searchPagesFetched: crawl.pagesFetched,
  searchSlices: (crawl.perSlice || []).map(s =>
    s.slice + ': ' + s.companies + ' companies over ' + s.pages + ' pages'
    + (s.siteReportedTotal == null ? '' : ' (site reported ' + s.siteReportedTotal + ')')),
  companiesFoundThisRegion: prepared.length,
  alreadyEnrichedFromPreviousRun: prepared.length - newThisRun,
  companiesEnrichedThisRun: enriched.length,
  scrapingBeeRequests: crawl.pagesFetched + (enriched.length * 2),
  rowsMissingEdb: prepared.filter(r => !r['Tax Number (EDB)']).length,
  crawlErrors: (crawl.errors || []).length ? crawl.errors : ['none']
};

if (skipReason) summary.detailPassSkipped = skipReason;

if (enriched.length) {
  summary.fieldCoverage = {
    phone:       has(enriched, 'Phones') + ' (' + pct(has(enriched, 'Phones'), enriched.length) + ')',
    email:       has(enriched, 'Emails') + ' (' + pct(has(enriched, 'Emails'), enriched.length) + ')',
    owners:      has(enriched, 'Owners') + ' (' + pct(has(enriched, 'Owners'), enriched.length) + ')',
    managers:    has(enriched, 'Managers') + ' (' + pct(has(enriched, 'Managers'), enriched.length) + ')',
    nkd:         has(enriched, 'NKD Code') + ' (' + pct(has(enriched, 'NKD Code'), enriched.length) + ')',
    dateFounded: has(enriched, 'Date Founded') + ' (' + pct(has(enriched, 'Date Founded'), enriched.length) + ')'
  };
  const withNotes = enriched.filter(r => r['Notes']);
  summary.rowsNeedingReview = withNotes.length
    ? withNotes.slice(0, 50).map(r => r['Profile URL'] + ' -> ' + r['Notes'])
    : ['none'];
}

if (blocked.length) {
  summary.WARNING = blocked.length + ' request(s) were blocked (403/429). Raise waitSeconds or set premiumProxy: true, then run again — already-enriched rows are skipped automatically.';
}

// A slice that collects far fewer than the site says exist has hit the paging
// ceiling and needs splitting further (by town, or by revenue band).
const short = (crawl.perSlice || []).filter(s =>
  typeof s.siteReportedTotal === 'number' && s.siteReportedTotal > s.companies * 1.1);
if (crawl.aborted) {
  summary.WARNING_ABORTED = 'The run was abandoned partway because the site blocked a request, so this region is INCOMPLETE. Fix the cause above and run again — everything already collected is kept and will not be re-scraped.';
}

if (!prepared.length) {
  summary.WARNING_EMPTY = 'No companies were collected at all. Last empty response: '
    + (crawl.lastEmptyDiagnostic || 'n/a')
    + '. If the byte count looks like a real page, the row parser needs tuning — save the HTML into tests/fixtures/ and run npm test.';
}

if (short.length) {
  summary.WARNING_TRUNCATED = short.map(s =>
    s.slice + ': site reports ' + s.siteReportedTotal + ' but only ' + s.companies + ' were collected'
  ).join('; ') + '. These searches hit the paging ceiling — they need splitting further to reach the rest.';
}
if (enriched.length && has(enriched, 'Owners') === 0 && has(enriched, 'Managers') === 0) {
  summary.WARNING_LICA = 'No owners or managers parsed for ANY company. The /lica parser very likely needs tuning — save a page into tests/fixtures/ and run npm test.';
}

const nextRegion = cfg.region.code === 7 ? 'East, { code: 2, name: \\'East\\' }' : 'Southeast, { code: 7, name: \\'Southeast\\' }';
summary.NEXT_STEP = 'Set region to ' + nextRegion + ' in the Config node and execute again. Rows from this run will be updated, not duplicated.';

return [{ json: summary }];
`),

    sticky([
      '## CompanyWall.mk → Google Sheets',
      '',
      '**Run this workflow twice.** Edit only the `Config` node between runs:',
      '',
      '1. `region = { code: 7, name: \'Southeast\' }` → execute',
      '2. `region = { code: 2, name: \'East\' }` → execute',
      '',
      'Filters: 1–5 employees, all industries (no NKD filter), one region per run.',
      '',
      '**Do a trial run first:** set `maxPages: 1` and `maxCompanies: 3`. That is 7 requests. Check the sheet and `Run Summary`, then go full.'
    ].join('\n'), [-1120, -60], [520, 320], 4),

    sticky([
      '### Why the sheet is read first',
      '',
      'Run 2 needs to know what run 1 already wrote. `Read Existing Sheet` makes the run idempotent:',
      '',
      '- a company found in **both** regions updates its existing row and gets `Region = "Southeast + East"` — no duplicate',
      '- a company already enriched is **not** re-scraped, so run 2 is cheaper',
      '- an interrupted run can simply be executed again',
      '',
      'Matching is on `Profile URL`, which is always present.'
    ].join('\n'), [-680, -80], [420, 340], 5),

    sticky([
      '### Rate limiting',
      '',
      'A `Wait` before **every** outbound request, and exactly one request in flight at a time.',
      '',
      'On 403/429 the crawl stops and logs rather than retrying, so a soft block never escalates.',
      '',
      'Tune `waitSeconds` in Config (default 4).'
    ].join('\n'), [200, 20], [380, 240], 6),

    sticky([
      '### Detail pass — 2 requests per company',
      '',
      'Profile page → phones, emails, NKD code + description, date founded.',
      '`/lica` page → owners (+ %), and **all** representatives with position and from-date.',
      '',
      'At `waitSeconds: 4` this is ~10 s per company. 1 000 companies ≈ 2 h 45 m.',
      '',
      'Set `fetchDetails: false` for a list-only run, or `maxCompanies` to cap it.'
    ].join('\n'), [2200, 380], [460, 280], 7)
  ];

  const edges = [
    ['When clicking Execute', 'Config'],
    ['Config', 'Read Existing Sheet'],
    ['Read Existing Sheet', 'Seed State'],
    ['Seed State', 'Build Search URL'],
    ['Build Search URL', 'Wait Before Search'],
    ['Wait Before Search', 'Fetch Search Page'],
    ['Fetch Search Page', 'Parse Search Page'],
    ['Parse Search Page', 'More Pages?'],
    ['More Pages?', 'Build Search URL', 0],      // true  -> next page
    ['More Pages?', 'Prepare Companies', 1],     // false -> region exhausted
    ['Prepare Companies', 'Write List Rows'],
    ['Write List Rows', 'Select For Detail'],
    ['Select For Detail', 'Need Details?'],
    ['Need Details?', 'Loop Companies', 0],
    ['Need Details?', 'Run Summary', 1],         // nothing to enrich
    ['Loop Companies', 'Run Summary', 0],        // loop finished
    ['Loop Companies', 'Wait Before Profile', 1],
    ['Wait Before Profile', 'Fetch Profile'],
    ['Fetch Profile', 'Wait Before Lica'],
    ['Wait Before Lica', 'Fetch Lica'],
    ['Fetch Lica', 'Merge Detail'],
    ['Merge Detail', 'Update Company Row'],
    ['Update Company Row', 'Loop Companies']
  ];

  return workflow('CompanyWall.mk — Companies 1-5 Employees by Region', nodes, edges);
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const wf = buildWorkflow();
writeFileSync(resolve(OUT_DIR, 'companywall-scraper.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
console.log(`wrote workflows/companywall-scraper.json  (${wf.nodes.length} nodes)`);
console.log('\nImport it into n8n, set credentials, then edit the Config node per run.');

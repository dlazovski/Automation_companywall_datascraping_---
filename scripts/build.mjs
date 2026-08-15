/**
 * Generates the importable n8n workflow JSON files from lib/parsers.js.
 *
 * Why generated rather than hand-written: the parser logic must live in exactly
 * one place. After Step 0 you will tune selectors in lib/parsers.js, run
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
    credentials: {
      googleSheetsOAuth2Api: { id: 'REPLACE_WITH_GOOGLE_SHEETS_CREDENTIAL_ID', name: 'Google Sheets account' }
    }
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

/* ------------------------------------------------------------------ *
 * Shared Config node body
 * ------------------------------------------------------------------ */

const CONFIG_BODY = `
// ---- EDIT THESE TWO BEFORE RUNNING -------------------------------------
const googleSheetId = 'PUT_YOUR_GOOGLE_SHEET_ID_HERE'; // from the sheet URL: /spreadsheets/d/<THIS>/edit
const sheetName     = 'Companies';                     // tab name inside that spreadsheet
// -----------------------------------------------------------------------

return [{
  json: {
    googleSheetId,
    sheetName,

    // Southeast + East. These two cover Штип, Радовиш, Струмица, Валандово,
    // Богданци, Дојран, Гевгелија, Пробиштип, Кочани, Виница,
    // Македонска Каменица, Делчево, Берово.
    regions: [
      { code: 7, name: 'Southeast' },
      { code: 2, name: 'East' }
    ],

    employeesFrom: 1,
    employeesTo: 5,

    // Rate limiting. CompanyWall asks not to send many search requests at once
    // ("Не испраќајте премногу барања за пребарување одеднаш").
    // Every outbound request is preceded by a Wait of this many seconds, and the
    // workflow is strictly single-threaded (one in-flight request at a time).
    waitSeconds: 4,

    // Runaway guards.
    maxPages: 300,          // per region
    maxCompaniesPhase2: 0,  // 0 = no limit; set e.g. 100 for a trial run

    // ScrapingBee options. The search and profile pages are plain server-rendered
    // HTML, so render_js is not needed. Turn premiumProxy on only if Step 0
    // reports CLOUDFLARE_CHALLENGE / CAPTCHA (it costs far more credits).
    renderJs: false,
    premiumProxy: false,

    // How multi-value fields (phones, emails, owners, managers) are written.
    // Single cell, values joined by this separator.
    multiValueSeparator: '; '
  }
}];
`;

/* ================================================================== *
 * Workflow 00 — Step 0 recon
 * ================================================================== */

function buildRecon() {
  const nodes = [
    manualTrigger('When clicking Execute', [-660, 300]),
    codeNode('Config', [-440, 300], CONFIG_BODY),
    codeNode('Recon Targets', [-220, 300], `
// Four probes: both region searches, one known-good profile, and its /lica page.
// The profile below is the one confirmed live in the task brief.
const cfg = $('Config').first().json;
const sample = '/kompanija/%D0%B1-%D1%82%D0%B5%D1%86%D1%85%D0%BD%D0%BE%D0%BB%D0%BE%D1%9F%D0%B8-%D0%B4%D0%BE%D0%BE%D0%B5%D0%BB-%D1%81%D0%BA%D0%BE%D0%BF%D1%98%D0%B5/MMxL2jxY';

const targets = [];
cfg.regions.forEach(r => {
  targets.push({
    kind: 'search',
    label: 'Search page 1 — ' + r.name + ' (r=' + r.code + ')',
    targetUrl: buildSearchUrl(r.code, 1, cfg.employeesFrom, cfg.employeesTo)
  });
});
targets.push({ kind: 'profile', label: 'Sample company profile', targetUrl: CW_BASE + sample });
targets.push({ kind: 'lica',    label: 'Sample company /lica',   targetUrl: CW_BASE + sample + '/lica' });

return targets.map(t => ({ json: t }));
`),
    splitInBatches('Loop Probes', [0, 300], 1),
    waitNode('Rate Limit Wait', [220, 420]),
    scrapingBee('Fetch (ScrapingBee)', [440, 420], '={{ $json.targetUrl }}'),
    codeNode('Diagnose', [660, 420], `
// Runs the real parsers against the real HTML and reports what they found.
// This is the whole point of Step 0: if the numbers below look wrong, tune
// lib/parsers.js (not the workflow) and re-run.
const probe = $('Loop Probes').item.json;
const resp  = $input.item.json;

const statusCode = resp.statusCode == null ? 0 : resp.statusCode;
const html = String(resp.body == null ? (resp.data == null ? '' : resp.data) : resp.body);

const out = {
  label: probe.label,
  kind: probe.kind,
  targetUrl: probe.targetUrl,
  statusCode,
  htmlLength: html.length,
  healthFlags: diagnoseResponse(html).join(', ') || 'none'
};

if (statusCode >= 400 || !html) {
  out.ERROR = 'Non-OK response — check ScrapingBee credential, credits, and whether premium_proxy is needed.';
  out.bodyPreview = html.slice(0, 2000);
  return { json: out };
}

if (probe.kind === 'search') {
  const r = parseSearchResults(html);
  out.anchorsFound   = r.anchorsFound;
  out.rowsParsed     = r.rows.length;
  out.rowsWithEdb    = r.rowsWithEdb;
  out.chunkingMode   = r.mode;
  out.totalReported  = r.total;
  out.hasNextPageLink = /[?&]p=2\\b/.test(html);
  out.firstThreeRows = r.rows.slice(0, 3);
  out.CHECK = [
    'rowsParsed should equal the number of companies visible on page 1',
    'rowsWithEdb should equal rowsParsed (if far lower, row chunking is off)',
    'firstThreeRows: verify name/status/address/employees/revenue are correct and not shifted between companies'
  ].join(' | ');
}

if (probe.kind === 'profile') {
  const p = parseProfile(html);
  out.parsed = p;
  // Does the "show all contacts" toggle hide anything, or is it just a /lica link?
  const showAll = html.match(/<a[^>]+href\\s*=\\s*["']([^"']+)["'][^>]*>[^<]*Прикажи ги сите[^<]*<\\/a>/i);
  out.showAllToggleHref = showAll ? showAll[1] : 'not found on page';
  out.showAllPointsToLica = showAll ? /\\/lica\\/?$/.test(showAll[1]) : null;
  out.mailtoCount = (html.match(/href\\s*=\\s*["']mailto:/gi) || []).length;
  out.telCount    = (html.match(/href\\s*=\\s*["']tel:/gi) || []).length;
  out.CHECK = [
    'phones/emails should contain EVERY value shown on the page, not just the first',
    'if mailtoCount > emails.length, the extra addresses are lazy-loaded and need render_js',
    'if showAllPointsToLica is true, the toggle is just a mislabelled link — no hidden contacts'
  ].join(' | ');
}

if (probe.kind === 'lica') {
  const l = parseLica(html);
  out.ownersFound   = l.owners.length;
  out.managersFound = l.managers.length;
  out.owners        = l.owners;
  out.managers      = l.managers;
  out.rawAnchorCounts = {
    'Претставник': (html.match(/Претставник/g) || []).length,
    'Сопственик':  (html.match(/Сопственик/g) || []).length
  };
  out.CHECK = 'ownersFound + managersFound should match rawAnchorCounts (minus any label occurring in page chrome)';
}

return { json: out };
`, { forEach: true }),
    codeNode('Recon Report', [220, 180], `
// Runs once, after all four probes.
const rows = $input.all().map(i => i.json);
const problems = [];

rows.forEach(r => {
  if (r.ERROR) problems.push(r.label + ': ' + r.ERROR);
  if (r.healthFlags && r.healthFlags !== 'none' && !/BONITET/.test(r.healthFlags)) {
    problems.push(r.label + ': health flags -> ' + r.healthFlags);
  }
  if (r.kind === 'search' && !r.rowsParsed) problems.push(r.label + ': parsed ZERO rows — selectors need tuning');
  if (r.kind === 'lica' && !r.ownersFound && !r.managersFound) problems.push(r.label + ': parsed ZERO people — selectors need tuning');
});

const searches = rows.filter(r => r.kind === 'search');
const perPage = searches.length && searches[0].rowsParsed ? searches[0].rowsParsed : 0;

return [{
  json: {
    verdict: problems.length ? 'NEEDS ATTENTION' : 'LOOKS GOOD — safe to run Phase 1',
    problems: problems.length ? problems : ['none'],
    resultsPerPage: perPage || 'unknown',
    reportedTotals: searches.map(s => s.label + ': ' + (s.totalReported == null ? 'not detected' : s.totalReported)),
    estimatedPhase1Requests: searches.map(s => {
      const t = s.totalReported;
      return s.label + ': ' + (t && perPage ? Math.ceil(t / perPage) + ' page requests' : 'unknown until first run');
    }),
    note: 'Phase 2 costs 2 requests per company (profile + /lica). Multiply the unique company count by 2 before running it.',
    probes: rows
  }
}];
`),
    sticky([
      '## Step 0 — run this FIRST',
      '',
      'Four probes through ScrapingBee: both region searches, one company profile, and that same company’s `/lica` page.',
      '',
      '**Read the `Recon Report` output**, not just the green ticks:',
      '- `verdict` — go / no-go',
      '- `resultsPerPage` + `reportedTotals` — tells you how big this run really is',
      '- each probe’s `CHECK` field lists exactly what to eyeball',
      '',
      'If parsing is off, fix `lib/parsers.js`, run `npm run build`, re-import.',
      'Do not edit the Code nodes in n8n — they are generated.'
    ].join('\n'), [-660, -60], [520, 320], 3)
  ];

  const edges = [
    ['When clicking Execute', 'Config'],
    ['Config', 'Recon Targets'],
    ['Recon Targets', 'Loop Probes'],
    ['Loop Probes', 'Recon Report', 0],   // done branch
    ['Loop Probes', 'Rate Limit Wait', 1], // loop branch
    ['Rate Limit Wait', 'Fetch (ScrapingBee)'],
    ['Fetch (ScrapingBee)', 'Diagnose'],
    ['Diagnose', 'Loop Probes']
  ];

  return workflow('CompanyWall — 00 Step 0 Recon', nodes, edges);
}

/* ================================================================== *
 * Workflow 01 — Phase 1: paginate both regions, write list fields
 * ================================================================== */

function buildPhase1() {
  const nodes = [
    manualTrigger('When clicking Execute', [-880, 300]),
    codeNode('Config', [-660, 300], CONFIG_BODY),
    codeNode('Seed State', [-440, 300], `
// ONE item carries the whole crawl. Regions are worked through sequentially via
// a queue rather than as parallel items, which guarantees exactly one in-flight
// request at a time and makes the "all regions finished" branch fire exactly once.
const cfg = $('Config').first().json;

return [{
  json: {
    queue: cfg.regions,
    idx: 0,
    page: 1,
    companies: [],
    seen: [],
    perRegion: [],
    errors: [],
    pagesFetched: 0
  }
}];
`),
    codeNode('Build Search URL', [-220, 300], `
const cfg = $('Config').first().json;
const st  = $input.item.json;
const region = st.queue[st.idx];

return {
  json: Object.assign({}, st, {
    regionCode: region.code,
    regionName: region.name,
    targetUrl: buildSearchUrl(region.code, st.page, cfg.employeesFrom, cfg.employeesTo)
  })
};
`, { forEach: true }),
    waitNode('Rate Limit Wait', [0, 300]),
    scrapingBee('Fetch Search Page', [220, 300], '={{ $json.targetUrl }}'),
    codeNode('Parse Search Page', [440, 300], `
const cfg  = $('Config').first().json;
const st   = $('Build Search URL').item.json;
const resp = $input.item.json;

const statusCode = resp.statusCode == null ? 0 : resp.statusCode;
const html = String(resp.body == null ? (resp.data == null ? '' : resp.data) : resp.body);

const errors    = (st.errors || []).slice();
const perRegion = (st.perRegion || []).slice();
const seen      = new Set(st.seen || []);
let companies   = (st.companies || []).slice();

let stopRegion = false;
let newRows = 0;
let pageRows = 0;

// Brief is explicit: on 403/429 stop this batch and log it. Do NOT retry in a
// loop — that is how you get the IP blocked for the rest of the run.
if (statusCode === 403 || statusCode === 429) {
  errors.push('BLOCKED ' + statusCode + ' on ' + st.regionName + ' page ' + st.page + ' — stopping this region. Consider premiumProxy: true or a longer waitSeconds.');
  stopRegion = true;
} else if (statusCode >= 400 || !html) {
  errors.push('HTTP ' + statusCode + ' on ' + st.regionName + ' page ' + st.page + ' — stopping this region.');
  stopRegion = true;
} else {
  const flags = diagnoseResponse(html);
  if (flags.indexOf('CLOUDFLARE_CHALLENGE') >= 0 || flags.indexOf('CAPTCHA') >= 0) {
    errors.push('CHALLENGE on ' + st.regionName + ' page ' + st.page + ' (' + flags.join(',') + ') — stopping this region. Set premiumProxy: true.');
    stopRegion = true;
  } else {
    const parsed = parseSearchResults(html);
    pageRows = parsed.rows.length;

    // "seen" is keyed per region, not globally: a company that legitimately
    // surfaces in BOTH regions must be collected twice so Dedupe Companies can
    // merge it and record "Southeast + East". Within a region the key still
    // detects the site repeating a page, which is our pagination stop signal.
    const key = r => st.regionCode + '|' + r.profileUrl;

    const fresh = parsed.rows.filter(r => r.profileUrl && !seen.has(key(r)));
    fresh.forEach(r => {
      seen.add(key(r));
      r.region = st.regionName;
      r.regionCode = st.regionCode;
      r.detailFetched = false;
      r.notes = [];
      companies.push(r);
    });
    newRows = fresh.length;

    // Exhausted when a page yields nothing new (covers both an empty page and
    // the site clamping pagination by repeating the last page).
    if (newRows === 0) stopRegion = true;
    if (st.page >= cfg.maxPages) {
      errors.push('Hit maxPages (' + cfg.maxPages + ') for ' + st.regionName + ' — results may be truncated.');
      stopRegion = true;
    }
  }
}

let idx  = st.idx;
let page = st.page;

if (stopRegion) {
  perRegion.push({
    region: st.regionName,
    regionCode: st.regionCode,
    pagesFetched: st.page,
    companiesFound: companies.filter(c => c.regionCode === st.regionCode).length
  });
  idx = st.idx + 1;
  page = 1;
} else {
  page = st.page + 1;
}

const hasMore = idx < st.queue.length;

return {
  json: {
    queue: st.queue,
    idx,
    page,
    companies,
    seen: Array.from(seen),
    perRegion,
    errors,
    pagesFetched: (st.pagesFetched || 0) + 1,
    hasMore,
    lastPage: { region: st.regionName, page: st.page, rows: pageRows, newRows, statusCode }
  }
};
`, { forEach: true }),
    ifNode('More Pages?', [660, 300], '={{ $json.hasMore }}'),
    codeNode('Dedupe Companies', [900, 200], `
// Runs once, when every region is exhausted.
const cfg = $('Config').first().json;
const st  = $input.first().json;

const unique = dedupeCompanies(st.companies || []);

return unique.map(c => ({
  json: buildSheetRow(c, cfg.multiValueSeparator)
}));
`),
    sheets('Write List Rows', [1120, 200], { operation: 'append' }),
    codeNode('Phase 1 Summary', [900, 420], `
const st = $input.first().json;
const unique = dedupeCompanies(st.companies || []);

const perRegionLines = (st.perRegion || []).map(r =>
  r.region + ' (r=' + r.regionCode + '): ' + r.companiesFound + ' companies over ' + r.pagesFetched + ' page requests'
);

const dupes = (st.companies || []).length - unique.length;
const missingEdb = unique.filter(c => !c.edb).length;

return [{
  json: {
    phase: 1,
    perRegion: perRegionLines,
    totalRowsCollected: (st.companies || []).length,
    totalUnique: unique.length,
    duplicatesRemoved: dupes,
    rowsMissingEdb: missingEdb,
    searchPageRequests: st.pagesFetched,
    errors: (st.errors || []).length ? st.errors : ['none'],

    CHECKPOINT: 'Review the sheet before running Phase 2.',
    phase2RequestEstimate: (unique.length * 2) + ' ScrapingBee requests (profile + /lica per company)',
    phase2TimeEstimate: (() => {
      const secs = unique.length * 2 * 5; // 2 requests x ~(4s wait + ~1s latency)
      const h = Math.floor(secs / 3600), m = Math.round((secs % 3600) / 60);
      return h ? h + 'h ' + m + 'm' : m + 'm';
    })(),
    phase2Advice: 'To trial it first, set maxCompaniesPhase2 to e.g. 25 in the Phase 2 Config node. Delete rows from the sheet to narrow the list — Phase 2 only enriches rows that are still there.'
  }
}];
`),
    sticky([
      '## Phase 1 — list scrape (cheap)',
      '',
      'Paginates `r=7` then `r=2` until a page returns nothing new, then writes one row per unique company using **only the fields already visible in search results** (name, status, ЕДБ, address, employees, revenue) — no profile visits.',
      '',
      '1 request per results page. Dedupe is by ЕДБ, falling back to profile URL when ЕДБ is absent, so nothing is silently dropped.',
      '',
      '**`Phase 1 Summary` is the Step-7 checkpoint** — it prints the unique count and what Phase 2 will cost in requests and wall-clock time. Read it before running Phase 2.'
    ].join('\n'), [-880, -80], [520, 340], 5),
    sticky([
      '### Rate limiting',
      '',
      'One in-flight request at a time (a single item through a sequential loop) plus a `waitSeconds` Wait before every fetch.',
      '',
      'On 403/429 the region stops and logs — it never auto-retries into a block.'
    ].join('\n'), [0, 60], [380, 200], 6)
  ];

  const edges = [
    ['When clicking Execute', 'Config'],
    ['Config', 'Seed State'],
    ['Seed State', 'Build Search URL'],
    ['Build Search URL', 'Rate Limit Wait'],
    ['Rate Limit Wait', 'Fetch Search Page'],
    ['Fetch Search Page', 'Parse Search Page'],
    ['Parse Search Page', 'More Pages?'],
    ['More Pages?', 'Build Search URL', 0],   // true  -> keep crawling
    ['More Pages?', 'Dedupe Companies', 1],   // false -> finished
    ['More Pages?', 'Phase 1 Summary', 1],
    ['Dedupe Companies', 'Write List Rows']
  ];

  return workflow('CompanyWall — 01 Phase 1 List Scrape', nodes, edges);
}

/* ================================================================== *
 * Workflow 02 — Phase 2: per-company profile + /lica enrichment
 * ================================================================== */

function buildPhase2() {
  const nodes = [
    manualTrigger('When clicking Execute', [-880, 300]),
    codeNode('Config', [-660, 300], CONFIG_BODY),
    sheetsRead('Read Companies From Sheet', [-440, 300]),
    codeNode('Select Rows To Enrich', [-220, 300], `
// Reads back what Phase 1 wrote. This is the checkpoint made concrete: prune or
// reorder rows in the sheet and Phase 2 only touches what is left.
const cfg = $('Config').first().json;
const rows = $input.all().map(i => i.json);

let pending = rows.filter(r => {
  const url = r['Profile URL'];
  if (!url || !/^https?:\\/\\//.test(String(url))) return false;
  return String(r['Detail Fetched'] || '').toLowerCase() !== 'yes'; // resumable
});

const limit = Number(cfg.maxCompaniesPhase2) || 0;
const skipped = limit > 0 ? Math.max(0, pending.length - limit) : 0;
if (limit > 0) pending = pending.slice(0, limit);

if (!pending.length) {
  return [{ json: { nothingToDo: true, message: 'No rows pending enrichment. Either Phase 1 has not run, or every row is already marked "Detail Fetched = yes".' } }];
}

return pending.map(r => ({
  json: {
    profileUrl: String(r['Profile URL']).replace(/\\/+$/, ''),
    licaUrl: String(r['Profile URL']).replace(/\\/+$/, '') + '/lica',
    existing: r,
    _skippedByLimit: skipped
  }
}));
`),
    splitInBatches('Loop Companies', [0, 300], 1),
    waitNode('Wait Before Profile', [220, 440]),
    scrapingBee('Fetch Profile', [440, 440], "={{ $('Loop Companies').item.json.profileUrl }}"),
    waitNode('Wait Before Lica', [660, 440]),
    scrapingBee('Fetch Lica', [880, 440], "={{ $('Loop Companies').item.json.licaUrl }}"),
    codeNode('Merge Detail', [1100, 440], `
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

// Phase 1 values win for the list fields (they came from the filtered search);
// the profile page only fills gaps. Detail-only fields always come from Phase 2.
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

// Brief: never drop a record because a regex missed — write it with blanks and
// the profile URL so it can be reviewed by hand.
return { json: buildSheetRow(merged, cfg.multiValueSeparator) };
`, { forEach: true }),
    sheets('Update Company Row', [1320, 440], {
      operation: 'appendOrUpdate',
      matchingColumns: ['Profile URL']
    }),
    codeNode('Phase 2 Summary', [220, 160], `
const rows = $input.all().map(i => i.json).filter(r => r && r['Profile URL']);

const withPhone   = rows.filter(r => r['Phones']).length;
const withEmail   = rows.filter(r => r['Emails']).length;
const withOwners  = rows.filter(r => r['Owners']).length;
const withMgrs    = rows.filter(r => r['Managers']).length;
const withNkd     = rows.filter(r => r['NKD Code']).length;
const withDate    = rows.filter(r => r['Date Founded']).length;

const blocked = rows.filter(r => /BLOCKED/.test(String(r['Notes'] || '')));
const problems = rows.filter(r => r['Notes']).map(r => r['Profile URL'] + ' -> ' + r['Notes']);

const pct = n => rows.length ? Math.round((n / rows.length) * 100) + '%' : 'n/a';

return [{
  json: {
    phase: 2,
    companiesEnriched: rows.length,
    scrapingBeeRequests: rows.length * 2,
    coverage: {
      phone: withPhone + ' (' + pct(withPhone) + ')',
      email: withEmail + ' (' + pct(withEmail) + ')',
      owners: withOwners + ' (' + pct(withOwners) + ')',
      managers: withMgrs + ' (' + pct(withMgrs) + ')',
      nkd: withNkd + ' (' + pct(withNkd) + ')',
      dateFounded: withDate + ' (' + pct(withDate) + ')'
    },
    blockedRequests: blocked.length,
    warning: blocked.length ? 'Some requests were blocked (403/429). Raise waitSeconds or enable premiumProxy, then re-run — already-enriched rows are skipped automatically.' : 'none',
    rowsWithNotes: problems.length ? problems.slice(0, 50) : ['none'],
    note: 'Low coverage across the board usually means a parser needs tuning, not that the data is absent. Save a failing page into tests/fixtures/ and run npm test.'
  }
}];
`),
    sticky([
      '## Phase 2 — per-company detail (expensive)',
      '',
      '**2 ScrapingBee requests per company** (profile + `/lica`), each preceded by a Wait. Read `Phase 1 Summary` first — at ~5s per request this is roughly 10 seconds of wall-clock per company.',
      '',
      'Adds: phones, emails, owners + %, managers + position + from-date, NKD code/description, date founded.',
      '',
      '**Resumable.** Rows already marked `Detail Fetched = yes` are skipped, so you can stop and re-run safely. Set `maxCompaniesPhase2` to trial a small batch first.',
      '',
      'Rows whose parsing failed are still written, with blanks plus a `Notes` value — nothing is dropped.'
    ].join('\n'), [-880, -100], [560, 360], 7)
  ];

  const edges = [
    ['When clicking Execute', 'Config'],
    ['Config', 'Read Companies From Sheet'],
    ['Read Companies From Sheet', 'Select Rows To Enrich'],
    ['Select Rows To Enrich', 'Loop Companies'],
    ['Loop Companies', 'Phase 2 Summary', 0],   // done
    ['Loop Companies', 'Wait Before Profile', 1], // loop
    ['Wait Before Profile', 'Fetch Profile'],
    ['Fetch Profile', 'Wait Before Lica'],
    ['Wait Before Lica', 'Fetch Lica'],
    ['Fetch Lica', 'Merge Detail'],
    ['Merge Detail', 'Update Company Row'],
    ['Update Company Row', 'Loop Companies']
  ];

  return workflow('CompanyWall — 02 Phase 2 Detail Enrichment', nodes, edges);
}

/* ------------------------------------------------------------------ *
 * Emit
 * ------------------------------------------------------------------ */

mkdirSync(OUT_DIR, { recursive: true });

const outputs = [
  ['00-step0-recon.json', buildRecon()],
  ['01-phase1-list-scrape.json', buildPhase1()],
  ['02-phase2-detail-enrichment.json', buildPhase2()]
];

for (const [file, wf] of outputs) {
  const path = resolve(OUT_DIR, file);
  writeFileSync(path, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  console.log(`wrote workflows/${file}  (${wf.nodes.length} nodes)`);
}

console.log('\nDone. Import these into n8n, then set credentials + Config in each.');

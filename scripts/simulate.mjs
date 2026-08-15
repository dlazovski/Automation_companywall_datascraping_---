/**
 * End-to-end simulation of the generated workflows.
 *
 *   npm run simulate
 *
 * Executes the *actual JavaScript emitted into the Code nodes* against a mock
 * n8n runtime and mock HTTP responses. This is what verifies the parts unit
 * tests cannot reach: the pagination state machine, the region queue, the
 * stop-on-empty-page rule, 403 handling, cross-region dedupe, and the Phase 2
 * merge — without touching the live site or spending ScrapingBee credits.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`  ${name}${detail ? '\n      ' + detail : ''}`);
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Minimal n8n Code-node runtime
 * ------------------------------------------------------------------ */

function loadWorkflow(file) {
  const wf = JSON.parse(readFileSync(resolve(ROOT, 'workflows', file), 'utf8'));
  const byName = {};
  wf.nodes.forEach(n => { byName[n.name] = n; });
  return { wf, byName };
}

/**
 * @param node     the n8n Code node
 * @param input    array of item objects ({json}) entering the node
 * @param nodeData map of nodeName -> array of items that node last output
 */
function runCode(node, input, nodeData = {}) {
  const perItem = node.parameters.mode === 'runOnceForEachItem';

  const accessor = (name) => {
    const items = nodeData[name];
    if (!items) throw new Error(`simulate: no recorded output for $('${name}')`);
    return {
      first: () => items[0],
      last: () => items[items.length - 1],
      all: () => items,
      get item() { return items[0]; }
    };
  };

  const invoke = (items) => {
    const $input = {
      all: () => items,
      first: () => items[0],
      last: () => items[items.length - 1],
      get item() { return items[0]; }
    };
    const fn = new Function('$input', '$', '$json', node.parameters.jsCode);
    return fn($input, accessor, items[0] ? items[0].json : {});
  };

  if (!perItem) {
    const out = invoke(input);
    return Array.isArray(out) ? out : [out];
  }
  // Per-item mode: n8n calls the code once per item, exposing only that item.
  return input.map(it => {
    const out = invoke([it]);
    return Array.isArray(out) ? out[0] : out;
  });
}

/* ------------------------------------------------------------------ *
 * Mock pages
 * ------------------------------------------------------------------ */

function searchPage(companies) {
  if (!companies.length) return '<html><body><div>Нема резултати</div>' + 'x'.repeat(2000) + '</body></html>';
  return '<html><body>' + companies.map(c => `
    <div class="row">
      <a href="/kompanija/${c.slug}/${c.code}">${c.name}</a>
      <span>Активен</span>
      <div>Адреса: ${c.addr}</div>
      <div>ЕДБ: ${c.edb}</div>
      <div>Вработени: ${c.emp}</div>
      <div>Приходи: ${c.rev}</div>
    </div>`).join('') + '<div>Пронајдени 4 резултати</div>' + 'x'.repeat(2000) + '</body></html>';
}

const C = {
  a: { slug: 'alfa-stip', code: 'AAAA1111', name: 'АЛФА ДООЕЛ Штип', addr: 'ул. 1, Штип', edb: '4029000000001', emp: 3, rev: '1.000.000' },
  b: { slug: 'beta-kocani', code: 'BBBB2222', name: 'БЕТА ДОО Кочани', addr: 'ул. 2, Кочани', edb: '4029000000002', emp: 5, rev: '2.000.000' },
  c: { slug: 'gama-strumica', code: 'CCCC3333', name: 'ГАМА ДОО Струмица', addr: 'ул. 3, Струмица', edb: '4029000000003', emp: 1, rev: '500.000' },
  // Deliberately present in BOTH region results — must merge into one row.
  both: { slug: 'delta-valandovo', code: 'DDDD4444', name: 'ДЕЛТА ДООЕЛ Валандово', addr: 'ул. 4, Валандово', edb: '4029000000004', emp: 2, rev: '750.000' }
};

/** Southeast (r=7): 2 pages. East (r=2): 1 page. Then empties. */
function mockSearchFetch(url) {
  const region = (url.match(/[&?]r=(\d+)/) || [])[1];
  const page = parseInt((url.match(/[&?]p=(\d+)/) || [])[1] || '1', 10);
  if (region === '7') {
    if (page === 1) return { statusCode: 200, body: searchPage([C.a, C.both]) };
    if (page === 2) return { statusCode: 200, body: searchPage([C.c]) };
    return { statusCode: 200, body: searchPage([]) };
  }
  if (region === '2') {
    if (page === 1) return { statusCode: 200, body: searchPage([C.b, C.both]) };
    return { statusCode: 200, body: searchPage([]) };
  }
  throw new Error('unexpected region ' + region);
}

/* ------------------------------------------------------------------ *
 * Phase 1 simulation
 * ------------------------------------------------------------------ */

function simulatePhase1(fetchFn) {
  const { byName } = loadWorkflow('01-phase1-list-scrape.json');
  const nodeData = {};

  nodeData['Config'] = runCode(byName['Config'], [{ json: {} }], nodeData);
  let state = runCode(byName['Seed State'], nodeData['Config'], nodeData);

  const requests = [];
  let guard = 0;

  while (true) {
    if (++guard > 50) throw new Error('pagination loop did not terminate');

    const built = runCode(byName['Build Search URL'], state, nodeData);
    nodeData['Build Search URL'] = built;

    const url = built[0].json.targetUrl;
    requests.push(url);
    const resp = fetchFn(url);

    state = runCode(byName['Parse Search Page'], [{ json: resp }], nodeData);
    nodeData['Parse Search Page'] = state;

    if (!state[0].json.hasMore) break; // the IF node
  }

  const rows = runCode(byName['Dedupe Companies'], state, nodeData);
  const summary = runCode(byName['Phase 1 Summary'], state, nodeData);
  return { requests, rows: rows.map(r => r.json), summary: summary[0].json, state: state[0].json };
}

console.log('--- Phase 1: happy path ---');
const p1 = simulatePhase1(mockSearchFetch);

eq('P1: request count (2 SE pages + 1 empty, 1 E page + 1 empty)', p1.requests.length, 5);
ok('P1: page 1 of region 7 has no p= param', !/[&?]p=/.test(p1.requests[0]), p1.requests[0]);
ok('P1: second request is r=7 page 2', /r=7/.test(p1.requests[1]) && /p=2/.test(p1.requests[1]), p1.requests[1]);
ok('P1: switches to region 2 after region 7 exhausts',
  /r=2/.test(p1.requests[3]), p1.requests.join('\n      '));
ok('P1: every URL carries the 1-5 employee filter',
  p1.requests.every(u => u.includes('dsm[1].Code=48&dsm[1].From=1&dsm[1].To=5')));
ok('P1: every URL leaves the industry filter empty',
  p1.requests.every(u => u.includes('&at=&')));

eq('P1: unique companies written', p1.rows.length, 4);
eq('P1: total collected before dedupe', p1.summary.totalRowsCollected, 5);
eq('P1: duplicates removed', p1.summary.duplicatesRemoved, 1);

const delta = p1.rows.find(r => r['Tax Number (EDB)'] === '4029000000004');
ok('P1: cross-region company found', !!delta);
eq('P1: cross-region company records BOTH regions', delta['Region'], 'Southeast + East');

const alfa = p1.rows.find(r => r['Tax Number (EDB)'] === '4029000000001');
eq('P1: name', alfa['Company Name'], 'АЛФА ДООЕЛ Штип');
eq('P1: status', alfa['Status'], 'Активен');
eq('P1: address', alfa['Address'], 'ул. 1, Штип');
eq('P1: employees', alfa['Employees'], 3);
eq('P1: revenue parsed from MK format', alfa['Revenue MKD'], 1000000);
eq('P1: region', alfa['Region'], 'Southeast');
eq('P1: detail not yet fetched', alfa['Detail Fetched'], '');
ok('P1: profile URL absolute', /^https:\/\/www\.companywall\.com\.mk\/kompanija\//.test(alfa['Profile URL']));
eq('P1: all 18 columns present on every row',
  p1.rows.every(r => Object.keys(r).length === 18), true);

eq('P1: per-region breakdown reported', p1.summary.perRegion.length, 2);
eq('P1: no errors on happy path', p1.summary.errors, ['none']);
ok('P1: checkpoint reports Phase 2 cost',
  p1.summary.phase2RequestEstimate === '8 ScrapingBee requests (profile + /lica per company)',
  p1.summary.phase2RequestEstimate);

/* --- 403 must stop that region, keep what was already collected, and log --- */
console.log('--- Phase 1: 403 handling ---');
const p1blocked = simulatePhase1((url) => {
  const region = (url.match(/[&?]r=(\d+)/) || [])[1];
  const page = parseInt((url.match(/[&?]p=(\d+)/) || [])[1] || '1', 10);
  if (region === '7' && page === 1) return { statusCode: 200, body: searchPage([C.a, C.both]) };
  if (region === '7' && page === 2) return { statusCode: 403, body: 'Forbidden' };
  if (region === '2' && page === 1) return { statusCode: 200, body: searchPage([C.b]) };
  return { statusCode: 200, body: searchPage([]) };
});

ok('P1/403: logs the block', p1blocked.summary.errors.some(e => /BLOCKED 403/.test(e)),
  JSON.stringify(p1blocked.summary.errors));
ok('P1/403: does not retry the blocked page',
  p1blocked.requests.filter(u => /r=7/.test(u) && /p=2/.test(u)).length === 1);
ok('P1/403: still proceeds to the other region',
  p1blocked.requests.some(u => /r=2/.test(u)));
eq('P1/403: keeps rows collected before the block', p1blocked.rows.length, 3);
ok('P1/403: mentions premiumProxy as the remedy',
  p1blocked.summary.errors.some(e => /premiumProxy/.test(e)));

/* --- A page that repeats the previous page must not loop forever --- */
console.log('--- Phase 1: repeated-page guard ---');
const p1repeat = simulatePhase1((url) => {
  const region = (url.match(/[&?]r=(\d+)/) || [])[1];
  // Always returns the same companies, whatever the page number.
  return { statusCode: 200, body: searchPage(region === '7' ? [C.a] : [C.b]) };
});
eq('P1/repeat: stops after the repeat is detected (2 requests per region)', p1repeat.requests.length, 4);
eq('P1/repeat: no duplicate rows', p1repeat.rows.length, 2);

/* ------------------------------------------------------------------ *
 * Phase 2 simulation
 * ------------------------------------------------------------------ */

const PROFILE_HTML = `<html><body>
<h1>АЛФА ДООЕЛ Штип</h1>
<div><span>ЕДБ</span><span>4029000000001</span></div>
<div><span>ЕМБС</span><span>7000001</span></div>
<div><span>Дејност</span><span>47.910 - Трговија на мало преку пошта</span></div>
<p>АЛФА ДООЕЛ Штип е регистрирана на ул. 1, Штип и работи од 12.05.2016 година. Телефонот за контакт е 032/391-100 и контакт-мејл е info@alfa.mk.</p>
<section><span>тел</span><span>032/391-100</span><span>070 111 222</span>
<span>Е-пошта</span><span>info@alfa.mk</span><span>prodazba@alfa.mk</span></section>
</body></html>`;

const LICA_HTML = `<html><body>
<div><span>Претставник</span><span>Марко Марковски</span><span>Позиција</span><span>Управител</span><span>од</span><span>12.05.2016</span></div>
<div><span>Претставник</span><span>Ана Ангеловска</span><span>Позиција</span><span>Раководител на подружница</span><span>од</span><span>01.01.2020</span></div>
<div><span>Сопственик</span><span>Марко Марковски (100,00%)</span><span>од</span><span>12.05.2016</span></div>
</body></html>`;

function simulatePhase2(sheetRows, { profile = PROFILE_HTML, lica = LICA_HTML, profileStatus = 200, licaStatus = 200 } = {}) {
  const { byName } = loadWorkflow('02-phase2-detail-enrichment.json');
  const nodeData = {};
  nodeData['Config'] = runCode(byName['Config'], [{ json: {} }], nodeData);

  const selected = runCode(byName['Select Rows To Enrich'],
    sheetRows.map(r => ({ json: r })), nodeData);
  if (selected[0].json.nothingToDo) return { nothingToDo: true, selected };

  const out = [];
  for (const item of selected) {
    nodeData['Loop Companies'] = [item];
    nodeData['Fetch Profile'] = [{ json: { statusCode: profileStatus, body: profile } }];
    const merged = runCode(byName['Merge Detail'],
      [{ json: { statusCode: licaStatus, body: lica } }], nodeData);
    out.push(merged[0].json);
  }
  nodeData['Merge Detail'] = out.map(j => ({ json: j }));
  const summary = runCode(byName['Phase 2 Summary'], nodeData['Merge Detail'], nodeData);
  return { rows: out, summary: summary[0].json, selected };
}

console.log('--- Phase 2: enrichment ---');
const sheetRows = p1.rows;
const p2 = simulatePhase2(sheetRows);

eq('P2: enriches every pending row', p2.rows.length, 4);
const e = p2.rows[0];
eq('P2: phones joined, deduped', e['Phones'], '032/391-100; 070 111 222');
eq('P2: emails joined', e['Emails'], 'info@alfa.mk; prodazba@alfa.mk');
eq('P2: owner with percentage', e['Owners'], 'Марко Марковски (100,00%)');
eq('P2: ALL managers with position and from-date', e['Managers'],
  'Марко Марковски — Управител (од 12.05.2016); Ана Ангеловска — Раководител на подружница (од 01.01.2020)');
eq('P2: NKD code', e['NKD Code'], '47.910');
eq('P2: NKD description', e['NKD Description'], 'Трговија на мало преку пошта');
eq('P2: date founded', e['Date Founded'], '12.05.2016');
eq('P2: marked as fetched', e['Detail Fetched'], 'yes');

// Phase 1 values must survive Phase 2 — they came from the filtered search.
const eDelta = p2.rows.find(r => r['Tax Number (EDB)'] === '4029000000004');
eq('P2: preserves Phase 1 region merge', eDelta['Region'], 'Southeast + East');
eq('P2: preserves Phase 1 employees', p2.rows.find(r => r['Company Name'] === 'АЛФА ДООЕЛ Штип')['Employees'], 3);
eq('P2: preserves Phase 1 profile URL', e['Profile URL'], sheetRows[0]['Profile URL']);

ok('P2: reports coverage', /100%/.test(p2.summary.coverage.phone), JSON.stringify(p2.summary.coverage));
eq('P2: request count reported', p2.summary.scrapingBeeRequests, 8);

/* --- Resumability: already-enriched rows are skipped --- */
console.log('--- Phase 2: resume + failure handling ---');
const alreadyDone = sheetRows.map(r => ({ ...r, 'Detail Fetched': 'yes' }));
ok('P2/resume: skips rows already fetched', simulatePhase2(alreadyDone).nothingToDo === true);

const partial = sheetRows.map((r, i) => i < 2 ? { ...r, 'Detail Fetched': 'yes' } : r);
eq('P2/resume: only enriches the remainder', simulatePhase2(partial).rows.length, 2);

// A blocked /lica must still write the row, with the profile data and a note.
const p2blocked = simulatePhase2([sheetRows[0]], { licaStatus: 403 });
eq('P2/403: row is still written', p2blocked.rows.length, 1);
eq('P2/403: profile fields survive', p2blocked.rows[0]['Phones'], '032/391-100; 070 111 222');
eq('P2/403: owners blank', p2blocked.rows[0]['Owners'], '');
ok('P2/403: note records the block', /LICA_BLOCKED_403/.test(p2blocked.rows[0]['Notes']),
  p2blocked.rows[0]['Notes']);
ok('P2/403: summary warns', /blocked/i.test(p2blocked.summary.warning), p2blocked.summary.warning);

// Total parse failure must not drop the record — brief requires the URL survives.
const p2junk = simulatePhase2([sheetRows[0]], { profile: '<html><body>nothing</body></html>', lica: '<html><body>nothing</body></html>' });
eq('P2/junk: record not dropped', p2junk.rows.length, 1);
eq('P2/junk: profile URL retained for manual review', p2junk.rows[0]['Profile URL'], sheetRows[0]['Profile URL']);
eq('P2/junk: Phase 1 fields retained', p2junk.rows[0]['Company Name'], 'АЛФА ДООЕЛ Штип');
ok('P2/junk: notes explain what failed', /NO_PHONE_FOUND/.test(p2junk.rows[0]['Notes']), p2junk.rows[0]['Notes']);

/* --- maxCompaniesPhase2 trial-run limit --- */
const { byName: p2nodes } = loadWorkflow('02-phase2-detail-enrichment.json');
const cfgCode = p2nodes['Config'].parameters.jsCode.replace('maxCompaniesPhase2: 0', 'maxCompaniesPhase2: 2');
const limitedCfg = new Function('$input', '$', '$json', cfgCode)({ all: () => [] }, () => {}, {});
const nodeDataLimited = { Config: limitedCfg };
const limited = runCode(p2nodes['Select Rows To Enrich'], sheetRows.map(r => ({ json: r })), nodeDataLimited);
eq('P2/limit: maxCompaniesPhase2 caps the batch', limited.length, 2);

/* ------------------------------------------------------------------ */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFailures:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);

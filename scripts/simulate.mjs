/**
 * End-to-end simulation of the generated workflow.
 *
 *   npm run simulate
 *
 * Executes the *actual JavaScript emitted into the Code nodes* against a mock
 * n8n runtime, a mock Google Sheet and mock HTTP responses. This verifies what
 * unit tests cannot reach: the pagination state machine, the stop-on-empty rule,
 * 403 handling, the detail loop, and — most importantly — that running the
 * workflow a second time for the other region tops up the same sheet rows
 * instead of duplicating them.
 *
 * No network, no ScrapingBee credits.
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

function loadWorkflow() {
  const wf = JSON.parse(readFileSync(resolve(ROOT, 'workflows/companywall-scraper.json'), 'utf8'));
  const byName = {};
  wf.nodes.forEach(n => { byName[n.name] = n; });
  return { wf, byName };
}

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
  return input.map(it => {
    const out = invoke([it]);
    return Array.isArray(out) ? out[0] : out;
  });
}

/** Google Sheets "Append or Update", matching on Profile URL. */
function upsert(sheet, row) {
  const i = sheet.findIndex(r => r['Profile URL'] && r['Profile URL'] === row['Profile URL']);
  if (i >= 0) sheet[i] = { ...sheet[i], ...row };
  else sheet.push({ ...row });
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
  // Deliberately returned by BOTH region searches.
  both: { slug: 'delta-valandovo', code: 'DDDD4444', name: 'ДЕЛТА ДООЕЛ Валандово', addr: 'ул. 4, Валандово', edb: '4029000000004', emp: 2, rev: '750.000' }
};

/** Southeast (r=7): 2 pages. East (r=2): 1 page. Then empty. */
function mockSearch(url) {
  const region = (url.match(/[&?]r=(\d+)/) || [])[1];
  const page = parseInt((url.match(/[&?]p=(\d+)/) || [])[1] || '1', 10);
  if (region === '7') {
    if (page === 1) return { statusCode: 200, body: searchPage([C.a, C.both]) };
    if (page === 2) return { statusCode: 200, body: searchPage([C.c]) };
    return { statusCode: 200, body: searchPage([]) };
  }
  if (page === 1) return { statusCode: 200, body: searchPage([C.b, C.both]) };
  return { statusCode: 200, body: searchPage([]) };
}

const PROFILE_HTML = `<html><body>
<h1>Тест компанија</h1>
<div><span>ЕДБ</span><span>4029000000001</span></div>
<div><span>ЕМБС</span><span>7000001</span></div>
<div><span>Дејност</span><span>47.910 - Трговија на мало преку пошта</span></div>
<p>Тест компанија е регистрирана на ул. 1, Штип и работи од 12.05.2016 година. Телефонот за контакт е 032/391-100 и контакт-мејл е info@alfa.mk.</p>
<section><span>тел</span><span>032/391-100</span><span>070 111 222</span>
<span>Е-пошта</span><span>info@alfa.mk</span><span>prodazba@alfa.mk</span></section>
</body></html>`;

const LICA_HTML = `<html><body>
<div><span>Претставник</span><span>Марко Марковски</span><span>Позиција</span><span>Управител</span><span>од</span><span>12.05.2016</span></div>
<div><span>Претставник</span><span>Ана Ангеловска</span><span>Позиција</span><span>Раководител на подружница</span><span>од</span><span>01.01.2020</span></div>
<div><span>Сопственик</span><span>Марко Марковски (100,00%)</span><span>од</span><span>12.05.2016</span></div>
</body></html>`;

/* ------------------------------------------------------------------ *
 * Whole-workflow runner
 * ------------------------------------------------------------------ */

function runWorkflow(opts) {
  const {
    regionCode, regionName,
    sheet = [],
    searchFetch = mockSearch,
    profile = PROFILE_HTML, lica = LICA_HTML,
    profileStatus = 200, licaStatus = 200,
    fetchDetails, maxCompanies, maxPages
  } = opts;

  const { byName } = loadWorkflow();
  const nodeData = {};

  // Config is the one node the user edits between runs — patch it the same way.
  let cfgCode = byName['Config'].parameters.jsCode
    .replace("const region = { code: 7, name: 'Southeast' };",
      `const region = { code: ${regionCode}, name: '${regionName}' };`);
  if (fetchDetails === false) cfgCode = cfgCode.replace('const fetchDetails = true;', 'const fetchDetails = false;');
  if (maxCompanies != null) cfgCode = cfgCode.replace('const maxCompanies = 0;', `const maxCompanies = ${maxCompanies};`);
  if (maxPages != null) cfgCode = cfgCode.replace('const maxPages     = 300;', `const maxPages = ${maxPages};`);
  ok('config patch applied cleanly', cfgCode.includes(`code: ${regionCode}`));

  nodeData['Config'] = runCode({ parameters: { jsCode: cfgCode } }, [{ json: {} }], nodeData);

  // Read Existing Sheet — alwaysOutputData means an empty sheet yields one blank item.
  const live = sheet.map(r => ({ ...r }));
  nodeData['Read Existing Sheet'] = live.length ? live.map(r => ({ json: { ...r } })) : [{ json: {} }];

  let state = runCode(byName['Seed State'], nodeData['Read Existing Sheet'], nodeData);

  const searchRequests = [];
  let guard = 0;
  while (true) {
    if (++guard > 60) throw new Error('pagination loop did not terminate');
    const built = runCode(byName['Build Search URL'], state, nodeData);
    nodeData['Build Search URL'] = built;

    const url = built[0].json.targetUrl;
    searchRequests.push(url);

    state = runCode(byName['Parse Search Page'], [{ json: searchFetch(url) }], nodeData);
    nodeData['Parse Search Page'] = state;
    if (!state[0].json.hasMore) break;              // the "More Pages?" IF node
  }

  const prepared = runCode(byName['Prepare Companies'], state, nodeData);
  nodeData['Prepare Companies'] = prepared;
  prepared.forEach(p => upsert(live, p.json));      // Write List Rows

  const selected = runCode(byName['Select For Detail'], prepared, nodeData);
  nodeData['Select For Detail'] = selected;

  const detailRequests = [];
  let summaryInput;

  if (selected.length === 1 && selected[0].json.__none) {
    summaryInput = selected;                        // "Need Details?" false branch
  } else {
    const enriched = [];
    for (const item of selected) {                  // Loop Companies, batch size 1
      nodeData['Loop Companies'] = [item];
      detailRequests.push(item.json.profileUrl, item.json.licaUrl);
      nodeData['Fetch Profile'] = [{ json: { statusCode: profileStatus, body: profile } }];
      const merged = runCode(byName['Merge Detail'],
        [{ json: { statusCode: licaStatus, body: lica } }], nodeData);
      upsert(live, merged[0].json);                 // Update Company Row
      enriched.push(merged[0]);
    }
    summaryInput = enriched;                        // Loop Companies "done" output
  }

  const summary = runCode(byName['Run Summary'], summaryInput, nodeData);
  return { searchRequests, detailRequests, sheet: live, summary: summary[0].json };
}

/* ================================================================== *
 * Run 1 — Southeast
 * ================================================================== */

console.log('--- Run 1: Southeast (r=7) ---');
const run1 = runWorkflow({ regionCode: 7, regionName: 'Southeast' });

eq('R1: search requests (2 pages + 1 empty)', run1.searchRequests.length, 3);
ok('R1: page 1 has no p= param', !/[&?]p=/.test(run1.searchRequests[0]), run1.searchRequests[0]);
ok('R1: page 2 requested', /[&?]p=2/.test(run1.searchRequests[1]), run1.searchRequests[1]);
ok('R1: only region 7 queried', run1.searchRequests.every(u => /[&?]r=7/.test(u)));
ok('R1: employee filter 1-5 on every request',
  run1.searchRequests.every(u => u.includes('dsm[1].Code=48&dsm[1].From=1&dsm[1].To=5')));
ok('R1: industry filter left empty', run1.searchRequests.every(u => u.includes('&at=&')));

eq('R1: rows written', run1.sheet.length, 3);
eq('R1: detail requests (3 companies x 2)', run1.detailRequests.length, 6);
ok('R1: every profile has a matching /lica request',
  run1.detailRequests.filter(u => u.endsWith('/lica')).length === 3);

const r1alfa = run1.sheet.find(r => r['Tax Number (EDB)'] === '4029000000001');
eq('R1: name', r1alfa['Company Name'], 'АЛФА ДООЕЛ Штип');
eq('R1: status', r1alfa['Status'], 'Активен');
eq('R1: address', r1alfa['Address'], 'ул. 1, Штип');
eq('R1: employees', r1alfa['Employees'], 3);
eq('R1: revenue parsed from MK format', r1alfa['Revenue MKD'], 1000000);
eq('R1: region', r1alfa['Region'], 'Southeast');
eq('R1: phones deduped and joined', r1alfa['Phones'], '032/391-100; 070 111 222');
eq('R1: emails joined', r1alfa['Emails'], 'info@alfa.mk; prodazba@alfa.mk');
eq('R1: owner with percentage', r1alfa['Owners'], 'Марко Марковски (100,00%)');
eq('R1: ALL managers, with position and from-date', r1alfa['Managers'],
  'Марко Марковски — Управител (од 12.05.2016); Ана Ангеловска — Раководител на подружница (од 01.01.2020)');
eq('R1: NKD code', r1alfa['NKD Code'], '47.910');
eq('R1: NKD description', r1alfa['NKD Description'], 'Трговија на мало преку пошта');
eq('R1: date founded', r1alfa['Date Founded'], '12.05.2016');
eq('R1: marked enriched', r1alfa['Detail Fetched'], 'yes');
eq('R1: 18 columns on every row', run1.sheet.every(r => Object.keys(r).length === 18), true);

eq('R1: summary region', run1.summary.region, 'Southeast (r=7)');
eq('R1: summary companies found', run1.summary.companiesFoundThisRegion, 3);
eq('R1: summary request count', run1.summary.scrapingBeeRequests, 3 + 6);
eq('R1: no crawl errors', run1.summary.crawlErrors, ['none']);
ok('R1: summary tells you the next region', /code: 2/.test(run1.summary.NEXT_STEP), run1.summary.NEXT_STEP);

/* ================================================================== *
 * Run 2 — East, against the sheet run 1 produced
 * ================================================================== */

console.log('--- Run 2: East (r=2), same sheet ---');
const run2 = runWorkflow({ regionCode: 2, regionName: 'East', sheet: run1.sheet });

ok('R2: only region 2 queried', run2.searchRequests.every(u => /[&?]r=2/.test(u)));
eq('R2: search requests (1 page + 1 empty)', run2.searchRequests.length, 2);

// C.both was already found in run 1; only C.b is new.
eq('R2: total rows after both runs (no duplicates)', run2.sheet.length, 4);
eq('R2: only the genuinely new company is enriched', run2.detailRequests.length, 2);
ok('R2: does NOT re-fetch the company already enriched in run 1',
  !run2.detailRequests.some(u => u.includes('delta-valandovo')),
  JSON.stringify(run2.detailRequests));

const r2both = run2.sheet.find(r => r['Tax Number (EDB)'] === '4029000000004');
eq('R2: cross-region company records BOTH regions', r2both['Region'], 'Southeast + East');
eq('R2: its run-1 detail is preserved, not blanked', r2both['Owners'], 'Марко Марковски (100,00%)');
eq('R2: its run-1 phones preserved', r2both['Phones'], '032/391-100; 070 111 222');
eq('R2: still marked enriched', r2both['Detail Fetched'], 'yes');

const r2beta = run2.sheet.find(r => r['Tax Number (EDB)'] === '4029000000002');
eq('R2: new company region', r2beta['Region'], 'East');
eq('R2: new company enriched', r2beta['Detail Fetched'], 'yes');

const r2alfa = run2.sheet.find(r => r['Tax Number (EDB)'] === '4029000000001');
eq('R2: run-1-only company untouched', r2alfa['Region'], 'Southeast');
eq('R2: run-1-only company keeps its data', r2alfa['NKD Code'], '47.910');

eq('R2: summary counts previously-enriched', run2.summary.alreadyEnrichedFromPreviousRun, 1);
eq('R2: summary counts newly enriched', run2.summary.companiesEnrichedThisRun, 1);
ok('R2: summary points back to Southeast', /code: 7/.test(run2.summary.NEXT_STEP), run2.summary.NEXT_STEP);

/* --- Re-running the same region must be a no-op --- */
console.log('--- Re-run: idempotency ---');
const rerun = runWorkflow({ regionCode: 7, regionName: 'Southeast', sheet: run2.sheet });
eq('Rerun: no new rows', rerun.sheet.length, 4);
eq('Rerun: no detail requests', rerun.detailRequests.length, 0);
eq('Rerun: region field not corrupted', rerun.sheet.find(r => r['Tax Number (EDB)'] === '4029000000004')['Region'], 'Southeast + East');
ok('Rerun: summary explains the skip', /already enriched/i.test(rerun.summary.detailPassSkipped || ''),
  rerun.summary.detailPassSkipped);

/* ================================================================== *
 * Failure modes
 * ================================================================== */

console.log('--- 403 on search ---');
const blocked = runWorkflow({
  regionCode: 7, regionName: 'Southeast',
  searchFetch: (url) => {
    const page = parseInt((url.match(/[&?]p=(\d+)/) || [])[1] || '1', 10);
    if (page === 1) return { statusCode: 200, body: searchPage([C.a, C.both]) };
    return { statusCode: 403, body: 'Forbidden' };
  }
});
ok('403: logged', blocked.summary.crawlErrors.some(e => /BLOCKED 403/.test(e)),
  JSON.stringify(blocked.summary.crawlErrors));
ok('403: not retried', blocked.searchRequests.filter(u => /[&?]p=2/.test(u)).length === 1);
eq('403: rows found before the block are kept', blocked.sheet.length, 2);
ok('403: remedy suggested', blocked.summary.crawlErrors.some(e => /premiumProxy/.test(e)));

console.log('--- repeated page guard ---');
const repeat = runWorkflow({
  regionCode: 7, regionName: 'Southeast',
  searchFetch: () => ({ statusCode: 200, body: searchPage([C.a]) })  // same page forever
});
eq('repeat: stops once nothing new arrives', repeat.searchRequests.length, 2);
eq('repeat: single row', repeat.sheet.length, 1);

console.log('--- maxPages guard ---');
const capped = runWorkflow({
  regionCode: 7, regionName: 'Southeast', maxPages: 1,
  searchFetch: (url) => {
    const page = parseInt((url.match(/[&?]p=(\d+)/) || [])[1] || '1', 10);
    return { statusCode: 200, body: searchPage(page < 5 ? [{ ...C.a, code: 'X' + page, slug: 's' + page }] : []) };
  }
});
eq('maxPages: stops at the cap', capped.searchRequests.length, 1);
ok('maxPages: warns about truncation', capped.summary.crawlErrors.some(e => /maxPages/.test(e)));

console.log('--- blocked /lica must still write the row ---');
const licaBlocked = runWorkflow({ regionCode: 7, regionName: 'Southeast', licaStatus: 403 });
const lb = licaBlocked.sheet[0];
eq('lica 403: row still written', licaBlocked.sheet.length, 3);
eq('lica 403: profile data survives', lb['Phones'], '032/391-100; 070 111 222');
eq('lica 403: owners blank', lb['Owners'], '');
ok('lica 403: note records it', /LICA_BLOCKED_403/.test(lb['Notes']), lb['Notes']);
ok('lica 403: summary warns', /blocked/i.test(licaBlocked.summary.WARNING || ''), licaBlocked.summary.WARNING);

console.log('--- unparseable pages must not drop records ---');
const junk = runWorkflow({
  regionCode: 7, regionName: 'Southeast',
  profile: '<html><body>nothing here</body></html>',
  lica: '<html><body>nothing here</body></html>'
});
eq('junk: records kept', junk.sheet.length, 3);
ok('junk: profile URL retained for manual review', !!junk.sheet[0]['Profile URL']);
eq('junk: list fields retained', junk.sheet[0]['Company Name'], 'АЛФА ДООЕЛ Штип');
ok('junk: notes explain the miss', /NO_PHONE_FOUND/.test(junk.sheet[0]['Notes']), junk.sheet[0]['Notes']);
ok('junk: summary flags the lica parser', /lica parser/i.test(junk.summary.WARNING_LICA || ''),
  junk.summary.WARNING_LICA);

/* ================================================================== *
 * Config switches
 * ================================================================== */

console.log('--- config switches ---');
const listOnly = runWorkflow({ regionCode: 7, regionName: 'Southeast', fetchDetails: false });
eq('fetchDetails=false: no detail requests', listOnly.detailRequests.length, 0);
eq('fetchDetails=false: list rows still written', listOnly.sheet.length, 3);
eq('fetchDetails=false: list fields present', listOnly.sheet[0]['Employees'], 3);
eq('fetchDetails=false: detail columns blank', listOnly.sheet[0]['Phones'], '');
ok('fetchDetails=false: summary says why', /fetchDetails is false/.test(listOnly.summary.detailPassSkipped || ''),
  listOnly.summary.detailPassSkipped);

const trial = runWorkflow({ regionCode: 7, regionName: 'Southeast', maxPages: 1, maxCompanies: 2 });
eq('trial run: one search page', trial.searchRequests.length, 1);
eq('trial run: two companies enriched (4 requests)', trial.detailRequests.length, 4);
eq('trial run: total requests as advertised', trial.summary.scrapingBeeRequests, 1 + 4);

// A company held back by the cap must stay pending, and be picked up next run.
const capped1 = runWorkflow({ regionCode: 7, regionName: 'Southeast', maxPages: 1, maxCompanies: 1 });
eq('cap: only one company enriched', capped1.detailRequests.length, 2);
eq('cap: the other stays pending', capped1.sheet.filter(r => r['Detail Fetched'] !== 'yes').length, 1);

const capped2 = runWorkflow({ regionCode: 7, regionName: 'Southeast', maxPages: 1, sheet: capped1.sheet });
eq('cap: next run picks up exactly the pending one', capped2.detailRequests.length, 2);
eq('cap: nothing left pending afterwards', capped2.sheet.filter(r => r['Detail Fetched'] !== 'yes').length, 0);
eq('cap: no duplicate rows across the two runs', capped2.sheet.length, 2);

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('\nFailures:\n' + failures.join('\n'));
process.exit(fail ? 1 : 0);

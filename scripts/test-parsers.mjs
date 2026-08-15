/**
 * Offline parser tests.
 *
 *   npm test
 *
 * Two layers:
 *
 * 1. Synthetic fixtures — cover both plausible markup shapes (values inline with
 *    their label, vs. label and value in separate elements) so the parsers cannot
 *    silently regress when you tune them.
 *
 * 2. Real fixtures — anything you drop into tests/fixtures/ is parsed and
 *    reported on. This is the tuning loop after Step 0: save the HTML that
 *    parsed badly, edit lib/parsers.js, re-run, no ScrapingBee credits burned.
 *      tests/fixtures/search-*.html
 *      tests/fixtures/profile-*.html
 *      tests/fixtures/lica-*.html
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSearchResults, parseProfile, parseLica,
  buildSearchUrl, dedupeCompanies, buildSheetRow,
  mkNumber, isPhone, isEmail, phoneKey, htmlToLines
} from '../lib/parsers.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = resolve(ROOT, 'tests/fixtures');

let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fail++;
  failures.push(`  ${name}\n      expected: ${e}\n      actual:   ${a}`);
}

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`  ${name}${detail ? '\n      ' + detail : ''}`);
}

/* ================================================================== *
 * Primitives
 * ================================================================== */

check('mkNumber: MK thousands + decimal', mkNumber('1.234.567,89'), 1234567.89);
check('mkNumber: plain thousands', mkNumber('12.500'), 12500);
check('mkNumber: bare integer', mkNumber('450'), 450);
check('mkNumber: with currency noise', mkNumber('3.200.000 ден.'), 3200000);
check('mkNumber: empty', mkNumber('  '), null);

check('isPhone: landline w/ slash', isPhone('033/431-021'), true);
check('isPhone: mobile spaced', isPhone('078 123 456'), true);
check('isPhone: intl', isPhone('+389 2 3111 222'), true);
check('isPhone: rejects year', isPhone('2019'), false);
check('isPhone: rejects text', isPhone('Скопје'), false);

check('phoneKey: +389 form == national form',
  phoneKey('+389 78 123456') === phoneKey('078123456'), true);

check('isEmail: plain', isEmail('info@firma.mk'), true);
check('isEmail: rejects site own domain', isEmail('info@companywall.com.mk'), false);
check('isEmail: rejects image', isEmail('logo@2x.png'), false);

/* ================================================================== *
 * Search URL — must match the confirmed browser-captured string exactly
 * ================================================================== */

const u1 = buildSearchUrl(7, 1, 1, 5);
ok('searchUrl: no p= on page 1', !/[?&]p=/.test(u1), u1);
ok('searchUrl: region', u1.includes('&r=7&'), u1);
ok('searchUrl: no industry filter (at= empty)', u1.includes('&at=&'), u1);
ok('searchUrl: employee filter 1-5',
  u1.includes('dsm[1].Code=48&dsm[1].From=1&dsm[1].To=5'), u1);
ok('searchUrl: revenue filter disabled',
  u1.includes('dsm[0].Code=201&dsm[0].From=0&dsm[0].To=0'), u1);
ok('searchUrl: brackets left unencoded', u1.includes('dsm[-1].Code=0'), u1);
ok('searchUrl: page 2 appends p=2', buildSearchUrl(2, 2, 1, 5).endsWith('&p=2'));

/* ================================================================== *
 * Search results — shape A: each value inline with its label
 * ================================================================== */

const SEARCH_INLINE = `
<html><body>
<div class="results">
  <div class="row">
    <a href="/kompanija/%D0%B0%D0%BB%D1%84%D0%B0-%D0%B4%D0%BE%D0%BE%D0%B5%D0%BB-%D1%88%D1%82%D0%B8%D0%BF/AbCd1234">АЛФА ДООЕЛ Штип</a>
    <span class="status">Активен</span>
    <div>Адреса: ул. Тошо Арсов 12, Штип</div>
    <div>ЕДБ: 4029012345678</div>
    <div>ЕМБС: 7123456</div>
    <div>Вработени: 3</div>
    <div>Приходи: 4.250.000</div>
  </div>
  <div class="row">
    <a href="/kompanija/%D0%B1%D0%B5%D1%82%D0%B0-%D0%B4%D0%BE%D0%BE-%D0%BA%D0%BE%D1%87%D0%B0%D0%BD%D0%B8/EfGh5678">БЕТА ДОО Кочани</a>
    <span class="status">Активен</span>
    <div>Адреса: бул. Ослободување 5, Кочани</div>
    <div>ЕДБ: 4013998877665</div>
    <div>ЕМБС: 6543210</div>
    <div>Вработени: 5</div>
    <div>Приходи: 980.000</div>
  </div>
</div>
<a href="/kompanija/%D0%B0%D0%BB%D1%84%D0%B0-%D0%B4%D0%BE%D0%BE%D0%B5%D0%BB-%D1%88%D1%82%D0%B8%D0%BF/AbCd1234">лого</a>
<div class="paging"><a href="/prebaruvanje?r=7&amp;p=2">2</a></div>
<div>Пронајдени 137 резултати</div>
</body></html>`;

const sInline = parseSearchResults(SEARCH_INLINE);
check('search/inline: row count', sInline.rows.length, 2);
check('search/inline: name 1', sInline.rows[0].name, 'АЛФА ДООЕЛ Штип');
check('search/inline: edb 1', sInline.rows[0].edb, '4029012345678');
check('search/inline: embs 1', sInline.rows[0].embs, '7123456');
check('search/inline: status 1', sInline.rows[0].status, 'Активен');
check('search/inline: employees 1', sInline.rows[0].employees, 3);
check('search/inline: revenue 1', sInline.rows[0].revenue, 4250000);
check('search/inline: address 1', sInline.rows[0].address, 'ул. Тошо Арсов 12, Штип');
check('search/inline: profile url 2', sInline.rows[1].profileUrl,
  'https://www.companywall.com.mk/kompanija/%D0%B1%D0%B5%D1%82%D0%B0-%D0%B4%D0%BE%D0%BE-%D0%BA%D0%BE%D1%87%D0%B0%D0%BD%D0%B8/EfGh5678');
check('search/inline: lica url 2', sInline.rows[1].licaUrl, sInline.rows[1].profileUrl + '/lica');
check('search/inline: edb 2 (no bleed from row 1)', sInline.rows[1].edb, '4013998877665');
check('search/inline: employees 2', sInline.rows[1].employees, 5);
check('search/inline: total detected', sInline.total, 137);
check('search/inline: all rows have edb', sInline.rowsWithEdb, 2);

/* ================================================================== *
 * Search results — shape B: label and value in sibling elements
 * ================================================================== */

const SEARCH_SPLIT = `
<html><body>
<table><tbody>
<tr>
  <td><a href="/kompanija/gama-doo-strumica/XyZw9012"><strong>ГАМА ДОО Струмица</strong></a></td>
  <td><span>Активен</span></td>
  <td><span>Адреса</span><span>ул. Маршал Тито 1, Струмица</span></td>
  <td><span>ЕДБ</span><span>4027001122334</span></td>
  <td><span>Вработени</span><span>1</span></td>
  <td><span>Приходи</span><span>1.100.500</span></td>
</tr>
<tr>
  <td><a href="/kompanija/delta-dooel-berovo/QwEr3456"><strong>ДЕЛТА ДООЕЛ Берово</strong></a></td>
  <td><span>Неактивен</span></td>
  <td><span>Адреса</span><span>ул. Димитар Влахов 8, Берово</span></td>
  <td><span>ЕДБ</span><span>4005887766554</span></td>
  <td><span>Вработени</span><span>4</span></td>
  <td><span>Приходи</span><span>0</span></td>
</tr>
</tbody></table>
</body></html>`;

const sSplit = parseSearchResults(SEARCH_SPLIT);
check('search/split: row count', sSplit.rows.length, 2);
check('search/split: name 1', sSplit.rows[0].name, 'ГАМА ДОО Струмица');
check('search/split: edb 1', sSplit.rows[0].edb, '4027001122334');
check('search/split: employees 1', sSplit.rows[0].employees, 1);
check('search/split: revenue 1', sSplit.rows[0].revenue, 1100500);
check('search/split: address 1', sSplit.rows[0].address, 'ул. Маршал Тито 1, Струмица');
check('search/split: status 2 inactive', sSplit.rows[1].status, 'Неактивен');
check('search/split: edb 2', sSplit.rows[1].edb, '4005887766554');
check('search/split: all rows have edb', sSplit.rowsWithEdb, 2);

// Navigation/footer links must never be mistaken for result rows.
const SEARCH_NOISE = `<a href="/kompanija">Компании</a><a href="/kompanija/x">short</a>
<a href="/prebaruvanje?r=7">пребарување</a>`;
check('search: ignores non-profile links', parseSearchResults(SEARCH_NOISE).rows.length, 0);
check('search: empty page yields zero rows (pagination stop signal)',
  parseSearchResults('<html><body>Нема резултати</body></html>').rows.length, 0);

/* ================================================================== *
 * Profile page
 * ================================================================== */

const PROFILE = `
<html><head><title>Б-ТЕЦХНОЛОЏИ ДООЕЛ Скопје | CompanyWall</title></head><body>
<h1>Друштво за услуги Б-ТЕЦХНОЛОЏИ ДООЕЛ Скопје</h1>
<div><span>ЕДБ</span><span>4080019556789</span></div>
<div><span>ЕМБС</span><span>7412589</span></div>
<div><span>Дејност</span><span>62.010 - Компјутерско програмирање</span></div>
<p>Друштво за услуги Б-ТЕЦХНОЛОЏИ ДООЕЛ Скопје е регистрирана на ул. Партизански одреди 15, Скопје и работи од 14.03.2011 година. Телефонот за контакт е 02/3221-455 и контакт-мејл е info@btehnologi.mk.</p>
<section class="kontakti">
  <span>тел</span>
  <span>02/3221-455</span>
  <span>070 555 123</span>
  <span>+389 70 555 123</span>
  <span>Е-пошта</span>
  <span>info@btehnologi.mk</span>
  <span>sales@btehnologi.mk</span>
</section>
<a href="tel:023221455">Јави се</a>
<a href="mailto:info@btehnologi.mk">Пиши</a>
<a href="/kompanija/b-tehnologi/MMxL2jxY/lica">Прикажи ги сите</a>
<footer><a href="mailto:info@companywall.com.mk">CompanyWall</a></footer>
</body></html>`;

const p = parseProfile(PROFILE);
check('profile: name from h1', p.name, 'Друштво за услуги Б-ТЕЦХНОЛОЏИ ДООЕЛ Скопје');
check('profile: edb', p.edb, '4080019556789');
check('profile: embs', p.embs, '7412589');
check('profile: nkd code', p.nkdCode, '62.010');
check('profile: nkd description', p.nkdDesc, 'Компјутерско програмирање');
check('profile: address', p.address, 'ул. Партизански одреди 15, Скопје');
check('profile: date founded', p.dateFounded, '14.03.2011');
check('profile: emails (both, site email excluded)', p.emails,
  ['info@btehnologi.mk', 'sales@btehnologi.mk']);
ok('profile: captures multiple phones', p.phones.length >= 2, JSON.stringify(p.phones));
check('profile: dedupes 070 555 123 against +389 70 555 123', p.phones.length, 2);
ok('profile: no NO_PHONE/NO_EMAIL notes', !p.notes.some(n => /NO_(PHONE|EMAIL)/.test(n)),
  JSON.stringify(p.notes));

// The brief flags that phone is sometimes absent from the description paragraph.
const PROFILE_NO_PHONE = `<html><body><h1>ОМЕГА ДООЕЛ Виница</h1>
<div>ЕДБ 4004556677889</div>
<p>ОМЕГА ДООЕЛ Виница е регистрирана на ул. Бел Камен 3, Виница и работи од 2018 година. Контакт-мејл е kontakt@omega.mk.</p>
</body></html>`;
const pnp = parseProfile(PROFILE_NO_PHONE);
check('profile/no-phone: still extracts edb', pnp.edb, '4004556677889');
check('profile/no-phone: year-only founding date', pnp.dateFounded, '2018');
check('profile/no-phone: address', pnp.address, 'ул. Бел Камен 3, Виница');
ok('profile/no-phone: records NO_PHONE_FOUND note', pnp.notes.includes('NO_PHONE_FOUND'));
ok('profile/no-phone: email still found', pnp.emails.includes('kontakt@omega.mk'));

// A decimal in body text must not be mistaken for an NKD code.
const PROFILE_FAKE_NKD = `<html><body><h1>Тест</h1><p>Вредност 12.345 - 678</p></body></html>`;
check('profile: rejects non-Cyrillic NKD false positive',
  parseProfile(PROFILE_FAKE_NKD).nkdCode, '');

/* ================================================================== *
 * /lica — owners and representatives
 * ================================================================== */

const LICA = `
<html><body>
<div class="lica">
  <div><span>Претставник</span><span>Марко Марковски</span>
       <span>Позиција</span><span>Управител</span>
       <span>од</span><span>01.02.2015</span>
       <span>до</span><span>Активно</span></div>
  <div><span>Претставник</span><span>Марко Марковски</span>
       <span>Позиција</span><span>Управител-Менаџер</span>
       <span>од</span><span>03.09.2019</span>
       <span>до</span><span>Активно</span></div>
  <div><span>Претставник</span><span>Ана Ангеловска</span>
       <span>Позиција</span><span>Раководител на подружница</span>
       <span>од</span><span>12.12.2020</span>
       <span>до</span><span>Активно</span></div>
  <div><span>Сопственик</span><span>Друштво БТОБЕТ Лимитед (100,00%)</span>
       <span>од</span><span>14.03.2011</span>
       <span>до</span><span>Активно</span></div>
</div>
</body></html>`;

const l = parseLica(LICA);
check('lica: manager count (all roles, not just first)', l.managers.length, 3);
check('lica: owner count', l.owners.length, 1);
check('lica: manager 1 name', l.managers[0].name, 'Марко Марковски');
check('lica: manager 1 position', l.managers[0].position, 'Управител');
check('lica: manager 1 from-date', l.managers[0].from, '01.02.2015');
check('lica: same person, second role kept separately', l.managers[1].position, 'Управител-Менаџер');
check('lica: manager 3 position', l.managers[2].position, 'Раководител на подружница');
check('lica: owner can be a company, recorded as-is', l.owners[0].name, 'Друштво БТОБЕТ Лимитед');
check('lica: ownership percentage split off the name', l.owners[0].share, '100,00%');

// Explicit "Сопственички удел" label variant.
const LICA_SHARE_LABEL = `<html><body>
<div><span>Сопственик</span><span>Петар Петровски</span>
     <span>Сопственички удел</span><span>51,00%</span>
     <span>од</span><span>05.05.2005</span></div>
<div><span>Сопственик</span><span>Јана Јанева</span>
     <span>Сопственички удел</span><span>49,00%</span>
     <span>од</span><span>05.05.2005</span></div>
</body></html>`;
const l2 = parseLica(LICA_SHARE_LABEL);
check('lica/label: two owners', l2.owners.length, 2);
check('lica/label: owner 1 share', l2.owners[0].share, '51,00%');
check('lica/label: owner 2 name', l2.owners[1].name, 'Јана Јанева');

const licaEmpty = parseLica('<html><body>Нема податоци</body></html>');
check('lica: page with no people yields empty lists',
  { owners: licaEmpty.owners, managers: licaEmpty.managers }, { owners: [], managers: [] });

/* ================================================================== *
 * Dedupe + sheet row shaping
 * ================================================================== */

const dupA = { edb: '4029012345678', name: 'АЛФА', region: 'Southeast', profileUrl: 'https://x/1', employees: 3, revenue: 100 };
const dupB = { edb: '4029012345678', name: 'АЛФА', region: 'East', profileUrl: 'https://x/1', employees: null, revenue: null };
const dupC = { edb: '', name: 'БЕЗ ЕДБ', region: 'East', profileUrl: 'https://x/2' };

const deduped = dedupeCompanies([dupA, dupB, dupC]);
check('dedupe: merges by EDB', deduped.length, 2);
check('dedupe: records both regions', deduped[0].region, 'Southeast + East');
check('dedupe: keeps richer value', deduped[0].employees, 3);
check('dedupe: keeps EDB-less record via profile URL', deduped[1].name, 'БЕЗ ЕДБ');
check('dedupe: drops record with neither key', dedupeCompanies([{ edb: '', profileUrl: '' }]).length, 0);

const row = buildSheetRow({
  name: 'АЛФА', status: 'Активен', address: 'ул. 1', edb: '4029012345678', embs: '7123456',
  employees: 3, revenue: 4250000,
  phones: ['02/3221-455', '070 555 123'],
  emails: ['a@b.mk', 'c@d.mk'],
  owners: [{ name: 'Друштво БТОБЕТ Лимитед', share: '100,00%' }],
  managers: [{ name: 'Марко Марковски', position: 'Управител', from: '01.02.2015' }],
  nkdCode: '62.010', nkdDesc: 'Компјутерско програмирање',
  dateFounded: '14.03.2011', region: 'Southeast',
  profileUrl: 'https://x/1', detailFetched: true, notes: []
}, '; ');

check('row: phones joined', row['Phones'], '02/3221-455; 070 555 123');
check('row: emails joined', row['Emails'], 'a@b.mk; c@d.mk');
check('row: owner formatted with share', row['Owners'], 'Друштво БТОБЕТ Лимитед (100,00%)');
check('row: manager formatted with position + from-date',
  row['Managers'], 'Марко Марковски — Управител (од 01.02.2015)');
check('row: detail flag', row['Detail Fetched'], 'yes');
check('row: empty employees renders as blank not 0',
  buildSheetRow({ employees: null })['Employees'], '');
check('row: column count', Object.keys(row).length, 18);

/* ================================================================== *
 * Real fixtures, if any have been saved
 * ================================================================== */

function reportRealFixtures() {
  if (!existsSync(FIXTURES)) return;
  const files = readdirSync(FIXTURES).filter(f => f.endsWith('.html'));
  if (!files.length) {
    console.log('\nNo real fixtures yet. After Step 0, save pages into tests/fixtures/');
    console.log('as search-*.html / profile-*.html / lica-*.html to check them here.');
    return;
  }

  console.log('\n--- Real fixtures ---');
  for (const f of files) {
    const html = readFileSync(resolve(FIXTURES, f), 'utf8');
    const n = basename(f);
    if (n.startsWith('search')) {
      const r = parseSearchResults(html);
      console.log(`\n${n}: ${r.rows.length} rows, ${r.rowsWithEdb} with EDB, mode=${r.mode}, total=${r.total}`);
      if (r.flags.length) console.log(`  flags: ${r.flags.join(', ')}`);
      if (r.rows[0]) console.log('  first row:', JSON.stringify(r.rows[0], null, 2).replace(/\n/g, '\n  '));
      if (r.rows.length && r.rowsWithEdb / r.rows.length < 0.9) {
        console.log('  ** WARNING: many rows missing EDB — row chunking likely wrong');
      }
    } else if (n.startsWith('profile')) {
      const r = parseProfile(html);
      console.log(`\n${n}:`, JSON.stringify(r, null, 2).replace(/\n/g, '\n  '));
    } else if (n.startsWith('lica')) {
      const r = parseLica(html);
      console.log(`\n${n}: ${r.owners.length} owners, ${r.managers.length} managers`);
      console.log('  owners:', JSON.stringify(r.owners));
      console.log('  managers:', JSON.stringify(r.managers));
    } else {
      console.log(`\n${n}: unrecognised prefix — name it search-*, profile-* or lica-*`);
      console.log(`  first 15 text lines: ${JSON.stringify(htmlToLines(html).slice(0, 15))}`);
    }
  }
}

/* ================================================================== */

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:\n' + failures.join('\n'));
}
reportRealFixtures();
process.exit(fail ? 1 : 0);

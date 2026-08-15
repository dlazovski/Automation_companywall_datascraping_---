/**
 * CompanyWall.mk parsing helpers.
 *
 * SINGLE SOURCE OF TRUTH. Everything between the `#region injectable` markers is
 * inlined verbatim into every n8n Code node by `scripts/build.mjs`. Edit here,
 * run `npm run build`, re-import the workflows.
 *
 * Deliberately dependency-free: n8n Cloud Code nodes cannot `require()` external
 * modules (cheerio included), and self-hosted needs NODE_FUNCTION_ALLOW_EXTERNAL.
 *
 * Strategy: instead of CSS selectors (which depend on the exact DOM wrappers we
 * have not been able to see), we linearise the HTML into text lines and run small
 * state machines over the label/value sequences. The site renders its data as
 * "label line, then value line(s)", so this survives markup changes that would
 * break selectors, and it matches the shape the page structure was described in.
 */

// #region injectable

const CW_BASE = 'https://www.companywall.com.mk';

/* ------------------------------------------------------------------ *
 * Text / HTML primitives
 * ------------------------------------------------------------------ */

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, function (_, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCharCode(parseInt(h, 16)); });
}

function stripTags(s) {
  return decodeEntities(String(s == null ? '' : s).replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Flatten HTML into an array of trimmed, non-empty text lines.
 * Block AND inline-ish tags become line breaks, because the site wraps each
 * label and each value in its own <span>/<div>.
 */
function htmlToLines(html) {
  var s = String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|td|th|h[1-6]|dt|dd|section|article|span|a|label|strong|b|em|small)>/gi, '\n')
    .replace(/<(p|div|li|tr|td|th|h[1-6]|dt|dd|section|article|table|ul|ol|dl|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  var lines = decodeEntities(s)
    .split('\n')
    .map(function (l) { return l.replace(/\s+/g, ' ').trim(); })
    .filter(function (l) { return l.length > 0; });

  // Inline markup can strand an ownership percentage on its own line
  // ("Друштво БТОБЕТ Лимитед" / "(100,00%)"). Re-join it onto the name — but
  // never onto a label, or "Сопственички удел" + "51,00%" would fuse into a
  // line that no longer matches the label.
  var out = [];
  for (var i = 0; i < lines.length; i++) {
    if (/^\(?\s*\d{1,3}([.,]\d{1,4})?\s*%\s*\)?$/.test(lines[i])
      && out.length && !isLicaLabel(out[out.length - 1])) {
      out[out.length - 1] += ' ' + lines[i];
    } else {
      out.push(lines[i]);
    }
  }
  return out;
}

/**
 * Status tokens. JS \b is ASCII-only, so it never fires next to Cyrillic —
 * boundaries here are done with an explicit Cyrillic-letter lookahead instead.
 * "Неактивен" must precede "Активен" so it is not matched as a substring.
 */
var STATUS_RE = /(Неактивен|Неактивна|Неактивно|Блокиран[а-яѐ-џ]*|Во стечај|Ликвидациј[а-яѐ-џ]*|Избришан[а-яѐ-џ]*|Активен|Активна|Активно)(?![а-яѐ-џ])/i;

function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[:.\s]+$/, '')
    .trim();
}

function digitsOnly(s) { return String(s == null ? '' : s).replace(/\D+/g, ''); }

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function uniqBy(arr, keyFn) {
  var seen = Object.create(null);
  var out = [];
  (arr || []).forEach(function (v) {
    var k = keyFn(v);
    if (!k || seen[k]) return;
    seen[k] = 1;
    out.push(v);
  });
  return out;
}

/**
 * Macedonian number format: "1.234.567,89" -> 1234567.89
 * Returns null when there is nothing numeric to read.
 */
function mkNumber(s) {
  var t = String(s == null ? '' : s).replace(/[^\d.,-]/g, '');
  // Trailing separators come from units ("3.200.000 ден." -> "3.200.000.").
  t = t.replace(/^[.,-]+/, '').replace(/[.,-]+$/, '');
  if (!t || !/\d/.test(t)) return null;
  var hasDot = t.indexOf('.') >= 0;
  var hasComma = t.indexOf(',') >= 0;
  if (hasDot && hasComma) {
    t = t.replace(/\./g, '').replace(',', '.');           // dot = thousands, comma = decimal
  } else if (hasComma) {
    t = /,\d{3}(\D|$)/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (hasDot) {
    if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, ''); // pure thousands grouping
  }
  var n = parseFloat(t);
  return isFinite(n) ? n : null;
}

function firstInt(s) {
  var m = String(s == null ? '' : s).match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

/* ------------------------------------------------------------------ *
 * Validators
 * ------------------------------------------------------------------ */

var EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
var EMAIL_SCAN_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
var EMAIL_BLOCK_RE = /(companywall|bisnode|sentry|wixpress|example\.(com|org)|schema\.org|@2x|\.(png|jpe?g|gif|svg|webp|css|js)$)/i;

function isEmail(s) {
  var t = String(s == null ? '' : s).trim();
  return EMAIL_RE.test(t) && !EMAIL_BLOCK_RE.test(t);
}

/** Accepts "078 123 456", "033/431-021", "+389 2 3111 222". */
function isPhone(s) {
  var t = String(s == null ? '' : s).trim();
  if (!/^[+(\d]/.test(t)) return false;
  if (!/^[+()\d\s\-\/.]{6,25}$/.test(t)) return false;
  var d = digitsOnly(t).length;
  return d >= 6 && d <= 15;
}

/** Dedupe key that treats +389 78 123456 and 078123456 as the same line. */
function phoneKey(s) {
  var d = digitsOnly(s);
  return d.length > 8 ? d.slice(-8) : d;
}

function cleanPhone(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Label/value readers over linearised lines
 * ------------------------------------------------------------------ */

/**
 * Find a value for any of `labels`, handling both markup shapes:
 *   split:  ["Вработени", "3"]        -> "3"
 *   inline: ["Вработени: 3"]          -> "3"
 */
function labelValue(L, labels, maxAhead) {
  maxAhead = maxAhead || 2;
  for (var i = 0; i < L.length; i++) {
    var n = norm(L[i]);
    for (var k = 0; k < labels.length; k++) {
      var lab = norm(labels[k]);
      if (!lab) continue;
      if (n === lab) {
        for (var j = i + 1; j <= Math.min(L.length - 1, i + maxAhead); j++) {
          if (L[j] && norm(L[j]) !== lab) return L[j];
        }
      }
      var m = L[i].match(new RegExp('^' + escapeRe(labels[k]) + '\\s*[:\\-\u2013]?\\s+(.{1,200})$', 'i'));
      if (m && m[1].trim()) return m[1].trim();
    }
  }
  return '';
}

/** Same, but matches labels by prefix ("Приход" matches "Приходи (2024)"). */
function labelValueByPrefix(L, prefixes, maxAhead) {
  maxAhead = maxAhead || 2;
  for (var i = 0; i < L.length; i++) {
    var n = norm(L[i]);
    for (var k = 0; k < prefixes.length; k++) {
      var p = norm(prefixes[k]);
      if (!p || n.indexOf(p) !== 0) continue;
      var rest = L[i].slice(prefixes[k].length).replace(/^[\s:\-\u2013]+/, '').trim();
      if (rest) return rest;
      for (var j = i + 1; j <= Math.min(L.length - 1, i + maxAhead); j++) {
        if (L[j]) return L[j];
      }
    }
  }
  return '';
}

/**
 * Collect the run of values listed beneath a label, e.g.
 *   тел / 078111222 / 033431021 / Е-пошта / info@x.mk
 * Stops at `stopRe`, or at the first non-matching line once collecting started.
 */
function valuesUnderLabel(L, labelRe, stopRe, validator, max) {
  max = max || 25;
  var out = [];
  for (var i = 0; i < L.length; i++) {
    if (!labelRe.test(norm(L[i]))) continue;
    var got = 0;
    for (var j = i + 1; j < Math.min(L.length, i + 1 + max); j++) {
      var ln = L[j];
      if (stopRe && stopRe.test(norm(ln))) break;
      if (validator(ln)) { out.push(ln.trim()); got++; }
      else if (got) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Search URL
 * ------------------------------------------------------------------ */

/**
 * Query string is copied verbatim from a real browser session (confirmed live).
 * Brackets are intentionally left unencoded — that is what the site returns 200 for.
 *   at=                      -> no NKD/industry filter
 *   dsm[1].Code=48 From/To   -> employee count range
 *   dsm[0].Code=201 0/0      -> revenue filter disabled
 */
function buildSearchUrl(regionCode, page, empFrom, empTo) {
  var from = empFrom == null ? 1 : empFrom;
  var to = empTo == null ? 5 : empTo;
  var url = CW_BASE + '/prebaruvanje'
    + '?cr=MKD&n=&mv=&r=' + regionCode + '&c=&cp=&at=&area=&subarea=&sbjact=t'
    + '&blckd=&dbf=&dbt=&type=&bly=2025'
    + '&dsm[0].Code=201&dsm[0].From=0&dsm[0].To=0'
    + '&dsm[1].Code=48&dsm[1].From=' + from + '&dsm[1].To=' + to
    + '&dsm[-1].Code=0&dsm[-1].From=0&dsm[-1].To=0'
    + '&distinctcodes=&xpnd=true';
  return page && page > 1 ? url + '&p=' + page : url;
}

/* ------------------------------------------------------------------ *
 * Response health checks
 * ------------------------------------------------------------------ */

/**
 * Detects bot-challenge / login-wall responses so we fail loudly, not silently.
 *
 * Every marker is qualified by whether the page ALSO carries real site content.
 * The site's own login and registration forms load reCAPTCHA, so the string
 * "recaptcha" appears in the HTML of perfectly ordinary pages — treating that
 * alone as a block aborts a run that was working fine. A genuine interstitial
 * serves the challenge INSTEAD of the site, so it has no company links at all.
 */
function diagnoseResponse(html) {
  var h = String(html == null ? '' : html);
  var flags = [];
  if (!h) { flags.push('EMPTY_BODY'); return flags; }

  var hasContent = /\/kompanija\//i.test(h);

  if (h.length < 1500) flags.push('SUSPICIOUSLY_SHORT');

  var cfMarker = /cf-browser-verification|cf_chl|Checking your browser|Just a moment/i.test(h);
  if (cfMarker) flags.push(hasContent ? 'CF_MARKER_PRESENT_IGNORED' : 'CLOUDFLARE_CHALLENGE');

  var captchaMarker = /captcha|recaptcha|hcaptcha/i.test(h);
  if (captchaMarker) flags.push(hasContent ? 'CAPTCHA_SCRIPT_PRESENT_IGNORED' : 'CAPTCHA');

  if (/\/registracija|\/najava|Најави се|Регистрирај се/i.test(h) && !hasContent) flags.push('POSSIBLE_LOGIN_WALL');
  if (/CompanyBonitet/i.test(h)) flags.push('CONTAINS_BONITET_LINK_IGNORED');
  return flags;
}

/** True only for flags that mean "the site refused to serve us content". */
function isBlockingFlag(f) {
  return f === 'CLOUDFLARE_CHALLENGE' || f === 'CAPTCHA' || f === 'POSSIBLE_LOGIN_WALL';
}

/* ------------------------------------------------------------------ *
 * Search results page
 * ------------------------------------------------------------------ */

var PROFILE_HREF_RE = /href\s*=\s*["'](\/kompanija\/[^"'#?]+)["']/gi;

function isProfilePath(p) {
  var parts = String(p).split('/').filter(function (x) { return x.length > 0; });
  return parts.length === 3
    && parts[0] === 'kompanija'
    && parts[1].length > 0
    && /^[A-Za-z0-9_-]{4,24}$/.test(parts[2]);
}

/**
 * Ordered, de-duplicated profile anchors with their offsets in the raw HTML.
 *
 * `index` is rewound to the opening `<a`, not the `href=` match, so a row chunk
 * starts at a real tag boundary. Dedupe is by path across the whole page (not
 * just consecutive): a company is commonly linked twice per row (logo + title),
 * and a stray repeat elsewhere on the page must not invent an extra row.
 */
function findProfileAnchors(html) {
  var out = [];
  var seen = Object.create(null);
  var re = new RegExp(PROFILE_HREF_RE.source, 'gi');
  var m;
  while ((m = re.exec(html)) !== null) {
    var path = m[1].replace(/\/+$/, '');
    if (!isProfilePath(path) || seen[path]) continue;
    seen[path] = 1;
    var tagStart = html.lastIndexOf('<', m.index);
    out.push({ path: path, index: tagStart >= 0 ? tagStart : m.index });
  }
  return out;
}

function extractRowFields(chunkHtml, path) {
  var L = htmlToLines(chunkHtml);
  var text = L.join('\n');

  // A row links the company more than once (logo image, then title). Take the
  // anchor with the most text — that is the human-readable name.
  var name = '';
  var reA = /<a[^>]+href\s*=\s*["']\/kompanija\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/gi;
  var ma;
  while ((ma = reA.exec(chunkHtml)) !== null) {
    var cand = stripTags(ma[1]);
    if (cand.length > name.length) name = cand;
  }
  if (!name || name.length < 2) name = L[0] || '';
  if (name.length > 200) name = name.slice(0, 200).trim();

  var edb = (text.match(/ЕДБ[^\d]{0,15}(\d{13})/i) || [])[1]
    || (text.match(/(?:^|\D)(\d{13})(?:\D|$)/) || [])[1] || '';
  var embs = (text.match(/ЕМБС[^\d]{0,15}(\d{6,8})/i) || [])[1] || '';

  var status = (text.match(STATUS_RE) || [])[1] || '';

  var empRaw = labelValueByPrefix(L, ['Вработени', 'Број на вработени', 'Вработени лица', 'Број вработени']);
  var employees = empRaw ? firstInt(empRaw) : null;

  var revRaw = labelValueByPrefix(L, ['Приходи', 'Приход', 'Вкупен приход', 'Вкупни приходи', 'Годишен приход']);
  var revenue = revRaw ? mkNumber(revRaw) : null;

  var address = labelValueByPrefix(L, ['Адреса', 'Седиште']);
  if (!address) {
    // Fallback: first line after the name that looks like a street address.
    var ni = L.indexOf(name);
    for (var i = (ni >= 0 ? ni + 1 : 1); i < Math.min(L.length, (ni >= 0 ? ni : 0) + 8); i++) {
      var c = L[i];
      if (!c || c === status) continue;
      if (/^\d[\d\s.,]*$/.test(c)) continue;
      if (/^(ЕДБ|ЕМБС|Вработени|Приход)/i.test(c)) continue;
      if (/[,\d]/.test(c) && c.length > 5 && c.length < 160) { address = c; break; }
    }
  }

  return {
    name: name,
    status: status,
    address: address,
    edb: edb,
    embs: embs,
    employees: employees,
    revenue: revenue,
    profileUrl: CW_BASE + path,
    licaUrl: CW_BASE + path + '/lica',
    profilePath: path
  };
}

/** Total-results counter, best effort — used only for sanity logging. */
function detectTotal(html) {
  var text = htmlToLines(html).join('\n');
  var pats = [
    /(?:Пронајдени|Најдени|Вкупно|Резултати)[^\d]{0,40}([\d.,\s]{1,15})/i,
    /([\d.,\s]{1,15})\s*(?:резултат[аи]?|компани[иј][аи]?|друштв[аo])/i
  ];
  for (var i = 0; i < pats.length; i++) {
    var m = text.match(pats[i]);
    if (m) {
      var n = mkNumber(m[1]);
      if (n && n > 0) return Math.round(n);
    }
  }
  return null;
}

/**
 * Parse one search-results page.
 *
 * Rows are delimited by the profile anchors. Some layouts render a company's
 * fields BEFORE its link; if the no-lookbehind pass finds ЕДБ for fewer than
 * half the rows we retry with a lookbehind window and keep the better result.
 * `mode` in the return value tells you which pass won — check it in recon.
 */
function parseSearchResults(html, opts) {
  opts = opts || {};
  var raw = String(html == null ? '' : html);
  var anchors = findProfileAnchors(raw);

  function pass(lookbehind) {
    var rows = [];
    for (var i = 0; i < anchors.length; i++) {
      var prevEnd = i > 0 ? anchors[i - 1].index : 0;
      var start = Math.max(prevEnd, anchors[i].index - lookbehind);
      var end = i + 1 < anchors.length
        ? anchors[i + 1].index
        : Math.min(raw.length, anchors[i].index + 8000);
      rows.push(extractRowFields(raw.slice(start, end), anchors[i].path));
    }
    return rows;
  }

  var mode = 'no-lookbehind';
  var rows = pass(0);
  var withEdb = rows.filter(function (r) { return r.edb; }).length;
  if (anchors.length && withEdb / anchors.length < 0.5) {
    var alt = pass(opts.lookbehind == null ? 1200 : opts.lookbehind);
    var altEdb = alt.filter(function (r) { return r.edb; }).length;
    if (altEdb > withEdb) { rows = alt; withEdb = altEdb; mode = 'lookbehind'; }
  }

  return {
    rows: rows,
    total: detectTotal(raw),
    anchorsFound: anchors.length,
    rowsWithEdb: withEdb,
    mode: mode,
    flags: diagnoseResponse(raw)
  };
}

/* ------------------------------------------------------------------ *
 * Company profile page
 * ------------------------------------------------------------------ */

function parseProfile(html) {
  var raw = String(html == null ? '' : html);
  var L = htmlToLines(raw);
  var text = L.join('\n');
  var notes = [];

  var h1 = raw.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  var name = h1 ? stripTags(h1[1]) : '';
  if (!name) {
    var t = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    name = t ? stripTags(t[1]).split(/[|\u2013-]/)[0].trim() : '';
  }

  var edb = (text.match(/ЕДБ[^\d]{0,15}(\d{13})/i) || [])[1]
    || (text.match(/(?:^|\D)(?:МК)?(\d{13})(?:\D|$)/) || [])[1] || '';
  var embs = (text.match(/ЕМБС[^\d]{0,15}(\d{6,8})/i) || [])[1] || '';

  // NKD: "62.010 - Компјутерско програмирање". Require Cyrillic in the
  // description so we do not match a stray decimal number.
  var nkdCode = '', nkdDesc = '';
  var nkdRe = /(\d{2}\.\d{2,3})\s*[-\u2013\u2014]\s*([^\n<]{4,160})/;
  function tryNkd(s) {
    var m = String(s).match(nkdRe);
    if (m && /[А-Яа-яЀ-ѿ]/.test(m[2])) { nkdCode = m[1]; nkdDesc = m[2].trim(); return true; }
    return false;
  }
  var di = -1;
  for (var i = 0; i < L.length; i++) { if (/^дејност/.test(norm(L[i]))) { di = i; break; } }
  if (di >= 0) {
    for (var j = di; j < Math.min(L.length, di + 6); j++) { if (tryNkd(L[j])) break; }
  }
  if (!nkdCode) tryNkd(text);
  if (!nkdCode) notes.push('NKD_NOT_FOUND');

  var address = (text.match(/регистрирана\s+(?:е\s+)?на\s+([\s\S]{3,200}?)\s+и\s+работи\s+од/i) || [])[1] || '';
  address = address.replace(/\s+/g, ' ').trim();
  if (!address) address = labelValueByPrefix(L, ['Адреса', 'Седиште']);

  var dateFounded = (text.match(/работи\s+од\s+([0-9]{1,2}[.\-\/][0-9]{1,2}[.\-\/][0-9]{2,4}|[0-9]{4})\s*(?:год|година)/i) || [])[1] || '';
  if (!dateFounded) dateFounded = labelValueByPrefix(L, ['Датум на основање', 'Основана', 'Основано', 'Датум на регистрација']);

  /* --- Contacts: union of every source, then dedupe --- */
  var telHrefs = [];
  var reTel = /href\s*=\s*["']tel:([^"']+)["']/gi, mt;
  while ((mt = reTel.exec(raw)) !== null) telHrefs.push(decodeEntities(mt[1]).trim());

  var telBlock = valuesUnderLabel(
    L,
    /^(тел|тел\.|телефон|телефони|телефонски броеви|мобилен)$/,
    /^(е-пошта|е пошта|е-маил|e-?mail|факс|веб|www|адреса|дејност|контакти)/,
    isPhone, 25
  );
  var telFallback = (text.match(/Телефон(?:от)?\s+за\s+контакт\s+е\s+([+(\d][\d\s()\/\-.]{5,24})/i) || [])[1] || '';

  // Order matters: uniqBy keeps the FIRST form of each number, and the visible
  // "Контакти" block carries the human-readable formatting ("02/3221-455"),
  // whereas a tel: href is bare digits ("023221455"). Block first.
  var phones = uniqBy(
    [].concat(telBlock, telHrefs, telFallback ? [telFallback] : [])
      .map(cleanPhone)
      .filter(isPhone),
    phoneKey
  );

  var mailHrefs = [];
  var reMail = /href\s*=\s*["']mailto:([^"'?]+)/gi, mm;
  while ((mm = reMail.exec(raw)) !== null) mailHrefs.push(decodeEntities(mm[1]).trim());

  var mailBlock = valuesUnderLabel(
    L,
    /^(е-пошта|е пошта|е-маил|е маил|e-?mail|емаил|мејл)$/,
    /^(тел|телефон|факс|веб|www|адреса|дејност|контакти)/,
    isEmail, 25
  );
  var mailFallback = (text.match(/контакт[-\s]?мејл\s+е\s+([^\s;,<]+@[^\s;,<]+)/i) || [])[1] || '';

  var emails = uniqBy(
    [].concat(mailBlock, mailHrefs, mailFallback ? [mailFallback] : [])
      .map(function (e) { return e.trim().replace(/[.,;]+$/, ''); })
      .filter(isEmail),
    function (e) { return e.toLowerCase(); }
  );

  // Last resort only — a blind scan risks picking up unrelated addresses.
  if (!emails.length) {
    emails = uniqBy((text.match(EMAIL_SCAN_RE) || []).filter(isEmail),
      function (e) { return e.toLowerCase(); });
    if (emails.length) notes.push('EMAIL_VIA_BLIND_SCAN');
  }

  if (!phones.length) notes.push('NO_PHONE_FOUND');
  if (!emails.length) notes.push('NO_EMAIL_FOUND');
  if (!edb) notes.push('EDB_NOT_FOUND');

  return {
    name: name, edb: edb, embs: embs,
    nkdCode: nkdCode, nkdDesc: nkdDesc,
    address: address, dateFounded: dateFounded,
    phones: phones, emails: emails,
    notes: notes,
    flags: diagnoseResponse(raw)
  };
}

/* ------------------------------------------------------------------ *
 * /lica sub-page — owners and representatives
 * ------------------------------------------------------------------ */

var LICA_ANCHORS = ['претставник', 'сопственик'];
var LICA_WINDOW = 40; // max lines to scan after an anchor before giving up

function parseLica(html) {
  var raw = String(html == null ? '' : html);
  var L = htmlToLines(raw);

  function isAnchor(i) { return i >= 0 && i < L.length && LICA_ANCHORS.indexOf(norm(L[i])) >= 0; }

  var owners = [], managers = [];

  for (var i = 0; i < L.length; i++) {
    if (!isAnchor(i)) continue;
    var kind = norm(L[i]);
    var rec = { name: '', position: '', share: '', from: '', to: '' };
    var limit = Math.min(L.length, i + 1 + LICA_WINDOW);
    var j = i + 1;

    // First non-label line after the anchor is the name.
    while (j < limit && !isAnchor(j) && isLicaLabel(L[j])) j++;
    if (j < limit && !isAnchor(j)) { rec.name = L[j]; j++; }

    for (; j < limit && !isAnchor(j); j++) {
      // Handles both "label" / "value" on separate lines and "label value" inline.
      var lab = norm(L[j]);
      var val = (j + 1 < limit && !isAnchor(j + 1)) ? L[j + 1] : '';
      var inline = L[j].match(/^(Позиција|Функција|Вид|Сопственички удел|Удел|од|до)\s*[:\-–]?\s+(.+)$/i);
      if (inline) { lab = norm(inline[1]); val = inline[2].trim(); }

      if (lab === 'позиција' || lab === 'функција' || lab === 'вид') { rec.position = val; if (!inline) j++; }
      else if (lab === 'сопственички удел' || lab === 'удел') { rec.share = val; if (!inline) j++; }
      else if (lab === 'од') { rec.from = val; if (!inline) j++; }
      else if (lab === 'до') { rec.to = val; if (!inline) j++; }
    }

    // Percentage frequently rides along on the name line.
    var pm = rec.name.match(/\(\s*(\d{1,3}(?:[.,]\d{1,4})?)\s*%\s*\)/);
    if (pm) {
      if (!rec.share) rec.share = pm[1] + '%';
      rec.name = rec.name.replace(pm[0], '').replace(/\s{2,}/g, ' ').trim();
    }
    if (rec.share && !/%/.test(rec.share)) rec.share = rec.share.trim() + '%';

    if (!rec.name) continue;
    (kind === 'сопственик' ? owners : managers).push(rec);
  }

  return {
    owners: uniqBy(owners, function (o) { return norm(o.name) + '|' + norm(o.share) + '|' + norm(o.from); }),
    managers: uniqBy(managers, function (m) { return norm(m.name) + '|' + norm(m.position) + '|' + norm(m.from); }),
    flags: diagnoseResponse(raw)
  };
}

function isLicaLabel(s) {
  var n = norm(s);
  return n === 'позиција' || n === 'функција' || n === 'вид'
    || n === 'сопственички удел' || n === 'удел'
    || n === 'од' || n === 'до' || n === 'име' || n === 'име и презиме';
}

/* ------------------------------------------------------------------ *
 * Google Sheets row shaping
 * ------------------------------------------------------------------ */

var SHEET_HEADERS = [
  'Company Name', 'Status', 'Address', 'Tax Number (EDB)', 'Registration Number (EMBS)',
  'Employees', 'Revenue MKD', 'Phones', 'Emails', 'Owners', 'Managers',
  'NKD Code', 'NKD Description', 'Date Founded', 'Region', 'Profile URL',
  'Detail Fetched', 'Notes'
];

function fmtOwner(o) {
  return (o.name || '').trim() + (o.share ? ' (' + o.share + ')' : '');
}

function fmtManager(m) {
  var s = (m.name || '').trim();
  if (m.position) s += ' \u2014 ' + m.position;
  if (m.from) s += ' (\u043e\u0434 ' + m.from + ')';
  return s;
}

function buildSheetRow(r, sep) {
  sep = sep || '; ';
  return {
    'Company Name': r.name || '',
    'Status': r.status || '',
    'Address': r.address || '',
    'Tax Number (EDB)': r.edb || '',
    'Registration Number (EMBS)': r.embs || '',
    'Employees': (r.employees === null || r.employees === undefined) ? '' : r.employees,
    'Revenue MKD': (r.revenue === null || r.revenue === undefined) ? '' : r.revenue,
    'Phones': (r.phones || []).join(sep),
    'Emails': (r.emails || []).join(sep),
    'Owners': (r.owners || []).map(fmtOwner).join(sep),
    'Managers': (r.managers || []).map(fmtManager).join(sep),
    'NKD Code': r.nkdCode || '',
    'NKD Description': r.nkdDesc || '',
    'Date Founded': r.dateFounded || '',
    'Region': r.region || '',
    'Profile URL': r.profileUrl || '',
    'Detail Fetched': r.detailFetched ? 'yes' : '',
    'Notes': (r.notes || []).join(' | ')
  };
}

/** Dedupe across regions by ЕДБ, falling back to profile URL when ЕДБ is missing. */
function dedupeCompanies(list) {
  var byKey = Object.create(null);
  var order = [];
  (list || []).forEach(function (c) {
    var key = c.edb ? 'edb:' + c.edb : 'url:' + (c.profileUrl || '');
    if (!key || key === 'url:') return;
    if (!byKey[key]) {
      byKey[key] = Object.assign({}, c, { region: c.region || '' });
      order.push(key);
    } else {
      var prev = byKey[key];
      var regions = String(prev.region || '').split(/\s*\+\s*/).filter(Boolean);
      if (c.region && regions.indexOf(c.region) < 0) regions.push(c.region);
      prev.region = regions.join(' + ');
      // Keep the richer record field-by-field.
      ['name', 'status', 'address', 'edb', 'embs'].forEach(function (f) {
        if (!prev[f] && c[f]) prev[f] = c[f];
      });
      if (prev.employees == null && c.employees != null) prev.employees = c.employees;
      if (prev.revenue == null && c.revenue != null) prev.revenue = c.revenue;
    }
  });
  return order.map(function (k) { return byKey[k]; });
}

// #endregion injectable

export {
  CW_BASE,
  decodeEntities, stripTags, htmlToLines, norm, digitsOnly, escapeRe, uniqBy,
  mkNumber, firstInt,
  isEmail, isPhone, phoneKey, cleanPhone, STATUS_RE,
  labelValue, labelValueByPrefix, valuesUnderLabel,
  buildSearchUrl, diagnoseResponse, isBlockingFlag,
  findProfileAnchors, isProfilePath, extractRowFields, detectTotal, parseSearchResults,
  parseProfile, parseLica, isLicaLabel,
  SHEET_HEADERS, fmtOwner, fmtManager, buildSheetRow, dedupeCompanies
};

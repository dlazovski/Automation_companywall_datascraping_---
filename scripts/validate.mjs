/**
 * Structural validation of the generated workflows.
 *
 *   npm run validate
 *
 * Catches the mistakes that are otherwise only discoverable by importing into
 * n8n and clicking Execute: JS syntax errors inside Code nodes, expressions
 * referencing a node that does not exist or was renamed, dangling connections,
 * and orphaned nodes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'workflows');

let problems = 0;
const fail = (wf, msg) => { problems++; console.log(`  ✗ [${wf}] ${msg}`); };

const CODE_TYPE = 'n8n-nodes-base.code';
const NON_EXEC = new Set(['n8n-nodes-base.stickyNote']);

for (const file of readdirSync(DIR).filter(f => f.endsWith('.json'))) {
  let wf;
  try {
    wf = JSON.parse(readFileSync(resolve(DIR, file), 'utf8'));
  } catch (e) {
    fail(file, `not valid JSON: ${e.message}`);
    continue;
  }

  const names = new Set(wf.nodes.map(n => n.name));
  console.log(`\n${file} — ${wf.nodes.length} nodes`);

  // Duplicate node names break $('Node Name') lookups.
  const seen = new Set();
  for (const n of wf.nodes) {
    if (seen.has(n.name)) fail(file, `duplicate node name: "${n.name}"`);
    seen.add(n.name);
  }

  // Every Code node must be syntactically valid JavaScript.
  for (const n of wf.nodes.filter(n => n.type === CODE_TYPE)) {
    try {
      new Function(n.parameters.jsCode);
    } catch (e) {
      fail(file, `Code node "${n.name}" has a JS syntax error: ${e.message}`);
    }
  }

  // Every $('X') reference — in code and in expressions — must resolve.
  const refRe = /\$\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const n of wf.nodes) {
    const blob = JSON.stringify(n.parameters || {});
    let m;
    while ((m = refRe.exec(blob)) !== null) {
      if (!names.has(m[1])) fail(file, `node "${n.name}" references missing node $('${m[1]}')`);
    }
  }

  // Connections must point at real nodes.
  const targeted = new Set();
  for (const [from, conn] of Object.entries(wf.connections || {})) {
    if (!names.has(from)) fail(file, `connection source "${from}" is not a node`);
    for (const branch of conn.main || []) {
      for (const edge of branch || []) {
        if (!names.has(edge.node)) fail(file, `"${from}" connects to missing node "${edge.node}"`);
        targeted.add(edge.node);
      }
    }
  }

  // Anything that is neither a trigger, a sticky, nor a connection target is dead.
  for (const n of wf.nodes) {
    if (NON_EXEC.has(n.type)) continue;
    if (/trigger/i.test(n.type)) continue;
    if (!targeted.has(n.name)) fail(file, `node "${n.name}" is never reached`);
  }

  // Credentials must be flagged for the user to fill in, not silently blank.
  for (const n of wf.nodes) {
    for (const [type, cred] of Object.entries(n.credentials || {})) {
      if (!String(cred.id || '').startsWith('REPLACE_WITH')) {
        fail(file, `node "${n.name}" has a non-placeholder ${type} credential id — do not commit real ids`);
      }
    }
  }

  const codeCount = wf.nodes.filter(n => n.type === CODE_TYPE).length;
  const httpCount = wf.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest').length;
  const waitCount = wf.nodes.filter(n => n.type === 'n8n-nodes-base.wait').length;
  console.log(`  ${codeCount} code, ${httpCount} http, ${waitCount} wait`);

  // Every ScrapingBee call must be preceded by a Wait — the site asks for it.
  const waitNames = new Set(wf.nodes.filter(n => n.type === 'n8n-nodes-base.wait').map(n => n.name));
  for (const http of wf.nodes.filter(n => n.type === 'n8n-nodes-base.httpRequest')) {
    const feeders = Object.entries(wf.connections || {})
      .filter(([, c]) => (c.main || []).some(b => (b || []).some(e => e.node === http.name)))
      .map(([from]) => from);
    if (!feeders.some(f => waitNames.has(f))) {
      fail(file, `HTTP node "${http.name}" is not preceded by a Wait node (rate-limit requirement)`);
    }
    const url = http.parameters?.url || '';
    if (!String(url).includes('scrapingbee.com')) {
      fail(file, `HTTP node "${http.name}" does not go through ScrapingBee (url: ${url})`);
    }
  }
}

console.log(problems ? `\n${problems} problem(s) found` : '\nAll workflows valid');
process.exit(problems ? 1 : 0);

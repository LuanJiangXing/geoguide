// Guards the "every approval write site stamps first_approved_at" rule — run with:
//   node scripts/test-approval-sites.js
//
// LIVES IN scripts/ ON PURPOSE — do not move it back under api/. Vercel's zero-config Node
// detection turns EVERY top-level .js in api/ into a serverless function, and the Hobby plan
// refuses any deployment with more than 12 of them. This file and test-submissions-order.js
// spent a day in api/ and, by taking the count from 12 to 14, silently failed every production
// deploy from 2026-09-19 until they were moved — the build itself succeeded, so the failure
// showed up only as "Deploying outputs... Error". Test files do not belong in api/.
//
// `first_approved_at` is the column the homepage's "Recent Updates" sorts by, and it only works
// because it is written at EVERY site that moves a submission into 'approved'. A new approval
// path (or an edited one) that forgets it does not throw, does not log, and is invisible in
// review — the affected regions just sort by the fallback `reviewed_at` and jump back to the top
// of the homepage the next time their owner resubmits them. That is the failure this file exists
// to make loud.
//
// Three layers, because each one alone can be fooled:
//
//   1. STRUCTURAL — every static approval statement mentions first_approved_at. Collected by
//      scanning the source, so a newly added statement is covered the moment it lands.
//   2. EXECUTABLE — each statement is prepared and run against a real local SQLite (through
//      @libsql/client) with the right number of dummy parameters. This catches the two silent
//      killers layer 1 cannot see: a placeholder/argument-count mismatch, and a misspelled
//      column name (SQLite resolves names at prepare time, even on an empty table).
//   3. SELF-CONSISTENCY — the number of statements the extractor found must equal the number the
//      source actually contains. An extractor that silently misses a statement makes layers 1
//      and 2 pass while checking nothing, so the extractor is itself under test.
//
// Why the source needs a comment-stripper before any quote-matching (this bit me while writing
// it): an apostrophe in prose — "the user's redrawn polygon" — pairs with the next quote in the
// file and shifts every literal after it. Without stripping, this file collected 2 of the 7
// statements and reported green on both. Contractions are load-bearing.
//
// Statements built at runtime (a setClauses array in submit.js, a concatenated statusSql in
// review.js) cannot be collected this way and are asserted by their fragments at the end.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createClient } = require('@libsql/client');

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ok   — ' + label); }
  else { failed++; console.log('  FAIL — ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

const FILES = ['submit.js', 'review.js'].map((f) => path.join(__dirname, '..', 'api', f));
const SOURCES = FILES.map((f) => fs.readFileSync(f, 'utf8'));

// Newlines inside comments are preserved, so stripped line numbers still match the real file.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// {text, line, start, end} for every string literal in a comment-free source. The span is what
// the self-check below needs: it asks whether a raw piece of SQL text falls INSIDE a literal we
// captured, which is the only way to tell a complete extraction from a partial one.
function literals(src) {
  const clean = stripComments(src);
  const out = [];
  const re = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    out.push({
      text: m[0].slice(1, -1),
      line: clean.slice(0, m.index).split('\n').length,
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return out;
}

const isApprovalUpdate = (s) => /UPDATE submissions SET[\s\S]*?status = 'approved'/.test(s);
const isApprovalInsert = (s) => /INSERT INTO submissions[\s\S]*?'approved'/.test(s);

async function main() {
  const dbfile = path.join(os.tmpdir(), 'gg-approval-' + process.pid + '.db');
  const db = createClient({ url: 'file:' + dbfile });
  await db.execute('DROP TABLE IF EXISTS submissions');
  await db.execute(`CREATE TABLE submissions (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, detailed_description TEXT, tags TEXT,
    geojson TEXT, streetview TEXT, link TEXT, country_id TEXT, user_id TEXT, status TEXT,
    created_at TEXT, reviewed_at TEXT, first_approved_at TEXT, source_type TEXT, source_url TEXT,
    is_hidden INTEGER DEFAULT 0, edited_at TEXT, edit_target_id TEXT, is_deleted INTEGER DEFAULT 0,
    scope TEXT DEFAULT 'region')`);

  // Every occurrence, no dedup: two sites can hold byte-identical SQL, and collapsing them would
  // hide the fact that only one of them is actually being checked.
  const sites = [];
  SOURCES.forEach((src, fi) => {
    literals(src).forEach(({ text, line }) => {
      if (isApprovalUpdate(text) || isApprovalInsert(text)) {
        sites.push({ file: path.basename(FILES[fi]), line, sql: text.trim(), kind: isApprovalInsert(text) ? 'INSERT' : 'UPDATE' });
      }
    });
  });

  console.log('approval write sites (' + sites.length + ' static):');
  for (const site of sites) {
    const at = site.file + ':' + site.line;
    ok(site.sql.indexOf('first_approved_at') !== -1, at + ' — 带 first_approved_at');
    ok(site.kind === 'INSERT' ? /INSERT INTO submissions[\s\S]*first_approved_at[\s\S]*VALUES/.test(site.sql)
                              : site.sql.indexOf('COALESCE(first_approved_at') !== -1,
      at + ' — 写入是"只设一次"的语义（UPDATE 用 COALESCE）');
    const holes = (site.sql.match(/\?/g) || []).length;
    let err = null;
    try { await db.execute({ sql: site.sql, args: new Array(holes).fill('x') }); }
    catch (e) { err = e.message; }
    ok(err === null, at + ` — 真实 SQLite 可执行（${holes} 个占位符，列名与语法均有效）`, err);
  }

  // Layer 3: the extractor itself. Collecting statements is only meaningful if the extraction is
  // complete, and the way it fails is silent: drop one literal and the statements after it are
  // never visited, so every assertion above still passes. So: every place the raw SQL text starts
  // in the source must fall inside a literal we actually captured. One that doesn't means the
  // pairing got shifted and we are checking a subset.
  console.log('extractor self-check:');
  for (let fi = 0; fi < SOURCES.length; fi++) {
    const clean = stripComments(SOURCES[fi]);
    const spans = literals(SOURCES[fi]);
    const name = path.basename(FILES[fi]);
    for (const needle of ['UPDATE submissions SET', 'INSERT INTO submissions']) {
      let idx = -1, total = 0, uncovered = 0;
      while ((idx = clean.indexOf(needle, idx + 1)) !== -1) {
        total++;
        if (!spans.some((sp) => idx >= sp.start && idx < sp.end)) uncovered++;
      }
      if (total) {
        ok(uncovered === 0, name + ' — ' + total + ' 处 "' + needle + '" 全部落在已提取的字面量内（漏检会露出来）',
          uncovered ? { uncovered } : undefined);
      }
    }
  }

  console.log('dynamic sites (运行时拼接，无法用字面量收集):');
  ok(SOURCES[0].indexOf("setClauses.push('first_approved_at = COALESCE(first_approved_at, ?)')") !== -1,
    'api/submit.js 的 PATCH setClauses 分支带上了它');
  ok(SOURCES[1].indexOf("statusSql += ', is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?)'") !== -1,
    'api/review.js 的 statusSql 分支带上了它');

  await db.close();
  fs.rmSync(dbfile, { force: true });
  console.log(failed ? ('\n== FAILURES: ' + failed) : '\n== ALL PASS (' + passed + ')');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

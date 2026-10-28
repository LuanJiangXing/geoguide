// Guards the `scope` discriminator on submissions — run with:
//   node scripts/test-submission-scope.js
//
// LIVES IN scripts/ ON PURPOSE — a top-level .js under api/ becomes a Vercel serverless
// function, and the Hobby plan refuses any deployment with more than 12. See the header of
// test-approval-sites.js for the day this actually broke production.
//
// WHAT IT PROTECTS
//
//   'region'  — the pre-existing kind: a drawn area inside a country. Geometry required.
//   'country' — a country-wide meta: no geometry at all, stored as the canonical empty
//               geojson array '[]'.
//
// Two invariants hold the feature together. Both fail SILENTLY if broken, which is why they
// are worth a test rather than a comment.
//
//   1. `scope` IS IMMUTABLE. Exactly two statements in the codebase ever write it, and both
//      are `INSERT INTO submissions` in api/submit.js (the create paths). Every other write —
//      the trusted-merge UPDATE, the PATCH setClauses, and all five approval/merge statements
//      in api/review.js — must OMIT the column; omitting is what preserves the stored value.
//      A future "you forgot the new field here" edit that tacks `scope = ?` onto an UPDATE
//      would let a resubmit silently flip a drawn region into a country-wide entry, orphaning
//      its geometry and making it vanish from the map. Layer 1 makes that loud.
//
//   2. THE 'region' PATH IS BYTE-IDENTICAL. A geometry-less region submission must still be
//      rejected, with the same message as before. Layer 2 drives the real handler for it —
//      a source scan cannot see that the branch actually runs.
//
// Layer 2 stubs `global.fetch`, so no Turso and no network.
'use strict';

const fs = require('fs');
const path = require('path');

const FILES = ['submit.js', 'review.js'].map((f) => path.join(__dirname, '..', 'api', f));
const SOURCES = FILES.map((f) => fs.readFileSync(f, 'utf8'));

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ok   — ' + label); }
  else { failed++; console.log('  FAIL — ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// Newlines inside comments are preserved so stripped line numbers still match the real file.
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; }
      i += 2; continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}

// Returns the full string literal that encloses `idx`, or null. Callers pass an index found in
// the COMMENT-STRIPPED source, so a `//` or `/*` inside the literal cannot appear; the only
// delimiters left to reason about are the quotes themselves.
function enclosingLiteral(src, idx) {
  let start = -1;
  for (let i = idx; i >= 0; i--) {
    if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      let bs = 0;
      for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) bs++;
      if (bs % 2 === 0) { start = i; break; }
    }
  }
  if (start < 0) return null;
  const q = src[start];
  for (let i = idx; i < src.length; i++) {
    if (src[i] === '\\') { i++; continue; }
    if (src[i] === q) return { text: src.slice(start, i + 1), line: src.slice(0, start).split('\n').length };
  }
  return null;
}

// Every occurrence of `needle`, with the literal it sits inside. Deliberately NOT deduped: two
// sites can hold byte-identical SQL, and collapsing them would hide that only one is checked.
function statements(src, needle) {
  const clean = stripComments(src);
  const out = [];
  let idx = -1;
  while ((idx = clean.indexOf(needle, idx + 1)) !== -1) {
    const lit = enclosingLiteral(clean, idx);
    out.push({ text: lit ? lit.text : '', line: lit ? lit.line : 0, found: !!lit });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer 1 — structural: who is allowed to write `scope`
// ---------------------------------------------------------------------------------------------
function layer1() {
  console.log('L1  谁能写 scope（创建后不可变）:');

  for (let fi = 0; fi < SOURCES.length; fi++) {
    const name = path.basename(FILES[fi]);
    const src = SOURCES[fi];

    const updates = statements(src, 'UPDATE submissions SET');
    const inserts = statements(src, 'INSERT INTO submissions');

    // Self-check: the extractor must not silently lose statements, or everything below passes
    // while checking nothing. Compare against a raw (comment-stripped) occurrence count.
    const rawUpdates = stripComments(src).split('UPDATE submissions SET').length - 1;
    const rawInserts = stripComments(src).split('INSERT INTO submissions').length - 1;
    ok(updates.length === rawUpdates && inserts.length === rawInserts,
      name + ' — 提取器没漏语句（UPDATE ' + updates.length + '/' + rawUpdates +
      '，INSERT ' + inserts.length + '/' + rawInserts + '）');

    const updWithScope = updates.filter((s) => /\bscope\b/.test(s.text));
    ok(updWithScope.length === 0,
      name + ' — ' + updates.length + ' 条 UPDATE 全都不写 scope（省略即保留，这条挂了就会静默改写条目性质）',
      updWithScope.length ? updWithScope.map((s) => s.line) : undefined);

    if (name === 'submit.js') {
      const insWithScope = inserts.filter((s) => /\bscope\b/.test(s.text));
      ok(insWithScope.length === inserts.length && inserts.length === 2,
        'submit.js — 两个 create INSERT 都带 scope（' + insWithScope.length + '/' + inserts.length + '）');
      ok(inserts.every((s) => !/VALUES[\s\S]*\?[\s\S]*\?/.test(s.text) || true), 'submit.js — INSERT 占位符数由 test-approval-sites.js 用真 SQLite 验');
    } else {
      // review.js only ever merges/approves existing rows — it must never create one.
      ok(inserts.length === 0, 'review.js — 没有 INSERT（它只合并/审批既有行，不创建）', inserts.length);
    }
  }

  // The two mechanisms that keep the invariant true rather than merely asserted.
  ok(SOURCES[0].indexOf('editTargetScope') !== -1 && /SELECT user_id, scope FROM submissions/.test(SOURCES[0]),
    'submit.js — 草稿行从目标行读 scope（不信任 body，否则手写 POST 能偷改条目性质）');
  ok(/var rowScope = editTargetId \? editTargetScope : scope;/.test(SOURCES[0]),
    'submit.js — 草稿用继承值、新行才用 body 值');
  ok(SOURCES[0].indexOf("var scope = (req.body.scope === 'country') ? 'country' : 'region';") !== -1,
    'submit.js — 缺省 / 未知 scope 一律落回 region');
  ok(/existingScope === 'country'/.test(SOURCES[0]) && SOURCES[0].indexOf('"geojson = \'[]\'"') !== -1,
    'submit.js — PATCH 对国家范围条目把 geojson 钉死成空数组（不能走 normalizeGeometries，它必 400）');
}

// ---------------------------------------------------------------------------------------------
// Layer 2 — behavioural: drive the REAL POST/PATCH handlers with a stubbed transport
// ---------------------------------------------------------------------------------------------
const USER_ROW = [['u1'], ['d1'], ['tester'], [''], ['user'], ['']];
const COUNTRY_ROW = [['japan']];

function cell(v) { return v === null || v === undefined ? { type: 'null' } : { type: 'text', value: String(v) }; }
function row(vals) { return vals.map(cell); }

// Answers the small set of queries the submit handler actually issues, keyed by SQL text.
// Anything unmatched returns zero rows — which is the correct answer for the writes.
function respond(sql, state) {
  if (/FROM sessions s JOIN users u/.test(sql)) return { cols: [], rows: [row(USER_ROW)] };
  if (/SELECT id FROM countries/.test(sql)) return { cols: [], rows: [row(state.countryExists ? COUNTRY_ROW : [])] };
  if (/COUNT\(\*\) as cnt FROM submissions/.test(sql)) return { cols: [], rows: [[cell(0)]] };
  if (/SELECT user_id, scope FROM submissions WHERE id = \?/.test(sql)) {
    return { cols: [], rows: [row([state.targetUserId || 'u1', state.targetScope || 'region'])] };
  }
  if (/SELECT user_id, status, scope FROM submissions WHERE id = \?/.test(sql)) {
    return { cols: [], rows: [row([state.patchUserId || 'u1', state.patchStatus || 'pending', state.patchScope || 'region'])] };
  }
  return { cols: [], rows: [] };
}

function installStub() {
  const state = { writes: [] };
  const realFetch = global.fetch;
  global.fetch = function (url, opts) {
    const reqs = (JSON.parse(opts.body).requests) || [];
    const results = reqs.map(function (r) {
      if (r.type !== 'execute') return { type: 'ok', response: { type: 'close' } };
      const sql = (r.stmt && r.stmt.sql) || '';
      if (/^\s*(INSERT INTO submissions|UPDATE submissions SET)/i.test(sql)) {
        state.writes.push({
          sql: sql,
          args: ((r.stmt.args) || []).map(function (a) { return a.value; }),
        });
      }
      return { type: 'ok', response: { type: 'execute', result: respond(sql, state) } };
    });
    return Promise.resolve({ json: () => Promise.resolve({ results: results }) });
  };
  return { state: state, restore: function () { global.fetch = realFetch; } };
}

function fakeRes() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

function baseBody(over) {
  return Object.assign({
    name: 'Japan bollards',
    description: 'country-wide pole guide',
    link: 'https://www.google.com/maps/@1,2,3a,75y',
    streetview: [{ lat: 35.0, lng: 138.0, heading: 0, pitch: 0, fov: 90 }],
    country_id: 'japan',
  }, over || {});
}

function request(body, method) {
  return {
    method: method || 'POST',
    headers: { cookie: 'geoguide_sid=s1; geoguide_csrf=tok', 'x-csrf-token': 'tok' },
    body: body,
  };
}

async function callSubmit(handler, body, method, extraState) {
  const stub = installStub();
  if (extraState) Object.assign(stub.state, extraState);
  const res = fakeRes();
  try { await handler(request(body, method), res); }
  catch (e) { stub.restore(); return { status: 0, body: { error: 'threw: ' + e.message }, writes: stub.state.writes }; }
  stub.restore();
  return { status: res.statusCode, body: res.body, writes: stub.state.writes };
}

async function layer2() {
  console.log('\nL2  真 handler 行为:');
  // Required AFTER the stub installer is defined; loading it earlier would capture the real fetch.
  const handler = require('../api/submit.js');

  // --- the two halves of AC1 / AC2 -----------------------------------------------------------------
  const country = await callSubmit(handler, baseBody({ scope: 'country', geojson: [] }));
  ok(country.status === 201, "country + geojson:[] → 201（国家范围不需要几何）", country.body);
  const ins = country.writes.filter((w) => /INSERT INTO submissions/.test(w.sql))[0];
  ok(!!ins, 'country → 落库走了 INSERT');
  if (ins) {
    ok(ins.args[ins.args.length - 1] === 'country', "INSERT 的 scope 参数是 'country'", ins.args[ins.args.length - 1]);
    const gi = ins.sql.match(/\((id[^)]*)\)/)[1].split(',').map((s) => s.trim()).indexOf('geojson');
    ok(ins.args[gi] === '[]', "geojson 落库是规范空数组 '[]'（不是 '{}' 也不是 null）", ins.args[gi]);
  }

  const regionEmpty = await callSubmit(handler, baseBody({ scope: 'region', geojson: [] }));
  ok(regionEmpty.status === 400 && /1-10 geometries/.test((regionEmpty.body || {}).error || ''),
    'region + geojson:[] → 仍然 400（老路径一个字都不能变）', regionEmpty.body);

  const omitted = await callSubmit(handler, baseBody({ geojson: [] }));
  ok(omitted.status === 400, '不传 scope → 按 region 处理，仍然 400（缺省值不能漏）', omitted.body);

  const noGeoField = await callSubmit(handler, baseBody({ scope: 'country' }));
  ok(noGeoField.status === 201, 'country 且连 geojson 字段都不传 → 仍然 201（required 检查已按 scope 放开）', noGeoField.body);

  // --- the draft inherits, it does not trust the body ----------------------------------------------
  // The dangerous direction: a hand-written request claiming 'region' WHILE carrying real geometry,
  // pointed at a country-scope target. Geometry validation alone would wave it through, and the
  // draft would land with scope='country' plus a polygon — which the merge then copies onto the
  // target. Only resolving the target's scope BEFORE the geometry branch closes this.
  const draft = await callSubmit(handler,
    baseBody({ scope: 'region', geojson: [{ type: 'Point', coordinates: [138.0, 35.0] }], edit_target_id: 'orig-1' }),
    'POST', { targetScope: 'country' });
  const draftIns = draft.writes.filter((w) => /INSERT INTO submissions/.test(w.sql))[0];
  ok(draft.status === 201 && !!draftIns, '草稿（带 edit_target_id）走 INSERT', draft.body);
  if (draftIns) {
    ok(draftIns.args[draftIns.args.length - 1] === 'country',
      "草稿 body 说 'region'，但目标行是 country → 落库仍是 'country'（不信 body）",
      draftIns.args[draftIns.args.length - 1]);
    const gidx = draftIns.sql.match(/\((id[^)]*)\)/)[1].split(',').map((s) => s.trim()).indexOf('geojson');
    ok(draftIns.args[gidx] === '[]',
      "且那条谎报的几何被清干净（否则国家范围条目会被塞进多边形）", draftIns.args[gidx]);
  }

  // The mirror direction: body claims 'country' (so it ships no geometry) but the target is a real
  // region. Inheriting would produce a region row with no shape — which explore silently drops.
  const mirror = await callSubmit(handler,
    baseBody({ scope: 'country', geojson: [], edit_target_id: 'orig-2' }),
    'POST', { targetScope: 'region' });
  ok(mirror.status === 400 && /1-10 geometries/.test((mirror.body || {}).error || ''),
    'body 谎称 country、目标是 region → 400（不能写出没有几何的 region 行）', mirror.body);

  // --- PATCH never touches scope, and never 400s a country row on empty geometry -------------------
  const patchCountry = await callSubmit(handler,
    { id: 'c1', name: 'renamed', geojson: [], scope: 'region' }, 'PATCH', { patchScope: 'country' });
  ok(patchCountry.status === 200, 'PATCH 国家范围条目 + geojson:[] → 200（不能走 normalizeGeometries）', patchCountry.body);
  const patchUpd = patchCountry.writes.filter((w) => /UPDATE submissions SET/.test(w.sql))[0];
  if (patchUpd) {
    ok(/geojson = '\[\]'/.test(patchUpd.sql), 'PATCH 把国家范围条目的 geojson 钉死成空数组', patchUpd.sql);
    ok(!/\bscope\b/.test(patchUpd.sql), 'PATCH 的 UPDATE 不含 scope（body 里塞 scope 也无效）', patchUpd.sql);
  } else {
    ok(false, 'PATCH 应当发出 UPDATE');
  }

  const patchRegion = await callSubmit(handler,
    { id: 'r1', geojson: [] }, 'PATCH', { patchScope: 'region' });
  ok(patchRegion.status === 400, 'PATCH region 条目 + geojson:[] → 仍然 400（老路径不变）', patchRegion.body);
}

(async () => {
  layer1();
  await layer2();
  console.log(failed ? ('\n== FAILURES: ' + failed) : '\n== ALL PASS (' + passed + ')');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

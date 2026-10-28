// Unit tests for the ORDER BY switch in api/submissions.js — run directly with:
//   node scripts/test-submissions-order.js
//
// LIVES IN scripts/ ON PURPOSE — see the header of test-approval-sites.js: a top-level .js under
// api/ becomes a Vercel serverless function, and the Hobby plan caps a deployment at 12. Sitting
// in api/ alongside its sibling, this file helped push the count to 14 and broke every production
// deploy in the process.
//
// Stubs `global.fetch` so the REAL handler builds its REAL SQL; no Turso, no network.
// We assert on the statement that would be sent, because the thing being protected here is a
// contract between two consumers of one endpoint:
//
//   - the homepage asks for ?order=approved (sort by first approval, resubmit-proof)
//   - explore asks for nothing, and must keep getting the byte-identical legacy ORDER BY,
//     because it feeds the returned array to renderRegions() — polygon creation order.
//
// RED CHECK (verified): pointing the no-param branch at the new clause turns 断言 1 red.
// That is the whole point of the test — a change that helps the homepage must not quietly
// reach through to explore.
'use strict';

const handler = require('../api/submissions.js');

const ORDER_CREATED = ' ORDER BY s.created_at DESC';
const ORDER_APPROVED = " ORDER BY COALESCE(NULLIF(s.first_approved_at, ''), NULLIF(s.reviewed_at, ''), s.created_at) DESC";

let passed = 0, failed = 0;
function ok(cond, label, extra) {
  if (cond) { passed++; console.log('  ok   — ' + label); }
  else { failed++; console.log('  FAIL — ' + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); }
}

// --- fake Turso -----------------------------------------------------------------------------
let sent = [];
const realFetch = global.fetch;
global.fetch = function (url, opts) {
  const reqs = (JSON.parse(opts.body).requests) || [];
  reqs.forEach(function (r) { if (r.type === 'execute') sent.push(r.stmt.sql); });
  return Promise.resolve({
    json: () => Promise.resolve({
      results: reqs.map(() => ({ type: 'ok', response: { type: 'execute', result: { cols: [], rows: [] } } })),
    }),
  });
};

function fakeRes() {
  const r = { statusCode: 0, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}

async function listSql(query) {
  sent = [];
  const res = fakeRes();
  await handler({ method: 'GET', query: query }, res);
  const sql = sent.filter((s) => s.indexOf('FROM submissions s') !== -1).pop() || '';
  const ob = sql.indexOf(' ORDER BY') === -1 ? '' : sql.slice(sql.indexOf(' ORDER BY'));
  return { status: res.statusCode, sql, ob, list: res.body };
}

async function main() {
  console.log('api/submissions ORDER BY:');
  global.__firstCall = true;   // ensureSchema runs once; keep it out of the assertions below

  const plain = await listSql({});
  ok(plain.status === 200, '不带参数：请求成功', plain.status);
  ok(plain.ob === ORDER_CREATED, '不带参数：ORDER BY 与改动前逐字节相同（explore 走这条）', plain.ob);

  const others = await listSql({ order: 'created' });
  ok(others.ob === ORDER_CREATED, "order=created 走旧子句（只有 'approved' 才切换）", others.ob);

  const approved = await listSql({ order: 'approved' });
  ok(approved.status === 200, 'order=approved：请求成功', approved.status);
  ok(approved.ob === ORDER_APPROVED, 'order=approved：用了首次通过时间的兜底链', approved.ob);

  ok(plain.sql.indexOf('s.first_approved_at') !== -1, '两种查询都返回 first_approved_at 字段');
  ok(Array.isArray(plain.list) && plain.list.length === 0, '返回体仍是数组', typeof plain.list);

  // 参数不能只是"看起来对"——它必须真的落在 SQL 里，而不是被当作别的东西吃掉
  ok(approved.sql.split('ORDER BY').length === 2, '只有一处 ORDER BY（没有拼接出两条排序）',
    approved.sql.split('ORDER BY').length - 1);

  global.fetch = realFetch;
  console.log(failed ? ('\n== FAILURES: ' + failed) : '\n== ALL PASS (' + passed + ')');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { global.fetch = realFetch; console.error(e); process.exit(1); });

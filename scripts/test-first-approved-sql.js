// Locks down the SQL semantics behind `first_approved_at` — the column that makes
// "Recent Updates" sort by FIRST approval while resubmits leave it alone.
//
// Why a real database instead of a string assertion: the whole behaviour is one expression,
// `first_approved_at = COALESCE(first_approved_at, ?)`, and what matters is that SQLite
// actually leaves an existing value alone. A test that greps for the text would pass just as
// happily against `first_approved_at = ?`, which is the bug this guards.
//
// `@libsql/client` can open a local file DB, so this touches real SQLite, no Turso, no network.
// Run: node scripts/test-first-approved-sql.js
//
// RED CHECK (verified): replacing the expression with plain `first_approved_at = ?` in
// WRITE_SQL below turns 断言 1 and 断言 3 red. Everything else stays green — that is the point:
// only the "never overwrite" assertions can see the difference.
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

// The exact SET fragment the API uses at every one of its nine approval write sites.
// Update this line and the API together or not at all.
const WRITE_SQL = "UPDATE submissions SET first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?";
const ORDER_BY = " ORDER BY COALESCE(NULLIF(s.first_approved_at, ''), NULLIF(s.reviewed_at, ''), s.created_at) DESC";

async function main() {
  const file = path.join(os.tmpdir(), 'geoguide-first-approved-' + process.pid + '.db');
  const db = createClient({ url: 'file:' + file });
  await db.execute('DROP TABLE IF EXISTS submissions');
  await db.execute('CREATE TABLE submissions (id TEXT PRIMARY KEY, status TEXT, created_at TEXT, reviewed_at TEXT, first_approved_at TEXT)');

  const write = (id, now) => db.execute(WRITE_SQL, [now, id]);
  const read = async (id) => (await db.execute('SELECT first_approved_at FROM submissions WHERE id = ?', [id])).rows[0].first_approved_at;

  console.log('first_approved_at:');

  // 断言 1 — 二次通过不得覆盖
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at) VALUES ('a', 'approved', '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z')");
  await write('a', '2026-07-02T00:00:00.000Z');
  ok(await read('a') === '2026-07-02T00:00:00.000Z', '第一次通过时写入');
  await write('a', '2026-09-01T00:00:00.000Z');
  ok(await read('a') === '2026-07-02T00:00:00.000Z', 'resubmit 再次通过时不覆盖（仍是首次的时间）', await read('a'));

  // 断言 2 — 空值行首次通过
  await db.execute("INSERT INTO submissions (id, status, created_at) VALUES ('b', 'pending', '2026-08-01T00:00:00.000Z')");
  ok(await read('b') === null, '未通过的行是空的');
  await write('b', '2026-08-05T00:00:00.000Z');
  ok(await read('b') === '2026-08-05T00:00:00.000Z', '第一次通过时写入值', await read('b'));

  // 断言 3 — approved → rejected → approved 仍是第一次
  await db.execute("UPDATE submissions SET status = 'rejected' WHERE id = 'a'");
  await write('a', '2026-10-01T00:00:00.000Z');
  ok(await read('a') === '2026-07-02T00:00:00.000Z', '驳回后重新通过，仍是首次的时间', await read('a'));

  // 断言 4 — 兜底排序链
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at, first_approved_at) VALUES ('c', 'approved', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')");
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at, first_approved_at) VALUES ('d', 'approved', '2026-01-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', NULL)");
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at, first_approved_at) VALUES ('e', 'approved', '2026-03-01T00:00:00.000Z', '', '')");
  const listed = (await db.execute('SELECT s.id FROM submissions s' + ORDER_BY)).rows.map((r) => r.id);
  // c=6月,b(8月)=… 先只看这三个的相互顺序:e 用 created_at(3月),d 用 reviewed_at(5月),c 用 6月
  ok(JSON.stringify(listed.slice(listed.indexOf('c'), listed.indexOf('e') + 1)) === JSON.stringify(['c', 'd', 'e']),
    '排序链：有 first_approved_at 的用它，空值退回 reviewed_at，两者都空退回 created_at', listed);
  ok(listed.indexOf('b') === 0, '有值的行按各自时间排在最前，不会被空值行挤掉', listed);

  // 断言 5 — 回填可以重复跑。SQL 取自被跟踪的 api/_lib/firstApproved.js（回填脚本自己也是
  // require 它），不是在这里另抄一份 —— scripts/backfill-*.js 按约定不进仓库，测试不能依赖它。
  const { BACKFILL_SQL, BACKFILL_WHERE } = require('../api/_lib/firstApproved.js');
  console.log('backfill 幂等性:');
  await db.execute("DELETE FROM submissions");
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at, first_approved_at) VALUES ('f', 'approved', '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', NULL)");
  await db.execute("INSERT INTO submissions (id, status, created_at, reviewed_at, first_approved_at) VALUES ('g', 'approved', '2026-01-01T00:00:00.000Z', NULL, NULL)");
  await db.execute(BACKFILL_SQL);
  ok(await read('f') === '2026-06-01T00:00:00.000Z', '回填把 reviewed_at 写进空列');
  ok(await read('g') === null, 'reviewed_at 为空的行不回填（留给兜底链，不写一个已知是错的值）');
  await db.execute("UPDATE submissions SET reviewed_at = '2026-12-01T00:00:00.000Z' WHERE id = 'f'");
  await db.execute(BACKFILL_SQL);
  ok(await read('f') === '2026-06-01T00:00:00.000Z', '第二次执行不覆盖已冻结的值（回填可重复跑）', await read('f'));
  ok(BACKFILL_WHERE.indexOf('first_approved_at IS NULL') !== -1,
    '子句来自被跟踪的 api/_lib/firstApproved.js（回填脚本与测试共用同一份）');

  await db.close();
  fs.rmSync(file, { force: true });

  console.log(failed ? ('\n== FAILURES: ' + failed) : '\n== ALL PASS (' + passed + ')');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });

// Contract + UI harness for the submission JSON export (my-submissions "Download").
//
// Why this script is shaped differently from its neighbours.
//
//   Every other script in scripts/ drives a running server through Playwright with
//   `page.route` mocks. That approach CANNOT test this feature: the whole point of
//   the export is the 13-key projection the *server* builds, and a mocked
//   `/api/user-submissions?action=export` would hand back whatever fixture we wrote
//   — the real `buildExportSubmission` would never run. The test would pass against
//   an empty handler.
//
//   So this script has two halves:
//
//     Part A — in-process. Load the REAL api/user-submissions.js, with only the
//       network-touching pieces of _lib/turso.js stubbed (tursoFetch / ensureSchema
//       / getSessionUser). safeJson / normalizeStreetview / normalizeLink stay
//       real, because the projection depends on them. The stub emulates the one
//       semantic this feature turns on — `is_deleted = 0` — by READING THE SQL
//       STRING, so deleting that clause from the source turns the Trash assertion
//       red instead of silently passing.
//
//     Part B — Playwright. The button's presence per tab, its computed style, the
//       download-options MENU (geometry / clipping / keyboard / dismissal — the
//       button opens a menu since 2026-10-02, it no longer downloads directly),
//       and a real download through a Blob URL (the filename rule is unverifiable
//       in Part A: it lives in the page).
//
// Usage: node scripts/test-submission-export.js
//        BASE_URL=http://localhost:8123 node scripts/test-submission-export.js
//
// GOTCHA — Part A mutates require.cache. It must run BEFORE anything else requires
// the handler, and `currentUser` is read at call time (a module-level let) so the
// 401 case can flip it without re-stubbing.
'use strict';

const path = require('path');
const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/$/, '');

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// ---------------------------------------------------------------- fixtures

// 13 键：只留「提交内容 + 地理位置 + 出处 + 元信息」。
const EXPECTED_KEYS = [
  'name', 'description', 'detailed_description', 'tags',
  'geojson', 'streetview', 'country_id', 'scope',
  'link', 'source_type', 'source_url',
  'created_at', 'edit_target_id'
].sort();

// 2026-10-01 用户明确要求精简掉的内部记账字段。它们**不许**出现在导出里 ——
// 这条比「13 键都在」更重要：多一个键是回归，A3 的集合相等会因为长度不同而红，
// 但这里单独列出来是为了在失败时报出**具体是哪个字段漏了**。
const BANNED_KEYS = [
  'id', 'user_id', 'is_hidden', 'is_deleted', 'deleted_at',
  'status', 'reject_reason', 'reviewed_at', 'edited_at', 'first_approved_at',
  'useful_count', 'useless_count'
];

const POLY = JSON.stringify({ type: 'Polygon', coordinates: [[[24, -30], [25, -30], [25, -29], [24, -30]]] });
const SV = JSON.stringify([{ pano: 'abc123', heading: 90, pitch: 0, zoom: 1 }]);

const USER_ID = 'u1';

const ACTIVE = {
  id: 'aaa11111-2222-3333-4444-555566667777',
  name: 'Kirstenbosch stone path',
  description: 'A path', detailed_description: 'A longer path',
  tags: JSON.stringify(['t1', 't2']), geojson: POLY, streetview: SV,
  link: 'https://example.com/a', country_id: 'south-africa', scope: 'region',
  status: 'approved', created_at: '2026-01-02T00:00:00Z',
  reviewed_at: '2026-01-03T00:00:00Z', source_type: 'web', source_url: 'https://src.example',
  user_id: USER_ID, edit_target_id: null, reject_reason: '',
  is_deleted: 0, deleted_at: null, is_hidden: 0,
  edited_at: '2026-01-04T00:00:00Z', first_approved_at: '2026-01-03T00:00:00Z'
};

// Same row, hidden. Every field that distinguishes it from ACTIVE must not change
// the key set — that is the whole contract.
const HIDDEN = Object.assign({}, ACTIVE, {
  id: 'bbb11111-2222-3333-4444-555566667777',
  name: 'Hidden Ridge', is_hidden: 1, status: 'pending', reviewed_at: null
});

// In Trash. Export must refuse it.
const TRASHED = Object.assign({}, ACTIVE, {
  id: 'ccc11111-2222-3333-4444-555566667777',
  name: 'Deleted Thing', is_deleted: 1, deleted_at: '2026-02-01T00:00:00Z'
});

// A draft row: edit_target_id points at ACTIVE. Exercises the null-vs-'' rule.
const DRAFT = Object.assign({}, ACTIVE, {
  id: 'ddd11111-2222-3333-4444-555566667777',
  name: 'Kirstenbosch stone path (edit)',
  status: 'pending', edit_target_id: ACTIVE.id, reviewed_at: null, first_approved_at: null
});

const ALL_ROWS = [ACTIVE, HIDDEN, TRASHED, DRAFT];

const SUB_COLS = ['id', 'name', 'description', 'detailed_description', 'tags', 'geojson',
  'streetview', 'link', 'country_id', 'scope', 'status', 'created_at', 'reviewed_at',
  'source_type', 'source_url', 'user_id', 'edit_target_id', 'reject_reason',
  'is_deleted', 'deleted_at', 'is_hidden', 'edited_at', 'first_approved_at'];

const cell = (v) => ({ value: v });
const toTursoRow = (obj) => SUB_COLS.map((c) => cell(obj[c] === undefined ? null : obj[c]));

// ------------------------------------------------- Part A: in-process contract

let currentUser = { id: USER_ID, username: 'probe' };
let submissionsHits = 0;
const sqlLog = [];

async function fakeTursoFetch(sql, args) {
  sqlLog.push(sql);
  if (/FROM\s+submissions/i.test(sql)) {
    submissionsHits++;
    const [wantedId, wantedUser] = args;
    let hits = ALL_ROWS.filter((r) => r.id === wantedId && r.user_id === wantedUser);
    // The stub honours the clause only because it is literally in the SQL. Remove
    // it from the handler and TRASHED starts coming back — which is exactly the
    // regression assertion 7 is meant to catch.
    if (/is_deleted\s*=\s*0/i.test(sql)) hits = hits.filter((r) => !r.is_deleted);
    return { cols: SUB_COLS.map((n) => ({ name: n })), rows: hits.map(toTursoRow) };
  }
  if (/FROM\s+reactions/i.test(sql)) {
    return { cols: [{ name: 'type' }, { name: 'cnt' }], rows: [[cell('useful'), cell(3)], [cell('useless'), cell(1)]] };
  }
  return { cols: [], rows: [] };
}

const tursoPath = path.resolve(__dirname, '..', 'api', '_lib', 'turso.js');
const realTurso = require(tursoPath);

// Only the network layer is replaced. safeJson / normalizeStreetview /
// normalizeLink stay real — the projection under test is built out of them.
require.cache[tursoPath] = {
  id: tursoPath, filename: tursoPath, loaded: true, children: [], paths: [],
  exports: Object.assign({}, realTurso, {
    tursoFetch: fakeTursoFetch,
    ensureSchema: async () => {},
    cleanupTrash: async () => {},
    checkRateLimit: async () => false,
    checkCsrf: () => true,
    getSessionUser: async () => currentUser
  })
};

const handlerPath = path.resolve(__dirname, '..', 'api', 'user-submissions.js');
delete require.cache[handlerPath];
const handler = require(handlerPath);

function fakeRes() {
  const r = {
    statusCode: 0, body: null, ended: false,
    status(c) { r.statusCode = c; return r; },
    json(o) { r.body = o; return r; },
    end() { r.ended = true; return r; }
  };
  return r;
}

async function callExport(id, format) {
  const res = fakeRes();
  const query = { action: 'export', id };
  // undefined → 连 `format` 这个键都不传。这是要断言的那条契约：省略 = 'full'。
  if (format !== undefined) query.format = format;
  await handler({ method: 'GET', query, headers: {} }, res);
  return res;
}

// ------------------------------------------------- Part B: page-level helpers

async function newCtx(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const errors = [];
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.includes('unpkg.com')) return r.continue();
    return r.abort();
  });
  await ctx.route(/\/api\/auth/, (r) => r.fulfill(j({ user: { id: 1, username: 'probe' } })));
  await ctx.route(/\/api\/pageview/, (r) => r.fulfill(j({ ok: true })));
  await ctx.route(/\/api\/countries/, (r) => r.fulfill(j({ countries: [] })));
  await ctx.route(/\/api\/user-submissions/, async (r) => {
    const u = r.request().url();
    if (u.includes('action=export')) {
      opts.exportHits = (opts.exportHits || 0) + 1;
      opts.lastExportUrl = u;
      if (u.includes('format=geojson')) {
        opts.geojsonHits = (opts.geojsonHits || 0) + 1;
        // 裸 geometry，形状对齐真 handler 的 exportGeometry()。
        return r.fulfill(j(JSON.parse(POLY)));
      }
      return r.fulfill(j({
        format: 'geoguide-submission', version: 1,
        exported_at: '2026-10-01T00:00:00.000Z',
        submission: { id: ACTIVE.id, name: ACTIVE.name }
      }));
    }
    if (u.includes('action=notifications')) return r.fulfill(j({ notifications: [], unread: 0 }));
    if (u.includes('action=countries')) return r.fulfill(j({ countries: [
      { country: 'south-africa', name: 'South Africa', count: 1 }] }));
    if (u.includes('status=hidden')) return r.fulfill(j({ submissions: [card('hidden')], total: 1, page: 1 }));
    if (u.includes('status=trash')) return r.fulfill(j({ submissions: [card('trash')], total: 1, page: 1 }));
    return r.fulfill(j({ submissions: [card('active')], total: 1, page: 1 }));
  });
  ctx.__errors = errors;
  return ctx;
}

const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

// Card objects as the list endpoint would hand them to the three builders.
function card(kind) {
  const base = {
    id: kind === 'hidden' ? HIDDEN.id : kind === 'trash' ? TRASHED.id : ACTIVE.id,
    name: kind === 'hidden' ? HIDDEN.name : kind === 'trash' ? TRASHED.name : ACTIVE.name,
    description: 'd', detailed_description: '', country_id: 'south-africa', scope: 'region',
    tags: [], geojson: JSON.parse(POLY), streetview: [], link: '',
    status: kind === 'trash' ? 'approved' : kind === 'hidden' ? 'pending' : 'approved',
    created_at: '2026-01-02T00:00:00Z', reviewed_at: null, reject_reason: '',
    useful_count: 0, useless_count: 0, edit_target_id: null
  };
  if (kind === 'hidden') { base.is_hidden = 1; }
  if (kind === 'trash') { base.is_deleted = 1; base.deleted_at = '2026-02-01T00:00:00Z'; }
  return base;
}

(async () => {
  // ============================================== Part A — the contract

  const activeRes = await callExport(ACTIVE.id);
  ok(activeRes.statusCode === 200, 'A1 active 提交导出返回 200', activeRes.statusCode);

  const env = activeRes.body || {};
  ok(typeof env.format === 'string' && env.format === 'geoguide-submission',
    'A2 信封带 format=geoguide-submission', env.format);
  ok(env.version === 1, 'A2 信封带 version=1', env.version);
  ok(typeof env.exported_at === 'string' && !isNaN(Date.parse(env.exported_at)),
    'A2 信封带可解析的 exported_at', env.exported_at);
  ok(!!env.submission && typeof env.submission === 'object', 'A2 信封带 submission 对象');

  const activeKeys = Object.keys(env.submission || {}).sort();
  ok(JSON.stringify(activeKeys) === JSON.stringify(EXPECTED_KEYS),
    'A3 submission 恰好是约定的 13 键（多一个少一个都红）',
    activeKeys.length === EXPECTED_KEYS.length ? undefined
      : { got: activeKeys.length, want: EXPECTED_KEYS.length,
          missing: EXPECTED_KEYS.filter((k) => !activeKeys.includes(k)),
          extra: activeKeys.filter((k) => !EXPECTED_KEYS.includes(k)) });

  const hiddenRes = await callExport(HIDDEN.id);
  const hiddenKeys = Object.keys((hiddenRes.body || {}).submission || {}).sort();
  ok(hiddenRes.statusCode === 200, 'A4 hidden 提交也能导出（200）', hiddenRes.statusCode);
  ok(JSON.stringify(hiddenKeys) === JSON.stringify(activeKeys),
    'A4 ★核心★ active 与 hidden 的键集逐字相同（集合相等，不是「都包含」）',
    JSON.stringify(hiddenKeys) === JSON.stringify(activeKeys) ? undefined : { activeKeys, hiddenKeys });

  const sub = env.submission || {};
  ok(typeof sub.tags === 'object' && Array.isArray(sub.tags), 'A5 tags 是数组不是 JSON 字符串', typeof sub.tags);
  ok(typeof sub.geojson === 'object' && sub.geojson !== null && sub.geojson.type === 'Polygon',
    'A5 geojson 是对象不是 JSON 字符串', typeof sub.geojson);
  ok(Array.isArray(sub.streetview) && typeof sub.streetview[0] === 'object',
    'A5 streetview 是对象数组不是 JSON 字符串', sub.streetview);

  const leaked = BANNED_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(sub, k));
  ok(leaked.length === 0, 'A5 ★能简则简★ 12 个内部记账字段一个都没漏进导出', leaked);
  ok(!sqlLog.some((s) => /FROM\s+reactions/i.test(s)),
    'A5 不再查 reactions 表（点赞数已删，少一次数据库往返）');

  const draftRes = await callExport(DRAFT.id);
  const draftSub = (draftRes.body || {}).submission || {};
  ok(draftSub.edit_target_id === ACTIVE.id, 'A6 草稿行保留 edit_target_id 指向', draftSub.edit_target_id);
  ok(sub.edit_target_id === null,
    'A6 ★NULL 语义★ 独立提交的 edit_target_id 是 null，不是空串', JSON.stringify(sub.edit_target_id));

  const missingRes = await callExport('nope-does-not-exist');
  ok(missingRes.statusCode === 404, 'A7 不存在的 id → 404', missingRes.statusCode);
  ok(!JSON.stringify(missingRes.body || {}).includes('nope-does-not-exist'),
    'A7 ★不泄露★ 404 响应体不含被请求的 id', missingRes.body);

  const trashRes = await callExport(TRASHED.id);
  ok(trashRes.statusCode === 404, 'A8 ★Trash 被拒★ Trash 里的提交 → 404', trashRes.statusCode);
  ok(JSON.stringify(trashRes.body) === JSON.stringify(missingRes.body),
    'A8 Trash 的 404 与「不存在」的 404 文案逐字相同（否则可当探针）',
    { trash: trashRes.body, missing: missingRes.body });

  const noIdRes = await callExport('');
  ok(noIdRes.statusCode === 400, 'A9 缺 id → 400', noIdRes.statusCode);

  currentUser = null;
  const anonRes = await callExport(ACTIVE.id);
  ok(anonRes.statusCode === 401, 'A10 未登录 → 401', anonRes.statusCode);
  ok(anonRes.body && anonRes.body.error === 'Login required',
    'A10 401 沿用既有文案', anonRes.body);
  currentUser = { id: USER_ID, username: 'probe' };

  const sql = sqlLog.find((s) => /FROM\s+submissions/i.test(s)) || '';
  ok(/is_deleted\s*=\s*0/i.test(sql), 'A11 ★SQL 守住 Trash★ 取数 SQL 含 is_deleted = 0', sql);
  ok(/user_id\s*=\s*\?/i.test(sql), 'A11 SQL 是 owner 限定的（带 user_id = ?）', sql);

  ok(submissionsHits > 0, 'A12 ★非空洞性★ 提交查询真被调用过（否则上面的断言全在空转）', submissionsHits);
  ok(activeKeys.length > 0, 'A12 ★非空洞性★ 键集非空', activeKeys.length);

  // ---- A13/A14：简易下载（format=geojson）----
  // 发布到用户硬盘上的第二种格式。与完整导出的**唯一关系**：它就是
  // `submission.geojson` 那一项原样。所以下面第一条断言是两边对拍，而不是照抄夹具 ——
  // 照抄夹具的话，哪天两边各写一份投影、漂移了也测不出来。
  const geoRes = await callExport(ACTIVE.id, 'geojson');
  ok(geoRes.statusCode === 200, 'A13 format=geojson 返回 200', geoRes.statusCode);

  const geo = geoRes.body || {};
  ok(JSON.stringify(geo) === JSON.stringify(sub.geojson),
    'A13 ★核心★ 简易下载的响应体 = 完整导出里的 submission.geojson，逐字节相同',
    JSON.stringify(geo) === JSON.stringify(sub.geojson) ? undefined
      : { geojson: JSON.stringify(geo), fromFull: JSON.stringify(sub.geojson) });

  const geoKeys = Object.keys(geo).sort();
  ok(JSON.stringify(geoKeys) === JSON.stringify(['coordinates', 'type']),
    'A13 裸 geometry：只有 type/coordinates，没有 format/version/exported_at/submission 信封',
    geoKeys);
  ok(geo.type === 'Polygon' && Array.isArray(geo.coordinates),
    'A13 返回的是几何对象而不是 JSON 字符串', [geo.type, typeof geo.coordinates]);

  const geoHidden = await callExport(HIDDEN.id, 'geojson');
  ok(geoHidden.statusCode === 200
     && JSON.stringify(geoHidden.body) === JSON.stringify(hiddenRes.body.submission.geojson),
    'A13 hidden 的简易下载同样可用且同样对得上完整导出', geoHidden.statusCode);

  const geoTrash = await callExport(TRASHED.id, 'geojson');
  ok(geoTrash.statusCode === 404, 'A13 ★Trash 照样不可下载★ format=geojson 也拒', geoTrash.statusCode);
  ok(JSON.stringify(geoTrash.body) === JSON.stringify(trashRes.body),
    'A13 两种 format 的 Trash 404 文案逐字相同（共用同一套语义，不是各写一遍）', geoTrash.body);

  const geoNoId = await callExport('', 'geojson');
  ok(geoNoId.statusCode === 400, 'A13 format=geojson 缺 id → 400', geoNoId.statusCode);
  const geoMissing = await callExport('nope-does-not-exist', 'geojson');
  ok(geoMissing.statusCode === 404, 'A13 format=geojson 不存在的 id → 404', geoMissing.statusCode);

  currentUser = null;
  const geoAnon = await callExport(ACTIVE.id, 'geojson');
  ok(geoAnon.statusCode === 401, 'A13 format=geojson 未登录 → 401（鉴权只有一份实现）', geoAnon.statusCode);
  currentUser = { id: USER_ID, username: 'probe' };

  // 省略 format 必须仍是 full —— 老调用方的 URL 里没有这个参数，一旦默认值变了，
  // 所有旧书签/脚本会静默拿到另一种格式。
  const noFormat = await callExport(ACTIVE.id);
  ok(noFormat.statusCode === 200 && !!(noFormat.body || {}).submission,
    'A14 省略 format 仍然是完整导出（默认值没变，老调用方不受影响）',
    Object.keys(noFormat.body || {}));

  const bogusFormat = await callExport(ACTIVE.id, 'nope');
  ok(bogusFormat.statusCode === 400, 'A14 ★未知 format 直接拒★ 不静默回落成 full', bogusFormat.statusCode);

  // ============================================== Part B — the page

  const browser = await firefox.launch({ headless: true });

  // 控制字符一律用 charCode 构造。**不要**在源码里写转义序列或字面量 ——
  // 这个仓库踩过：写正则时落进去真实控制字节，整个文件变二进制，ugrep 从此静默。
  const hasCtrlChar = (s) => Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  const unsafeName = (s) => s.includes('/') || s.includes('\\') || s.includes('..');

  async function openPage(ctx) {
    const p = await ctx.newPage();
    p.on('pageerror', (e) => ctx.__errors.push(e.message));
    const dl = [];
    p.on('download', (d) => dl.push(d));
    await p.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
    await p.waitForSelector('#my-results .review-item__icon--download', { timeout: 10000 });
    return { page: p, downloads: dl };
  }

  // 下载图标现在是个**菜单触发器**（2026-10-02），不再直接下载。
  // 所有下载断言都得先过这一步：点图标 → 点菜单项。
  async function pickDownload(page, label) {
    await page.click('#my-results .review-item__icon--download');
    await page.waitForSelector('.download-menu:not([hidden])', { timeout: 5000 });
    await page.click('.download-menu__item:has-text("' + label + '")');
  }

  // ---- B1/B2：图标的存在、位置与几何（Firefox 没有 showSaveFilePicker，走兑底）----
  //
  // ⚠️ 2026-10-01 **方向反过一次，别再反回去。** 第一版把「下载图标在卡片右上角、
  // **不是** .review-item__actions 的子元素」写成了契约，理由是下载既不是状态变更也不是
  // 破坏性操作，混进 Edit/Hide/Delete 那一行语义不对。用户当天改主意：下载挪到右下角、
  // 和另外三个排成一行。详见 submission-export.md §9（沿革）与 §3.6（新几何）。
  //
  // 保留下来的只有**语义**：「Trash 不可下载」（B5）。几何会随设计变，语义不会。
  const opts = {};
  const ctx = await newCtx(browser, opts);
  const { page, downloads } = await openPage(ctx);

  const icon = await page.evaluate(() => {
    const card = document.querySelector('#my-results .review-item');
    const b = card && card.querySelector('.review-item__icon--download');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const cardCs = getComputedStyle(card);
    const r = b.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const svg = b.querySelector('svg');
    const sr = svg && svg.getBoundingClientRect();
    const btns = [...card.querySelectorAll('.review-item__actions button')];
    // 卡片内容盒的右缘 —— 「下载贴在右下角」就是它的右缘等于这个数
    const contentRight = cr.right - parseFloat(cardCs.borderRightWidth) - parseFloat(cardCs.paddingRight);
    return {
      inActions: !!b.closest('.review-item__actions'),
      position: cs.position,
      rightGap: Math.round(contentRight - r.right),
      isLast: btns[btns.length - 1] === b,
      siblingsBefore: btns.indexOf(b),
      w: Math.round(r.width), h: Math.round(r.height),
      svgW: sr ? Math.round(sr.width) : null,
      namePadRight: getComputedStyle(card.querySelector('.review-item__name')).paddingRight,
      triW: Math.round(card.querySelector('.review-item__status').getBoundingClientRect().width),
      border: cs.borderStyle,
      bg: cs.backgroundColor,
      label: b.getAttribute('aria-label'),
      title: b.getAttribute('title'),
      haspopup: b.getAttribute('aria-haspopup'),
      expanded: b.getAttribute('aria-expanded')
    };
  });
  ok(!!icon, 'B1 active 卡上有下载图标');
  ok(icon && icon.inActions === true, 'B1 ★图标在动作行里★（2026-10-01 用户改的方向）', icon && icon.inActions);
  ok(icon && icon.isLast && icon.siblingsBefore === 3,
    'B1 下载是动作行的**最后一个**（Edit/Hide/Delete 之后）', icon && [icon.siblingsBefore, icon.isLast]);
  ok(icon && icon.position === 'static', 'B2 在内容流里（不再绝对定位）', icon && icon.position);
  ok(icon && icon.w === 32 && icon.h === 32, 'B2 命中区 32px（--compact 档）', icon && [icon.w, icon.h]);
  ok(icon && icon.svgW === 18, 'B2 字形 18px（与同排另外三个一致）', icon && icon.svgW);
  ok(icon && icon.border === 'none' && (icon.bg === 'rgba(0, 0, 0, 0)' || icon.bg === 'transparent'),
    'B2 无框无底，hover 才浮出来', icon && [icon.border, icon.bg]);
  // 「右下角」的几何含义：靠 :last-child 的 margin-left:auto 顶到内容盒右缘
  ok(icon && Math.abs(icon.rightGap) <= 1, 'B2 ★右缘贴住卡片内容盒★（右下角）', icon && icon.rightGap);
  // 标题右内边距现在是让开**右上角的三角**（不再是为了让开下载图标）
  ok(icon && icon.namePadRight !== '0px' && parseFloat(icon.namePadRight) >= icon.triW,
    'B2 标题留了右内边距，且 ≥ 三角宽度（长名字不会钻到三角底下）',
    icon && [icon.namePadRight, icon.triW]);
  ok(icon && icon.label && icon.label.indexOf('Kirstenbosch') !== -1, 'B2 aria-label 带上了提交名', icon && icon.label);
  // 文案从 'Download as JSON' 改成 'Download options'：这个图标现在开菜单、不直接下载，
  // 名字得跟着行为走（2.5.3 的近亲）。
  ok(icon && icon.title === 'Download options', 'B2 title 提示（它开的是菜单，不是直接下载）', icon && icon.title);
  ok(icon && icon.haspopup === 'menu', 'B2 aria-haspopup=menu', icon && icon.haspopup);
  ok(icon && icon.expanded === 'false',
    'B2 ★收起时 aria-expanded=false★（写死 false 而没人翻它，读屏器会永远以为它是收起的）',
    icon && icon.expanded);

  // ---- B3：兑底下载（Firefox 无 picker）----
  await pickDownload(page, 'Full JSON');
  await page.waitForTimeout(600);
  ok(downloads.length === 1, 'B3 没有 picker 时走 <a download> 兑底（一次下载）', downloads.length);
  if (downloads.length) {
    ok(downloads[0].suggestedFilename() === 'geoguide_Kirstenbosch-stone-path.json',
      'B3 文件名 = geoguide_<名字>.json', downloads[0].suggestedFilename());
  }
  ok(opts.lastExportUrl && opts.lastExportUrl.indexOf('action=export') !== -1
     && opts.lastExportUrl.indexOf(encodeURIComponent(ACTIVE.id)) !== -1,
    'B3 ★非空洞性★ 确实打到了 export 端点且带对了 id', opts.lastExportUrl);
  ok(opts.lastExportUrl.indexOf('format=') === -1,
    'B3 Full JSON 不带 format 参数（省略即默认 full，别让默认值失去消费者）', opts.lastExportUrl);

  // ---- B8：菜单的几何 —— 不能被卡片裁掉 ----
  // 这是选「点图标弹菜单」这个方案时**唯一的真风险**：卡片是 overflow: hidden
  // （右上角三角贴圆角的前提），浮层放卡片里会被裁掉半截。所以菜单必须挂在 body 上
  // 且是 position: fixed。下面用 elementFromPoint 验收 —— 这正是导航栏那条注释里
  // 记的既有手段（「实测 elementFromPoint 在下拉中心返回的是那个工具栏」）。
  //
  // 上一段（B3）选完就关掉了，这里重新打开 —— 量 display:none 的元素只会得到全 0 的 rect。
  await page.click('#my-results .review-item__icon--download');
  await page.waitForSelector('.download-menu:not([hidden])', { timeout: 5000 });
  const menuBox = await page.evaluate(() => {
    const menu = document.querySelector('.download-menu');
    const r = menu.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      parentIsBody: menu.parentElement === document.body,
      position: getComputedStyle(menu).position,
      insideCard: !!menu.closest('#my-results'),
      rect: [r.left, r.top, r.right, r.bottom],
      vw: window.innerWidth, vh: window.innerHeight,
      // 菜单中心点真的能命中菜单自己 = 既没被裁、也没被别的东西盖住
      hitInside: !!(hit && menu.contains(hit)),
      hitTag: hit ? hit.className : null,
      items: menu.querySelectorAll('.download-menu__item').length
    };
  });
  ok(menuBox.parentIsBody, 'B8 ★菜单挂在 body 上★（不在卡片里，否则会被 overflow 裁掉）', menuBox);
  ok(!menuBox.insideCard, 'B8 ★菜单不是卡片的后代★', menuBox.insideCard);
  ok(menuBox.position === 'fixed', 'B8 菜单是 position: fixed', menuBox.position);
  ok(menuBox.hitInside, 'B8 ★可见可点★ elementFromPoint 在菜单中心命中菜单自己', menuBox.hitTag);
  ok(menuBox.rect[0] >= 0 && menuBox.rect[1] >= 0
     && menuBox.rect[2] <= menuBox.vw + 0.5 && menuBox.rect[3] <= menuBox.vh + 0.5,
    'B8 菜单整个落在视口内（没顶出去）', { rect: menuBox.rect, vw: menuBox.vw, vh: menuBox.vh });
  ok(menuBox.items === 2, 'B8 菜单两项', menuBox.items);

  ok(ctx.__errors.length === 0, 'B8 开菜单的过程中无 JS 报错',
    ctx.__errors.length ? ctx.__errors : undefined);

  // ---- B9：Escape 收起，焦点还回触发按钮 ----
  const afterEsc = await page.evaluate(() => {
    const menu = document.querySelector('.download-menu');
    const btn = document.querySelector('#my-results .review-item__icon--download');
    const inMenu = menu.contains(document.activeElement);
    return { inMenu, expanded: btn.getAttribute('aria-expanded') };
  });
  ok(afterEsc.expanded === 'true',
    'B9 前提：菜单开着时 aria-expanded 真的被翻成 true（否则 B2 那条是空转）', afterEsc);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  const escState = await page.evaluate(() => {
    const menu = document.querySelector('.download-menu');
    const btn = document.querySelector('#my-results .review-item__icon--download');
    return {
      hidden: menu.hidden,
      expanded: btn.getAttribute('aria-expanded'),
      focusOnBtn: document.activeElement === btn
    };
  });
  ok(escState.hidden, 'B9 Escape 收起菜单', escState);
  ok(escState.expanded === 'false', 'B9 收起后 aria-expanded 翻回 false', escState.expanded);
  ok(escState.focusOnBtn,
    'B9 ★焦点还回触发按钮★（不回的话焦点掉在 body 上，键盘用户直接丢失位置）', escState);

  // ---- B10：点外部收起 ----
  await page.click('#my-results .review-item__icon--download');
  await page.waitForSelector('.download-menu:not([hidden])', { timeout: 5000 });
  // 点页面标题 —— 确定在菜单外，也不是触发按钮，且不是链接（点导航栏角落会有别的变数）。
  await page.click('h1');
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => document.querySelector('.download-menu').hidden),
    'B10 点菜单外面收起');

  // 再点一次触发按钮 = 收起（开关语义，与放大镜、国家筛选一致）。放在最后，
  // 因为下面的 B4 还要靠 page.evaluate 读页面上的函数，与菜单状态无关。
  await page.click('#my-results .review-item__icon--download');
  await page.waitForSelector('.download-menu:not([hidden])', { timeout: 5000 });
  await page.click('#my-results .review-item__icon--download');
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => document.querySelector('.download-menu').hidden),
    'B10 再点一次触发按钮也收起（开关语义，不是只能点外面）');

  // ---- B11：GeoJSON 那一项 —— 文件名、MIME、请求参数 ----
  await pickDownload(page, 'GeoJSON only');
  await page.waitForTimeout(600);
  ok(downloads.length === 2, 'B11 GeoJSON 项也走了一次兑底下载', downloads.length);
  if (downloads.length === 2) {
    ok(downloads[1].suggestedFilename() === 'geoguide_Kirstenbosch-stone-path.geojson',
      'B11 ★扩展名是 .geojson★', downloads[1].suggestedFilename());
  }
  ok((opts.geojsonHits || 0) === 1, 'B11 ★确实带上了 format=geojson★', opts.lastExportUrl);
  ok(opts.lastExportUrl.indexOf('format=geojson') !== -1, 'B11 请求 URL 含 format=geojson', opts.lastExportUrl);

  // ---- B12：滚动时收起 ----
  // position: fixed 不跟着滚动走 —— 不收起的话菜单会钉在原地、跟触发按钮分家。
  // 先把视口压矮**逼出滚动条**，否则这条是空转（一屏塞得下就滚不动，断言恒绿）。
  // 改视口本身会触发 resize 从而收起菜单，所以顺序是：先压矮 → 再开菜单。
  await page.setViewportSize({ width: 1280, height: 320 });
  await page.waitForTimeout(200);
  await page.click('#my-results .review-item__icon--download');
  await page.waitForSelector('.download-menu:not([hidden])', { timeout: 5000 });
  // ⚠️ 滚动容器是 **`document.body`**，不是视口 —— style.css 里 `html, body` 是
  // `overflow: hidden`，只有 `body.allow-scroll` 开了 `overflow-y: auto`。
  // 所以 `document.scrollingElement`（= documentElement）的 scrollHeight 恒等于
  // clientHeight，拿它判「能不能滚」永远是 false，`window.scrollBy` 也不动。
  //
  // ⚠️ 而且**必须选一个真的会改变 scrollTop 的方向**：Playwright 为了点下载图标
  // 已经把卡片滚进视口了，矮视口下那多半就是**底部**（实测 top=121 = 441-320 = 上限）。
  // 这时再写 `scrollTop = 150` 会被夹回 121 —— 位置没变 → 不派发 scroll →
  // 下面那条红的毫无道理。第一版就这么红的：前提写的是 `scrollTop > 0`，
  // 而它本来就已经 > 0，**前提本身是空转的**。
  const before = await page.evaluate(() => {
    const b = document.body;
    return { scrollH: b.scrollHeight, clientH: b.clientHeight, top: b.scrollTop };
  });
  ok(before.scrollH > before.clientH + 20,
    'B12 前提：矮视口下 body 真的能滚（不然下面那条是空转）', before);
  const moved = await page.evaluate(() => {
    const b = document.body;
    // 上下哪边有余量就往哪边滚，保证位置**一定**变
    b.scrollTop = b.scrollTop > 50 ? b.scrollTop - 100 : b.scrollTop + 100;
    return { top: b.scrollTop };
  });
  ok(Math.abs(moved.top - before.top) > 1,
    'B12 前提：scrollTop 真的变了（不变就不会派发 scroll，下面的断言毫无意义）',
    { from: before.top, to: moved.top });
  await page.waitForTimeout(200);
  ok(await page.evaluate(() => document.querySelector('.download-menu').hidden),
    'B12 ★滚动时收起★（fixed 菜单不跟滚动走，不收就成了一个脱离按钮的浮层）');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);

  // ---- B4：文件名净化（签名已变成 exportFilename(name)）----
  const names = await page.evaluate(() => ({
    traversal: exportFilename('../../etc/passwd'),
    backslash: exportFilename('a\\b\\\\c'),
    ctrl: exportFilename('a' + String.fromCharCode(0, 31, 127) + 'bcd'),
    cjk: exportFilename('塔斯马尼亚 摇篮山'),
    empty: exportFilename(''),
    dots: exportFilename('..'),
    long: exportFilename('x'.repeat(200)),
    // 扩展名是第二个参数（2026-10-02 加）。省略 = .json，与老调用点兼容。
    geo: exportFilename('Kirstenbosch stone path', '.geojson'),
    geoDefault: exportFilename('Kirstenbosch stone path')
  }));
  ok(!unsafeName(names.traversal), 'B4 路径穿越被中和', names.traversal);
  ok(!unsafeName(names.backslash), 'B4 反斜杠被中和', names.backslash);
  ok(!hasCtrlChar(names.ctrl), 'B4 控制字符被剔除', JSON.stringify(names.ctrl));
  ok(names.cjk === 'geoguide_塔斯马尼亚-摇篮山.json', 'B4 中文原样保留、空格折成 -', names.cjk);
  ok(names.empty === 'geoguide_submission.json', 'B4 空名字兜底 submission', names.empty);
  ok(!unsafeName(names.dots), 'B4 纯 ".." 不会生成穿越名', names.dots);
  ok(names.long.length <= 'geoguide_'.length + 60 + '.json'.length, 'B4 超长名被截断', names.long.length);
  ok(names.geo === 'geoguide_Kirstenbosch-stone-path.geojson', 'B4 第二个参数给 .geojson', names.geo);
  ok(names.geoDefault === 'geoguide_Kirstenbosch-stone-path.json',
    'B4 ★扩展名省略 = .json★（老调用点不受影响）', names.geoDefault);

  // ---- B5：hidden 有、trash 没有 ----
  await page.click('#visibility-tabs .review-tab[data-visibility="hidden"]');
  await page.waitForSelector('#my-results .review-item__icon--download', { timeout: 10000 });
  const hiddenHas = await page.evaluate(() => document.querySelectorAll('#my-results .review-item__icon--download').length);
  ok(hiddenHas === 1, 'B5 hidden 卡上也有下载图标', hiddenHas);

  await page.click('#visibility-tabs .review-tab[data-visibility="trash"]');
  await page.waitForTimeout(800);
  const trashInfo = await page.evaluate(() => ({
    cards: document.querySelectorAll('#my-results .review-item').length,
    dl: document.querySelectorAll('#my-results .review-item__icon--download').length,
    otherBtns: document.querySelectorAll('#my-results .review-item__actions button').length
  }));
  ok(trashInfo.cards > 0, 'B5 前提：Trash 卡确实渲染出来了（否则下面那条是空转）', trashInfo.cards);
  ok(trashInfo.dl === 0, 'B5 ★Trash 卡上没有下载图标★', trashInfo.dl);
  ok(trashInfo.otherBtns > 0, 'B5 前提：Trash 卡上确实还有别的按钮', trashInfo.otherBtns);

  ok(ctx.__errors.length === 0, 'B7 无 JS 报错', ctx.__errors.length ? ctx.__errors : undefined);
  await ctx.close();

  // ---- B6：Chromium 路径 —— 注入一个假的 showSaveFilePicker ----
  // Firefox 没有这个 API，所以真实的「另存为」分支在这台机器上永远走不到。
  // 注入一个假的把它跑起来，否则那条分支就是发布前从未执行过的代码。
  const opts2 = {};
  const ctx2 = await newCtx(browser, opts2);
  await ctx2.addInitScript(() => {
    window.__saved = null;
    window.showSaveFilePicker = function (o) {
      window.__saved = { suggestedName: o && o.suggestedName };
      return Promise.resolve({
        createWritable: function () {
          return Promise.resolve({
            write: function (t) { window.__saved.text = t; return Promise.resolve(); },
            close: function () { window.__saved.closed = true; return Promise.resolve(); }
          });
        }
      });
    };
  });
  const b2 = await openPage(ctx2);
  await pickDownload(b2.page, 'Full JSON');
  await b2.page.waitForTimeout(700);
  const saved = await b2.page.evaluate(() => window.__saved);
  ok(!!saved, 'B6 ★Chromium 路径★ 有 showSaveFilePicker 时确实调用了它');
  ok(saved && saved.suggestedName === 'geoguide_Kirstenbosch-stone-path.json',
    'B6 另存为对话框拿到的建议文件名正确', saved && saved.suggestedName);
  ok(saved && saved.closed === true, 'B6 写完调了 close()（不 close 文件是残缺的）');
  let parsed = null;
  try { parsed = JSON.parse((saved || {}).text); } catch (e) { /* 留 null，让下面那条红 */ }
  // ⚠️ 这里**只能**断言「落盘的是接口返回的那份 JSON」。键集契约由 A3 对着真 handler
  // 断言 —— 在 Part B 里数键等于在数我自己写的 mock，正是本文件头部警告的那个陷阱。
  // （第一版就是那么写的，跑出来红在 2 键上，因为 mock 只回了两键。）
  ok(!!parsed && !!parsed.format && !!parsed.submission,
    'B6 落盘的正是接口返回的那份 JSON（带信封）',
    parsed ? Object.keys(parsed) : String((saved || {}).text).slice(0, 60));
  ok(b2.downloads.length === 0, 'B6 走了 picker 就**不该**再触发一次普通下载', b2.downloads.length);
  await ctx2.close();

  // ---- B7：取消 = 什么都不存 ----
  const opts3 = {};
  const ctx3 = await newCtx(browser, opts3);
  await ctx3.addInitScript(() => {
    window.showSaveFilePicker = function () {
      const e = new Error('cancelled');
      e.name = 'AbortError';
      return Promise.reject(e);
    };
  });
  const b3 = await openPage(ctx3);
  await pickDownload(b3.page, 'Full JSON');
  await b3.page.waitForTimeout(700);
  ok(b3.downloads.length === 0,
    'B7 ★取消不该落盘★ 用户按取消 → 什么也不下载（错误地退回普通下载就等于照存不误）', b3.downloads.length);
  await ctx3.close();

  await browser.close();

  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });

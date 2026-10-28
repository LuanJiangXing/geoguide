// 首页国家卡片网格 —— 列数分档、单卡宽度下限、`+` 卡与邻居同档。
//
// WHY 需要单独一个脚本:这套网格原本是 `repeat(auto-fill, minmax(200px, 1fr))`,**自适应**的 ——
// 视口变窄它自己就换列,漏写一档不会出事。改成固定的 `repeat(6, minmax(0,1fr))` 之后,
// 每个档位都成了一条必须存在的断言,而**漏掉一档的症状是「6 条细柱」,不报错、不换行、
// 页面看起来还「挺整齐」**。这类静默失效正是本仓库其它脚本要挡的东西。
//
// 另一条守的是 `+` 卡。它是网格的最后一张、通常独占最后一行 —— **那一行的高度由它一个人决定**。
// 它身上钉着一个 min-height: 160px(基准卡 155px 高时看不出来),卡片收到 ~102px 之后
// 就会让最后一行突兀地高出 58px。反过来内边距比基准小,最后一行又会矮一截。
//
// Usage: node scripts/test-homepage-cards.js
//        BASE_URL=http://localhost:8123 node scripts/test-homepage-cards.js
'use strict';

const { firefox } = require('playwright');
const zlib = require('zlib');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

// 手搓一张 3:2 的 PNG 当国旗替身（仓库里没有现成的图，公共 CDN 又不可靠）。
// 不用 1:1：旗子按 `width: 40px; height: auto` 渲染，1:1 会把每张卡多算 13px 高。
function makePng(w, h) {
  const T = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const table = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;                     // 8-bit, truecolor RGB
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const o = y * (1 + w * 3);
    for (let x = 0; x < w; x++) { raw[o + 1 + x * 3] = 200; raw[o + 2 + x * 3] = 180; raw[o + 3 + x * 3] = 60; }
  }
  return Buffer.concat([Buffer.from(T), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const FLAG_PNG = makePng(60, 40);

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// 12 个国家 + `+` 卡 = 13 张。名字里刻意放最长的两种（含空格的 "Sao Tome and Principe"
// 与 "United Kingdom"），这样换行行为也在射程内。
const NAMES = [
  ['south-africa', 'South Africa', 'za'], ['paraguay', 'Paraguay', 'py'], ['canada', 'Canada', 'ca'],
  ['united-states', 'United States', 'us'], ['hawaii', 'Hawaii', 'us-hi'], ['turkey', 'Turkey', 'tr'],
  ['japan', 'Japan', 'jp'], ['brazil', 'Brazil', 'br'], ['kenya', 'Kenya', 'ke'],
  ['sao-tome', 'Sao Tome and Principe', 'st'], ['new-zealand', 'New Zealand', 'nz'],
  ['united-kingdom', 'United Kingdom', 'gb'],
];
const COUNTRIES = { countries: NAMES.map(([id, name, flag], i) => ({
  id, name, flag, bounds_sw: [0, 0], bounds_ne: [1, 1], active: 1, sort_order: i, region_count: i * 3 })) };

// 断点两侧各取一点。每个视口都验证「这一档的列数」—— 断言的是列数本身,不是"够宽就行":
// 少了某一档时列数会直接跳到 6,而单卡宽度恰好还能过一条宽松的下限断言,那样就测空了。
const CASES = [
  { vw: 1280, cols: 6, label: '桌面' },
  { vw: 900, cols: 6, label: '桌面窄端（容器刚好 900）' },
  { vw: 861, cols: 6, label: '860 断点上方' },
  { vw: 860, cols: 4, label: '860 断点本身' },
  { vw: 681, cols: 4, label: '680 断点上方' },
  { vw: 680, cols: 3, label: '680 断点本身' },
  { vw: 601, cols: 3, label: '600 断点上方' },
  { vw: 600, cols: 2, label: '600 断点本身' },
  { vw: 380, cols: 2, label: '小屏手机' },
];

const CARD_FLOOR = 120;   // 单卡宽度下限：低于这个数名字就开始逐字断行了

(async () => {
  const browser = await firefox.launch({ headless: true });
  const errs = [];

  for (const c of CASES) {
    const ctx = await browser.newContext({ viewport: { width: c.vw, height: 1200 } });
    // 国旗走 flagcdn 的真实请求会让「卡片高度」时高时低（加载失败时 onerror 把 img 隐藏，
    // 一张卡就矮 48px），量出来的行高全是噪声。这里统一换成同一张 3:2 的本地图，
    // 让高度只反映 CSS。3:2 是因为 w160 的旗子大体就是这个比例（za 是 160x107）。
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (u.startsWith(BASE) || u.includes('unpkg.com')) return r.continue();
      if (u.includes('flagcdn.com')) return r.fulfill({ status: 200, contentType: 'image/png', body: FLAG_PNG });
      return r.abort();
    });
    // ⚠️ Playwright 的路由**后注册者优先**，通用 /api/ 必须先注册，否则会吃掉 countries
    await ctx.route(/\/api\//, (r) => r.fulfill(j({})));
    await ctx.route(/\/api\/countries/, (r) => r.fulfill(j(COUNTRIES)));

    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(c.vw + ': ' + e.message));
    await p.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
    await p.waitForTimeout(700);
    await p.click('#view-cards-btn');          // 卡片视图默认是隐藏的，不点量到的全是 0
    await p.waitForTimeout(300);

    const m = await p.evaluate(() => {
      const grid = document.getElementById('country-grid');
      const cards = [...grid.children];
      if (!cards.length) return { error: '没有卡片' };
      const cols = new Set(cards.map((x) => Math.round(x.getBoundingClientRect().left))).size;
      const first = cards[0].getBoundingClientRect();
      const add = cards[cards.length - 1].getBoundingClientRect();
      const gr = grid.getBoundingClientRect();
      // 同一行的卡高度必然相同（grid 默认 stretch），所以「有几行」= 有几个不同的 top
      const rows = {};
      cards.forEach((x) => { const t = Math.round(x.getBoundingClientRect().top); (rows[t] = rows[t] || []).push(x); });
      const rowH = Object.keys(rows).sort((a, b) => a - b).map((t) => Math.round(rows[t][0].getBoundingClientRect().height));
      return {
        cols, cardW: +first.width.toFixed(1), cardH: Math.round(first.height),
        addH: Math.round(add.height), addIsLast: cards[cards.length - 1].classList.contains('country-card--add'),
        gridRight: Math.round(gr.right), vw: window.innerWidth,
        hScroll: document.documentElement.scrollWidth > window.innerWidth,
        overflow: cards.filter((x) => x.scrollWidth > x.clientWidth + 1).length,
        rowH,
      };
    });

    if (m.error) { ok(false, `${c.label}（${c.vw}px）: ${m.error}`, m); await ctx.close(); continue; }

    ok(m.cols === c.cols, `${c.label}（${c.vw}px）是 ${c.cols} 列`, { got: m.cols, cardW: m.cardW });
    ok(m.cardW >= CARD_FLOOR, `${c.label}（${c.vw}px）单卡 ${m.cardW}px ≥ ${CARD_FLOOR}px`, { cardW: m.cardW });
    ok(!m.hScroll && m.gridRight <= m.vw + 0.5, `${c.label}（${c.vw}px）不溢出视口`, { gridRight: m.gridRight, vw: m.vw, hScroll: m.hScroll });
    ok(m.overflow === 0, `${c.label}（${c.vw}px）无卡片内容溢出`, { overflow: m.overflow });

    // `+` 卡：既不比邻居高（min-height 回归），也不比邻居矮（内边距覆盖回归）。
    // 普通卡之间本来就有 102/118 两种高度（名字一行还是两行），所以只要求差 ≤ 2px。
    if (m.addIsLast) {
      ok(Math.abs(m.addH - m.cardH) <= 2,
        `${c.label}（${c.vw}px）\`+\` 卡与邻居同档（${m.addH} vs ${m.cardH}）`,
        { addH: m.addH, cardH: m.cardH, rowH: m.rowH });
    }

    await ctx.close();
  }

  ok(errs.length === 0, '无 JS 报错', errs.length ? errs : undefined);
  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

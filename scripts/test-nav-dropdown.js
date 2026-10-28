// Playwright harness for the nav's user dropdown vs the page chrome underneath it.
//
// Contract: an OPEN `.nav__dropdown` paints above whatever the page puts below the nav — and the
// nav itself still paints BELOW modal overlays.
//
// Why this needs its own script. `.nav` is `position: sticky` + `z-index`, so it is a stacking
// context; the dropdown's own `z-index: 4000` cannot escape it. The nav therefore competes as a
// single box, and explore's page chrome sat at 1100 (raised from 999 to clear Leaflet's 1000
// control layer) while `.nav` sat at 1000. That chrome painted over the whole open dropdown:
// `elementFromPoint` at its centre returned `div.toolbar`, so every item in it was unclickable.
// `test-style-parity.js` cannot see this (z-index *values* were all valid, and it aborts the
// cross-origin leaflet.css anyway); the bug is a relationship between boxes, not a computed style.
//
// 2026-09-18: explore's `.toolbar` is gone — search and the tag filter are now the `.map-tools`
// overlay (z-index 1001) in the map's top-left corner. `.map-tools` does NOT overlap the dropdown
// at all (measured: 0px² at 1280 — one is top-left, the other top-right), so using it as the
// subject here would make the non-vacuity guard below fail. What the dropdown genuinely competes
// with on explore is Leaflet's own control layer, and the basemap switch is the control it
// overlaps (measured 3843px² of the dropdown's 180×106 box). Same contract, honest subject.
//
// The other half of the contract is the regression the obvious fix causes: raising `.nav` above
// the page chrome also raises it above `.proposal-backdrop` (1000) / `.proposal-modal` (1001),
// because the backdrop used to win that tie on DOM order. Section 3 pins that down.
//
// GOTCHA — `z-index: auto` is NOT a fix. `position: sticky` always creates a stacking context,
// whatever the z-index. Measured: the dropdown stays covered with the nav at `z-index: auto`.
//
// GOTCHA — sample the CENTRE OF THE INTERSECTION between the dropdown and the element it competes
// with, not the dropdown's own centre. Same trap as test-tag-dropdown-overlap.js: the dropdown is
// mostly over nothing in particular, and a sample there passes whether or not the bug is present.
//
// Usage: node scripts/test-nav-dropdown.js
//        BASE_URL=http://localhost:8123 node scripts/test-nav-dropdown.js
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const USER = { id: 1, username: 'probe', avatar_url: null, is_admin: 1, is_reviewer: 1 };
// One real region, so explore's map actually initialises. This used to be `[]`, which made
// app.js throw '数据文件为空' — initMap never ran, so the page had NO Leaflet controls at all.
// That was invisible while the subject below was `.toolbar` (static HTML, always present), but
// the subject is a real control now, so the fixture has to produce a real map.
// NOTE: `geojson` must be a bare Geometry — geometryLayer() wraps it into a Feature itself.
const REGION = [{
  id: 'r1', name: 'Region r1', tags: [], user_id: '',
  geojson: { type: 'Polygon', coordinates: [[[28, -26], [28.4, -26], [28.4, -26.4], [28, -26.4], [28, -26]]] },
}];
const PAGES = ['/index.html', '/explore.html', '/my-submissions.html', '/profile.html',
  '/submit.html', '/review.html'];

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};
const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

// 下拉矩形与某个元素矩形的交集（取中心点采样）。没有交集时 area 为 0。
// 注意参数是**一个数组**：page.evaluate 只接受一个参数，写成 (selA, selB) 会让 selB 恒为
// undefined，querySelector 返回 null，报错还指向别处。
const INTERSECT = ([selA, selB]) => {
  const ea = document.querySelector(selA), eb = document.querySelector(selB);
  if (!ea || !eb) return { error: 'selector not found: ' + (ea ? selB : selA) };
  const a = ea.getBoundingClientRect();
  const b = eb.getBoundingClientRect();
  const x0 = Math.max(a.left, b.left), x1 = Math.min(a.right, b.right);
  const y0 = Math.max(a.top, b.top), y1 = Math.min(a.bottom, b.bottom);
  return { x: Math.round((x0 + x1) / 2), y: Math.round((y0 + y1) / 2),
    area: Math.round(Math.max(0, x1 - x0) * Math.max(0, y1 - y0)) };
};

// 某点最上层元素是不是下拉菜单的一部分
const TOP_IS_DROPDOWN = ([x, y]) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, top: 'null' };
  const inDD = el.closest && el.closest('.nav__dropdown.is-open') !== null;
  const desc = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim()
      ? '.' + el.className.trim().split(/\s+/).join('.') : '');
  return { ok: inDD, top: desc.slice(0, 60) };
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.includes('unpkg.com') || u.includes('jsdelivr') || u.includes('cdnjs')) return r.continue();
    return r.abort();
  });
  // 捕获全部路由要先注册（Playwright 后注册者优先）
  await ctx.route('**/api/**', (r) => r.fulfill(j({})));
  await ctx.route(/\/api\/auth/, (r) => r.fulfill(j({ user: USER })));
  await ctx.route(/\/api\/profile/, (r) => r.fulfill(j({ user: USER, submissions: [] })));
  await ctx.route(/\/api\/pageview/, (r) => r.fulfill(j({ ok: true })));
  await ctx.route(/\/api\/regions/, (r) => r.fulfill(j({ regions: [], total: 0 })));
  await ctx.route(/\/api\/countries/, (r) => r.fulfill(j({ countries: [] })));
  await ctx.route(/\/api\/submissions(\?|$)/, (r) => r.fulfill(j(REGION)));
  await ctx.route(/\/api\/tags/, (r) => r.fulfill(j({ categories: [] })));
  await ctx.route(/\/api\/user-submissions/, (r) => r.fulfill(j({ submissions: [], total: 0, page: 1, unread: 0 })));

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));

  const openMenu = async (path) => {
    await page.goto(BASE + path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('.nav__user-btn', { timeout: 15000 });
    await page.waitForTimeout(700);
    await page.click('.nav__user-btn');
    await page.waitForTimeout(300);
  };

  // --- 1) explore：下拉 ∩ Leaflet 控件层。这里才是它真正被盖住的地方 ---
  console.log('--- 1) explore：导航下拉 vs 底图切换控件 ---');
  await openMenu('/explore.html');
  // 底图切换由 basemap.js 动态创建，不是静态 HTML —— 不等它出现，交集会算成 NaN，
  // 报错还指向 elementFromPoint，看起来像"元素被盖住"而不是"元素没有"。
  await page.waitForSelector('.basemap-switch', { timeout: 15000 }).catch(() => {});
  const inter = await page.evaluate(INTERSECT, ['.nav__dropdown.is-open', '.basemap-switch']);
  ok(!inter.error, '两个采样对象都找得到', inter.error);
  // 非空断言：两者不重叠的话，下面那条断言就是在空跑
  ok(inter.area > 0, `下拉与底图切换确实重叠（${inter.area}px² @ ${inter.x},${inter.y}）`);
  const hit = inter.error ? { ok: false } : await page.evaluate(TOP_IS_DROPDOWN, [inter.x, inter.y]);
  ok(hit.ok, `重叠区中心最上层是下拉菜单`, hit.top);

  // 点在重叠区里，看命中的是不是「Log Out」——即点击真的落到了菜单项上
  const logoutOk = await page.evaluate(() => {
    const b = document.querySelector('.nav__dropdown-logout');
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { ok: el === b, top: el ? el.className.toString().slice(0, 60) : 'null' };
  });
  ok(logoutOk.ok, 'Log Out 按钮中心可点（命中的是它自己）', logoutOk.top);

  // --- 2) 其余页面：下拉中心最上层应始终是下拉自己 ---
  console.log('--- 2) 全站：下拉中心不被任何页面内容盖住 ---');
  for (const path of PAGES) {
    await openMenu(path);
    const r = await page.evaluate(() => {
      const dd = document.querySelector('.nav__dropdown.is-open');
      if (!dd) return { open: false };
      const b = dd.getBoundingClientRect();
      const el = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
      return {
        open: true,
        area: Math.round(b.width * b.height),
        ok: el !== null && el.closest('.nav__dropdown.is-open') !== null,
        top: el ? el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
          ? '.' + el.className.trim().split(/\s+/).join('.') : '') : 'null',
      };
    });
    ok(r.open && r.area > 0, `${path} 用户下拉打开了（${r.area || 0}px²，不是空跑）`);
    ok(r.ok, `${path} 下拉中心在最上层`, r.ok ? undefined : r.top);
  }

  // --- 3) index：抬高导航栏之后，弹窗遮罩必须仍然盖得住它 ---
  // 这是「修 explore 盖住下拉」最容易引入的反向回归：遮罩原先是靠 DOM 顺序赢下 1000 平局的。
  console.log('--- 3) index：提案弹窗遮罩仍盖住导航栏 ---');
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('.nav', { timeout: 15000 });
  await page.waitForTimeout(900);
  await page.evaluate(() => window.openProposalModal && window.openProposalModal());
  await page.waitForTimeout(600);
  const modalState = await page.evaluate(() => {
    const backdrop = document.querySelector('.proposal-backdrop');
    const modal = document.querySelector('.proposal-modal');
    const nav = document.querySelector('.nav');
    const nr = nav.getBoundingClientRect();
    const el = document.elementFromPoint(400, Math.round(nr.y + nr.height / 2));
    return {
      backdropOpen: backdrop ? backdrop.classList.contains('is-open') : false,
      modalOpen: modal ? modal.classList.contains('is-open') : false,
      navZ: getComputedStyle(nav).zIndex,
      backdropZ: backdrop ? getComputedStyle(backdrop).zIndex : null,
      navCoveredByBackdrop: el !== null && el.classList.contains('proposal-backdrop'),
      top: el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') : 'null',
    };
  });
  ok(modalState.backdropOpen && modalState.modalOpen, '提案弹窗确实打开了（不是空跑）',
    { backdrop: modalState.backdropOpen, modal: modalState.modalOpen });
  ok(modalState.navCoveredByBackdrop,
    `导航栏仍被遮罩盖住（nav z=${modalState.navZ} < 遮罩 z=${modalState.backdropZ}）`, modalState.top);

  ok(errs.length === 0, '无 JS 报错', errs.length ? errs : undefined);

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

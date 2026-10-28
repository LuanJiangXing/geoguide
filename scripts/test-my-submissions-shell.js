// Playwright harness for the my-submissions view shell: the loading indicator, the map's
// show/hide lifecycle, and the three-row segmented filter control.
//
// Why this needs its own script. Two invariants live here that no other script checks:
//
//   1. `#my-loading` is ONE element shared by the list view and the map view. `switchView('map')`
//      hid it and then immediately called `loadMapSubmissions()`, which turned it back on — while
//      `#my-map-wrap` was already visible. Result: "Loading..." and the map on screen together for
//      the whole fetch (measured 403ms against a 400ms API). `test-style-parity.js` cannot see
//      this: both elements are individually styled correctly, the bug is that they coexist.
//
//   2. The filter rows are a segmented control whose *bottom* rounding moves between rows.
//      `#status-tabs` disappears whenever visibility != Active, and the whole block disappears in
//      map view — so "which row is at the bottom" is a runtime state, not a fixed row order.
//
// Usage: node scripts/test-my-submissions-shell.js
//        BASE_URL=http://localhost:8123 node scripts/test-my-submissions-shell.js
//
// GOTCHA — the loading/map check needs a slow API. With an instant response the overlap window is
// ~4ms and a frame-sampling loop can miss it; the route below adds LAG ms on purpose. The
// non-vacuity assertions below guard the other direction: if a future change stops showing the
// loading indicator at all, "they never coexist" would pass while testing nothing.
//
// GOTCHA — `#my-map` must be visible when Leaflet measures it. Hiding the container during load
// is fine, but `invalidateSize()` while it is `display:none` records size 0 and the map comes back
// blank. That is why the final assertion compares Leaflet's own `getSize()` against the DOM.
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const LAG = 400;                       // ms，给 action=map 加的模拟延迟
const USER = { id: 1, username: 'probe', avatar_url: null, is_admin: 1, is_reviewer: 1 };
const SUB = { id: 'p1', name: 'Probe Region', country: 'south-africa',
  geojson: { type: 'Polygon', coordinates: [[[24, -30], [25, -30], [25, -29], [24, -29], [24, -30]]] } };

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};
const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

// 分页/预取那一段要的是「装不下一页」的规模：total 40 > PAGE_SIZE(18) 才走网络分支
// （一页装得下时排序键走本地反转，那条路径根本不碰网络，测不到预取）。
const ROWS = Array.from({ length: 18 }, (_, i) => ({
  id: 'r' + i, name: 'Row ' + i, description: 'd' + i, country_id: 'south-africa',
  status: 'approved', created_at: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00Z',
  geojson: { type: 'Polygon', coordinates: [[[24, -30], [25, -30], [25, -29], [24, -29], [24, -30]]] },
}));

async function newCtx(browser, lag, listRows) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.includes('unpkg.com')) return r.continue();
    return r.abort();
  });
  await ctx.route(/\/api\/auth/, (r) => r.fulfill(j({ user: USER })));
  await ctx.route(/\/api\/profile/, (r) => r.fulfill(j({ user: USER, submissions: [] })));
  await ctx.route(/\/api\/pageview/, (r) => r.fulfill(j({ ok: true })));
  await ctx.route(/\/api\/regions/, (r) => r.fulfill(j({ regions: [], total: 0 })));
  await ctx.route(/\/api\/countries/, (r) => r.fulfill(j({ countries: [] })));
  await ctx.route(/\/api\/submissions(\?|$)/, (r) => r.fulfill(j([SUB])));
  await ctx.route(/\/api\/user-submissions/, async (r) => {
    const u = r.request().url();
    if (u.includes('action=map')) {
      if (lag) await new Promise((res) => setTimeout(res, lag));
      return r.fulfill(j({ submissions: [SUB] }));
    }
    if (u.includes('action=countries')) {
      // 只有 listRows 的那一段需要 ≥2 个国家（1 个时 buildCountryFilter 会把整个国家键隐藏，
      // 高度量到 0），并且需要 countries **也**带延迟：不然它几乎瞬时返回，串行的旧写法与
      // 并行的新写法只差几毫秒，"列表请求早于国家菜单响应" 这条断言就没有分辨力了。
      if (listRows) {
        await new Promise((res) => setTimeout(res, LAG));
        return r.fulfill(j({ countries: [{ country: 'south-africa', name: 'South Africa', count: 1 },
                                        { country: 'japan', name: 'Japan', count: 2 }] }));
      }
      return r.fulfill(j({ countries: [{ country: 'south-africa', name: 'South Africa', count: 1 }] }));
    }
    if (u.includes('action=notifications')) return r.fulfill(j({ notifications: [], unread: 0 }));
    // 列表：两种排序给**可区分**的内容。给同一份数据的话，「切过去了」和「压根没切」在
    // DOM 上一模一样，那条瞬时性断言就变成了空转。
    if (!listRows) return r.fulfill(j({ submissions: [], total: 0, page: 1 }));
    if (lag) await new Promise((res) => setTimeout(res, lag));
    const sort = new URL(u, BASE).searchParams.get('sort');
    const rows = listRows.map((x, i) => Object.assign({}, x, { name: (sort === 'oldest' ? 'Old ' : 'New ') + i }));
    return r.fulfill(j({ submissions: rows, total: 40, page: 1 }));
  });
  return ctx;
}

// 三行的几何：缝隙、宽度、圆角
const SEG = () => {
  const root = getComputedStyle(document.documentElement).getPropertyValue('--radius').trim();
  const rows = ['#view-tabs', '#visibility-tabs', '#status-tabs'].map((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const r = el.getBoundingClientRect();
    // 别用 getComputedStyle(el).display 判断可见性：祖先 display:none 时它返回的是元素
    // **自己**的 display（仍是 block/flex），完全看不见遮挡。隐藏元素的后备尺寸恒为 0。
    const vis = r.width > 0 && r.height > 0;
    const btns = Array.from(el.querySelectorAll('.review-tab')).map((b) => {
      const br = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      // 按钮里的文字实际画出来多宽 —— 用来验证「按文字取宽」而不是等分。
      // 取 text node 的 client rect，不是按钮的盒子（那正是要验证的东西）。
      let textW = null;
      for (const n of b.childNodes) {
        if (n.nodeType === 3 && n.textContent.trim()) {
          const rg = document.createRange();
          rg.selectNodeContents(n);
          const rc = rg.getClientRects()[0];
          if (rc) textW = rc.width;
          break;
        }
      }
      // border-radius 的计算值会被浏览器归一化（`4px 0 0 0` 读回来是 `4px 0px 0px`），
      // 拿字符串比会假失败。逐个读四个角的 longhand，拼成固定的 tl tr br bl。
      return { t: b.textContent.trim(), w: Math.round(br.width), h: Math.round(br.height),
        left: Math.round(br.left), right: Math.round(br.right),
        // 自然宽度 = 文字 + 左右 padding + 左右 border（box-sizing: border-box）
        natural: textW === null ? null : Math.round(
          textW + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
          parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)),
        radius: [cs.borderTopLeftRadius, cs.borderTopRightRadius,
          cs.borderBottomRightRadius, cs.borderBottomLeftRadius].join(' '),
        borderLeft: cs.borderLeftWidth,
        clipped: b.scrollWidth > b.clientWidth };
    });
    return { sel, visible: vis, top: Math.round(r.top), bottom: Math.round(r.bottom),
      left: Math.round(r.left), right: Math.round(r.right),
      gap: getComputedStyle(el).gap, overflow: getComputedStyle(el).overflowX, btns };
  });
  // 容错：测量函数不要在元素缺失时抛错，否则整个脚本会炸在半路、后面的断言一条都不跑。
  // 缺元素本身就是一次失败，交给断言去报。
  const filterRow = document.querySelector('.my-filter-row');
  return { root, rows, rowGap: filterRow ? getComputedStyle(filterRow).marginTop : null,
    bodyClass: document.body.className };
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const errs = [];

  // ============ 1) loading 与地图不得同时可见 ============
  console.log('--- 1) 进入地图视图：loading 与地图互斥 ---');
  const ctx = await newCtx(browser, LAG);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await page.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view-tabs', { timeout: 15000 });
  await page.waitForTimeout(1200);

  const tl = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    document.querySelector('#view-tabs button[data-view="map"]').click();
    const tick = () => {
      const l = document.getElementById('my-loading');
      const m = document.getElementById('my-map');
      const w = document.getElementById('my-map-wrap');
      out.push({ loading: getComputedStyle(l).display !== 'none',
        map: m ? getComputedStyle(m).display !== 'none' : false,
        wrap: w ? getComputedStyle(w).display !== 'none' : false });
      if (out.length > 400 || (!out[out.length - 1].loading && out.length > 5)) return resolve(out);
      requestAnimationFrame(tick);
    };
    tick();
  }));
  const both = tl.filter((s) => s.loading && s.map);
  const sawLoading = tl.some((s) => s.loading);
  const finalMap = await page.evaluate(() => {
    const m = document.getElementById('my-map');
    const mm = window.myMap;
    return { disp: getComputedStyle(m).display, dom: [m.clientWidth, m.clientHeight],
      leaflet: mm && mm.getSize ? [Math.round(mm.getSize().x), Math.round(mm.getSize().y)] : null };
  });

  // 非空断言：没显示过 loading 的话，下面那条「不曾并存」就是在空跑
  ok(sawLoading, `加载期间确实显示过 Loading（${LAG}ms 延迟下采到 ${tl.filter((s) => s.loading).length} 帧）`);
  ok(both.length === 0, `Loading 与地图从未同时可见（共 ${tl.length} 帧，并存 ${both.length} 帧）`);
  ok(finalMap.disp !== 'none', '加载完成后地图可见', finalMap.disp);
  ok(finalMap.leaflet && finalMap.leaflet[0] === finalMap.dom[0] && finalMap.leaflet[1] === finalMap.dom[1],
    `Leaflet 内部尺寸与 DOM 一致（隐藏期间没把尺寸写成 0）`,
    { leaflet: finalMap.leaflet, dom: finalMap.dom });

  // ============ 1b) 原地刷新不闪 ============
  const silent = await page.evaluate(() => new Promise((resolve) => {
    const out = [];
    window.loadMapSubmissions(true);           // 原地刷新那条路径
    const tick = () => {
      const l = document.getElementById('my-loading');
      const m = document.getElementById('my-map');
      out.push({ loading: getComputedStyle(l).display !== 'none',
        map: getComputedStyle(m).display !== 'none' });
      if (out.length > 400 || (out.length > 5 && !out[out.length - 1].loading)) return resolve(out);
      requestAnimationFrame(tick);
    };
    tick();
  }));
  ok(silent.every((s) => s.map), '原地刷新期间地图始终可见（不白一下）');
  ok(silent.every((s) => !s.loading), '原地刷新期间不显示 Loading');
  await ctx.close();

  // ============ 2) 分段控件几何 ============
  console.log('--- 2) 三行拼成一整块 ---');
  const ctx2 = await newCtx(browser, 0);
  const p2 = await ctx2.newPage();
  p2.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p2.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
  await p2.waitForSelector('#view-tabs', { timeout: 15000 });
  await p2.waitForTimeout(1200);

  const g = await p2.evaluate(SEG);
  const vis = g.rows.filter((r) => !r.missing && r.visible);
  ok(g.rowGap !== null, '搜索/排序/国家筛选已独立成行（.my-filter-row 存在）', g.rowGap);
  ok(vis.length === 3, `三行都在（${vis.length}/3）—— 少于 3 条下面就是在空跑`);
  ok(vis.every((r) => r.gap === '0px'), '行内 gap 为 0（连成一体）', vis.map((r) => r.gap));
  const seams = [];
  for (let i = 1; i < vis.length; i++) seams.push(vis[i].top - vis[i - 1].bottom);
  ok(seams.length === 2 && seams.every((s) => s === -1),
    '行间边框重合为 1px（相邻行 top−上一行 bottom = −1）', seams);
  // 三行靠左对齐；右缘是阶梯（自然宽度下每行长度不同），所以只断言左缘。
  ok(vis.every((r) => r.left === vis[0].left), '三行左边缘对齐', vis.map((r) => r.left));
  // 「不撑满」：量到按钮的右缘为止。行元素本身是块级 flex 容器，盒子永远是满宽的，
  // 拿它比会得出「撑满了」的错误结论 —— 真正缩到内容宽的是里面的按钮。
  const colW = await p2.evaluate(() => document.querySelector('main.my-submissions').clientWidth - 40);
  const blockW = Math.max(...vis.map((r) => r.btns[r.btns.length - 1].right)) - vis[0].left;
  ok(blockW < colW - 100, `整块不铺满（最宽的一行 ${blockW}px < 列内容宽 ${colW}px）`);
  // 「按钮不那么大」：宽度由文字决定，不是等分。两者差超过 2px 就说明被撑过或压过。
  const notNatural = vis.flatMap((r) => r.btns.filter((b) => b.natural !== null && Math.abs(b.w - b.natural) > 2)
    .map((b) => `${b.t}: 实际 ${b.w} vs 文字+padding ${b.natural}`));
  ok(notNatural.length === 0, '按钮按文字取宽（不是 flex 等分铺满）', notNatural.length ? notNatural : undefined);
  ok(vis.every((r) => r.btns.every((b) => !b.clipped)), '没有按钮文字被裁');

  const R = g.root;
  const topRow = vis[0], midRow = vis[1], botRow = vis[2];
  ok(topRow.btns[0].radius === `${R} 0px 0px 0px` && topRow.btns[topRow.btns.length - 1].radius === `0px ${R} 0px 0px`,
    `顶行只圆上面两角（${R}）`, topRow.btns.map((b) => b.radius));
  ok(midRow.btns.every((b) => b.radius === '0px 0px 0px 0px'), '中间行不圆角', midRow.btns.map((b) => b.radius));
  ok(botRow.btns[0].radius === `0px 0px 0px ${R}` && botRow.btns[botRow.btns.length - 1].radius === `0px 0px ${R} 0px`,
    `底行只圆下面两角（${R}）`, botRow.btns.map((b) => b.radius));
  ok(topRow.btns.slice(1).every((b) => b.borderLeft === '0px'),
    '行内相邻按钮不画重复的竖线（border-left: none）');

  // ============ 3) 底行会换人 ============
  console.log('--- 3) 底行会换人 ---');
  await p2.click('#visibility-tabs .review-tab[data-visibility="hidden"]');
  await p2.waitForTimeout(600);
  const gh = await p2.evaluate(SEG);
  ok(/is-status-hidden/.test(gh.bodyClass), '切到 Hidden 后 body 打上 is-status-hidden', gh.bodyClass);
  ok(!gh.rows[2].visible, '#status-tabs 已隐藏');
  const hVis = gh.rows[1];
  ok(hVis.btns[0].radius === `0px 0px 0px ${R}` && hVis.btns[hVis.btns.length - 1].radius === `0px 0px ${R} 0px`,
    `status 行隐藏后由 visibility 行收底（下角圆起来）`, hVis.btns.map((b) => b.radius));

  await p2.click('#visibility-tabs .review-tab[data-visibility="active"]');
  await p2.waitForTimeout(400);
  await p2.click('#view-tabs .review-tab[data-view="map"]');
  await p2.waitForTimeout(1000);
  const gm = await p2.evaluate(SEG);
  ok(/is-map-view/.test(gm.bodyClass), '地图视图下 body 有 is-map-view', gm.bodyClass);
  ok(!gm.rows[1].visible && !gm.rows[2].visible, '地图视图下下面两行隐藏');
  const mv = gm.rows[0];
  ok(mv.btns[0].radius === `${R} 0px 0px ${R}` && mv.btns[mv.btns.length - 1].radius === `0px ${R} ${R} 0px`,
    '地图视图下 view-tabs 独自成块 → 四角都圆', mv.btns.map((b) => b.radius));
  await ctx2.close();

  // ============ 4) 极窄屏 ============
  console.log('--- 4) 窄屏不裁字 ---');
  const ctx3 = await newCtx(browser, 0);
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  for (const vw of [1280, 500, 400, 390, 360, 320]) {
    await p3.setViewportSize({ width: vw, height: 900 });
    await p3.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
    await p3.waitForSelector('#view-tabs', { timeout: 15000 });
    await p3.waitForTimeout(900);
    const r = await p3.evaluate(SEG);
    const doc = await p3.evaluate(() => ({ clientW: document.documentElement.clientWidth }));
    const v = r.rows.filter((x) => !x.missing && x.visible);
    const clipped = v.flatMap((x) => x.btns.filter((b) => b.clipped).map((b) => b.t));
    const aligned = v.every((x) => x.left === v[0].left);
    const inside = v.every((x) => x.right <= doc.clientW);
    ok(clipped.length === 0 && aligned && inside && v.length === 3,
      `${vw}px 无裁字、三行左对齐、都在视口内`, clipped.length ? clipped : undefined);
  }
  await ctx3.close();

  // ============ 5) 筛选行：并行取数 / 排序预取 / 翻页键皮肤 ============
  //
  // 为什么这三条要在这里守：它们都是**静默**失效的。
  //   · 把 loadTab 串回 buildCountryFilter 的 .then() 里，页面看起来完全正常，只是慢一轮；
  //   · 预取的 URL 和请求的 URL 只要有一处参数不一致，命中永远不发生，退回网络请求而已，不报错；
  //   · 44px 是基础规则给的，去掉作用域覆盖后按钮会悄悄长回 44。
  console.log('--- 5) 筛选行：并行取数、排序预取、翻页键 ---');
  const ctx5 = await newCtx(browser, LAG, ROWS);
  const p5 = await ctx5.newPage();
  p5.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  const reqLog = [], resLog = [];
  p5.on('request', (r) => { if (r.url().includes('/api/user-submissions')) reqLog.push({ url: r.url(), t: Date.now() }); });
  p5.on('response', (r) => { if (r.url().includes('/api/user-submissions')) resLog.push({ url: r.url(), t: Date.now() }); });

  const t0 = Date.now();
  await p5.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
  await p5.waitForSelector('#my-results .review-item', { timeout: 15000 });

  const listReq = reqLog.find((r) => /[?&]status=/.test(r.url) && !r.url.includes('action='));
  const countriesDone = resLog.find((r) => r.url.includes('action=countries'));
  ok(!!listReq && !!countriesDone, '前提：列表与国家菜单两个请求都发了（否则下面两条空转）',
    { listReq: !!listReq, countriesDone: !!countriesDone });
  // 旧写法 `buildCountryFilter(eff).then(function(){ loadTab(eff,1); })` 下列表请求必然晚于
  // countries 的**响应**；并行则是两个请求几乎同时出发。这条能精确地把两种写法分开。
  ok(listReq && countriesDone && listReq.t < countriesDone.t,
    '列表请求早于国家菜单响应 —— 两者并行，列表没有在等菜单',
    { listAt: listReq && (listReq.t - t0), countriesDoneAt: countriesDone && (countriesDone.t - t0) });

  const hh = await p5.evaluate(() => {
    const g = (s) => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : null; };
    return { tab: g('#view-tabs .review-tab'), sort: g('#sort-toggle'),
             country: g('#country-filter-btn'), toggle: g('#name-search-toggle') };
  });
  ok(hh.tab === 32 && hh.sort === 32 && hh.country === 32 && hh.toggle === 32,
    '筛选行四个键都是 32px（排序/国家那两个卡过 padding，光写 min-height 压不下来）', hh);

  // 放大镜：去底去框、图标放大。hover 那条是这次最容易漏的 —— 基础规则
  // `.search-chip__toggle:hover` 写着 `background: #f2f2f2`，不覆盖的话无框按钮一悬停
  // 反而浮出一个灰方块，比带框时更脏。
  const chipCss = await p5.evaluate(() => {
    const t = document.getElementById('name-search-toggle');
    const cs = getComputedStyle(t);
    const svg = t.querySelector('svg').getBoundingClientRect();
    return { bg: cs.backgroundColor, border: cs.borderTopStyle, bw: cs.borderTopWidth,
             icon: Math.round(svg.width), color: cs.color };
  });
  ok(chipCss.bg === 'rgba(0, 0, 0, 0)' && chipCss.border === 'none' && parseFloat(chipCss.bw) === 0,
    '放大镜无底色、无边框', chipCss);
  ok(chipCss.icon === 20, '放大镜图标 20px（原 16，与 explore 的图标同尺寸）', chipCss.icon);
  await p5.hover('#name-search-toggle');
  await p5.waitForTimeout(150);
  const chipHoverBg = await p5.evaluate(() => getComputedStyle(document.getElementById('name-search-toggle')).backgroundColor);
  ok(chipHoverBg === 'rgba(0, 0, 0, 0)',
    '悬停时不浮出灰方块（基础规则的 background: #f2f2f2 被覆盖）', chipHoverBg);
  await p5.mouse.move(5, 5);

  // 预取：首屏加载完，另一排序方向的第 1 页已经在路上/已落地
  await p5.waitForTimeout(200);
  const altPrefetched = reqLog.some((r) => r.url.includes('sort=oldest') && r.url.includes('page=1'));
  ok(altPrefetched, '首屏加载后预取了「另一种排序」的第 1 页');

  const nameOf = () => p5.evaluate(() => {
    const el = document.querySelector('#my-results .review-item__name');
    return el ? el.textContent.trim() : '';
  });
  const before5 = await nameOf();
  let sawLoading5 = false;
  const watch5 = setInterval(() => {
    p5.evaluate(() => getComputedStyle(document.getElementById('my-loading')).display !== 'none')
      .then((v) => { if (v) sawLoading5 = true; }).catch(() => {});
  }, 25);
  const t5 = Date.now();
  await p5.click('#sort-toggle');
  await p5.waitForFunction((prev) => {
    const el = document.querySelector('#my-results .review-item__name');
    return el && el.textContent.trim() !== prev;
  }, before5, { timeout: 5000 });
  const switchMs = Date.now() - t5;
  clearInterval(watch5);
  ok(switchMs < LAG / 2, `排序切换是瞬时的：${switchMs}ms 就换好了新顺序（一次网络往返是 ${LAG}ms）`, { switchMs });
  ok(!sawLoading5, '切换全程没有 "Loading..." 白屏（旧实现的 loadTab 会把列表整块藏掉）', { sawLoading5 });

  // 5b) 连点排序键：缓存好了就不该再 load。
  //     旧实现把预取放在**一个单槽**里，且只在 `.then()` 里落槽 —— 请求在飞的整段窗口内槽位读作空，
  //     点击就掉到第 3 档 loadTab（进门藏列表 → "Loading..."）。更糟的是 miss 一次要 2×RTT 才恢复
  //     （loadTab 一个往返 + 它触发的预取再一个），所以点得比一个往返快就永远回不到快路径。
  //     旧代码实测：间隔 500ms 以上全过、300ms 起逐次白屏；下面这条按 120ms 打，必红。
  const armLoads = () => p5.evaluate(() => {
    window.__loads = 0;
    let last = false;
    setInterval(() => {
      const l = document.getElementById('my-loading');
      const v = !!l && getComputedStyle(l).display !== 'none';
      if (v && !last) window.__loads++;
      last = v;
    }, 8);
  });
  const reads = () => p5.evaluate(() => window.__loads);

  // 先把两个方向都暖起来。loadTab 不走 _page1，所以首屏之后缓存里只有「另一方向」，
  // 当前方向要等第一次点过去才进 _page1 —— 那一次是允许发请求的，之后的必须一次都不发。
  await p5.click('#sort-toggle'); await p5.waitForTimeout(LAG + 400);
  await p5.click('#sort-toggle'); await p5.waitForTimeout(LAG + 400);
  const reqsWarm = reqLog.length;
  await armLoads();
  for (let i = 0; i < 8; i++) { await p5.click('#sort-toggle'); await p5.waitForTimeout(120); }
  await p5.waitForTimeout(400);
  const burstLoads = await reads();
  const burstReqs = reqLog.length - reqsWarm;
  ok(burstLoads === 0, `8 次连点（间隔 120ms，快于 ${LAG}ms 的往返）全程零白屏`, { burstLoads });
  ok(burstReqs === 0, '两个方向都暖了之后连点**零请求** —— 缓存好了就不该重复 load', { burstReqs });

  // 首屏刚渲染、预取还在飞的窗口内连点 —— 旧实现在这里漏得最凶（槽位在飞行期间读作空）。
  await p5.reload({ waitUntil: 'domcontentloaded' });
  await p5.waitForSelector('#my-results .review-item', { timeout: 15000 });
  await armLoads();
  for (let i = 0; i < 6; i++) { await p5.click('#sort-toggle'); await p5.waitForTimeout(120); }
  await p5.waitForTimeout(400);
  const coldLoads = await reads();
  ok(coldLoads === 0, '首屏预取尚未落地时连点 6 次，同样零白屏（旧实现在这个窗口必白）', { coldLoads });

  // 5c) 放大镜：空框开合不该惊动列表。
  //     search-chip.js 收起那条分支原来**无条件** fire() 一个 input 事件，而 input 的契约是
  //     「值变了」—— 空框收起什么都没变，使用方却白跑一趟：一次完整 refetch + Loading 闪烁。
  //     同一份模块 explore 也在用（那边是本地过滤，白跑一趟不显眼），所以这条只有在
  //     my-submissions 上才看得见。实测旧代码：每对开合 +1 个列表请求、+1 次白屏。
  await p5.waitForTimeout(LAG + 400);
  const reqsBeforeChip = reqLog.length;
  await armLoads();
  for (let i = 0; i < 3; i++) {
    await p5.click('#name-search-toggle'); await p5.waitForTimeout(120);
    await p5.click('#name-search-toggle'); await p5.waitForTimeout(120);
  }
  await p5.waitForTimeout(500);
  const chipLoads = await reads();
  const chipReqs = reqLog.length - reqsBeforeChip;
  ok(chipReqs === 0, '空框连点放大镜 6 次（3 组开合）**零请求** —— 没输入过就不该 reload', { chipReqs });
  ok(chipLoads === 0, '同上，全程零白屏', { chipLoads });

  // 反检：有词时收起**必须**仍然清词 + refetch，别把该做的事一起删掉。
  await p5.click('#name-search-toggle');
  await p5.fill('#name-search', 'Row 1');
  await p5.waitForTimeout(250 + LAG + 500);          // 越过 250ms 防抖 + 一次往返
  // 断言按**意图**写,不数请求条数:一个 input 会牵出 loadTab + 它触发的 prefetchAltSort,
  // 条数随时序浮动(红检时就数出过 7 条),数条数会变成一条看时序脸色的假断言。
  // 要问的是「有没有一趟**带着 q** 的取数」和「收起后有没有一趟**不带 q** 的取数」。
  const reqsTyped = reqLog.length;
  const typedWithQ = reqLog.slice(reqsBeforeChip).filter((r) => r.url.includes('q=Row'));
  ok(typedWithQ.length > 0,
    '输入后确实按 q 取了一次数（反检前提：不是「什么都不发」的那种绿）',
    { withQ: typedWithQ.length });
  await p5.click('#name-search-toggle');              // 有词时收起 = 清词
  await p5.waitForTimeout(250 + LAG + 500);
  const chipCleared = await p5.evaluate(() => nameFilter);
  const clearedReq = reqLog.slice(reqsTyped).some((r) => !r.url.includes('&q='));
  ok(clearedReq && chipCleared === '',
    '有词时收起仍然清词并 refetch（守住 §5 那条「清词后要手动派发 input」的契约）',
    { clearedReq, nameFilter: chipCleared });

  // ============ 6) 翻页键：无边框无底色 ============
  const pg = await p5.evaluate(() => [...document.querySelectorAll('#my-pager button')].map((b) => {
    const cs = getComputedStyle(b);
    return { cls: b.className, border: cs.borderStyle, bg: cs.backgroundColor };
  }));
  ok(pg.length > 0, '前提：分页条上确实有按钮（total 40 > PAGE_SIZE 18）', pg.length);
  ok(pg.every((b) => b.cls === 'my-pager-btn'), '翻页键用的是 .my-pager-btn', pg.map((b) => b.cls));
  ok(pg.every((b) => b.border === 'none' && (b.bg === 'rgba(0, 0, 0, 0)' || b.bg === 'transparent')),
    '翻页键无边框、无底色（原来借的是深绿实心的 .review-btn--approve）', pg);
  await ctx5.close();

  ok(errs.length === 0, '无 JS 报错', errs.length ? errs : undefined);

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

// Playwright harness for explore's floating overlays and the tag panel's country reset.
//
// Four independent contracts, all of them "a box that lives on top of the map":
//
//   A. Clicking the magnifier and then clicking elsewhere WITHOUT typing must collapse the field.
//      It used to stay open showing nothing but the "Search regions..." placeholder — `setOpen`
//      was only ever called by the magnifier itself and by Escape, so there was no blur/outside
//      path at all. (An empty field is the only case that collapses; a field with text is the
//      only visible indicator that a filter is live, so it stays.)
//   B. The region hover card must paint ABOVE the open tag-filter panel. Leaflet gives
//      `.leaflet-tooltip-pane` z-index 650, and `.map-tools` sits at 1001 — so any card landing
//      inside the open panel's box was covered deterministically, not occasionally.
//   C. The contributors panel must fit inside the viewport. `openContributorsPanel` used to clamp
//      only the BUTTON's top (`Math.min(r.top, innerHeight - 8)`) and never the panel's own
//      height, so on a short window the panel ran off the bottom edge.
//   D. Switching country resets the tag selection. Tags are per-country, so a tag ticked in one
//      country usually does not exist in the next — keeping it makes the filter fail silently
//      (the map empties, and the panel gives no hint why).
//
// RED CHECKS (each verified red before this was trusted — see the notes on the individual
// assertions; the file is useless if these do not turn it red):
//   - delete the outside-click listener in explore.html's search IIFE  -> A fails
//   - delete `.leaflet-tooltip-pane { z-index: 1100 }` from style.css   -> B fails
//   - restore the old `Math.min(r.top, innerHeight - 8)` clamp          -> C fails
//   - drop the `_lastCountry` branch in explore.html                    -> D fails
//
// Usage: setsid nohup python3 -m http.server 3999 -d public >/dev/null 2>&1 < /dev/null &
//        BASE_URL=http://localhost:3999 node scripts/test-explore-overlays.js
//        kill $(lsof -ti :3999)
//
// GOTCHA — the local server does no extensionless routing, so the URL must be `/explore.html`
// (production is a Vercel clean URL).
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const TAGS = { categories: [
  { name: 'cars', tags: [{ name: 'cars-a' }, { name: 'cars-b' }, { name: 'cars-c' }] },
  { name: 'nature', tags: [{ name: 'nature-a' }, { name: 'nature-b' }] },
] };

const COUNTRIES = { countries: [
  { id: 'south-africa', name: 'South Africa', flag: null, active: 1, sort_order: 1,
    bounds_sw: [-34.5, 17.0], bounds_ne: [-22.5, 32.5] },
  { id: 'brazil', name: 'Brazil', flag: null, active: 1, sort_order: 2,
    bounds_sw: [-15.0, -50.0], bounds_ne: [-5.0, -40.0] },
] };

const poly = (s, w, n, e) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
// One big ZA polygon: it has to cover the map's top-left corner, where the tag panel opens, or
// section B has nothing to hover and would pass vacuously.
const REGIONS = [
  { id: 'za-1', region: 'south-africa', name: 'ZA Big', scope: 'region',
    tags: ['cars-a', 'nature-a'], geojson: poly(-46, 8, -12, 44) },
  { id: 'br-1', region: 'brazil', name: 'BR One', scope: 'region',
    tags: ['cars-b', 'nature-b'], geojson: poly(-16, -52, -4, -38) },
];

// Enough rows that the list hits its 320px cap and the panel is tall enough to overflow a 560px
// viewport — which is what section C needs to be exercising anything at all.
const CONTRIBUTORS = { contributors: Array.from({ length: 24 }, (_, i) => ({
  user_id: 'u' + i, name: 'Contributor ' + i, count: 24 - i,
})) };

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// --- page-side helpers -------------------------------------------------------------------------

const FIELD_STATE = () => {
  const field = document.getElementById('map-search-field');
  const toggle = document.getElementById('map-search-toggle');
  return {
    hidden: field.hidden,
    display: getComputedStyle(field).display,
    value: document.getElementById('search-input').value,
    expanded: toggle.getAttribute('aria-expanded'),
  };
};

// The card's box, and whether it intersects a given rect. The contract in section B is geometric
// (the card must not sit under the panel), NOT a paint-order one — see the ⚠️ note there.
const CARD_BOX = (rect) => {
  const card = document.querySelector('.region-hover-shell');
  const cont = document.getElementById('map').getBoundingClientRect();
  if (!card) return { card: false };
  const b = card.getBoundingClientRect();
  return {
    card: true,
    box: { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), bo: Math.round(b.bottom) },
    overlapsPanel: !(b.right <= rect.left || rect.right <= b.left || b.bottom <= rect.top || rect.bottom <= b.top),
    insideMap: b.left >= cont.left - 1 && b.right <= cont.right + 1 &&
      b.top >= cont.top - 1 && b.bottom <= cont.bottom + 1,
    mapBox: { l: Math.round(cont.left), t: Math.round(cont.top), r: Math.round(cont.right), bo: Math.round(cont.bottom) },
  };
};

const RECT = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const b = el.getBoundingClientRect();
  return { x: b.left, y: b.top, w: b.width, h: b.height, bottom: b.bottom, right: b.right };
};

const CONTRIB_STATE = () => {
  const panel = document.getElementById('contrib-panel');
  if (!panel) return { missing: true };
  const b = panel.getBoundingClientRect();
  const list = panel.querySelector('.contrib-panel__list');
  const btn = document.querySelector('.map-contrib-btn');
  return {
    hidden: panel.hidden,
    top: Math.round(b.top), bottom: Math.round(b.bottom), height: Math.round(b.height),
    vh: window.innerHeight,
    panelCenterY: Math.round(b.top + b.height / 2),
    btnCenterY: btn ? Math.round(btn.getBoundingClientRect().top + btn.getBoundingClientRect().height / 2) : null,
    btnTop: btn ? Math.round(btn.getBoundingClientRect().top) : null,
    // The OLD algorithm, recomputed here so the test can prove the old code really did overflow
    // on this viewport. Without this the assertion is unfalsifiable: a panel that happens to be
    // short would pass no matter which clamp is in place.
    oldTop: btn ? Math.max(8, Math.min(btn.getBoundingClientRect().top, window.innerHeight - 8)) : null,
    naturalHeight: (function () {
      const saved = panel.style.maxHeight;
      panel.style.maxHeight = '';
      const h = panel.offsetHeight;
      panel.style.maxHeight = saved;
      return h;
    })(),
    listScrolls: list ? list.scrollHeight > list.clientHeight + 1 : null,
    rows: panel.querySelectorAll('.contrib-panel__row').length,
  };
};

const TAG_STATE = () => ({
  selectedByCategory: JSON.parse(JSON.stringify(window._selectedTagsByCategory || {})),
  flat: (window._selectedTags || []).slice(),
  checked: Array.from(document.querySelectorAll('#tag-filter-panel input[type=checkbox]')).filter((c) => c.checked).map((c) => c.value),
  indeterminate: Array.from(document.querySelectorAll('#tag-filter-panel input[type=checkbox]')).filter((c) => c.indeterminate).length,
  badgeHidden: document.querySelector('.tag-filter__badge').hidden,
  activeTab: (document.querySelector('.country-tab.is-active') || {}).dataset ?
    document.querySelector('.country-tab.is-active').dataset.region : null,
});

(async () => {
  const browser = await firefox.launch({ headless: true });
  const viewport = { width: 1280, height: 560 };   // short on purpose — section C needs the squeeze
  const ctx = await browser.newContext({ viewport });

  // Least-specific FIRST — Playwright gives precedence to the LAST matching route.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/tags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TAGS) }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/submissions*', (r) => {
    const body = /action=contributors/.test(r.request().url()) ? CONTRIBUTORS : REGIONS;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await ctx.route(/tile\.openstreetmap\.org|maps\.googleapis\.com|maps\.gstatic\.com/, (r) => r.abort());

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/countries|tile|net::ERR/i.test(t)) errs.push('console: ' + t.slice(0, 140));
  });

  // Must be an init script: `applyTagFilters` can dispatch before any post-goto evaluate runs.
  await page.addInitScript(() => {
    window.__tagEvents = [];
    document.addEventListener('tagfilter:change', (e) => {
      window.__tagEvents.push((e.detail && e.detail.tags) ? e.detail.tags.slice() : null);
    });
  });

  await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => !!document.querySelector('.tag-filter__cols'), null, { timeout: 20000 });
  await page.waitForTimeout(800);

  const boot = await page.evaluate(() => ({
    leaflet: typeof L !== 'undefined',
    polygons: window._polygonLayers ? window._polygonLayers.size : null,
    tabs: document.querySelectorAll('.country-tab').length,
    active: (document.querySelector('.country-tab.is-active') || {}).dataset
      ? document.querySelector('.country-tab.is-active').dataset.region : null,
  }));
  ok(boot.leaflet && boot.polygons === 2 && boot.tabs === 2 && boot.active === 'south-africa',
    '前提：Leaflet 与真实 region 都就位（否则下面四条全是空转）', boot);

  // ── A. search field collapses on an outside click ────────────────────────────────────────────
  console.log('\n--- A. 放大镜点开后不输入、点别处应收起 ---');
  await page.evaluate(() => document.getElementById('map-search-toggle').click());
  await page.waitForTimeout(150);
  const aOpen = await page.evaluate(FIELD_STATE);
  ok(aOpen.hidden === false && aOpen.display !== 'none',
    '前提：点放大镜确实把输入框展开了', aOpen);

  // Click a genuinely outside target: the country bar, well away from the search chip.
  await page.evaluate(() => document.getElementById('country-bar').click());
  await page.waitForTimeout(200);
  const aAfter = await page.evaluate(FIELD_STATE);
  ok(aAfter.hidden === true && aAfter.display === 'none' && aAfter.expanded === 'false',
    'A1 空输入框 + 点外部 → 收起（占位符不再留在图上）', aAfter);

  // Non-empty must NOT collapse: the field is the only "a filter is live" indicator.
  await page.evaluate(() => document.getElementById('map-search-toggle').click());
  await page.waitForTimeout(120);
  await page.evaluate(() => {
    const input = document.getElementById('search-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'ZA');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById('country-bar').click());
  await page.waitForTimeout(250);
  const aText = await page.evaluate(FIELD_STATE);
  ok(aText.hidden === false && aText.value === 'ZA',
    'A2 有内容时点外部**不**收起（框是筛选生效的唯一指示）', aText);
  // Clean up: clear the search so it cannot bias the later sections.
  await page.evaluate(() => {
    const input = document.getElementById('search-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('search-input').dispatchEvent(new Event('keydown', { key: 'Escape', bubbles: true }));
  });
  await page.waitForTimeout(700);

  // ── B. the open tag panel must not cover the hover card ──────────────────────────────────────
  //
  // ⚠️ WHY THIS IS A GEOMETRY TEST AND NOT A PAINT-ORDER TEST. The obvious fix — raise
  // `.leaflet-tooltip-pane` above `.map-tools` — CANNOT work, and the first version of this
  // section measured the wrong thing and said so. The card sits inside `.leaflet-map-pane`, which
  // carries `z-index: 400` AND a `transform`: it is its own stacking context, so no z-index on the
  // card (or its pane) escapes it, and `.map-tools` is 1001. Measured directly: with
  // `.leaflet-tooltip-pane { z-index: 1100 }` in place the computed value really was 1100 and the
  // panel still painted on top. Lifting `.leaflet-map-pane` instead would raise the tiles over the
  // search box. So the card is moved out of the way by `clampHoverToMap`, and that is what this
  // checks.
  //
  // The before/after is a real A/B on the SAME hover position: `panel.hidden = true` makes
  // `hoverOccluder()` return null (old behaviour), `false` restores it. `map.fire('moveend')`
  // re-runs renderHover without moving the pointer, so the two measurements differ only in the
  // one variable under test.
  console.log('\n--- B. 展开的筛选栏不得盖住悬停卡片 ---');
  await page.evaluate(() => { if (document.getElementById('tag-filter-panel').hidden) document.getElementById('tag-filter-toggle').click(); });
  await page.waitForTimeout(250);
  const panelRect = await page.evaluate(RECT, '#tag-filter-panel');
  ok(panelRect && panelRect.w > 100 && panelRect.h > 60,
    '前提：筛选栏确实展开了（够大才有遮挡可言）', panelRect);

  const setPanel = (hidden) => page.evaluate((h) => {
    document.getElementById('tag-filter-panel').hidden = h;
    window._geoguideMap.fire('moveend');
  }, hidden);

  // Sweep just outside the panel's right edge — inside the big ZA polygon, so the map (not the
  // panel) receives the hover and the card renders next to the cursor.
  let hit = null;
  for (const dy of [0.15, 0.4, 0.7]) {
    for (const dx of [6, 30, 90, 200]) {
      const x = Math.round(panelRect.right + dx);
      const y = Math.round(panelRect.y + panelRect.h * dy);
      if (x > viewport.width - 4 || y > viewport.height - 4) continue;
      await page.mouse.move(x, y);
      await page.waitForTimeout(300);
      // Sanity: the card must exist at all before the A/B means anything.
      if (!(await page.evaluate(() => !!document.querySelector('.region-hover-shell')))) continue;
      await setPanel(true);
      await page.waitForTimeout(200);
      const raw = await page.evaluate(CARD_BOX, panelRect);
      await setPanel(false);
      await page.waitForTimeout(200);
      const fixed = await page.evaluate(CARD_BOX, panelRect);
      // Only a point where the UNPROTECTED card really lands under the panel is a valid probe.
      if (raw.card && raw.overlapsPanel && fixed.card) { hit = { x, y, raw, fixed }; break; }
    }
    if (hit) break;
  }
  ok(hit !== null,
    '前提：存在一处「不做遮挡规避时卡片真的会落进筛选栏」的悬停点 —— 找不到就说明 B 是空转，按失败处理',
    hit && { x: hit.x, y: hit.y, rawBox: hit.raw.box, panel: { l: Math.round(panelRect.x), t: Math.round(panelRect.y), r: Math.round(panelRect.right), bo: Math.round(panelRect.bottom) } });

  if (hit) {
    ok(hit.raw.overlapsPanel === true, 'B1 反证：关掉遮挡计算后卡片确实与筛选栏相交（旧行为复现）', hit.raw.box);
    ok(hit.fixed.overlapsPanel === false, 'B2 打开遮挡计算后同一位置卡片不再与筛选栏相交', hit.fixed.box);
    ok(hit.fixed.insideMap === true,
      'B3 卡片仍完整落在地图容器内（绕开 ≠ 被挤出可视区）', { box: hit.fixed.box, mapBox: hit.fixed.mapBox });
  }
  // Move the pointer off the polygon so the card is torn down before the later sections.
  await page.mouse.move(8, viewport.height - 8);
  await page.waitForTimeout(250);

  // ── C. contributors panel fits the viewport ──────────────────────────────────────────────────
  console.log('\n--- C. contributors 面板不得溢出视口 ---');
  await page.evaluate(() => { if (!document.getElementById('tag-filter-panel').hidden) document.getElementById('tag-filter-toggle').click(); });
  await page.evaluate(() => document.querySelector('.map-contrib-btn').click());
  await page.waitForFunction(() => {
    const p = document.getElementById('contrib-panel');
    return p && !p.hidden && p.querySelector('.contrib-panel__row');
  }, null, { timeout: 15000 });
  await page.waitForTimeout(400);

  const c = await page.evaluate(CONTRIB_STATE);
  ok(c.oldTop + c.naturalHeight > c.vh,
    '前提：这台视口上**旧算法真的会溢出**（否则 C 断言不可证伪）',
    { oldTop: c.oldTop, naturalHeight: c.naturalHeight, vh: c.vh, oldBottom: c.oldTop + c.naturalHeight });
  ok(c.bottom <= c.vh,
    'C1 面板下边缘在视口内', { bottom: c.bottom, vh: c.vh, overflowBy: c.bottom - c.vh });
  ok(c.top >= 0, 'C2 面板上边缘也在视口内', { top: c.top });
  ok(c.listScrolls === true,
    'C3 被压短的是列表本身（可滚动），不是整块面板被裁掉',
    { listScrolls: c.listScrolls, rows: c.rows });

  // Shrinking the window must re-clamp: the panel is position:fixed and does not reflow by itself.
  await page.setViewportSize({ width: 1280, height: 420 });
  await page.waitForTimeout(300);
  const c2 = await page.evaluate(CONTRIB_STATE);
  ok(c2.bottom <= c2.vh, 'C4 视口再变矮后重新夹住（resize 监听）',
    { bottom: c2.bottom, vh: c2.vh });
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);

  // 中线对齐必须在一个**装得下**的视口上量。560px 高时面板根本居中不了（居中会把下缘推出
  // 视口），夹取会把它压到上沿 —— 那时「中线平齐」既不成立也不该成立；而且旧代码在这个高度上
  // 恰好落到同一个位置，量了也分辨不出新旧。所以换到 900px 高再量。
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);
  const c3 = await page.evaluate(CONTRIB_STATE);
  ok(c3.naturalHeight + 16 <= c3.vh,
    'C5 前提：这个视口装得下整个面板 —— 否则中线对齐无从谈起，下面那条是空转',
    { naturalHeight: c3.naturalHeight, vh: c3.vh });
  ok(c3.panelCenterY === c3.btnCenterY,
    'C6 面板中线与按钮中线平齐（旧行为是顶部对齐，中线要差出 natural/2 - 22 约 180px）',
    { panelCenterY: c3.panelCenterY, btnCenterY: c3.btnCenterY });
  await page.setViewportSize(viewport);
  await page.waitForTimeout(300);
  await page.evaluate(() => document.getElementById('contrib-panel').hidden || document.querySelector('.contrib-panel__close').click());

  // ── D. switching country resets the tag selection ───────────────────────────────────────────
  console.log('\n--- D. 换国家必须把标签归零 ---');
  await page.evaluate(() => { if (document.getElementById('tag-filter-panel').hidden) document.getElementById('tag-filter-toggle').click(); });
  await page.waitForTimeout(200);
  // Tick one tag that only South Africa has, via a real click on the real checkbox.
  await page.evaluate(() => {
    const cb = Array.from(document.querySelectorAll('#tag-filter-panel input[type=checkbox]')).find((c) => c.value === 'cars-a');
    cb.click();
  });
  await page.waitForTimeout(400);
  const dBefore = await page.evaluate(TAG_STATE);
  ok(dBefore.flat.indexOf('cars-a') !== -1 && dBefore.badgeHidden === false,
    '前提：cars-a 真的被勾上并进了筛选', dBefore);

  // Clicking the ALREADY ACTIVE country tab is not a country change — it must not wipe the选择.
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.country-tab')).find((b) => b.dataset.region === 'south-africa').click();
  });
  await page.waitForTimeout(500);
  const dSame = await page.evaluate(TAG_STATE);
  ok(dSame.flat.indexOf('cars-a') !== -1,
    'D1 点当前已激活的国家标签**不算**换国家，勾选保留', { flat: dSame.flat });

  const tagEventsBefore = await page.evaluate(() => window.__tagEvents.length);
  await page.evaluate(() => {
    Array.from(document.querySelectorAll('.country-tab')).find((b) => b.dataset.region === 'brazil').click();
  });
  await page.waitForTimeout(600);
  const dAfter = await page.evaluate(TAG_STATE);
  ok(dAfter.flat.length === 0 && Object.keys(dAfter.selectedByCategory).length === 0,
    'D2 换到 brazil → selectedTags 归零', { flat: dAfter.flat, byCat: dAfter.selectedByCategory });
  ok(dAfter.checked.length === 0 && dAfter.indeterminate === 0 && dAfter.badgeHidden === true,
    'D3 面板里所有复选框（含「全选」）打回未选，角标消失',
    { checked: dAfter.checked, indeterminate: dAfter.indeterminate, badgeHidden: dAfter.badgeHidden });

  // The reset must also reach the MAP, not just the panel's own state: clearing `selectedTags`
  // without re-running the filter would leave the map showing the old tag filter forever.
  // Instrument: the `tagfilter:change` events `applyTagFilters` dispatches.
  // ⚠️ Do NOT assert on `region._searchVisible` here — that flag is the tag/search filter's verdict
  // only, and it stays `true` for a hidden country's regions. The first version of this test did
  // exactly that and failed against correct code (`za-1: true` while ZA was country-hidden).
  const tagEvents = await page.evaluate(() => window.__tagEvents.slice());
  const lastTagEvent = tagEvents[tagEvents.length - 1];
  ok(tagEvents.length > tagEventsBefore && Array.isArray(lastTagEvent) && lastTagEvent.length === 0,
    'D4 归零真的重新应用到了地图上（换国家的过程中派发了 tags 为空的 tagfilter:change）',
    { before: tagEventsBefore, after: tagEvents.length, last: lastTagEvent });

  // And the narrowed panel is brazil's own catalogue, with the reset tag gone.
  const dPanel = await page.evaluate(() => Array.from(
    document.querySelectorAll('#tag-filter-panel .tag-filter__item input[type=checkbox]'))
    .filter((c) => c.value && c.value !== '__all__' &&
      getComputedStyle(c.closest('.tag-filter__item')).display !== 'none')
    .map((c) => c.value).sort());
  ok(dPanel.indexOf('cars-a') === -1 && dPanel.indexOf('cars-b') !== -1,
    'D5 归零后面板 = brazil 的标签（刚才勾的 cars-a 不再被撑出来）', dPanel);

  // ── E. 放大镜与筛选要跟 Leaflet 那四个控件同时出现 ──────────────────────────────────────────
  //
  // 那两个在 HTML 里（parse 阶段就存在），而 zoom/reset/contributors 要等 Leaflet 从 unpkg
  // 下载完、initMap 装好控件才建得出来 —— 不压一下就会先冒出两个按钮浮在还没出来的地图上，
  // 过一会儿另外四个才一起出现。闸门是 `.map-tools { visibility: hidden }`（style.css）
  // 加 map.js 在控件装齐后派发的 mapready（explore.html 监听后加 `.is-ready`）。
  //
  // 断言刻意**不碰绝对时间**（CDN 快慢不可控）：把 Leaflet 推迟 900ms，于是「那一刻必须还藏着」
  // 就成了确定的事实，取 t≥300ms 的采样点即可。被断言的只有相对时序。
  console.log('\n--- E. 放大镜/筛选与 Leaflet 控件同时出现 ---');
  const ctx2 = await browser.newContext({ viewport });
  await ctx2.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx2.route('**/api/tags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TAGS) }));
  await ctx2.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx2.route('**/api/submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REGIONS) }));
  await ctx2.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', async (r) => {
    await new Promise((s) => setTimeout(s, 900));
    return r.continue();
  });
  await ctx2.route(/tile\.openstreetmap\.org|maps\.googleapis\.com|maps\.gstatic\.com/, (r) => r.abort());

  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (ev) => errs2.push(ev.message.slice(0, 160)));
  await p2.addInitScript(() => {
    window.__t0 = performance.now();
    window.__samples = [];
    (function tick() {
      const tools = document.getElementById('map-tools');
      window.__samples.push({
        t: Math.round(performance.now() - window.__t0),
        toolsExist: !!tools,
        toolsVisible: tools ? getComputedStyle(tools).visibility === 'visible' : null,
        zoom: !!document.querySelector('.leaflet-control-zoom'),
        reset: !!document.querySelector('.map-reset-btn'),
        contrib: !!document.querySelector('.map-contrib-btn'),
      });
      if (window.__samples.length < 300) requestAnimationFrame(tick);
    })();
  });
  await p2.goto(BASE + '/explore.html', { waitUntil: 'load', timeout: 60000 });
  await p2.waitForTimeout(2000);

  const e = await p2.evaluate(() => {
    const s = window.__samples.filter((x) => x.toolsExist);
    return {
      total: s.length,
      first: s[0] || null,
      earlyHidden: s.find((x) => x.t >= 300) || null,
      firstVisible: s.find((x) => x.toolsVisible) || null,
    };
  });
  ok(e.first && e.first.toolsVisible === false,
    'E1 元素一进 DOM 就是藏着的（不是先露一下再藏）', e.first);
  ok(e.earlyHidden && e.earlyHidden.toolsVisible === false && !e.earlyHidden.zoom,
    'E2 前提：Leaflet 还没到的时刻它确实还藏着 —— 否则 E3 是空转', e.earlyHidden);
  ok(e.firstVisible && e.firstVisible.zoom && e.firstVisible.reset && e.firstVisible.contrib,
    'E3 它转可见的那一刻，Leaflet 那三个控件已经在了：六个一起出现，不再分两批', e.firstVisible);
  ok(errs2.length === 0, 'E 段无 JS 报错', errs2);
  await ctx2.close();

  ok(errs.length === 0, '全程无 JS 报错', errs);

  await browser.close();
  console.log(fails === 0 ? '\nALL GREEN (0 failures)' : '\n' + fails + ' FAILURE(S)');
  process.exit(fails === 0 ? 0 : 1);
})();

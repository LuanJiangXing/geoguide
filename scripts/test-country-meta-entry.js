// Guards the explore page's country-wide entry point — run with:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-country-meta-entry.js
//   kill $(lsof -ti :3999)
//
// A submission with scope 'country' has NO geometry, so it never reaches _polygonLayers — that
// map is the registry for geometry layers, and putting a shapeless entry into it would hand it to
// regionsAtPoint / pinAtPoint / the dot-collapse logic, each of which would then need an exception.
// It gets its own screen-fixed overlay instead, and this file pins down that arrangement:
//
//   1. The entry is REACHABLE at any zoom — it is not a map layer, so it cannot scroll off-screen.
//   2. It opens the SAME modal as everything else, with the tab bar when a country has 2+.
//   3. The pre-existing region path is untouched: a drawn polygon still hovers, clicks, and opens.
//
// Assertions use getBoundingClientRect and computed style rather than screenshots — this
// environment cannot view images.
'use strict';

const { firefox } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3999';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ' — ' + detail));
}

// japan has TWO country-wide entries plus a polygon; canada has none (→ empty state);
// kenya has exactly ONE (→ no tab bar).
//
// `manyland` carries TWELVE country-wide entries — the overlap tab bar's overflow case. It is a
// SEPARATE country on purpose: adding entries to japan would break A7 (japan has exactly 2) and
// B3 (two entries → tab bar), which describe the non-overflow behaviour and must not change.
const REGIONS = [
  {
    id: 'jp-meta-1', name: 'Japan — bollards', description: 'poles', tags: [], region: 'japan',
    scope: 'country', geojson: [], user_id: '', submitted_by: 'alice', link: '', streetview: {},
  },
  {
    id: 'jp-meta-2', name: 'Japan — signage', description: 'signs', tags: [], region: 'japan',
    scope: 'country', geojson: [], user_id: '', submitted_by: 'bob', link: '', streetview: {},
  },
  {
    id: 'jp-poly', name: 'Hokkaido', description: 'an actual drawn area', tags: [], region: 'japan',
    scope: 'region', user_id: '', submitted_by: 'carol', link: '', streetview: {},
    geojson: { type: 'Polygon', coordinates: [[[141.0, 43.0], [144.0, 43.0], [144.0, 44.5], [141.0, 44.5], [141.0, 43.0]]] },
  },
  {
    id: 'ke-meta-1', name: 'Kenya — matatu', description: 'one only', tags: [], region: 'kenya',
    scope: 'country', geojson: [], user_id: '', submitted_by: 'dave', link: '', streetview: {},
  },
].concat(Array.from({ length: 12 }, (_, i) => ({
  id: 'ml-meta-' + (i + 1),
  name: 'Manyland — country-wide guide number ' + (i + 1),
  description: 'one of many', tags: [], region: 'manyland',
  scope: 'country', geojson: [], user_id: '', submitted_by: 'eve', link: '', streetview: {},
})));

const COUNTRIES = {
  countries: [
    { id: 'japan', name: 'Japan', flag: 'jp', bounds_sw: [30.0, 130.0], bounds_ne: [45.0, 146.0], active: 1, sort_order: 0, region_count: 3 },
    { id: 'kenya', name: 'Kenya', flag: 'ke', bounds_sw: [-4.7, 33.9], bounds_ne: [5.0, 41.9], active: 1, sort_order: 1, region_count: 1 },
    { id: 'canada', name: 'Canada', flag: 'ca', bounds_sw: [36.0, -142.0], bounds_ne: [73.0, -50.0], active: 1, sort_order: 2, region_count: 0 },
    { id: 'manyland', name: 'Manyland', flag: 'ml', bounds_sw: [-10.0, -10.0], bounds_ne: [10.0, 10.0], active: 1, sort_order: 3, region_count: 12 },
  ],
};

const probe = () => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), cy: Math.round(r.top + r.height / 2), cx: Math.round(r.left + r.width / 2) };
  };
  const overlaps = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const star = rect('#country-meta-btn');
  const empty = rect('#country-meta-empty');
  const tools = rect('.map-tools');
  const basemap = rect('.basemap-switch');
  const searchField = (() => {
    const el = document.getElementById('map-search-field');
    if (!el || el.hidden) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })();
  const wrap = document.getElementById('country-meta-entry');
  const mapRect = document.getElementById('map').getBoundingClientRect();
  return {
    wrapHidden: wrap ? wrap.hidden : null,
    shifted: wrap ? wrap.classList.contains('is-shifted') : null,
    star, empty, tools, basemap, searchField,
    starOverlapsTools: overlaps(star, tools),
    starOverlapsBasemap: overlaps(star, basemap),
    starOverlapsSearch: overlaps(star, searchField),
    starCentered: star ? Math.abs(star.cx - Math.round(mapRect.left + mapRect.width / 2)) <= 2 : null,
    // 相对**地图顶边**的偏移。getBoundingClientRect 是视口坐标，里面含了 69px 的导航栏，
    // 直接拿 star.y 跟 10 比会永远失败。
    starTopOffset: star ? star.y - Math.round(mapRect.top) : null,
    emptyText: (document.getElementById('country-meta-empty-text') || {}).textContent || null,
    emptyHref: (document.getElementById('country-meta-empty-link') || {}).getAttribute('href') || null,
    metaIds: (document.getElementById('country-meta-btn') || {})._countryMetaIds || null,
    modalOpen: (() => { const m = document.getElementById('modal'); return !!m && !m.hidden; })(),
    modalTitle: (document.getElementById('modal-title') || {}).textContent || '',
    tabs: (() => {
      const t = document.getElementById('overlap-tabs');
      if (!t || t.hidden) return null;
      return Array.from(t.querySelectorAll('.overlap-tab')).map((b) => ({
        text: b.textContent.trim(),
        active: b.classList.contains('is-active'),
      }));
    })(),
    compareBtnVisible: (() => {
      const b = document.querySelector('.modal__compare-btn');
      if (!b) return null;
      return getComputedStyle(b).display !== 'none';
    })(),
    // --- overlap tab bar overflow probes (09-23) -------------------------------------------------
    // The row is anchored to BOTH edges of the centred modal, so its width must equal the modal's
    // width — never 92vw, which on a wide screen runs off the right edge.
    overlapTabsBox: (() => {
      const t = document.getElementById('overlap-tabs');
      if (!t || t.hidden) return null;
      const r = t.getBoundingClientRect();
      return { x: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) };
    })(),
    innerWidth: window.innerWidth,
    track: (() => {
      const tr = document.getElementById('overlap-tabs-track');
      if (!tr) return null;
      return { scrollWidth: tr.scrollWidth, clientWidth: tr.clientWidth, scrollLeft: Math.round(tr.scrollLeft) };
    })(),
    arrowLeft: (() => {
      const b = document.getElementById('overlap-tabs-left');
      return b ? { hidden: b.hidden, disabled: b.disabled } : null;
    })(),
    arrowRight: (() => {
      const b = document.getElementById('overlap-tabs-right');
      return b ? { hidden: b.hidden, disabled: b.disabled } : null;
    })(),
    // Every tab's rendered width — the shrink floor (AC5) is asserted against these.
    tabWidths: Array.from(document.querySelectorAll('#overlap-tabs .overlap-tab'))
      .map((b) => Math.round(b.getBoundingClientRect().width)),
    // Which tab labels are actually ellipsized (scrollWidth > clientWidth ⇒ text is clipped).
    tabEllipsis: Array.from(document.querySelectorAll('#overlap-tabs .overlap-tab__label'))
      .map((s) => s.scrollWidth > s.clientWidth),
    // title attribute mirrors the full name for truncation compensation (R2).
    tabTitles: Array.from(document.querySelectorAll('#overlap-tabs .overlap-tab'))
      .map((b) => b.title || ''),
  };
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REGIONS) }));

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

  const open = async (url, w, h) => {
    if (w) await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => window._geoguideMap && (window._hoverRegions || []).length >= 4, null, { timeout: 20000 });
    await page.waitForTimeout(600);
  };

  // --- A. a country WITH country-wide entries → star ---------------------------------------------
  await open('/explore.html?country=japan');
  let s = await page.evaluate(probe);
  check('A1 japan 有国家范围条目 → 浮层可见', s.wrapHidden === false, String(s.wrapHidden));
  check('A2 星标可见', !!s.star, JSON.stringify(s.star));
  check('A3 星标贴地图顶部正中', s.starCentered === true && s.starTopOffset !== null && s.starTopOffset <= 16,
    JSON.stringify({ centered: s.starCentered, topOffset: s.starTopOffset }));
  check('A4 星标不与左上工具列重叠', s.starOverlapsTools === false, JSON.stringify({ star: s.star, tools: s.tools }));
  check('A5 星标不与右上 basemap 切换重叠', s.starOverlapsBasemap === false, JSON.stringify({ star: s.star, basemap: s.basemap }));
  check('A6 空态不显示', s.empty === null, JSON.stringify(s.empty));
  check('A7 按钮上挂了该国的 id 列表', Array.isArray(s.metaIds) && s.metaIds.length === 2, JSON.stringify(s.metaIds));

  // --- B. click → modal + tab bar (2 entries) ----------------------------------------------------
  await page.click('#country-meta-btn');
  await page.waitForFunction(() => !document.getElementById('modal').hidden, null, { timeout: 5000 });
  s = await page.evaluate(probe);
  check('B1 点击星标打开弹窗', s.modalOpen === true);
  check('B2 弹窗内容是该国第一条国家范围条目', s.modalTitle === 'Japan — bollards', s.modalTitle);
  check('B3 两条 → 摆出标签栏', Array.isArray(s.tabs) && s.tabs.length === 2, JSON.stringify(s.tabs));
  check('B4 标签栏里就是这两条，且当前条高亮',
    !!s.tabs && s.tabs[0].text.indexOf('bollards') !== -1 && s.tabs[1].text.indexOf('signage') !== -1 && s.tabs[0].active === true,
    JSON.stringify(s.tabs));
  check('B5 国家范围条目不显示 Compare 按钮', s.compareBtnVisible === false, String(s.compareBtnVisible));

  // AC7 的另一半：光藏按钮不够 —— 篮子侧也必须拒绝，否则地图点击路径照样能塞进去。
  const basket = await page.evaluate(() => {
    const r = (window._hoverRegions || []).find((x) => x.id === 'jp-meta-1');
    const before = window._compareBasket.getSlots().length;
    window._compareBasket.add(r);
    return { before: before, after: window._compareBasket.getSlots().length };
  });
  check('B5b 篮子侧也拒绝国家范围条目', basket.after === basket.before, JSON.stringify(basket));

  // AC9：国家范围条目走的是同一个 openModal，弹窗部件该有的都得在。
  const chrome = await page.evaluate(() => {
    const rr = document.getElementById('modal-reactions');
    const fav = document.querySelector('.modal__fav-btn');
    return {
      reactions: !!rr,
      reactionsClass: rr ? rr.className : null,
      favBtn: !!fav,
      tags: !!document.getElementById('modal-tags'),
      streetviewPane: !!document.getElementById('modal-streetview'),
      translateToggle: !!document.querySelector('.modal__meta .lang-toggle--name'),
    };
  });
  check('B5c 国家范围条目的弹窗部件与普通条目一致（reactions / 收藏 / 标签 / 街景 / 翻译）',
    chrome.reactions && /modal__reactions/.test(chrome.reactionsClass || '') && chrome.favBtn && chrome.tags
      && chrome.streetviewPane && chrome.translateToggle,
    JSON.stringify(chrome));

  // tab switch
  await page.click('#overlap-tabs .overlap-tab:nth-child(2)');
  await page.waitForTimeout(400);
  s = await page.evaluate(probe);
  check('B6 点第二个标签切到第二条', s.modalTitle === 'Japan — signage', s.modalTitle);
  check('B7 active 跟着移动', !!s.tabs && s.tabs[1].active === true, JSON.stringify(s.tabs));

  // AC2 — roomy case: the 2 tabs keep their FULL names (no ellipsis) and the arrows stay hidden.
  check('B8 空间充足（2 条）时标签文字不被截断',
    s.tabEllipsis.length === 2 && s.tabEllipsis.every((e) => e === false), JSON.stringify({ ellipsis: s.tabEllipsis, widths: s.tabWidths }));
  check('B9 空间充足（2 条）时左右箭头都隐藏',
    !!s.arrowLeft && !!s.arrowRight && s.arrowLeft.hidden === true && s.arrowRight.hidden === true,
    JSON.stringify({ left: s.arrowLeft, right: s.arrowRight }));

  await page.evaluate(() => window.closeModal());
  await page.waitForFunction(() => document.getElementById('modal').hidden, null, { timeout: 5000 });

  // --- C. a country with NO country-wide entries → empty state -----------------------------------
  await open('/explore.html?country=canada');
  s = await page.evaluate(probe);
  check('C1 canada 没有国家范围条目 → 星标隐藏', s.star === null, JSON.stringify(s.star));
  check('C2 显示鼓励文案', s.empty !== null && /no country-wide meta/i.test(s.emptyText || ''), JSON.stringify(s.emptyText));
  check('C3 链接指向提交页并预选了该国', s.emptyHref === '/submit?country=canada', String(s.emptyHref));
  check('C4 空态也不与工具列重叠', !s.empty || (s.empty.x > s.tools.x + s.tools.w), JSON.stringify({ empty: s.empty, tools: s.tools }));

  // --- D. exactly ONE entry → no tab bar ---------------------------------------------------------
  await open('/explore.html?country=kenya');
  s = await page.evaluate(probe);
  check('D1 kenya 只有 1 条 → 星标仍在', !!s.star, JSON.stringify(s.star));
  await page.click('#country-meta-btn');
  await page.waitForFunction(() => !document.getElementById('modal').hidden, null, { timeout: 5000 });
  s = await page.evaluate(probe);
  check('D2 只有 1 条 → 不摆标签栏', s.tabs === null, JSON.stringify(s.tabs));
  check('D3 弹窗仍正确打开', s.modalTitle === 'Kenya — matatu', s.modalTitle);
  await page.evaluate(() => window.closeModal());
  await page.waitForFunction(() => document.getElementById('modal').hidden, null, { timeout: 5000 });

  // --- E. deep link ------------------------------------------------------------------------------
  await open('/explore.html?country=japan&region=jp-meta-2');
  await page.waitForFunction(() => !document.getElementById('modal').hidden, null, { timeout: 8000 });
  await page.waitForTimeout(400);
  s = await page.evaluate(probe);
  check('E1 ?region= 深链打开对应条目', s.modalTitle === 'Japan — signage', s.modalTitle);
  check('E2 深链也把标签栏摆出来，且该条 active',
    !!s.tabs && s.tabs.length === 2 && s.tabs[1].active === true, JSON.stringify(s.tabs));

  // --- F. zoom does not move it (it is not a map layer) ------------------------------------------
  const before = await page.evaluate(() => {
    const r = document.getElementById('country-meta-btn').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  await page.evaluate(() => { window.closeModal(); window._geoguideMap.setZoom(4); });
  await page.waitForFunction(() => document.getElementById('modal').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => {
    const r = document.getElementById('country-meta-btn').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top) };
  });
  check('F1 zoom 后星标位置不动（它不是地图图层，不会飘出屏幕）',
    before.x === after.x && before.y === after.y, JSON.stringify({ before, after }));

  // --- G. narrow screen + expanded search → the star yields --------------------------------------
  await open('/explore.html?country=japan', 375, 720);
  const narrowBefore = await page.evaluate(probe);
  check('G1 窄屏：未展开搜索时星标不与搜索框重叠', narrowBefore.starOverlapsSearch === false,
    JSON.stringify({ star: narrowBefore.star, field: narrowBefore.searchField }));
  await page.click('#map-search-toggle');
  await page.waitForFunction(() => document.getElementById('map-search-toggle').getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const narrowAfter = await page.evaluate(probe);
  check('G2 搜索展开后星标被标记为让位', narrowAfter.shifted === true, String(narrowAfter.shifted));
  check('G3 让位后与搜索框不再重叠', narrowAfter.starOverlapsSearch === false,
    JSON.stringify({ star: narrowAfter.star, field: narrowAfter.searchField }));
  check('G4 让位后仍不与工具列重叠', narrowAfter.starOverlapsTools === false,
    JSON.stringify({ star: narrowAfter.star, tools: narrowAfter.tools }));
  await page.click('#map-search-toggle');
  await page.waitForFunction(() => document.getElementById('map-search-toggle').getAttribute('aria-expanded') === 'false', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const narrowReset = await page.evaluate(probe);
  check('G5 收起搜索后回到正中', narrowReset.shifted === false && narrowReset.starCentered === true,
    JSON.stringify({ shifted: narrowReset.shifted, centered: narrowReset.starCentered }));

  // G6/G7 — 宽屏上搜索框够不着正中，入口**不许**下移。
  // 这条是回归:让位规则早先只看 aria-expanded、不看几何,于是 1280 宽下点放大镜星标也会
  // 往下跳一下(搜索框在 x 60–312,星标在 cx 640,隔着三百多像素)。G1–G5 只覆盖窄屏,漏了这半边。
  await open('/explore.html?country=japan', 1280, 800);
  const wideBefore = await page.evaluate(probe);
  await page.click('#map-search-toggle');
  await page.waitForFunction(() => document.getElementById('map-search-toggle').getAttribute('aria-expanded') === 'true', null, { timeout: 5000 });
  await page.waitForTimeout(400);
  const wideAfter = await page.evaluate(probe);
  check('G6 宽屏展开搜索：搜索框确实够不着入口（前提成立）',
    !!wideAfter.searchField && wideAfter.star !== null && wideAfter.searchField.x + wideAfter.searchField.w < wideAfter.star.x,
    JSON.stringify({ star: wideAfter.star, field: wideAfter.searchField }));
  check('G7 宽屏展开搜索：入口不下移',
    wideAfter.shifted === false && wideAfter.star.y === wideBefore.star.y,
    JSON.stringify({ shifted: wideAfter.shifted, before: wideBefore.star.y, after: wideAfter.star.y }));

  // --- H. the pre-existing region path is untouched ----------------------------------------------
  await open('/explore.html?country=japan');
  const poly = await page.evaluate(() => {
    const map = window._geoguideMap;
    const r = (window._hoverRegions || []).find((x) => x.id === 'jp-poly');
    const ring = r.geojson.coordinates[0];
    let sx = 0, sy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const p = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
      sx += p.x; sy += p.y;
    }
    const n = ring.length - 1;
    const rect = document.getElementById('map').getBoundingClientRect();
    return { x: rect.left + sx / n, y: rect.top + sy / n };
  });
  await page.mouse.click(poly.x, poly.y);
  await page.waitForFunction(() => !document.getElementById('modal').hidden, null, { timeout: 5000 });
  const h = await page.evaluate(() => ({
    title: document.getElementById('modal-title').textContent,
    tabs: (() => { const t = document.getElementById('overlap-tabs'); return (!t || t.hidden) ? null : t.querySelectorAll('.overlap-tab').length; })(),
    compareVisible: (() => {
      const b = document.querySelector('.modal__compare-btn');
      return b ? getComputedStyle(b).display !== 'none' : null;
    })(),
  }));
  check('H1 画出来的多边形照旧能点开', h.title === 'Hokkaido', h.title);
  check('H2 不相关的区域条目不会冒出一个国家范围标签栏', h.tabs === null, JSON.stringify(h.tabs));
  check('H3 普通区域条目照旧显示 Compare 按钮', h.compareVisible === true, String(h.compareVisible));

  // --- J. many entries → the bar must stay on screen, shrink, then scroll ------------------------
  // Two independent defects live here. (1) The row is pinned to the LEFT edge of a CENTRED modal
  // while `max-width: 92vw` is measured against the whole viewport — so on a 1920 screen it ends
  // at 2246px. (2) `.overlap-tab` is a flex item with the default `min-width: auto`, so it refuses
  // to shrink below its text and can only overflow.
  await open('/explore.html?country=manyland', 1280, 800);
  s = await page.evaluate(probe);
  check('J1 manyland 12 条 → 星标挂 12 个 id', Array.isArray(s.metaIds) && s.metaIds.length === 12, JSON.stringify(s.metaIds));
  await page.click('#country-meta-btn');
  await page.waitForFunction(() => !document.getElementById('modal').hidden, null, { timeout: 5000 });
  await page.waitForTimeout(500);
  s = await page.evaluate(probe);
  check('J2 12 条 → 标签栏摆出 12 个标签', Array.isArray(s.tabs) && s.tabs.length === 12,
    JSON.stringify(s.tabs && s.tabs.length));
  check('J3 1280 视口：标签栏不出屏（left ≥ 0 且 right ≤ innerWidth）',
    !!s.overlapTabsBox && s.overlapTabsBox.x >= 0 && s.overlapTabsBox.right <= s.innerWidth,
    JSON.stringify({ box: s.overlapTabsBox, innerWidth: s.innerWidth }));
  check('J4 12 条：轨道确实溢出（scrollWidth > clientWidth）',
    !!s.track && s.track.scrollWidth > s.track.clientWidth, JSON.stringify(s.track));
  check('J5 12 条：左右箭头都出现',
    !!s.arrowLeft && !!s.arrowRight && s.arrowLeft.hidden === false && s.arrowRight.hidden === false,
    JSON.stringify({ left: s.arrowLeft, right: s.arrowRight }));
  check('J6 12 条：标签文字出现省略号', s.tabEllipsis.some((e) => e === true), JSON.stringify(s.tabEllipsis));
  check('J7 收缩地板：压到最窄时每个标签仍 ≥ 100px',
    s.tabWidths.length === 12 && s.tabWidths.every((w) => w >= 100), JSON.stringify(s.tabWidths));
  check('J8 截断时 title 补偿完整名字',
    s.tabTitles.length === 12 && s.tabTitles.every((t) => t.indexOf('Manyland') !== -1), JSON.stringify(s.tabTitles));

  check('J9 初始：左箭头 disabled、右箭头可用',
    !!s.arrowLeft && !!s.arrowRight && s.arrowLeft.disabled === true && s.arrowRight.disabled === false,
    JSON.stringify({ left: s.arrowLeft, right: s.arrowRight }));
  await page.evaluate(() => {
    const tr = document.getElementById('overlap-tabs-track');
    if (tr) tr.scrollLeft = tr.scrollWidth;
  });
  await page.waitForTimeout(300);
  s = await page.evaluate(probe);
  check('J10 滚到最右：右箭头 disabled、左箭头可用',
    !!s.arrowLeft && !!s.arrowRight && s.arrowRight.disabled === true && s.arrowLeft.disabled === false,
    JSON.stringify({ left: s.arrowLeft, right: s.arrowRight, scrollLeft: s.track && s.track.scrollLeft }));
  await page.evaluate(() => {
    const tr = document.getElementById('overlap-tabs-track');
    if (tr) tr.scrollLeft = 0;
  });
  await page.waitForTimeout(300);
  s = await page.evaluate(probe);
  check('J11 滚回最左恢复初始态',
    !!s.arrowLeft && !!s.arrowRight && s.arrowLeft.disabled === true && s.arrowRight.disabled === false,
    JSON.stringify({ left: s.arrowLeft, right: s.arrowRight }));

  // J9–J11 都是直接赋 scrollLeft 去驱动 update()，从没点过箭头 —— 而箭头正是这次新增的交互本身，
  // scrollBy/smooth 坏掉不会有任何断言响。这里真的点。
  // 等条件而不是等固定时长：滚动是 behavior:'smooth'，sleep 会在边界上偶发失败。
  // 先确认箭头真的在，再点 —— 否则 page.click 会抛异常中断整个脚本，
  // 把后面 J12/J13 的「不出屏」断言一并跳过（断言失败不该阻断后续断言）。
  const arrowsUsable = await page.evaluate(() => {
    const l = document.getElementById('overlap-tabs-left');
    const r = document.getElementById('overlap-tabs-right');
    return !!l && !!r && !l.hidden && !r.hidden;
  });
  if (!arrowsUsable) {
    check('J11b 点右箭头真的滚动', false, '箭头不可见，无法点击');
    check('J11c 点左箭头滚回起点', false, '箭头不可见，无法点击');
  } else {
    await page.click('#overlap-tabs-right');
    await page.waitForFunction(
      () => document.getElementById('overlap-tabs-track').scrollLeft > 0, null, { timeout: 5000 });
    s = await page.evaluate(probe);
    check('J11b 点右箭头真的滚动了，左箭头随之可用',
      !!s.track && s.track.scrollLeft > 0 && !!s.arrowLeft && s.arrowLeft.disabled === false,
      JSON.stringify({ track: s.track, left: s.arrowLeft }));

    await page.click('#overlap-tabs-left');
    await page.waitForFunction(
      () => document.getElementById('overlap-tabs-track').scrollLeft === 0, null, { timeout: 5000 });
    s = await page.evaluate(probe);
    check('J11c 点左箭头滚回起点，左箭头重新变灰',
      !!s.track && s.track.scrollLeft === 0 && !!s.arrowLeft && s.arrowLeft.disabled === true,
      JSON.stringify({ track: s.track, left: s.arrowLeft }));
  }

  for (const w of [[1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w[0], height: w[1] });
    await page.waitForTimeout(400);
    s = await page.evaluate(probe);
    check('J12 ' + w[0] + ' 视口：标签栏不出屏',
      !!s.overlapTabsBox && s.overlapTabsBox.x >= 0 && s.overlapTabsBox.right <= s.innerWidth,
      JSON.stringify({ box: s.overlapTabsBox, innerWidth: s.innerWidth }));
  }

  await page.setViewportSize({ width: 390, height: 720 });
  await page.waitForTimeout(400);
  s = await page.evaluate(probe);
  check('J13 390 视口：标签栏在屏内且轨道有宽',
    !!s.overlapTabsBox && s.overlapTabsBox.x >= 0 && s.overlapTabsBox.right <= s.innerWidth
      && !!s.track && s.track.clientWidth > 0,
    JSON.stringify({ box: s.overlapTabsBox, innerWidth: s.innerWidth, track: s.track }));

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await page.click('#overlap-tabs .overlap-tab:nth-child(3)');
  await page.waitForTimeout(500);
  s = await page.evaluate(probe);
  check('J14 点第 3 个标签切到第 3 条', s.modalTitle === 'Manyland — country-wide guide number 3', s.modalTitle);
  check('J15 active 跟随',
    !!s.tabs && s.tabs[2].active === true && s.tabs[0].active === false, JSON.stringify(s.tabs));
  await page.evaluate(() => window.closeModal());
  await page.waitForFunction(() => document.getElementById('modal').hidden, null, { timeout: 5000 });

  // --- I. homepage Recent Updates distinguishes the two kinds (AC12) -----------------------------
  // The list is text-only (● + name + country + date), so both kinds render; the question is
  // whether a reader can tell them apart — at 10px a ★ and a ● are nearly identical, which is
  // why the country variant also changes size and colour.
  const home = await ctx.newPage();
  await home.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await home.waitForFunction(() => document.querySelectorAll('.recent-update-item').length > 0, null, { timeout: 20000 })
    .catch(() => {});
  const marks = await home.evaluate(() => Array.from(document.querySelectorAll('.recent-update-item')).map((el) => {
    const icon = el.querySelector('.recent-update-item__icon');
    return {
      name: (el.querySelector('.recent-update-item__name') || {}).textContent || '',
      icon: icon ? icon.textContent : null,
      countryVariant: !!el.querySelector('.recent-update-item__icon--country'),
      size: icon ? getComputedStyle(icon).fontSize : null,
    };
  }));
  const metaMark = marks.find((m) => m.name.indexOf('bollards') !== -1);
  const polyMark = marks.find((m) => m.name === 'Hokkaido');
  check('I1 国家范围条目在首页列表里带 ★ 标记', !!metaMark && metaMark.icon === '★' && metaMark.countryVariant === true,
    JSON.stringify(metaMark));
  check('I2 具体小区域条目仍是 ●（不误伤）', !!polyMark && polyMark.icon === '●' && polyMark.countryVariant === false,
    JSON.stringify(polyMark));
  check('I3 两者的标记字号不同（10px 下 ★/● 分不出来）',
    !!metaMark && !!polyMark && metaMark.size !== polyMark.size,
    JSON.stringify({ meta: metaMark && metaMark.size, poly: polyMark && polyMark.size }));

  check('Z1 无未捕获的页面错误', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures ? ('\n== FAILURES: ' + failures) : '\n== ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

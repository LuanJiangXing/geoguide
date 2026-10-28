// Playwright harness for explore's map-tools overlay: the icon-only search button and the tag
// filter button that sit in the map's top-left corner, above Leaflet's own control column.
//
// Why this needs its own script — three things here are relationships between boxes, not computed
// styles, so `test-style-parity.js` cannot see them break:
//
//   1. The two tools must be stacked DIRECTLY ABOVE the zoom control, in one column, with no
//      overlap. That is enforced by `--map-tools-h` on `.map-shell` pushing
//      `.leaflet-top.leaflet-left` down. ⚠️ The variable must live on a common ancestor: it is
//      consumed by a SIBLING of `.map-tools`, and custom properties inherit downwards, so
//      declaring it on `.map-tools` makes the padding compute to nothing — silently. The first
//      run of this change did exactly that and the icons landed on top of the zoom buttons.
//   2. The two tools must be indistinguishable from the Leaflet buttons beside them. They get
//      that by SHARING the `.map-reset-btn` rule group, so this asserts the computed boxes match
//      rather than trusting the intent.
//   3. `.map-shell` must start immediately below the nav — i.e. the old full-width toolbar row
//      is really gone and its height went back to the map.
//
// RED CHECKS (all three verified red before this was trusted):
//   - set `.leaflet-top.leaflet-left { padding-top: 0 }`  -> "tools do not overlap the controls" fails
//   - remove the search IIFE from explore.html            -> "clicking the magnifier opens the field" fails
//   - lower `.map-tools` below 1000                       -> covered by test-tag-dropdown-overlap.js
//
// Usage: node scripts/test-map-tools.js
//        BASE_URL=http://localhost:8123 node scripts/test-map-tools.js
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

// The real seed shape: 10 categories, 35 tags. Enough to exercise the panel; the point here is
// the tools' geometry and the search wiring, not the panel's contents.
const CATS = [
  ['Car', ['smallcam', 'gen2', 'gen3', 'gen4', 'truck']],
  ['Copyright', ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026']],
  ['Landscape', ['grassland', 'farmland', 'forest', 'desert']],
  ['Terrain', ['flat', 'hilly', 'mountainous']],
  ['Soil', ['red', 'sandy']],
  ['Vegetation', ['grass', 'shrubs']],
  ['Season', ['spring', 'summer', 'autumn', 'winter']],
  ['Vibe', ['green', 'sandstorm']],
  ['Road', ['paved', 'unpaved']],
  ['Plantation', ['eucalyptus', 'pine']],
];
const TAGS = { categories: CATS.map(([name, tags]) => ({ name, tags: tags.map((t) => ({ name: t })) })) };
// geometryLayer() wants a bare Geometry, not a Feature.
const REGIONS = ['r1', 'r2', 'r3'].map((id, i) => ({
  id, name: 'Region ' + id, tags: [], user_id: '',
  geojson: { type: 'Polygon', coordinates: [[[28 + i, -26], [28.4 + i, -26], [28.4 + i, -26.4], [28 + i, -26.4], [28 + i, -26]]] },
}));

// Properties that must match `.map-reset-btn` exactly. `position` and `display` are deliberately
// NOT here: the toggles need `position: relative` for their badges, and the shared touch-target
// group already gives all of them the same `display`.
const BOX_PROPS = ['background-color', 'border-top-width', 'border-top-style', 'border-top-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius',
  'border-bottom-right-radius', 'width', 'height', 'cursor', 'color', 'padding-top', 'padding-left'];

const SIZES = [[1440, 900], [1280, 800], [1024, 640], [768, 700], [390, 760]];

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

const COLUMN = (props) => {
  const r = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
  const read = (el) => { const cs = getComputedStyle(el); const o = {}; props.forEach((p) => { o[p] = cs.getPropertyValue(p); }); return o; };
  const zoom = document.querySelector('.leaflet-control-zoom');
  const reset = document.querySelector('.map-reset-btn');
  const search = document.querySelector('.search-chip__toggle');
  const filter = document.querySelector('.tag-filter__toggle');
  if (!zoom || !reset || !search || !filter) return { missing: true };
  const order = [['search', search], ['filter', filter], ['zoom', zoom], ['reset', reset],
    ['contrib', document.querySelector('.map-contrib-btn')]].map(([n, el]) => ({ n, ...r(el) }));
  const collide = [];
  for (let i = 0; i < order.length; i++) for (let j = i + 1; j < order.length; j++) {
    const a = order[i], b = order[j];
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) collide.push(a.n + '×' + b.n);
  }
  let monotonic = true;
  for (let i = 1; i < order.length; i++) if (order[i].y <= order[i - 1].y) monotonic = false;
  const nav = document.querySelector('.nav').getBoundingClientRect();
  const shell = document.querySelector('.map-shell').getBoundingClientRect();
  return {
    missing: false,
    order, collide, monotonic,
    sameX: order.every((o) => o.x === order[0].x),
    navBottom: Math.round(nav.bottom), shellTop: Math.round(shell.top), shellH: Math.round(shell.height),
    toolsZ: getComputedStyle(document.querySelector('.map-tools')).zIndex,
    boxSearch: read(search), boxFilter: read(filter), boxReset: read(reset),
    searchIsReset: props.every((p) => read(search)[p] === read(reset)[p]),
    filterIsReset: props.every((p) => read(filter)[p] === read(reset)[p]),
  };
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Least-specific FIRST — Playwright gives precedence to the LAST matching route.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/tags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(TAGS) }));
  await ctx.route('**/api/submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REGIONS) }));

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error' && !/countries/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 140)); });

  const boot = async () => {
    await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1100);
  };

  console.log('--- 1) the toolbar row is gone and its height went to the map ---');
  await boot();
  const s0 = await page.evaluate(COLUMN, BOX_PROPS);
  ok(await page.evaluate(() => !document.querySelector('.toolbar')), '页面里不再有 .toolbar');
  ok(await page.evaluate(() => {
    const i = document.getElementById('search-input');
    return !!i && i.type === 'search';
  }), '#search-input 仍在，且仍是 type=search（search.js 的接线依赖它）');
  ok(Math.abs(s0.shellTop - s0.navBottom) <= 1,
    `地图紧贴导航栏下方，中间没有工具栏（nav 底 ${s0.navBottom} vs 地图顶 ${s0.shellTop}）`);
  ok(s0.toolsZ === '1001', `地图浮层 z-index 是 1001（压过 Leaflet 的 1000）`, s0.toolsZ);

  console.log('--- 2) the tool column: one column, above the controls, no overlap ---');
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await boot();
    const c = await page.evaluate(COLUMN, BOX_PROPS);
    ok(!c.missing, `${w}x${h} 四个按钮都在`);
    if (c.missing) continue;
    ok(c.sameX, `${w}x${h} 五个控件同一列（x=${c.order[0].x}）`, c.order.map((o) => o.x));
    ok(c.monotonic, `${w}x${h} 自上而下 y 严格递增`, c.order.map((o) => o.n + ':' + o.y));
    ok(c.collide.length === 0, `${w}x${h} 五个控件两两不重叠`, c.collide);
  }

  console.log('--- 3) the two tools look like the Leaflet buttons beside them ---');
  const c0 = await page.evaluate(COLUMN, BOX_PROPS);
  ok(c0.searchIsReset, '搜索钮与 .map-reset-btn 的边框/底色/圆角/尺寸逐属性相等',
    Object.keys(c0.boxSearch).filter((p) => c0.boxSearch[p] !== c0.boxReset[p]));
  ok(c0.filterIsReset, '筛选钮与 .map-reset-btn 的边框/底色/圆角/尺寸逐属性相等',
    Object.keys(c0.boxFilter).filter((p) => c0.boxFilter[p] !== c0.boxReset[p]));

  // An SVG with no width/height rule falls back to the browser default and renders at 40x40 in a
  // 44px button — twice every other icon in the column, and completely silent. This shipped once.
  const icons = await page.evaluate(() => {
    const box = (sel) => { const el = document.querySelector(sel); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return { search: box('.search-chip__toggle svg'), filter: box('.tag-filter__toggle svg'), contrib: box('.map-contrib-btn svg') };
  });
  ok(icons.search && icons.search.w === 20 && icons.search.h === 20,
    '放大镜图标有明确尺寸 20×20（漏写尺寸规则会让它落到浏览器默认的 40×40）', icons);
  ok(icons.filter && icons.filter.w === 20 && icons.contrib && icons.contrib.w === 20,
    '另外两个图标也是 20×20（三者同档）', icons);

  // The zoom control is the one neighbour NOT in `.map-reset-btn`'s rule group. Leaflet builds it
  // as a `.leaflet-bar`, and `.leaflet-touch` puts a 2px border on that bar — OUTSIDE the 44px
  // content, so the control measured 48px wide while every other button is 44 (border-box). Its
  // glyph was 22px against the column's 20px for the same reason: Leaflet's own font-size, which
  // out-specifies a plain `.leaflet-control-zoom a` rule.
  const zoom = await page.evaluate(() => {
    const box = (s) => { const el = document.querySelector(s); if (!el) return null; const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };
    return { bar: box('.leaflet-control-zoom'), anchor: box('.leaflet-control-zoom-in'),
      reset: box('.map-reset-btn'),
      font: getComputedStyle(document.querySelector('.leaflet-control-zoom-in')).fontSize,
      resetFont: getComputedStyle(document.querySelector('.map-reset-btn')).fontSize };
  });
  ok(zoom.bar && zoom.reset && zoom.bar.w === zoom.reset.w,
    '缩放控件外框宽度与 .map-reset-btn 一致（Leaflet 的 2px 边框曾让它宽出 4px）', zoom);
  ok(zoom.font === zoom.resetFont,
    '缩放控件字号与同列一致（Leaflet 触摸环境自带 22px，这一列是 20px）', zoom);

  console.log('--- 4) search: a magnifier that expands on click ---');
  await page.setViewportSize({ width: 1280, height: 800 });
  await boot();
  const state = () => page.evaluate(() => ({
    fieldHidden: document.getElementById('map-search-field').hidden,
    expanded: document.getElementById('map-search-toggle').getAttribute('aria-expanded'),
    active: document.activeElement ? document.activeElement.id : null,
    value: document.getElementById('search-input').value,
    clearHidden: document.getElementById('map-search-clear').hidden,
  }));
  ok((await state()).fieldHidden, '初始状态输入框不可见');
  await page.click('#map-search-toggle');
  await page.waitForTimeout(250);
  const open = await state();
  ok(!open.fieldHidden && open.expanded === 'true', '点放大镜后输入框可见且 aria-expanded=true', open);
  ok(open.active === 'search-input', '展开后焦点落在输入框上', open.active);
  const field = await page.evaluate(() => {
    const r = document.getElementById('map-search-field').getBoundingClientRect();
    const cs = getComputedStyle(document.getElementById('map-search-field'));
    return { inView: r.left >= 0 && r.right <= window.innerWidth + 0.5, bg: cs.backgroundColor, x: Math.round(r.left), w: Math.round(r.width) };
  });
  ok(field.inView, `展开的输入框不溢出视口（x=${field.x}, w=${field.w}）`);
  ok(field.bg === 'rgba(0, 0, 0, 0)', '展开的输入框是透明的（地图要能透出来）', field.bg);

  await page.fill('#search-input', 'region');
  await page.waitForTimeout(300);
  ok(!(await state()).clearHidden, '有词时出现清除钮');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const escText = await state();
  ok(escText.value === '' && !escText.fieldHidden, 'Esc 有词：清词但保持展开', escText);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  const escEmpty = await state();
  ok(escEmpty.fieldHidden && escEmpty.expanded === 'false', 'Esc 无词：收起', escEmpty);

  await page.click('#map-search-toggle');
  await page.waitForTimeout(200);
  await page.fill('#search-input', 'region');
  await page.waitForTimeout(250);
  await page.click('#map-search-clear');
  await page.waitForTimeout(250);
  const cleared = await state();
  ok(cleared.value === '' && !cleared.fieldHidden, '点 × 清词且保持展开', cleared);

  // 空框开合不该惊动使用方：search-chip.js 收起那条分支的 input 事件契约是「值变了」，
  // 空框收起什么都没变。这半条在 my-submissions 上表现为一次整列表 reload + Loading 闪烁，
  // 在 explore 上不显眼（applyFilters 是本地过滤），但那是同一份模块、同一个白跑。
  // applyFilters 每次调用都无条件写 #filter-status，所以那个节点就是「过滤跑了几趟」的精确计数器。
  const emptyToggle = await page.evaluate(async () => {
    const st = document.getElementById('filter-status');
    let writes = 0;
    const mo = new MutationObserver(() => { writes++; });
    mo.observe(st, { childList: true, characterData: true, subtree: true });
    const toggle = document.getElementById('map-search-toggle');
    toggle.click();                       // 收起（空框）
    await new Promise((r) => setTimeout(r, 400));   // 越过 180ms 防抖
    toggle.click();                       // 再展开
    await new Promise((r) => setTimeout(r, 400));
    mo.disconnect();
    return { writes, value: document.getElementById('search-input').value };
  });
  ok(emptyToggle.writes === 0,
    '空框开合一次不触发任何过滤（收起时若值本来就是空的，就不该派发 input）', emptyToggle);

  console.log('--- 5) the input is debounced ---');
  const deb = await page.evaluate(async () => {
    const st = document.getElementById('filter-status');
    let writes = 0;
    const mo = new MutationObserver(() => { writes++; });
    mo.observe(st, { childList: true, characterData: true, subtree: true });
    const input = document.getElementById('search-input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    for (const v of ['r', 're', 'reg', 'regi', 'regio']) {
      setter.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    await new Promise((r) => setTimeout(r, 700));
    mo.disconnect();
    return { writes, status: st.textContent };
  });
  // Five keystrokes 30ms apart must collapse into ONE filter pass, not five.
  ok(deb.writes === 1, `连打 5 次只触发 1 次过滤（防抖生效）`, deb);

  ok(errs.length === 0, '无 JS 报错', errs);

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

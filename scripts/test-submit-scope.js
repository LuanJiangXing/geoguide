// Guards the submit page's scope switch (region / country) — run with:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-submit-scope.js
//   kill $(lsof -ti :3999)
//
// The switch is not just another form field: picking "a whole country" removes the ENTIRE left
// half of the page's work, so it has to be decided before the user starts drawing. These
// assertions pin down the three things that can quietly rot:
//
//   1. The region path is untouched. A geometry-less region submission must still be refused,
//      with the same message, and switching back must fully restore the drawing affordances.
//   2. The country path ships `geojson: []` and `scope: 'country'` — never the shapes that
//      happen to be sitting on the canvas.
//   3. Switching modes is NON-DESTRUCTIVE. A drawn shape survives a round trip through country
//      mode; we assert it by looking at the live `drawnLayers` array, not at pixels.
//
// Assertions read computed style / geometry rather than screenshots on purpose — this
// environment cannot view images.
'use strict';

const { firefox } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3999';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ' — ' + detail));
}

const ME = { user: { id: 'u1', username: 'tester', display_name: 'Tester', role: 'user', avatar_url: null } };
const COUNTRIES = {
  countries: [
    { id: 'japan', name: 'Japan', flag: 'jp', bounds_sw: [24, 122], bounds_ne: [46, 146], active: 1, sort_order: 0, region_count: 0 },
    { id: 'canada', name: 'Canada', flag: 'ca', bounds_sw: [36, -142], bounds_ne: [73, -50], active: 1, sort_order: 1, region_count: 0 },
  ],
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Catch-all FIRST: Playwright matches routes most-recently-registered first.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/auth*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/tags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories: [], tags: [] }) }));
  await ctx.route('**/api/user-submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ submissions: [] }) }));

  let submitted = null;
  await ctx.route('**/api/submit', (r) => {
    try { submitted = JSON.parse(r.request().postData() || '{}'); } catch (e) { submitted = { _parseError: String(e) }; }
    r.fulfill({ status: 201, contentType: 'application/json', body: '{"success":true,"id":"new-1"}' });
  });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('dialog', (d) => d.accept());   // "N link(s) failed to resolve. Submit anyway?"

  await page.goto(BASE + '/submit.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('submit-form').style.display === 'block', null, { timeout: 20000 });
  await page.waitForFunction(() => window._countryMap && Object.keys(window._countryMap).length > 0, null, { timeout: 20000 });

  const state = () => page.evaluate(() => {
    const cs = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      return { display: s.display, visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) };
    };
    const note = document.getElementById('submit-map-note');
    return {
      scope: typeof currentScope === 'undefined' ? null : currentScope,
      checked: (document.querySelector('.scope-choice__opt input:checked') || {}).value || null,
      selectedOpt: (document.querySelector('.scope-choice__opt.is-selected input') || {}).value || null,
      nameLabel: (document.getElementById('region-name-label') || {}).textContent || null,
      hint: (document.getElementById('scope-hint') || {}).textContent || null,
      noteHidden: note ? note.hidden : null,
      noteText: note ? note.textContent : null,
      toolbar: cs('.leaflet-pm-toolbar'),
      overlayPane: cs('.leaflet-overlay-pane'),
      shapeList: cs('#shape-list'),
      mobileWarning: cs('#mobile-warning'),
      drawn: typeof drawnLayers === 'undefined' ? -1 : drawnLayers.length,
      onMap: typeof drawnLayers === 'undefined' ? -1 : drawnLayers.filter((l) => window._submitMapProbe.has(l)).length,
    };
  });

  // Expose the map so `onMap` can be measured; injected once, after load.
  await page.evaluate(() => {
    window._submitMapProbe = {
      has(l) { const m = document.querySelector('#submit-map'); return !!(m && m._leaflet_id && l._map); },
    };
  });

  // --- A. defaults -------------------------------------------------------------------------------
  const a = await state();
  check('A1 默认选中 region', a.checked === 'region' && a.selectedOpt === 'region', JSON.stringify({ checked: a.checked, selected: a.selectedOpt }));
  check('A2 默认 name 标签是 Region Name', a.nameLabel === 'Region Name', a.nameLabel);
  check('A3 默认不显示置灰遮罩', a.noteHidden === true, String(a.noteHidden));
  check('A4 Geoman 工具条默认可见（选择器命中）', !!a.toolbar && a.toolbar.display !== 'none', JSON.stringify(a.toolbar));
  check('A5 形状层默认可见', !!a.overlayPane && a.overlayPane.display !== 'none', JSON.stringify(a.overlayPane));

  // --- B. draw one shape, so the round trip has something to preserve ----------------------------
  // `map`, `drawnLayers`, `renderShapeList` and `currentScope` are all top-level declarations in a
  // classic <script>, so they are page globals — same reason `currentScope` is readable above.
  const drew = await page.evaluate(() => {
    if (typeof map === 'undefined' || typeof L === 'undefined') return 'no map/L';
    const poly = L.polygon([[35.6, 139.7], [35.7, 139.8], [35.65, 139.9]]).addTo(map);
    drawnLayers.push(poly);
    renderShapeList();
    return drawnLayers.length;
  });
  check('B1 先在 region 模式下画一个形状', drew === 1, String(drew));

  // --- C. switch to country ----------------------------------------------------------------------
  await page.click('.scope-choice__opt input[value="country"]');
  const c = await state();
  check('C1 currentScope 变成 country', c.scope === 'country', String(c.scope));
  check('C2 country 选中态跟随', c.checked === 'country' && c.selectedOpt === 'country', JSON.stringify({ checked: c.checked, selected: c.selectedOpt }));
  check('C3 name 标签改成 Name', c.nameLabel === 'Name', c.nameLabel);
  check('C4 置灰遮罩显示且带说明', c.noteHidden === false && /no drawing needed/i.test(c.noteText || ''), JSON.stringify({ hidden: c.noteHidden, text: c.noteText }));
  check('C5 遮罩提到形状会被保留（不销毁用户劳动）', /kept/i.test(c.noteText || ''), c.noteText);
  check('C6 Geoman 工具条被隐藏', !!c.toolbar && c.toolbar.display === 'none', JSON.stringify(c.toolbar));
  check('C7 形状层被隐藏', !!c.overlayPane && c.overlayPane.display === 'none', JSON.stringify(c.overlayPane));
  check('C8 形状列表被隐藏', !!c.shapeList && c.shapeList.display === 'none', JSON.stringify(c.shapeList));
  check('C9 手机端「来画区域」警告被隐藏', !!c.mobileWarning && c.mobileWarning.display === 'none', JSON.stringify(c.mobileWarning));
  check('C10 drawnLayers 一个都没删', c.drawn === 1, String(c.drawn));

  // --- D. switch back to region — the round trip must be non-destructive -------------------------
  // Runs BEFORE any submit: a successful submit clears the canvas on purpose, so checking
  // preservation after one would measure that reset instead of the mode switch.
  await page.click('.scope-choice__opt input[value="region"]');
  const d = await state();
  check('D1 切回 region：currentScope 复原', d.scope === 'region', String(d.scope));
  check('D2 切回 region：name 标签复原', d.nameLabel === 'Region Name', d.nameLabel);
  check('D3 切回 region：遮罩收起', d.noteHidden === true, String(d.noteHidden));
  check('D4 切回 region：工具条复原', !!d.toolbar && d.toolbar.display !== 'none', JSON.stringify(d.toolbar));
  check('D5 切回 region：形状层复原', !!d.overlayPane && d.overlayPane.display !== 'none', JSON.stringify(d.overlayPane));
  check('D6 切回 region：形状列表复原（画的还在）', !!d.shapeList && d.shapeList.display !== 'none', JSON.stringify(d.shapeList));
  check('D7 跨模式往返后 drawnLayers 仍是 1（非破坏性）', d.drawn === 1, String(d.drawn));

  // --- E. submit in country mode without drawing -------------------------------------------------
  await page.click('.scope-choice__opt input[value="country"]');
  await page.fill('#region-name', 'Japan — bollards & poles');
  await page.fill('#region-desc', 'country-wide pole guide');
  await page.selectOption('#region-country', 'japan');
  await page.fill('#link-inputs .link-row__input', 'https://www.google.com/maps/@35.6,139.7,3a,75y');
  await page.click('#submit-btn');
  await page.waitForTimeout(1500);
  check('E1 country 模式不画几何也能提交', !!submitted && submitted._parseError === undefined, JSON.stringify(submitted && submitted._parseError));
  if (submitted) {
    check("E2 提交体带 scope:'country'", submitted.scope === 'country', String(submitted.scope));
    check('E3 提交体的 geojson 是空数组（画布上那个多边形不该进去）',
      Array.isArray(submitted.geojson) && submitted.geojson.length === 0,
      JSON.stringify(submitted.geojson).slice(0, 120));
  }

  // --- F. the region path is unchanged -----------------------------------------------------------
  await page.click('.scope-choice__opt input[value="region"]');   // E 结束在 country，先切回来
  await page.evaluate(() => {
    // 清掉形状，回到「什么都没画」的 region 态
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    renderShapeList();
  });
  // 提交成功后表单会被清空，这三个必填项都得补齐，否则拦在更早的校验上、测不到几何那一关。
  await page.fill('#region-name', 'Osaka bollards');
  await page.fill('#region-desc', 'a drawn area');
  await page.selectOption('#region-country', 'japan');
  await page.fill('#link-inputs .link-row__input', 'https://www.google.com/maps/@34.7,135.5,3a,75y');
  await page.click('#submit-btn');
  await page.waitForTimeout(600);
  const f = await page.evaluate(() => ({
    msg: document.getElementById('form-feedback').textContent,
    cls: document.getElementById('form-feedback').className,
  }));
  check('F1 region 模式不画东西仍然被拦，文案逐字未变',
    f.msg === 'Please draw at least one polygon or line on the map.', JSON.stringify(f));
  check('F2 拦截用的是 is-error 样式', /is-error/.test(f.cls), f.cls);

  // --- G. ?country= preselect --------------------------------------------------------------------
  const p2 = await ctx.newPage();
  await p2.goto(BASE + '/submit.html?country=canada', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p2.waitForFunction(() => window._countryMap && Object.keys(window._countryMap).length > 0, null, { timeout: 20000 });
  await p2.waitForFunction(() => document.getElementById('region-country').options.length > 1, null, { timeout: 20000 });
  const g = await p2.evaluate(() => document.getElementById('region-country').value);
  check('G1 ?country= 预选了该国家', g === 'canada', g);
  const p3 = await ctx.newPage();
  await p3.goto(BASE + '/submit.html?country=not-a-country', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p3.waitForFunction(() => window._countryMap && Object.keys(window._countryMap).length > 0, null, { timeout: 20000 });
  await p3.waitForFunction(() => document.getElementById('region-country').options.length > 1, null, { timeout: 20000 });
  const g3 = await p3.evaluate(() => document.getElementById('region-country').value);
  check('G3 ?country= 给了不存在的国家 → 保持未选中', g3 === '', JSON.stringify(g3));

  check('Z1 无未捕获的页面错误', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures ? ('\n== FAILURES: ' + failures) : '\n== ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

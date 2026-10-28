// Playwright harness for the explore tag-filter panel vs the map's own controls.
//
// Contract: the OPEN `.tag-filter__panel` paints above every Leaflet control, and a click inside
// the overlap reaches the panel rather than the map. The panel hangs off the filter button in the
// map's top-left corner and overflows downward onto the map, and `.map-tools`' own
// `z-index: 1001` creates a stacking context — so the panel's z-index cannot lift it out, and the
// tools container itself must sit above Leaflet's control layer (`.leaflet-top/.leaflet-bottom` =
// z-index 1000, `.leaflet-control` = 800). At 999 the zoom (+/-), reset and contributors buttons
// painted over the open panel, and the basemap switch over its far edge.
//
// ⚠️ The panel itself carries NO z-index, and raising one would change nothing: `.map-tools`
// establishes the stacking context, so nothing inside it can escape upward. If this test ever
// goes red, look at `.map-tools`' z-index — not the panel's. (Before 2026-09-18 the same contract
// hung off `.toolbar`, the full-width row that used to sit above the map.)
//
// Usage: node scripts/test-tag-dropdown-overlap.js
//        BASE_URL=http://localhost:8123 node scripts/test-tag-dropdown-overlap.js
//
// GOTCHA — read before editing the sampling below: `.leaflet-top` is `pointer-events: none` and the
// controls inside it are not contiguous, so sampling the panel's own rect (centre/corners) returns
// the panel and the test passes even while the bug is present. Sample the CENTRE OF THE
// INTERSECTION between the panel and a real `.leaflet-control` box instead — that is where the two
// actually compete.
const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Enough categories that the panel runs to several columns and lands over the map's left-hand
// column of controls at every width.
const NAMES = ['cars', 'scenery', 'signs', 'roads', 'weather', 'nature', 'urban', 'coast',
  'mountain', 'rural', 'historic', 'transport', 'water', 'sky'];
const TAGS = { categories: NAMES.map((n) => ({ name: n, tags: [{ name: n + '-a' }, { name: n + '-b' }, { name: n + '-c' }] })) };

const SIZES = [[1440, 900], [1280, 800], [1024, 640], [768, 700], [390, 760]];

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// For the open panel, reports — per real intersection with a map control — whether the topmost
// element at the intersection's centre belongs to the panel.
const SCAN = () => {
  const panel = document.querySelector('.tag-filter__panel');
  if (!panel || panel.hidden) return { open: false, overlaps: 0, lost: 0, samples: [], count: 0 };
  const pr = panel.getBoundingClientRect();
  let overlaps = 0, lost = 0;
  const samples = [];
  document.querySelectorAll('.leaflet-control').forEach((c) => {
    const cr = c.getBoundingClientRect();
    const x0 = Math.max(pr.left, cr.left), x1 = Math.min(pr.right, cr.right);
    const y0 = Math.max(pr.top, cr.top), y1 = Math.min(pr.bottom, cr.bottom);
    if (x1 - x0 < 2 || y1 - y0 < 2) return;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    overlaps++;
    const el = document.elementFromPoint(cx, cy);
    if (!panel.contains(el)) {
      lost++;
      samples.push(`${c.className.split(' ').filter((s) => s !== 'leaflet-control').join('.') || 'control'}` +
        ` @(${Math.round(cx)},${Math.round(cy)}) → ${el ? el.className.toString().slice(0, 40) : 'null'}`);
    }
  });
  return { open: true, overlaps, lost, samples, count: document.querySelectorAll('.leaflet-control').length };
};

// Panel box invariants. Two assertions only, and both can actually go red:
//   • inView   — `width: min(860px, calc(100vw - 24px))`: drop the `min()` and re-hardcode a fixed
//                width (the bug documented in explore-tag-filter.md §5) and 390px goes red.
//   • wrapped  — `column-width: 112px` is the FLOOR set by the longest category (~111px); lower it
//                and long tag names break mid-word inside the column. Red at 60px.
// Deliberately NOT asserted: `scrollWidth <= clientWidth`. A multicol container never overflows
// horizontally by construction (extra content stacks into taller columns instead), so that check
// could never fail — an unfalsifiable assertion is worse than none.
const GEOMETRY = () => {
  const p = document.querySelector('.tag-filter__panel');
  const r = p.getBoundingClientRect();
  // A single row is exactly `min-height: 30px`; a wrapped one adds a ~17px line.
  const wrapped = [...document.querySelectorAll('.tag-filter__item')]
    .filter((el) => el.getBoundingClientRect().height > 32).length;
  return {
    left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth,
    inView: r.left >= -0.5 && r.right <= window.innerWidth + 0.5,
    wrapped,
  };
};

const openPanel = async (page) => {
  await page.evaluate(() => {
    const t = document.getElementById('tag-filter-toggle');
    if (t && t.getAttribute('aria-expanded') !== 'true') t.click();
  });
  await page.waitForTimeout(250);
};

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Least-specific route FIRST — Playwright gives precedence to the LAST matching route.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/tags*', (r) => r.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(TAGS)
  }));

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));

  console.log('--- 1) the open panel paints above every map control ---');
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(800);
    await openPanel(page);

    const r = await page.evaluate(SCAN);
    ok(r.open, `${w}x${h} 面板确实打开了`);
    // Non-vacuity guard: if a future change stops the panel from reaching the map, this test would
    // otherwise pass while testing nothing.
    ok(r.overlaps > 0, `${w}x${h} 面板确实压到了地图控件（${r.overlaps} 处交集，测的是真场景）`);
    ok(r.lost === 0, `${w}x${h} 面板与 ${r.count} 个控件全部有交叠，且交叠中心都在面板之上`, r.lost ? r.samples.slice(0, 4) : undefined);

    const g = await page.evaluate(GEOMETRY);
    ok(g.inView, `${w}x${h} 面板整体在视口内（宽度仍是 min(860px, 100vw - 24px)，没被写死）`, g);
    ok(g.wrapped === 0, `${w}x${h} 没有标签在栏内断词（column-width 112 没被调更小）`, g);
  }

  console.log('--- 2) a click inside the overlap reaches the panel, not the map ---');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(800);
  await openPanel(page);

  const pt = await page.evaluate(() => {
    const p = document.querySelector('.tag-filter__panel').getBoundingClientRect();
    const z = document.querySelector('.leaflet-control-zoom').getBoundingClientRect();
    const x0 = Math.max(p.left, z.left), x1 = Math.min(p.right, z.right);
    const y0 = Math.max(p.top, z.top), y1 = Math.min(p.bottom, z.bottom);
    const cx = Math.round((x0 + x1) / 2), cy = Math.round((y0 + y1) / 2);
    const el = document.elementFromPoint(cx, cy);
    return {
      x: cx, y: cy,
      area: Math.round((x1 - x0) * (y1 - y0)),
      inPanel: document.querySelector('.tag-filter__panel').contains(el),
      zoomBefore: window._geoguideMap ? window._geoguideMap.getZoom() : null,
    };
  });
  ok(pt.area > 0, `拿到了"面板 ∩ 缩放控件"的交集区（${pt.area}px² @ ${pt.x},${pt.y}）`);
  ok(pt.inPanel, '交集中心的最上层元素属于面板（不是缩放控件）', { top: pt.inPanel });

  await page.mouse.click(pt.x, pt.y);
  await page.waitForTimeout(400);
  const afterClick = await page.evaluate(() => ({
    zoomAfter: window._geoguideMap ? window._geoguideMap.getZoom() : null,
  }));
  ok(afterClick.zoomAfter === pt.zoomBefore,
    '在这个区域点击没有穿透到地图控件（缩放未变）', { before: pt.zoomBefore, after: afterClick.zoomAfter });

  console.log('--- 3) selecting a tag updates the badge and the count ---');
  const after = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.tag-filter__item input[type=checkbox]'));
    // Pick a real tag row, never the per-category "All" row.
    const target = boxes.find((cb) => cb.value !== '__all__');
    target.click();
    const badge = document.querySelector('.tag-filter__badge');
    return {
      value: target.value,
      checked: document.querySelectorAll('.tag-filter__item input:checked').length,
      badge: badge.textContent.trim(),
      badgeHidden: badge.hidden,
    };
  });
  ok(after.checked > 0, '勾选生效', after);
  ok(!after.badgeHidden && after.badge === String(after.checked), '角标数 = 勾选数', after);

  console.log('--- 4) closing hands the corner back ---');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => {
    const panel = document.querySelector('.tag-filter__panel');
    const z = document.querySelector('.leaflet-control-zoom').getBoundingClientRect();
    const el = document.elementFromPoint(z.left + z.width / 2, z.top + z.height / 2);
    return {
      hidden: panel.hidden,
      expanded: document.getElementById('tag-filter-toggle').getAttribute('aria-expanded'),
      zoomTop: el ? el.className.toString() : 'null',
    };
  });
  ok(closed.hidden && closed.expanded === 'false', 'Esc 关闭了面板且 aria-expanded 归位', closed);
  ok(/leaflet-control-zoom/.test(closed.zoomTop), '面板关闭后缩放按钮恢复可点（地图没被永久盖住）', closed.zoomTop);

  ok(errs.length === 0, '无 JS 报错', errs);

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

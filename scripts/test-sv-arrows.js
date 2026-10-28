// Playwright harness for the street view carousel arrows — explore modal AND compare view.
//
// Contract: the two arrows form a CENTRED PAIR along the bottom of the pane, sitting just above
// the dot indicators. They must stay clear of, at every pane size and aspect ratio:
//   · Google's right-hand control column (zoom 24–105px above the bottom, compass 137–186px,
//     all 10–58px in from the right) — which is why the pair is centred, not parked on an edge;
//   · Google's top-left place card (0–66px from the top);
//   · the pane's own chrome at the bottom: the `.sv-dots` strip (explore) / `.comp-carousel__dots`
//     (compare), and the "Press F for fullscreen" chip in the bottom-left of the explore pane.
//
// Usage: node scripts/test-sv-arrows.js
//        BASE_URL=http://localhost:8123 node scripts/test-sv-arrows.js
// Requires a static server serving public/ (default http://localhost:3000). All /api/* calls are
// route-mocked and the modal / compare overlay are opened with injected fixtures, so no login or
// real data is needed.
const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const CARD_H = 66;            // measured height of Google's top-left place card
const RIGHT_BAND = [10, 58];  // Google's right control column, measured 10–58px in from the right
const GAP_MIN = 4;
const GAP_MAX = 12;

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

const PANO = 'uyHXZwSmqs4rooFI_26VSw';
const mkRegion = (id) => ({
  id, name: 'fixture' + id, country_id: 'vietnam', description: 'fixture', tags: [], submitted_by: 'fixture',
  streetview: [1, 2, 3].map(() => ({ lat: 21.0638675, lng: 107.2369005, heading: 41, pitch: -10, fov: 90, pano: PANO })),
  link: ['a', 'b', 'c']
});

// Wide desktop down to phone widths, tall and short alike.
const SIZES = [
  [1920, 1080], [1440, 900], [1440, 760], [1440, 700], [1440, 620], [1440, 561], [1440, 500],
  [1366, 625], [1280, 720], [1024, 640], [900, 600], [768, 700], [767, 700], [700, 700],
  [500, 800], [390, 760]
];

// ---------------------------------------------------------------------------
// Shared assertions
// ---------------------------------------------------------------------------

/**
 * @param tag     label for the row
 * @param m       { pw, ph, L, R, dots, hint } — boxes relative to the pane, `fb` = bottom edge
 *                distance from the pane's bottom, `ft` = top edge distance from the pane's top
 * @param what    'explore' | 'compare', only used in messages
 */
function checkPair(tag, m, what) {
  const { pw, ph, L, R, dots, hint } = m;

  // ① 并排：同一水平线、同一个底距、同样的高
  ok(Math.abs(L.fb - R.fb) <= 1, `${tag} 两箭同一水平线（距底 ${L.fb} / ${R.fb}）`);
  ok(L.y0 === R.y0 && L.y1 === R.y1, `${tag} 两箭等高（y ${L.y0}–${L.y1}）`, { L: L.y, R: R.y });

  // ② 中间留缝
  const gap = R.x0 - L.x1;
  ok(gap >= GAP_MIN && gap <= GAP_MAX, `${tag} 两箭间距 ${gap}px`);

  // ③ 整对以窗格中线居中
  const mid = (L.x0 + R.x1) / 2;
  ok(Math.abs(mid - pw / 2) <= 1.5, `${tag} 整对水平居中（中线 ${mid} vs ${pw / 2}）`);

  // ④ 横向不进 Google 右列
  const band = [pw - RIGHT_BAND[1], pw - RIGHT_BAND[0]];
  const xHit = Math.max(0, Math.min(R.x1, band[1]) - Math.max(L.x0, band[0]));
  ok(R.x1 <= band[0] && xHit === 0, `${tag} 不进 Google 右列（右沿 ${R.x1} < ${band[0]}）`);

  // ⑤ 整对留在窗格内，下方留边
  ok(L.x0 >= 0 && L.y0 >= 0 && L.fb >= 4, `${tag} 不出窗格（x0 ${L.x0}, y0 ${L.y0}, 距底 ${L.fb}）`);

  // ⑥ 让开 Google 左上角地点卡
  ok(L.y0 >= CARD_H + 4, `${tag} 让开地点卡（上沿 ${L.y0} >= ${CARD_H + 4}）`);

  // ⑦ 让开圆点
  if (dots) {
    const dotsTop = ph - dots.y0;   // 圆点上沿距底
    ok(L.fb >= dotsTop + 4, `${tag} 让开圆点（箭下沿距底 ${L.fb} >= 圆点上沿距底 ${dotsTop} + 4）`);
  }

  // ⑧ 让开左下角 "Press F for fullscreen" 提示（只有 explore 有）
  if (hint) {
    const hintTop = ph - hint.y0;
    const xHitHint = Math.max(0, Math.min(L.x1, hint.x1) - Math.max(L.x0, hint.x0));
    ok(L.fb >= hintTop + 4 || xHitHint === 0,
      `${tag} 让开 F 提示（箭下沿距底 ${L.fb} >= 提示上沿距底 ${hintTop} + 4，或横向不相交）`);
  }
}

// ---------------------------------------------------------------------------
// Page-side measurement
// ---------------------------------------------------------------------------

const MEASURE_FN = `(sel) => {
  const box = (el, pane) => {
    const r = el.getBoundingClientRect();
    const x0 = Math.round(r.x - pane.x), x1 = Math.round(r.x + r.width - pane.x);
    const y0 = Math.round(r.y - pane.y), y1 = Math.round(r.y + r.height - pane.y);
    return { x0, x1, y0, y1, y: [y0, y1], fb: Math.round(pane.bottom - (r.y + r.height)), ft: Math.round(r.y - pane.top) };
  };
  const paneEl = document.querySelector(sel.pane);
  if (!paneEl) return null;
  const pane = paneEl.getBoundingClientRect();
  const $ = (s) => document.querySelector(s);
  return {
    pw: Math.round(pane.width), ph: Math.round(pane.height),
    L: box($(sel.left), pane),
    R: box($(sel.right), pane),
    dots: sel.dots && $(sel.dots) ? box($(sel.dots), pane) : null,
    hint: sel.hint && $(sel.hint) ? box($(sel.hint), pane) : null
  };
}`;

const EXPLORE_SEL = {
  pane: '#modal-streetview',
  left: '#sv-arrow-left',
  right: '#sv-arrow-right',
  dots: '#sv-dots',
  hint: '.fs-exit-hint'
};

const COMPARE_SEL = (i) => ({
  pane: `.compare-col:nth-of-type(${i + 1}) .compare-col__streetview`,
  left: `.compare-col:nth-of-type(${i + 1}) .comp-carousel__arrow--left`,
  right: `.compare-col:nth-of-type(${i + 1}) .comp-carousel__arrow--right`,
  dots: `.compare-col:nth-of-type(${i + 1}) .comp-carousel__dots`,
  hint: null
});

// ---------------------------------------------------------------------------

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));

  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));

  const measure = (sel) => page.evaluate(new Function('return ' + MEASURE_FN)(), sel);

  const openModal = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(700);
    await page.evaluate((r) => window.openModal(r), mkRegion(9001));
    await page.waitForTimeout(900);
  };

  const openCompare = async (w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(700);
    // NOTE: page.evaluate only forwards ONE argument here — pass a single object, not (a, b).
    await page.evaluate((regions) => {
      window._compareBasket.add(regions.a);
      window._compareBasket.add(regions.b);   // both slots filled → overlay opens
    }, { a: mkRegion(9101), b: mkRegion(9102) });
    await page.waitForTimeout(1200);
  };

  console.log('--- 1) explore modal: geometry across viewport sizes ---');
  for (const [w, h] of SIZES) {
    await openModal(w, h);
    const m = await measure(EXPLORE_SEL);
    if (!m) { ok(false, `${w}x${h} 找不到窗格/箭头`); continue; }
    checkPair(`${w}x${h} (pane ${m.pw}x${m.ph})`, m, 'explore');
  }

  console.log('--- 2) explore modal: still works ---');
  await openModal(1440, 900);
  const readExplore = () => page.evaluate(() => ({
    counter: document.getElementById('sv-counter').textContent.trim(),
    opacity: getComputedStyle(document.getElementById('sv-arrow-right')).opacity
  }));
  ok((await readExplore()).counter === '1 / 3', '初始为 1 / 3', (await readExplore()).counter);

  await page.hover('#sv-carousel');
  await page.waitForTimeout(350);
  ok(Number((await readExplore()).opacity) > 0.9, '悬浮时箭头可见', (await readExplore()).opacity);

  await page.click('#sv-arrow-right');
  await page.waitForTimeout(500);
  ok((await readExplore()).counter === '2 / 3', '点右箭头翻到 2 / 3', (await readExplore()).counter);

  await page.click('#sv-arrow-left');
  await page.waitForTimeout(500);
  ok((await readExplore()).counter === '1 / 3', '点左箭头翻回 1 / 3', (await readExplore()).counter);

  await page.evaluate(() => document.getElementById('sv-key-catcher').focus());
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(500);
  ok((await readExplore()).counter === '2 / 3', '键盘 → 仍能翻页', (await readExplore()).counter);

  console.log('--- 3) compare view: geometry across viewport sizes ---');
  const COMPARE_SIZES = [[1920, 1080], [1440, 900], [1280, 720], [1024, 640], [900, 700], [680, 900], [390, 760]];
  for (const [w, h] of COMPARE_SIZES) {
    await openCompare(w, h);
    const cols = await page.evaluate(() => document.querySelectorAll('.compare-col').length);
    ok(cols === 2, `${w}x${h} 对比视图两列就位（${cols}）`);
    for (let i = 0; i < 2; i++) {
      const m = await measure(COMPARE_SEL(i));
      if (!m) { ok(false, `${w}x${h} 第 ${i + 1} 列找不到窗格/箭头`); continue; }
      checkPair(`${w}x${h} 第 ${i + 1} 列 (pane ${m.pw}x${m.ph})`, m, 'compare');
    }
  }

  console.log('--- 4) compare view: still works ---');
  await openCompare(1440, 900);
  const readCompare = () => page.evaluate(() => {
    const c = document.querySelector('.compare-col .comp-carousel__counter');
    return c ? c.textContent.trim() : '(none)';
  });
  ok((await readCompare()) === '1 / 3', '第 1 列初始为 1 / 3', await readCompare());
  await page.click('.compare-col .comp-carousel__arrow--right');
  await page.waitForTimeout(500);
  ok((await readCompare()) === '2 / 3', '点右箭头翻到 2 / 3', await readCompare());

  ok(errs.length === 0, '无 JS 报错', errs);

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

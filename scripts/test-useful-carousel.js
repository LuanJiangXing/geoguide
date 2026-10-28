// Playwright harness for the homepage "Most Useful Meta" carousel
// (public/index.html's inline Batch 2 module, `#most-useful`).
//
// Why this needs its own script. Movement used to be a pure CSS keyframe; it is
// now an rAF-driven JS transform (design D1). A transform written by JS has no
// DOM attribute a test can read, so the module exposes `window.__usefulCarousel`
// — a read-only probe — for the same reason the constellation exposes
// `window.__constellation`. Every position/state assertion reads from it; the
// gesture assertions drive real events (page.mouse, dispatched PointerEvent /
// WheelEvent / DragEvent) and then read the probe, never the other way round.
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-useful-carousel.js
//   kill $(lsof -ti :3999)
//
// The sandbox has no network: every non-local request is mocked or aborted, and
// flag/thumb image loads are served from an in-harness 1x1 PNG. "The sandbox can
// load a real flag" is never a pass condition. Touch gestures are dispatched as
// PointerEvents (pointerType:'touch'): that exercises this module's handler path,
// not the browser's own axis negotiation, which the `touch-action` assertions
// cover instead — a real touch fling cannot be produced reliably in headless
// Firefox.
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/$/, '');

// 1x1 transparent PNG — stands in for any successfully loaded flag/thumb image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

const COUNTRY_IDS = ['canada', 'hawaii', 'paraguay', 'south-africa', 'france', 'japan', 'brazil', 'kenya'];
const CARD_PITCH = 300;   // 288px card + 12px margin-right (style.css)

function fixtures(n) {
  const regions = [];
  const subs = [];
  for (let i = 0; i < n; i++) {
    const id = 'sub-' + (i + 1);
    const cid = COUNTRY_IDS[i % COUNTRY_IDS.length];
    regions.push({ region_id: id, name: 'Region ' + String.fromCharCode(65 + i), country_id: cid, useful_count: 20 - i });
    subs.push({
      id: id, name: 'Region ' + String.fromCharCode(65 + i),
      description: 'Description for region ' + (i + 1) + '.', tags: [],
      country_id: cid, submitted_by: 'tester', source_type: '', source_url: '',
      created_at: '2026-01-0' + ((i % 9) + 1), streetview: {}, link: 'https://maps.app.goo.gl/x'
    });
  }
  return {
    COUNTRIES: { countries: COUNTRY_IDS.map(function (id, i) { return { id: id, name: id, flag: 'x' + i, active: 1 }; }) },
    REACTIONS: { regions: regions },
    SUBMISSIONS: subs
  };
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL'), name + (detail === undefined ? '' : ' — ' + detail));
}
function num2(v) { return (v === null || v === undefined || !isFinite(v)) ? String(v) : v.toFixed(2); }
// touch-action is an ordered token list that Firefox may normalise/reorder, so
// assert on tokens rather than on the whole string. Observed in this Firefox:
// `touch-action: pan-y pinch-zoom` round-trips exactly as written; a bare element
// reports `auto`. The token test keeps working if that ever changes.
function taHas(v, token) { return String(v).trim().split(/\s+/).indexOf(token) !== -1; }
// Shortest signed displacement congruent to d modulo w. Lets a drag assertion
// survive the wrap: +120px near the seam comes back as 120, not 120 - w.
function wrapDelta(d, w) { const m = ((d % w) + w) % w; return m > w / 2 ? m - w : m; }
// Counts requestAnimationFrame calls in-page. Installed before any page script
// runs, so it is the only way to prove the reduced-motion gate schedules nothing
// (same trick as scripts/test-constellation.js). Callers must reset __raf right
// before the quiet window they want to measure: the homepage fires one rAF of
// its own (fadeInSections) while the Batch 2 handler builds the sections.
const RAF_COUNTER = function () {
  window.__raf = 0;
  var origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) { window.__raf++; return origRaf(cb); };
};

async function installRoutes(context, fx) {
  // One dispatching route, not several. Playwright runs the LAST registered
  // matching route, so a broad pattern registered after a narrow one silently
  // swallows it — which is exactly how a `/api/` catch-all turned every response
  // into `{}` and left the section empty.
  await context.route('**/*', function (route) {
    const url = route.request().url();
    const json = function (b) { return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) }); };
    if (/\/api\/countries(\?|$)/.test(url)) return json(fx.COUNTRIES);
    if (/\/api\/auth(\?|$)/.test(url)) return json({ user: null });
    if (/\/api\/reactions\?action=top/.test(url)) return json(fx.REACTIONS);
    if (/\/api\/reactions/.test(url)) return json({ regions: [] });
    if (/\/api\/submissions\?action=contributors/.test(url)) return json({ contributors: [], total: 0 });
    if (/\/api\/submissions/.test(url)) return json(fx.SUBMISSIONS);
    if (/\/api\/pageview/.test(url)) return json({});
    if (/\/data\/changelog\.json/.test(url)) return json([]);
    if (/\/api\//.test(url)) return json({});
    if (url.indexOf('flagcdn.com') !== -1) {
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    if (url.indexOf(BASE) === 0) return route.continue();
    return route.abort();   // unpkg/tiles/discord/etc.
  });
}

// Wait for the carousel to be built, then scroll it into view and let the
// page's fade-in settle.
async function boot(page, expectCards) {
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function (arg) {
    return document.querySelectorAll('#useful-track > .useful-card').length === arg.n;
  }, { n: expectCards }, { timeout: 15000 });
  await page.evaluate(function () {
    document.getElementById('useful-viewport').scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);
}

async function probe(page) {
  return page.evaluate(function () {
    if (!window.__usefulCarousel || typeof window.__usefulCarousel.state !== 'function') return null;
    return window.__usefulCarousel.state();
  });
}

async function boxOf(page, sel) {
  return page.locator(sel).boundingBox();
}

// Press-move-release in chunks that stay on screen. Each gesture is a separate
// drag; between gestures the module is paused (resumeAt) so the strip does not
// drift underneath the measurement. The 150ms pause before mouse.up makes the
// last velocity sample stale, which the module zeroes — so a measured delta is
// the drag distance and nothing else. Without it the release throws the strip on
// with inertia and every "did it move by exactly D" assertion reads long.
async function dragBy(page, box, dx) {
  const y = box.y + 30;
  const cx = box.x + box.width / 2;
  let remaining = dx;
  let guard = 0;
  while (Math.abs(remaining) > 1 && guard++ < 40) {
    const step = Math.max(-280, Math.min(280, remaining));
    await page.mouse.move(cx, y);
    await page.mouse.down();
    await page.mouse.move(cx + step, y, { steps: 4 });
    await page.waitForTimeout(150);
    await page.mouse.up();
    remaining -= step;
  }
}

async function injectClickCounter(page) {
  await page.evaluate(function () {
    window.__clicks = 0;
    window.__clickSeen = [];
    document.querySelectorAll('.useful-card__link').forEach(function (a) {
      // A target-phase listener: if the viewport's capture handler calls
      // stopPropagation() this never runs, so it is exactly the "did the click
      // reach the card" signal. preventDefault keeps the harness on one page.
      a.addEventListener('click', function (e) { window.__clicks++; e.preventDefault(); });
    });
    // A bubble-phase document listener: empty when the capture handler swallowed
    // the click. Its target names whoever actually received it.
    document.addEventListener('click', function (e) {
      window.__clickSeen.push(String(e.target.className || e.target.tagName));
    });
  });
}

async function readClicks(page) { return page.evaluate(function () { return window.__clicks; }); }
async function resetClicks(page) {
  await page.evaluate(function () { window.__clicks = 0; window.__clickSeen = []; });
}

// The centre of a card that is comfortably inside the viewport, plus what is
// actually hit there. Picking "the first card" is not enough: after a fling it
// can sit off-screen, and a press there never reaches the strip at all — the
// assertion would then pass or fail for the wrong reason.
async function visibleCardCenter(page) {
  return page.evaluate(function () {
    const vp = document.getElementById('useful-viewport').getBoundingClientRect();
    const cards = document.querySelectorAll('#useful-track > .useful-card');
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      // Fully inside, not merely centred inside: a press on a card that is
      // clipped by the viewport can move the track out from under the click.
      if (r.left >= vp.left && r.right <= vp.right && cy > vp.top && cy < vp.bottom) {
        const el = document.elementFromPoint(cx, cy);
        return { i: i, x: cx, y: cy, hit: el ? String(el.className || el.tagName) : null,
                 isLink: !!(el && el.classList && el.classList.contains('useful-card__link')) };
      }
    }
    return null;
  });
}

(async () => {
  const browser = await firefox.launch({ headless: true });

  // ======================================================================
  // Phase A — looping state, 8 regions, desktop 1280x800
  // ======================================================================
  {
    const fx = fixtures(8);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await installRoutes(context, fx);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String((e && e.message) || e)); });
    await boot(page, 16);   // 8 originals + 8 clones
    await injectClickCounter(page);

    // --- A. seam + duplication (R8) --------------------------------------
    const info = await page.evaluate(function () {
      const track = document.getElementById('useful-track');
      const cards = Array.prototype.slice.call(track.children);
      const half = cards.length / 2;
      const lastOfSet = cards[half - 1];
      const cloneFirst = cards[half];
      const mr = parseFloat(getComputedStyle(lastOfSet).marginRight) || 0;
      const setWidth = lastOfSet.offsetLeft + lastOfSet.offsetWidth + mr;
      const cs = getComputedStyle(track);
      const card = cards[0];
      const ccs = getComputedStyle(card);
      return {
        count: cards.length, setWidth: setWidth,
        trackW: track.getBoundingClientRect().width,
        cloneFirstOffsetLeft: cloneFirst.offsetLeft,
        cloneAria: cloneFirst.getAttribute('aria-hidden'),
        cloneTab: cloneFirst.getAttribute('tabindex'),
        cloneLinkTabs: Array.prototype.every.call(cloneFirst.querySelectorAll('a'), function (a) { return a.getAttribute('tabindex') === '-1'; }),
        trackAnimName: cs.animationName,
        willChange: cs.willChange,
        cardAnimName: ccs.animationName,
        cardOpacity: ccs.opacity,
        viewportTouchAction: getComputedStyle(document.getElementById('useful-viewport')).touchAction,
        viewportOverflowX: getComputedStyle(document.getElementById('useful-viewport')).overflowX
      };
    });
    check('A1 the track holds the card set twice (16 cards)', info.count === 16, 'cards=' + info.count);
    check('A2 one set is exactly N x pitch', Math.abs(info.setWidth - 8 * CARD_PITCH) < 1,
      'setWidth=' + num2(info.setWidth) + ' expected=' + (8 * CARD_PITCH));
    check('A3 track width is exactly 2 x setWidth', Math.abs(info.trackW - 2 * info.setWidth) < 1,
      'trackW=' + num2(info.trackW) + ' 2x=' + num2(2 * info.setWidth));
    check('A4 the second copy starts at offsetLeft === setWidth',
      Math.abs(info.cloneFirstOffsetLeft - info.setWidth) < 0.5,
      'offsetLeft=' + num2(info.cloneFirstOffsetLeft) + ' setWidth=' + num2(info.setWidth));
    check('A5 clones are aria-hidden + out of the tab order',
      info.cloneAria === 'true' && info.cloneTab === '-1' && info.cloneLinkTabs,
      'aria=' + info.cloneAria + ' rootTab=' + info.cloneTab + ' linksTab=-1:' + info.cloneLinkTabs);

    // --- B. the keyframe is gone; only transform animates (AC) -----------
    check('A6 the track carries no CSS animation', info.trackAnimName === 'none', info.trackAnimName);
    check('A7 no per-card animation or opacity', info.cardAnimName === 'none' && info.cardOpacity === '1',
      'anim=' + info.cardAnimName + ' opacity=' + info.cardOpacity);
    check('A8 the track opts into compositing', info.willChange === 'transform', info.willChange);
    check('A9 looping viewport is overflow hidden', info.viewportOverflowX === 'hidden', info.viewportOverflowX);
    // D5 / R1: horizontal panning must be handed to the drag module, not the
    // browser. And `pan-y` alone excludes pinch-zoom (Pointer Events spec), which
    // would disable pinch-zoom on the strip — an accessibility regression, since
    // before this change the element had no touch-action at all. Both tokens must
    // be present. Firefox reports the pair in source order: "pan-y pinch-zoom".
    check('A10 looping viewport gives horizontal pan to JS but keeps pinch-zoom (D5)',
      taHas(info.viewportTouchAction, 'pan-y') && taHas(info.viewportTouchAction, 'pinch-zoom'),
      info.viewportTouchAction);

    // --- C. auto-advance is live and transform-owned ---------------------
    const adv1 = await probe(page);
    await page.waitForTimeout(450);
    const adv2 = await probe(page);
    check('A11 the probe exists and reports the module installed', !!adv1 && adv1.installed === true,
      JSON.stringify(adv1));
    check('A12 auto-advance moves the offset', !!adv1 && !!adv2 && Math.abs(adv2.offset - adv1.offset) > 1,
      'offset ' + num2(adv1 && adv1.offset) + ' -> ' + num2(adv2 && adv2.offset));
    const tform = await page.evaluate(function () {
      function tx() {
        const t = getComputedStyle(document.getElementById('useful-track')).transform;
        if (t === 'none') return null;
        return new DOMMatrixReadOnly(t).m41;
      }
      const a = tx();
      return new Promise(function (resolve) {
        setTimeout(function () { resolve({ a: a, b: tx(), offset: window.__usefulCarousel.state().offset }); }, 300);
      });
    });
    check('A13 the animated property is a transform that changes per frame',
      tform.a !== null && tform.b !== null && Math.abs(tform.b - tform.a) > 0.5,
      'm41 ' + num2(tform.a) + ' -> ' + num2(tform.b));
    check('A14 the offset stays inside one set width (invariant)',
      !!adv2 && adv2.offset > -adv2.setWidth - 1 && adv2.offset <= 0.5,
      'offset=' + num2(adv2 && adv2.offset) + ' setWidth=' + num2(adv2 && adv2.setWidth));

    // --- D. keyboard focus reveal + pause (R9) ---------------------------
    const reveal = await page.evaluate(function () {
      const track = document.getElementById('useful-track');
      const cards = track.children;
      // index 4 is off-screen to the right at the resting position
      const card = cards[4];
      card.querySelector('.useful-card__link').focus();
      const vp = document.getElementById('useful-viewport').getBoundingClientRect();
      const cr = card.getBoundingClientRect();
      return {
        activeIsLink: document.activeElement.classList.contains('useful-card__link'),
        inside: cr.left >= vp.left - 0.5 && cr.right <= vp.right + 0.5,
        cardLeft: cr.left, cardRight: cr.right, vpLeft: vp.left, vpRight: vp.right,
        scrollLeft: document.getElementById('useful-viewport').scrollLeft
      };
    });
    check('A15 focusing an off-screen card brings it inside the visible box (R9)',
      reveal.inside, JSON.stringify(reveal));
    check('A16 focus reveal does not use scrollLeft (one owner, D9)', reveal.scrollLeft === 0,
      'scrollLeft=' + reveal.scrollLeft);
    const f1 = await probe(page);
    await page.waitForTimeout(450);
    const f2 = await probe(page);
    check('A17 keyboard focus pauses auto-advance',
      !!f1 && f1.focusWithin === true && Math.abs(f2.offset - f1.offset) < 0.01,
      'focusWithin=' + (f1 && f1.focusWithin) + ' offset ' + num2(f1 && f1.offset) + ' -> ' + num2(f2 && f2.offset));
    await page.evaluate(function () { document.activeElement.blur(); });
    await page.waitForTimeout(120);
    const f3 = await probe(page);
    await page.waitForTimeout(400);
    const f4 = await probe(page);
    check('A18 blurring resumes auto-advance', Math.abs(f4.offset - f3.offset) > 1,
      'offset ' + num2(f3.offset) + ' -> ' + num2(f4.offset));

    // --- E. hover pause ---------------------------------------------------
    const box = await boxOf(page, '#useful-viewport');
    await page.mouse.move(box.x + box.width / 2, box.y + 30);
    await page.waitForTimeout(120);
    const h1 = await probe(page);
    await page.waitForTimeout(450);
    const h2 = await probe(page);
    check('A19 hovering pauses auto-advance',
      !!h1 && h1.hovering === true && Math.abs(h2.offset - h1.offset) < 0.01,
      'hovering=' + (h1 && h1.hovering));
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await page.waitForTimeout(150);
    const h3 = await probe(page);
    await page.waitForTimeout(450);
    const h4 = await probe(page);
    check('A20 moving the pointer away resumes auto-advance',
      !!h3 && h3.hovering === false && Math.abs(h4.offset - h3.offset) > 1,
      'hovering=' + (h3 && h3.hovering) + ' offset ' + num2(h3 && h3.offset) + ' -> ' + num2(h4 && h4.offset));

    // --- F. mouse drag moves the strip by exactly D (R1) ------------------
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await page.waitForTimeout(80);
    await page.mouse.move(box.x + 400, box.y + 30);
    await page.mouse.down();
    const dragBefore = await probe(page);
    await page.mouse.move(box.x + 400 + 120, box.y + 30, { steps: 4 });
    const dragAfter = await probe(page);
    await page.mouse.up();
    const dDelta = wrapDelta(dragAfter.offset - dragBefore.offset, dragBefore.setWidth);
    check('A21 a 120px mouse drag moves the track 120px (+/-1)', Math.abs(dDelta - 120) <= 1,
      'delta=' + num2(dDelta));
    check('A22 a drag is reported as dragging',
      !!(dragBefore && dragAfter && dragAfter.dragging === true), JSON.stringify(dragAfter));

    // D4: a fast release carries the strip on instead of stopping dead under
    // the finger. (A touch flick that stops instantly reads as a broken control.)
    const i1 = await probe(page);
    await page.waitForTimeout(200);
    const i2 = await probe(page);
    check('A22b a fast release carries the strip on (inertia, D4)',
      Math.abs(i2.offset - i1.offset) > 1,
      'offset ' + num2(i1.offset) + ' -> ' + num2(i2.offset));
    await page.waitForTimeout(2800);   // let the fling die before the next gesture

    // Vertical movement must not produce horizontal travel.
    await page.mouse.move(box.x + 400, box.y + 20);
    await page.mouse.down();
    const vBefore = await probe(page);
    await page.mouse.move(box.x + 400, box.y + 90, { steps: 4 });
    const vAfter = await probe(page);
    await page.mouse.up();
    check('A23 a vertical mouse drag produces no horizontal movement',
      Math.abs(wrapDelta(vAfter.offset - vBefore.offset, vBefore.setWidth)) < 0.01,
      'delta=' + num2(wrapDelta(vAfter.offset - vBefore.offset, vBefore.setWidth)));

    // --- G. touch swipe (dispatched PointerEvents, pointerType:'touch') ---
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await page.waitForTimeout(80);
    const touch = await page.evaluate(function (arg) {
      const vp = document.getElementById('useful-viewport');
      const st0 = window.__usefulCarousel.state();
      const state = function () { return window.__usefulCarousel.state().offset; };
      function ev(type, x, y) {
        vp.dispatchEvent(new PointerEvent(type, {
          pointerId: 42, pointerType: 'touch', isPrimary: true, button: 0,
          buttons: type === 'pointerup' ? 0 : 1,
          clientX: x, clientY: y, bubbles: true, cancelable: true
        }));
      }
      const start = state();
      ev('pointerdown', arg.x, arg.y);
      ev('pointermove', arg.x + 90, arg.y);
      const afterH = state();
      ev('pointerup', arg.x + 90, arg.y);
      const afterV0 = state();
      ev('pointerdown', arg.x, arg.y);
      ev('pointermove', arg.x, arg.y + 90);
      const afterV = state();
      ev('pointerup', arg.x, arg.y + 90);
      return { start: start, afterH: afterH, afterV0: afterV0, afterV: afterV, w: st0.setWidth };
    }, { x: Math.round(box.x + 400), y: Math.round(box.y + 40) });
    check('A24 a horizontal touch swipe moves the strip',
      Math.abs(wrapDelta(touch.afterH - touch.start, touch.w) - 90) <= 1,
      'delta=' + num2(wrapDelta(touch.afterH - touch.start, touch.w)));
    check('A25 a vertical touch swipe leaves the strip position unchanged',
      Math.abs(wrapDelta(touch.afterV - touch.afterV0, touch.w)) < 0.01,
      'delta=' + num2(wrapDelta(touch.afterV - touch.afterV0, touch.w)));

    // --- H. wheel: horizontal intent only (R3) ----------------------------
    const wheel = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport');
      const st = function () { return window.__usefulCarousel.state(); };
      const before = st().offset;
      const ev1 = new WheelEvent('wheel', { deltaX: 100, deltaY: 0, bubbles: true, cancelable: true });
      const hNotCanceled = vp.dispatchEvent(ev1);
      const after = st().offset;
      const before2 = st().offset;
      const ev2 = new WheelEvent('wheel', { deltaX: 0, deltaY: 120, bubbles: true, cancelable: true });
      const vNotCanceled = vp.dispatchEvent(ev2);
      const after2 = st().offset;
      return { before: before, after: after, hNotCanceled: hNotCanceled, w: st().setWidth,
               before2: before2, after2: after2, vNotCanceled: vNotCanceled };
    });
    check('A26 a wheel with deltaX moves the strip by -deltaX',
      Math.abs(wrapDelta(wheel.after - wheel.before, wheel.w) + 100) <= 1,
      'delta=' + num2(wrapDelta(wheel.after - wheel.before, wheel.w)));
    check('A27 a horizontal wheel is consumed (preventDefault)',
      wheel.hNotCanceled === false, 'dispatchEvent returned ' + wheel.hNotCanceled);
    // Negative control: the page must still scroll through a vertical wheel.
    check('A28 a vertical wheel does not move the strip',
      Math.abs(wrapDelta(wheel.after2 - wheel.before2, wheel.w)) < 0.01,
      'delta=' + num2(wrapDelta(wheel.after2 - wheel.before2, wheel.w)));
    check('A29 a vertical wheel does NOT preventDefault (page keeps scrolling)',
      wheel.vNotCanceled === true, 'dispatchEvent returned ' + wheel.vNotCanceled);

    // --- I. resume 2000ms after a no-velocity release (R4) ----------------
    // Drag with a pause before release: the staleness guard zeroes velocity, so
    // there is no inertia to confuse "started moving again".
    await page.mouse.move(box.x + 400, box.y + 30);
    await page.mouse.down();
    await page.mouse.move(box.x + 440, box.y + 30, { steps: 3 });
    await page.waitForTimeout(200);
    await page.mouse.up();
    const releaseAt = Date.now();
    // Leave the viewport so hover does not hold it paused.
    await page.mouse.move(box.x + box.width / 2, box.y - 60);
    await page.waitForTimeout(300);
    const r1 = await probe(page);
    await page.waitForTimeout(1400);          // ~1.7s after release
    const r2 = await probe(page);
    await page.waitForTimeout(700);           // ~2.4s after release
    const r3 = await probe(page);
    check('A30 the strip is stationary for the first 2s after release',
      Math.abs(r2.offset - r1.offset) < 0.01,
      'offset ' + num2(r1.offset) + ' -> ' + num2(r2.offset) + ' (' + (Date.now() - releaseAt) + 'ms)');
    check('A31 auto-advance resumes 2s after release', Math.abs(r3.offset - r2.offset) > 1,
      'offset ' + num2(r2.offset) + ' -> ' + num2(r3.offset));

    // --- J. drag vs click (R6) -------------------------------------------
    await page.waitForTimeout(2200);   // let any resume settle
    const preClick = await probe(page);
    check('A32-pre0 no gesture is still active before the click tests', !preClick.dragging,
      'dragging=' + preClick.dragging + ' hovering=' + preClick.hovering +
      ' state=' + JSON.stringify(preClick));
    await resetClicks(page);
    const clickBox = await visibleCardCenter(page);
    check('A32-pre the drag starts over a card link that is actually on screen',
      !!clickBox && clickBox.isLink, JSON.stringify(clickBox));
    await page.mouse.move(clickBox.x, clickBox.y);
    await page.mouse.down();
    await page.mouse.move(clickBox.x + 90, clickBox.y, { steps: 5 });
    await page.waitForTimeout(150);   // kill the fling so the card stays on screen
    await page.mouse.up();
    check('A32 a >6px drag over a card does not navigate', (await readClicks(page)) === 0,
      'clicks=' + (await readClicks(page)));

    await resetClicks(page);
    const underBox = await visibleCardCenter(page);
    check('A33-pre the press starts over a card link that is actually on screen',
      !!underBox && underBox.isLink, JSON.stringify(underBox));
    await page.mouse.move(underBox.x, underBox.y);
    await page.mouse.down();
    await page.mouse.up();
    check('A33 a press under the threshold still navigates', (await readClicks(page)) === 1,
      'clicks=' + (await readClicks(page)) + ' seen=' +
      JSON.stringify(await page.evaluate(function () { return window.__clickSeen; })) +
      ' state=' + JSON.stringify(await probe(page)));

    // Clone click: bring the duplicated half on screen, then press and release
    // on a clone. It must navigate AND must not leave focus in the aria-hidden
    // subtree (the clone's mousedown preventDefault is what guarantees that).
    const target = await page.evaluate(function () {
      const st = window.__usefulCarousel.state();
      // want a clone (index 8) whose center is comfortably inside the viewport
      const cards = document.querySelectorAll('#useful-track > .useful-card');
      const clone = cards[8];
      const vp = document.getElementById('useful-viewport').getBoundingClientRect();
      const want = vp.left + vp.width / 2 - (clone.offsetLeft + clone.offsetWidth / 2);
      // move the strip by (want - current offset)
      return { delta: want - st.offset, setWidth: st.setWidth };
    });
    await dragBy(page, box, Math.round(wrapDelta(target.delta, target.setWidth)));
    const cloneHit = await page.evaluate(function () {
      const clone = document.querySelectorAll('#useful-track > .useful-card')[8];
      const r = clone.getBoundingClientRect();
      return { aria: clone.getAttribute('aria-hidden'), x: r.left + r.width / 2, y: r.top + r.height / 2,
               inView: r.left >= 0 && r.right <= window.innerWidth };
    });
    await resetClicks(page);
    await page.mouse.move(cloneHit.x, cloneHit.y);
    await page.mouse.down();
    await page.mouse.up();
    const cloneState = await page.evaluate(function () {
      const ae = document.activeElement;
      return { clicks: window.__clicks,
               activeIsBody: ae === document.body,
               activeInClone: !!(ae && ae.closest && ae.closest('[aria-hidden="true"]') && ae.closest('[aria-hidden="true"]').classList.contains('useful-card')) };
    });
    check('A34 the clone half is on screen for the click test', cloneHit.aria === 'true' && cloneHit.inView,
      JSON.stringify(cloneHit));
    check('A35 clicking a duplicated card still fires the click', cloneState.clicks === 1,
      'clicks=' + cloneState.clicks);
    check('A36 focus is not left inside an aria-hidden clone',
      !cloneState.activeInClone, 'activeIsBody=' + cloneState.activeIsBody + ' inClone=' + cloneState.activeInClone);

    // --- J2. the 300ms pointer guard in reveal() (R9 vs R6) ---------------
    // mousedown focuses the card link -> focusin -> reveal(). reveal() exists for
    // keyboard Tab (R9), but it must NOT fire for a mouse press: it would shift
    // the track between mousedown and mouseup, moving the card out from under the
    // pointer. So press-and-hold a card that is clipped by the viewport's right
    // edge and assert the strip does not move during the press. Park a known card
    // at the clip point first: drag to offset -288 so card index 3 (track right
    // edge 1188) overhangs the 860px viewport by 40px.
    const clipBase = await probe(page);
    await dragBy(page, box, Math.round(wrapDelta(-288 - clipBase.offset, clipBase.setWidth)));
    await page.waitForTimeout(400);   // still inside the 2s post-release pause
    const guardPre = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport').getBoundingClientRect();
      const cards = document.querySelectorAll('#useful-track > .useful-card');
      for (let i = 0; i < cards.length; i++) {
        const r = cards[i].getBoundingClientRect();
        if (r.right - vp.right > 8 && r.left < vp.right - 30) {
          const x = vp.right - 20, y = r.top + r.height / 2;
          const el = document.elementFromPoint(x, y);
          return { i: i, x: x, y: y, overflow: r.right - vp.right,
                   isLink: !!(el && el.classList && el.classList.contains('useful-card__link')) };
        }
      }
      return null;
    });
    check('A44-pre a card is clipped by the viewport under the press point',
      !!guardPre && guardPre.isLink, JSON.stringify(guardPre));
    await resetClicks(page);
    await page.mouse.move(guardPre.x, guardPre.y);
    await page.waitForTimeout(120);   // hovering pauses auto-advance, so the baseline is stable
    const guardBefore = await probe(page);
    await page.mouse.down();
    await page.waitForTimeout(250);
    const guardDuring = await probe(page);
    await page.mouse.up();
    const guardAfter = await page.evaluate(function () {
      const ae = document.activeElement;
      return { clicks: window.__clicks,
               active: String((ae && (ae.className || ae.tagName)) || '') };
    });
    check('A45 the strip does not move between mousedown and mouseup on a clipped card',
      !!guardBefore && !!guardDuring &&
      Math.abs(wrapDelta(guardDuring.offset - guardBefore.offset, guardBefore.setWidth)) < 0.5,
      'offset ' + num2(guardBefore && guardBefore.offset) + ' -> ' + num2(guardDuring && guardDuring.offset));
    // The guard's purpose: a press (not a drag) still navigates to the card it
    // landed on. Its link must receive the click, which only happens if the track
    // did not move under the pointer between down and up.
    check('A46 a press on a clipped card still navigates',
      guardAfter.clicks === 1, 'clicks=' + guardAfter.clicks + ' active=' + guardAfter.active);
    await page.evaluate(function () { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });

    // --- K. native drag-and-drop is cancelled (R7) ------------------------
    const dnd = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport');
      const img = document.querySelector('.useful-card__thumb');
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true });
      const notCanceled = img.dispatchEvent(ev);
      return { notCanceled: notCanceled };
    });
    check('A37 a dragstart inside the viewport is cancelled', dnd.notCanceled === false,
      'dispatchEvent returned ' + dnd.notCanceled);

    // A mousedown-drag that starts on top of a card's overlay link must still move it.
    await page.mouse.move(box.x + 300, box.y + 30);
    const linkDragBefore = await probe(page);
    await page.mouse.down();
    await page.mouse.move(box.x + 300 + 100, box.y + 30, { steps: 4 });
    const linkDragAfter = await probe(page);
    await page.waitForTimeout(150);
    await page.mouse.up();
    check('A38 a drag starting on the overlay link still moves the strip',
      Math.abs(wrapDelta(linkDragAfter.offset - linkDragBefore.offset, linkDragBefore.setWidth) - 100) <= 2,
      'delta=' + num2(wrapDelta(linkDragAfter.offset - linkDragBefore.offset, linkDragBefore.setWidth)));

    // --- L. no walls in either direction (R5) -----------------------------
    const holdTests = [{ dx: 6000 }, { dx: -6000 }];
    let outOfRange = null, congruentOk = true;
    for (const t of holdTests) {
      const before = await probe(page);
      await dragBy(page, box, t.dx);
      const after = await probe(page);
      if (!(after.offset > -after.setWidth - 1 && after.offset <= 0.5)) {
        outOfRange = JSON.stringify(after);
      }
      if (Math.abs(wrapDelta(after.offset - before.offset, after.setWidth) - wrapDelta(t.dx, after.setWidth)) > 2) {
        congruentOk = false;
      }
    }
    // Congruence at the wrap point: an exact one-set move must land on the same
    // pixel (the two copies are identical).
    const beforeExact = await probe(page);
    await dragBy(page, box, beforeExact.setWidth);
    const afterExact = await probe(page);
    check('A39 held for several set widths the offset never leaves (-setWidth, 0]',
      outOfRange === null, outOfRange === null ? 'ok' : outOfRange);
    check('A40 the loop has no walls in either direction (no clamping)',
      outOfRange === null && congruentOk);
    check('A41 a one-set drag is congruent modulo setWidth (seam invisible)',
      Math.abs(wrapDelta(afterExact.offset - beforeExact.offset, afterExact.setWidth)) < 1,
      'delta=' + num2(wrapDelta(afterExact.offset - beforeExact.offset, afterExact.setWidth)));

    // --- M. one owner of horizontal position (D9) -------------------------
    const scroll = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport');
      vp.scrollLeft = 40;
      return new Promise(function (resolve) {
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          resolve({ after: vp.scrollLeft, probe: window.__usefulCarousel.state().scrollLeft });
        }); });
      });
    });
    check('A42 the tick forces scrollLeft back to 0 (one owner, D9)',
      scroll.after === 0 && scroll.probe === 0, 'scrollLeft=' + scroll.after);

    check('A43 no uncaught page errors on the looping page', pageErrors.length === 0, pageErrors.join(' | '));

    await context.close();
  }

  // ======================================================================
  // Phase B — non-looping / fail-safe state, 2 regions at 1000px then 320px
  // ======================================================================
  {
    const fx = fixtures(2);
    const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
    await installRoutes(context, fx);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String((e && e.message) || e)); });
    await boot(page, 2);   // 2 cards: setWidth 600 < 860px content box at 1000px

    const b = await page.evaluate(function () {
      const track = document.getElementById('useful-track');
      const vp = document.getElementById('useful-viewport');
      const st = window.__usefulCarousel ? window.__usefulCarousel.state() : null;
      return {
        cards: track.children.length,
        animatedClass: track.classList.contains('useful-carousel__track--animated'),
        animName: getComputedStyle(track).animationName,
        touchAction: getComputedStyle(vp).touchAction,
        overflowX: getComputedStyle(vp).overflowX,
        state: st
      };
    });
    check('B1 a set that fits is not duplicated', b.cards === 2, 'cards=' + b.cards);
    check('B2 a set that fits does not animate', !b.animatedClass && b.animName === 'none',
      'class=' + b.animatedClass + ' anim=' + b.animName);
    check('B3 non-looping viewport is natively scrollable', b.overflowX === 'auto', b.overflowX);
    // D5 negative control: the drag-state touch-action must NOT be hoisted onto
    // the base class, or the overflowing cards this state exists to keep
    // reachable become unreachable. Asserting the untouched computed `auto` is
    // what makes the hoist fail: either `pan-y` or `pan-y pinch-zoom` on the base
    // class turns this red.
    check('B4 non-looping viewport leaves touch-action untouched (auto)', b.touchAction === 'auto',
      b.touchAction);
    check('B5 the probe reports the module not installed', !!b.state && b.state.installed === false,
      JSON.stringify(b.state));

    // R8b fail-safe: load wide (static decision), then narrow. The cards must
    // still be reachable by scrolling, not stranded outside overflow:hidden.
    await page.setViewportSize({ width: 320, height: 700 });
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport');
      const cs = getComputedStyle(vp);
      const max = vp.scrollWidth - vp.clientWidth;
      vp.scrollLeft = max;
      return new Promise(function (resolve) {
        resolve({ overflowX: cs.overflowX, scrollW: vp.scrollWidth, clientW: vp.clientWidth,
                  max: max, reached: vp.scrollLeft });
      });
    });
    check('B6 after narrowing, the stale static strip is still scrollable',
      narrow.overflowX === 'auto' && narrow.max > 0 && narrow.reached > 0,
      'overflowX=' + narrow.overflowX + ' max=' + narrow.max + ' reached=' + num2(narrow.reached));
    check('B7 no uncaught page errors on the non-looping page', pageErrors.length === 0, pageErrors.join(' | '));

    await context.close();
  }

  // ======================================================================
  // Phase C — prefers-reduced-motion: static + natively scrollable (R10)
  // ======================================================================
  {
    const fx = fixtures(8);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
    await installRoutes(context, fx);
    // Count every rAF scheduled from page load on; the counter is reset again
    // right after boot so only the quiet window below is measured.
    await context.addInitScript(RAF_COUNTER);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String((e && e.message) || e)); });
    await boot(page, 16);

    const c = await page.evaluate(function () {
      const track = document.getElementById('useful-track');
      const vp = document.getElementById('useful-viewport');
      const st = window.__usefulCarousel ? window.__usefulCarousel.state() : null;
      return { transform: getComputedStyle(track).transform,
               overflowX: getComputedStyle(vp).overflowX,
               touchAction: getComputedStyle(vp).touchAction,
               state: st,
               max: vp.scrollWidth - vp.clientWidth };
    });
    check('C1 reduced motion is seen by the module', !!c.state && c.state.reduceMotion === true,
      JSON.stringify(c.state));
    check('C2 reduced motion leaves no transform on the track', c.transform === 'none', c.transform);
    check('C3 reduced motion keeps the native scroll affordance', c.overflowX === 'auto', c.overflowX);
    // The looping state sets touch-action: pan-y pinch-zoom, which would block
    // horizontal touch panning on the natively-scrollable reduced-motion strip and
    // strand the cards off-screen on a touch device. The reduced-motion block must
    // restore the untouched value.
    check('C3b reduced motion restores touch-action: auto (touch scrolling works)',
      c.touchAction === 'auto', c.touchAction);
    // The loop must be stopped, not merely re-checked each frame: no rAF callback
    // may be scheduled at all, and the probe must report running === false. This
    // is the assertion that goes red when the module keeps rescheduling under
    // reduced motion (the old per-frame matchMedia() gate).
    const rafQuiet = await page.evaluate(function () {
      window.__raf = 0;
      return new Promise(function (resolve) { setTimeout(function () { resolve(window.__raf); }, 300); });
    });
    check('C3c reduced motion schedules no rAF callback at all',
      rafQuiet === 0 && c.state.running === false,
      'raf=' + rafQuiet + ' running=' + (c.state && c.state.running) +
      ' installed=' + (c.state && c.state.installed));

    const c1 = await probe(page);
    await page.waitForTimeout(500);
    const c2 = await probe(page);
    check('C4 reduced motion never auto-advances',
      !!c1 && !!c2 && c1.offset === 0 && c2.offset === 0,
      'offset ' + num2(c1 && c1.offset) + ' -> ' + num2(c2 && c2.offset));

    const reach = await page.evaluate(function () {
      const vp = document.getElementById('useful-viewport');
      const max = vp.scrollWidth - vp.clientWidth;
      vp.scrollLeft = max;
      const cards = document.querySelectorAll('#useful-track > .useful-card');
      const last = cards[cards.length - 1].getBoundingClientRect();
      const vr = vp.getBoundingClientRect();
      return { max: max, reached: vp.scrollLeft, lastInside: last.right <= vr.right + 1 };
    });
    check('C5 under reduced motion every card is reachable by scrolling',
      reach.max > 0 && reach.reached > 0 && reach.lastInside, JSON.stringify(reach));

    // The reduced-at-load path must re-arm when the setting is turned off. Here
    // the handlers were never installed at init, so only a change listener can
    // bring them back — the old one-shot `installed = !reduced()` left this dead.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(400);
    const g1 = await probe(page);
    await page.waitForTimeout(400);
    const g2 = await probe(page);
    check('C7 toggling reduced motion off after a reduced load restarts the loop',
      !!g1 && !!g2 && g1.running === true && g1.installed === true && Math.abs(g2.offset - g1.offset) > 1,
      'running=' + (g1 && g1.running) + ' installed=' + (g1 && g1.installed) +
      ' offset ' + num2(g1 && g1.offset) + ' -> ' + num2(g2 && g2.offset));

    const cbox = await boxOf(page, '#useful-viewport');
    await page.mouse.move(cbox.x + 400, cbox.y - 60);
    await page.waitForTimeout(80);
    await page.mouse.move(cbox.x + 400, cbox.y + 30);
    await page.mouse.down();
    const cgBefore = await probe(page);
    await page.mouse.move(cbox.x + 400 + 90, cbox.y + 30, { steps: 4 });
    const cgAfter = await probe(page);
    await page.mouse.up();
    check('C8 dragging works after reduced motion is switched off (handlers re-installed)',
      Math.abs(wrapDelta(cgAfter.offset - cgBefore.offset, cgBefore.setWidth) - 90) <= 1,
      'delta=' + num2(wrapDelta(cgAfter.offset - cgBefore.offset, cgBefore.setWidth)));

    check('C6 no uncaught page errors under reduced motion', pageErrors.length === 0, pageErrors.join(' | '));
    await context.close();
  }

  // ======================================================================
  // Phase D — reduced-motion OFF control, and toggled ON mid-session (R10)
  // ======================================================================
  {
    const fx = fixtures(8);
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await installRoutes(context, fx);
    const page = await context.newPage();
    await boot(page, 16);

    // Control: with the setting OFF the very same probe shows motion. This is
    // what makes the Phase C "static" result attributable to the setting rather
    // than to a module that never moves.
    const d1 = await probe(page);
    await page.waitForTimeout(450);
    const d2 = await probe(page);
    check('D1 (control) with reduced motion off the strip auto-advances',
      !!d1 && !!d2 && d1.reduceMotion === false && Math.abs(d2.offset - d1.offset) > 1,
      'reduceMotion=' + (d1 && d1.reduceMotion) + ' offset ' + num2(d1 && d1.offset) + ' -> ' + num2(d2 && d2.offset));

    // Toggling the setting on while the page is open must stop it — and stop the
    // loop itself, not just freeze the offset. A `change` listener (not per-frame
    // polling) is what drives it.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForTimeout(400);
    const d3 = await probe(page);
    await page.waitForTimeout(400);
    const d4 = await page.evaluate(function () {
      return { st: window.__usefulCarousel.state(),
               transform: getComputedStyle(document.getElementById('useful-track')).transform };
    });
    check('D2 toggling reduced motion on stops the motion',
      !!d3 && !!d4.st && d3.offset === 0 && d4.st.offset === 0,
      'offset ' + num2(d3 && d3.offset) + ' -> ' + num2(d4.st && d4.st.offset));
    check('D3 toggling reduced motion on removes the transform', d4.transform === 'none', d4.transform);
    check('D3b toggling reduced motion on stops the rAF loop and drops the handlers',
      !!d4.st && d4.st.running === false && d4.st.installed === false,
      'running=' + (d4.st && d4.st.running) + ' installed=' + (d4.st && d4.st.installed));

    // ...and toggling it back off must re-arm everything: the loop restarts, the
    // transform is written again, and a mouse drag works (handlers reinstalled by
    // the idempotent installHandlers(), which the old one-shot `installed` flag
    // left half-wired).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.waitForTimeout(400);
    const e1 = await probe(page);
    await page.waitForTimeout(400);
    const e2 = await probe(page);
    check('D4 toggling reduced motion off restarts the loop',
      !!e1 && !!e2 && e1.running === true && e1.installed === true && Math.abs(e2.offset - e1.offset) > 1,
      'running=' + (e1 && e1.running) + ' installed=' + (e1 && e1.installed) +
      ' offset ' + num2(e1 && e1.offset) + ' -> ' + num2(e2 && e2.offset));

    const dbox = await boxOf(page, '#useful-viewport');
    await page.mouse.move(dbox.x + 400, dbox.y - 60);
    await page.waitForTimeout(80);
    await page.mouse.move(dbox.x + 400, dbox.y + 30);
    await page.mouse.down();
    const offBefore = await probe(page);
    await page.mouse.move(dbox.x + 400 + 90, dbox.y + 30, { steps: 4 });
    const offAfter = await probe(page);
    await page.mouse.up();
    check('D5 dragging works again after reduced motion is switched off',
      Math.abs(wrapDelta(offAfter.offset - offBefore.offset, offBefore.setWidth) - 90) <= 1,
      'delta=' + num2(wrapDelta(offAfter.offset - offBefore.offset, offBefore.setWidth)));

    await context.close();
  }

  // ======================================================================
  // Phase E — Most Useful 卡片上的计数徽章（2026-10-04 入场券放宽到三项任一 >= 2）
  // ======================================================================
  // 这条契约有上下两半，分在两个脚本里验：
  //   服务端决定**谁上榜** → scripts/test-reactions.js 的 checkTopMeta，把真 handler 发出的
  //                          SQL 拿去真 SQLite 跑；
  //   前端决定**上榜后显哪几个计数** → 这里。
  // 这里要挡的回归是「只显 👍」：一张靠 goat 进来的卡会渲染成「👍 0」，看着像坏了。
  // 所以夹具里特意放了 goat 达标、useful 只有 1 的行 —— 断言它**只**出现 GOAT 那一块牌。
  {
    const regions = [
      { region_id: 's1', name: 'Goat only', country_id: 'canada', goat_count: 2, heart_count: 0, useful_count: 0 },
      { region_id: 's2', name: 'Heart only', country_id: 'hawaii', goat_count: 0, heart_count: 2, useful_count: 0 },
      { region_id: 's3', name: 'All three', country_id: 'france', goat_count: 4, heart_count: 3, useful_count: 5 },
      { region_id: 's4', name: 'Mixed below', country_id: 'japan', goat_count: 7, heart_count: 1, useful_count: 1 },
    ];
    const fx = {
      COUNTRIES: { countries: regions.map(function (r) { return { id: r.country_id, name: r.country_id, flag: 'xx', active: 1 }; }) },
      REACTIONS: { regions: regions },
      SUBMISSIONS: regions.map(function (r) {
        return { id: r.region_id, name: r.name, description: 'D', tags: [], country_id: r.country_id,
                 submitted_by: 'tester', source_type: '', source_url: '', created_at: '2026-01-01',
                 streetview: {}, link: '' };
      }),
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await installRoutes(context, fx);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String((e && e.message) || e)); });
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(function () {
      return document.querySelectorAll('#useful-track > .useful-card').length >= 4;
    }, null, { timeout: 15000 });

    const got = await page.evaluate(function () {
      const out = {};
      const cards = Array.prototype.slice.call(document.querySelectorAll('#useful-track > .useful-card'));
      cards.forEach(function (c) {
        const nameEl = c.querySelector('.useful-card__name');
        const head = c.querySelector('.useful-card__head');
        out[nameEl.textContent] = {
          labels: Array.prototype.slice.call(c.querySelectorAll('.useful-card__counts > .useful-card__count'))
            .map(function (x) { return x.getAttribute('aria-label'); }),
          srcs: Array.prototype.slice.call(c.querySelectorAll('.useful-card__counts img'))
            .map(function (i) { return i.getAttribute('src'); }),
          spill: head.scrollWidth - head.clientWidth,
        };
      });
      return out;
    });

    check('E1 靠 goat 上榜的卡片显示 GOAT 计数（不是「👍 0」）',
      JSON.stringify((got['Goat only'] || {}).labels) === JSON.stringify(['2 GOAT']),
      JSON.stringify(got['Goat only']));
    check('E2 靠 heart 上榜的卡片显示 Thanks 计数',
      JSON.stringify((got['Heart only'] || {}).labels) === JSON.stringify(['2 Thanks']),
      JSON.stringify(got['Heart only']));
    check('E3 三项都达标的卡片三块牌按 goat → heart → useful 顺序全显',
      JSON.stringify((got['All three'] || {}).labels) === JSON.stringify(['4 GOAT', '3 Thanks', '5 Useful']),
      JSON.stringify(got['All three']));
    check('E4 没达标的项不露面（goat=7 而 useful=1 时只显 GOAT 一块）',
      JSON.stringify((got['Mixed below'] || {}).labels) === JSON.stringify(['7 GOAT']),
      JSON.stringify(got['Mixed below']));
    check('E5 计数图标走自托管 Twemoji（goat=1f410 / heart=2764）',
      (got['Goat only'] || {}).srcs && got['Goat only'].srcs[0] === 'images/twemoji/1f410.svg?v=1'
      && (got['Heart only'] || {}).srcs && got['Heart only'].srcs[0] === 'images/twemoji/2764.svg?v=1',
      JSON.stringify({ goat: (got['Goat only'] || {}).srcs, heart: (got['Heart only'] || {}).srcs }));
    check('E6 三块牌挤在一起时 head 行不溢出（名字负责截断）',
      Object.keys(got).every(function (k) { return got[k].spill <= 0; }),
      JSON.stringify(Object.keys(got).map(function (k) { return k + '=' + got[k].spill; })));
    check('E7 useful 区无 JS 报错', pageErrors.length === 0, pageErrors);

    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (err) {
  console.error('HARNESS ERROR:', (err && err.stack) || err);
  process.exit(1);
});

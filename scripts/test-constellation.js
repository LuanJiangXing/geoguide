// Playwright harness for the homepage contributor constellation
// (public/index.html's inline canvas module, `#most-contributed`).
//
// Why this needs its own script. The constellation is a rAF-driven canvas whose
// content is invisible to every other harness: the avatars come from
// cdn.discordapp.com and cross-origin images taint the canvas, so pixels cannot
// be read (getImageData throws SecurityError) and this environment cannot view
// images anyway. The module therefore exposes `window.__constellation` — a
// read-only probe — and every assertion here reads numbers from it or from
// instrumented canvas draw calls. Nothing is asserted by eye.
//
// How the geometry is made deterministic. The nodes drift (~20s period), so a
// single sample is not reproducible. Rather than sampling in real time, the
// harness overrides `performance.now()` with a controllable value: `drawFrame`
// derives its drift phase from it, so pinning it freezes every node at an exact
// position while rAF keeps running. Sweeping the fake clock over one full period
// gives the whole orbit. Before any geometry number is trusted the harness
// asserts the loop is actually running (frame counter advancing + moving the
// fake clock moves the nodes) — a stuck loop would otherwise report static
// anchors as if they were sampled positions (spec §7, trap 2).
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-constellation.js
//   kill $(lsof -ti :3999)
//
// The sandbox has no network: every non-local request is mocked or aborted, and
// flagcdn image loads are served from an in-harness 1x1 PNG. "The sandbox can
// load a real flag" is never a pass condition.
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/$/, '');

// 1x1 transparent PNG — stands in for any successfully loaded flag/avatar image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// A data URL loads without any network at all; the aborted discord URL stands in
// for a real 404/timeout. Both paths are exercised by `entryFor`.
const AVATAR_OK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const AVATAR_DEAD = 'https://cdn.discordapp.com/avatars/1/dead.png';

// Country fixture. `ghostland` is deliberately absent from _countryMap and
// `emptyflag` deliberately has flag:'' — both must cost that node one flag, not
// break it. `zzfail` is a valid flag code whose image request is aborted.
const COUNTRIES = {
  countries: [
    { id: 'canada', name: 'Canada', flag: 'ca' },
    { id: 'hawaii', name: 'Hawaii', flag: 'us-hi' },
    { id: 'paraguay', name: 'Paraguay', flag: 'py' },
    { id: 'south-africa', name: 'South Africa', flag: 'za' },
    { id: 'france', name: 'France', flag: 'fr' }
  ]
};
const COUNTRY_MAP = {
  canada: { name: 'Canada', flag: 'ca' },
  hawaii: { name: 'Hawaii', flag: 'us-hi' },
  paraguay: { name: 'Paraguay', flag: 'py' },
  'south-africa': { name: 'South Africa', flag: 'za' },
  france: { name: 'France', flag: 'fr' },
  emptyflag: { name: 'Empty Flag', flag: '' },
  // A real flag code whose image request the route aborts: it is *decided*
  // (so it reserves a slot) but never loads (so it is simply not painted).
  zzfail: { name: 'ZZ Fail', flag: 'zz-fail' }
  // ghostland intentionally missing
};

// Same long username on every node: a short one would make the "all name boxes
// are the same width" assertion vacuous, because the truncation would never kick
// in. Every node must render the *identical truncated string*.
const LONG_NAME = 'A Very Long Contributor Username';
const THREE = ['canada', 'hawaii', 'paraguay'];

// How many mixed-fixture nodes the boundary clamp catches. Measured, not assumed.
//
// 2026-09-18, before the radial reversal: 1 node (index 19, the spiral's
// outermost bottom anchor pinned against botPad).
// 2026-09-18, after reversing the radial order (index 0, the biggest
// contributor, now takes the outermost ring): 0. The node that used to be pinned
// is now near the centre, and the big node that took its place is pulled inside
// by rhoMax -- so the reversal removed the clamp rather than moving it.
const MIXED_CLAMP_EXPECT = 0;

// Budget for name-box-over-body-box collisions (A31b / B5b). See
// accumulateWorstCase's second pass for what is being compared.
//
// This is NOT zero and cannot be tuned to zero. A name box sits only 7-18px
// above its own disc while two discs may legally sit ~10px apart, so the label
// block reaches ~50px further than the geometry every spacing constant is
// calibrated on; there is always a pair where the discs clear and the name does
// not. What relaxNodes() buys is that the residue is shallow rather than deep.
//
// The budget is set from measurement and guards two separate regressions:
// removing relaxNodes() from buildNodes, and shrinking the canvas back down.
// Measured 2026-09-18 with relaxation on: worst phase 2 collisions on both
// fixtures (mixed and ceiling), tightest -3.02px. 6 leaves headroom for the
// count text, the one input measured rather than taken from the probe, without
// letting a missing relaxation pass through.
const BODY_OVERLAP_BUDGET = 6;

function contributors() {
  const list = [];
  for (let i = 0; i < 20; i++) {
    list.push({ user_id: 'u' + i, username: LONG_NAME, avatar_url: '', count: 50, countries: THREE.slice() });
  }
  return list;
}

// Mixed fixture: one node per behaviour under test, then fillers.
function mixedContributors() {
  const list = contributors();
  const set = (i, count, countries, avatar) => {
    list[i] = { user_id: 'u' + i, username: LONG_NAME, avatar_url: avatar || '', count: count, countries: countries };
  };
  set(0, 2, THREE, AVATAR_OK);                              // cap 1  + ready avatar
  set(1, 5, THREE, AVATAR_DEAD);                            // cap 2  + failed avatar
  set(2, 20, THREE);                                        // cap 3
  set(3, 50, ['canada']);                                   // 1 country < cap 3
  set(4, 50, ['canada', 'hawaii']);                         // 2 countries < cap 3
  set(5, 50, ['canada', 'ghostland', 'paraguay']);          // unknown id dropped
  set(6, 50, ['canada', 'emptyflag', 'paraguay']);          // flag:'' dropped
  set(7, 50, ['canada', 'zzfail']);                         // 2 decided, 1 image fails
  set(8, 50, ['canada', 'zzfail', 'paraguay']);             // 3 decided, 1 image fails
  return list;
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL'), name + (detail === undefined ? '' : ' — ' + detail));
}
function num2(v) { return (v === null || v === undefined || !isFinite(v)) ? String(v) : v.toFixed(2); }

async function installRoutes(context) {
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (url.indexOf(BASE) === 0) return route.continue();
    if (url.indexOf('flagcdn.com') !== -1) {
      // A flag whose code contains "zz-fail" must fail to load.
      if (url.indexOf('zz-fail') !== -1) return route.abort();
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    }
    return route.abort();   // discord avatars, unpkg, anything else
  });
  const json = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
  await context.route(/\/api\/countries/, (r) => r.fulfill(json(COUNTRIES)));
  await context.route(/\/api\/auth/, (r) => r.fulfill(json({ user: null })));
  // Empty contributors: the homepage's own Batch 2 must NOT initialise the
  // constellation, so the harness drives initConstellation() alone.
  await context.route(/\/api\/submissions\?action=contributors/, (r) => r.fulfill(json({ contributors: [], total: 0 })));
  await context.route(/\/api\/submissions/, (r) => r.fulfill(json([])));
  await context.route(/\/api\/reactions/, (r) => r.fulfill(json({ regions: [] })));
  await context.route(/\/api\/pageview/, (r) => r.fulfill(json({})));
  await context.route(/\/data\/changelog\.json/, (r) => r.fulfill(json([])));
  await context.route(/\/api\//, (r) => r.fulfill(json({})));
}

// Installed once per page, before initConstellation. Records the actual draw
// calls so the flag row's geometry is asserted from what was painted, not from
// the same formula the painter used. Also counts requestAnimationFrame calls
// (the only way to prove the reduced-motion gate schedules nothing).
const BOOT = function (arg) {
  window.__raf = 0;
  var origRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) { window.__raf++; return origRaf(cb); };

  window.__draw = { flag: [], avatar: [], text: [], rings: [] };
  var proto = window.CanvasRenderingContext2D.prototype;
  var lastArc = null;
  if (!proto.__instrumented) {
    proto.__instrumented = true;
    var drawImage = proto.drawImage;
    proto.drawImage = function (img, dx, dy, dw, dh) {
      var rec = { x: dx, y: dy, w: dw, h: dh };
      // Flags are 13x10; avatars are square (r*2). dw/dh disambiguate.
      if (dw === 13 && dh === 10) window.__draw.flag.push(rec);
      else window.__draw.avatar.push(rec);
      return drawImage.apply(this, arguments);
    };
    var fillText = proto.fillText;
    proto.fillText = function (text, x, y) {
      window.__draw.text.push({ text: String(text), x: x, y: y, style: String(this.fillStyle) });
      return fillText.apply(this, arguments);
    };
    var arc = proto.arc;
    proto.arc = function (x, y, r) { lastArc = { x: x, y: y, r: r }; return arc.apply(this, arguments); };
    var stroke = proto.stroke;
    proto.stroke = function () {
      // Link gradients are CanvasGradient objects; node rings are hex strings.
      var st = typeof this.strokeStyle === 'string' ? this.strokeStyle : null;
      if (lastArc && st) window.__draw.rings.push({ x: lastArc.x, y: lastArc.y, r: lastArc.r, style: st, lw: this.lineWidth });
      return stroke.apply(this, arguments);
    };
  }

  document.getElementById('constellation-root').removeAttribute('hidden');
  document.getElementById('most-contributed').removeAttribute('hidden');
  window._countryMap = arg.countryMap;

  if (arg.freeze) {
    // Freeze the drift clock. t0 is captured inside initConstellation from the
    // same overridden clock, so t = (__fakeNow - base)/1000 exactly.
    window.__fakeNow = 1000000;
    Object.defineProperty(window.performance, 'now', {
      configurable: true, writable: true,
      value: function () { return window.__fakeNow; }
    });
  }
  window.initConstellation(arg.list);
};

async function boot(page, list, opts) {
  opts = opts || {};
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.initConstellation === 'function'; }, null, { timeout: 15000 });
  // The homepage's own Batch 2 always reveals #most-contributed; when there are
  // no contributors it hides #constellation-root. Wait for it to settle before
  // taking over, otherwise it re-hides the stage under us.
  await page.waitForFunction(function () { return !document.getElementById('contributed-empty').hidden; }, null, { timeout: 15000 });
  await page.evaluate(BOOT, { list: list, countryMap: COUNTRY_MAP, freeze: opts.freeze !== false });
  await page.evaluate(function () { document.getElementById('most-contributed').scrollIntoView({ block: 'center' }); });
  await page.waitForTimeout(opts.settle === undefined ? 700 : opts.settle);
}

// Runs in-page: clears the draw log, waits two real frames, returns a snapshot.
const COLLECT = async function () {
  window.__draw.flag.length = 0;
  window.__draw.avatar.length = 0;
  window.__draw.text.length = 0;
  window.__draw.rings.length = 0;
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  return {
    flag: window.__draw.flag.slice(),
    avatar: window.__draw.avatar.slice(),
    text: window.__draw.text.slice(),
    rings: window.__draw.rings.slice()
  };
};

// Runs in-page: sweeps the fake clock over one full 20s drift period and returns
// the minimum edge gap and the pair that owns it. Guards first: a stuck rAF loop
// would make every sample identical, and reporting a gap from that would be a
// confident lie (spec §7 trap 2).
const SAMPLE_CYCLE = async function (arg) {
  var periodMs = arg.periodMs;
  var steps = arg.steps;
  // The submission count is the one label element the probe carries no width for,
  // so it is measured here with the same stack the module draws it with.
  // --font-body holds the identical string FONT_STACK does, so nothing is
  // re-typed from CONFIG.
  var measureStack = getComputedStyle(document.documentElement).getPropertyValue('--font-body');
  var mctx = document.createElement('canvas').getContext('2d');
  function positions() {
    return window.__constellation.nodes().map(function (n, i) {
      // textGap is not exposed directly, but flagRowTop = cy + r + textGap, so
      // it is recoverable from the probe rather than re-typed from CONFIG.
      mctx.font = '400 ' + n.countSize + 'px ' + measureStack;
      return { i: i, cx: n.cx, cy: n.cy, r: n.r, xc: n.xClamped, yc: n.yClamped,
               nameW: n.nameW, nameSize: n.nameSize, nameMax: n.nameMax,
               textGap: n.flagRowTop - n.cy - n.r,
               countTop: n.countTop, countSize: n.countSize,
               countW: mctx.measureText(String(n.count)).width,
               flagRowTop: n.flagRowTop, flagH: n.flagH, flagTotalW: n.flagTotalW };
    });
  }
  // Canvas containment swept over the whole cycle. The ampY bug shipped because
  // containment was only ever checked at one frozen phase: index 19 sat at a
  // static y that was inside the canvas, and only a downward drift phase pushed
  // its count text past the bottom. A single sample cannot see a different
  // phase's overflow, so every extreme here is accumulated across all phases and
  // the phase that owns it is reported.
  var contain = {
    width: null, height: null,
    bottomOvershoot: -Infinity, bottomNode: -1, bottomPhase: -1, bottomPhase0: -Infinity,
    topOvershoot: -Infinity, topNode: -1, topPhase: -1, topPhase0: -Infinity,
    flagLeft: Infinity, flagLeftPhase: -1, flagLeftPhase0: Infinity,
    flagRight: -Infinity, flagRightPhase: -1, flagRightPhase0: -Infinity,
    countClear: Infinity, countClearPhase: -1, countClearPhase0: Infinity
  };
  function accumulateContainment(ns, phaseIdx) {
    if (!ns.length) return;
    for (var a = 0; a < ns.length; a++) {
      var p = ns[a];
      // Signed overshoot: positive means the box is past the edge (clipped).
      var bottom = (p.countTop + p.countSize) - contain.height;
      if (bottom > contain.bottomOvershoot) {
        contain.bottomOvershoot = bottom; contain.bottomNode = p.i; contain.bottomPhase = phaseIdx;
      }
      var top = -(p.cy - p.r - p.textGap - p.nameSize);
      if (top > contain.topOvershoot) {
        contain.topOvershoot = top; contain.topNode = p.i; contain.topPhase = phaseIdx;
      }
      var left = p.cx - p.flagTotalW / 2;
      var right = p.cx + p.flagTotalW / 2;
      if (left < contain.flagLeft) { contain.flagLeft = left; contain.flagLeftPhase = phaseIdx; }
      if (right > contain.flagRight) { contain.flagRight = right; contain.flagRightPhase = phaseIdx; }
      var clear = p.countTop - (p.flagRowTop + p.flagH);
      if (clear < contain.countClear) { contain.countClear = clear; contain.countClearPhase = phaseIdx; }
      if (phaseIdx === 0) {
        if (bottom > contain.bottomPhase0) contain.bottomPhase0 = bottom;
        if (top > contain.topPhase0) contain.topPhase0 = top;
        if (left < contain.flagLeftPhase0) contain.flagLeftPhase0 = left;
        if (right > contain.flagRightPhase0) contain.flagRightPhase0 = right;
        if (clear < contain.countClearPhase0) contain.countClearPhase0 = clear;
      }
    }
  }
  // Worst-case name boxes: every box is widened to its full allowance (nameMax)
  // rather than the width its own username happened to render at. No string
  // truncate() can produce exceeds nameMax, so if these never collide, no real
  // username can either. Vertical extent does not depend on the width.
  var worst = { overlapCount: 0, overlapExample: null,
                minClearance: Infinity, minPair: null, minPhase: -1,
                maxRenderedNameW: 0, nameMaxSeen: 0, textGap: null,
                // Second family — a name box against another node's BODY. See the
                // pass at the end of accumulateWorstCase.
                bodyOverlapCount: 0, bodyOverlapExample: null,
                bodyOverlapMaxPhase: 0, bodyOverlapMaxPhaseIdx: -1,
                bodyMinClearance: Infinity, bodyMinPair: null,
                bodyMinKind: null, bodyMinPhase: -1 };
  function accumulateWorstCase(ns, phaseIdx) {
    if (!ns.length) return;
    var textGap = ns[0].textGap;
    worst.textGap = textGap;
    var boxes = ns.map(function (p) {
      var w = p.nameMax;   // the allowance, not p.nameW
      if (p.nameW > worst.maxRenderedNameW) worst.maxRenderedNameW = p.nameW;
      if (p.nameMax > worst.nameMaxSeen) worst.nameMaxSeen = p.nameMax;
      return { i: p.i,
               left: p.cx - w / 2, right: p.cx + w / 2,
               top: p.cy - p.r - textGap - p.nameSize,
               bottom: p.cy - p.r - textGap };
    });
    for (var a = 0; a < boxes.length; a++) {
      for (var b = a + 1; b < boxes.length; b++) {
        var A = boxes[a], B = boxes[b];
        // Both axes must overlap for the boxes to collide. Skip pairs whose
        // horizontal projections are disjoint — they cannot collide.
        if (!(A.left < B.right && B.left < A.right)) continue;
        var clearance = Math.max(A.top, B.top) - Math.min(A.bottom, B.bottom);
        if (clearance < worst.minClearance) {
          worst.minClearance = clearance;
          worst.minPair = [A.i, B.i];
          worst.minPhase = phaseIdx;
        }
        if (clearance < 0) {
          worst.overlapCount++;
          if (!worst.overlapExample) {
            worst.overlapExample = { pair: [A.i, B.i], phase: phaseIdx, clearance: clearance };
          }
        }
      }
    }

    // --- Second family: a node's NAME box against another node's BODY ---
    // The pass above compares name boxes with name boxes only. What a visitor
    // actually sees is a lower node's name landing on an upper node's avatar,
    // flag row or submission count — and nothing measured that, which is why the
    // suite stayed fully green while the strip was visibly colliding. Body =
    // disc ∪ flag row ∪ count text.
    //
    // These boxes use the RENDERED name width, not the nameMax allowance the pass
    // above uses. That is deliberate, and it is the opposite of A30's choice:
    // relaxNodes() separates nodes using the boxes they actually draw, so
    // asserting on the allowance would demand a guarantee the layout never aims
    // at. The count joins the body because for a 1-flag node with a 2-digit count
    // it is wider than the 13px flag row.
    var kinds = ['disc', 'flag', 'count'];
    var bodies = ns.map(function (p) {
      return { i: p.i,
               disc:  { left: p.cx - p.r, right: p.cx + p.r,
                        top: p.cy - p.r, bottom: p.cy + p.r },
               flag:  { left: p.cx - p.flagTotalW / 2, right: p.cx + p.flagTotalW / 2,
                        top: p.flagRowTop, bottom: p.flagRowTop + p.flagH },
               count: { left: p.cx - p.countW / 2, right: p.cx + p.countW / 2,
                        top: p.countTop, bottom: p.countTop + p.countSize } };
    });
    var phaseCollisions = 0;
    for (var na = 0; na < ns.length; na++) {
      var N = { i: ns[na].i,
                left: ns[na].cx - ns[na].nameW / 2, right: ns[na].cx + ns[na].nameW / 2,
                top: ns[na].cy - ns[na].r - textGap - ns[na].nameSize,
                bottom: ns[na].cy - ns[na].r - textGap };
      for (var nb = 0; nb < bodies.length; nb++) {
        if (bodies[nb].i === N.i) continue;
        for (var kk = 0; kk < kinds.length; kk++) {
          var Bd = bodies[nb][kinds[kk]];
          if (!(N.left < Bd.right && Bd.left < N.right)) continue;
          var c2 = Math.max(N.top, Bd.top) - Math.min(N.bottom, Bd.bottom);
          if (c2 < worst.bodyMinClearance) {
            worst.bodyMinClearance = c2;
            worst.bodyMinPair = [N.i, bodies[nb].i];
            worst.bodyMinKind = kinds[kk];
            worst.bodyMinPhase = phaseIdx;
          }
          if (c2 < 0) {
            worst.bodyOverlapCount++;
            phaseCollisions++;
            if (!worst.bodyOverlapExample) {
              worst.bodyOverlapExample = { pair: [N.i, bodies[nb].i], kind: kinds[kk],
                                           phase: phaseIdx, clearance: c2 };
            }
          }
        }
      }
    }
    // The running total grows with the step count, so it says nothing about what
    // a visitor sees at one instant. The per-phase maximum is the interpretable
    // number and the one asserted on; the total is kept only for the report.
    if (phaseCollisions > worst.bodyOverlapMaxPhase) {
      worst.bodyOverlapMaxPhase = phaseCollisions;
      worst.bodyOverlapMaxPhaseIdx = phaseIdx;
    }
  }
  function gapPair(ns) {
    var best = { gap: Infinity, pair: null };
    for (var i = 0; i < ns.length; i++) {
      for (var j = i + 1; j < ns.length; j++) {
        var dx = ns[j].cx - ns[i].cx, dy = ns[j].cy - ns[i].cy;
        var g = Math.sqrt(dx * dx + dy * dy) - (ns[i].r + ns[j].r);
        if (g < best.gap) best = { gap: g, pair: [i, j] };
      }
    }
    return best;
  }
  var base = window.__fakeNow;
  var f1 = window.__constellation.status().frames;
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  var f2 = window.__constellation.status().frames;

  window.__fakeNow = base;
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  var a = JSON.stringify(positions().map(function (p) { return [p.cx, p.cy]; }));
  window.__fakeNow = base + periodMs / 4;
  await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
  var b = JSON.stringify(positions().map(function (p) { return [p.cx, p.cy]; }));
  var moves = a !== b;
  var framesAdvance = f2 > f1;
  if (!framesAdvance || !moves) {
    return { loopStuck: true, framesAdvance: framesAdvance, moves: moves, frames: f2 };
  }

  var st = window.__constellation.status();
  contain.width = st.width;
  contain.height = st.height;

  var min = { gap: Infinity, pair: null, at: -1 };
  var staticGap = null;
  for (var k = 0; k < steps; k++) {
    window.__fakeNow = base + k * (periodMs / (steps - 1));
    await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
    var ns = positions();
    var g = gapPair(ns);
    if (k === 0) staticGap = g;
    if (g.gap < min.gap) min = { gap: g.gap, pair: g.pair, at: k };
    accumulateWorstCase(ns, k);
    accumulateContainment(ns, k);
  }
  var last = positions();
  return {
    loopStuck: false,
    framesAdvance: framesAdvance,
    moves: moves,
    minGap: min.gap,
    minPair: min.pair,
    staticGap: staticGap.gap,
    clamped: last.filter(function (p) { return p.xc || p.yc; }).map(function (p) { return p.i; }),
    nameWorst: worst,
    contain: contain
  };
};

(async () => {
  const browser = await firefox.launch({ headless: true });

  // ======================================================================
  // Phase A — desktop 1280x900, frozen clock, mixed fixture
  // ======================================================================
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installRoutes(context);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', function (e) { pageErrors.push(String((e && e.message) || e)); });
    await boot(page, mixedContributors());

    const st = await page.evaluate(function () { return window.__constellation.status(); });
    const nodes = await page.evaluate(function () { return window.__constellation.nodes(); });

    // --- 1. stage / section geometry (prd AC1)
    const layout = await page.evaluate(function () {
      const stage = document.getElementById('constellation-stage').getBoundingClientRect();
      const sec = document.getElementById('most-contributed');
      const secRect = sec.getBoundingClientRect();
      return {
        stageW: stage.width, stageH: stage.height,
        secW: secRect.width, maxW: getComputedStyle(sec).maxWidth
      };
    });
    check('A1 stage is 640px tall', layout.stageH === 640, 'height=' + layout.stageH);
    check('A2 section is max-width 900px', layout.maxW === '900px' && Math.abs(layout.secW - 900) < 2,
      'maxWidth=' + layout.maxW + ' width=' + layout.secW);

    // --- 2. one shared name width, rendered identical everywhere (prd R2 / AC4)
    const maxR = Math.max.apply(null, nodes.map(function (n) { return n.r; }));
    const expectedNameMax = Math.min(maxR * 4.5, 240);
    const nameMaxes = Array.from(new Set(nodes.map(function (n) { return n.nameMax; })));
    const nameTexts = Array.from(new Set(nodes.map(function (n) { return n.nameText; })));
    check('A3 every node shares one nameMax', nameMaxes.length === 1, JSON.stringify(nameMaxes));
    check('A4 nameMax = min(maxR*4.5, 240)', Math.abs(nameMaxes[0] - expectedNameMax) < 0.01,
      'nameMax=' + nameMaxes[0] + ' expected=' + expectedNameMax);
    // Non-vacuity: the shared username is long enough to be truncated, and the
    // truncation is identical on every node — a per-node budget would differ
    // between the biggest and smallest disc.
    check('A5 the long username is actually truncated (not vacuous)',
      nameTexts.length === 1 && /…$/.test(nameTexts[0]), JSON.stringify(nameTexts));
    check('A6 every rendered name box fits its shared budget',
      nodes.every(function (n) { return n.nameW <= n.nameMax + 0.01; }),
      'maxW=' + Math.max.apply(null, nodes.map(function (n) { return n.nameW; })));

    // --- 3. count font size (prd R3)
    const countSizes = Array.from(new Set(nodes.map(function (n) { return n.countSize; })));
    check('A7 countSize is 12 on every node', countSizes.length === 1 && countSizes[0] === 12,
      JSON.stringify(countSizes));

    // --- 4/5/6. flag cap tiers, distinct-country clamp, dropped ids
    const byIndex = {};
    nodes.forEach(function (n, i) { byIndex[i] = n; });
    check('A8 count 2 → 1 flag', byIndex[0].flagCount === 1, 'got ' + byIndex[0].flagCount);
    check('A9 count 5 → 2 flags', byIndex[1].flagCount === 2, 'got ' + byIndex[1].flagCount);
    check('A10 count 20 → 3 flags', byIndex[2].flagCount === 3, 'got ' + byIndex[2].flagCount);
    check('A11 count 50 with 1 distinct country → 1 flag', byIndex[3].flagCount === 1, 'got ' + byIndex[3].flagCount);
    check('A12 count 50 with 2 distinct countries → 2 flags', byIndex[4].flagCount === 2, 'got ' + byIndex[4].flagCount);
    check('A13 country id missing from _countryMap is dropped, not fatal',
      JSON.stringify(byIndex[5].flagIds) === JSON.stringify(['canada', 'paraguay']),
      JSON.stringify(byIndex[5].flagIds));
    check('A14 country with an empty flag code is dropped',
      JSON.stringify(byIndex[6].flagIds) === JSON.stringify(['canada', 'paraguay']),
      JSON.stringify(byIndex[6].flagIds));
    check('A15 a valid country survives the drop of its neighbour',
      byIndex[2].flagIds.length === 3, JSON.stringify(byIndex[2].flagIds));

    // --- 7/8. flag row geometry from the actual draw calls (prd AC7 / AC8)
    // Derive the slot metrics from the probe instead of re-typing CONFIG.
    const oneFlagW = nodes.filter(function (n) { return n.flagCount === 1; })[0].flagTotalW;
    const threeFlagW = nodes.filter(function (n) { return n.flagCount === 3; })[0].flagTotalW;
    const flagGap = (threeFlagW - 3 * oneFlagW) / 2;
    const draw = await page.evaluate(COLLECT);
    const flagH = draw.flag.length ? draw.flag[0].h : 0;
    check('A16 flag slot width derived from the probe is sane',
      oneFlagW === 13 && flagGap === 2 && flagH === 10,
      'w=' + oneFlagW + ' gap=' + flagGap + ' h=' + flagH);

    // Match each painted flag to a node slot by its expected x.
    const slotOf = function (node, k) {
      return node.cx - node.flagTotalW / 2 + k * (oneFlagW + flagGap);
    };
    const near = function (a, b, tol) { return Math.abs(a - b) <= (tol === undefined ? 0.6 : tol); };

    const drawnFlags = draw.flag.map(function (f) { return { x: f.x, y: f.y, w: f.w, h: f.h }; });
    // Bind each painted flag to the one node/slot whose expected position it
    // matches. Both axes are needed: two nodes can share an x while sitting at
    // opposite ends of the canvas, and matching by x alone mixes them up.
    const slotHit = function (n, i, k, f) {
      return near(f.x, slotOf(n, k), 0.75) && near(f.y, n.flagRowTop, 1.5);
    };
    const painted = {};   // "nodeIndex:slot" -> true
    drawnFlags.forEach(function (f) {
      nodes.forEach(function (n, i) {
        for (var k = 0; k < n.flagCount; k++) {
          if (slotHit(n, i, k, f)) painted[i + ':' + k] = true;
        }
      });
    });
    const insideCanvas = drawnFlags.every(function (f) { return f.x >= -0.01 && f.x + f.w <= st.width + 0.01; });
    const countTexts = nodes.map(function (n) {
      return draw.text.filter(function (t) { return t.text === String(n.count) && near(t.x, n.cx, 0.75); })[0] || null;
    });
    const bottomFor = function (i) {
      var n = nodes[i];
      var ys = drawnFlags.filter(function (f) { return [0, 1, 2].some(function (k) { return k < n.flagCount && slotHit(n, i, k, f); }); });
      return ys.length ? Math.max.apply(null, ys.map(function (f) { return f.y + f.h; })) : null;
    };
    const allSettled = nodes.every(function (n) {
      return n.flagState.every(function (s) { return s === 'ready' || s === 'failed'; });
    });
    // The decisive AC8 check: a slot is painted exactly when its image loaded, so
    // an unloaded one leaves a hole in place instead of closing the row up.
    const paintedIffReady = nodes.every(function (n, i) {
      for (var k = 0; k < n.flagCount; k++) {
        if (!!painted[i + ':' + k] !== (n.flagState[k] === 'ready')) return false;
      }
      return true;
    });
    const noOverlap = nodes.every(function (n, i) {
      var bottom = bottomFor(i);
      return bottom === null || (countTexts[i] !== null && countTexts[i].y >= bottom - 0.01);
    });
    check('A17 every flag finished loading (no slot still pending)', allSettled);
    // Non-vacuity: if the 13x10 classifier stops recognising flags, drawnFlags
    // empties and `every(...)` would pass while testing nothing.
    check('A18 the flag row never leaves the canvas horizontally',
      drawnFlags.length > 0 && insideCanvas,
      'drawn=' + drawnFlags.length + ' ' + JSON.stringify(drawnFlags.filter(function (f) { return f.x < 0 || f.x + f.w > st.width; })));
    check('A19 the count baseline is clear of the flag row', noOverlap,
      JSON.stringify(nodes.map(function (n, i) {
        return { i: i, countTop: countTexts[i] && countTexts[i].y, flagBottom: bottomFor(i) };
      }).filter(function (o) { return o.countTop === null || o.flagBottom === null || o.countTop < o.flagBottom - 0.01; })));
    check('A20 a slot is painted exactly when its image loaded', paintedIffReady);

    // A8 specifically: node 8 decided 3 flags, the middle one fails to load.
    // The row keeps the full 3-slot width (43px) and k=1 is simply not painted —
    // slot width follows the decided list, not the loaded images.
    const n8 = byIndex[8];
    const n8painted = [0, 1, 2].map(function (k) { return !!painted['8:' + k]; });
    check('A21 count 50 + 3 decided flags keeps the full 3-slot width',
      n8.flagTotalW === 3 * oneFlagW + 2 * flagGap && n8.flagTotalW === 43, 'totalW=' + n8.flagTotalW);
    check('A22 the failed flag is not painted, the other two are',
      n8.flagState[1] === 'failed' && n8painted[0] && !n8painted[1] && n8painted[2],
      'state=' + JSON.stringify(n8.flagState) + ' painted=' + JSON.stringify(n8painted));
    check('A23 a fully loaded node paints all three slots',
      byIndex[2].flagState.every(function (s) { return s === 'ready'; }) &&
      [0, 1, 2].every(function (k) { return !!painted['2:' + k]; }), JSON.stringify(byIndex[2].flagState));

    // --- 9. screen-reader mirror carries the countries (prd AC9)
    const mirror = await page.evaluate(function () {
      return document.getElementById('contributed-list').textContent;
    });
    check('A24 sr-only mirror names the countries', /Canada, Hawaii, Paraguay/.test(mirror),
      mirror.slice(0, 80));
    check('A25 sr-only mirror has one entry per rendered contributor',
      (mirror.match(/submissions/g) || []).length === nodes.length,
      'entries=' + (mirror.match(/submissions/g) || []).length + ' nodes=' + nodes.length);

    // --- 11a. avatar failure degrades to the initial-letter disc
    const avatars = await page.evaluate(COLLECT);
    const n0 = byIndex[0], n1 = byIndex[1];
    const n0AvatarPaint = avatars.avatar.filter(function (a) {
      return near(a.x, n0.cx - n0.r, 0.75) && near(a.y, n0.cy - n0.r, 0.75) && near(a.w, n0.r * 2, 0.75);
    });
    const n1Letter = avatars.text.filter(function (t) {
      return t.text === 'A' && near(t.x, n1.cx, 0.75) && near(t.y, n1.cy + 1, 1.5);
    });
    check('A26 a loaded avatar paints the disc image',
      n0.imgState === 'ready' && n0AvatarPaint.length > 0, 'state=' + n0.imgState);
    check('A27 a failed avatar degrades to the initial-letter disc',
      n1.imgState === 'failed' && n1Letter.length > 0, 'state=' + n1.imgState + ' letters=' + n1Letter.length);

    // --- 11b. hover highlights exactly one node
    // The probe exposes no `hovered` flag, so the ring strokes are read instead:
    // the hovered ring switches to the accent colour and 2px, every other ring
    // stays at the idle colour and 1px.
    const before = await page.evaluate(COLLECT);
    await page.evaluate(function (arg) {
      const canvas = document.getElementById('constellation-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + arg.cx, clientY: rect.top + arg.cy, bubbles: true
      }));
    }, { cx: n0.cx, cy: n0.cy });
    await page.waitForTimeout(120);
    const after = await page.evaluate(COLLECT);
    const ringStyle = function (snap) {
      return Array.from(new Set(snap.rings.map(function (r) { return r.style + '|' + r.lw; })));
    };
    const idleStyles = ringStyle(before);
    const hotStyles = ringStyle(after);
    const idleColor = idleStyles.length === 1 ? idleStyles[0].split('|')[0] : null;
    const hotRing = idleColor === null ? [] : after.rings.filter(function (r) { return r.style !== idleColor; });
    check('A28 idle: every ring uses the same style/width', idleStyles.length === 1, JSON.stringify(idleStyles));
    check('A29 hover: exactly one ring switches to the accent style',
      hotStyles.length === 2 && hotRing.length > 0 &&
      hotRing.every(function (r) { return near(r.x, n0.cx, 1.5) && near(r.y, n0.cy, 1.5); }),
      'styles=' + JSON.stringify(hotStyles) + ' n=' + hotRing.length);

    // --- 12. worst-case name-box overlap (mixed fixture)
    // R2 widened every name box to a shared allowance. The sweep that first
    // measured "0 overlaps" used a fixture whose widest box was 82.0px, i.e. it
    // never exercised the allowance itself. This builds every box at nameMax and
    // checks all pairs over the full drift period — the true upper bound, since
    // no truncate() output can exceed nameMax.
    const mixedCycle = await page.evaluate(SAMPLE_CYCLE, { periodMs: 20000, steps: 41 });
    const mixedWorst = mixedCycle.nameWorst;
    const expectedMixedNameMax = Math.min(maxR * 4.5, 240);
    check('A30 no pair of worst-case name boxes overlaps (mixed fixture)',
      mixedWorst.overlapCount === 0,
      'overlaps=' + mixedWorst.overlapCount +
      (mixedWorst.overlapExample ? ' first=' + JSON.stringify(mixedWorst.overlapExample) : '') +
      '; tightest pair=' + JSON.stringify(mixedWorst.minPair) + ' at phase ' + mixedWorst.minPhase +
      ' with vertical clearance ' + num2(mixedWorst.minClearance) + 'px;' +
      ' widest rendered name box=' + num2(mixedWorst.maxRenderedNameW) + 'px, nameMax(the ceiling)=' + num2(mixedWorst.nameMaxSeen) + 'px');
    check('A31 the worst-case width really is the ceiling (non-vacuous, mixed)',
      Math.abs(mixedWorst.nameMaxSeen - expectedMixedNameMax) < 0.01,
      'nameMaxSeen=' + num2(mixedWorst.nameMaxSeen) + ' expected=' + num2(expectedMixedNameMax));
    check('A31b name boxes clear every other node\'s body, within budget (mixed)',
      mixedWorst.bodyOverlapMaxPhase <= BODY_OVERLAP_BUDGET,
      'worst-phase collisions=' + mixedWorst.bodyOverlapMaxPhase +
      ' at phase ' + mixedWorst.bodyOverlapMaxPhaseIdx +
      ' budget=' + BODY_OVERLAP_BUDGET +
      ' (total over all phases=' + mixedWorst.bodyOverlapCount + ')' +
      (mixedWorst.bodyOverlapExample ? ' first=' + JSON.stringify(mixedWorst.bodyOverlapExample) : '') +
      '; tightest=' + JSON.stringify(mixedWorst.bodyMinPair) + ' vs ' + mixedWorst.bodyMinKind +
      ' at phase ' + mixedWorst.bodyMinPhase +
      ' clearance ' + num2(mixedWorst.bodyMinClearance) + 'px');

    // --- 13. canvas containment over the full cycle (mixed fixture)
    const mC = mixedCycle.contain;
    check('A32 count text stays inside the canvas bottom at every phase (mixed)',
      mC.bottomOvershoot <= 0.01,   // sub-pixel tolerance: the clamp makes this exactly 0
      'worst count-bottom overshoot=' + num2(mC.bottomOvershoot) + 'px at node ' + mC.bottomNode +
      ' phase ' + mC.bottomPhase + ' (phase 0 was ' + num2(mC.bottomPhase0) + 'px)');
    check('A33 name box stays inside the canvas top at every phase (mixed)',
      mC.topOvershoot <= 0.01,
      'worst name-top overshoot=' + num2(mC.topOvershoot) + 'px at node ' + mC.topNode +
      ' phase ' + mC.topPhase + ' (phase 0 was ' + num2(mC.topPhase0) + 'px)');
    check('A34 flag row stays inside the canvas horizontally at every phase (mixed)',
      mC.flagLeft >= -0.01 && mC.flagRight <= mC.width + 0.01,
      'leftmost=' + num2(mC.flagLeft) + 'px (phase ' + mC.flagLeftPhase + '), rightmost=' + num2(mC.flagRight) +
      'px (phase ' + mC.flagRightPhase + '), width=' + mC.width +
      '; phase 0 was [' + num2(mC.flagLeftPhase0) + ', ' + num2(mC.flagRightPhase0) + ']');
    check('A35 count baseline clears the flag row at every phase (mixed)',
      mC.countClear >= -0.01,
      'min clearance=' + num2(mC.countClear) + 'px at phase ' + mC.countClearPhase +
      ' (phase 0 was ' + num2(mC.countClearPhase0) + 'px)');
    // Spec §8 claims the mixed fixture clamps 0 nodes. Measure and pin it.
    check('A36 mixed fixture clamps ' + MIXED_CLAMP_EXPECT + ' node(s)',
      mixedCycle.clamped.length === MIXED_CLAMP_EXPECT, 'clamped=' + JSON.stringify(mixedCycle.clamped));

    check('A37 no uncaught page errors on the desktop page', pageErrors.length === 0, pageErrors.join(' | '));

    await context.close();
  }

  // ======================================================================
  // Phase B — desktop, pure "every node at radiusCeil" fixture (prd AC2b)
  // ======================================================================
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await installRoutes(context);
    const page = await context.newPage();
    await boot(page, contributors());
    const cycle = await page.evaluate(SAMPLE_CYCLE, { periodMs: 20000, steps: 41 });

    if (cycle.loopStuck) {
      // No gap number may be reported from a loop that never ran.
      check('B0 rAF loop is running before sampling', false,
        JSON.stringify({ framesAdvance: cycle.framesAdvance, moves: cycle.moves }));
    } else {
      check('B0 rAF loop is running before sampling (frames advance + clock moves nodes)',
        cycle.framesAdvance && cycle.moves);
      check('B1 at most one node is clamped', cycle.clamped.length <= 1, JSON.stringify(cycle.clamped));
      check('B2 the clamped node does not form the minimum-gap pair',
        cycle.clamped.every(function (i) { return cycle.minPair.indexOf(i) === -1; }),
        'clamped=' + JSON.stringify(cycle.clamped) + ' minPair=' + JSON.stringify(cycle.minPair));
      // prd AC2 records the shipped value: >= +10px on this synthetic fixture.
      check('B3 minimum edge gap over the full cycle is at least +10px',
        cycle.minGap >= 10, 'minGap=' + cycle.minGap.toFixed(3) + 'px at sample ' + cycle.minPair.join('/'));
      // Non-vacuity for the whole sampling method: drift only closes gaps, so the
      // static reading must be an upper bound AND must measurably exceed the
      // cycle minimum. If the samples were secretly static anchors, `static ===
      // min` and this fails — which is exactly the trap the spec warns about.
      check('B4 drift measurably closes the gap (samples are not static anchors)',
        cycle.staticGap >= cycle.minGap - 0.01 && (cycle.staticGap - cycle.minGap) >= 1,
        'static=' + cycle.staticGap.toFixed(3) + ' min=' + cycle.minGap.toFixed(3));
    }

    // --- worst-case name-box overlap (ceiling fixture)
    const bNodes = await page.evaluate(function () { return window.__constellation.nodes(); });
    const bMaxR = Math.max.apply(null, bNodes.map(function (n) { return n.r; }));
    const bWorst = cycle.nameWorst;
    const bDetail = bWorst
      ? 'overlaps=' + bWorst.overlapCount +
        (bWorst.overlapExample ? ' first=' + JSON.stringify(bWorst.overlapExample) : '') +
        '; tightest pair=' + JSON.stringify(bWorst.minPair) + ' at phase ' + bWorst.minPhase +
        ' with vertical clearance ' + num2(bWorst.minClearance) + 'px;' +
        ' widest rendered name box=' + num2(bWorst.maxRenderedNameW) + 'px, nameMax(the ceiling)=' + num2(bWorst.nameMaxSeen) + 'px'
      : 'loop never ran — no samples';
    check('B5 no pair of worst-case name boxes overlaps (ceiling fixture)',
      !!bWorst && bWorst.overlapCount === 0, bDetail);
    check('B5b name boxes clear every other node\'s body, within budget (ceiling)',
      !!bWorst && bWorst.bodyOverlapMaxPhase <= BODY_OVERLAP_BUDGET,
      bWorst ? ('worst-phase collisions=' + bWorst.bodyOverlapMaxPhase +
        ' at phase ' + bWorst.bodyOverlapMaxPhaseIdx +
        ' budget=' + BODY_OVERLAP_BUDGET +
        ' (total over all phases=' + bWorst.bodyOverlapCount + ')' +
        (bWorst.bodyOverlapExample ? ' first=' + JSON.stringify(bWorst.bodyOverlapExample) : '') +
        '; tightest=' + JSON.stringify(bWorst.bodyMinPair) + ' vs ' + bWorst.bodyMinKind +
        ' clearance ' + num2(bWorst.bodyMinClearance) + 'px') : 'no sample');
    check('B6 the worst-case width really is the ceiling (non-vacuous, ceiling fixture)',
      !!bWorst && Math.abs(bWorst.nameMaxSeen - Math.min(bMaxR * 4.5, 240)) < 0.01,
      'nameMaxSeen=' + num2(bWorst && bWorst.nameMaxSeen) + ' expected=' + num2(Math.min(bMaxR * 4.5, 240)));

    // --- canvas containment over the full cycle (ceiling fixture)
    const bC = cycle.contain;
    check('B7 count text stays inside the canvas bottom at every phase (ceiling)',
      !!bC && bC.bottomOvershoot <= 0.01,   // sub-pixel tolerance
      bC ? 'worst count-bottom overshoot=' + num2(bC.bottomOvershoot) + 'px at node ' + bC.bottomNode +
           ' phase ' + bC.bottomPhase + ' (phase 0 was ' + num2(bC.bottomPhase0) + 'px)'
         : 'loop never ran — no samples');
    check('B8 name box stays inside the canvas top at every phase (ceiling)',
      !!bC && bC.topOvershoot <= 0.01,
      bC ? 'worst name-top overshoot=' + num2(bC.topOvershoot) + 'px at node ' + bC.topNode +
           ' phase ' + bC.topPhase + ' (phase 0 was ' + num2(bC.topPhase0) + 'px)'
         : 'loop never ran — no samples');
    check('B9 flag row stays inside the canvas horizontally at every phase (ceiling)',
      !!bC && bC.flagLeft >= -0.01 && bC.flagRight <= bC.width + 0.01,
      bC ? 'leftmost=' + num2(bC.flagLeft) + 'px (phase ' + bC.flagLeftPhase + '), rightmost=' + num2(bC.flagRight) +
           'px (phase ' + bC.flagRightPhase + '), width=' + bC.width +
           '; phase 0 was [' + num2(bC.flagLeftPhase0) + ', ' + num2(bC.flagRightPhase0) + ']'
         : 'loop never ran — no samples');
    check('B10 count baseline clears the flag row at every phase (ceiling)',
      !!bC && bC.countClear >= -0.01,
      bC ? 'min clearance=' + num2(bC.countClear) + 'px at phase ' + bC.countClearPhase +
           ' (phase 0 was ' + num2(bC.countClearPhase0) + 'px)'
         : 'loop never ran — no samples');
    await context.close();
  }

  // ======================================================================
  // Phase C — narrow 368px: n capped to 6, zero clamps, no overflow (prd AC2b)
  // ======================================================================
  {
    const context = await browser.newContext({ viewport: { width: 368, height: 700 } });
    await installRoutes(context);
    const page = await context.newPage();
    await boot(page, contributors());
    const st = await page.evaluate(function () { return window.__constellation.status(); });
    const cycle = await page.evaluate(SAMPLE_CYCLE, { periodMs: 20000, steps: 41 });
    const geometry = await page.evaluate(function () {
      const ns = window.__constellation.nodes();
      const st = window.__constellation.status();
      const stage = document.getElementById('constellation-stage').getBoundingClientRect();
      return {
        width: st.width,
        narrow: st.narrow,
        maxRight: Math.max.apply(null, ns.map(function (n) { return n.cx + n.flagTotalW / 2; })),
        minLeft: Math.min.apply(null, ns.map(function (n) { return n.cx - n.flagTotalW / 2; })),
        stageLeft: stage.left,
        stageRight: stage.right,
        docScrollW: document.documentElement.scrollWidth,
        innerW: window.innerWidth
      };
    });

    check('C1 narrow viewport caps the node count to 6', st.narrow === true && st.n === 6,
      'narrow=' + st.narrow + ' n=' + st.n);
    if (cycle.loopStuck) {
      check('C2 rAF loop is running before sampling', false, JSON.stringify(cycle));
    } else {
      check('C2 rAF loop is running before sampling', cycle.framesAdvance && cycle.moves);
      check('C3 narrow viewport has zero clamped nodes', cycle.clamped.length === 0,
        JSON.stringify(cycle.clamped));
    }
    check('C4 the flag row stays inside the narrow canvas',
      geometry.minLeft >= -0.01 && geometry.maxRight <= geometry.width + 0.01,
      'left=' + geometry.minLeft.toFixed(2) + ' right=' + geometry.maxRight.toFixed(2) + ' width=' + geometry.width);
    // body has overflow-x:hidden, so a scrollWidth comparison alone can never see
    // overflow (it is clipped, not scrollable). The stage's own right edge is the
    // real signal — assert both.
    check('C5 nothing overflows the viewport horizontally',
      geometry.stageRight <= geometry.innerW + 0.01 && geometry.docScrollW <= geometry.innerW + 1,
      'stageRight=' + geometry.stageRight + ' scrollW=' + geometry.docScrollW + ' innerW=' + geometry.innerW);
    await context.close();
  }

  // ======================================================================
  // Phase D — prefers-reduced-motion: static frame, zero scheduled rAF
  // ======================================================================
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    await installRoutes(context);
    const page = await context.newPage();
    await boot(page, contributors(), { freeze: false, settle: 400 });
    const first = await page.evaluate(function () { return window.__constellation.status(); });
    const posA = await page.evaluate(function () {
      const n = window.__constellation.nodes()[0];
      return { cx: n.cx, cy: n.cy, all: window.__constellation.nodes().map(function (m) { return [m.cx, m.cy]; }) };
    });
    // Force a repaint by hovering a node: `wireHover` calls renderNow() in
    // reduced mode. Reduced motion must render that frame at t=0, so the
    // coordinates stay put; a broken gate (real time in reduced mode) would move
    // them here even though the loop is stopped.
    await page.evaluate(function (arg) {
      const canvas = document.getElementById('constellation-canvas');
      const rect = canvas.getBoundingClientRect();
      canvas.dispatchEvent(new MouseEvent('mousemove', {
        clientX: rect.left + arg.cx, clientY: rect.top + arg.cy, bubbles: true
      }));
    }, { cx: posA.cx, cy: posA.cy });
    await page.waitForTimeout(200);
    const second = await page.evaluate(function () {
      return { st: window.__constellation.status(), pos: window.__constellation.nodes().map(function (n) { return [n.cx, n.cy]; }) };
    });
    const raf = await page.evaluate(function () { return window.__raf; });

    check('D1 reduced motion is detected', first.reduced === true);
    check('D2 reduced motion leaves the loop stopped', first.running === false && second.st.running === false,
      'running=' + second.st.running);
    check('D3 reduced motion schedules no rAF callback at all', raf === 0, 'raf=' + raf);
    check('D4 a static frame is still drawn', first.frames >= 1, 'frames=' + first.frames);
    check('D5 the static frame never moves',
      JSON.stringify(posA.all) === JSON.stringify(second.pos), 'posA=' + JSON.stringify(posA.all.slice(0, 2)));
    await context.close();
  }

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (err) {
  console.error('HARNESS ERROR:', (err && err.stack) || err);
  process.exit(1);
});

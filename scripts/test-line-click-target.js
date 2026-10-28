// Guards the explore map's line hit-testing.
//
// THE BUG THIS LOCKS DOWN: a LineString is drawn as a thin stroke that is deliberately
// non-interactive (`layer.setStyle({ interactive: false })`), with a separate 28px-wide
// invisible polyline as the click target — the target carries both the `leaflet-interactive`
// class (hence the pointer cursor) and the click handler. But the target is added to the map
// BEFORE the visible line, so the visible line sits on top of it in the SVG.
//
// `switchCountry` then re-enabled pointer events on every visible path with
// `pathEl.style.pointerEvents = show ? 'auto' : 'none'`. For a polygon that is correct — the
// polygon's own path IS the click layer. For a line it is exactly backwards: the inline
// `pointer-events: auto` overrides Leaflet's `.leaflet-pane > svg path { pointer-events: none }`
// (the rule that makes a non-interactive path transparent), so the thin visible stroke started
// swallowing the pointer wherever it lay on top of the target. Result: hovering exactly ON the
// line showed the container's inherited `grab` cursor instead of `pointer`, and clicking did
// nothing — while hovering a few pixels to the side worked.
//
// The assertions below therefore come in pairs: the line must resolve to the click target, and
// a polygon must still resolve to its own path (the shared condition must not regress it).
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-line-click-target.js
//   kill $(lsof -ti :3999)
'use strict';

const { firefox } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3999';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ' — ' + detail));
}

// `region` (not `country`) is the field switchCountry matches on — see map.js:1333.
const REGIONS = [
  {
    id: 'line-arrow', name: 'Line With Arrow', tags: [], user_id: '', region: 'south-africa',
    geojson: { type: 'LineString', coordinates: [[26.0, -24.0], [31.0, -27.0]], arrow: true },
  },
  {
    id: 'line-plain', name: 'Line No Arrow', tags: [], user_id: '', region: 'south-africa',
    geojson: { type: 'LineString', coordinates: [[26.0, -29.0], [31.0, -32.0]] },
  },
  {
    id: 'poly', name: 'Polygon', tags: [], user_id: '', region: 'south-africa',
    geojson: { type: 'Polygon', coordinates: [[[23.0, -25.0], [25.0, -25.0], [25.0, -26.5], [23.0, -26.5], [23.0, -25.0]]] },
  },
];

const COUNTRIES = {
  countries: [{
    id: 'south-africa', name: 'South Africa', flag: 'za',
    bounds_sw: [-34.5, 17.0], bounds_ne: [-22.5, 32.5], active: 1, sort_order: 1, region_count: 3,
  }],
};

// Names every SVG path belonging to a region, so a probe can say which layer it landed on
// rather than guessing from the class list.
const PROBE = (id) => {
  const map = window._geoguideMap;
  const region = (window._hoverRegions || []).find((r) => r.id === id);
  if (!map || !region) return { error: 'no map/region' };

  const owner = new Map();
  const collectDecorator = (node) => {
    if (!node) return;
    if (node._path) owner.set(node._path, 'arrowDecorator');
    if (node.eachLayer) node.eachLayer(collectDecorator);
  };
  const group = window._polygonLayers.get(id);
  group.eachLayer((l) => {
    if (l._path) owner.set(l._path, l._isClickTarget ? 'clickTarget' : 'visibleLine');
    if (l._clickTarget && l._clickTarget._path) owner.set(l._clickTarget._path, 'clickTarget');
    if (l._arrowDecorator) collectDecorator(l._arrowDecorator);
  });

  const rect = document.getElementById('map').getBoundingClientRect();
  const at = (x, y) => {
    const el = document.elementFromPoint(rect.left + x, rect.top + y);
    if (!el) return { who: 'null', cursor: 'none', pe: '' };
    const cs = getComputedStyle(el);
    return {
      who: el.tagName.toLowerCase() === 'path' ? (owner.get(el) || 'UNMAPPED-PATH') : el.tagName.toLowerCase(),
      cursor: cs.cursor,
      pe: cs.pointerEvents,
    };
  };

  const geo = region.geojson;
  if (geo.type === 'Polygon') {
    // Centroid of the outer ring — comfortably inside the fill.
    const ring = geo.coordinates[0];
    let sx = 0, sy = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      const p = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
      sx += p.x; sy += p.y;
    }
    const n = ring.length - 1;
    return { kind: 'poly', probe: at(sx / n, sy / n), scan: [] };
  }

  const c = geo.coordinates;
  const a = map.latLngToContainerPoint([c[0][1], c[0][0]]);
  const b = map.latLngToContainerPoint([c[c.length - 1][1], c[c.length - 1][0]]);
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nrm = { x: -dy / len, y: dx / len };

  const scan = [];
  for (let t = -16; t <= 16; t += 2) {
    scan.push({ off: t, ...at(mid.x + nrm.x * t, mid.y + nrm.y * t) });
  }
  return { kind: 'line', len: Math.round(len), scan, probe: at(mid.x, mid.y) };
};

async function clickAndAsk(page, id) {
  const pt = await page.evaluate((rid) => {
    const map = window._geoguideMap;
    const region = (window._hoverRegions || []).find((r) => r.id === rid);
    const rect = document.getElementById('map').getBoundingClientRect();
    let x, y;
    if (region.geojson.type === 'Polygon') {
      const ring = region.geojson.coordinates[0];
      let sx = 0, sy = 0;
      for (let i = 0; i < ring.length - 1; i++) {
        const p = map.latLngToContainerPoint([ring[i][1], ring[i][0]]);
        sx += p.x; sy += p.y;
      }
      x = sx / (ring.length - 1); y = sy / (ring.length - 1);
    } else {
      const c = region.geojson.coordinates;
      const a = map.latLngToContainerPoint([c[0][1], c[0][0]]);
      const b = map.latLngToContainerPoint([c[c.length - 1][1], c[c.length - 1][0]]);
      x = (a.x + b.x) / 2; y = (a.y + b.y) / 2;
    }
    return { x: rect.left + x, y: rect.top + y };
  }, id);

  await page.mouse.click(pt.x, pt.y);
  // A click that does nothing is the very failure this file exists to catch, so a timeout
  // here is a FAIL to report — not an exception that aborts the remaining checks.
  let out = { open: false, title: '' };
  try {
    await page.waitForFunction(() => {
      const m = document.getElementById('modal');
      return !!m && !m.hidden;
    }, null, { timeout: 2500 });
    out = await page.evaluate(() => ({
      open: true,
      title: document.getElementById('modal-title').textContent || '',
    }));
  } catch (e) { /* leave out.open === false */ }

  await page.evaluate(() => { if (window.closeModal) window.closeModal(); });
  // closeModal() only drops `.is-open`; the `hidden` attribute lands after the 0.25-0.3s
  // fade, and the modal covers the viewport with pointer-events:auto until then. A fixed
  // sleep here made the NEXT probe sample the fading modal (a bare `div`, cursor:auto)
  // instead of the map — it failed roughly one run in three. Wait for the actual condition.
  await page.waitForFunction(() => document.getElementById('modal').hidden, null, { timeout: 5000 });
  // Park the pointer away from the map so no hover card is left covering the next probe.
  await page.mouse.move(5, 5);
  await page.waitForFunction(() => !document.querySelector('.region-hover-card'), null, { timeout: 5000 });
  return out;
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REGIONS) }));

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)));

  await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => window._geoguideMap && (window._hoverRegions || []).length >= 3, null, { timeout: 20000 });
  await page.waitForTimeout(1200); // let the setTimeout(0) arrow decorators land

  for (const [id, label] of [['line-arrow', 'with arrow'], ['line-plain', 'no arrow']]) {
    const p = await page.evaluate(PROBE, id);
    if (p.error) { check('probe ' + id, false, p.error); continue; }

    console.log('\n-- ' + id + ' (' + label + ', ' + p.len + 'px on screen) --');
    p.scan.forEach((r) => console.log('   off ' + String(r.off).padStart(4) + 'px  ' +
      r.who.padEnd(16) + ' cursor=' + String(r.cursor).padEnd(9) + ' pe=' + r.pe));

    check('L/' + id + ' exactly on the line resolves to the click target',
      p.probe.who === 'clickTarget', JSON.stringify(p.probe));
    check('L/' + id + ' exactly on the line shows the pointer cursor',
      p.probe.cursor === 'pointer', p.probe.cursor);
    // No gap inside the band. The target is `weight: max(28, lw+24)` px wide, i.e. ±14px of
    // half-width; ±12 is the largest offset that is unambiguously inside it on a diagonal
    // stroke at a fractional zoom (the outermost pixel or two rasterise either way).
    const inside = p.scan.filter((r) => Math.abs(r.off) <= 12);
    check('L/' + id + ' no gap inside the 28px band',
      inside.length >= 12 && inside.every((r) => r.who === 'clickTarget' && r.cursor === 'pointer'),
      'samples=' + inside.length + ' off=' +
        (inside.filter((r) => r.who !== 'clickTarget').map((r) => r.off).join(',') || 'none'));

    const clicked = await clickAndAsk(page, id);
    check('L/' + id + ' clicking exactly on the line opens the modal',
      clicked.open, JSON.stringify(clicked));
  }

  // The shared condition in switchCountry must not have broken polygons: their own path is the
  // click layer, so it still needs `pointer-events: auto`.
  const poly = await page.evaluate(PROBE, 'poly');
  console.log('\n-- poly (polygon interior) --');
  console.log('   ' + poly.probe.who + '  cursor=' + poly.probe.cursor + ' pe=' + poly.probe.pe);
  check('P1 polygon interior is interactive', poly.probe.who === 'visibleLine' && poly.probe.pe === 'auto',
    JSON.stringify(poly.probe));
  check('P2 polygon interior shows the pointer cursor', poly.probe.cursor === 'pointer', poly.probe.cursor);
  const polyClick = await clickAndAsk(page, 'poly');
  check('P3 clicking inside the polygon opens the modal', polyClick.open, JSON.stringify(polyClick));

  check('D1 no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures ? ('\n== FAILURES: ' + failures) : '\n== ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

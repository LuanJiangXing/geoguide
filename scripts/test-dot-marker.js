// Playwright harness for the tiny-submission dot-marker feature.
// Usage: node scripts/test-dot-marker.js <smoke|dot-visible|dot-hidden-on-switch|dot-hidden-on-search>
// Requires the dev server on http://localhost:3000 (check: curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/explore)
const { firefox } = require('playwright');
const MODE = process.argv[2] || 'smoke';

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto('http://localhost:3000/explore', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.L && window.renderRegions, null, { timeout: 15000 });

  // Common setup: init the map ourselves (app.js won't init without data),
  // stub openModal for assertions, and render one mock region sized by mode.
  await page.evaluate((mode) => {
    const map = L.map('map').setView([0, 0], 6);
    setTimeout(() => map.invalidateSize(), 100);
    window._geoguideMap = map;
    window.__modalOpened = false;
    window.__modalRegionId = null;
    window.openModal = function (r) { window.__modalOpened = true; window.__modalRegionId = r && r.id; };
    // smoke uses a large polygon so a click lands; every other mode uses a tiny
    // polygon whose on-screen bbox collapses below the dot threshold at low zoom.
    const half = mode === 'smoke' ? 2.5 : 0.0005;
    window.__mockRegion = {
      id: 'mock-1', region: 'mock-country', name: 'Mock', description: 'mock region',
      geojson: { type: 'Polygon', coordinates: [[[-half, -half], [half, -half], [half, half], [-half, half], [-half, -half]]] },
      _countryVisible: true, _searchVisible: true
    };
    renderRegions(map, [window.__mockRegion]);
  }, MODE);
  await page.waitForTimeout(400);

  let pass = true;

  if (MODE === 'smoke') {
    const center = await page.evaluate(() => {
      const p = window._geoguideMap.latLngToContainerPoint([0, 0]);
      // containerPoint is relative to the map div, but page.mouse uses
      // viewport coords — offset by the map div's page position.
      const rect = window._geoguideMap.getContainer().getBoundingClientRect();
      return { x: rect.left + p.x, y: rect.top + p.y };
    });
    await page.mouse.click(center.x, center.y);
    await page.waitForTimeout(300);
    pass = await page.evaluate(() => window.__modalOpened === true);
    console.log((pass ? 'PASS' : 'FAIL'), 'smoke: click opens modal =', pass);
  } else if (MODE === 'dot-visible') {
    const onMap = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && window._geoguideMap.hasLayer(gl._dot));
    });
    await page.evaluate(() => window._geoguideMap.setZoom(18));
    await page.waitForTimeout(400);
    const hiddenAtHighZoom = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && !window._geoguideMap.hasLayer(gl._dot));
    });
    pass = onMap && hiddenAtHighZoom;
    console.log((pass ? 'PASS' : 'FAIL'), 'dot-visible: onMap=' + onMap + ' hiddenAtHighZoom=' + hiddenAtHighZoom);
  } else if (MODE === 'dot-hidden-on-switch') {
    const before = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && window._geoguideMap.hasLayer(gl._dot));
    });
    // Stub fitBounds so no zoomend fires — otherwise the Task 2 zoom listener
    // hides the dot as a side effect, masking whether switchCountry's explicit
    // refreshRegionDot sync actually runs.
    await page.evaluate(() => { window._geoguideMap.fitBounds = function () {}; });
    await page.evaluate(() => switchCountry([window.__mockRegion], 'other-country'));
    const after = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && !window._geoguideMap.hasLayer(gl._dot));
    });
    pass = before && after;
    console.log((pass ? 'PASS' : 'FAIL'), 'dot-hidden-on-switch: before=' + before + ' after=' + after);
  } else if (MODE === 'dot-hidden-on-search') {
    const before = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && window._geoguideMap.hasLayer(gl._dot));
    });
    await page.evaluate(() => applyFilters([window.__mockRegion], 'zzzz-no-match'));
    const after = await page.evaluate(() => {
      const gl = window._polygonLayers.get('mock-1');
      return !!(gl && gl._dot && !window._geoguideMap.hasLayer(gl._dot));
    });
    pass = before && after;
    console.log((pass ? 'PASS' : 'FAIL'), 'dot-hidden-on-search: before=' + before + ' after=' + after);
  }

  await browser.close();
  process.exit(pass ? 0 : 1);
})();

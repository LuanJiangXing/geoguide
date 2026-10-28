// Tests automatic country resolution and prefill on submit.html.
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-auto-country.js
//   kill $(lsof -ti :3999)
'use strict';

const { chromium } = require('playwright');
const BASE = process.env.BASE_URL || 'http://localhost:3999';

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ' — ' + detail));
}

const ME = { user: { id: 'u1', username: 'tester', display_name: 'Tester', role: 'user', avatar_url: null } };
const COUNTRIES = {
  countries: [
    { id: 'canada', name: 'Canada', flag: 'ca', bounds_sw: [41.0, -141.0], bounds_ne: [72.0, -52.0], active: 1, sort_order: 0, region_count: 5 },
    { id: 'south-africa', name: 'South Africa', flag: 'za', bounds_sw: [-35.0, 16.0], bounds_ne: [-22.0, 33.0], active: 1, sort_order: 1, region_count: 10 },
    { id: 'united-states', name: 'United States', flag: 'us', bounds_sw: [24.0, -125.0], bounds_ne: [49.5, -66.0], active: 1, sort_order: 2, region_count: 8 },
    { id: 'hawaii', name: 'Hawaii', flag: 'us-hi', bounds_sw: [18.5, -160.5], bounds_ne: [22.5, -154.5], active: 1, sort_order: 3, region_count: 2 },
    { id: 'russia', name: 'Russia', flag: 'ru', bounds_sw: [35.0, 45.0], bounds_ne: [65.0, 135.0], active: 1, sort_order: 4, region_count: 20 },
    { id: 'kenya', name: 'Kenya', flag: 'ke', bounds_sw: [-4.7, 33.9], bounds_ne: [5.5, 41.9], active: 1, sort_order: 5, region_count: 3 },
  ],
};

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: process.env.http_proxy ? { server: process.env.http_proxy, bypass: 'localhost,127.0.0.1' } : undefined
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  // Route API endpoints
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/auth*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME) }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/tags*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ categories: [], tags: [] }) }));
  let proposalBody = null;
  await ctx.route('**/api/user-submissions*', (r) => {
    if (r.request().method() === 'POST') {
      try { proposalBody = JSON.parse(r.request().postData() || '{}'); } catch (e) {}
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    } else {
      r.fulfill({ status: 200, contentType: 'application/json', body: '{"submissions":[]}' });
    }
  });

  // Mock BigDataCloud reverse geocode API deterministically based on coordinates
  let abortBdc = false;
  await ctx.route('**/api.bigdatacloud.net/**', (r) => {
    if (abortBdc) {
      r.abort();
      return;
    }
    const url = new URL(r.request().url());
    const lat = parseFloat(url.searchParams.get('latitude'));
    const lng = parseFloat(url.searchParams.get('longitude'));

    if (lat >= 45 && lat <= 60 && lng >= -130 && lng <= -60) {
      // Canada
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'CA', countryName: 'Canada', principalSubdivision: 'Ontario' })
      });
    } else if (lat >= -35 && lat <= -20 && lng >= 15 && lng <= 35) {
      // South Africa
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'ZA', countryName: 'South Africa', principalSubdivision: 'Western Cape' })
      });
    } else if (lat >= 19 && lat <= 22 && lng >= -160 && lng <= -155) {
      // Hawaii
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'US', countryName: 'United States of America', principalSubdivision: 'Hawaii' })
      });
    } else if (lat >= 25 && lat <= 48 && lng >= -120 && lng <= -70) {
      // Contiguous US
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'US', countryName: 'United States of America', principalSubdivision: 'California' })
      });
    } else if (lat >= 42 && lat <= 51 && lng >= -5 && lng <= 8) {
      // France (not in GeoGuide)
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'FR', countryName: 'France', principalSubdivision: 'Île-de-France' })
      });
    } else if (lat >= 40 && lat <= 56 && lng >= 46 && lng <= 88) {
      // Kazakhstan (within Russia's bounding box [35, 45]-[65, 135], but unmapped in GeoGuide)
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: 'KZ', countryName: 'Kazakhstan', principalSubdivision: 'Almaty' })
      });
    } else {
      // Ocean / outside
      r.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ countryCode: '', countryName: '', principalSubdivision: '' })
      });
    }
  });

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message)));

  await page.goto(BASE + '/submit.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => document.getElementById('submit-form').style.display === 'block', null, { timeout: 20000 });
  await page.waitForFunction(() => window._countryMap && Object.keys(window._countryMap).length > 0, null, { timeout: 20000 });

  // Helper to get current country and prompt states
  const getState = () => page.evaluate(() => {
    const sel = document.getElementById('region-country');
    const toast = document.getElementById('country-toast');
    const prompt = document.getElementById('country-prompt-toast');
    const promptText = document.getElementById('country-prompt-text');
    return {
      country: sel ? sel.value : null,
      toastVisible: toast ? toast.classList.contains('toast--visible') : false,
      toastText: toast ? toast.textContent : '',
      promptVisible: prompt ? (prompt.classList.contains('toast--visible') && prompt.style.display !== 'none') : false,
      promptText: promptText ? promptText.textContent : '',
    };
  });

  // --- Test 1: Empty select + Marker in Canada -> auto prefill Canada + toast ---
  console.log('\n--- 1. Marker with empty select ---');
  await page.evaluate(() => {
    document.getElementById('region-country').value = '';
    // Enable marker drawing and place a marker in Canada [50.0, -95.0]
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(50.0, -95.0) });
  });

  // Wait for async reverse geocode to resolve and update select
  await page.waitForFunction(() => document.getElementById('region-country').value === 'canada', null, { timeout: 5000 });
  const s1 = await getState();
  check('1a Marker placed in Canada auto-fills country select to canada', s1.country === 'canada', s1.country);
  check('1b Marker placed shows auto-selected toast message', s1.toastVisible && s1.toastText.includes('Canada'), s1.toastText);
  check('1c Marker placed does NOT show prompt toast', !s1.promptVisible, String(s1.promptVisible));

  // --- Test 2: Country already selected ('canada') + Line in Canada -> Case 1: do nothing ---
  console.log('\n--- 2. Matching country already selected (Case 1) ---');
  // Clear any active toasts first
  await page.evaluate(() => {
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
  });
  await page.evaluate(() => {
    // Start drawing line in Canada [52.0, -90.0]
    map.pm.enableDraw('Line');
    map.fire('click', { latlng: L.latLng(52.0, -90.0) });
    // Add second vertex
    map.fire('click', { latlng: L.latLng(53.0, -89.0) });
    map.pm.disableDraw();
  });
  await page.waitForTimeout(400);

  const s2 = await getState();
  check('2a Country remains canada', s2.country === 'canada', s2.country);
  check('2b No new toast shown when country matches', !s2.toastVisible, s2.toastText);
  check('2c No prompt toast shown when country matches', !s2.promptVisible, String(s2.promptVisible));

  // --- Test 3: Country is 'canada' + First vertex in South Africa -> Case 2: prompt player, don't auto change ---
  console.log('\n--- 3. Conflicting country with Line (Case 2: prompt without changing) ---');
  await page.evaluate(() => {
    // Start line in South Africa [-30.0, 25.0]
    map.pm.enableDraw('Line');
    map.fire('click', { latlng: L.latLng(-30.0, 25.0) });
  });

  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });

  const s3 = await getState();
  check('3a Country dropdown NOT automatically changed, remains canada', s3.country === 'canada', s3.country);
  check('3b Prompt toast is visible', s3.promptVisible === true, String(s3.promptVisible));
  check('3c Prompt asks to change from Canada to South Africa', s3.promptText.includes('South Africa') && s3.promptText.includes('Canada'), s3.promptText);

  // Subsequent vertices of the line do NOT re-trigger or change prompt
  await page.evaluate(() => {
    map.fire('click', { latlng: L.latLng(-31.0, 26.0) });
    map.fire('click', { latlng: L.latLng(-32.0, 27.0) });
    map.pm.disableDraw();
  });
  await page.waitForTimeout(300);
  const s3b = await getState();
  check('3d Subsequent vertices do not change selection', s3b.country === 'canada', s3b.country);

  // Click "Keep" button -> dismisses prompt, country stays canada
  console.log('\n--- 4. Dismissing prompt with "Keep" ---');
  await page.click('#country-prompt-keep');
  await page.waitForTimeout(400);
  const s4 = await getState();
  check('4a Clicking Keep hides prompt toast', !s4.promptVisible, String(s4.promptVisible));
  check('4b Selection remains canada', s4.country === 'canada', s4.country);

  // --- Test 5: Conflicting country + Click "Change" -> updates country select to detected ---
  console.log('\n--- 5. Accepting prompt with "Change" ---');
  await page.evaluate(() => {
    // Place a marker in South Africa [-29.0, 24.0]
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-29.0, 24.0) });
  });

  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });

  await page.click('#country-prompt-change');
  await page.waitForTimeout(400);

  const s5 = await getState();
  check('5a Clicking Change updates select to south-africa', s5.country === 'south-africa', s5.country);
  check('5b Prompt toast is dismissed', !s5.promptVisible, String(s5.promptVisible));
  check('5c Shows confirmation toast: Country changed to South Africa', s5.toastVisible && s5.toastText.includes('South Africa'), s5.toastText);

  // --- Test 6: Polygon with empty select in Hawaii -> auto prefill hawaii ---
  console.log('\n--- 6. Polygon first vertex with empty select (Hawaii) ---');
  await page.evaluate(() => {
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    // Start drawing polygon in Hawaii [21.3, -157.8]
    map.pm.enableDraw('Polygon');
    map.fire('click', { latlng: L.latLng(21.3, -157.8) });
  });

  await page.waitForFunction(() => document.getElementById('region-country').value === 'hawaii', null, { timeout: 5000 });
  const s6 = await getState();
  check('6a First vertex of polygon in Hawaii auto-selects hawaii', s6.country === 'hawaii', s6.country);
  check('6b Informational toast shows Hawaii', s6.toastVisible && s6.toastText.includes('Hawaii'), s6.toastText);

  // Add more vertices to polygon -> no new change
  await page.evaluate(() => {
    map.fire('click', { latlng: L.latLng(21.4, -157.7) });
    map.fire('click', { latlng: L.latLng(21.2, -157.6) });
    map.pm.disableDraw();
  });
  await page.waitForTimeout(300);
  const s6b = await getState();
  check('6c Country remains hawaii after completing polygon', s6b.country === 'hawaii', s6b.country);

  // --- Test 7: Country mode scope guard ---
  console.log('\n--- 7. Country scope mode guard ---');
  await page.evaluate(() => {
    document.getElementById('region-country').value = '';
    setScope('country');
    // Calling handleFirstPointCountry directly in country mode
    handleFirstPointCountry(L.latLng(50.0, -95.0));
  });
  await page.waitForTimeout(400);
  const s7 = await getState();
  check('7a Country mode ignores auto-detection', s7.country === '', s7.country);

  // --- Test 8: Fallback to bounding box when reverse geocode fails ---
  console.log('\n--- 8. Bounding box fallback on API failure ---');
  abortBdc = true;
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    setScope('region');
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    // Place marker in South Africa [-28.0, 24.0]
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-28.0, 24.0) });
  });
  await page.waitForFunction(() => document.getElementById('region-country').value === 'south-africa', null, { timeout: 5000 });
  const s8 = await getState();
  check('8a Bounding box fallback resolves to south-africa when API aborted', s8.country === 'south-africa', s8.country);
  check('8b Informational toast is displayed with south-africa', s8.toastVisible && s8.toastText.includes('South Africa'), s8.toastText);

  // 8c: Offline Kazakhstan [48.0, 67.0] must NOT resolve to Russia
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(48.0, 67.0) });
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });
  const s8c = await getState();
  check('8c Offline Kazakhstan does NOT select Russia in dropdown', s8c.country === '', s8c.country);
  check('8d Offline Kazakhstan prompts Kazakhstan proposal', s8c.promptText.includes('Kazakhstan'), s8c.promptText);

  // 8e: Offline Western China [43.8, 87.6] must NOT resolve to Russia
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(43.8, 87.6) });
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });
  const s8e = await getState();
  check('8e Offline Western China does NOT select Russia in dropdown', s8e.country === '', s8e.country);
  check('8f Offline Western China prompts China proposal', s8e.promptText.includes('China'), s8e.promptText);

  // 8g/8h: Tororo, Uganda [0.69, 34.18] near Kenya border (Kenya is active) -> must prompt Uganda proposal, NOT select Kenya
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(0.69, 34.18) });
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });
  const s8g = await getState();
  check('8g Uganda near Kenya border does NOT falsely select active Kenya', s8g.country === '', s8g.country);
  check('8h Uganda near Kenya border prompts Uganda proposal', s8g.promptText.includes('Uganda'), s8g.promptText);

  // 8i/8j: Musina, South Africa [-22.35, 30.04] (northern border near Botswana/Zimbabwe) -> must auto-select South Africa
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-22.35, 30.04) });
  });
  await page.waitForFunction(() => document.getElementById('region-country').value === 'south-africa', null, { timeout: 5000 });
  const s8i = await getState();
  check('8i Musina on northern border resolves to south-africa', s8i.country === 'south-africa', s8i.country);
  check('8j Informational toast shows South Africa at northern border', s8i.toastVisible && s8i.toastText.includes('South Africa'), s8i.toastText);

  // 8k: Zeerust, South Africa [-25.53, 26.08] (45km from Botswana border) -> must auto-select South Africa
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-25.53, 26.08) });
  });
  await page.waitForFunction(() => document.getElementById('region-country').value === 'south-africa', null, { timeout: 5000 });
  const s8k = await getState();
  check('8k Zeerust resolves to south-africa', s8k.country === 'south-africa', s8k.country);

  // 8l/8m: Gaborone, Botswana [-24.65, 25.90] (15km from SA border) -> must prompt Botswana proposal, NOT South Africa
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-24.65, 25.90) });
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });
  const s8l = await getState();
  check('8l Gaborone, Botswana does NOT select South Africa in dropdown', s8l.country === '', s8l.country);
  check('8m Gaborone, Botswana prompts Botswana proposal', s8l.promptText.includes('Botswana'), s8l.promptText);

  // 8n/8o: Maseru, Lesotho [-29.31, 27.48] (enclave inside SA) -> must prompt Lesotho proposal, NOT South Africa
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(-29.31, 27.48) });
  });
  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });
  const s8n = await getState();
  check('8n Maseru, Lesotho does NOT select South Africa in dropdown', s8n.country === '', s8n.country);
  check('8o Maseru, Lesotho prompts Lesotho proposal', s8n.promptText.includes('Lesotho'), s8n.promptText);

  abortBdc = false;

  // --- Test 9: Kazakhstan (inside Russia bounding box) -> must prompt for Kazakhstan, NOT select Russia ---
  console.log('\n--- 9. Kazakhstan (inside Russia bounding box) prompts Kazakhstan proposal and mirrors full modal ---');
  await page.evaluate(() => {
    drawnLayers.slice().forEach((l) => { if (l._map) l._map.removeLayer(l); });
    drawnLayers.length = 0;
    document.getElementById('region-country').value = '';
    const t = document.getElementById('country-toast');
    if (t) t.classList.remove('toast--visible');
    const p = document.getElementById('country-prompt-toast');
    if (p) p.classList.remove('toast--visible');
    // Place a marker in Kazakhstan [48.0, 67.0] (geographically inside Russia bounding box [35, 45]-[65, 135])
    map.pm.enableDraw('Marker');
    map.fire('click', { latlng: L.latLng(48.0, 67.0) });
  });

  await page.waitForFunction(() => {
    const p = document.getElementById('country-prompt-toast');
    return p && p.classList.contains('toast--visible');
  }, null, { timeout: 5000 });

  const s9 = await getState();
  check('9a Country select is NOT falsely set to russia, remains empty', s9.country === '', s9.country);
  check('9b Prompt toast is visible', s9.promptVisible === true, String(s9.promptVisible));
  check('9c Prompt mentions Kazakhstan isn’t on GeoGuide yet', s9.promptText.includes('Kazakhstan') && s9.promptText.includes('isn’t on GeoGuide yet'), s9.promptText);

  // Check propose button in prompt toast
  const proposeBtnText = await page.evaluate(() => {
    const btn = document.getElementById('country-prompt-change');
    return btn ? btn.textContent : '';
  });
  check('9d Propose button has label Propose Kazakhstan', proposeBtnText.includes('Kazakhstan'), proposeBtnText);

  // Click "Propose Kazakhstan" button
  proposalBody = null;
  await page.click('#country-prompt-change');
  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && !modal.hidden && modal.classList.contains('is-open');
  }, null, { timeout: 5000 });

  // Verify full modal structure: Country select is preselected, Region input is dimmed
  const modalState = await page.evaluate(() => {
    const sel = document.getElementById('proposal-country-select');
    const reg = document.getElementById('proposal-region');
    const toggle = document.getElementById('proposal-meta-toggle');
    return {
      countryVal: sel ? sel.value : null,
      regionDimmed: reg ? (reg.parentElement.style.opacity === '0.3') : false,
      hasToggle: !!toggle,
    };
  });
  check('9e Proposal modal has country select prefilled to Kazakhstan', modalState.countryVal === 'Kazakhstan', modalState.countryVal);
  check('9f Region input parent is dimmed when country is selected', modalState.regionDimmed === true, String(modalState.regionDimmed));
  check('9g Proposal modal includes goal toggle (Provide / Learn meta)', modalState.hasToggle === true, String(modalState.hasToggle));

  // Check "Provide meta" is selected by default
  const defaultGoalSelected = await page.evaluate(() => {
    const btn = document.querySelector('#proposal-meta-toggle .meta-toggle-btn[data-value="provide"]');
    return btn ? btn.classList.contains('is-selected') : false;
  });
  check('9h Provide meta goal is selected by default', defaultGoalSelected === true, String(defaultGoalSelected));

  // If intent is explicitly unset, submitting shows validation error
  await page.evaluate(() => { setMetaIntent(null); });
  await page.click('#proposal-submit-btn');
  const errText1 = await page.evaluate(() => {
    const err = document.getElementById('proposal-error');
    return err && err.style.display !== 'none' ? err.textContent : '';
  });
  check('9i Submitting without goal shows validation error', errText1.includes('provide or learn meta'), errText1);

  // Re-select "Provide meta" goal
  await page.click('#proposal-meta-toggle .meta-toggle-btn[data-value="provide"]');

  // Enter a reason and submit proposal
  await page.fill('#proposal-reason', 'Distinct landscape, steppe, and blue license plates');
  await page.click('#proposal-submit-btn');

  // Wait for submission to complete and modal to close
  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && modal.hidden;
  }, null, { timeout: 5000 });

  check('9j Proposal posted with correct proposed_name Kazakhstan, type country, and meta_intent provide',
    proposalBody && proposalBody.action === 'propose-country'
      && proposalBody.proposed_name === 'Kazakhstan'
      && proposalBody.proposal_type === 'country'
      && proposalBody.meta_intent === 'provide'
      && proposalBody.reason === 'Distinct landscape, steppe, and blue license plates',
    JSON.stringify(proposalBody)
  );

  const s9Toast = await getState();
  check('9k Shows success toast after proposing Kazakhstan', s9Toast.toastVisible && s9Toast.toastText.includes('Kazakhstan submitted'), s9Toast.toastText);

  // --- Test 10: Country dropdown proposal option (__propose__) ---
  console.log('\n--- 10. Country select "__propose__" option opens modal ---');
  await page.selectOption('#region-country', '__propose__');
  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && !modal.hidden && modal.classList.contains('is-open');
  }, null, { timeout: 5000 });

  const s10 = await getState();
  check('10a Selecting propose option resets dropdown value to empty', s10.country === '', s10.country);
  await page.click('#proposal-modal-close');
  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && modal.hidden;
  }, null, { timeout: 5000 });
  check('10b Proposal modal closed via close button', true);

  // --- Test 11: Propose link under country select + Custom Region input test ---
  console.log('\n--- 11. Propose link under country select opens modal and allows proposing custom Region ---');
  await page.click('#propose-country-link');
  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && !modal.hidden && modal.classList.contains('is-open');
  }, null, { timeout: 5000 });

  // Type in custom region -> country select should dim
  await page.fill('#proposal-region', 'Central Asia');
  const countryDimmed = await page.evaluate(() => {
    const sel = document.getElementById('proposal-country-select');
    return sel ? (sel.parentElement.style.opacity === '0.3') : false;
  });
  check('11a Typing in region input dims country dropdown', countryDimmed === true, String(countryDimmed));

  // Select "Learn meta" goal and submit
  proposalBody = null;
  await page.click('#proposal-meta-toggle .meta-toggle-btn[data-value="learn"]');
  await page.fill('#proposal-reason', 'Cross-border landscape tips');
  await page.click('#proposal-submit-btn');

  await page.waitForFunction(() => {
    const modal = document.getElementById('proposal-modal');
    return modal && modal.hidden;
  }, null, { timeout: 5000 });

  check('11b Custom region proposal posted with proposed_name Central Asia, type region, and meta_intent learn',
    proposalBody && proposalBody.action === 'propose-country'
      && proposalBody.proposed_name === 'Central Asia'
      && proposalBody.proposal_type === 'region'
      && proposalBody.meta_intent === 'learn',
    JSON.stringify(proposalBody)
  );

  const s11Toast = await getState();
  check('11c Shows success toast after proposing Central Asia', s11Toast.toastVisible && s11Toast.toastText.includes('Central Asia submitted'), s11Toast.toastText);

  console.log('\nPage errors logged:', pageErrors.length);
  if (pageErrors.length > 0) {
    console.log(pageErrors);
  }
  check('No page errors during execution', pageErrors.length === 0, pageErrors.join(', '));

  await browser.close();

  console.log('\nSummary: ' + (failures === 0 ? 'ALL PASS' : failures + ' FAILED'));
  process.exit(failures === 0 ? 0 : 1);
})();

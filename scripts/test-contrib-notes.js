// Playwright test suite for contributors country notes selection & interaction
// Verifies:
// 1. Contributors note expands on row click.
// 2. Clicking inside note text does NOT collapse the note.
// 3. Dragging to select text within note does NOT collapse note or close panel.
// 4. Dragging selection starting in note and releasing outside panel does NOT close panel or collapse note.
// 5. Clicking genuinely outside the panel (e.g. on map) closes the panel.
// 6. Clicking on contributor name/count toggles the note.

const { chromium } = require('playwright');

const TEST_PORT = 3000;
const URL = `http://localhost:${TEST_PORT}/explore.html`;

const MOCK_CONTRIBUTORS = {
  contributors: [
    {
      user_id: 'u1',
      username: 'geoguide_pro',
      count: 12,
      note: 'Gen 4 camera with distinct front antenna and reddish soil in southern territory.'
    },
    {
      user_id: 'u2',
      username: 'explorer_bob',
      count: 3
    }
  ],
  total: 2
};

const MOCK_REGIONS = [
  {
    id: 1,
    region_name: 'Western Cape',
    country_id: 'south-africa',
    color: '#3388ff',
    geojson: [{ type: 'Polygon', coordinates: [[[18, -34], [19, -34], [19, -33], [18, -33], [18, -34]]] }]
  }
];

let failed = false;
function check(title, condition, extra) {
  if (!condition) {
    failed = true;
    console.error(`FAIL: ${title}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  } else {
    console.log(`PASS: ${title}${extra ? ' — ' + JSON.stringify(extra) : ''}`);
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    proxy: process.env.http_proxy ? { server: process.env.http_proxy, bypass: 'localhost,127.0.0.1' } : undefined
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));

  // Route API requests
  await ctx.route('**/api/countries*', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      countries: [
        { id: 'south-africa', name: 'South Africa', flag: 'za', active: true, bounds_sw: [-35, 16], bounds_ne: [-22, 33] }
      ]
    })
  }));

  await ctx.route('**/api/submissions?action=contributors*', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(MOCK_CONTRIBUTORS)
  }));

  await ctx.route('**/api/submissions*', r => {
    const url = r.request().url();
    if (url.includes('action=contributors')) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_CONTRIBUTORS) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_REGIONS) });
  });

  await ctx.route('**/api/auth*', r => r.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ user: { id: 'u1', username: 'tester' } })
  }));

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Wait for map and contributors button
  await page.waitForSelector('.map-contrib-btn', { state: 'visible' });

  // Click contributors button to open panel
  await page.click('.map-contrib-btn');
  await page.waitForSelector('#contrib-panel:not([hidden])');
  await page.waitForSelector('.contrib-panel__row--has-note');

  // Verify panel is open
  const isPanelOpen = await page.evaluate(() => {
    const p = document.getElementById('contrib-panel');
    return p && !p.hidden;
  });
  check('1. Contributors panel opens', isPanelOpen === true);

  // Click row to expand note
  const rowWithNote = page.locator('.contrib-panel__row--has-note');
  await rowWithNote.click();
  await page.waitForSelector('.contrib-panel__note:not([hidden])');

  const isNoteExpanded = await page.evaluate(() => {
    const note = document.querySelector('.contrib-panel__note');
    return note && !note.hidden;
  });
  check('2. Note expands on row click', isNoteExpanded === true);

  // 3. Click directly on note text: must NOT collapse note
  const noteText = page.locator('.contrib-panel__note-text');
  await noteText.click();
  await page.waitForTimeout(100);

  const noteStillOpenAfterClick = await page.evaluate(() => {
    const note = document.querySelector('.contrib-panel__note');
    return note && !note.hidden;
  });
  check('3. Clicking inside note text does NOT collapse note', noteStillOpenAfterClick === true);

  // 4. Drag to select text within note: must NOT collapse note or close panel
  const box = await noteText.boundingBox();
  check('4a. Note text has valid bounding box', !!box);
  if (box) {
    // Mouse down at start of text, drag 80px to the right, mouse up
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 10, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const noteOpenAfterDrag = await page.evaluate(() => {
      const note = document.querySelector('.contrib-panel__note');
      const p = document.getElementById('contrib-panel');
      const sel = window.getSelection ? window.getSelection().toString() : '';
      return { noteOpen: note && !note.hidden, panelOpen: p && !p.hidden, selectedText: sel };
    });
    check('4b. Note remains open after internal drag-selection', noteOpenAfterDrag.noteOpen === true);
    check('4c. Panel remains open after internal drag-selection', noteOpenAfterDrag.panelOpen === true);
    check('4d. Text was selected during drag', noteOpenAfterDrag.selectedText.length > 0, noteOpenAfterDrag.selectedText);
  }

  // 5. Drag selection starting inside note and ending OUTSIDE the panel (e.g. at x=100, y=500 on map)
  if (box) {
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    // Drag way outside panel to map area
    await page.mouse.move(100, 500, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);

    const noteOpenAfterOuterDrag = await page.evaluate(() => {
      const note = document.querySelector('.contrib-panel__note');
      const p = document.getElementById('contrib-panel');
      return { noteOpen: note && !note.hidden, panelOpen: p && !p.hidden };
    });
    check('5a. Note remains open after mouseup outside panel', noteOpenAfterOuterDrag.noteOpen === true);
    check('5b. Panel remains open after mouseup outside panel', noteOpenAfterOuterDrag.panelOpen === true);
  }

  // 6. Clicking contributor name/header toggles the note closed
  const nameEl = page.locator('.contrib-panel__name').first();
  await nameEl.click();
  await page.waitForTimeout(100);

  const noteClosedAfterToggle = await page.evaluate(() => {
    const note = document.querySelector('.contrib-panel__note');
    return !note || note.hidden;
  });
  check('6. Clicking contributor name toggles the note closed', noteClosedAfterToggle === true);

  // 7. Genuinely clicking outside the panel (mousedown and mouseup on map) must close panel
  await page.mouse.click(100, 500);
  await page.waitForTimeout(200);

  const panelClosedAfterOuterClick = await page.evaluate(() => {
    const p = document.getElementById('contrib-panel');
    return !p || p.hidden;
  });
  check('7. Clicking on map closes the contributors panel', panelClosedAfterOuterClick === true);

  // Check errors
  check('8. No page errors occurred', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();

  if (failed) {
    console.error('\nResult: SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\nResult: ALL PASS');
    process.exit(0);
  }
})();

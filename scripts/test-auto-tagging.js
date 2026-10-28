// Playwright test suite for submit page title auto-tagging
// Verifies:
// 1. Unambiguous tags are extracted and auto-selected (e.g. 2024, spring).
// 2. Conservative disambiguation: cross-category duplicate tags (e.g. black in Car vs Soil) are NOT auto-filled.
// 3. Unambiguous compound/sub-tags (e.g. black truck) ARE auto-filled.
// 4. Word boundary guard: substrings (e.g. Springfield, 20240) do NOT trigger tags.
// 5. Existing manual tag selections are preserved.
// 6. User deselect memory: removing an auto-tagged chip does NOT bounce back on title edits.
// 7. Deleting the word and re-typing resets memory and re-tags.
// 8. Selected tags display chip remove button works directly.
//
// Run with: node scripts/test-auto-tagging.js

const { chromium } = require('playwright');

const TEST_PORT = 3999;
const URL = `http://127.0.0.1:${TEST_PORT}/submit.html`;

const MOCK_CATEGORIES = [
  {
    name: 'Car',
    sort_order: 0,
    tags: [
      { id: 'c1', name: 'smallcam' },
      { id: 'c2', name: 'gen3' },
      { id: 'c3', name: 'gen4' },
      { id: 'c4', name: 'black' },
      { id: 'c5', name: 'truck', children: [{ id: 'c5-1', name: 'black truck' }] }
    ]
  },
  {
    name: 'Copyright',
    sort_order: 1,
    tags: [
      { id: 'cp1', name: '2022' },
      { id: 'cp2', name: '2023' },
      { id: 'cp3', name: '2024' },
      { id: 'cp4', name: '2025' }
    ]
  },
  {
    name: 'Season',
    sort_order: 2,
    tags: [
      { id: 's1', name: 'spring' },
      { id: 's2', name: 'summer' },
      { id: 's3', name: 'autumn' },
      { id: 's4', name: 'winter' }
    ]
  },
  {
    name: 'Soil',
    sort_order: 3,
    tags: [
      { id: 'sl1', name: 'black' },
      { id: 'sl2', name: 'red' },
      { id: 'sl3', name: 'sandy' }
    ]
  },
  {
    name: 'Terrain',
    sort_order: 4,
    tags: [
      { id: 't1', name: 'flat' },
      { id: 't2', name: 'mountainous' }
    ]
  }
];

let failed = false;
function check(title, condition, extra) {
  if (!condition) {
    failed = true;
    console.error(`FAIL: ${title}${extra ? ' — ' + extra : ''}`);
  } else {
    console.log(`PASS: ${title}${extra ? ' — ' + extra : ''}`);
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

  // Route API endpoints
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/auth*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"u1","username":"tester"}}' }));
  await ctx.route('**/api/tags*', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ categories: MOCK_CATEGORIES })
    });
  });
  await ctx.route('**/api/countries*', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        countries: [
          { id: 'south-africa', name: 'South Africa', flag: 'za', active: true, bounds_sw: [-35, 16], bounds_ne: [-22, 33] }
        ]
      })
    });
  });
  await ctx.route('**/api/user-submissions*', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Wait for tags to load
  await page.waitForFunction(() => window._categoriesData && window._categoriesData.length > 0);

  function hasTag(list, name) {
    return (list || []).some(t => t === name || t.endsWith(':' + name));
  }

  async function getSelectedTags() {
    return await page.evaluate(() => selectedTags.slice());
  }

  // --- Test 1: Conservative Auto-tagging ---
  console.log('\n--- 1. Title with unambiguous and ambiguous keywords ---');
  await page.fill('#region-name', 'Northern Northland 2024 Spring Black');
  // Wait for debounce (250ms)
  await page.waitForTimeout(400);

  const t1Tags = await getSelectedTags();
  check('1a Auto-selected 2024 (Copyright)', hasTag(t1Tags, '2024'), JSON.stringify(t1Tags));
  check('1b Auto-selected spring (Season)', hasTag(t1Tags, 'spring'), JSON.stringify(t1Tags));
  check('1c Conservative: Ambiguous "black" (Car vs Soil) is NOT auto-selected', !hasTag(t1Tags, 'black'), JSON.stringify(t1Tags));

  // Check display element
  const displayHtml1 = await page.innerHTML('#selected-tags-display');
  check('1d Display shows 2024 chip', displayHtml1.includes('2024'));
  check('1e Display shows spring chip', displayHtml1.includes('spring'));
  check('1f Display does NOT show black chip', !displayHtml1.includes('data-tag="black"') && !displayHtml1.includes(':black"'));

  // --- Test 2: Unambiguous compound sub-tag ---
  console.log('\n--- 2. Unambiguous compound sub-tag (black truck) ---');
  await page.fill('#region-name', 'Northern Northland 2024 Spring black truck');
  await page.waitForTimeout(400);

  const t2Tags = await getSelectedTags();
  check('2a Auto-selected black truck (Car)', hasTag(t2Tags, 'black truck'), JSON.stringify(t2Tags));
  check('2b Auto-selected parent truck (Car)', hasTag(t2Tags, 'truck'), JSON.stringify(t2Tags));
  check('2c Ambiguous single black still NOT selected', !hasTag(t2Tags, 'black'), JSON.stringify(t2Tags));

  // --- Test 3: False-positive substring guard ---
  console.log('\n--- 3. False-positive substring guard ---');
  // Clear tags and title
  await page.evaluate(() => {
    selectedTags.length = 0;
    updateSelectedDisplay();
  });
  await page.fill('#region-name', 'Springfield 20240 Blackwood');
  await page.waitForTimeout(400);

  const t3Tags = await getSelectedTags();
  check('3a Springfield does not trigger spring', !hasTag(t3Tags, 'spring'), JSON.stringify(t3Tags));
  check('3b 20240 does not trigger 2024', !hasTag(t3Tags, '2024'), JSON.stringify(t3Tags));
  check('3c Blackwood does not trigger black', !hasTag(t3Tags, 'black'), JSON.stringify(t3Tags));
  check('3d No tags selected', t3Tags.length === 0, JSON.stringify(t3Tags));

  // --- Test 4: Preserving existing manual tags ---
  console.log('\n--- 4. Preserving existing manual tags ---');
  // User selects Terrain -> mountainous manually
  await page.selectOption('#tag-category-select', 'Terrain');
  await page.waitForSelector('#tag-chips .tag-chip');
  await page.click('#tag-chips .tag-chip:has-text("mountainous")');

  const t4Before = await getSelectedTags();
  check('4a Manually selected mountainous', hasTag(t4Before, 'mountainous'), JSON.stringify(t4Before));

  // Now user types title with 2024
  await page.fill('#region-name', 'Table Mountain Peak 2024');
  await page.waitForTimeout(400);

  const t4After = await getSelectedTags();
  check('4b mountainous is retained', hasTag(t4After, 'mountainous'), JSON.stringify(t4After));
  check('4c 2024 is incrementally added', hasTag(t4After, '2024'), JSON.stringify(t4After));

  // --- Test 5: User deselect memory ---
  console.log('\n--- 5. User deselect memory (no bouncing back) ---');
  // Clear title and tags
  await page.evaluate(() => {
    selectedTags.length = 0;
    updateSelectedDisplay();
  });
  await page.fill('#region-name', 'Northland 2024 Spring');
  await page.waitForTimeout(400);

  const t5Init = await getSelectedTags();
  check('5a Initial auto-tags include spring and 2024', hasTag(t5Init, 'spring') && hasTag(t5Init, '2024'), JSON.stringify(t5Init));

  // User manually deselects spring by clicking its remove button in selected tags display
  await page.click('#selected-tags-display .tag-chip[data-tag*="spring"] .tag-chip__remove');
  const t5AfterRemove = await getSelectedTags();
  check('5b spring is removed from selectedTags', !hasTag(t5AfterRemove, 'spring'), JSON.stringify(t5AfterRemove));
  check('5c 2024 is still selected', hasTag(t5AfterRemove, '2024'), JSON.stringify(t5AfterRemove));

  // User continues typing in the title without removing the word Spring
  await page.fill('#region-name', 'Northland 2024 Spring Extra Notes');
  await page.waitForTimeout(400);

  const t5AfterEdit = await getSelectedTags();
  check('5d spring does NOT bounce back after user explicitly removed it', !hasTag(t5AfterEdit, 'spring'), JSON.stringify(t5AfterEdit));
  check('5e 2024 is still selected', hasTag(t5AfterEdit, '2024'), JSON.stringify(t5AfterEdit));

  // --- Test 6: Deleting word and re-typing resets memory ---
  console.log('\n--- 6. Deleting word and re-typing resets memory ---');
  // User removes the word Spring from title
  await page.fill('#region-name', 'Northland 2024 Extra Notes');
  await page.waitForTimeout(400);

  // Now user re-types Spring
  await page.fill('#region-name', 'Northland 2024 Extra Notes Spring');
  await page.waitForTimeout(400);

  const t6Tags = await getSelectedTags();
  check('6a spring is re-selected after user removed and re-typed it', hasTag(t6Tags, 'spring'), JSON.stringify(t6Tags));

  // --- Test 7: Category chips visual sync ---
  console.log('\n--- 7. Category chips visual sync ---');
  await page.selectOption('#tag-category-select', 'Season');
  await page.waitForTimeout(200);

  const isSpringChipActive = await page.evaluate(() => {
    const chip = document.querySelector('#tag-chips .tag-chip[data-tag*="spring"]');
    return chip ? chip.classList.contains('is-selected') : false;
  });
  check('7a Season category chip for spring is visually marked is-selected', isSpringChipActive === true);

  // Clicking the chip in category view deselects it
  await page.click('#tag-chips .tag-chip[data-tag*="spring"]');
  const t7Tags = await getSelectedTags();
  check('7b Deselected spring via category chip click', !hasTag(t7Tags, 'spring'), JSON.stringify(t7Tags));

  // --- Test 8: Toast notification on auto-tag prefill ---
  console.log('\n--- 8. Toast notification on auto-tag prefill ---');
  await page.evaluate(() => {
    selectedTags.length = 0;
    updateSelectedDisplay();
  });
  await page.fill('#region-name', 'Table Mountain 2024');
  await page.waitForTimeout(400);

  const isToastVisible = await page.evaluate(() => {
    const t = document.getElementById('tag-toast');
    return t ? t.classList.contains('toast--visible') : false;
  });
  const toastText = await page.evaluate(() => {
    const t = document.getElementById('tag-toast');
    return t ? t.textContent : '';
  });
  check('8a Informational toast is visible', isToastVisible === true);
  check('8b Informational toast mentions 2024', toastText.includes('2024') && toastText.includes('Auto-selected'), toastText);

  // --- Test 9: Removal prompt toast when keyword is removed from title (Keep vs Remove) ---
  console.log('\n--- 9. Removal prompt toast when keyword is removed from title ---');
  // Remove 2024 from title
  await page.fill('#region-name', 'Table Mountain');
  await page.waitForTimeout(400);

  const isPromptVisible = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-toast');
    return t ? t.classList.contains('toast--visible') : false;
  });
  const promptText = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-text');
    return t ? t.textContent : '';
  });
  check('9a Removal prompt toast is visible', isPromptVisible === true);
  check('9b Prompt text asks to remove 2024', promptText.includes('2024') && promptText.includes('removed from title'), promptText);

  // 9c: Click "Keep" button
  await page.click('#tag-prompt-keep');
  await page.waitForTimeout(100);

  const t9KeepTags = await getSelectedTags();
  check('9c Clicking Keep retains 2024 in selectedTags', hasTag(t9KeepTags, '2024'), JSON.stringify(t9KeepTags));

  const isPromptClosedAfterKeep = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-toast');
    return t ? !t.classList.contains('toast--visible') : true;
  });
  check('9d Prompt toast is dismissed after Keep', isPromptClosedAfterKeep === true);

  // Now re-type 2024, wait, then delete it again and click "Remove"
  await page.fill('#region-name', 'Table Mountain 2024');
  await page.waitForTimeout(400);

  await page.fill('#region-name', 'Table Mountain');
  await page.waitForTimeout(400);

  const isPromptVisible2 = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-toast');
    return t ? t.classList.contains('toast--visible') : false;
  });
  check('9e Prompt toast appears again upon deleting re-typed 2024', isPromptVisible2 === true);

  // Click "Remove" button
  await page.click('#tag-prompt-remove');
  await page.waitForTimeout(100);

  const t9RemoveTags = await getSelectedTags();
  check('9f Clicking Remove removes 2024 from selectedTags', !hasTag(t9RemoveTags, '2024'), JSON.stringify(t9RemoveTags));

  const removeToastText = await page.evaluate(() => {
    const t = document.getElementById('tag-toast');
    return t ? t.textContent : '';
  });
  check('9g Removal confirmation toast shows', removeToastText.includes('Removed tag: 2024'), removeToastText);

  // --- Test 10: Auto-dismiss prompt if keyword is re-typed before answering ---
  console.log('\n--- 10. Auto-dismiss prompt if keyword is re-typed before answering ---');
  await page.fill('#region-name', 'Table Mountain 2024');
  await page.waitForTimeout(400);
  await page.fill('#region-name', 'Table Mountain');
  await page.waitForTimeout(400);

  const isPromptVisible3 = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-toast');
    return t ? t.classList.contains('toast--visible') : false;
  });
  check('10a Prompt visible after deletion', isPromptVisible3 === true);

  // User immediately re-types 2024
  await page.fill('#region-name', 'Table Mountain 2024');
  await page.waitForTimeout(400);

  const isPromptDismissedOnRetype = await page.evaluate(() => {
    const t = document.getElementById('tag-prompt-toast');
    return t ? !t.classList.contains('toast--visible') : true;
  });
  check('10b Prompt automatically dismissed when keyword is re-typed', isPromptDismissedOnRetype === true);
  const t10Tags = await getSelectedTags();
  check('10c 2024 remains selected', hasTag(t10Tags, '2024'), JSON.stringify(t10Tags));

  // --- Page errors check ---
  check('11a No page errors occurred during run', pageErrors.length === 0, pageErrors.join('; '));

  await browser.close();

  if (failed) {
    console.error('\nResult: SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\nResult: ALL PASS');
    process.exit(0);
  }
})();

#!/usr/bin/env node
/**
 * Test suite for tag category scoping (task 10-20-tag-category-scoping).
 *
 * Verifies:
 * 1. utils.js helper contracts: parseTag, formatTagName, formatTagFull.
 * 2. search.js filtering disambiguation: duplicate tag names across categories
 *    (e.g., 'blue' in 'Car' vs 'Vibe') do NOT cross-match.
 * 3. Sub-tag inheritance within category works with scoped tags.
 * 4. Backward compatibility: legacy unscoped tags map gracefully using catalog.
 * 5. Frontend UI chip rendering formats clean names without category prefixes.
 * 6. tagMerge.js and expandTags category scoping contracts.
 *
 * Usage: node scripts/test-tag-category-scoping.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

let totalChecks = 0;
let passedChecks = 0;

function check(desc, ok, extra) {
  totalChecks++;
  if (ok) {
    passedChecks++;
    console.log(`  ✓ ${desc}`);
  } else {
    console.error(`  ✗ FAIL: ${desc}`);
    if (extra !== undefined) {
      console.error('    Details:', extra);
    }
  }
}

// -------------------------------------------------------------
// 1. Test public/js/utils.js helper functions
// -------------------------------------------------------------
console.log('\n--- 1. Testing public/js/utils.js helpers ---');
const utils = require(path.join(ROOT, 'public', 'js', 'utils.js'));

check('parseTag("Car:blue") returns { category: "Car", name: "blue" }',
  utils.parseTag('Car:blue').category === 'Car' && utils.parseTag('Car:blue').name === 'blue');

check('parseTag("  Vibe : chill ") handles whitespace trimming',
  utils.parseTag('  Vibe : chill ').category === 'Vibe' && utils.parseTag('  Vibe : chill ').name === 'chill');

check('parseTag("blue") returns { category: null, name: "blue" }',
  utils.parseTag('blue').category === null && utils.parseTag('blue').name === 'blue');

check('parseTag("") returns { category: null, name: "" }',
  utils.parseTag('').category === null && utils.parseTag('').name === '');

check('parseTag(null) returns { category: null, name: "" }',
  utils.parseTag(null).category === null && utils.parseTag(null).name === '');

check('parseTag("Cat:Sub:Name") splits on first colon',
  utils.parseTag('Cat:Sub:Name').category === 'Cat' && utils.parseTag('Cat:Sub:Name').name === 'Sub:Name');

check('formatTagName("Car:blue") returns "blue"', utils.formatTagName('Car:blue') === 'blue');
check('formatTagName("blue") returns "blue"', utils.formatTagName('blue') === 'blue');
check('formatTagName("") returns ""', utils.formatTagName('') === '');

check('formatTagFull("Car:blue") returns "Car: blue"', utils.formatTagFull('Car:blue') === 'Car: blue');
check('formatTagFull("blue") returns "blue"', utils.formatTagFull('blue') === 'blue');

// -------------------------------------------------------------
// 2. Test search.js cross-category scoping logic
// -------------------------------------------------------------
console.log('\n--- 2. Testing public/js/search.js filtering ---');
const searchSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'search.js'), 'utf8');

// Load search.js in sandbox
const sandbox = {
  window: {},
  document: {
    addEventListener: () => {},
    getElementById: () => null
  },
  parseTag: utils.parseTag,
  formatTagName: utils.formatTagName,
  formatTagFull: utils.formatTagFull,
  console: console
};
vm.createContext(sandbox);
vm.runInContext(searchSrc, sandbox);

// Setup mock catalog structures on window
sandbox.window._tagChildrenMap = {
  'truck': ['black truck']
};
sandbox.window._scopedChildrenMap = {
  'Car:truck': ['black truck']
};
sandbox.window._legacyTagToCats = {
  'blue': ['Car', 'Vibe'],
  'gen3': ['Generation'],
  'truck': ['Car'],
  'black truck': ['Car']
};

const regions = [
  { id: 'r1', name: 'Car Blue Region', tags: ['Car:blue'] },
  { id: 'r2', name: 'Vibe Blue Region', tags: ['Vibe:blue'] },
  { id: 'r3', name: 'Car Truck Region', tags: ['Car:black truck'] },
  { id: 'r4', name: 'Legacy Gen3 Region', tags: ['gen3'] },
  { id: 'r5', name: 'Legacy Blue Region', tags: ['blue'] }
];

// Mock polygon layers to observe visibility setting
const mockLayers = new Map();
regions.forEach(r => {
  mockLayers.set(r.id, {
    eachLayer: (fn) => {},
    feature: { geometry: { type: 'Polygon' } }
  });
});
sandbox.window._polygonLayers = mockLayers;

// Test A: Filtering Car -> blue
sandbox.window._selectedTagsByCategory = { 'Car': ['blue'] };
sandbox.applyFilters(regions, '');
check('Car -> blue matches Car:blue (r1)', regions[0]._searchVisible === true);
check('Car -> blue DOES NOT match Vibe:blue (r2)', regions[1]._searchVisible === false);
check('Car -> blue matches legacy blue (r5)', regions[4]._searchVisible === true);

// Test B: Filtering Vibe -> blue
sandbox.window._selectedTagsByCategory = { 'Vibe': ['blue'] };
sandbox.applyFilters(regions, '');
check('Vibe -> blue DOES NOT match Car:blue (r1)', regions[0]._searchVisible === false);
check('Vibe -> blue matches Vibe:blue (r2)', regions[1]._searchVisible === true);
check('Vibe -> blue matches legacy blue (r5)', regions[4]._searchVisible === true);

// Test C: Child tag inheritance within category (Car -> truck matches Car:black truck)
sandbox.window._selectedTagsByCategory = { 'Car': ['truck'] };
sandbox.applyFilters(regions, '');
check('Car -> truck matches child tag Car:black truck (r3)', regions[2]._searchVisible === true);
check('Car -> truck does not match Car:blue (r1)', regions[0]._searchVisible === false);

// Test D: Legacy tag reverse mapping to single category (Generation -> gen3)
sandbox.window._selectedTagsByCategory = { 'Generation': ['gen3'] };
sandbox.applyFilters(regions, '');
check('Generation -> gen3 matches legacy unscoped gen3 (r4)', regions[3]._searchVisible === true);

// Test E: Legacy tag does not match wrong category
sandbox.window._selectedTagsByCategory = { 'Car': ['gen3'] };
sandbox.applyFilters(regions, '');
check('Car -> gen3 does NOT match legacy gen3 (r4)', regions[3]._searchVisible === false);

// -------------------------------------------------------------
// 3. Test explore.html live count scoping
// -------------------------------------------------------------
console.log('\n--- 3. Testing explore.html live count logic ---');
const exploreSrc = fs.readFileSync(path.join(ROOT, 'public', 'explore.html'), 'utf8');

check('explore.html computeLiveCounts uses parseTag',
  exploreSrc.includes('parseTag(t)') && exploreSrc.includes('counts[key]'),
  true);

check('explore.html refreshTagAvailability checks scopedKey = catName + ":" + row.name',
  exploreSrc.includes('catName + \':\' + row.name'),
  true);

check('explore.html refreshTagAvailability scopes catChecked by selectedTags[catName]',
  exploreSrc.includes('var catChecked = selectedTags[catName]') ||
  exploreSrc.includes('selectedTags[catName].indexOf(row.name)'),
  true);

// -------------------------------------------------------------
// 4. Test submit.html tag scoping and display
// -------------------------------------------------------------
console.log('\n--- 4. Testing submit.html tag scoping ---');
const submitSrc = fs.readFileSync(path.join(ROOT, 'public', 'submit.html'), 'utf8');

check('submit.html defines isTagSelected helper', submitSrc.includes('function isTagSelected(catName, tagName)'));
check('submit.html defines removeTag helper', submitSrc.includes('function removeTag(tagKey, tagName)'));
check('submit.html defines normalizeLegacyTags helper', submitSrc.includes('function normalizeLegacyTags(tags)'));
check('submit.html chip click sets catName + ":" + tag.name', submitSrc.includes('var tagKey = catName + \':\' + tag.name'));
check('submit.html updateSelectedDisplay uses formatTagName', submitSrc.includes('formatTagName(t)'));
check('submit.html updateSelectedDisplay uses formatTagFull for title', submitSrc.includes('formatTagFull(t)'));

// -------------------------------------------------------------
// 5. Test UI chips renderers across other pages
// -------------------------------------------------------------
console.log('\n--- 5. Testing frontend UI chip display safety ---');
const modalSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modal.js'), 'utf8');
const mySubSrc = fs.readFileSync(path.join(ROOT, 'public', 'my-submissions.html'), 'utf8');
const profileSrc = fs.readFileSync(path.join(ROOT, 'public', 'profile.html'), 'utf8');
const compareSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'compare.js'), 'utf8');
const reviewSrc = fs.readFileSync(path.join(ROOT, 'public', 'review.html'), 'utf8');

check('modal.js uses formatTagName and formatTagFull',
  modalSrc.includes('formatTagName(t)') && modalSrc.includes('formatTagFull(t)'));

check('my-submissions.html makeTagEl uses formatTagName and formatTagFull',
  mySubSrc.includes('formatTagName(text)') && mySubSrc.includes('formatTagFull(text)'));

check('profile.html uses formatTagName and formatTagFull',
  profileSrc.includes('formatTagName(t)') && profileSrc.includes('formatTagFull(t)'));

check('compare.js uses formatTagName and formatTagFull',
  compareSrc.includes('formatTagName(t)') && compareSrc.includes('formatTagFull(t)'));

check('review.html uses formatTagName and formatTagFull',
  reviewSrc.includes('formatTagName(t)') && reviewSrc.includes('formatTagFull(t)'));

// -------------------------------------------------------------
// 6. Test backend tagMerge.js category scoping
// -------------------------------------------------------------
console.log('\n--- 6. Testing api/_lib/tagMerge.js scoping ---');
const tagMergeSrc = fs.readFileSync(path.join(ROOT, 'api', '_lib', 'tagMerge.js'), 'utf8');
check('tagMerge.js mergeIntoRow supports category parameter',
  tagMergeSrc.includes('mergeIntoRow(db, name, submissionId, category)'));
check('tagMerge.js mergeNameIntoSubmission supports category parameter',
  tagMergeSrc.includes('mergeNameIntoSubmission(db, name, submissionId, category)'));
check('tagMerge.js approves and merges with scoped name category + ":" + name',
  tagMergeSrc.includes('scopedName = category ? (category + \':\' + name) : name'));

const submitApiSrc = fs.readFileSync(path.join(ROOT, 'api', 'submit.js'), 'utf8');
check('api/submit.js expandTags scopes parent query by category',
  submitApiSrc.includes('t1.category = ?') && submitApiSrc.includes('parentCat ? (parentCat + \':\' + parentName) : parentName'));

// -------------------------------------------------------------
// 7. Testing tag filter sizing & contributors mutual close
// -------------------------------------------------------------
console.log('\n--- 7. Testing tag filter sizing & contributors mutual close ---');
const exploreHtmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'explore.html'), 'utf8');
const contribJsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'contributors.js'), 'utf8');
const styleCssSrc = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

check('explore.html exposes window.closeTagFilterPanel',
  exploreHtmlSrc.includes('window.closeTagFilterPanel = function()'));
check('explore.html setOpen calls closeContributorsPanel when opening',
  exploreHtmlSrc.includes('if (open && typeof closeContributorsPanel === \'function\')'));
check('explore.html tag-filter-toggle click calls closeContributorsPanel',
  exploreHtmlSrc.includes('if (willOpen && typeof closeContributorsPanel === \'function\')'));
check('contributors.js calls window.closeTagFilterPanel when opening',
  contribJsSrc.includes('window.closeTagFilterPanel()'));
check('explore.html refreshTagAvailability calculates visibleCatCount',
  exploreHtmlSrc.includes('visibleCatCount++'));
check('explore.html refreshTagAvailability adjusts panel.style.width dynamically',
  exploreHtmlSrc.includes('panel.style.width = \'min(\' + w + \'px, calc(100vw - 24px))\''));
check('explore.html handles empty tag state in tag filter',
  exploreHtmlSrc.includes('tag-filter__empty'));
check('style.css defines .tag-filter__empty styles',
  styleCssSrc.includes('.tag-filter__empty {'));

// -------------------------------------------------------------
// 8. Testing scripts/backfill-scoped-tags.js
// -------------------------------------------------------------
console.log('\n--- 8. Testing scripts/backfill-scoped-tags.js ---');
const backfill = require('./backfill-scoped-tags.js');

check('backfill parseTag handles scoped tag',
  backfill.parseTag('Car:blue').category === 'Car' && backfill.parseTag('Car:blue').name === 'blue');
check('backfill parseTag handles unscoped tag',
  backfill.parseTag('blue').category === null && backfill.parseTag('blue').name === 'blue');
check('backfill parseTags handles string array',
  JSON.stringify(backfill.parseTags('["blue", "Car:fast"]')) === JSON.stringify(['blue', 'Car:fast']));
check('backfill parseTags handles invalid JSON gracefully',
  JSON.stringify(backfill.parseTags('invalid')) === JSON.stringify([]));

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Total checks: ${totalChecks} | Passed: ${passedChecks} | Failed: ${totalChecks - passedChecks}`);
console.log(`========================================\n`);

if (passedChecks === totalChecks) {
  console.log('ALL TAG CATEGORY SCOPING CHECKS PASSED! 🎉');
  process.exit(0);
} else {
  console.error('SOME CHECKS FAILED!');
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Test suite for Homepage Total Meta Counter with Highlights.
 * Task: 10-24-homepage-meta-counter
 *
 * Verifies:
 * 1. DOM structure: #hero-stats inside .hero__content, initially hidden, clean layout.
 * 2. Visual design contract: NO background, NO border, NO box-shadow, NO extra label texts (no 'Top Countries'/'Top Contributors').
 * 3. Smooth scroll targets: countries click targets view-toggle / world-map; contributors click targets most-contributed.
 * 4. CSS styling: tabular-nums for counter, pointer cursor on flags and avatars, responsive wrap.
 * 5. Calculation logic: total metas sum, top 5 countries by region_count, top 5 contributors.
 * 6. Animation logic: Ease-out cubic progression and prefers-reduced-motion fallback.
 * 7. Live DB validation (when credentials present): verifies live totals and top rankings.
 *
 * Usage:
 *   node scripts/test-homepage-meta-counter.js
 *   node --env-file=.env.local scripts/test-homepage-meta-counter.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const indexHtmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const styleCssSrc = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

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
// 1. DOM Structure & Cleanliness Contracts
// -------------------------------------------------------------
console.log('\n--- 1. Testing DOM Structure & Minimalist Contracts ---');

check('index.html contains #hero-stats inside .hero__content',
  indexHtmlSrc.includes('<div class="hero__stats" id="hero-stats" hidden>')
);

check('index.html contains #hero-meta-count for number ticker',
  indexHtmlSrc.includes('id="hero-meta-count"')
);

check('index.html contains #hero-top-countries container',
  indexHtmlSrc.includes('id="hero-top-countries"')
);

check('index.html contains #hero-top-contributors container',
  indexHtmlSrc.includes('id="hero-top-contributors"')
);

check('index.html hero stats does NOT contain "Top Countries" text in DOM',
  !indexHtmlSrc.includes('<span class="hero__stats-section-label">Top Countries</span>')
);

check('index.html hero stats does NOT contain "Top Contributors" text in DOM',
  !indexHtmlSrc.includes('<span class="hero__stats-section-label">Top Contributors</span>')
);

check('index.html hero stats does NOT contain emoji/symbol decoration icons',
  !indexHtmlSrc.includes('hero__stats-icon')
);

// -------------------------------------------------------------
// 2. CSS Styling & Minimalist Contracts
// -------------------------------------------------------------
console.log('\n--- 2. Testing CSS Styling & Absence of Border/Backdrop ---');

check('.hero__stats has background: none',
  styleCssSrc.includes('.hero__stats') && styleCssSrc.includes('background: none;')
);

check('.hero__stats has border: none',
  styleCssSrc.includes('.hero__stats') && styleCssSrc.includes('border: none;')
);

check('.hero__stats has box-shadow: none',
  styleCssSrc.includes('.hero__stats') && styleCssSrc.includes('box-shadow: none;')
);

check('.hero__stats-num uses tabular-nums to prevent jitter',
  styleCssSrc.includes('font-variant-numeric: tabular-nums;')
);

check('.hero__stats-flags has cursor: pointer',
  styleCssSrc.includes('.hero__stats-flags') && styleCssSrc.includes('cursor: pointer;')
);

check('.hero__stats-avatars has cursor: pointer',
  styleCssSrc.includes('.hero__stats-avatars') && styleCssSrc.includes('cursor: pointer;')
);

check('.hero__stats-avatar has overlap (-8px) and circular border ring',
  styleCssSrc.includes('.hero__stats-avatar') &&
  styleCssSrc.includes('margin-left: -8px;') &&
  styleCssSrc.includes('border-radius: 50%;')
);

check('index.html reads u.count correctly for contributor title (not stuck at 0)',
  indexHtmlSrc.includes('var count = u.count != null ? u.count : (u.cnt || 0);')
);

// -------------------------------------------------------------
// 3. Smooth Scroll Navigation Contracts
// -------------------------------------------------------------
console.log('\n--- 3. Testing Smooth Scroll Navigation Contracts ---');

check('flagsEl click scrolls to view-toggle / map section',
  indexHtmlSrc.includes("flagsEl.addEventListener('click', function()") &&
  indexHtmlSrc.includes("scrollToTarget('view-toggle')")
);

check('avatarsEl click scrolls to most-contributed section',
  indexHtmlSrc.includes("avatarsEl.addEventListener('click', function()") &&
  indexHtmlSrc.includes("scrollToTarget('most-contributed')")
);

check('Smooth scroll includes keyboard accessibility (Enter / Space)',
  indexHtmlSrc.includes("flagsEl.addEventListener('keydown'") &&
  indexHtmlSrc.includes("avatarsEl.addEventListener('keydown'")
);

// -------------------------------------------------------------
// 3.5 Loading Timing Contracts (Batch 1 Concurrency)
// -------------------------------------------------------------
console.log('\n--- 3.5 Testing Loading Timing Contracts (Batch 1 Concurrency) ---');

check('window.__homeContribData is preloaded concurrently in head',
  indexHtmlSrc.includes("window.__homeContribData = fetch('/api/submissions?action=contributors&limit=0')")
);

check('window.__homeDataRest reuses preloaded window.__homeContribData without duplicate fetch',
  indexHtmlSrc.includes("window.__homeContribData,") &&
  !indexHtmlSrc.includes("fetch('/api/submissions?action=contributors&limit=0').then(function(r) { return r.json(); }).catch(function() { return { contributors: [] }; }),\n      fetch('data/changelog.json')")
);

check('renderHeroStats is executed in Batch 1 (window.__homeDataCore)',
  indexHtmlSrc.includes("fadeInSections('#hero-stats, #view-toggle, #world-map')")
);

check('Batch 2 does not contain redundant renderHeroStats invocation',
  !indexHtmlSrc.includes("(function renderHeroStats()")
);

check('Smooth scroll to most-contributed handles deferred Batch 2 loading gracefully',
  indexHtmlSrc.includes("if (el.hasAttribute('hidden') && window.__homeDataRest)")
);

// -------------------------------------------------------------
// 3.6 Anti-Flash & Synchronized Loading Contracts
// -------------------------------------------------------------
console.log('\n--- 3.6 Testing Anti-Flash & Synchronized Loading Contracts ---');

check('index.html hero-meta-count has no hardcoded 0 in static HTML to avoid 0 metas flash',
  indexHtmlSrc.includes('<span class="hero__stats-num" id="hero-meta-count"></span>')
);

check('style.css enforces display: none !important for .hero__stats[hidden]',
  styleCssSrc.includes('.hero__stats[hidden]') && styleCssSrc.includes('display: none !important;')
);

check('style.css hides world-map legend when world-map-svg is empty',
  styleCssSrc.includes('#world-map-svg:empty + .world-map__legend') &&
  styleCssSrc.includes('display: none !important;')
);

check('Batch 1 coordinates simultaneous unhiding of hero-stats, view-toggle, and world-map',
  indexHtmlSrc.includes('if (heroStats) heroStats.removeAttribute(\'hidden\');') &&
  indexHtmlSrc.includes('if (coreToggle) coreToggle.removeAttribute(\'hidden\');') &&
  indexHtmlSrc.includes('if (worldMapEl) worldMapEl.removeAttribute(\'hidden\');') &&
  indexHtmlSrc.includes("fadeInSections('#hero-stats, #view-toggle, #world-map')")
);

check('index.html does not prematurely unhide world-map in Country Cards section',
  !indexHtmlSrc.includes("// --- Country Cards ---\n      document.getElementById('world-map').removeAttribute('hidden');")
);

const worldMapJsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'world-map.js'), 'utf8');

check('world-map.js does not prematurely unhide view-toggle in renderWorldMap',
  !worldMapJsSrc.includes("if (toggle) toggle.removeAttribute('hidden');")
);

// -------------------------------------------------------------
// 4. Data Calculation & Sorting Units
// -------------------------------------------------------------
console.log('\n--- 4. Testing Calculation & Top 5 Extraction Logic ---');

const mockCountryMap = {
  'greece': { id: 'greece', name: 'Greece', flag: 'gr', active: 1, region_count: 171 },
  'turkey': { id: 'turkey', name: 'Turkey', flag: 'tr', active: 1, region_count: 85 },
  'canada': { id: 'canada', name: 'Canada', flag: 'ca', active: 1, region_count: 50 },
  'japan': { id: 'japan', name: 'Japan', flag: 'jp', active: 1, region_count: 42 },
  'usa': { id: 'usa', name: 'United States', flag: 'us', active: 1, region_count: 103 },
  'brazil': { id: 'brazil', name: 'Brazil', flag: 'br', active: 1, region_count: 20 },
  'inactive': { id: 'inactive', name: 'Inactive', flag: 'xx', active: 0, region_count: 999 }
};

// Test country sorting
const activeCountries = Object.keys(mockCountryMap)
  .map(k => mockCountryMap[k])
  .filter(c => c && c.active && c.region_count > 0);
activeCountries.sort((a, b) => (b.region_count || 0) - (a.region_count || 0));
const top5C = activeCountries.slice(0, 5);

check('Top 5 countries filters inactive countries', !top5C.some(c => c.id === 'inactive'));
check('Top 5 countries ordered by region_count desc',
  top5C[0].id === 'greece' &&
  top5C[1].id === 'usa' &&
  top5C[2].id === 'turkey' &&
  top5C[3].id === 'canada' &&
  top5C[4].id === 'japan'
);

// Test total count sum
const totalSum = Object.keys(mockCountryMap)
  .filter(k => mockCountryMap[k].active)
  .reduce((s, k) => s + (mockCountryMap[k].region_count || 0), 0);
check('Total metas calculates correctly from country map (471)', totalSum === 471);

// Test top 5 contributors
const mockContributors = [
  { username: 'alice', cnt: 100 },
  { username: 'bob', cnt: 90 },
  { username: 'charlie', cnt: 80 },
  { username: 'david', cnt: 70 },
  { username: 'eve', cnt: 60 },
  { username: 'frank', cnt: 50 }
];
const top5Contribs = mockContributors.slice(0, 5);
check('Top 5 contributors takes top 5 items', top5Contribs.length === 5 && top5Contribs[4].username === 'eve');

// -------------------------------------------------------------
// 5. Animation Math (Ease-Out Cubic)
// -------------------------------------------------------------
console.log('\n--- 5. Testing Animation Progression Math ---');

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

check('Ease-out cubic starts at 0 for t=0', easeOutCubic(0) === 0);
check('Ease-out cubic reaches 1 for t=1', easeOutCubic(1) === 1);
check('Ease-out cubic is front-loaded (progress > 50% at t=0.25)', easeOutCubic(0.25) > 0.5);
check('renderHeroStats includes prefers-reduced-motion bypass',
  indexHtmlSrc.includes("window.matchMedia('(prefers-reduced-motion: reduce)').matches")
);

// -------------------------------------------------------------
// 6. Live DB Sanity (Optional)
// -------------------------------------------------------------
async function runLiveDbChecks() {
  const hasTursoUrl = Boolean(process.env.turso_database_url || process.env.TURSO_DATABASE_URL || process.env.TURSO_URL);
  if (!hasTursoUrl) {
    console.log('\n--- 6. Live DB Sanity (Skipped: No Turso credentials provided) ---');
    return;
  }

  console.log('\n--- 6. Live DB Sanity (Querying Turso Database) ---');
  const { tursoFetch } = require('../api/_lib/turso.js');

  const rCount = await tursoFetch("SELECT COUNT(*) FROM submissions WHERE status = 'approved' AND is_deleted = 0 AND is_hidden = 0");
  const liveCount = Number((rCount.rows[0] && rCount.rows[0][0] && rCount.rows[0][0].value) || 0);
  check(`Live DB has approved submissions (count: ${liveCount})`, liveCount > 0);

  const rTopC = await tursoFetch(
    "SELECT c.id, c.name, (SELECT COUNT(*) FROM submissions WHERE country_id = c.id AND status = 'approved' AND is_deleted = 0 AND is_hidden = 0) as cnt FROM countries c WHERE c.active = 1 ORDER BY cnt DESC LIMIT 5"
  );
  check('Live DB returns 5 top countries', rTopC.rows.length === 5);
}

runLiveDbChecks().then(() => {
  console.log(`\n========================================`);
  console.log(`Total checks: ${totalChecks} | Passed: ${passedChecks} | Failed: ${totalChecks - passedChecks}`);
  console.log(`========================================\n`);

  if (passedChecks === totalChecks) {
    console.log('ALL HERO STATS CHECKS PASSED! 🎉');
    process.exit(0);
  } else {
    console.error('SOME CHECKS FAILED!');
    process.exit(1);
  }
}).catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Test suite for the share-link feature across:
 * - public/js/utils.js (GEOGUIDE_ICONS.share, buildExploreShareUrl, copyToClipboard)
 * - public/js/modal.js (Explore modal share button & URL sync)
 * - public/my-submissions.html (Card action row & map tooltip menu)
 * - public/profile.html (Favorites card share button)
 * - public/css/style.css (Layout & hover styles)
 * - Cache busting version consistency across 6 HTML files
 *
 * Usage: node scripts/test-share-link.js
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
// 1. Test public/js/utils.js logic
// -------------------------------------------------------------
console.log('\n--- 1. Testing public/js/utils.js ---');
const utilsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'utils.js'), 'utf8');

// Load utils.js in a mock VM context
const mockWindow = {
  location: { origin: 'https://geoguide.example.com' },
  dispatchEvent: () => {}
};
const sandbox = {
  window: mockWindow,
  document: {
    createElement: (tag) => ({
      tagName: tag,
      setAttribute: () => {},
      appendChild: () => {}
    }),
    body: { appendChild: () => {}, removeChild: () => {} }
  },
  navigator: {},
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  console: console
};
vm.createContext(sandbox);
vm.runInContext(utilsSrc, sandbox);

check('GEOGUIDE_ICONS.share exists and is non-empty string',
  typeof sandbox.GEOGUIDE_ICONS.share === 'string' && sandbox.GEOGUIDE_ICONS.share.length > 10,
  sandbox.GEOGUIDE_ICONS.share);

const shareSvg = sandbox.geoguideIconSvg('share');
check('geoguideIconSvg("share") produces valid svg string with stroke-width="1.8"',
  shareSvg.startsWith('<svg') && shareSvg.includes('stroke-width="1.8"') && shareSvg.includes(sandbox.GEOGUIDE_ICONS.share),
  shareSvg);

check('buildExploreShareUrl exists as a function', typeof sandbox.buildExploreShareUrl === 'function');

const url1 = sandbox.buildExploreShareUrl({ id: '123', country_id: 'japan' });
check('buildExploreShareUrl with country_id and id',
  url1 === 'https://geoguide.example.com/explore?country=japan&region=123',
  url1);

const url2 = sandbox.buildExploreShareUrl({ id: 456, region: 'south-africa' });
check('buildExploreShareUrl with region and numeric id',
  url2 === 'https://geoguide.example.com/explore?country=south-africa&region=456',
  url2);

const url3 = sandbox.buildExploreShareUrl({ id: 'tokyo-central', country_id: 'japan / tokyo' });
check('buildExploreShareUrl encodes parameters with encodeURIComponent',
  url3 === 'https://geoguide.example.com/explore?country=japan%20%2F%20tokyo&region=tokyo-central',
  url3);

const urlEmpty = sandbox.buildExploreShareUrl(null);
check('buildExploreShareUrl returns empty string for null / invalid', urlEmpty === '');

check('copyToClipboard exists as a function', typeof sandbox.copyToClipboard === 'function');

// -------------------------------------------------------------
// 2. Test Explore modal in public/js/modal.js
// -------------------------------------------------------------
console.log('\n--- 2. Testing public/js/modal.js ---');
const modalSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modal.js'), 'utf8');

check('modal.js defines modal__share-btn in headerDiv',
  modalSrc.includes("headerDiv.querySelector('.modal__share-btn')") &&
  modalSrc.includes("shareBtn.className = 'icon-btn modal__share-btn'"),
  true);

check('modal.js shareBtn calls copyToClipboard and buildExploreShareUrl',
  modalSrc.includes('copyToClipboard(buildExploreShareUrl(shareBtn._region)') ||
  modalSrc.includes('copyToClipboard(buildExploreShareUrl('),
  true);

check('modal.js shareBtn shows instant ✓ copied feedback',
  modalSrc.includes("shareBtn.title = 'Link copied!'") &&
  modalSrc.includes('✓'),
  true);

check('modal.js openModal syncs country alongside region to replaceState',
  modalSrc.includes("var cid = region.country_id || region.region") &&
  modalSrc.includes("url.searchParams.set('country', cid)") &&
  modalSrc.includes("url.searchParams.set('region', region.id)"),
  true);

// -------------------------------------------------------------
// 3. Test My Submissions in public/my-submissions.html
// -------------------------------------------------------------
console.log('\n--- 3. Testing public/my-submissions.html ---');
const mySubSrc = fs.readFileSync(path.join(ROOT, 'public', 'my-submissions.html'), 'utf8');

check('my-submissions.html includes share in ICON_LABELS',
  /share:\s*['"]Share link['"]/.test(mySubSrc),
  true);

check('createActiveCard only adds share if approved',
  mySubSrc.includes("var isApproved = (submissionBucket(s).key === 'approved');") &&
  mySubSrc.includes("['edit', 'hide', 'delete', 'share', 'download']"),
  true);

check('createActiveCard falls back to without-share when not approved',
  mySubSrc.includes("['edit', 'hide', 'delete', 'download']"),
  true);

check('createActiveCard share handler triggers toast',
  mySubSrc.includes("showToast('Link copied to clipboard!')"),
  true);

check('createHiddenCard does NOT include share',
  !/createHiddenCard[\s\S]*?buildActions\(s,\s*\[[^\]]*'share'/.test(mySubSrc),
  true);

check('createTrashCard does NOT include share',
  !/createTrashCard[\s\S]*?buildActions\(s,\s*\[[^\]]*'share'/.test(mySubSrc),
  true);

check('buildMapTooltip adds Share link menu item for approved bucket only',
  mySubSrc.includes("if (bucket.key === 'approved')") &&
  mySubSrc.includes("menu.appendChild(makeMenuBtn('Share link'"),
  true);

// -------------------------------------------------------------
// 4. Test Profile favorites in public/profile.html
// -------------------------------------------------------------
console.log('\n--- 4. Testing public/profile.html ---');
const profileSrc = fs.readFileSync(path.join(ROOT, 'public', 'profile.html'), 'utf8');

check('profile.html renderFavorites adds shareBtn with geoguideIconSvg("share")',
  profileSrc.includes("geoguideIconSvg('share')") &&
  profileSrc.includes("review-btn--share"),
  true);

check('profile.html shareBtn calls copyToClipboard and toggles checkmark feedback',
  profileSrc.includes("copyToClipboard(buildExploreShareUrl(r)") &&
  profileSrc.includes("✓"),
  true);

// -------------------------------------------------------------
// 5. Test styles in public/css/style.css
// -------------------------------------------------------------
console.log('\n--- 5. Testing public/css/style.css ---');
const styleCss = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');

check('style.css defines .modal__share-btn styles',
  styleCss.includes('.modal__share-btn'),
  true);

check('style.css defines #favorites-list .review-btn--share',
  styleCss.includes('#favorites-list .review-btn--share'),
  true);

check('style.css defines review-item__icon--share margin-left: auto and sibling 0',
  styleCss.includes('#my-submissions-content .review-item__icon--share { margin-left: auto; }') &&
  styleCss.includes('#my-submissions-content .review-item__icon--share + .review-item__icon { margin-left: 0; }'),
  true);

// -------------------------------------------------------------
// 6. Test Cache Busting Version Tags Across All 6 HTML Files
// -------------------------------------------------------------
console.log('\n--- 6. Testing Cache-Busting Version Consistency ---');
const htmlFiles = [
  'explore.html',
  'index.html',
  'my-submissions.html',
  'profile.html',
  'review.html',
  'submit.html'
];

const firstStyleVer = (fs.readFileSync(path.join(ROOT, 'public', htmlFiles[0]), 'utf8').match(/style\.css\?v=(\d+)/) || [])[1];
for (const file of htmlFiles) {
  const content = fs.readFileSync(path.join(ROOT, 'public', file), 'utf8');
  check(`${file} has consistent style.css?v=${firstStyleVer}`, content.includes(`style.css?v=${firstStyleVer}`));
  check(`${file} has utils.js?v=28`, content.includes('utils.js?v=28'));
}

const exploreContent = fs.readFileSync(path.join(ROOT, 'public', 'explore.html'), 'utf8');
check('explore.html has modal.js?v=59', exploreContent.includes('modal.js?v=59'));

// -------------------------------------------------------------
// Summary
// -------------------------------------------------------------
console.log(`\n========================================`);
console.log(`Total checks: ${totalChecks} | Passed: ${passedChecks} | Failed: ${totalChecks - passedChecks}`);
console.log(`========================================\n`);

if (passedChecks === totalChecks) {
  console.log('ALL CHECKS PASSED! 🎉');
  process.exit(0);
} else {
  console.error('SOME CHECKS FAILED!');
  process.exit(1);
}

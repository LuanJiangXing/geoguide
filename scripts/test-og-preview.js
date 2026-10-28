#!/usr/bin/env node
/**
 * Test suite for the Open Graph / Discord Link Preview feature:
 * - api/_lib/og.js (helpers, flag emoji, markdown stripping, image resolution, HTML generation)
 * - api/submissions.js (action=og routing, zero new serverless functions)
 * - vercel.json (rewrite rules for Discordbot and other crawlers)
 * - public/explore.html & public/index.html (default OG meta tags)
 * - Verifies total Serverless Function count in api/ remains <= 12 (Vercel Hobby limit)
 *
 * Usage: node scripts/test-og-preview.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

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

console.log('\n=== 1. Testing Vercel Serverless Function Count Limit (<= 12) ===');
const apiFiles = fs.readdirSync(path.join(ROOT, 'api'))
  .filter(f => f.endsWith('.js') && !f.startsWith('_'));
check(`Serverless function count in api/ is ${apiFiles.length} (Limit: 12)`, apiFiles.length <= 12, apiFiles);
check('api/submissions.js exists in the list', apiFiles.includes('submissions.js'));

console.log('\n=== 2. Testing api/_lib/og.js Logic ===');
const og = require(path.join(ROOT, 'api', '_lib', 'og.js'));

// 2.0 formatOgTitle
check('formatOgTitle formats short name', og.formatOgTitle('Ontario Clues') === 'Ontario Clues | GeoGuide');
const longEn = og.formatOgTitle('Very long descriptive title explaining that utility poles in rural Manitoba have yellow ribbons and distinct transformers');
check('formatOgTitle truncates overly long English name to <= 65 chars', longEn.length <= 65 && longEn.includes('... | GeoGuide'), longEn);
const longZh = og.formatOgTitle('这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的点位名称用于测试超长标题截断逻辑');
check('formatOgTitle truncates overly long Chinese name to <= 65 chars', longZh.length <= 65 && longZh.includes('... | GeoGuide'), longZh);

// 2.1 stripMarkdown
const rawMd = '# Header 1\nThis is **bold** text and *italic* with a [link](https://example.com) and `code`.\n- Bullet 1\n- Bullet 2';
const stripped = og.stripMarkdown(rawMd, 100);
check('stripMarkdown removes markdown tokens', 
  !stripped.includes('#') && !stripped.includes('**') && !stripped.includes('[link]') && stripped.includes('link') && stripped.includes('bold'),
  stripped
);

// 2.2 resolveStreetViewImageUrl
const testPanoSv = { pano: 'test-pano-123', heading: 90, pitch: 10 };
const panoImg = og.resolveStreetViewImageUrl(testPanoSv, 'https://geoguide-gamma.vercel.app');
check('resolveStreetViewImageUrl with pano produces square Street View thumbnail with cb_client tactile',
  panoImg.includes('streetviewpixels-pa.googleapis.com/v1/thumbnail') &&
  panoImg.includes('panoid=test-pano-123') &&
  panoImg.includes('cb_client=maps_sv.tactile') &&
  panoImg.includes('w=600') &&
  panoImg.includes('h=600') &&
  panoImg.includes('yaw=90'),
  panoImg
);

const multiSv = [{ lat: 0, lng: 0 }, { pano_id: 'multi-pano-456', heading: 180 }];
const multiImg = og.resolveStreetViewImageUrl(multiSv, 'https://geoguide-gamma.vercel.app');
check('resolveStreetViewImageUrl finds pano in array of streetviews',
  multiImg.includes('panoid=multi-pano-456') && multiImg.includes('yaw=180'),
  multiImg
);

const linkPanoSv = { lat: 0, lng: 0 };
const rawLink = 'https://www.google.com/maps/@45.42,-75.69,3a,75y,90t/data=!3m7!1e1!3m5!1sRAW_PANO_TEST_789!2e0!6shttps!7i16384!8i8192';
const rawLinkImg = og.resolveStreetViewImageUrl(linkPanoSv, 'https://geoguide-gamma.vercel.app', rawLink);
check('resolveStreetViewImageUrl extracts pano from rawLink when sv has no pano',
  rawLinkImg.includes('panoid=RAW_PANO_TEST_789'),
  rawLinkImg
);

const emptySv = {};
const fallbackImg = og.resolveStreetViewImageUrl(emptySv, 'https://geoguide-gamma.vercel.app');
check('resolveStreetViewImageUrl fallback returns icon-512.png',
  fallbackImg === 'https://geoguide-gamma.vercel.app/images/icon-512.png',
  fallbackImg
);

// 2.3 renderOgHtml
const sampleHtml = og.renderOgHtml({
  title: 'Ontario Clues | GeoGuide',
  description: 'Explore more region-guessing META on GeoGuide.',
  imageUrl: 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=abc',
  canonicalUrl: 'https://geoguide-gamma.vercel.app/explore?country=canada&region=123',
  origin: 'https://geoguide-gamma.vercel.app',
  cardType: 'summary'
});

check('renderOgHtml outputs DOCTYPE and valid HTML structure', sampleHtml.startsWith('<!DOCTYPE html>'));
check('renderOgHtml contains og:site_name', sampleHtml.includes('<meta property="og:site_name" content="GeoGuide">'));
check('renderOgHtml contains og:title format: [Name] | GeoGuide (clean title)', 
  sampleHtml.includes('content="Ontario Clues | GeoGuide"') && !sampleHtml.includes('🌐')
);
check('renderOgHtml contains uniform META description', 
  sampleHtml.includes('<meta property="og:description" content="Explore more region-guessing META on GeoGuide.">')
);
check('renderOgHtml contains brand icon link tags', 
  sampleHtml.includes('href="https://geoguide-gamma.vercel.app/favicon.svg"') &&
  sampleHtml.includes('href="https://geoguide-gamma.vercel.app/images/icon-32.png"')
);
check('renderOgHtml contains twitter:card summary (balanced right thumbnail)', 
  sampleHtml.includes('<meta name="twitter:card" content="summary">')
);
check('renderOgHtml contains og:image 600x600 square dimensions',
  sampleHtml.includes('<meta property="og:image:width" content="600">') &&
  sampleHtml.includes('<meta property="og:image:height" content="600">')
);
check('renderOgHtml contains theme-color #4A7C59', sampleHtml.includes('<meta name="theme-color" content="#4A7C59">'));
check('renderOgHtml contains instant browser redirect', 
  sampleHtml.includes('<meta http-equiv="refresh"') && sampleHtml.includes('window.location.replace')
);

check('handleOgImage is exported and a function', typeof og.handleOgImage === 'function');

console.log('\n=== 3. Testing vercel.json Redirects & Rewrites ===');
const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
check('vercel.json contains redirects array (evaluated before static files)', Array.isArray(vercelConfig.redirects));

const exploreRedirect = (vercelConfig.redirects || []).find(r => r.source === '/explore');
check('/explore redirect rule exists for crawlers', !!exploreRedirect);
check('/explore redirect routes to /api/submissions?action=og', exploreRedirect && exploreRedirect.destination === '/api/submissions?action=og');
check('/explore redirect has Discordbot in user-agent condition',
  exploreRedirect && exploreRedirect.has && exploreRedirect.has.some(h => h.key === 'user-agent' && h.value.includes('Discordbot'))
);

check('vercel.json contains rewrites array', Array.isArray(vercelConfig.rewrites));
const shareRewrite = vercelConfig.rewrites.find(r => r.source === '/share');
check('/share direct rewrite exists', !!shareRewrite && shareRewrite.destination === '/api/submissions?action=og');

const imageRewrite = vercelConfig.rewrites.find(r => r.source && r.source.startsWith('/images/og/'));
check('/images/og/:path* rewrite exists for Street View proxy', !!imageRewrite);
check('/images/og rewrite maps to /api/submissions?action=image', imageRewrite && imageRewrite.destination.includes('action=image'));

console.log('\n=== 4. Testing HTML Meta Tags & Fallback Assets ===');
const exploreHtml = fs.readFileSync(path.join(ROOT, 'public', 'explore.html'), 'utf8');
check('explore.html contains og:site_name', exploreHtml.includes('<meta property="og:site_name" content="GeoGuide">'));
check('explore.html contains og:image', exploreHtml.includes('<meta property="og:image"'));
check('explore.html contains theme-color', exploreHtml.includes('<meta name="theme-color" content="#4A7C59">'));

const indexHtml = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
check('index.html contains og:site_name', indexHtml.includes('<meta property="og:site_name" content="GeoGuide">'));
check('index.html contains og:image', indexHtml.includes('<meta property="og:image"'));

const fallbackImgPath = path.join(ROOT, 'public', 'images', 'icon-512.png');
check('public/images/icon-512.png exists on disk', fs.existsSync(fallbackImgPath));
if (fs.existsSync(fallbackImgPath)) {
  const stat = fs.statSync(fallbackImgPath);
  check('icon-512.png size is non-empty (>10KB)', stat.size > 10240, `${stat.size} bytes`);
}
check('public/favicon.svg exists on disk', fs.existsSync(path.join(ROOT, 'public', 'favicon.svg')));
check('public/images/icon-192.png exists on disk', fs.existsSync(path.join(ROOT, 'public', 'images', 'icon-192.png')));

console.log('\n=== Summary ===');
console.log(`Passed: ${passedChecks} / ${totalChecks} checks.`);
if (passedChecks === totalChecks) {
  console.log('✓ All tests passed!\n');
  process.exit(0);
} else {
  console.error('✗ Some tests failed.\n');
  process.exit(1);
}

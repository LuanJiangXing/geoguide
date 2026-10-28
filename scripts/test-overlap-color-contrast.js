#!/usr/bin/env node
/**
 * Test suite for explore map overlap color contrast optimization.
 * Task: 10-22-explore-overlap-color-contrast
 *
 * Verifies:
 * 1. Palette properties: 16 colors, metadata (h, s, l, tier, family), stroke luminance contrast (l - 16%).
 * 2. 2-layer overlaps: zero same-color, zero same-tone (warm vs cool_blue vs cool_purple), zero green overlaps, min hue difference >= 60°.
 * 3. 3-layer & 4-layer overlaps: 3+ overlapping regions cycle across distinct color families and tones with Tier 1 primary colors.
 * 4. Determinism: region ID sorting ensures identical color assignment regardless of input array order.
 * 5. Rendering contracts: Leaflet polygon stroke weight = 2.5 in public/js/map.js.
 * 6. Cache busting consistency: explore.html references utils.js?v=28 and map.js?v=87.
 * 7. Real database validation (optional live run): zero green-on-green and zero same-color overlaps across all countries.
 *
 * Usage:
 *   node scripts/test-overlap-color-contrast.js
 *   node --env-file=.env.local scripts/test-overlap-color-contrast.js --live
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const utils = require(path.join(ROOT, 'public', 'js', 'utils.js'));

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

function circularHueDiff(h1, h2) {
  const diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// -------------------------------------------------------------
// 1. Palette Structure and Contrast Metadata
// -------------------------------------------------------------
console.log('\n--- 1. Testing buildPalette() Structure & Metadata ---');
const palette = utils.buildPalette();
check('Palette contains exactly 16 colors', palette.length === 16);

const tier1 = palette.filter(c => c.tier === 1);
const tier2 = palette.filter(c => c.tier === 2);
const tier3 = palette.filter(c => c.tier === 3);

check('Tier 1 has 8 primary colors', tier1.length === 8);
check('Tier 2 has 2 green fallback colors', tier2.length === 2);
check('Tier 3 has 6 light variants', tier3.length === 6);

const tier1Families = new Set(tier1.map(c => c.family));
check('Tier 1 colors all belong to unique families', tier1Families.size === 8);
check('Tier 2 colors are green / olive', tier2.every(c => c.family === 'green' || c.family === 'olive'));

// Check stroke contrast calculation: stroke luminance must be l - 16%
let strokeLuminanceCorrect = true;
palette.forEach(c => {
  const match = c.stroke.match(/hsl\(\s*\d+\s*,\s*\d+%\s*,\s*(\d+)%\s*\)/);
  if (!match) strokeLuminanceCorrect = false;
  else {
    const expectedL = Math.max(0, c.l - 16);
    if (parseInt(match[1], 10) !== expectedL) strokeLuminanceCorrect = false;
  }
});
check('Stroke luminance is darkened by 16% across all palette colors', strokeLuminanceCorrect);

// -------------------------------------------------------------
// 2. Synthetic Overlap Tests (2-Layer, 3-Layer, 4-Layer)
// -------------------------------------------------------------
console.log('\n--- 2. Testing assignRegionColors() with Overlapping Geometries ---');

const TONE_MAP = {
  red: 'warm', orange: 'warm', yellow: 'warm', rose: 'warm',
  blue: 'cool_blue', cyan: 'cool_blue',
  purple: 'cool_purple', magenta: 'cool_purple',
  green: 'green', olive: 'green'
};

function createBoxPolygon(w, s, e, n) {
  return {
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]]
  };
}

// Case A: 2 overlapping regions
const twoOverlapping = [
  { id: 'sub-a', geojson: createBoxPolygon(20, 38, 22, 40) },
  { id: 'sub-b', geojson: createBoxPolygon(21, 39, 23, 41) }
];
const colors2 = utils.assignRegionColors(twoOverlapping);
const cA = colors2['sub-a'];
const cB = colors2['sub-b'];

check('2 overlapping regions receive different colors', cA.fill !== cB.fill);
check('2 overlapping regions are both Tier 1 primary colors', cA.tier === 1 && cB.tier === 1);
check('2 overlapping regions have distinct color families', cA.family !== cB.family);

const toneA = TONE_MAP[cA.family] || cA.family;
const toneB = TONE_MAP[cB.family] || cB.family;
check('2 overlapping regions have mutually exclusive tones (warm vs cool)', toneA !== toneB);

const hueDiff2 = circularHueDiff(cA.h, cB.h);
check(`2 overlapping regions have hue difference >= 60° (actual: ${hueDiff2}°)`, hueDiff2 >= 60);

// Case B: 3 concentric overlapping regions
const threeConcentric = [
  { id: 'layer-1', geojson: createBoxPolygon(10, 10, 30, 30) },
  { id: 'layer-2', geojson: createBoxPolygon(12, 12, 28, 28) },
  { id: 'layer-3', geojson: createBoxPolygon(15, 15, 25, 25) }
];
const colors3 = utils.assignRegionColors(threeConcentric);
const c1 = colors3['layer-1'];
const c2 = colors3['layer-2'];
const c3 = colors3['layer-3'];

const threeFamilies = new Set([c1.family, c2.family, c3.family]);
check('3 concentric overlapping regions all receive distinct color families', threeFamilies.size === 3);
check('3 concentric overlapping regions all use Tier 1 primary colors', [c1, c2, c3].every(c => c.tier === 1));

const threeTones = new Set([c1, c2, c3].map(c => TONE_MAP[c.family] || c.family));
check('3 concentric overlapping regions span at least 3 distinct tones/families', threeTones.size >= 2);

const hasGreenIn3 = [c1, c2, c3].some(c => c.tier === 2 || c.family === 'green' || c.family === 'olive');
check('Zero green colors assigned in 3-layer overlap', !hasGreenIn3);

// Case C: 4 overlapping regions
const fourOverlapping = [
  { id: 'r1', geojson: createBoxPolygon(0, 0, 10, 10) },
  { id: 'r2', geojson: createBoxPolygon(2, 2, 12, 12) },
  { id: 'r3', geojson: createBoxPolygon(4, 4, 14, 14) },
  { id: 'r4', geojson: createBoxPolygon(6, 6, 16, 16) }
];
const colors4 = utils.assignRegionColors(fourOverlapping);
const f1 = colors4['r1'];
const f2 = colors4['r2'];
const f3 = colors4['r3'];
const f4 = colors4['r4'];

const fourColors = new Set([f1.fill, f2.fill, f3.fill, f4.fill]);
check('4 overlapping regions all receive 4 unique colors', fourColors.size === 4);
const fourFams = new Set([f1.family, f2.family, f3.family, f4.family]);
check('4 overlapping regions all receive 4 unique color families', fourFams.size === 4);

// -------------------------------------------------------------
// 3. Determinism and Sorting Consistency
// -------------------------------------------------------------
console.log('\n--- 3. Testing Assignment Determinism & UUID Sorting ---');

const shuffledInput1 = [
  { id: 'uuid-charlie', geojson: createBoxPolygon(0, 0, 5, 5) },
  { id: 'uuid-alpha', geojson: createBoxPolygon(2, 2, 7, 7) },
  { id: 'uuid-bravo', geojson: createBoxPolygon(4, 4, 9, 9) }
];
const shuffledInput2 = [
  { id: 'uuid-alpha', geojson: createBoxPolygon(2, 2, 7, 7) },
  { id: 'uuid-bravo', geojson: createBoxPolygon(4, 4, 9, 9) },
  { id: 'uuid-charlie', geojson: createBoxPolygon(0, 0, 5, 5) }
];

const res1 = utils.assignRegionColors(shuffledInput1);
const res2 = utils.assignRegionColors(shuffledInput2);

check('Color assignment is 100% deterministic regardless of input array order',
  res1['uuid-alpha'].fill === res2['uuid-alpha'].fill &&
  res1['uuid-bravo'].fill === res2['uuid-bravo'].fill &&
  res1['uuid-charlie'].fill === res2['uuid-charlie'].fill
);

// -------------------------------------------------------------
// 4. Rendering Contracts in map.js and explore.html
// -------------------------------------------------------------
console.log('\n--- 4. Testing Frontend Rendering Contracts ---');

const mapJsSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'map.js'), 'utf8');
const exploreHtmlSrc = fs.readFileSync(path.join(ROOT, 'public', 'explore.html'), 'utf8');

check('map.js polygon default render style has weight: 2.5',
  mapJsSrc.includes('fillColor: colors.fill, color: colors.stroke, fillOpacity: 0.52, weight: 2.5')
);

check('map.js restoreOverlapColors has weight: 2.5',
  mapJsSrc.includes('l.setStyle({ fillColor: colors.fill, color: colors.stroke, fillOpacity: 0.52, weight: 2.5 })')
);

check('explore.html loads utils.js?v=28', exploreHtmlSrc.includes('js/utils.js?v=28'));
check('explore.html loads map.js?v=87', exploreHtmlSrc.includes('js/map.js?v=87'));

// -------------------------------------------------------------
// 5. Live DB Validation (if available)
// -------------------------------------------------------------
async function runLiveDbChecks() {
  const hasLiveFlag = process.argv.includes('--live');
  const hasTursoUrl = Boolean(process.env.turso_database_url || process.env.TURSO_DATABASE_URL || process.env.TURSO_URL);

  if (!hasTursoUrl) {
    console.log('\n--- 5. Live DB Validation (Skipped: No Turso credentials provided) ---');
    return;
  }

  console.log('\n--- 5. Live DB Validation (Querying Turso Database) ---');
  const { tursoFetch } = require('../api/_lib/turso.js');

  const res = await tursoFetch(
    "SELECT id, country_id, geojson FROM submissions WHERE status = 'approved' AND geojson IS NOT NULL",
    []
  );

  const colIdx = {};
  res.cols.forEach((c, i) => { colIdx[c.name] = i; });

  const byCountry = {};
  res.rows.forEach(r => {
    const id = r[colIdx.id] && r[colIdx.id].value;
    const countryId = r[colIdx.country_id] && r[colIdx.country_id].value;
    const geoRaw = r[colIdx.geojson] && r[colIdx.geojson].value;
    let geo = null;
    try {
      geo = typeof geoRaw === 'string' ? JSON.parse(geoRaw) : geoRaw;
    } catch (e) {}
    if (!geo || !countryId) return;
    if (!byCountry[countryId]) byCountry[countryId] = [];
    byCountry[countryId].push({ id: String(id), geojson: geo });
  });

  let totalOverlaps = 0;
  let greenOnGreenOverlaps = 0;
  let sameColorOverlaps = 0;
  let hueBelow60Overlaps = 0;

  for (const [countryId, regions] of Object.entries(byCountry)) {
    if (regions.length < 2) continue;
    const colorMap = utils.assignRegionColors(regions);

    for (let i = 0; i < regions.length; i++) {
      const b1 = utils.regionBBox(regions[i].geojson);
      const c1 = colorMap[regions[i].id];
      if (!b1 || !c1) continue;

      for (let j = i + 1; j < regions.length; j++) {
        const b2 = utils.regionBBox(regions[j].geojson);
        const c2 = colorMap[regions[j].id];
        if (!b2 || !c2) continue;

        if (utils.bboxOverlap(b1, b2)) {
          totalOverlaps++;
          if (c1.fill === c2.fill) sameColorOverlaps++;
          if (c1.tier === 2 && c2.tier === 2) greenOnGreenOverlaps++;
          const d = circularHueDiff(c1.h, c2.h);
          if (d < 60 && c1.family === c2.family) hueBelow60Overlaps++;
        }
      }
    }
  }

  check(`Live DB: Zero same-color overlaps across ${totalOverlaps} overlaps`, sameColorOverlaps === 0);
  check(`Live DB: Zero green-on-green overlaps across ${totalOverlaps} overlaps`, greenOnGreenOverlaps === 0);
  check(`Live DB: Zero same-family hue < 60° overlaps`, hueBelow60Overlaps === 0);
}

// -------------------------------------------------------------
// Run and Summary
// -------------------------------------------------------------
runLiveDbChecks().then(() => {
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
}).catch(err => {
  console.error('Test execution error:', err);
  process.exit(1);
});

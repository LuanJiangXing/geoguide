#!/usr/bin/env node
/**
 * Build compact world boundaries JSON from Natural Earth 1:110m TopoJSON.
 *
 * Output: public/data/world-boundaries.json
 * Structure:
 * [
 *   {
 *     id: "south-africa",
 *     name: "South Africa",
 *     code: "za",
 *     bbox: [-34.82, 16.35, -22.09, 32.83], // [minLat, minLng, maxLat, maxLng]
 *     rings: [
 *       [ [-34.82, 19.99], ... ] // [lat, lng]
 *     ]
 *   },
 *   ...
 * ]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const srcPath = path.join(__dirname, 'data', 'countries-110m.json');
const prefillPath = path.join(__dirname, '..', 'public', 'data', 'country-prefill.json');
const outPath = path.join(__dirname, '..', 'public', 'data', 'world-boundaries.json');

const topoData = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
const prefill = JSON.parse(fs.readFileSync(prefillPath, 'utf8'));

const transform = topoData.transform;
const scale = transform.scale;
const translate = transform.translate;
const arcs = topoData.arcs;

function decodeArc(arcIdx) {
  var raw, pts = [], x = 0, y = 0;
  if (arcIdx < 0) {
    raw = arcs[~arcIdx];
    for (var i = 0; i < raw.length; i++) {
      x += raw[i][0];
      y += raw[i][1];
      pts.push([
        Math.round((y * scale[1] + translate[1]) * 100) / 100, // lat
        Math.round((x * scale[0] + translate[0]) * 100) / 100  // lng
      ]);
    }
    return pts.reverse();
  } else {
    raw = arcs[arcIdx];
    for (var j = 0; j < raw.length; j++) {
      x += raw[j][0];
      y += raw[j][1];
      pts.push([
        Math.round((y * scale[1] + translate[1]) * 100) / 100, // lat
        Math.round((x * scale[0] + translate[0]) * 100) / 100  // lng
      ]);
    }
    return pts;
  }
}

// Index prefill entries
const prefillByName = {};
for (var key in prefill) {
  if (key.charAt(0) === '_') continue;
  var entry = prefill[key];
  prefillByName[entry.name.toLowerCase()] = { id: key, name: entry.name, flag: entry.flag };
}

const ALIASES = {
  'United States of America': { id: 'united-states', name: 'United States', flag: 'us' },
  'Dem. Rep. Congo': { id: 'dr-congo', name: 'DR Congo', flag: 'cd' },
  'Dominican Rep.': { id: 'dominican-republic', name: 'Dominican Republic', flag: 'do' },
  'Falkland Is.': { id: 'falkland-islands', name: 'Falkland Islands', flag: 'fk' },
  'Fr. S. Antarctic Lands': { id: 'french-southern-and-antarctic-lands', name: 'French Southern and Antarctic Lands', flag: 'tf' },
  "Côte d'Ivoire": { id: 'ivory-coast', name: 'Ivory Coast', flag: 'ci' },
  'Central African Rep.': { id: 'central-african-republic', name: 'Central African Republic', flag: 'cf' },
  'Eq. Guinea': { id: 'equatorial-guinea', name: 'Equatorial Guinea', flag: 'gq' },
  'Turkey': { id: 'turkey', name: 'Turkey', flag: 'tr' },
  'Solomon Is.': { id: 'solomon-islands', name: 'Solomon Islands', flag: 'sb' },
  'Bosnia and Herz.': { id: 'bosnia-and-herzegovina', name: 'Bosnia and Herzegovina', flag: 'ba' },
  'Macedonia': { id: 'north-macedonia', name: 'North Macedonia', flag: 'mk' },
  'Kosovo': { id: 'kosovo', name: 'Kosovo', flag: 'xk' },
  'S. Sudan': { id: 'south-sudan', name: 'South Sudan', flag: 'ss' },
  'W. Sahara': { id: 'western-sahara', name: 'Western Sahara', flag: 'eh' },
  'Antarctica': { id: 'antarctica', name: 'Antarctica', flag: 'aq' },
  'N. Cyprus': { id: 'cyprus', name: 'Cyprus', flag: 'cy' },
  'Somaliland': { id: 'somalia', name: 'Somalia', flag: 'so' }
};

const geometries = topoData.objects.countries.geometries;
const output = [];

geometries.forEach(function(geom) {
  var rawName = geom.properties ? geom.properties.name : '';
  if (!rawName) return;

  var meta = ALIASES[rawName];
  if (!meta) {
    var slug = rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (prefill[slug]) {
      meta = { id: slug, name: prefill[slug].name, flag: prefill[slug].flag };
    } else if (prefillByName[rawName.toLowerCase()]) {
      meta = prefillByName[rawName.toLowerCase()];
    } else {
      meta = { id: slug, name: rawName, flag: '' };
    }
  }

  var rings = [];
  if (geom.type === 'Polygon') {
    (geom.arcs || []).forEach(function(arcList) {
      var ring = [];
      arcList.forEach(function(arcIdx) {
        var pts = decodeArc(arcIdx);
        // Avoid repeating first point when stitching consecutive arcs
        if (ring.length > 0 && pts.length > 0) {
          if (ring[ring.length - 1][0] === pts[0][0] && ring[ring.length - 1][1] === pts[0][1]) {
            pts = pts.slice(1);
          }
        }
        ring = ring.concat(pts);
      });
      if (ring.length >= 3) rings.push(ring);
    });
  } else if (geom.type === 'MultiPolygon') {
    (geom.arcs || []).forEach(function(poly) {
      poly.forEach(function(arcList) {
        var ring = [];
        arcList.forEach(function(arcIdx) {
          var pts = decodeArc(arcIdx);
          if (ring.length > 0 && pts.length > 0) {
            if (ring[ring.length - 1][0] === pts[0][0] && ring[ring.length - 1][1] === pts[0][1]) {
              pts = pts.slice(1);
            }
          }
          ring = ring.concat(pts);
        });
        if (ring.length >= 3) rings.push(ring);
      });
    });
  }

  var minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
  var totalPts = 0;
  rings.forEach(function(ring) {
    ring.forEach(function(p) {
      totalPts++;
      if (p[0] < minLat) minLat = p[0];
      if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLng) minLng = p[1];
      if (p[1] > maxLng) maxLng = p[1];
    });
  });

  if (totalPts === 0) return;

  output.push({
    id: meta.id,
    name: meta.name,
    code: meta.flag,
    bbox: [minLat, minLng, maxLat, maxLng],
    rings: rings
  });
});

// Sort alphabetically by name
output.sort(function(a, b) { return a.name.localeCompare(b.name); });

const jsonStr = JSON.stringify(output);
fs.writeFileSync(outPath, jsonStr, 'utf8');

const rawSize = Buffer.byteLength(jsonStr, 'utf8');
const gzSize = zlib.gzipSync(Buffer.from(jsonStr)).length;

console.log(`[OK] Generated ${outPath}`);
console.log(`     Countries: ${output.length}`);
console.log(`     Raw size: ${(rawSize / 1024).toFixed(1)} KB`);
console.log(`     Gzip size: ${(gzSize / 1024).toFixed(1)} KB`);

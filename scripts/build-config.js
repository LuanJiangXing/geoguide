/**
 * Vercel build script — 生成 js/config.js
 *
 * Static files live directly in public/ (the deploy directory).
 * This script generates the one dynamic file that needs build-time secrets:
 *   - js/config.js  (Google Maps API key)
 */
'use strict';

var fs = require('fs');
var path = require('path');

var root = path.join(__dirname, '..');
var pub = path.join(root, 'public');

// Ensure target directories exist
fs.mkdirSync(path.join(pub, 'js'), { recursive: true });

// 生成 js/config.js
var apiKey = process.env.GOOGLE_MAPS_API_KEY || '';
if (!apiKey) {
  console.warn('WARN: GOOGLE_MAPS_API_KEY environment variable is not set.');
  console.warn('      Generating js/config.js with empty key (OpenStreetMap will work; Street View will prompt for key).');
}

var configContent = '// Google Maps Embed API 配置（由 build 自动生成）\n'
  + 'window.__GEOCONFIG__ = {\n'
  + "  GOOGLE_MAPS_API_KEY: '" + apiKey.replace(/'/g, "\\'") + "'\n"
  + '};\n';

fs.writeFileSync(path.join(pub, 'js', 'config.js'), configContent, 'utf-8');
console.log('config.js generated successfully.');

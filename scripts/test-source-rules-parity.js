#!/usr/bin/env node
/**
 * Parity check for the two copies of the submission-source validation rules.
 *
 * `api/_lib/source.js` (server security boundary) and `public/js/utils.js`
 * (front-end instant feedback) each carry a SOURCE_RULES object. They cannot
 * share a module (different runtime), so the only way to prove they have not
 * drifted is to extract the four regex literals from both source files and
 * compare them string-for-string.
 *
 * Exit code 0 = identical, 1 = drifted or a copy is missing.
 *
 * Usage: node scripts/test-source-rules-parity.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER_FILE = path.join(ROOT, 'api', '_lib', 'source.js');
const CLIENT_FILE = path.join(ROOT, 'public', 'js', 'utils.js');

const TYPE_ORDER = ['plonkit', 'rmrg', 'geohints', 'other'];

function extractRules(file) {
  const src = fs.readFileSync(file, 'utf8');
  const block = src.match(/SOURCE_RULES\s*=\s*\{([\s\S]*?)\n\};?/);
  if (!block) {
    throw new Error('SOURCE_RULES block not found in ' + path.relative(ROOT, file));
  }
  const body = block[1];
  const rules = {};
  const lineRe = /^\s*([a-z]+)\s*:\s*(\/[^\n]*\/[a-z]*)\s*,?\s*$/gm;
  let m;
  while ((m = lineRe.exec(body)) !== null) {
    rules[m[1]] = m[2];
  }
  return rules;
}

function main() {
  let serverRules, clientRules;
  try {
    serverRules = extractRules(SERVER_FILE);
    clientRules = extractRules(CLIENT_FILE);
  } catch (e) {
    console.error('FAIL: ' + e.message);
    return 1;
  }

  let failed = false;

  // Every expected type must be present in both copies.
  for (const type of TYPE_ORDER) {
    if (serverRules[type] === undefined) { console.error('FAIL: server copy missing rule "' + type + '"'); failed = true; }
    if (clientRules[type] === undefined) { console.error('FAIL: client copy missing rule "' + type + '"'); failed = true; }
  }

  // Any extra keys are drift too.
  for (const type of Object.keys(serverRules)) {
    if (TYPE_ORDER.indexOf(type) === -1) { console.error('FAIL: unexpected rule "' + type + '" in server copy'); failed = true; }
  }
  for (const type of Object.keys(clientRules)) {
    if (TYPE_ORDER.indexOf(type) === -1) { console.error('FAIL: unexpected rule "' + type + '" in client copy'); failed = true; }
  }

  for (const type of TYPE_ORDER) {
    const a = serverRules[type];
    const b = clientRules[type];
    if (a === undefined || b === undefined) continue;
    if (a === b) {
      console.log('ok   ' + type.padEnd(9) + a);
    } else {
      console.error('FAIL ' + type + ' differs:');
      console.error('       server: ' + a);
      console.error('       client: ' + b);
      failed = true;
    }
  }

  if (failed) {
    console.error('\nSOURCE_RULES parity FAILED — sync api/_lib/source.js and public/js/utils.js');
    return 1;
  }
  console.log('\nSOURCE_RULES parity OK (4/4 rules identical)');
  return 0;
}

process.exit(main());

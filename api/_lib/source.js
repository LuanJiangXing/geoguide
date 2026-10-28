// Submission source attribution — single source of truth for the server-side
// validation of a submission's optional source (plonkit / rmrg / geohints / other).
//
// The frontend keeps a byte-for-byte copy of SOURCE_RULES in
// `public/js/utils.js` (different language, so the module cannot be shared).
// If you change a regex here you MUST change the twin there — the two copies
// are checked mechanically by `scripts/test-source-rules-parity.js`.
//
// Only the domain + non-empty path are validated, never the path content:
// `https://geohints.com/meta/bollards` and `https://geohints.com/anything`
// both pass by design (the reviewer is the final gate).

var SOURCE_RULES = {
  plonkit:  /^https:\/\/(www\.)?plonkit\.net\/\S+$/,
  rmrg:     /^https:\/\/(www\.)?rmrg\.me\/\S+$/,
  geohints: /^https:\/\/(www\.)?geohints\.com\/\S+$/,
  other:    /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/\S+$/i
};

// Accepted types, in display order. Kept in sync with the frontend chips.
var SOURCE_TYPES = ['plonkit', 'rmrg', 'geohints', 'other'];

// Max length of a source URL. Longer than the 180-char link cap because
// guide URLs (with path segments) are typically longer.
var MAX_SOURCE_URL_LENGTH = 300;

/**
 * Normalize a (type, url) pair to values that are safe to store.
 *
 * Always returns an object with both keys: `{ source_type, source_url }`.
 * Any inconsistent or invalid input collapses to `{ source_type: '', source_url: '' }`
 * (= "not attributed"), which is also what an omitted source produces.
 *
 * This is the security boundary for the `other` type: its host is not
 * whitelisted, so a `javascript:` URL posted directly to /api/submit must be
 * rejected here, before it can be rendered as an <a href>.
 *
 * @param {*} type  Raw source_type from an untrusted request body
 * @param {*} url   Raw source_url from an untrusted request body
 * @returns {{source_type: string, source_url: string}}
 */
function normalizeSource(type, url) {
  var t = (type == null) ? '' : String(type).trim();
  var u = (url == null) ? '' : String(url).trim();

  // Both empty (or absent) → not attributed.
  if (!t && !u) return { source_type: '', source_url: '' };

  // Only the two cases above survive: a lone type, a lone url, an unknown type,
  // an over-long url, or a url that fails its type's rule.
  if (SOURCE_TYPES.indexOf(t) === -1) return { source_type: '', source_url: '' };
  if (!u || u.length > MAX_SOURCE_URL_LENGTH) return { source_type: '', source_url: '' };
  if (!SOURCE_RULES[t].test(u)) return { source_type: '', source_url: '' };

  return { source_type: t, source_url: u };
}

module.exports = { SOURCE_RULES: SOURCE_RULES, SOURCE_TYPES: SOURCE_TYPES, MAX_SOURCE_URL_LENGTH: MAX_SOURCE_URL_LENGTH, normalizeSource: normalizeSource };

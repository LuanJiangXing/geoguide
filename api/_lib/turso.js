// Shared Turso HTTP API helpers for GeoGuide serverless functions
//
// Environment variables used:
//   TURSO_URL  or turso_database_url  — Turso database HTTP endpoint
//   TURSO_TOKEN or turso_auth_token   — Turso auth token

/**
 * Execute a SQL query against the Turso HTTP API.
 *
 * Maps JavaScript null / undefined to a Turso SQL NULL (not the string "null").
 * Objects (arrays, plain objects) are JSON-stringified so they can be stored in
 * TEXT columns and parsed back on read.
 *
 * @param {string} sql    SQL statement with ? placeholders
 * @param {Array}  [args] Positional parameter values
 * @returns {Promise<{cols: Array<{name: string}>, rows: Array<Array<{type: string, value: any}>>>}
 */
function tursoFetch(sql, args) {
  args = args || [];
  var url = (process.env.TURSO_URL || process.env.turso_database_url || '').replace('libsql://', 'https://');
  var token = process.env.TURSO_TOKEN || process.env.turso_auth_token || '';

  return fetch(url + '/v2/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      requests: [
        { type: 'execute', stmt: { sql: sql, args: args.map(function(v) {
          if (v === null || v === undefined) return { type: 'null' };
          if (typeof v === 'object') return { type: 'text', value: JSON.stringify(v) };
          if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
          return { type: 'text', value: String(v) };
        }) } },
        { type: 'close' },
      ],
    }),
  }).then(function(r) { return r.json(); }).then(function(data) {
    var pres = data.results && data.results[0];
    if (pres && pres.type === 'error') {
      throw new Error((pres.error && pres.error.message) || 'Pipeline error');
    }
    var resp = pres && pres.response;
    if (resp && resp.type === 'error') {
      throw new Error((resp.error && resp.error.message) || 'DB error');
    }
    if (!resp || resp.type !== 'execute') {
      throw new Error('Unexpected response: ' + JSON.stringify(data).slice(0, 200));
    }
    var result = resp.result || {};
    return { cols: result.cols || [], rows: result.rows || [] };
  });
}

/**
 * Execute multiple SQL statements in a single HTTP round-trip.
 * @param {Array<{sql: string, args?: Array}>} statements
 * @returns {Promise<Array<{cols: Array, rows: Array}>>}
 */
function tursoBatch(statements) {
  var url = (process.env.TURSO_URL || process.env.turso_database_url || '').replace('libsql://', 'https://');
  var token = process.env.TURSO_TOKEN || process.env.turso_auth_token || '';

  var requests = statements.map(function(st) {
    var args = st.args || [];
    return {
      type: 'execute',
      stmt: { sql: st.sql, args: args.map(function(v) {
        if (v === null || v === undefined) return { type: 'null' };
        if (typeof v === 'object') return { type: 'text', value: JSON.stringify(v) };
        if (typeof v === 'number' && Number.isInteger(v)) return { type: 'integer', value: String(v) };
        return { type: 'text', value: String(v) };
      }) }
    };
  });
  requests.push({ type: 'close' });

  return fetch(url + '/v2/pipeline', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ requests: requests }),
  }).then(function(r) { return r.json(); }).then(function(data) {
    var results = [];
    for (var i = 0; i < statements.length; i++) {
      var pres = data.results && data.results[i];
      if (pres && pres.type === 'error') {
        throw new Error((pres.error && pres.error.message) || 'Pipeline error at statement ' + i);
      }
      var resp = pres && pres.response;
      if (resp && resp.type === 'error') {
        throw new Error((resp.error && resp.error.message) || 'DB error at statement ' + i);
      }
      if (!resp || resp.type !== 'execute') {
        throw new Error('Unexpected response at statement ' + i + ': ' + JSON.stringify(data).slice(0, 200));
      }
      var result = resp.result || {};
      results.push({ cols: result.cols || [], rows: result.rows || [] });
    }
    return results;
  });
}

// --------------- schema bootstrap ---------------
// Single source of truth for all CREATE TABLE + migrations.
// Call once at the top of any API handler that touches the database.
// All statements are idempotent (IF NOT EXISTS / ALTER ... catch).
// Module-level flag skips the (now single) schema round-trip on warm
// invocations (Vercel reuses the same Node.js process across requests).
// On cold start: 1 HTTP call (batch of 36 statements). Previously: 1 HTTP call per statement.
var _schemaEnsured = false;
async function ensureSchema() {
  if (_schemaEnsured) return;
  // All 36 schema statements in a single HTTP round-trip.
  // Turso pipeline executes every statement regardless of individual errors,
  // so a failing ALTER TABLE (column already exists) doesn't stop the rest.
  try { await tursoBatch([
    // --- core tables ---
    { sql: "CREATE TABLE IF NOT EXISTS submissions (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, detailed_description TEXT, tags TEXT NOT NULL DEFAULT '[]', geojson TEXT NOT NULL DEFAULT '{}', streetview TEXT NOT NULL DEFAULT '{}', link TEXT NOT NULL DEFAULT '', country_id TEXT NOT NULL DEFAULT 'south-africa', status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT '', reviewed_at TEXT, source_type TEXT, source_url TEXT)" },
    { sql: "CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, parent_id TEXT, status TEXT NOT NULL DEFAULT 'approved', created_at TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS tag_categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0)" },
    { sql: "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, discord_id TEXT UNIQUE NOT NULL, username TEXT NOT NULL, avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, created_at TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS countries (id TEXT PRIMARY KEY, name TEXT NOT NULL, flag TEXT NOT NULL, bounds_sw TEXT NOT NULL, bounds_ne TEXT NOT NULL, active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0)" },
    { sql: "CREATE TABLE IF NOT EXISTS reactions (region_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, PRIMARY KEY (region_id, user_id, type))" },
    { sql: "CREATE TABLE IF NOT EXISTS favorites (region_id TEXT NOT NULL, user_id TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (region_id, user_id))" },
    { sql: "CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, created_at)" },
    { sql: "CREATE TABLE IF NOT EXISTS page_views (id INTEGER PRIMARY KEY AUTOINCREMENT, page TEXT NOT NULL, referer TEXT, user_agent TEXT, ip TEXT, user_id TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))" },
    { sql: "CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, action TEXT NOT NULL, target_user_id TEXT NOT NULL, performed_by TEXT NOT NULL, created_at TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS link_resolution_log (user_id TEXT NOT NULL, created_at TEXT NOT NULL)" },
    { sql: "CREATE TABLE IF NOT EXISTS admin_auth_attempts (user_id TEXT NOT NULL, created_at TEXT NOT NULL)" },
    // --- migrations (ALTER TABLE — fail silently if column already exists) ---
    { sql: "ALTER TABLE submissions ADD COLUMN country_id TEXT NOT NULL DEFAULT 'south-africa'" },
    { sql: "ALTER TABLE submissions ADD COLUMN user_id TEXT NOT NULL DEFAULT ''" },
    { sql: "ALTER TABLE submissions ADD COLUMN edit_target_id TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN reject_reason TEXT" },
    { sql: "ALTER TABLE tags ADD COLUMN parent_id TEXT" },
    { sql: "ALTER TABLE tags ADD COLUMN user_id TEXT" },
    { sql: "ALTER TABLE tags ADD COLUMN submission_id TEXT" },
    { sql: "ALTER TABLE users ADD COLUMN display_name TEXT" },
    { sql: "ALTER TABLE users ADD COLUMN status TEXT" },
    { sql: "ALTER TABLE users ADD COLUMN last_read_at TEXT" },
    { sql: "ALTER TABLE countries RENAME COLUMN available TO active" },
    { sql: "ALTER TABLE reactions ADD COLUMN created_at TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN is_deleted INTEGER DEFAULT 0" },
    { sql: "ALTER TABLE submissions ADD COLUMN deleted_at TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN is_hidden INTEGER DEFAULT 0" },
    { sql: "ALTER TABLE submissions ADD COLUMN edited_at TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN detailed_description TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN source_type TEXT" },
    { sql: "ALTER TABLE submissions ADD COLUMN source_url TEXT" },
    // 首次通过时间。与 reviewed_at（最后一次通过）不同：一条已通过的区域被 resubmit
    // 并再次通过时，它不会被刷新 —— 首页 "Recent Updates" 就按它排序。
    // 每个把 status 置为 'approved' 的写入点都必须带 `first_approved_at =
    // COALESCE(first_approved_at, ?)`（共 9 处，见 .trellis/spec/frontend/first-approved-order.md）。
    { sql: "ALTER TABLE submissions ADD COLUMN first_approved_at TEXT" },
    // 提交范围：'region'（默认，国家下属的具体小区域，需要绘制几何）
    //         | 'country'（整个国家/区域的 meta，不需要任何几何，geojson 存规范空数组 '[]'）。
    // **创建后不可更改** —— 所以只有 create INSERT 写这一列，其余所有 UPDATE 一律省略（省略即保留存储值）。
    // 值域与 country_proposals.proposal_type 共用同一套词汇。见 task 09-21 的 design.md §2.2。
    { sql: "ALTER TABLE submissions ADD COLUMN scope TEXT NOT NULL DEFAULT 'region'" },
    { sql: "CREATE TABLE IF NOT EXISTS country_proposals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, proposed_name TEXT NOT NULL, proposal_type TEXT NOT NULL CHECK(proposal_type IN ('country','region')), reason TEXT DEFAULT '', meta_intent TEXT NOT NULL DEFAULT 'unknown', created_at TEXT NOT NULL, UNIQUE(user_id, proposed_name))" },
    { sql: "ALTER TABLE country_proposals ADD COLUMN meta_intent TEXT NOT NULL DEFAULT 'unknown'" },
    { sql: "ALTER TABLE country_proposals ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'" },
    { sql: "CREATE TABLE IF NOT EXISTS country_notes (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, country_id TEXT NOT NULL, note TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, updated_at TEXT, UNIQUE(user_id, country_id))" },
  ]); _schemaEnsured = true; } catch(e) { console.error('ensureSchema pipeline failed:', e.message); /* retry on next request */ }
}

async function cleanupTrash() {
  try {
    await tursoFetch("DELETE FROM submissions WHERE is_deleted = 1 AND deleted_at < datetime('now', '-7 days')");
  } catch(e) { /* best-effort cleanup, never fail a request for this */ }
}

// --------------- shared utilities ---------------

function uuid() {
  return crypto.randomUUID();
}

function safeJson(str, fallback) {
  if (typeof str !== 'string' || !str) return fallback;
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

// Normalize streetview to array (backward compat: single object → [obj])
function normalizeStreetview(raw) {
  if (!raw) return [];
  var parsed = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch(e) { return []; }
  }
  if (Array.isArray(parsed)) return parsed.slice(0, 5);
  // Single object — wrap
  if (parsed && typeof parsed.lat === 'number') return [parsed];
  return [];
}

// Normalize link to array (backward compat: single string → [str])
function normalizeLink(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.slice(0, 5).map(String);
  if (typeof raw === 'string') {
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(0, 5).map(String);
    } catch(e) { /* plain string, fall through */ }
    return [raw];
  }
  return [];
}

async function sha256(message) {
  var data = new TextEncoder().encode(message);
  var hashBuffer = await crypto.subtle.digest('SHA-256', data);
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

// Shared admin gate — verifies both session + admin password in one call.
// Returns the user object if authenticated, null otherwise.
async function checkAdmin(req) {
  var user = await getSessionUser(req);
  if (!user || user.role !== 'admin' || !(await checkAdminPassword(req))) return null;
  return user;
}

// Shared rate-limit helper — checks how many actions a user performed recently.
// When `record` is true, this call is also recorded as a rate-limit event (for endpoints
// that don't naturally create timestamped rows, e.g. admin actions).
// Returns true if the limit is exceeded (client should get 429).
async function checkRateLimit(table, userColumn, userId, columnName, threshold, windowMinutes, record) {
  if (record) {
    try { await tursoFetch("CREATE TABLE IF NOT EXISTS " + table + " (" + userColumn + " TEXT NOT NULL, " + columnName + " TEXT NOT NULL)"); } catch(e) { /* ok */ }
    try {
      await tursoFetch("INSERT INTO " + table + " (" + userColumn + ", " + columnName + ") VALUES (?, ?)", [userId, new Date().toISOString()]);
    } catch(e) { /* table may still be creating; proceed with check */ }
  }
  var result = await tursoFetch(
    "SELECT COUNT(*) as cnt FROM " + table + " WHERE " + userColumn + " = ? AND " + columnName + " > strftime('%Y-%m-%dT%H:%M:%S', 'now', '-" + windowMinutes + " minutes')",
    [userId]
  );
  var count = parseInt((result.rows[0] && result.rows[0][0].value)) || 0;
  // With record: action already counted; block when count exceeds threshold
  // Without record: action not yet counted; block when count reaches threshold
  return record ? (count > threshold) : (count >= threshold);
}

// Admin password gate: admins must enter the admin_password (env) to access
// privileged endpoints. A hashed cookie is set so they don't re-enter every request.
async function checkAdminPassword(req) {
  var cookieHeader = req && req.headers && req.headers.cookie;
  var adminKey = getCookie(cookieHeader, 'geoguide_admin_key');
  var pw = process.env.admin_password;
  if (!pw || !adminKey) return false;
  var user = await getSessionUser(req);
  if (!user) return false;
  var expected = await sha256(pw + ':' + user.id);
  return adminKey === expected;
}

// Server-side resolution of Google Maps short links (no CORS restriction)

// Extract the Street View panorama ID from a Google Maps URL. Google encodes the
// specific panorama (including historical captures) as the `!1s` token in the
// `data=` segment, or as `panoid=` / `pano=` query params. Place URLs also use
// `!1s` (for their place ID), so only trust `!1s` on street-view URLs.
function extractPanoId(link) {
  if (!link) return null;
  var m = null;
  if (/,3a,/.test(link) || /!1e\d/.test(link)) {
    m = link.match(/!1s([^!]+)/);
  }
  if (!m) m = link.match(/[?&](?:panoid|pano)=([^&]+)/);
  if (!m || !m[1]) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

async function resolveStreetview(link) {
  // If already a full URL with coordinates, parse directly
  var cm = link.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (cm) {
    var hm = link.match(/([\d.]+)h/);
    var tm = link.match(/([\d.]+)t/);
    var ym = link.match(/([\d.]+)y/);
    var t = tm ? parseFloat(tm[1]) : 90;
    var pano = extractPanoId(link);
    return {
      lat: parseFloat(cm[1]), lng: parseFloat(cm[2]),
      heading: hm ? parseFloat(hm[1]) : 0,
      pitch: parseFloat((t - 90).toFixed(2)),
      fov: ym ? parseFloat(ym[1]) : 90,
      pano: pano || undefined
    };
  }
  // Short link: server-side redirect follow (only allow Google Maps domains)
  if (link.indexOf('goo.gl') > -1 || (link.indexOf('maps.app') > -1 && link.indexOf('maps.app.goo.gl') === -1)) {
    // Validate URL is a Google Maps short link
    if (link.indexOf('https://') !== 0 && link.indexOf('http://') !== 0) {
      return { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 };
    }
    try {
      var allowedHosts = ['goo.gl', 'maps.app.goo.gl', 'maps.google.com', 'www.google.com'];
      var linkUrl;
      try { linkUrl = new URL(link); } catch(e) { return { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 }; }
      var hostOk = false;
      for (var h = 0; h < allowedHosts.length; h++) {
        if (linkUrl.hostname === allowedHosts[h] || linkUrl.hostname.endsWith('.' + allowedHosts[h])) {
          hostOk = true; break;
        }
      }
      if (!hostOk) return { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 };
      var resp = await fetch(link, { method: 'GET', redirect: 'follow' });
      var finalUrl = resp.url || '';
      var m = finalUrl.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (m) {
        var hm2 = finalUrl.match(/([\d.]+)h/);
        var tm2 = finalUrl.match(/([\d.]+)t/);
        var ym2 = finalUrl.match(/([\d.]+)y/);
        var t2 = tm2 ? parseFloat(tm2[1]) : 90;
        var pano2 = extractPanoId(finalUrl);
        return {
          lat: parseFloat(m[1]), lng: parseFloat(m[2]),
          heading: hm2 ? parseFloat(hm2[1]) : 0,
          pitch: parseFloat((t2 - 90).toFixed(2)),
          fov: ym2 ? parseFloat(ym2[1]) : 90,
          pano: pano2 || undefined
        };
      }
    } catch(e) { /* resolution failed, return defaults */ }
  }
  return { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 };
}

// --------------- session helpers ---------------

function getCookie(cookies, name) {
  if (!cookies) return null;
  var match = cookies.match(new RegExp('(^|; )' + name + '=([^;]*)'));
  return match ? match[2] : null;
}

/**
 * Extract the authenticated user from the session cookie on a request.
 *
 * @param {object} request  The HTTP request object (reads request.headers.cookie)
 * @returns {Promise<object|null>}  User { id, discord_id, username, avatar_url, role } or null
 */
async function getSessionUser(request) {
  var cookieHeader = request && request.headers && request.headers.cookie;
  var sid = getCookie(cookieHeader, 'geoguide_sid');
  if (!sid) return null;
  try {
    var rows = await tursoFetch(
      "SELECT u.id, u.discord_id, u.username, u.avatar_url, u.role, u.display_name FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.id = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%S', 'now') AND (u.status IS NULL OR u.status != 'banned')",
      [sid]
    );
    if (rows.rows.length === 0) return null;
    var r = rows.rows[0];
    return {
      id: r[0].value,
      discord_id: r[1].value,
      username: r[2].value,
      avatar_url: r[3].value || null,
      role: r[4].value,
      display_name: (r[5] && r[5].value) || null,
    };
  } catch (e) {
    console.error('getSessionUser: session lookup failed:', e.message);
    return null;
  }
}

/**
 * CSRF protection — double-submit cookie pattern.
 * The client must send the value of the `geoguide_csrf` cookie as an `x-csrf-token` header.
 * An attacker on a different origin cannot read the cookie, so they cannot forge the header.
 */
function checkCsrf(request) {
  var cookieHeader = request && request.headers && request.headers.cookie;
  var cookieToken = getCookie(cookieHeader, 'geoguide_csrf');
  var headerToken = request && request.headers && request.headers['x-csrf-token'];
  if (!cookieToken || !headerToken) return false;
  return cookieToken === headerToken;
}

module.exports = { tursoFetch: tursoFetch, tursoBatch: tursoBatch, ensureSchema: ensureSchema, getSessionUser: getSessionUser, checkCsrf: checkCsrf, checkAdmin: checkAdmin, checkRateLimit: checkRateLimit, uuid: uuid, getCookie: getCookie, safeJson: safeJson, resolveStreetview: resolveStreetview, extractPanoId: extractPanoId, sha256: sha256, checkAdminPassword: checkAdminPassword, normalizeStreetview: normalizeStreetview, normalizeLink: normalizeLink, cleanupTrash: cleanupTrash };

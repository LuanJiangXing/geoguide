const { tursoFetch, ensureSchema, checkAdmin, checkRateLimit, getSessionUser } = require('./_lib/turso.js');

module.exports = async function handler(req, res) {
  // Stats endpoint — admin only
  if (req.method === 'GET' && req.query && req.query.action === 'stats') {
    return handleStats(req, res);
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    await ensureSchema();

    var page = (req.query && req.query.page) ? String(req.query.page).trim() : '/';
    if (req.body && req.body.page) page = String(req.body.page).trim();
    if (page.length > 200) page = page.substring(0, 200);

    // Gather visitor context from headers
    var referer = (req.headers.referer || req.headers.referrer || '').substring(0, 500) || null;
    var userAgent = (req.headers['user-agent'] || '').substring(0, 500) || null;
    var ip = (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || '').split(',')[0].trim() || null;
    if (ip && ip.length > 45) ip = null;

    // Rate limit by IP — 60 req/min per IP (well above normal browsing)
    if (ip && await checkRateLimit('rate_limit_pageviews', 'identifier', ip, 'created_at', 60, 1, true)) {
      return res.status(204).end();
    }

    // Try to get user_id from session (don't fail if not logged in)
    var userId = null;
    try {
      var user = await getSessionUser(req);
      if (user && user.id) userId = user.id;
    } catch(e) { /* anonymous */ }

    await tursoFetch(
      "INSERT INTO page_views (page, referer, user_agent, ip, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [page, referer, userAgent, ip, userId, new Date().toISOString()]
    );

    return res.status(204).end();
  } catch (e) {
    console.error('pageview error:', e.message);
    return res.status(204).end(); // silently fail — never block the page
  }
};

async function handleStats(req, res) {
  try {
    // Admin check
    var user = await checkAdmin(req);
    if (!user) {
      return res.status(401).json({ error: 'Admin access required' });
    }

    // Build date filter (relative — "7d", "30d", "90d", "all")
    var range = (req.query.range || '30d').trim();
    // Whitelist: reject unrecognized ranges
    if (range !== '7d' && range !== '30d' && range !== '90d' && range !== 'all') {
      return res.status(400).json({ error: 'Invalid range. Use 7d, 30d, 90d, or all.' });
    }
    var where = '';
    if (range === '7d') where = " WHERE created_at > datetime('now', '-7 days')";
    else if (range === '30d') where = " WHERE created_at > datetime('now', '-30 days')";
    else if (range === '90d') where = " WHERE created_at > datetime('now', '-90 days')";

    // 1. Daily views (for line chart)
    var dailyResult = await tursoFetch(
      "SELECT date(created_at) as d, COUNT(*) as cnt FROM page_views" + where + " GROUP BY d ORDER BY d",
      []
    );
    var daily = dailyResult.rows.map(function(row) {
      return { date: row[0].value, count: parseInt(row[1].value) || 0 };
    });

    // 2. Top pages
    var pagesResult = await tursoFetch(
      "SELECT page, COUNT(*) as cnt FROM page_views" + where + " GROUP BY page ORDER BY cnt DESC LIMIT 10",
      []
    );
    var topPages = pagesResult.rows.map(function(row) {
      return { page: row[0].value, count: parseInt(row[1].value) || 0 };
    });

    // 3. Device breakdown
    var deviceResult = await tursoFetch(
      "SELECT CASE WHEN user_agent LIKE '%Mobile%' OR user_agent LIKE '%Android%' THEN 'Mobile' WHEN user_agent LIKE '%Tablet%' OR user_agent LIKE '%iPad%' THEN 'Tablet' ELSE 'Desktop' END as device, COUNT(*) as cnt FROM page_views" + where + " GROUP BY device ORDER BY cnt DESC",
      []
    );
    var devices = {};
    deviceResult.rows.forEach(function(row) {
      devices[row[0].value.toLowerCase()] = parseInt(row[1].value) || 0;
    });

    // 4. Totals
    var totalResult = await tursoFetch("SELECT COUNT(*) as total FROM page_views" + where, []);
    var totalViews = parseInt((totalResult.rows[0] && totalResult.rows[0][0].value)) || 0;

    var ipResult = await tursoFetch("SELECT COUNT(DISTINCT ip) as cnt FROM page_views" + where, []);
    var uniqueIps = parseInt((ipResult.rows[0] && ipResult.rows[0][0].value)) || 0;

    // 5. Visitor summary (grouped by user)
    var visitorQuery = "SELECT COALESCE(u.display_name, u.username) as username, COUNT(*) as visits, MAX(pv.created_at) as last_visit, MIN(pv.created_at) as first_visit FROM page_views pv JOIN users u ON pv.user_id = u.id WHERE pv.user_id IS NOT NULL";
    if (range !== 'all') visitorQuery += " AND pv.created_at > datetime('now', '-" + range.replace('d','') + " days')";
    visitorQuery += " GROUP BY pv.user_id ORDER BY visits DESC LIMIT 50";
    var visitorResult = await tursoFetch(visitorQuery, []);
    var visitors = visitorResult.rows.map(function(row) {
      return {
        username: row[0].value,
        visits: parseInt(row[1].value) || 0,
        last_visit: row[2].value,
        first_visit: row[3].value
      };
    });

    // 6. Recent visitors (last 20)
    var recentResult = await tursoFetch(
      "SELECT page, referer, user_agent, ip, COALESCE((SELECT COALESCE(display_name, username) FROM users WHERE id = page_views.user_id), 'anonymous') as username, created_at FROM page_views ORDER BY created_at DESC LIMIT 20",
      []
    );
    var recent = recentResult.rows.map(function(row) {
      return {
        page: row[0].value,
        referer: row[1].value || null,
        user_agent: row[2].value || null,
        ip: row[3].value || null,
        username: row[4].value,
        created_at: row[5].value
      };
    });

    return res.status(200).json({
      range: range,
      daily_views: daily,
      top_pages: topPages,
      devices: devices,
      total_views: totalViews,
      unique_ips: uniqueIps,
      visitors: visitors,
      recent: recent
    });
  } catch (e) {
    console.error('pageview stats error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

const { tursoFetch, ensureSchema, tursoBatch, getSessionUser, checkCsrf, checkRateLimit, cleanupTrash } = require('./_lib/turso.js');

// Helper: parse reaction counts from GROUP BY rows.
// The zero-valued object must list EVERY type the API can return — a missing key
// is silent: the frontend reads `data[key] || 0`, so it looks fine while the
// count is permanently 0. Server twin of GEOGUIDE_REACTIONS in public/js/utils.js.
function parseCounts(rows) {
  var counts = { goat: 0, heart: 0, useful: 0, useless: 0, wrong: 0, error: 0 };
  (rows || []).forEach(function(row) {
    var t = row[0].value;
    counts[t] = Number(row[1].value) || 0;
  });
  return counts;
}

// Helper: parse the user's own reaction state from user rows.
// Six types are fully independent (no mutual exclusion), so this is a LIST, not
// a scalar — a user can hold any subset at once. Empty array when logged out.
function parseUserState(rows) {
  var userReactions = [];
  (rows || []).forEach(function(r) {
    var t = r[0] ? r[0].value : '';
    if (t && userReactions.indexOf(t) === -1) userReactions.push(t);
  });
  return { userReactions: userReactions };
}

// 六项 reaction 的规范列表 —— 与 parseCounts 的键、GEOGUIDE_REACTIONS（public/js/utils.js）、
// user-submissions.js 的 REACTION_COUNT_TYPES 是同一组值。收藏列表（D6）的 six-count
// 标量子查询也由它生成，绝不另抄一份。
var REACTION_TYPES = ['goat', 'heart', 'useful', 'useless', 'wrong', 'error'];

// 收藏列表用的 `<type>_count` 标量子查询片段 —— 每个 type 一段，逗号分隔（无尾逗号）。
function favoriteCountSubqueries() {
  return REACTION_TYPES.map(function(t) {
    return "(SELECT COUNT(*) FROM reactions r WHERE r.region_id = s.id AND r.type = '" + t + "') AS " + t + "_count";
  }).join(', ');
}

// Ensure table exists — runs once per cold start, skipped on warm invocations
var _reactionsTableReady = false;
var _reactionsCreatedAtReady = false;

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    // Trash cleanup is a maintenance DELETE — skip on GET to keep reads fast.
    if (req.method !== 'GET') await cleanupTrash();

    // Ensure created_at column exists — uses a fresh flag so it runs once
    // even on warm instances that were deployed before this migration existed
    if (!_reactionsCreatedAtReady) {
      _reactionsCreatedAtReady = true;
      try {
        await tursoFetch("ALTER TABLE reactions ADD COLUMN created_at TEXT");
      } catch(e) {
        if (e.message && e.message.indexOf('duplicate column') === -1 && e.message.indexOf('already exists') === -1) {
          console.error('reactions ALTER TABLE created_at failed:', e.message);
        }
      }
    }

    // GET — public
    if (req.method === 'GET') {
      // Top regions for the homepage carousel.
      //
      // 入场券从「useful >= 2」放宽到「goat / heart / useful 任一 >= 2」
      //（用户决定，2026-10-04）。原口径把「最有用的 meta」等同于「点赞最多的 meta」，
      // 而 goat（特别出彩）与 heart（感谢分享）同样是正向信号，够格上首页。
      // useless / wrong / error 三项永远不参与 —— 它们是「不够好」，不是「好」。
      if (req.query && req.query.action === 'top') {
        // 三个计数列与 HAVING、ORDER BY 全部由这一个数组生成 —— 抄第二份就会有
        // 一处漏改（列名对不上时报的是「no such column」，那时才发现）。
        var TOP_TYPES = ['goat', 'heart', 'useful'];
        var TOP_MIN = 2;
        var topCountExpr = function(t) {
          return "SUM(CASE WHEN r.type = '" + t + "' THEN 1 ELSE 0 END)";
        };
        // HAVING 里重复写聚合表达式、不吃结果别名：SQLite 对 HAVING 里的别名解析
        // 依版本而异，ORDER BY 用别名才是明确支持的。多打一遍换掉一个不确定行为。
        var topHaving = TOP_TYPES.map(function(t) {
          return topCountExpr(t) + ' >= ' + TOP_MIN;
        }).join(' OR ');
        var topResult = await tursoFetch(
          "SELECT r.region_id, s.name, s.country_id, " +
            TOP_TYPES.map(function(t) { return topCountExpr(t) + ' AS ' + t + '_count'; }).join(', ') +
          " FROM reactions r JOIN submissions s ON r.region_id = s.id" +
          " WHERE r.type IN ('" + TOP_TYPES.join("', '") + "')" +
          " AND s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0" +
          " GROUP BY r.region_id" +
          " HAVING " + topHaving +
          // 排序按三项之和：任一维度上受欢迎都能往前排，与「任一达标即可入场」同口径。
          " ORDER BY (" + TOP_TYPES.map(function(t) { return t + '_count'; }).join(' + ') + ") DESC" +
          " LIMIT 8",
          []
        );
        var topRegions = (topResult.rows || []).map(function(row) {
          return {
            region_id: row[0].value,
            name: row[1].value,
            country_id: row[2].value,
            // 列序跟着 TOP_TYPES：第 3 列起依次是 goat/heart/useful 的计数。
            goat_count: Number(row[3].value) || 0,
            heart_count: Number(row[4].value) || 0,
            useful_count: Number(row[5].value) || 0
          };
        });
        return res.status(200).json({ regions: topRegions });
      }

      // My favorites (private bookmark list) — login required
      if (req.query && req.query.action === 'favorites') {
        var favUser = await getSessionUser(req);
        if (!favUser) {
          return res.status(401).json({ error: 'Login required' });
        }
        // Rich payload so profile can render cards as full as my-submissions:
        // description, tags, country name, favorited-at date, reaction counts.
        var favResult = await tursoFetch(
          "SELECT s.id, s.name, s.country_id, s.description, s.tags, f.created_at AS favorited_at, c.name AS country_name, c.flag AS country_flag, "
          + favoriteCountSubqueries() + " "
          + "FROM favorites f JOIN submissions s ON s.id = f.region_id JOIN countries c ON c.id = s.country_id "
          + "WHERE f.user_id = ? AND s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0 ORDER BY f.created_at DESC",
          [favUser.id]
        );
        var favRegions = (favResult.rows || []).map(function(row) {
          var o = {};
          favResult.cols.forEach(function(col, i) {
            var cell = row[i];
            o[col.name] = (cell && cell.value != null) ? cell.value : '';
          });
          var tags = [];
          try {
            var parsed = JSON.parse(o.tags || '[]');
            if (Array.isArray(parsed)) tags = parsed;
          } catch (e) { /* leave tags empty */ }
          var favMapped = {
            id: o.id,
            name: o.name,
            country_id: o.country_id,
            country_name: o.country_name || o.country_id,
            country_flag: o.country_flag || '',
            description: o.description || '',
            tags: tags,
            favorited_at: o.favorited_at || ''
          };
          REACTION_TYPES.forEach(function(t) {
            favMapped[t + '_count'] = Number(o[t + '_count']) || 0;
          });
          return favMapped;
        });
        return res.status(200).json({ regions: favRegions });
      }

      // Counts for a specific region
      var regionId = req.query && req.query.region_id;
      if (!regionId) {
        return res.status(400).json({ error: 'Missing region_id' });
      }

      // Check user first so we can batch counts + user reaction into one round-trip
      var user = await getSessionUser(req);

      // Build batch: always fetch counts, optionally fetch user's reaction + favorite state
      var queries = [
        { sql: "SELECT type, COUNT(*) as cnt FROM reactions WHERE region_id = ? GROUP BY type", args: [regionId] }
      ];
      if (user) {
        queries.push({ sql: "SELECT type FROM reactions WHERE region_id = ? AND user_id = ?", args: [regionId, user.id] });
        queries.push({ sql: "SELECT 1 FROM favorites WHERE region_id = ? AND user_id = ?", args: [regionId, user.id] });
      }
      var results = await tursoBatch(queries);

      var counts = parseCounts(results[0].rows);
      var us = (user && results[1]) ? parseUserState(results[1].rows) : { userReactions: [] };
      var favorited = !!(user && results[2] && results[2].rows && results[2].rows.length);

      return res.status(200).json({
        goat: counts.goat,
        heart: counts.heart,
        useful: counts.useful,
        useless: counts.useless,
        wrong: counts.wrong,
        error: counts.error,
        user_reactions: us.userReactions,
        authenticated: !!user,
        favorited: favorited
      });
    }

    // POST — auth required, upsert reaction (or favorite a region)
    if (req.method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      var user = await getSessionUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Login required' });
      }

      // Favorite a region (bookmark) — separate rate budget from reactions
      if (req.body && req.body.action === 'favorite') {
        if (await checkRateLimit('fav_actions', 'user_id', user.id, 'created_at', 60, 10, true)) {
          return res.status(429).json({ error: 'Too many favorites. Slow down.' });
        }
        var favRegionId = String(req.body.region_id || '');
        if (!favRegionId) {
          return res.status(400).json({ error: 'Missing region_id' });
        }
        // Only approved, visible regions can be favorited (no drafts/trash)
        var visResult = await tursoFetch(
          "SELECT status, is_deleted, is_hidden FROM submissions WHERE id = ?",
          [favRegionId]
        );
        var visRow = visResult.rows && visResult.rows[0];
        if (!visRow) return res.status(404).json({ error: 'Region not found' });
        if (visRow[0].value !== 'approved' || Number(visRow[1].value) || Number(visRow[2].value)) {
          return res.status(400).json({ error: 'Only approved, visible regions can be favorited' });
        }
        // Idempotent: a repeat favorite keeps the earliest created_at
        var now = new Date().toISOString();
        await tursoFetch(
          "INSERT INTO favorites (region_id, user_id, created_at) VALUES (?, ?, ?) ON CONFLICT(region_id, user_id) DO NOTHING",
          [favRegionId, user.id, now]
        );
        return res.status(200).json({ ok: true, favorited: true });
      }

      // Rate limit: max 30 reactions per 10 minutes per user
      var rateWindow = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      var rateResult = await tursoFetch(
        "SELECT COUNT(*) as cnt FROM reactions WHERE user_id = ? AND created_at > ?",
        [user.id, rateWindow]
      );
      var recentReactions = Number((rateResult.rows[0] && rateResult.rows[0][0].value)) || 0;
      if (recentReactions >= 30) {
        return res.status(429).json({ error: 'Too many reactions. Please slow down.' });
      }

      var postBody = (req.body && typeof req.body === 'object') ? req.body : {};
      var regionId = postBody.region_id;
      var type = postBody.type;

      if (!regionId) {
        return res.status(400).json({ error: 'Missing region_id' });
      }
      if (REACTION_TYPES.indexOf(type) === -1) {
        return res.status(400).json({ error: 'Invalid type — must be goat, heart, useful, useless, wrong, or error' });
      }

      // No mutual exclusion: all six types are independent and can be held at
      // once (a repeat click on an already-active type just refreshes its row).

      // Upsert + fetch counts + user state in a single batch
      var now = new Date().toISOString();
      var batchResults = await tursoBatch([
        { sql: "INSERT OR REPLACE INTO reactions (region_id, user_id, type, created_at) VALUES (?, ?, ?, ?)", args: [regionId, user.id, type, now] },
        { sql: "SELECT type, COUNT(*) as cnt FROM reactions WHERE region_id = ? GROUP BY type", args: [regionId] },
        { sql: "SELECT type FROM reactions WHERE region_id = ? AND user_id = ?", args: [regionId, user.id] }
      ]);
      var counts = parseCounts(batchResults[1].rows);
      var us = parseUserState(batchResults[2].rows);

      return res.status(200).json({
        goat: counts.goat,
        heart: counts.heart,
        useful: counts.useful,
        useless: counts.useless,
        wrong: counts.wrong,
        error: counts.error,
        user_reactions: us.userReactions
      });
    }

    // DELETE — auth required, cancel reaction (or unfavorite a region)
    if (req.method === 'DELETE') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      var user = await getSessionUser(req);
      if (!user) {
        return res.status(401).json({ error: 'Login required' });
      }

      // Unfavorite a region (bookmark off) — idempotent
      if (req.body && req.body.action === 'favorite') {
        if (await checkRateLimit('fav_actions', 'user_id', user.id, 'created_at', 60, 10, true)) {
          return res.status(429).json({ error: 'Too many favorites. Slow down.' });
        }
        var unfavId = String(req.body.region_id || '');
        if (!unfavId) {
          return res.status(400).json({ error: 'Missing region_id' });
        }
        await tursoFetch("DELETE FROM favorites WHERE region_id = ? AND user_id = ?", [unfavId, user.id]);
        return res.status(200).json({ ok: true, favorited: false });
      }

      var regionId = (req.body && req.body.region_id) || (req.query && req.query.region_id);
      var delType = (req.body && req.body.type) || null;
      if (!regionId || !delType) {
        return res.status(400).json({ error: 'Missing region_id or type' });
      }

      // Delete the specific type + fetch counts + user state in a single batch
      var batchResults = await tursoBatch([
        { sql: "DELETE FROM reactions WHERE region_id = ? AND user_id = ? AND type = ?", args: [regionId, user.id, delType] },
        { sql: "SELECT type, COUNT(*) as cnt FROM reactions WHERE region_id = ? GROUP BY type", args: [regionId] },
        { sql: "SELECT type FROM reactions WHERE region_id = ? AND user_id = ?", args: [regionId, user.id] }
      ]);
      var counts = parseCounts(batchResults[1].rows);
      var us = parseUserState(batchResults[2].rows);

      return res.status(200).json({
        goat: counts.goat,
        heart: counts.heart,
        useful: counts.useful,
        useless: counts.useless,
        wrong: counts.wrong,
        error: counts.error,
        user_reactions: us.userReactions
      });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('reactions error:', e.message, e.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

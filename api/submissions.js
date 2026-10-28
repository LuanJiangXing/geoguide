const { tursoFetch, tursoBatch, ensureSchema, normalizeStreetview, normalizeLink, cleanupTrash } = require('./_lib/turso.js');
const { handleOgPreview, handleOgImage } = require('./_lib/og.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {

    await ensureSchema();
    // submissions.js is read-only; trash cleanup runs on write endpoints (countries/reactions).
    if (req.method !== 'GET') await cleanupTrash();

    // --- GET /api/submissions?action=image (Proxy Street View image for Discord embed) ---
    if (req.query && req.query.action === 'image') {
      return await handleOgImage(req, res);
    }

    // --- GET /api/submissions?action=og (Open Graph metadata for crawler unfurls) ---
    if (req.query && (req.query.action === 'og' || req.query.action === 'share')) {
      return await handleOgPreview(req, res);
    }

    // --- GET /api/submissions?action=contributors ---
    if (req.query && req.query.action === 'contributors') {
      var limit = parseInt(req.query.limit, 10);
      if (isNaN(limit) || limit < 0) limit = 5;
      var limitClause = limit === 0 ? '' : ' LIMIT ' + limit;

      var country = (req.query.country || '').trim();
      var countryFilter = country ? " AND s.country_id = ?" : "";
      var countryArgs = country ? [country] : [];

      var noteSelect = country ? ", MAX(cn.note) as note" : "";
      var noteJoin = country
        ? " LEFT JOIN country_notes cn ON cn.user_id = s.user_id AND cn.country_id = ? AND cn.status = 'approved'"
        : "";

      // 三条语句一次往返。此前是两次 tursoFetch（total + 列表），新增国家聚合若再用
      // tursoFetch 就是三次 —— 首页每次访问都要付这个钱。tursoBatch 的元素形状与
      // tursoFetch 的返回值完全一致（api/_lib/turso.js:62），下面的映射代码原样保留。
      var batched = await tursoBatch([
        // 1) 有账号的贡献者总数
        { sql: "SELECT COUNT(DISTINCT s.user_id) as total FROM submissions s INNER JOIN users u ON s.user_id = u.id WHERE s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0" + countryFilter,
          args: countryArgs },
        // 2) 列表（含 explore 面板需要的 note）
        { sql: "SELECT s.user_id, COALESCE(NULLIF(u.display_name,''), u.username) as username, u.avatar_url, COUNT(*) as cnt" + noteSelect +
               " FROM submissions s INNER JOIN users u ON s.user_id = u.id" + noteJoin +
               " WHERE s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0" + countryFilter +
               " GROUP BY s.user_id ORDER BY cnt DESC" + limitClause,
          args: noteJoin ? [country].concat(countryArgs) : countryArgs },
        // 3) 每个用户按国家分组的提交数。前端只取前三个，所以不用窗口函数 ——
        //    行数上界是"贡献者数 × 国家数"，SQLite 没有兼容性风险。
        //    第二排序键 country_id 是承重的：计数相同的国家顺序在 SQLite 里未定义，
        //    没有它同一个用户的国旗会在两次请求之间换位置。
        { sql: "SELECT s.user_id, s.country_id, COUNT(*) AS cnt" +
               " FROM submissions s INNER JOIN users u ON s.user_id = u.id" +
               " WHERE s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0" + countryFilter +
               " GROUP BY s.user_id, s.country_id ORDER BY s.user_id, cnt DESC, s.country_id ASC",
          args: countryArgs }
      ]);
      var totalResult = batched[0];
      var result = batched[1];
      var countryResult = batched[2];

      var total = totalResult.rows.length > 0 ? Number(totalResult.rows[0][0].value) || 0 : 0;

      // 前三个国家，SQL 已按 cnt DESC 排好，直接顺序截断即可。
      // 带 country 过滤时数组退化成 [<那个国家>]，这在这个视图里是正确的值。
      var byUser = {};
      (countryResult.rows || []).forEach(function(row) {
        var uid = (row[0] && row[0].value) || '';
        var cid = (row[1] && row[1].value) || '';
        if (!uid || !cid) return;
        var list = byUser[uid] || (byUser[uid] = []);
        if (list.length < 3) list.push(cid);
      });

      var contributors = (result.rows || []).map(function(row) {
        var uid = row[0].value || '';
        var c = {
          user_id: uid,
          username: (row[1] && row[1].value) || 'Unknown',
          avatar_url: (row[2] && row[2].value) || '',
          count: Number(row[3].value) || 0,
          countries: byUser[uid] || []
        };
        if (country) c.note = (row[4] && row[4].value) || null;
        return c;
      });

      return res.status(200).json({ contributors: contributors, total: total });
    }

    // --- GET /api/submissions (with optional ?country= / ?order=) ---
    // 两条排序子句写成并列常量，是为了让 scripts/test-submissions-order.js 能直接比字符串：
    // 不带参数时必须是改动前那一串，一个字都不能差。
    //
    // ?order=approved 是**首页专有**的：首页的 "Recent Updates" 要按区域的首次通过时间排，
    // 且一条已通过的区域被 resubmit 再次通过时不得回到顶部（故取 first_approved_at，
    // 而非会被刷新的 reviewed_at）。explore 不传这个参数 —— 它拿返回的数组喂
    // renderRegions()（多边形创建顺序），那条顺序不该被首页的需求牵动。
    var ORDER_CREATED = ' ORDER BY s.created_at DESC';
    var ORDER_APPROVED = " ORDER BY COALESCE(NULLIF(s.first_approved_at, ''), NULLIF(s.reviewed_at, ''), s.created_at) DESC";
    var orderClause = (req.query && req.query.order === 'approved') ? ORDER_APPROVED : ORDER_CREATED;

    // first_approved_at 追加在**末尾**，好让下面 row[0..13] 的映射原样不动。
    var result = await tursoFetch(
      "SELECT s.id, s.name, s.description, s.tags, s.geojson, s.streetview, s.link, s.country_id, s.created_at, s.user_id, COALESCE(NULLIF(u.display_name,''), u.username, '') as submitted_by, s.detailed_description, s.source_type, s.source_url, s.first_approved_at, s.scope FROM submissions s LEFT JOIN users u ON s.user_id = u.id WHERE s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0" + orderClause
    );

    var submissions = result.rows.map(function(row) {
      var id = row[0].value;
      var name = row[1].value;
      var description = row[2].value;
      var tagsRaw = row[3].value;
      var geojsonRaw = row[4].value;
      var streetviewRaw = row[5].value;
      var link = row[6].value;
      link = normalizeLink(link);
      var countryId = row[7].value;
      var createdAt = row[8] ? row[8].value : '';
      var userId = row[9] ? row[9].value : '';
      var submittedBy = row[10] ? row[10].value : '';
      var detailedDescription = row[11] ? row[11].value : '';
      var sourceType = row[12] ? row[12].value : '';
      var sourceUrl = row[13] ? row[13].value : '';
      var firstApprovedAt = row[14] ? row[14].value : '';
      // 追加在 SELECT 末尾 —— 位置性读法，插在中间会静默错位。
      var scope = row[15] ? row[15].value : '';

      // Parse JSON text fields
      var tags = [];
      try { tags = JSON.parse(tagsRaw || '[]'); } catch(e) { tags = []; }
      if (!Array.isArray(tags)) tags = [];

      var geojson = {};
      try { geojson = JSON.parse(geojsonRaw || '{}'); } catch(e) { geojson = {}; }

      var streetview = {};
      try { streetview = JSON.parse(streetviewRaw || '{}'); } catch(e) { streetview = {}; }
      streetview = normalizeStreetview(streetview);

      return {
        id: id,
        name: name,
        description: description,
        detailed_description: detailedDescription || '',
        source_type: sourceType || '',
        source_url: sourceUrl || '',
        tags: tags,
        geojson: geojson,
        streetview: streetview,
        link: link,
        region: countryId || 'south-africa',
        created_at: createdAt || '',
        // 首次通过时间。老行（回填脚本跑之前）可能是空的，消费方要自己兜底。
        first_approved_at: firstApprovedAt || '',
        // 'region'（默认）| 'country'。缺失/老行一律兜底成 'region'。
        scope: scope || 'region',
        user_id: userId || '',
        submitted_by: submittedBy || ''
      };
    });

    return res.status(200).json(submissions);
  } catch(e) {
    console.error('submissions error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

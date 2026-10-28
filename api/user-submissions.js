const { tursoFetch, ensureSchema, getSessionUser, checkCsrf, checkRateLimit, safeJson, normalizeStreetview, normalizeLink, cleanupTrash } = require('./_lib/turso.js');

// Ensure last_read_at column exists (cold-start migration)
var _userSubmissionsReady = false;
var _reactionsCreatedAtReady = false;

// 从窗口函数 COUNT(*) OVER() 结果里读取 total；无该列时回退为行数
function totalFromRows(cols, rows) {
  if (!rows || !rows.length) return 0;
  var idx = cols.findIndex(function(c) { return c.name === 'total'; });
  if (idx < 0) return rows.length;
  var v = rows[0][idx];
  return (v && v.value != null) ? (Number(v.value) || 0) : 0;
}

// 把用户搜索词转成 LIKE 模式，转义 % _ \ 为字面量
function likePattern(q) {
  return '%' + q.replace(/[\\%_]/g, '\\$&') + '%';
}

// 投稿人侧要展示的六项 reaction 计数。**SELECT 的 CASE 与 LEFT JOIN 的 IN 必须覆盖
// 同一组 type** —— IN 漏掉的 type 会被 JOIN 挡掉、计数恒为 0，而且不报错（design §7）。
// 三处列表（default / hidden / trash）共用下面两个生成器，绝不复制三份 SQL：
// 本仓库在 SOURCE_RULES、OSM 瓦片 URL 上已经因复制栽过。
// SERVER TWIN: public/js/utils.js 的 GEOGUIDE_REACTIONS。
var REACTION_COUNT_TYPES = ['goat', 'heart', 'useful', 'useless', 'wrong', 'error'];

// `SELECT s.*,` 之后追加的六个计数列（`<type>_count`）
function reactionCountSelect() {
  return REACTION_COUNT_TYPES.map(function(t) {
    return " COALESCE(SUM(CASE WHEN r.type = '" + t + "' THEN 1 ELSE 0 END), 0) as " + t + "_count,";
  }).join('');
}

// `LEFT JOIN reactions r ON s.id = r.region_id` 之后追加的 type 过滤 —— 与
// reactionCountSelect() 同一组值。
function reactionJoinFilter() {
  return " AND r.type IN ('" + REACTION_COUNT_TYPES.join("', '") + "')";
}

// 把查询行上的六个 `<type>_count` 映射成 API 字段（与 reactionCountSelect 的列名对齐）。
// 四个 mapper（mapSubmissionRow + hidden/trash 的两段内联）共用，避免字段名复制四份。
function reactionCountsFrom(obj) {
  var out = {};
  REACTION_COUNT_TYPES.forEach(function(t) {
    out[t + '_count'] = Number(obj[t + '_count']) || 0;
  });
  return out;
}

// 把一行 submissions 查询结果映射成 API 返回对象（与默认列表分支保持一致）
function mapSubmissionRow(cols, row) {
  var obj = {};
  cols.forEach(function(c, i) {
    if (c.name === 'total') return;
    var cell = row[i];
    obj[c.name] = (cell && cell.value != null) ? cell.value : '';
  });
  var mapped = {
    id: obj.id,
    name: obj.name,
    description: obj.description,
    detailed_description: obj.detailed_description || '',
    source_type: obj.source_type || '',
    source_url: obj.source_url || '',
    country_id: obj.country_id || 'south-africa',
    // 'region'（默认）| 'country'。老行没有该列值一律兜底成 'region'。
    scope: obj.scope || 'region',
    tags: safeJson(obj.tags, []),
    geojson: safeJson(obj.geojson, { type: 'Polygon', coordinates: [] }),
    streetview: normalizeStreetview(safeJson(obj.streetview, {})),
    link: normalizeLink(obj.link),
    status: obj.status,
    created_at: obj.created_at,
    reviewed_at: obj.reviewed_at,
    reject_reason: obj.reject_reason || '',
    is_hidden: Number(obj.is_hidden) || 0,
    user_id: obj.user_id,
    edit_target_id: obj.edit_target_id || null
  };
  Object.assign(mapped, reactionCountsFrom(obj));
  return mapped;
}

// Turso 的每个 cell 是 {value} 包装。既有那几个 mapper 把 NULL 一律塌成 ''，
// 备份要能区分「列存在且为 NULL」和「列缺失」，所以这里保留 null。
function unboxRow(cols, row) {
  var obj = {};
  cols.forEach(function(c, i) {
    if (c.name === 'total') return;
    var cell = row[i];
    obj[c.name] = (cell && cell.value != null) ? cell.value : null;
  });
  return obj;
}

// 一条提交的几何。**两种导出格式的唯一来源**（见 buildExportSubmission 上方的说明）：
// 完整导出的 `submission.geojson` 与 `format=geojson` 简易下载返回的是同一个值，
// 兜底形状也只在这一处。
function exportGeometry(row) {
  return safeJson(row.geojson, { type: 'Polygon', coordinates: [] });
}

// 导出文件的 13 键契约。**显式列全，不要用 { ...row } 展开** —— 展开会让键集
// 随 schema 漂移，而这份键集是发布到用户硬盘上的格式，必须自己说了算。
//
// 只留「提交内容 + 地理位置 + 出处」。2026-10-01 用户明确要求去掉内部记账字段：
// 点赞数、is_hidden、user_id、以及 status/reject_reason/审核时间戳等审核态。
// is_deleted / deleted_at 顺带一并去掉 —— 它们对可导出的行恒为 0/null（Trash 不可
// 下载），留着等于两个常量。
// 详见 .trellis/spec/frontend/submission-export.md。
//
// `geojson` 那一项走 exportGeometry()，不在这里内联兜底 —— 简易下载（format=geojson）
// 出的就是同一个值，两个投影点各写一份 fallback 迟早会漂移（SOURCE_RULES 与 OSM 瓦片
// URL 两个前车之鉴）。契约是「简易版 = 完整版里 geojson 字段原样」，所以只有一个来源。
function buildExportSubmission(row) {
  return {
    // --- 内容 ---
    name: row.name,
    description: row.description,
    detailed_description: row.detailed_description || '',
    tags: safeJson(row.tags, []),          // 存的就是标签名本身，不是 id
    // --- 地理位置 ---
    geojson: exportGeometry(row),
    streetview: normalizeStreetview(safeJson(row.streetview, {})),
    country_id: row.country_id || 'south-africa',
    // 'region'（默认）| 'country'。老行没有该列值一律兜底成 'region'。
    scope: row.scope || 'region',
    // --- 出处 ---
    link: normalizeLink(row.link),
    source_type: row.source_type || '',
    source_url: row.source_url || '',
    // --- 元信息 ---
    created_at: row.created_at || '',
    // 非 null 表示「这是对某条的编辑草稿」。注意导出里没有 id，所以它是个**悬空引用** ——
    // 用户要的是「草稿 / 独立提交」这个信号，不是那个可解析的指向。
    edit_target_id: row.edit_target_id || null
  };
}

module.exports = async function handler(req, res) {
  try {
    if (!_reactionsCreatedAtReady) {
      _reactionsCreatedAtReady = true;
      try { await tursoFetch("ALTER TABLE reactions ADD COLUMN created_at TEXT"); } catch(e) { /* already exists */ }
    }

    if (!_userSubmissionsReady) {
      _userSubmissionsReady = true;
      await ensureSchema();
      try { await cleanupTrash(); } catch(e) { /* ok */ }
      try { await tursoFetch("CREATE INDEX IF NOT EXISTS idx_reactions_region_type ON reactions(region_id, type)"); } catch(e) { /* ok */ }
      try { await tursoFetch("CREATE INDEX IF NOT EXISTS idx_submissions_user_status ON submissions(user_id, status, created_at)"); } catch(e) { /* ok */ }
    }

    // Authenticate user via session cookie
    var user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }

    // --- GET: list submissions or notifications ---
    if (req.method === 'GET') {
      // Notifications: return unread count and recent events
      if (req.query && req.query.action === 'notifications') {
        // Get user's last_read_at
        var userResult = await tursoFetch(
          "SELECT last_read_at FROM users WHERE id = ?",
          [user.id]
        );
        var lastReadAt = (userResult.rows[0] && userResult.rows[0][0] && userResult.rows[0][0].value) || null;

        var items = [];

        if (lastReadAt) {
          // 1. Status changes: submissions owned by user, reviewed after last_read_at
          var statusResult = await tursoFetch(
            "SELECT id, name, status, reviewed_at FROM submissions WHERE user_id = ? AND reviewed_at > ? AND status IN ('approved', 'rejected') ORDER BY reviewed_at DESC LIMIT 20",
            [user.id, lastReadAt]
          );
          (statusResult.rows || []).forEach(function(row) {
            items.push({
              type: 'status_change',
              submission_id: row[0].value,
              submission_name: row[1].value,
              detail: row[2].value,
              created_at: row[3].value
            });
          });

          // 2. Edits: submitted items where admin edited after last_read_at
          //    Only catches edits that happened AFTER the last review (pure edits, not first approval)
          var editResult = await tursoFetch(
            "SELECT id, name, status, edited_at FROM submissions WHERE user_id = ? AND edited_at > ? AND edited_at > COALESCE(reviewed_at, '1970-01-01') AND status = 'approved' ORDER BY edited_at DESC LIMIT 20",
            [user.id, lastReadAt]
          );
          (editResult.rows || []).forEach(function(row) {
            items.push({
              type: 'edited',
              submission_id: row[0].value,
              submission_name: row[1].value,
              detail: row[2].value,
              created_at: row[3].value
            });
          });

          // 3. Reactions on user's submissions, created after last_read_at
          //    goat / heart 也在这里（D7）：用户选 D6 的意图是「让感谢抵达投稿人」，
          //    活动流是投稿人主动看到反馈的另一个面 —— 只改卡片等于少一半。
          //    error 维持排除：它是「报告故障」不是「反馈」（现状即有据）。
          var reactionResult = await tursoFetch(
            "SELECT r.region_id, s.name, r.type, r.created_at FROM reactions r JOIN submissions s ON r.region_id = s.id WHERE s.user_id = ? AND r.created_at > ? AND r.type IN ('goat', 'heart', 'useful', 'useless', 'wrong') ORDER BY r.created_at DESC LIMIT 20",
            [user.id, lastReadAt]
          );
          (reactionResult.rows || []).forEach(function(row) {
            items.push({
              type: 'reaction',
              submission_id: row[0].value,
              submission_name: row[1].value,
              detail: row[2].value,
              created_at: row[3].value
            });
          });
        }

        // Merge and sort by created_at DESC
        items.sort(function(a, b) {
          if (a.created_at > b.created_at) return -1;
          if (a.created_at < b.created_at) return 1;
          return 0;
        });
        var unreadCount = items.length;
        items = items.slice(0, 20);

        return res.status(200).json({ unread: unreadCount, items: items });
      }

      // My country/region proposals
      if (req.query && req.query.action === 'my-proposals') {
        var propResult = await tursoFetch(
          "SELECT proposed_name, proposal_type, reason, created_at FROM country_proposals WHERE user_id = ? ORDER BY created_at DESC",
          [user.id]
        );
        var proposals = (propResult.rows || []).map(function(row) {
          return {
            proposed_name: row[0].value,
            proposal_type: row[1].value,
            reason: (row[2] && row[2].value) || '',
            created_at: row[3].value
          };
        });
        return res.status(200).json({ proposals: proposals });
      }

      // Check ownership: returns { is_owner: true/false } for a single submission
      if (req.query && req.query.action === 'check-owner') {
        var checkId = req.query.id || '';
        if (!checkId) {
          return res.status(400).json({ error: 'Missing submission id' });
        }
        var ownerResult = await tursoFetch(
          "SELECT user_id FROM submissions WHERE id = ?",
          [checkId]
        );
        var isOwner = !!(ownerResult.rows[0] && ownerResult.rows[0][0] && ownerResult.rows[0][0].value === user.id);
        return res.status(200).json({ is_owner: isOwner });
      }

      // Distinct countries for the current tab (drives the country filter dropdown)
      if (req.query && req.query.action === 'countries') {
        var cStatus = (req.query && req.query.status) ? String(req.query.status) : '';
        if (cStatus === 'all') cStatus = '';
        var cWhere = " WHERE s.user_id = ?";
        var cArgs = [user.id];
        if (cStatus === 'hidden') {
          cWhere += " AND s.is_hidden = 1 AND s.is_deleted = 0";
        } else if (cStatus === 'trash') {
          cWhere += " AND s.is_deleted = 1";
        } else {
          cWhere += " AND s.is_deleted = 0 AND s.is_hidden = 0";
          if (cStatus) { cWhere += " AND s.status = ?"; cArgs.push(cStatus); }
        }
        var cResult = await tursoFetch(
          "SELECT DISTINCT s.country_id FROM submissions s" + cWhere + " ORDER BY s.country_id",
          cArgs
        );
        var countries = (cResult.rows || []).map(function(r) { return r[0].value; });
        return res.status(200).json({ countries: countries });
      }

      // Map view: all of the user's submissions (no status/visibility filter, no pagination).
      // Exclude edit-draft rows (edit_target_id IS NOT NULL) — a draft is a pending
      // modification of an already-shown original, and its identical geometry would
      // otherwise stack on top of the original on the map.
      // Safety clamp: cap at 200 most-recent to bound the response body (each row carries
      // full geojson) under Vercel's ~4.5MB serverless response limit.
      if (req.query && req.query.action === 'map') {
        var mapResult = await tursoFetch(
          "SELECT id, name, status, country_id, is_hidden, is_deleted, geojson, scope FROM submissions WHERE user_id = ? AND edit_target_id IS NULL ORDER BY created_at DESC LIMIT 200",
          [user.id]
        );
        var mapCols = mapResult.cols;
        var mapRows = mapResult.rows || [];
        var mapSubmissions = mapRows.map(function(row) {
          var obj = {};
          mapCols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return {
            id: obj.id,
            name: obj.name,
            status: obj.status,
            country_id: obj.country_id || 'south-africa',
            scope: obj.scope || 'region',
            is_hidden: Number(obj.is_hidden) || 0,
            is_deleted: Number(obj.is_deleted) || 0,
            geojson: safeJson(obj.geojson, null)
          };
        });
        return res.status(200).json({ submissions: mapSubmissions });
      }

      // Single submission for edit prefill. Returns the target even when hidden
      // (editing is allowed from the hidden list) but excludes soft-deleted
      // items. Also returns any draft rows targeting it so an in-progress
      // modification draft can be resumed instead of creating a duplicate.
      if (req.query && req.query.action === 'single') {
        var singleId = (req.query && req.query.id) ? String(req.query.id) : '';
        if (!singleId) {
          return res.status(400).json({ error: 'Missing submission id' });
        }

        var singleResult = await tursoFetch(
          "SELECT * FROM submissions WHERE id = ? AND user_id = ? AND is_deleted = 0",
          [singleId, user.id]
        );
        var singleRows = singleResult.rows || [];
        if (!singleRows[0]) {
          return res.status(404).json({ error: 'Submission not found' });
        }
        var submission = mapSubmissionRow(singleResult.cols, singleRows[0]);

        var draftResult = await tursoFetch(
          "SELECT * FROM submissions WHERE edit_target_id = ? AND user_id = ? AND is_deleted = 0 ORDER BY created_at DESC",
          [singleId, user.id]
        );
        var drafts = (draftResult.rows || []).map(function(row) {
          return mapSubmissionRow(draftResult.cols, row);
        });

        return res.status(200).json({ submission: submission, drafts: drafts });
      }

      // Export: one submission, two projections.
      // SQL is intentionally identical to `single` above — `is_deleted = 0` is the
      // contract (Trash is not downloadable). They differ only in projection:
      // `single` returns the lossy mapSubmissionRow, this returns the frozen export
      // shape. Kept separate so the edit flow's contract can evolve independently
      // of a format users already have on disk.
      //
      // `format` (2026-10-02):
      //   'full'（默认，也接受省略）→ 13 键信封，见 buildExportSubmission。
      //   'geojson'                 → **裸 geometry**，供 QGIS / geojson.io 直接吃。
      //   两者**共用同一段 SQL 与同一套 404 语义** —— 只有投影不同，鉴权与
      //   「Trash 不可下载」在这条分支上只有一份实现。
      if (req.query && req.query.action === 'export') {
        var exportId = (req.query && req.query.id) ? String(req.query.id) : '';
        if (!exportId) {
          return res.status(400).json({ error: 'Missing submission id' });
        }
        // 未知 format 直接拒，不静默回落成 full —— 回落会让拼错的调用方拿到一个
        // 「看着能解析、其实是另一种格式」的文件。
        var exportFormat = (req.query && req.query.format) ? String(req.query.format) : 'full';
        if (exportFormat !== 'full' && exportFormat !== 'geojson') {
          return res.status(400).json({ error: 'Invalid format' });
        }
        try {
          var expResult = await tursoFetch(
            "SELECT * FROM submissions WHERE id = ? AND user_id = ? AND is_deleted = 0",
            [exportId, user.id]
          );
          var expRows = expResult.rows || [];
          if (!expRows[0]) {
            // "does not exist" / "not yours" / "in Trash" all collapse into this one
            // response — distinguishing them would let anyone probe for ids.
            return res.status(404).json({ error: 'Submission not found' });
          }
          var expRow = unboxRow(expResult.cols, expRows[0]);

          if (exportFormat === 'geojson') {
            return res.status(200).json(exportGeometry(expRow));
          }

          return res.status(200).json({
            format: 'geoguide-submission',
            version: 1,
            exported_at: new Date().toISOString(),
            submission: buildExportSubmission(expRow)
          });
        } catch (e) {
          console.error('export failed:', e && e.message);
          return res.status(500).json({ error: 'Internal server error' });
        }
      }

      // Existing: list user's submissions with optional status filter
      var statusFilter = (req.query && req.query.status) ? String(req.query.status) : '';
      var validStatuses = ['pending', 'approved', 'rejected', 'all', 'hidden', 'trash'];
      if (statusFilter && validStatuses.indexOf(statusFilter) === -1) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }
      // 'all' means no filter — treat same as empty
      if (statusFilter === 'all') {
        statusFilter = '';
      }

      // Sort: newest (default) or oldest
      var sortOrder = (req.query && req.query.sort === 'oldest') ? 'ASC' : 'DESC';

      var pageSize = parseInt(req.query && req.query.pageSize, 10);
      if (!pageSize || pageSize < 1) pageSize = 18;
      if (pageSize > 1000) pageSize = 1000;
      var page = parseInt(req.query && req.query.page, 10);
      if (!page || page < 1) page = 1;
      var offset = (page - 1) * pageSize;

      // Server-side filters (name search + country)
      var q = (req.query && req.query.q) ? String(req.query.q).trim() : '';
      var countryFilter = (req.query && req.query.country) ? String(req.query.country).trim() : '';

      // hidden: return hidden items (is_hidden=1, is_deleted=0)
      if (statusFilter === 'hidden') {
        var hiddenSql = "SELECT s.*," + reactionCountSelect()
          + " COUNT(*) OVER() as total"
          + " FROM submissions s"
          + " LEFT JOIN reactions r ON s.id = r.region_id" + reactionJoinFilter()
          + " WHERE s.user_id = ? AND s.is_hidden = 1 AND s.is_deleted = 0";
        var hiddenArgs = [user.id];
        if (q) { hiddenSql += " AND s.name LIKE ? ESCAPE '\\'"; hiddenArgs.push(likePattern(q)); }
        if (countryFilter) { hiddenSql += " AND s.country_id = ?"; hiddenArgs.push(countryFilter); }
        hiddenSql += " GROUP BY s.id ORDER BY s.created_at " + sortOrder + " LIMIT ? OFFSET ?";
        hiddenArgs.push(pageSize, offset);
        var hiddenResult = await tursoFetch(hiddenSql, hiddenArgs);

        var hiddenCols = hiddenResult.cols;
        var hiddenRows = hiddenResult.rows;
        var hiddenTotal = totalFromRows(hiddenCols, hiddenRows);
        if (!hiddenRows || !Array.isArray(hiddenRows)) {
          return res.status(200).json({ submissions: [], total: 0, page: page, pageSize: pageSize });
        }
        var hiddenSubmissions = hiddenRows.map(function(row) {
          var obj = {};
          hiddenCols.forEach(function(c, i) {
            if (c.name === 'total') return;
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          var hiddenMapped = {
            id: obj.id,
            name: obj.name,
            description: obj.description,
            detailed_description: obj.detailed_description || '',
            source_type: obj.source_type || '',
            source_url: obj.source_url || '',
            country_id: obj.country_id || 'south-africa',
            // 'region'（默认）| 'country'。老行没有该列值一律兜底成 'region'。
            scope: obj.scope || 'region',
            tags: safeJson(obj.tags, []),
            geojson: safeJson(obj.geojson, { type: 'Polygon', coordinates: [] }),
            streetview: normalizeStreetview(safeJson(obj.streetview, {})),
            link: normalizeLink(obj.link),
            status: obj.status,
            created_at: obj.created_at,
            reviewed_at: obj.reviewed_at,
            reject_reason: obj.reject_reason || '',
            user_id: obj.user_id,
            edit_target_id: obj.edit_target_id || null,
            is_hidden: 1
          };
          Object.assign(hiddenMapped, reactionCountsFrom(obj));
          return hiddenMapped;
        });
        return res.status(200).json({ submissions: hiddenSubmissions, total: hiddenTotal, page: page, pageSize: pageSize });
      }

      // trash: return soft-deleted items with their deletion timestamps
      if (statusFilter === 'trash') {
        var trashSql = "SELECT s.*," + reactionCountSelect()
          + " COUNT(*) OVER() as total"
          + " FROM submissions s"
          + " LEFT JOIN reactions r ON s.id = r.region_id" + reactionJoinFilter()
          + " WHERE s.user_id = ? AND s.is_deleted = 1";
        var trashArgs = [user.id];
        if (q) { trashSql += " AND s.name LIKE ? ESCAPE '\\'"; trashArgs.push(likePattern(q)); }
        if (countryFilter) { trashSql += " AND s.country_id = ?"; trashArgs.push(countryFilter); }
        trashSql += " GROUP BY s.id ORDER BY s.created_at " + sortOrder + " LIMIT ? OFFSET ?";
        trashArgs.push(pageSize, offset);
        var trashResult = await tursoFetch(trashSql, trashArgs);

        var trashCols = trashResult.cols;
        var trashRows = trashResult.rows;
        var trashTotal = totalFromRows(trashCols, trashRows);
        if (!trashRows || !Array.isArray(trashRows)) {
          return res.status(200).json({ submissions: [], total: 0, page: page, pageSize: pageSize });
        }
        var trashSubmissions = trashRows.map(function(row) {
          var obj = {};
          trashCols.forEach(function(c, i) {
            if (c.name === 'total') return;
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          var trashMapped = {
            id: obj.id,
            name: obj.name,
            description: obj.description,
            detailed_description: obj.detailed_description || '',
            source_type: obj.source_type || '',
            source_url: obj.source_url || '',
            country_id: obj.country_id || 'south-africa',
            // 'region'（默认）| 'country'。老行没有该列值一律兜底成 'region'。
            scope: obj.scope || 'region',
            tags: safeJson(obj.tags, []),
            geojson: safeJson(obj.geojson, { type: 'Polygon', coordinates: [] }),
            streetview: normalizeStreetview(safeJson(obj.streetview, {})),
            link: normalizeLink(obj.link),
            status: obj.status,
            created_at: obj.created_at,
            reviewed_at: obj.reviewed_at,
            reject_reason: obj.reject_reason || '',
            user_id: obj.user_id,
            edit_target_id: obj.edit_target_id || null,
            is_deleted: 1,
            deleted_at: obj.deleted_at || ''
          };
          Object.assign(trashMapped, reactionCountsFrom(obj));
          return trashMapped;
        });
        return res.status(200).json({ submissions: trashSubmissions, total: trashTotal, page: page, pageSize: pageSize });
      }

      // LEFT JOIN replaces per-row correlated subqueries — single pass over reactions
      var sql = "SELECT s.*," + reactionCountSelect()
        + " COUNT(*) OVER() as total"
        + " FROM submissions s"
        + " LEFT JOIN reactions r ON s.id = r.region_id" + reactionJoinFilter()
        + " WHERE s.user_id = ? AND s.is_deleted = 0 AND s.is_hidden = 0";
      var args = [user.id];
      if (statusFilter) {
        sql += " AND s.status = ?";
        args.push(statusFilter);
      }
      if (q) {
        sql += " AND s.name LIKE ? ESCAPE '\\'";
        args.push(likePattern(q));
      }
      if (countryFilter) {
        sql += " AND s.country_id = ?";
        args.push(countryFilter);
      }
      sql += " GROUP BY s.id ORDER BY s.created_at " + sortOrder + " LIMIT ? OFFSET ?";
      args.push(pageSize, offset);

      var result = await tursoFetch(sql, args);

      var cols = result.cols;
      var rows = result.rows;

      if (!rows || !Array.isArray(rows)) {
        return res.status(200).json({ submissions: [], total: 0, page: page, pageSize: pageSize });
      }
      var totalCount = totalFromRows(cols, rows);

      var submissions = rows.map(function(row) {
        return mapSubmissionRow(cols, row);
      });

      return res.status(200).json({ submissions: submissions, total: totalCount, page: page, pageSize: pageSize });
    }

    // --- POST: mark notifications as read, delete, restore, hide, unhide ---
    if (req.method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      var postAction = (req.body && req.body.action) || '';
      var postId = (req.body && req.body.id) || '';

      if (postAction === 'mark-read') {
        var now = new Date().toISOString();
        await tursoFetch("UPDATE users SET last_read_at = ? WHERE id = ?", [now, user.id]);
        return res.status(200).json({ ok: true });
      }

      // --- Restore all items from trash (no id needed — operates on all user's items) ---
      if (postAction === 'restore-all') {
        await tursoFetch("UPDATE submissions SET is_deleted = 0, deleted_at = NULL WHERE user_id = ? AND is_deleted = 1", [user.id]);
        return res.status(200).json({ success: true, action: 'restored-all' });
      }

      // --- Propose new country/region (no id needed) ---
      if (postAction === 'propose-country') {
        var proposedName = (req.body && req.body.proposed_name || '').trim();
        var proposalType = (req.body && req.body.proposal_type || '').trim();
        var reason = (req.body && req.body.reason || '').trim();
        var metaIntent = (req.body && req.body.meta_intent || '').trim();
        if (metaIntent !== 'provide' && metaIntent !== 'learn') metaIntent = 'unknown';

        // Validate
        if (!proposedName || proposedName.length === 0) {
          return res.status(400).json({ error: 'Name is required' });
        }
        if (proposalType !== 'country' && proposalType !== 'region') {
          return res.status(400).json({ error: 'Type must be country or region' });
        }
        if (proposedName.length > 100) {
          return res.status(400).json({ error: 'Name must be 100 characters or fewer' });
        }
        if (proposedName.length < 2) {
          return res.status(400).json({ error: 'Name must be at least 2 characters' });
        }
        if (proposalType === 'region' && proposedName.length > 20) {
          return res.status(400).json({ error: 'Region name must be 20 characters or fewer' });
        }
        if (reason.length > 60) {
          return res.status(400).json({ error: 'Reason must be 60 characters or fewer' });
        }

        // Rate limit: 10 proposals per minute
        if (await checkRateLimit('country_proposals', 'user_id', user.id, 'created_at', 10, 1, false)) {
          return res.status(429).json({ error: 'Too many proposals. Slow down.' });
        }

        // Check daily limit (max 5 per user per day)
        var dailyCount = await tursoFetch(
          "SELECT COUNT(*) as cnt FROM country_proposals WHERE user_id = ? AND created_at > date('now')",
          [user.id]
        );
        var todayCount = parseInt((dailyCount.rows[0] && dailyCount.rows[0][0] && dailyCount.rows[0][0].value)) || 0;
        if (todayCount >= 5) {
          return res.status(429).json({ error: 'You can only propose 5 countries/regions per day' });
        }

        // Check not already an existing country
        var existingCountry = await tursoFetch(
          "SELECT id FROM countries WHERE name = ?",
          [proposedName]
        );
        if (existingCountry.rows.length > 0) {
          return res.status(400).json({ error: 'This country already exists' });
        }

        // Insert (UNIQUE constraint prevents duplicate proposals from same user)
        try {
          await tursoFetch(
            "INSERT INTO country_proposals (id, user_id, proposed_name, proposal_type, reason, meta_intent, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [crypto.randomUUID(), user.id, proposedName, proposalType, reason, metaIntent, new Date().toISOString()]
          );
          return res.status(200).json({ ok: true });
        } catch (e) {
          if (e.message && e.message.indexOf('UNIQUE') > -1) {
            return res.status(409).json({ error: 'You have already proposed this country/region' });
          }
          throw e;
        }
      }

      // All remaining mutating actions require an id (restore-all handled above)
      if (!postId) {
        return res.status(400).json({ error: 'Missing submission id' });
      }

      // Verify ownership — user must own the submission
      var ownerCheck = await tursoFetch(
        "SELECT user_id, is_deleted FROM submissions WHERE id = ?",
        [postId]
      );
      if (!ownerCheck.rows[0]) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      var ownerId = ownerCheck.rows[0][0].value;
      var deletedVal = (ownerCheck.rows[0][1] && ownerCheck.rows[0][1].value != null) ? Number(ownerCheck.rows[0][1].value) : 0;
      var isCurrentlyDeleted = deletedVal !== 0 ? 1 : 0;

      if (ownerId !== user.id) {
        return res.status(403).json({ error: 'You can only manage your own submissions' });
      }

      // --- Delete (soft) ---
      if (postAction === 'delete') {
        // Also soft-delete any pending draft rows that target this submission
        await tursoFetch("UPDATE submissions SET is_deleted = 1, deleted_at = datetime('now') WHERE edit_target_id = ? AND user_id = ?", [postId, user.id]);
        await tursoFetch("UPDATE submissions SET is_deleted = 1, deleted_at = datetime('now') WHERE id = ?", [postId]);
        return res.status(200).json({ success: true, action: 'deleted' });
      }

      // --- Permanent delete (from trash only) ---
      if (postAction === 'permanent-delete') {
        if (!isCurrentlyDeleted) {
          return res.status(400).json({ error: 'Can only permanently delete items already in trash' });
        }
        // Cascade: delete draft rows, then reactions, then the submission itself
        await tursoFetch("DELETE FROM submissions WHERE edit_target_id = ? AND user_id = ?", [postId, user.id]);
        await tursoFetch("DELETE FROM reactions WHERE region_id = ?", [postId]);
        await tursoFetch("DELETE FROM submissions WHERE id = ?", [postId]);
        return res.status(200).json({ success: true, action: 'permanent-deleted' });
      }

      // --- Restore single item from trash ---
      if (postAction === 'restore') {
        if (!isCurrentlyDeleted) {
          return res.status(400).json({ error: 'Item is not in trash' });
        }
        // Also restore any draft rows that were soft-deleted alongside the submission
        await tursoFetch("UPDATE submissions SET is_deleted = 0, deleted_at = NULL WHERE edit_target_id = ? AND user_id = ? AND is_deleted = 1", [postId, user.id]);
        await tursoFetch("UPDATE submissions SET is_deleted = 0, deleted_at = NULL WHERE id = ?", [postId]);
        return res.status(200).json({ success: true, action: 'restored' });
      }

      // --- Hide from public ---
      if (postAction === 'hide') {
        if (isCurrentlyDeleted) {
          return res.status(400).json({ error: 'Cannot hide an item in the trash' });
        }
        await tursoFetch("UPDATE submissions SET is_hidden = 1 WHERE id = ?", [postId]);
        return res.status(200).json({ success: true, action: 'hidden' });
      }

      // --- Unhide (restore visibility) ---
      if (postAction === 'unhide') {
        await tursoFetch("UPDATE submissions SET is_hidden = 0 WHERE id = ?", [postId]);
        return res.status(200).json({ success: true, action: 'unhidden' });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('user-submissions error:', e.message, e.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

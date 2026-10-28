const { tursoFetch, ensureSchema, getSessionUser, checkCsrf, checkRateLimit, uuid, resolveStreetview, normalizeStreetview, normalizeLink } = require('./_lib/turso.js');
const { insertProposedTagAuto } = require('./_lib/tagMerge.js');
const { normalizeSource } = require('./_lib/source.js');

// Validate country_id against live countries table (not hardcoded —
// new countries are added via admin review /api/countries).
async function isValidCountry(countryId) {
  var result = await tursoFetch("SELECT id FROM countries WHERE id = ? AND active = 1", [countryId]);
  return result.rows.length > 0;
}

// Insert proposed tags for a submission (shared between POST and PATCH).
// When `autoApprove` is true (trusted/admin users whose submissions bypass
// review), each proposal is approved at submit time and immediately merged
// into the submission's tags array instead of landing as pending.
async function insertProposedTags(proposedTags, userId, submissionId, autoApprove) {
  if (!proposedTags || !Array.isArray(proposedTags) || proposedTags.length === 0) return;
  var tagNow = new Date().toISOString();
  for (var i = 0; i < proposedTags.length; i++) {
    var pt = proposedTags[i];
    if (!pt.name || !pt.category) continue;
    var cleanName = pt.name.trim();
    if (cleanName.length > 50) continue;
    try {
      if (autoApprove) {
        await insertProposedTagAuto(tursoFetch, userId, cleanName, pt.category, submissionId);
      } else {
        await tursoFetch(
          "INSERT OR IGNORE INTO tags (id, name, category, user_id, status, created_at, submission_id) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
          [uuid(), cleanName, pt.category, userId, tagNow, submissionId]
        );
      }
    } catch(e) { /* skip duplicates */ }
  }
}

// Wrap a longitude into [-180, 180]. Drawing tools that pan across the
// antimeridian (Leaflet worldCopyJump) can emit lng in [180, 360) or beyond.
function wrapLng(lng) {
  if (typeof lng !== 'number' || !isFinite(lng)) return lng;
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

// Recursively wrap the lng of every [lng, lat] pair in a GeoJSON coordinates tree.
function wrapCoords(coords) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    coords[0] = wrapLng(coords[0]);
    return coords;
  }
  for (var i = 0; i < coords.length; i++) wrapCoords(coords[i]);
  return coords;
}

// Count every leaf [lng, lat] pair in a GeoJSON coordinates tree.
function countPoints(coords) {
  if (!Array.isArray(coords)) return 0;
  if (typeof coords[0] === 'number') return 1; // a leaf coordinate pair
  var n = 0;
  for (var i = 0; i < coords.length; i++) n += countPoints(coords[i]);
  return n;
}
function totalPoints(geometries) {
  var n = 0;
  for (var i = 0; i < geometries.length; i++) {
    if (geometries[i] && geometries[i].coordinates) n += countPoints(geometries[i].coordinates);
  }
  return n;
}

// Normalize geojson to array of geometry objects. Returns { geometries, error }
function normalizeGeometries(geojson) {
  var geometries;
  if (Array.isArray(geojson)) {
    geometries = geojson;
  } else if (geojson && geojson.type) {
    geometries = [geojson]; // backward compat: wrap single geometry
  } else {
    return { error: 'Invalid geometry. Must be a GeoJSON geometry or array of geometries.' };
  }

  if (geometries.length === 0 || geometries.length > 10) {
    return { error: 'Must have 1-10 geometries.' };
  }

  var validTypes = ['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon'];
  for (var i = 0; i < geometries.length; i++) {
    var g = geometries[i];
    if (!g || !g.type || validTypes.indexOf(g.type) === -1) {
      return { error: 'Invalid geometry type at index ' + i + '. Must be a valid GeoJSON geometry.' };
    }
    if (!g.coordinates || !Array.isArray(g.coordinates) || g.coordinates.length === 0) {
      return { error: 'Invalid geometry coordinates at index ' + i + '.' };
    }
  }

  // Storage gate: cap total coordinate points across all geometries (not shape count).
  if (totalPoints(geometries) > 3000) {
    return { error: 'Too many coordinate points (max 3000).' };
  }

  // Store clean lng in [-180, 180] so no future submission is saved +360°-wrapped.
  for (var j = 0; j < geometries.length; j++) {
    if (geometries[j] && geometries[j].coordinates) wrapCoords(geometries[j].coordinates);
  }

  return { geometries: geometries };
}

module.exports = async function handler(req, res) {
  // Check login for all methods
  var user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Login required' });
  }

  // Trusted users & admins are exempt from rate limits
  var isTrusted = user.role === 'trusted' || user.role === 'admin';

  if (req.method !== 'POST' && req.method !== 'PATCH') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // CSRF protection for state-changing requests
  if (!checkCsrf(req)) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  // resolve-link action — parse Google Maps short links into Street View coordinates
  if (req.query && req.query.action === 'resolve-link') {
    var link = (req.body && req.body.link) ? String(req.body.link).trim() : '';
    if (!link) return res.status(400).json({ error: 'Missing link' });
    if (link.length > 500) return res.status(400).json({ error: 'Link too long (max 500 characters)' });
    if (link.indexOf('https://') !== 0 && link.indexOf('http://') !== 0) {
      return res.status(400).json({ error: 'Invalid URL. Must start with https:// or http://' });
    }

    // Rate limit: max 10 link resolutions per 5 minutes per user
    await ensureSchema();
    if (!isTrusted && await checkRateLimit('link_resolution_log', 'user_id', user.id, 'created_at', 10, 5)) {
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
    }

    await tursoFetch(
      "INSERT INTO link_resolution_log (user_id, created_at) VALUES (?, ?)",
      [user.id, new Date().toISOString()]
    );

    var result = await resolveStreetview(link);
    if (!result || (result.lat === 0 && result.lng === 0)) {
      return res.status(400).json({ error: 'Cannot resolve this Google Maps link. Please provide a valid Street View URL with visible coordinates.' });
    }

    return res.status(200).json(result);
  }

  try {
    // Expand child tags to include parent tag names
    async function expandTags(tagNames) {
      if (!tagNames || !Array.isArray(tagNames) || tagNames.length === 0) return tagNames;
      var expanded = tagNames.slice(); // copy
      for (var i = 0; i < tagNames.length; i++) {
        var rawTag = tagNames[i];
        if (!rawTag || typeof rawTag !== 'string') continue;
        var colonIdx = rawTag.indexOf(':');
        var cat = colonIdx > -1 ? rawTag.slice(0, colonIdx).trim() : null;
        var tagName = colonIdx > -1 ? rawTag.slice(colonIdx + 1).trim() : rawTag.trim();
        var sql = cat
          ? "SELECT t2.name, t2.category FROM tags t1 JOIN tags t2 ON t1.parent_id = t2.id AND t1.category = t2.category WHERE t1.name = ? AND t1.category = ? AND t1.parent_id IS NOT NULL AND t2.status = 'approved'"
          : "SELECT t2.name, t2.category FROM tags t1 JOIN tags t2 ON t1.parent_id = t2.id AND t1.category = t2.category WHERE t1.name = ? AND t1.parent_id IS NOT NULL AND t2.status = 'approved'";
        var params = cat ? [tagName, cat] : [tagName];
        var result = await tursoFetch(sql, params);
        if (result.rows.length > 0) {
          var parentName = result.rows[0][0].value;
          var parentCat = (result.rows[0][1] && result.rows[0][1].value) || cat;
          var parentKey = parentCat ? (parentCat + ':' + parentName) : parentName;
          if (expanded.indexOf(parentKey) === -1 && expanded.indexOf(parentName) === -1) {
            expanded.push(parentKey);
          }
        }
      }
      return expanded;
    }

    // Ensure schema is up to date (single source of truth in _lib/turso.js)
    await ensureSchema();

    // Rate limit: max 5 submissions per 5 minutes per user
    if (!isTrusted && await checkRateLimit('submissions', 'user_id', user.id, 'created_at', 5, 5)) {
      return res.status(429).json({ error: 'Too many submissions. Please wait a few minutes before submitting again.' });
    }

    if (req.method === 'POST') {
      if (!req.body) return res.status(400).json({ error: 'Missing request body' });
      let { name, description, detailed_description, tags, geojson, streetview, link, country_id, source_type, source_url } = req.body;

      // 提交范围：'region'（默认，国家下属的具体小区域，需要几何）
      //         | 'country'（整个国家/区域的 meta，不需要任何几何）。
      // 必须在几何校验**之前**解析出来 —— 它决定了几何是不是必填。
      // **创建后不可更改**：下面每个 UPDATE 都故意不写这一列，草稿行从目标行继承。
      var scope = (req.body.scope === 'country') ? 'country' : 'region';

      if (!name || !description || !link) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // 草稿行的 scope 由**目标行**决定，不由 body 决定 —— 所以必须在几何校验之前解析。
      // 否则两个方向都会漏：body 谎称 'region' 并带真几何，能给国家范围条目塞进几何；
      // body 谎称 'country'，能写出一个没有几何的 region 行（explore 会把它整个丢掉）。
      var editTargetId = req.body.edit_target_id || null;
      var editTargetScope = null;
      if (editTargetId) {
        var targetData = await tursoFetch(
          "SELECT user_id, scope FROM submissions WHERE id = ?",
          [editTargetId]
        );
        if (!targetData.rows || targetData.rows.length === 0) {
          return res.status(400).json({ error: 'Target submission not found' });
        }
        var targetUserId = targetData.rows[0][0].value;
        if (targetUserId !== user.id) {
          return res.status(403).json({ error: 'You can only edit your own submissions' });
        }
        editTargetScope = (targetData.rows[0][1] && targetData.rows[0][1].value) || 'region';
      }
      // 这一行该按哪个 scope 校验与落库：草稿继承目标行，全新提交才听 body 的。
      var rowScope = editTargetId ? editTargetScope : scope;

      // 只有 region 范围才要求 geojson 存在。原来这里是 `!geojson`；空数组在 JS 里是
      // truthy，所以本来就漏得过去 —— 显式分开是为了让意图可读，不是依赖那个巧合。
      if (rowScope === 'region' && !geojson) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      if (rowScope === 'country') {
        // 规范空几何用 '[]'（几何**数组**的规范形态）：读侧的 array/single 两个分支
        // 都能吃，且与 normalizeGeometries 对普通行的产出同形。别存 '{}' 或 NULL。
        geojson = [];
      } else {
        // Validate and normalize GeoJSON geometry (accepts single or array, 1-10 max + 3000 point budget)
        var norm = normalizeGeometries(geojson);
        if (norm.error) {
          return res.status(400).json({ error: norm.error });
        }
        geojson = norm.geometries; // always use normalized array going forward
      }

      // Input size limits
      if (name.length > 60) return res.status(400).json({ error: 'Name too long (max 60 characters)' });
      if (description.length > 300) return res.status(400).json({ error: 'Description too long (max 300 characters)' });
      var detailDesc = (detailed_description || '').trim();
      if (detailDesc.length > 2000) return res.status(400).json({ error: 'Detailed description too long (max 2000 characters)' });
      // Optional source attribution. Any inconsistent/invalid input (unknown type,
      // lone type or url, non-https `other`, over-long url) normalizes to empty —
      // this is the security boundary for the non-whitelisted `other` type.
      var srcPair = normalizeSource(source_type, source_url);
      if (tags && Array.isArray(tags) && tags.length > 10) return res.status(400).json({ error: 'Too many tags (max 10)' });
      if (geojson && JSON.stringify(geojson).length > 100000) return res.status(400).json({ error: 'GeoJSON too large' });
      if (country_id && country_id.length > 40) return res.status(400).json({ error: 'Country too long' });
      if (country_id && !(await isValidCountry(country_id))) return res.status(400).json({ error: 'Invalid country' });

      // Normalize to arrays
      var streetviewArr = normalizeStreetview(streetview);
      var linkArr = normalizeLink(link);

      // Validate individual link URL lengths
      for (var li = 0; li < linkArr.length; li++) {
        if (typeof linkArr[li] === 'string' && linkArr[li].length > 180) {
          return res.status(400).json({ error: 'Link URL too long (max 180 characters per URL)' });
        }
      }

      // Validate arrays
      if (streetviewArr.length === 0) return res.status(400).json({ error: 'At least one Street View link is required' });
      if (streetviewArr.length > 5) return res.status(400).json({ error: 'Too many streetviews (max 5)' });
      if (linkArr.length === 0) return res.status(400).json({ error: 'At least one link is required' });
      if (linkArr.length > 5) return res.status(400).json({ error: 'Too many links (max 5)' });
      if (JSON.stringify(streetviewArr).length > 2500) return res.status(400).json({ error: 'Streetview data too large' });

      // At least one entry must have real coordinates
      var hasValidCoords = streetviewArr.some(function(sv) {
        return sv && typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0);
      });
      if (!hasValidCoords) return res.status(400).json({ error: 'At least one valid Street View link is required' });

      const id = uuid();
      const now = new Date().toISOString();

      // Expand child tags to auto-include parent tag names (sub-tag inheritance)
      var expandedTags = await expandTags(tags);

      // Resolve each entry independently
      var resolvedStreetviews = [];
      for (var si = 0; si < streetviewArr.length; si++) {
        var sv = streetviewArr[si];
        if (sv && typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0)) {
          resolvedStreetviews.push(sv);
        } else {
          var linkForThisOne = linkArr[si] || linkArr[0] || '';
          var resolved = await resolveStreetview(linkForThisOne);
          resolvedStreetviews.push(resolved && resolved.lat !== 0
            ? resolved
            : { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 });
        }
      }

      // edit_target_id 的所有权校验与 scope 继承**已提前到几何校验之前**（见上面
      // rowScope 那一段）—— 顺序是承重的，别把它挪回来。

      console.log('submit POST: role=' + (user.role || 'user') + ' country=' + (country_id || 'south-africa') + ' isTrusted=' + isTrusted);

      // Trusted users with edit_target_id: auto-merge into original (skip draft flow)
      if (isTrusted && editTargetId) {
        // 这是 resubmit 路径之一：原行多半已经通过过，COALESCE 保证首次通过时间不被顶掉。
        // 这里**故意不写 scope** —— 它创建后不可变，省略即保留存储值。别来"补齐"它。
        await tursoFetch(
          "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, geojson = ?, streetview = ?, link = ?, country_id = ?, source_type = ?, source_url = ?, status = 'approved', reviewed_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
          [name, description, detailDesc, expandedTags, geojson, JSON.stringify(resolvedStreetviews), JSON.stringify(linkArr), country_id || 'south-africa', srcPair.source_type, srcPair.source_url, now, now, editTargetId]
        );
        // Save proposed tags (attached to the original submission) before returning
        await insertProposedTags(req.body.proposed_tags, user.id, editTargetId, isTrusted);
        return res.status(201).json({ success: true, id: editTargetId, merged: true });
      }

      if (isTrusted) {
        // 信任用户的新提交：出生即 approved，首次通过时间就是现在。
        await tursoFetch(
          `INSERT INTO submissions (id, name, description, detailed_description, tags, geojson, streetview, link, country_id, user_id, status, created_at, edit_target_id, reviewed_at, source_type, source_url, first_approved_at, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?)`,
          [id, name, description, detailDesc, expandedTags, geojson, JSON.stringify(resolvedStreetviews), JSON.stringify(linkArr), country_id || 'south-africa', user.id, now, editTargetId, now, srcPair.source_type, srcPair.source_url, now, rowScope]
        );
      } else {
        await tursoFetch(
          `INSERT INTO submissions (id, name, description, detailed_description, tags, geojson, streetview, link, country_id, user_id, status, created_at, edit_target_id, source_type, source_url, scope)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
          [id, name, description, detailDesc, expandedTags, geojson, JSON.stringify(resolvedStreetviews), JSON.stringify(linkArr), country_id || 'south-africa', user.id, now, editTargetId, srcPair.source_type, srcPair.source_url, rowScope]
        );
      }

      // Handle proposed tags (trusted → auto-approve + merge; others → pending for review)
      await insertProposedTags(req.body.proposed_tags, user.id, id, isTrusted);

      return res.status(201).json({ success: true, id, edit_target_id: editTargetId || null });
    }

    if (req.method === 'PATCH') {
      if (!req.body) return res.status(400).json({ error: 'Missing request body' });
      const { id, name, description, detailed_description, tags, geojson, streetview, link, country_id, source_type, source_url } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'Missing submission id' });
      }

      // Input size limits for edit
      if (name !== undefined && name.length > 60) return res.status(400).json({ error: 'Name too long (max 60 characters)' });
      if (description !== undefined && description.length > 300) return res.status(400).json({ error: 'Description too long (max 300 characters)' });
      if (detailed_description !== undefined && detailed_description.length > 2000) return res.status(400).json({ error: 'Detailed description too long (max 2000 characters)' });
      if (link !== undefined && link.length > 180) return res.status(400).json({ error: 'Link too long (max 180 characters)' });
      if (tags !== undefined && Array.isArray(tags) && tags.length > 10) return res.status(400).json({ error: 'Too many tags (max 10)' });
      if (geojson !== undefined && JSON.stringify(geojson).length > 100000) return res.status(400).json({ error: 'GeoJSON too large' });
      if (streetview !== undefined && JSON.stringify(streetview).length > 2500) return res.status(400).json({ error: 'Streetview data too large' });

      var streetviewArr = streetview !== undefined ? normalizeStreetview(streetview) : undefined;
      var linkArr = link !== undefined ? normalizeLink(link) : undefined;

      if (streetviewArr !== undefined) {
        if (streetviewArr.length === 0) return res.status(400).json({ error: 'At least one Street View link is required' });
        if (streetviewArr.length > 5) return res.status(400).json({ error: 'Too many streetviews (max 5)' });
        if (JSON.stringify(streetviewArr).length > 2500) return res.status(400).json({ error: 'Streetview data too large' });
        // At least one entry must have real coordinates
        var hasValidCoords = streetviewArr.some(function(sv) {
          return sv && typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0);
        });
        if (!hasValidCoords) return res.status(400).json({ error: 'At least one valid Street View link is required' });
        // Resolve coordinates from links for entries without valid coords
        var resolvedLinkArr = linkArr;
        if (!resolvedLinkArr) {
          var existingData = await tursoFetch("SELECT link FROM submissions WHERE id = ?", [id]);
          if (existingData.rows && existingData.rows.length > 0) {
            resolvedLinkArr = normalizeLink(existingData.rows[0][0].value);
          }
        }
        if (!resolvedLinkArr) resolvedLinkArr = [];
        var resolvedStreetviews = [];
        for (var si = 0; si < streetviewArr.length; si++) {
          var sv = streetviewArr[si];
          if (sv && typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0)) {
            resolvedStreetviews.push(sv);
          } else {
            var linkForThisOne = resolvedLinkArr[si] || resolvedLinkArr[0] || '';
            var resolved = await resolveStreetview(linkForThisOne);
            resolvedStreetviews.push(resolved && resolved.lat !== 0
              ? resolved
              : { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 });
          }
        }
        streetviewArr = resolvedStreetviews;
      }
      if (linkArr !== undefined) {
        if (linkArr.length === 0) return res.status(400).json({ error: 'At least one link is required' });
        if (linkArr.length > 5) return res.status(400).json({ error: 'Too many links (max 5)' });
        // Validate individual link URL lengths
        for (var li = 0; li < linkArr.length; li++) {
          if (typeof linkArr[li] === 'string' && linkArr[li].length > 180) {
            return res.status(400).json({ error: 'Link URL too long (max 180 characters per URL)' });
          }
        }
      }

      // Fetch existing submission and verify ownership + pending status
      var data = await tursoFetch(
        "SELECT user_id, status, scope FROM submissions WHERE id = ?",
        [id]
      );
      var rows = data.rows;

      if (!rows || rows.length === 0) {
        return res.status(404).json({ error: 'Submission not found' });
      }

      var existingUserId = rows[0][0].value;
      var existingStatus = rows[0][1].value;
      // scope 创建后不可变：PATCH 既不去解构 req.body.scope（传了也无效），
      // 也不用它写库 —— 只在下面决定几何那一支怎么走。
      var existingScope = (rows[0][2] && rows[0][2].value) || 'region';

      if (existingUserId !== user.id) {
        return res.status(403).json({ error: 'You can only edit your own submissions' });
      }

      // Trusted users can edit any of their own submissions directly
      // Regular users: pending/rejected only; approved must use draft flow
      if (existingStatus === 'approved' && !isTrusted) {
        return res.status(400).json({ error: 'Approved submissions cannot be edited directly. Use the edit button to create a modification draft.' });
      }

      // Build dynamic UPDATE
      var setClauses = [];
      var args = [];

      if (name !== undefined) {
        setClauses.push('name = ?');
        args.push(name);
      }
      if (description !== undefined) {
        setClauses.push('description = ?');
        args.push(description);
      }
      if (detailed_description !== undefined) {
        setClauses.push('detailed_description = ?');
        args.push((detailed_description || '').trim());
      }
      if (source_type !== undefined || source_url !== undefined) {
        // Same normalization as POST (server-side revalidation, never trust the
        // client). Sending only one of the two rewrites both columns.
        var srcPatch = normalizeSource(source_type, source_url);
        setClauses.push('source_type = ?');
        args.push(srcPatch.source_type);
        setClauses.push('source_url = ?');
        args.push(srcPatch.source_url);
      }
      if (tags !== undefined) {
        var expandedPatchTags = await expandTags(tags);
        setClauses.push('tags = ?');
        args.push(expandedPatchTags);
      }
      if (geojson !== undefined) {
        if (existingScope === 'country') {
          // 国家范围条目永远不该带几何。**不能**走 normalizeGeometries —— 它要求
          // 1-10 个几何，国家范围发的规范空数组 '[]' 必然被它 400 掉。这里直接钉死
          // 成空数组，顺带挡掉"给国家范围条目补几何"的尝试。
          setClauses.push("geojson = '[]'");
        } else {
          var norm = normalizeGeometries(geojson);
          if (norm.error) {
            return res.status(400).json({ error: norm.error });
          }
          setClauses.push('geojson = ?');
          args.push(norm.geometries);
        }
      }
      if (streetviewArr !== undefined) {
        setClauses.push('streetview = ?');
        args.push(JSON.stringify(streetviewArr));
      }
      if (linkArr !== undefined) {
        setClauses.push('link = ?');
        args.push(JSON.stringify(linkArr));
      }
      if (country_id !== undefined) {
        if (country_id.length > 40) return res.status(400).json({ error: 'Country too long' });
        if (!(await isValidCountry(country_id))) return res.status(400).json({ error: 'Invalid country' });
        setClauses.push('country_id = ?');
        args.push(country_id);
      }

      // Trusted users: always stay approved. Regular users: rejected → pending reset.
      var patchNow = new Date().toISOString();
      if (isTrusted) {
        setClauses.push("status = 'approved'");
        setClauses.push('reviewed_at = ?');
        args.push(patchNow);
        // resubmit 路径之一：自改后保持 approved。首次通过时间若已存在则不动。
        setClauses.push('first_approved_at = COALESCE(first_approved_at, ?)');
        args.push(patchNow);
        // Approved items are always visible, so un-hide on trusted self-approval.
        setClauses.push('is_hidden = 0');
      } else if (existingStatus === 'rejected') {
        setClauses.push("status = 'pending'");
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      args.push(id);
      await tursoFetch(
        'UPDATE submissions SET ' + setClauses.join(', ') + ' WHERE id = ?',
        args
      );

      // Handle proposed tags on PATCH (same as POST)
      await insertProposedTags(req.body.proposed_tags, user.id, id, isTrusted);

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('submit error:', e.message, e.stack);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const { tursoFetch, ensureSchema, getSessionUser, checkCsrf, checkRateLimit, checkAdmin, checkAdminPassword, uuid } = require('./_lib/turso.js');
const { approveTagWithMerge } = require('./_lib/tagMerge.js');

module.exports = async function handler(req, res) {
  try {

    await ensureSchema();
    if (req.method === 'GET') {
      // Return approved tags grouped by category
      // Migrate: ensure parent_id column exists

      // Auto-seed if categories table is empty (like countries.js pattern)
      var catCount = await tursoFetch("SELECT COUNT(*) as cnt FROM tag_categories", []);
      if (parseInt((catCount.rows[0] && catCount.rows[0][0].value)) === 0) {
        var now = new Date().toISOString();
        var BASE_CATEGORIES = [
          { name: 'Car', sort: 0, tags: ['smallcam', 'gen2', 'gen3', 'gen4', 'truck'] },
          { name: 'Copyright', sort: 1, tags: ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025', '2026'] },
          { name: 'Landscape', sort: 2, tags: ['grassland', 'farmland', 'forest', 'desert'] },
          { name: 'Terrain', sort: 3, tags: ['flat', 'hilly', 'mountainous'] },
          { name: 'Soil', sort: 4, tags: ['red', 'sandy'] },
          { name: 'Vegetation', sort: 5, tags: ['grass', 'shrubs'] },
          { name: 'Season', sort: 6, tags: ['spring', 'summer', 'autumn', 'winter'] },
          { name: 'Vibe', sort: 7, tags: ['green', 'sandstorm'] },
          { name: 'Road', sort: 8, tags: ['paved', 'unpaved'] },
          { name: 'Plantation', sort: 9, tags: ['eucalyptus', 'pine'] }
        ];
        for (var ci = 0; ci < BASE_CATEGORIES.length; ci++) {
          var cat = BASE_CATEGORIES[ci];
          var catId = uuid();
          await tursoFetch(
            "INSERT INTO tag_categories (id, name, sort_order) VALUES (?, ?, ?)",
            [catId, cat.name, String(cat.sort)]
          );
          for (var ti = 0; ti < cat.tags.length; ti++) {
            await tursoFetch(
              "INSERT INTO tags (id, name, category, user_id, status, created_at) VALUES (?, ?, ?, ?, 'approved', ?)",
              [uuid(), cat.tags[ti], cat.name, '', now]
            );
          }
        }
      }

      var cats = await tursoFetch(
        "SELECT * FROM tag_categories ORDER BY sort_order ASC", []
      );
      // Use explicit column names so parent_id index is stable regardless of
      // whether the column was added via ALTER TABLE (appended) or CREATE TABLE (inline)
      var tags = await tursoFetch(
        "SELECT id, name, category, parent_id FROM tags WHERE status = 'approved' ORDER BY name ASC", []
      );

      // Build flat tag objects keyed by id for parent lookup
      // Explicit SELECT ensures: id(0), name(1), category(2), parent_id(3)
      var tagMap = {};
      tags.rows.forEach(function(tr) {
        var id = tr[0].value;
        var name = tr[1].value;
        var category = tr[2].value;
        var parentId = (tr[3] && tr[3].value) || null;
        tagMap[id] = { id: id, name: name, category: category, parentId: parentId };
      });

      // Nest children under parents
      var nestedTags = [];
      var childIds = {};
      Object.values(tagMap).forEach(function(tag) {
        if (tag.parentId && tagMap[tag.parentId]) {
          // This is a child — nest under parent
          var parent = tagMap[tag.parentId];
          if (!parent.children) parent.children = [];
          parent.children.push({ id: tag.id, name: tag.name });
          childIds[tag.id] = true;
        }
      });
      // Top-level tags are those not marked as children
      Object.values(tagMap).forEach(function(tag) {
        if (!childIds[tag.id]) {
          nestedTags.push(tag);
        }
      });

      // Build category response with nested tags
      var categories = cats.rows.map(function(row) {
        var catName = row[1].value;
        var catTags = nestedTags.filter(function(t) { return t.category === catName; });
        return {
          name: catName,
          sort_order: parseInt(row[2].value) || 0,
          tags: catTags.map(function(t) {
            var obj = { id: t.id, name: t.name };
            if (t.children && t.children.length > 0) {
              obj.children = t.children;
            }
            return obj;
          })
        };
      });

      return res.status(200).json({ categories: categories });
    }

    // All other methods require auth
    var adminUser = await checkAdmin(req);
    if (!adminUser) {
      return res.status(401).json({ error: 'Admin access required' });
    }

    if (req.method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('tag_edits', 'user_id', adminUser.id, 'created_at', 30, 1, true)) return res.status(429).json({ error: 'Too many tag edits. Slow down.' });
      var body = req.body;
      var action = body.action;
      var now = new Date().toISOString();
      var adminUserId = adminUser.id;

      if (action === 'create_category') {
        var catName = (body.category || '').trim();
        if (!catName) return res.status(400).json({ error: 'Missing category name' });
        if (catName.length > 50) return res.status(400).json({ error: 'Category name too long (max 50 characters)' });

        // Get max sort_order
        var maxSort = await tursoFetch("SELECT MAX(sort_order) as m FROM tag_categories", []);
        var nextSort = (maxSort.rows[0] && maxSort.rows[0][0].value != null)
          ? parseInt(maxSort.rows[0][0].value) + 1 : 0;

        await tursoFetch(
          "INSERT INTO tag_categories (id, name, sort_order) VALUES (?, ?, ?)",
          [uuid(), catName, String(nextSort)]
        );
        return res.status(200).json({ success: true });
      }

      if (action === 'create_tags_batch') {
        var category = (body.category || '').trim();
        var names = body.names || [];
        var parentId = body.parent_id || null;
        if (!category || !names.length) return res.status(400).json({ error: 'Missing category or names' });
        if (names.length > 30) return res.status(400).json({ error: 'Too many tags (max 30 per batch)' });

        // If parent_id provided, validate: parent must exist and itself have no parent (one level only)
        if (parentId) {
          var parentRows = await tursoFetch(
            "SELECT id, parent_id, category FROM tags WHERE id = ? AND status = 'approved'", [parentId]
          );
          if (parentRows.rows.length === 0) {
            return res.status(400).json({ error: 'Parent tag not found' });
          }
          var parentParentId = parentRows.rows[0][1] ? parentRows.rows[0][1].value : null;
          if (parentParentId) {
            return res.status(400).json({ error: 'Cannot nest under a child tag — only one level supported' });
          }
          // Enforce: child tags always inherit parent's category
          category = parentRows.rows[0][2].value;
        }

        for (var i = 0; i < names.length; i++) {
          var name = names[i].trim();
          if (!name) continue;
          if (name.length > 50) continue;
          await tursoFetch(
            "INSERT OR IGNORE INTO tags (id, name, category, parent_id, user_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'approved', ?)",
            [uuid(), name, category, parentId || null, adminUserId, now]
          );
        }
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    if (req.method === 'PATCH') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('tag_edits', 'user_id', adminUser.id, 'created_at', 30, 1, true)) return res.status(429).json({ error: 'Too many tag edits. Slow down.' });

      var action = req.body.action;

      if (action === 'rename_category') {
        var oldName = (req.body.old_name || '').trim();
        var newName = (req.body.new_name || '').trim();
        if (!oldName || !newName) return res.status(400).json({ error: 'Missing old_name or new_name' });
        if (newName.length > 50) return res.status(400).json({ error: 'Category name too long (max 50)' });
        await tursoFetch("UPDATE tag_categories SET name = ? WHERE name = ?", [newName, oldName]);
        await tursoFetch("UPDATE tags SET category = ? WHERE category = ?", [newName, oldName]);
        return res.status(200).json({ success: true });
      }

      if (action === 'rename_tag') {
        var id = req.body.id;
        var newName = (req.body.new_name || '').trim();
        if (!id || !newName) return res.status(400).json({ error: 'Missing id or new_name' });
        if (newName.length > 50) return res.status(400).json({ error: 'Tag name too long (max 50)' });
        await tursoFetch("UPDATE tags SET name = ? WHERE id = ?", [newName, id]);
        return res.status(200).json({ success: true });
      }

      // Batch approve/reject of pending tag proposals.
      // Approve merges each approved tag name into its linked submission's
      // tags array (same path as single approve). Reject deletes the rows
      // (mirrors the single DELETE /api/tags?id=X&type=tag semantics).
      if (action === 'batch') {
        var ids = req.body.ids;
        var batchAction = req.body.batch_action;
        if (!Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'Missing or empty ids array' });
        }
        if (ids.length > 50) {
          return res.status(400).json({ error: 'Too many ids — maximum 50 per batch' });
        }
        if (batchAction !== 'approve' && batchAction !== 'reject') {
          return res.status(400).json({ error: 'Invalid action — must be approve or reject' });
        }
        if (batchAction === 'approve') {
          for (var abi = 0; abi < ids.length; abi++) {
            await approveTagWithMerge(tursoFetch, ids[abi]);
          }
        } else {
          for (var rbi = 0; rbi < ids.length; rbi++) {
            await tursoFetch("DELETE FROM tags WHERE parent_id = ?", [ids[rbi]]);
            await tursoFetch("DELETE FROM tags WHERE id = ?", [ids[rbi]]);
          }
        }
        return res.status(200).json({ ok: true, processed: ids.length });
      }

      // Legacy status update (approve/reject/pending)
      var id = req.body.id;
      var status = req.body.status;
      if (!id || !status) return res.status(400).json({ error: 'Missing id or status' });

      var allowedStatuses = ['approved', 'rejected', 'pending'];
      if (allowedStatuses.indexOf(status) === -1) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      // Approving a pending tag now merges its name into the linked
      // submission's tags array (single-approve path shares approveTagWithMerge
      // with the batch action). Reject/pending keep the old status-only update.
      if (status === 'approved') {
        await approveTagWithMerge(tursoFetch, id);
      } else {
        await tursoFetch("UPDATE tags SET status = ? WHERE id = ?", [status, id]);
      }
      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('tag_edits', 'user_id', adminUser.id, 'created_at', 30, 1, true)) return res.status(429).json({ error: 'Too many tag edits. Slow down.' });
      var delId = req.query.id;
      var delType = req.query.type || 'tag';
      var delName = req.query.name;

      // Name-based category deletion
      if (delType === 'category' && delName) {
        await tursoFetch("DELETE FROM tags WHERE category = ?", [delName]);
        await tursoFetch("DELETE FROM tag_categories WHERE name = ?", [delName]);
        return res.status(200).json({ success: true });
      }

      if (!delId) return res.status(400).json({ error: 'Missing id' });

      if (delType === 'category') {
        // Get category name first
        var catRows = await tursoFetch("SELECT name FROM tag_categories WHERE id = ?", [delId]);
        if (catRows.rows.length === 0) return res.status(404).json({ error: 'Category not found' });
        var catName = catRows.rows[0][0].value;
        await tursoFetch("DELETE FROM tags WHERE category = ?", [catName]);
        await tursoFetch("DELETE FROM tag_categories WHERE id = ?", [delId]);
      } else {
        // Delete children first, then the tag itself
        await tursoFetch("DELETE FROM tags WHERE parent_id = ?", [delId]);
        await tursoFetch("DELETE FROM tags WHERE id = ?", [delId]);
      }
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('tags error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

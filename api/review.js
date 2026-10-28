const { tursoFetch, ensureSchema, checkAdmin, checkCsrf, checkRateLimit, resolveStreetview, safeJson, cleanupTrash } = require('./_lib/turso.js');

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    await cleanupTrash();
    var user = await checkAdmin(req);
    if (!user) {
      return res.status(401).json({ error: 'Admin access required' });
    }
    if (req.method === 'GET') {
      var status = req.query.status || 'pending';
      var validStatuses = ['pending', 'approved', 'rejected', 'flagged', 'trash'];
      if (validStatuses.indexOf(status) === -1) {
        return res.status(400).json({ error: 'Invalid status filter' });
      }

      // Diagnostic: check environment variables
      if (!process.env.TURSO_URL && !process.env.turso_database_url || !process.env.TURSO_TOKEN && !process.env.turso_auth_token) {
        return res.status(500).json({ error: 'Database not configured', step: 'env' });
      }

      // Ensure table exists

      var country = req.query.country || null;

      let cols, rows;
      try {
        // --- trash: all soft-deleted submissions across users ---
        if (status === 'trash') {
          var trashSql = 'SELECT s.*, COALESCE(NULLIF(u.display_name,\'\'), u.username, \'\') as submitted_by FROM submissions s LEFT JOIN users u ON s.user_id = u.id WHERE s.is_deleted = 1';
          var trashArgs = [];
          if (country) {
            trashSql += ' AND s.country_id = ?';
            trashArgs.push(country);
          }
          trashSql += ' ORDER BY s.deleted_at DESC';
          const trashResult = await tursoFetch(trashSql, trashArgs);
          cols = trashResult.cols;
          rows = trashResult.rows;
        } else if (status === 'flagged') {
          var flaggedSql = "SELECT s.*, COALESCE(NULLIF(u.display_name,''), u.username, '') as submitted_by, SUM(CASE WHEN r.type = 'useless' THEN 1 ELSE 0 END) as useless_count, SUM(CASE WHEN r.type = 'wrong' THEN 1 ELSE 0 END) as wrong_count, SUM(CASE WHEN r.type = 'error' THEN 1 ELSE 0 END) as error_count FROM submissions s LEFT JOIN users u ON s.user_id = u.id JOIN reactions r ON s.id = r.region_id WHERE s.status = 'approved' AND s.is_deleted = 0 AND r.type IN ('useless', 'wrong', 'error')";
          var flaggedArgs = [];
          if (country) {
            flaggedSql += ' AND s.country_id = ?';
            flaggedArgs.push(country);
          }
          flaggedSql += ' GROUP BY s.id HAVING useless_count >= 5 OR wrong_count >= 5 OR error_count >= 1 ORDER BY (useless_count + wrong_count + error_count) DESC';
          const flaggedResult = await tursoFetch(flaggedSql, flaggedArgs);
          cols = flaggedResult.cols;
          rows = flaggedResult.rows;
        } else {
          var sql = 'SELECT s.*, COALESCE(NULLIF(u.display_name,\'\'), u.username, \'\') as submitted_by FROM submissions s LEFT JOIN users u ON s.user_id = u.id WHERE s.status = ? AND s.is_deleted = 0';
          var args = [status];
          if (country) {
            sql += ' AND s.country_id = ?';
            args.push(country);
          }
          sql += ' ORDER BY s.created_at DESC';
          const result = await tursoFetch(sql, args);
          cols = result.cols;
          rows = result.rows;
        }
      } catch (e) {
        return res.status(500).json({ error: 'Query failed', step: 'query' });
      }

      if (!rows || !Array.isArray(rows)) {
        return res.status(500).json({ error: 'Unexpected response', step: 'format' });
      }

      let submissions;
      try {
        submissions = rows.map(function(row) {
          var obj = {};
          cols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return {
            id: obj.id,
            name: obj.name,
            description: obj.description,
            detailed_description: obj.detailed_description || '',
            source_type: obj.source_type || '',
            source_url: obj.source_url || '',
            country_id: obj.country_id || 'south-africa',
            // 'region'（默认）| 'country'。老行一律兜底成 'region'。
            scope: obj.scope || 'region',
            tags: safeJson(obj.tags, []),
            geojson: safeJson(obj.geojson, { type: 'Polygon', coordinates: [] }),
            streetview: safeJson(obj.streetview, {}),
            link: obj.link,
            status: obj.status,
            created_at: obj.created_at,
            reviewed_at: obj.reviewed_at,
            reject_reason: obj.reject_reason || '',
            submitted_by: obj.submitted_by || '',
            edit_target_id: obj.edit_target_id || null,
            user_id: obj.user_id || '',
            useless_count: parseInt(obj.useless_count) || 0,
            wrong_count: parseInt(obj.wrong_count) || 0,
            error_count: parseInt(obj.error_count) || 0,
          };
        });
      } catch (e) {
        return res.status(500).json({ error: 'Parse failed', step: 'parse' });
      }

      // Also fetch pending tags
      let pendingTags = [];
      try {
        var tagResult = await tursoFetch(
          "SELECT t.id, t.name, t.category, t.status, t.created_at, COALESCE(NULLIF(u.display_name,''), u.username, '') as submitted_by, s.name as submission_name FROM tags t LEFT JOIN users u ON t.user_id = u.id LEFT JOIN submissions s ON t.submission_id = s.id WHERE t.status = 'pending' ORDER BY t.created_at DESC",
          []
        );
        pendingTags = tagResult.rows.map(function(row) {
          var obj = {};
          tagResult.cols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return { id: obj.id, name: obj.name, category: obj.category, status: obj.status, created_at: obj.created_at, submitted_by: obj.submitted_by || '', submission_name: obj.submission_name || '' };
        });
      } catch(e) { /* tags table may not exist yet */ }

      // Also fetch country/region proposals
      let countryProposals = [];
      try {
        var proposalResult = await tursoFetch(
          "SELECT cp.proposed_name, cp.proposal_type, COUNT(*) as votes, GROUP_CONCAT(COALESCE(u.display_name, u.username), ', ') as proposers, MAX(cp.created_at) as latest, SUM(CASE WHEN cp.meta_intent = 'provide' THEN 1 ELSE 0 END) as provide_count, SUM(CASE WHEN cp.meta_intent = 'learn' THEN 1 ELSE 0 END) as learn_count, SUM(CASE WHEN cp.meta_intent = 'unknown' THEN 1 ELSE 0 END) as unknown_count FROM country_proposals cp JOIN users u ON cp.user_id = u.id GROUP BY cp.proposed_name, cp.proposal_type ORDER BY votes DESC, latest DESC",
          []
        );
        countryProposals = proposalResult.rows.map(function(row) {
          var obj = {};
          proposalResult.cols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return {
            proposed_name: obj.proposed_name,
            proposal_type: obj.proposal_type,
            votes: parseInt(obj.votes) || 0,
            proposers: obj.proposers || '',
            latest: obj.latest,
            provide_count: parseInt(obj.provide_count) || 0,
            learn_count: parseInt(obj.learn_count) || 0,
            unknown_count: parseInt(obj.unknown_count) || 0
          };
        });
      } catch(e) { /* table may not exist yet */ }

      // Also fetch country notes for review (pending first)
      let notes = [];
      try {
        var noteResult = await tursoFetch(
          "SELECT cn.id, cn.user_id, cn.country_id, cn.note, cn.status, cn.created_at, COALESCE(NULLIF(u.display_name,''), u.username, '') as username FROM country_notes cn LEFT JOIN users u ON cn.user_id = u.id ORDER BY CASE cn.status WHEN 'pending' THEN 0 ELSE 1 END, cn.created_at DESC",
          []
        );
        notes = noteResult.rows.map(function(row) {
          var obj = {};
          noteResult.cols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return {
            id: obj.id,
            user_id: obj.user_id,
            country_id: obj.country_id,
            note: obj.note,
            status: obj.status,
            created_at: obj.created_at,
            username: obj.username || ''
          };
        });
      } catch(e) { /* country_notes table may not exist yet */ }

      return res.status(200).json({ submissions: submissions, pending_tags: pendingTags, country_proposals: countryProposals, notes: notes });
    }

    if (req.method === 'PATCH') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('review_actions', 'user_id', user.id, 'created_at', 60, 1, true)) return res.status(429).json({ error: 'Too many review actions. Slow down.' });
      if (!req.body) return res.status(400).json({ error: 'Missing request body' });
      const { id, status, action } = req.body;

      // Ensure column exists (may be needed if PATCH is called before any GET)

      // Dismiss flag: clear all useless reactions for a region
      if (action === 'dismiss_flag') {
        var flagId = req.body.id;
        if (!flagId) return res.status(400).json({ error: 'Missing id' });
        await tursoFetch("DELETE FROM reactions WHERE region_id = ? AND type = 'useless'", [flagId]);
        return res.status(200).json({ success: true, dismissed: true });
      }

      // Approve a pending country note
      if (action === 'note_approve') {
        var noteId = req.body.id;
        if (!noteId) return res.status(400).json({ error: 'Missing id' });
        await tursoFetch("UPDATE country_notes SET status = 'approved', updated_at = ? WHERE id = ?", [new Date().toISOString(), noteId]);
        return res.status(200).json({ success: true });
      }

      // Delete a country note (admin can delete any)
      if (action === 'note_delete') {
        var noteId2 = req.body.id;
        if (!noteId2) return res.status(400).json({ error: 'Missing id' });
        await tursoFetch("DELETE FROM country_notes WHERE id = ?", [noteId2]);
        return res.status(200).json({ success: true });
      }

      // Batch approve/reject
      if (action === 'batch') {
        var ids = req.body.ids;
        var batchAction = req.body.batch_action; // 'approve' or 'reject'
        var batchReason = req.body.reject_reason || '';

        if (!Array.isArray(ids) || ids.length === 0) {
          return res.status(400).json({ error: 'Missing or empty ids array' });
        }
        if (ids.length > 50) {
          return res.status(400).json({ error: 'Too many ids — maximum 50 per batch' });
        }
        if (batchAction !== 'approve' && batchAction !== 'reject') {
          return res.status(400).json({ error: 'Invalid action — must be approve or reject' });
        }
        if (batchAction === 'reject' && !batchReason) {
          return res.status(400).json({ error: 'Reject reason is required' });
        }

        var batchNow = new Date().toISOString();
        var placeholders = ids.map(function() { return '?'; }).join(',');

        // Verify all submissions exist and are pending
        var checkResult = await tursoFetch(
          "SELECT id FROM submissions WHERE id IN (" + placeholders + ") AND status != 'pending'",
          ids
        );
        if (checkResult.rows.length > 0) {
          var badIds = checkResult.rows.map(function(r) { return r[0].value; });
          return res.status(400).json({ error: 'Some submissions are not pending', ids: badIds });
        }

        // Apply the batch action. Approving a draft row (edit_target_id set) must
        // merge into its original and delete the draft — matching the single-approve
        // path — otherwise the draft becomes a second approved row with identical
        // geometry, which stacks as a duplicate polygon on the public map.
        if (batchAction === 'approve') {
          for (var bi = 0; bi < ids.length; bi++) {
            var draftResult = await tursoFetch(
              "SELECT edit_target_id, name, description, tags, geojson, streetview, link, country_id, detailed_description, source_type, source_url FROM submissions WHERE id = ?",
              [ids[bi]]
            );
            var drow = draftResult.rows[0];
            if (!drow) continue;
            var targetId = drow[0] ? drow[0].value : null;
            if (targetId) {
              // 合并进原行 —— 这是 resubmit 路径之一，首次通过时间要留住。
              // **故意不写 scope**：它创建后不可变，省略即保留存储值（草稿的 scope 必然
              // 与目标相同，见 api/submit.js 里的草稿继承逻辑）。本文件所有 UPDATE 同理，
              // 别单独给某一条"补齐"—— 列定义处的说明在 api/_lib/turso.js。
              await tursoFetch(
                "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, geojson = ?, streetview = ?, link = ?, country_id = ?, source_type = ?, source_url = ?, status = 'approved', reviewed_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
                [drow[1].value, drow[2].value, drow[8] ? drow[8].value : '', drow[3].value, drow[4].value, drow[5].value, drow[6].value, drow[7] ? drow[7].value : 'south-africa', (drow[9] && drow[9].value) || '', (drow[10] && drow[10].value) || '', batchNow, batchNow, targetId]
              );
              await tursoFetch("DELETE FROM submissions WHERE id = ?", [ids[bi]]);
            } else {
              await tursoFetch(
                "UPDATE submissions SET status = 'approved', reviewed_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
                [batchNow, batchNow, ids[bi]]
              );
            }
          }
        } else {
          // Rejecting a draft just rejects the draft row; the original stays
          // approved, so no merge/delete is needed.
          var rejectSql = "UPDATE submissions SET status = 'rejected', reviewed_at = ?, reject_reason = ? WHERE id IN (" + placeholders + ")";
          var rejectArgs = [batchNow, batchReason].concat(ids);
          await tursoFetch(rejectSql, rejectArgs);
        }

        return res.status(200).json({ ok: true, processed: ids.length });
      }

      // Admin inline edit: update text fields, resolve streetview from link, force approved
      if (action === 'edit') {
        const { name, description, detailed_description, tags, link } = req.body;

        if (!id || !name || name.trim() === '') {
          return res.status(400).json({ error: 'Missing id or name' });
        }

        var sv;
        try {
          sv = await resolveStreetview(link || '');
        } catch(e) {
          sv = { lat: 0, lng: 0, heading: 0, pitch: 0, fov: 90 };
        }

        var tagsStr = Array.isArray(tags) ? JSON.stringify(tags) : (typeof tags === 'string' ? tags : '[]');
        var detailDesc = (detailed_description || '').trim();
        var editNow = new Date().toISOString();

        // Check if this is a draft row and get current status
        var rowResult = await tursoFetch(
          "SELECT edit_target_id, country_id, status, geojson, source_type, source_url FROM submissions WHERE id = ?",
          [id]
        );
        var targetId = (rowResult.rows[0] && rowResult.rows[0][0] && rowResult.rows[0][0].value) || null;
        var draftCountry = (rowResult.rows[0] && rowResult.rows[0][1] && rowResult.rows[0][1].value) || null;
        var currentStatus = (rowResult.rows[0] && rowResult.rows[0][2] && rowResult.rows[0][2].value) || 'pending';
        // Draft rows always carry a geojson *value* — real geometry, or the canonical empty
        // array '[]' for a country-scope meta — so copying it here preserves the user's
        // redrawn polygon/line/point/arrow changes, and is a no-op for country scope.
        // (`scope` itself is deliberately not copied here: it is immutable, so the target
        // already holds the right value.)
        var draftGeojson = (rowResult.rows[0] && rowResult.rows[0][3] && rowResult.rows[0][3].value != null) ? rowResult.rows[0][3].value : null;
        // The admin edit form has no source controls, so the source must be copied
        // from the draft row — otherwise the attribution the user filled in would
        // silently vanish the moment an admin approves their draft.
        var draftSourceType = (rowResult.rows[0] && rowResult.rows[0][4] && rowResult.rows[0][4].value) || '';
        var draftSourceUrl = (rowResult.rows[0] && rowResult.rows[0][5] && rowResult.rows[0][5].value) || '';
        var wasApproved = (currentStatus === 'approved');

        if (targetId) {
          // Draft row: update the original submission (always an edit, never a first review)
          // 这一处原本不写 reviewed_at —— 首次通过时间同样只在为空时才落笔。
          await tursoFetch(
            "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, geojson = ?, link = ?, streetview = ?, country_id = ?, source_type = ?, source_url = ?, status = 'approved', edited_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
            [name.trim(), (description || '').trim(), detailDesc, tagsStr, draftGeojson, (link || '').trim(), JSON.stringify(sv), draftCountry || 'south-africa', draftSourceType, draftSourceUrl, editNow, editNow, targetId]
          );
          await tursoFetch("DELETE FROM submissions WHERE id = ?", [id]);
          return res.status(200).json({ success: true, streetview: sv, merged: true });
        }

        // Normal (non-draft) inline edit
        if (wasApproved) {
          // Edit of already-approved submission: only bump edited_at.
          // source_type/source_url are deliberately NOT in this UPDATE: SQL only
          // updates the listed columns, so omitting them preserves the existing
          // values. The admin form has no source controls — this is intentional,
          // not an omission. Do not "fix" it by adding source columns here.
          await tursoFetch(
            "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, link = ?, streetview = ?, edited_at = ? WHERE id = ?",
            [name.trim(), (description || '').trim(), detailDesc, tagsStr, (link || '').trim(), JSON.stringify(sv), editNow, id]
          );
        } else {
          // First-time approval via edit: bump reviewed_at (triggers status_change notification).
          // source_type/source_url are deliberately NOT in this UPDATE — same reason
          // as above: omitting a column leaves the stored value untouched.
          await tursoFetch(
            "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, link = ?, streetview = ?, status = 'approved', reviewed_at = ?, edited_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
            [name.trim(), (description || '').trim(), detailDesc, tagsStr, (link || '').trim(), JSON.stringify(sv), editNow, editNow, editNow, id]
          );
        }

        return res.status(200).json({ success: true, streetview: sv });
      }

      if (!id || !status) {
        return res.status(400).json({ error: 'Missing id or status' });
      }

      var allowedStatuses = ['approved', 'rejected', 'pending'];
      if (allowedStatuses.indexOf(status) === -1) {
        return res.status(400).json({ error: 'Invalid status' });
      }

      const now = new Date().toISOString();

      // If approving a draft row (has edit_target_id), copy data to original + delete draft
      if (status === 'approved') {
        var draftResult = await tursoFetch(
          "SELECT edit_target_id, name, description, tags, geojson, streetview, link, country_id, detailed_description, source_type, source_url FROM submissions WHERE id = ?",
          [id]
        );
        var drow = draftResult.rows[0];
        if (!drow) {
          return res.status(404).json({ error: 'Submission not found' });
        }
        var editTargetId = drow[0] ? drow[0].value : null;

        if (editTargetId) {
          // Copy draft data to original row
          var newName = drow[1].value;
          var newDesc = drow[2].value;
          var newTags = drow[3].value;
          var newGeojson = drow[4].value;
          var newStreetview = drow[5].value;
          var newLink = drow[6].value;
          var newCountry = drow[7] ? drow[7].value : 'south-africa';
          var newDetailDesc = drow[8] ? drow[8].value : '';
          var newSourceType = (drow[9] && drow[9].value) || '';
          var newSourceUrl = (drow[10] && drow[10].value) || '';

          // 合并进原行 —— 同样是可能发生在一条已通过区域上的 resubmit。
          await tursoFetch(
            "UPDATE submissions SET name = ?, description = ?, detailed_description = ?, tags = ?, geojson = ?, streetview = ?, link = ?, country_id = ?, source_type = ?, source_url = ?, status = 'approved', reviewed_at = ?, is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?) WHERE id = ?",
            [newName, newDesc, newDetailDesc, newTags, newGeojson, newStreetview, newLink, newCountry, newSourceType, newSourceUrl, now, now, editTargetId]
          );

          // Delete the draft row
          await tursoFetch("DELETE FROM submissions WHERE id = ?", [id]);

          return res.status(200).json({ success: true, merged: true });
        }
      }

      // Normal status update (for non-draft rows, or reject). Approving un-hides
      // the submission so an approved item is always visible (is_hidden = 0).
      var statusSql = 'UPDATE submissions SET status = ?, reviewed_at = ?';
      var statusArgs = [status, now];
      if (status === 'approved') {
        // first_approved_at 的参数必须 push 在 id 之前 —— 拼接出来的占位符顺序就是参数顺序。
        statusSql += ', is_hidden = 0, first_approved_at = COALESCE(first_approved_at, ?)';
        statusArgs.push(now);
      }
      statusSql += ' WHERE id = ?';
      statusArgs.push(id);
      await tursoFetch(statusSql, statusArgs);
      // Store reject reason if provided
      if (status === 'rejected' && req.body.reason && String(req.body.reason).trim()) {
        await tursoFetch("UPDATE submissions SET reject_reason = ? WHERE id = ?", [String(req.body.reason).trim(), id]);
      }

      // Diagnostic: verify the update actually took effect
      var verifyResult = await tursoFetch(
        "SELECT id, status FROM submissions WHERE id = ?",
        [id]
      );
      var vrow = verifyResult.rows[0];
      var actualStatus = vrow ? (vrow[1] ? vrow[1].value : '(null)') : 'NOT FOUND';

      return res.status(200).json({ success: true, verified: actualStatus });
    }

    if (req.method === 'DELETE') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('review_deletes', 'user_id', user.id, 'created_at', 15, 1, true)) return res.status(429).json({ error: 'Too many deletions. Slow down.' });
      const id = req.query.id;
      if (!id) {
        return res.status(400).json({ error: 'Missing id' });
      }
      // Cascade: delete all draft rows pointing to this submission
      await tursoFetch('DELETE FROM submissions WHERE edit_target_id = ?', [id]);
      await tursoFetch('DELETE FROM reactions WHERE region_id = ?', [id]);
      await tursoFetch('DELETE FROM submissions WHERE id = ?', [id]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('review error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

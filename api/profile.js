const { tursoFetch, tursoBatch, getSessionUser, checkCsrf, uuid, ensureSchema } = require('./_lib/turso.js');

module.exports = async function handler(req, res) {
  var user = await getSessionUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Login required' });
  }

  try {
    await ensureSchema();

    if (req.method === 'GET') {
      // Stats: active breakdown + hidden + trash, in one batch
      var statsResults = await tursoBatch([
        { sql: "SELECT status, COUNT(*) as cnt FROM submissions WHERE user_id = ? AND is_deleted = 0 AND is_hidden = 0 GROUP BY status", args: [user.id] },
        { sql: "SELECT COUNT(*) as cnt FROM submissions WHERE user_id = ? AND is_hidden = 1 AND is_deleted = 0", args: [user.id] },
        { sql: "SELECT COUNT(*) as cnt FROM submissions WHERE user_id = ? AND is_deleted = 1", args: [user.id] }
      ]);

      var stats = { total: 0, approved: 0, pending: 0, rejected: 0, hidden: 0, trash: 0 };
      // Active submissions by status
      (statsResults[0].rows || []).forEach(function(row) {
        var status = row[0].value;
        var cnt = Number(row[1].value) || 0;
        stats[status] = cnt;
      });
      // Hidden count
      stats.hidden = Number((statsResults[1].rows[0] && statsResults[1].rows[0][0].value)) || 0;
      // Trash count
      stats.trash = Number((statsResults[2].rows[0] && statsResults[2].rows[0][0].value)) || 0;
      // Total includes everything
      stats.total = stats.approved + stats.pending + stats.rejected + stats.hidden + stats.trash;

      // Rank: only compute if user qualifies (avoids unnecessary queries for most users)
      var rank = { position: null, total_contributors: 0 };
      if (stats.approved >= 3) {
        // 2nd round trip: batch position + total in one HTTP call
        var rankResults = await tursoBatch([
          { sql: "SELECT COUNT(*) + 1 as position FROM (SELECT user_id, COUNT(*) as cnt FROM submissions WHERE status = 'approved' AND is_deleted = 0 AND is_hidden = 0 GROUP BY user_id HAVING cnt > ?)", args: [stats.approved] },
          { sql: "SELECT COUNT(*) as total FROM (SELECT user_id FROM submissions WHERE status = 'approved' AND is_deleted = 0 AND is_hidden = 0 GROUP BY user_id HAVING COUNT(*) >= 1)", args: [] }
        ]);
        rank.position = Number((rankResults[0].rows[0] && rankResults[0].rows[0][0].value)) || 1;
        rank.total_contributors = Number((rankResults[1].rows[0] && rankResults[1].rows[0][0].value)) || 0;
      }

      // User info from getSessionUser — no extra query needed
      var profileUser = {
        id: user.id,
        username: user.username || '',
        avatar_url: user.avatar_url || '',
        role: user.role || 'user',
        display_name: user.display_name || null
      };

      // Countries this user can write a note for (>=3 approved) + their existing note
      var notes = [];
      try {
        var noteResult = await tursoFetch(
          "SELECT s.country_id, c.name, COUNT(*) as cnt, cn.note, cn.status FROM submissions s JOIN countries c ON c.id = s.country_id LEFT JOIN country_notes cn ON cn.user_id = s.user_id AND cn.country_id = s.country_id WHERE s.user_id = ? AND s.status = 'approved' AND s.is_deleted = 0 AND s.is_hidden = 0 GROUP BY s.country_id HAVING COUNT(*) >= 3 ORDER BY cnt DESC",
          [user.id]
        );
        notes = (noteResult.rows || []).map(function(row) {
          var obj = {};
          noteResult.cols.forEach(function(c, i) {
            var cell = row[i];
            obj[c.name] = (cell && cell.value != null) ? cell.value : '';
          });
          return {
            country_id: obj.country_id,
            name: obj.name || obj.country_id,
            count: Number(obj.cnt) || 0,
            note: obj.note || '',
            status: obj.status || ''
          };
        });
      } catch (e) { /* country_notes table may not exist yet */ }

      return res.status(200).json({ user: profileUser, stats: stats, rank: rank, notes: notes });
    }

    if (req.method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      // --- Country notes ---
      if (req.body && req.body.action === 'note') {
        var noteCountryId = (req.body.country_id || '').trim();
        var noteText = String(req.body.note == null ? '' : req.body.note).trim();
        if (!noteCountryId) return res.status(400).json({ error: 'Missing country_id' });

        var qualResult = await tursoFetch(
          "SELECT COUNT(*) as cnt FROM submissions WHERE user_id = ? AND country_id = ? AND status = 'approved' AND is_deleted = 0 AND is_hidden = 0",
          [user.id, noteCountryId]
        );
        var qualCount = Number((qualResult.rows[0] && qualResult.rows[0][0].value)) || 0;
        if (qualCount < 3) {
          return res.status(400).json({ error: 'You need at least 3 approved submissions in this country to write a note.' });
        }

        if (noteText === '') {
          await tursoFetch("DELETE FROM country_notes WHERE user_id = ? AND country_id = ?", [user.id, noteCountryId]);
          return res.status(200).json({ success: true, note: '', status: null });
        }

        if (noteText.length > 200) {
          return res.status(400).json({ error: 'Note must be 200 characters or fewer.' });
        }

        var isTrusted = (user.role === 'trusted' || user.role === 'admin');
        var noteStatus = isTrusted ? 'approved' : 'pending';
        var now = new Date().toISOString();

        await tursoFetch(
          "INSERT INTO country_notes (id, user_id, country_id, note, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, country_id) DO UPDATE SET note = excluded.note, status = excluded.status, updated_at = excluded.updated_at",
          [uuid(), user.id, noteCountryId, noteText, noteStatus, now, now]
        );

        return res.status(200).json({ success: true, note: noteText, status: noteStatus });
      }

      if (req.body && req.body.action === 'note-delete') {
        var delCountryId = (req.body.country_id || '').trim();
        if (!delCountryId) return res.status(400).json({ error: 'Missing country_id' });
        await tursoFetch("DELETE FROM country_notes WHERE user_id = ? AND country_id = ?", [user.id, delCountryId]);
        return res.status(200).json({ success: true });
      }
      var displayName = (req.body && req.body.display_name) ? String(req.body.display_name).trim() : '';

      if (displayName.length === 0) {
        // Clear display name (revert to Discord username)
        await tursoFetch("UPDATE users SET display_name = NULL WHERE id = ?", [user.id]);
        return res.status(200).json({ success: true, display_name: null });
      }

      if (displayName.length < 2 || displayName.length > 20) {
        return res.status(400).json({ error: 'Display name must be 2–20 characters' });
      }

      await tursoFetch("UPDATE users SET display_name = ? WHERE id = ?", [displayName, user.id]);
      return res.status(200).json({ success: true, display_name: displayName });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('profile error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

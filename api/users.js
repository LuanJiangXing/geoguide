const { tursoFetch, ensureSchema, checkAdmin, checkCsrf, checkRateLimit } = require('./_lib/turso.js');

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    var user = await checkAdmin(req);
    if (!user) {
      return res.status(401).json({ error: 'Admin access required' });
    }

    if (req.method === 'GET') {
      // Audit log view
      if (req.query && req.query.type === 'audit_logs') {
        var logResult = await tursoFetch(
          "SELECT a.id, a.action, a.target_user_id, a.performed_by, a.created_at, COALESCE(NULLIF(u1.display_name,''), u1.username) as admin_name, COALESCE(NULLIF(u2.display_name,''), u2.username) as target_name FROM audit_logs a LEFT JOIN users u1 ON a.performed_by = u1.id LEFT JOIN users u2 ON a.target_user_id = u2.id ORDER BY a.created_at DESC LIMIT 100",
          []
        );
        var logs = logResult.rows.map(function(row) {
          return {
            id: row[0].value,
            action: row[1].value,
            target_user_id: row[2].value,
            performed_by: row[3].value,
            created_at: row[4].value,
            admin_name: (row[5] && row[5].value) || '(unknown)',
            target_name: (row[6] && row[6].value) || '(unknown)',
          };
        });
        return res.status(200).json({ logs: logs });
      }

      var result = await tursoFetch(
        "SELECT id, discord_id, COALESCE(NULLIF(display_name,''), username) as username, avatar_url, role, status, created_at FROM users ORDER BY created_at DESC",
        []
      );

      var users = result.rows.map(function(row) {
        return {
          id: row[0].value,
          discord_id: row[1].value,
          username: row[2].value,
          avatar_url: row[3].value || null,
          role: row[4].value,
          status: (row[5] && row[5].value) || 'active',
          created_at: row[6].value,
        };
      });

      return res.status(200).json({ users: users });
    }

    if (req.method === 'PATCH') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('user_admin', 'user_id', user.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many user admin actions. Slow down.' });
      const { id, status, role } = req.body;

      if (!id) return res.status(400).json({ error: 'Missing id' });
      if (!role && !status) return res.status(400).json({ error: 'Missing role or status' });

      // --- Permission hardening ---

      // Fetch target user's current role and discord_id
      var targetResult = await tursoFetch(
        "SELECT discord_id, role, status FROM users WHERE id = ?",
        [id]
      );
      if (targetResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      var targetRole = targetResult.rows[0][1].value;
      var targetDiscordId = targetResult.rows[0][0].value;

      // Whether this operation would remove admin status from the target
      var removesAdmin = (targetRole === 'admin' && role && role !== 'admin')
                      || (targetRole === 'admin' && status === 'banned');

      // 1. Super admin protection — site owner cannot be modified
      var superAdminDiscordId = (process.env.super_admin_discord_id || '').trim();
      if (superAdminDiscordId && targetDiscordId === superAdminDiscordId) {
        return res.status(403).json({ error: 'Cannot modify the site owner' });
      }

      // Is the actor the super admin? (super admin CAN modify other admins)
      var actorResult = await tursoFetch("SELECT discord_id FROM users WHERE id = ?", [user.id]);
      var actorDiscordId = (actorResult.rows[0] && actorResult.rows[0][0].value) || '';
      var actorIsSuperAdmin = !!(superAdminDiscordId && actorDiscordId === superAdminDiscordId);

      // 2. Admin immunity — admins cannot modify other admins (super admin excepted)
      if (targetRole === 'admin' && !actorIsSuperAdmin) {
        return res.status(403).json({ error: 'Cannot modify another admin' });
      }

      // 2b. Only super admin can promote users to admin
      if (role === 'admin' && targetRole !== 'admin' && !actorIsSuperAdmin) {
        return res.status(403).json({ error: 'Only the site owner can promote users to admin' });
      }

      // 3. Last admin protection — at least one active admin must remain
      if (removesAdmin) {
        var adminCountResult = await tursoFetch(
          "SELECT COUNT(*) as cnt FROM users WHERE role = 'admin' AND (status IS NULL OR status = 'active') AND id != ?",
          [id]
        );
        var adminCount = Number((adminCountResult.rows[0] && adminCountResult.rows[0][0].value)) || 0;
        if (adminCount === 0) {
          return res.status(400).json({ error: 'Cannot remove the last active admin' });
        }
      }

      // Role change
      if (role) {
        var validRoles = ['user', 'trusted', 'admin'];
        if (validRoles.indexOf(role) === -1) {
          return res.status(400).json({ error: 'Invalid role. Must be user, trusted, or admin.' });
        }
        if (id === user.id) {
          return res.status(400).json({ error: 'Cannot change your own role' });
        }
        await tursoFetch("UPDATE users SET role = ? WHERE id = ?", [role, id]);
        try {
          await tursoFetch(
            "INSERT INTO audit_logs (id, action, target_user_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?)",
            [crypto.randomUUID(), 'set_role_' + role, id, user.id, new Date().toISOString()]
          );
        } catch(e) { /* non-critical */ }
        return res.status(200).json({ success: true, role: role });
      }

      // Status change (ban/unban)
      if (status) {
        var validStatuses = ['active', 'banned'];
        if (validStatuses.indexOf(status) === -1) {
          return res.status(400).json({ error: 'Invalid status' });
        }
        if (id === user.id) {
          return res.status(400).json({ error: 'Cannot ban yourself' });
        }
        await tursoFetch(
          "UPDATE users SET status = ? WHERE id = ?",
          [status, id]
        );
        try {
          await tursoFetch(
            "INSERT INTO audit_logs (id, action, target_user_id, performed_by, created_at) VALUES (?, ?, ?, ?, ?)",
            [crypto.randomUUID(), status === 'banned' ? 'ban' : 'unban', id, user.id, new Date().toISOString()]
          );
        } catch(e) { /* non-critical */ }
        return res.status(200).json({ success: true });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('users error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

const { tursoFetch, tursoBatch, ensureSchema, getSessionUser, checkCsrf, checkRateLimit, checkAdminPassword, checkAdmin, uuid, cleanupTrash } = require('./_lib/turso.js');

var BASE_COUNTRIES = [
  { id: 'south-africa',  name: 'South Africa',  flag: 'za',    bounds_sw: [-34.5, 17.0],   bounds_ne: [-22.5, 32.5],   sort_order: 0 },
  { id: 'paraguay',      name: 'Paraguay',       flag: 'py',    bounds_sw: [-27.6, -62.6],  bounds_ne: [-19.3, -54.3],  sort_order: 1 },
  { id: 'canada',        name: 'Canada',         flag: 'ca',    bounds_sw: [36.0, -142.0],  bounds_ne: [73.0, -50.0],   sort_order: 2 },
  { id: 'united-states', name: 'United States',  flag: 'us',    bounds_sw: [24.5, -125.0],  bounds_ne: [49.5, -66.9],   sort_order: 3 },
  { id: 'hawaii',        name: 'Hawaii',         flag: 'us-hi', bounds_sw: [18.5, -160.5],  bounds_ne: [22.5, -154.5],  sort_order: 4 },
  { id: 'turkey',        name: 'Turkey',         flag: 'tr',    bounds_sw: [36.0, 26.0],    bounds_ne: [42.0, 45.0],    sort_order: 5 }
];

module.exports = async function handler(req, res) {
  try {

    await ensureSchema();
    // Trash cleanup is a maintenance DELETE — skip on GET to keep reads fast.
    if (req.method !== 'GET') await cleanupTrash();

    if (req.method === 'GET') {
      var isAdmin = !!(req.query && req.query.admin);
      var whereClause = isAdmin ? '1=1' : "c.active = 1";

      var isSuperAdmin = false;
      if (isAdmin) {
        var adminCheck = await checkAdmin(req);
        if (!adminCheck) {
          return res.status(401).json({ error: 'Admin access required' });
        }
        var superAdminDiscordId = (process.env.super_admin_discord_id || '').trim();
        var actorResult = await tursoFetch("SELECT discord_id FROM users WHERE id = ?", [adminCheck.id]);
        var actorDiscordId = (actorResult.rows[0] && actorResult.rows[0][0].value) || '';
        isSuperAdmin = !!(superAdminDiscordId && actorDiscordId === superAdminDiscordId);
      }

      var result = await tursoFetch(
        "SELECT c.id, c.name, c.flag, c.bounds_sw, c.bounds_ne, c.active, c.sort_order, (SELECT COUNT(*) FROM submissions WHERE country_id = c.id AND status = 'approved' AND is_deleted = 0 AND is_hidden = 0) as region_count FROM countries c WHERE " + whereClause + " ORDER BY c.sort_order ASC",
        []
      );

      // Auto-seed if table is empty (survives even if setup hasn't been run)
      if (result.rows.length === 0) {
        for (var ci = 0; ci < BASE_COUNTRIES.length; ci++) {
          var c = BASE_COUNTRIES[ci];
          await tursoFetch(
            "INSERT OR IGNORE INTO countries (id, name, flag, bounds_sw, bounds_ne, active, sort_order) VALUES (?, ?, ?, ?, ?, 1, ?)",
            [c.id, c.name, c.flag, JSON.stringify(c.bounds_sw), JSON.stringify(c.bounds_ne), String(c.sort_order)]
          );
        }
        // Re-query after seeding
        result = await tursoFetch(
          "SELECT c.id, c.name, c.flag, c.bounds_sw, c.bounds_ne, c.active, c.sort_order, (SELECT COUNT(*) FROM submissions WHERE country_id = c.id AND status = 'approved' AND is_deleted = 0 AND is_hidden = 0) as region_count FROM countries c WHERE " + whereClause + " ORDER BY c.sort_order ASC",
          []
        );
      }

      var countries = result.rows.map(function(row) {
        return {
          id: row[0].value,
          name: row[1].value,
          flag: row[2].value,
          bounds_sw: JSON.parse(row[3].value),
          bounds_ne: JSON.parse(row[4].value),
          active: parseInt(row[5].value) === 1,
          sort_order: parseInt(row[6].value) || 0,
          region_count: parseInt(row[7].value) || 0
        };
      });

      var response = { countries: countries };
      if (isAdmin) {
        response.is_super_admin = isSuperAdmin;
        // Include country/region proposals for the admin review table
        var proposalStatus = (req.query.proposal_status === 'exists') ? 'exists' : 'pending';
        try {
          var proposalResult = await tursoFetch(
            "SELECT cp.proposed_name, cp.proposal_type, COUNT(*) as votes, GROUP_CONCAT(COALESCE(u.display_name, u.username), ', ') as proposers, MAX(cp.created_at) as latest, SUM(CASE WHEN cp.meta_intent = 'provide' THEN 1 ELSE 0 END) as provide_count, SUM(CASE WHEN cp.meta_intent = 'learn' THEN 1 ELSE 0 END) as learn_count, SUM(CASE WHEN cp.meta_intent = 'unknown' THEN 1 ELSE 0 END) as unknown_count FROM country_proposals cp JOIN users u ON cp.user_id = u.id WHERE cp.status = ? GROUP BY cp.proposed_name, cp.proposal_type ORDER BY votes DESC, latest DESC",
            [proposalStatus]
          );
          response.country_proposals = proposalResult.rows.map(function(row) {
            var obj = {};
            proposalResult.cols.forEach(function(c, i) {
              var cell = row[i];
              obj[c.name] = (cell && cell.value != null) ? cell.value : '';
            });
            return {
              proposed_name: obj.proposed_name,
              proposal_type: obj.proposal_type,
              status: proposalStatus,
              votes: parseInt(obj.votes) || 0,
              proposers: obj.proposers || '',
              latest: obj.latest,
              provide_count: parseInt(obj.provide_count) || 0,
              learn_count: parseInt(obj.learn_count) || 0,
              unknown_count: parseInt(obj.unknown_count) || 0
            };
          });
        } catch(e) { response.country_proposals = []; }
      }

      // Countries change rarely — let Vercel's CDN cache the public GET response.
      // 60s freshness + stale-while-revalidate keeps the homepage's first batch fast
      // while still picking up admin edits within a minute.
      if (!isAdmin) {
        res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      }
      return res.status(200).json(response);
    }

    // All mutating methods require admin
    var adminUser = await checkAdmin(req);
    if (!adminUser) {
      return res.status(401).json({ error: 'Admin access required' });
    }

    if (req.method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('country_edits', 'user_id', adminUser.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many country edits. Slow down.' });

      var body = req.body;
      var id = (body.id || '').trim();
      var name = (body.name || '').trim();
      var flag = (body.flag || '').trim();
      var bounds_sw = body.bounds_sw;
      var bounds_ne = body.bounds_ne;
      var active = (body.active === false || body.active === 'false' || body.active === '0') ? 0 : 1;
      var sort_order = (body.sort_order !== undefined && body.sort_order !== '')
        ? (parseInt(body.sort_order) || 0)
        : null;

      if (!id || !name || !bounds_sw || !bounds_ne) {
        return res.status(400).json({ error: 'Missing required fields: id, name, bounds_sw, bounds_ne' });
      }
      if (id.length > 50 || name.length > 100) {
        return res.status(400).json({ error: 'id or name too long' });
      }
      if (!/^[a-z0-9][a-z0-9-]{0,49}$/.test(id)) {
        return res.status(400).json({ error: 'id must be a URL-safe slug (lowercase letters, numbers, hyphens)' });
      }
      if (!Array.isArray(bounds_sw) || bounds_sw.length !== 2 || !Array.isArray(bounds_ne) || bounds_ne.length !== 2) {
        return res.status(400).json({ error: 'bounds_sw and bounds_ne must be [lat, lng] arrays' });
      }

      // Check for duplicate id
      var existing = await tursoFetch("SELECT id FROM countries WHERE id = ?", [id]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Country ID already exists' });
      }

      // Append to the end when no explicit sort_order is given, instead of
      // defaulting to 0 (which collides with the current first country and
      // drops the new country into the second slot).
      if (sort_order === null) {
        var maxResult = await tursoFetch("SELECT COALESCE(MAX(sort_order), 0) as m FROM countries", []);
        sort_order = (parseInt(maxResult.rows[0][0].value) || 0) + 1;
      }

      await tursoFetch(
        "INSERT INTO countries (id, name, flag, bounds_sw, bounds_ne, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [id, name, flag, JSON.stringify(bounds_sw), JSON.stringify(bounds_ne), String(active), String(sort_order)]
      );

      return res.status(200).json({ success: true });
    }

    if (req.method === 'PATCH') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });

      // Batch reorder: { action: 'reorder', order: ['id1', 'id2', ...] }
      if (req.body && req.body.action === 'reorder') {
        if (await checkRateLimit('country_edits', 'user_id', adminUser.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many country edits. Slow down.' });
        var order = req.body.order;
        if (!Array.isArray(order) || order.length === 0) {
          return res.status(400).json({ error: 'Missing order array' });
        }
        if (order.length > 50) {
          return res.status(400).json({ error: 'Too many countries' });
        }
        var stmts = order.map(function(id, idx) {
          return { sql: "UPDATE countries SET sort_order = ? WHERE id = ?", args: [String(idx), id] };
        });
        await tursoBatch(stmts);
        return res.status(200).json({ success: true });
      }

      // Mark a country/region proposal group as "already exists" (or restore to pending)
      if (req.body && req.body.action === 'proposal_set_status') {
        if (await checkRateLimit('country_edits', 'user_id', adminUser.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many country edits. Slow down.' });
        var pName = (req.body.proposed_name || '').trim();
        var pType = req.body.proposal_type;
        var pStatus = req.body.status;
        if (!pName) return res.status(400).json({ error: 'Missing proposed_name' });
        if (pType !== 'country' && pType !== 'region') return res.status(400).json({ error: 'Invalid proposal_type' });
        if (pStatus !== 'exists' && pStatus !== 'pending') return res.status(400).json({ error: 'Invalid status' });
        await tursoFetch("UPDATE country_proposals SET status = ? WHERE proposed_name = ? AND proposal_type = ?", [pStatus, pName, pType]);
        return res.status(200).json({ success: true });
      }

      if (await checkRateLimit('country_edits', 'user_id', adminUser.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many country edits. Slow down.' });

      var patchId = (req.body.id || '').trim();
      if (!patchId) return res.status(400).json({ error: 'Missing id' });

      // Fetch existing
      var existing = await tursoFetch("SELECT * FROM countries WHERE id = ?", [patchId]);
      if (existing.rows.length === 0) {
        return res.status(404).json({ error: 'Country not found' });
      }
      var row = existing.rows[0];

      // Map column index to value — SELECT * returns: id(0), name(1), flag(2), bounds_sw(3), bounds_ne(4), active(5), sort_order(6)
      var cur = {
        name: row[1].value,
        flag: row[2].value,
        bounds_sw: row[3].value,
        bounds_ne: row[4].value,
        active: parseInt(row[5].value),
        sort_order: parseInt(row[6].value)
      };

      var newName = req.body.name !== undefined ? (req.body.name || '').trim() : cur.name;
      var newFlag = req.body.flag !== undefined ? (req.body.flag || '').trim() : cur.flag;
      var newBoundsSw = req.body.bounds_sw !== undefined ? JSON.stringify(req.body.bounds_sw) : cur.bounds_sw;
      var newBoundsNe = req.body.bounds_ne !== undefined ? JSON.stringify(req.body.bounds_ne) : cur.bounds_ne;
      var newActive = req.body.active !== undefined ? (req.body.active && req.body.active !== 'false' && req.body.active !== '0' ? '1' : '0') : String(cur.active);
      var newSortOrder = req.body.sort_order !== undefined ? String(parseInt(req.body.sort_order) || 0) : String(cur.sort_order);

      if (!newName) return res.status(400).json({ error: 'name cannot be empty' });

      // Validate bounds if provided
      if (req.body.bounds_sw !== undefined) {
        if (!Array.isArray(req.body.bounds_sw) || req.body.bounds_sw.length !== 2) {
          return res.status(400).json({ error: 'bounds_sw must be [lat, lng] array' });
        }
      }
      if (req.body.bounds_ne !== undefined) {
        if (!Array.isArray(req.body.bounds_ne) || req.body.bounds_ne.length !== 2) {
          return res.status(400).json({ error: 'bounds_ne must be [lat, lng] array' });
        }
      }

      await tursoFetch(
        "UPDATE countries SET name = ?, flag = ?, bounds_sw = ?, bounds_ne = ?, active = ?, sort_order = ? WHERE id = ?",
        [newName, newFlag, newBoundsSw, newBoundsNe, newActive, newSortOrder, patchId]
      );

      return res.status(200).json({ success: true });
    }

    if (req.method === 'DELETE') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      if (await checkRateLimit('country_edits', 'user_id', adminUser.id, 'created_at', 20, 1, true)) return res.status(429).json({ error: 'Too many country edits. Slow down.' });

      var delId = (req.query.id || '').trim();
      if (!delId) return res.status(400).json({ error: 'Missing id' });

      // Super admin check
      var superAdminDiscordId = (process.env.super_admin_discord_id || '').trim();
      var actorResult = await tursoFetch("SELECT discord_id FROM users WHERE id = ?", [adminUser.id]);
      var actorDiscordId = (actorResult.rows[0] && actorResult.rows[0][0].value) || '';
      var actorIsSuperAdmin = !!(superAdminDiscordId && actorDiscordId === superAdminDiscordId);
      if (!actorIsSuperAdmin) {
        return res.status(403).json({ error: 'Only the site owner can delete countries' });
      }

      // Check for approved submissions
      var subCount = await tursoFetch(
        "SELECT COUNT(*) as cnt FROM submissions WHERE country_id = ? AND status = 'approved'",
        [delId]
      );
      var count = parseInt((subCount.rows[0] && subCount.rows[0][0].value)) || 0;
      if (count > 0) {
        return res.status(400).json({ error: 'Cannot delete country with ' + count + ' approved submissions' });
      }

      await tursoFetch("DELETE FROM countries WHERE id = ?", [delId]);
      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    console.error('countries error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

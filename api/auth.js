const { tursoFetch, ensureSchema, getSessionUser, checkCsrf, uuid, getCookie, sha256 } = require('./_lib/turso.js');

var _adminAuthTableReady = false;

module.exports = async function handler(req, res) {
  try {
    var action = req.query && req.query.action;
    var method = req.method;

    // GET /api/auth?action=login
    if (method === 'GET' && action === 'login') {
      var state = uuid().replace(/-/g, '').substring(0, 16);
      var clientId = process.env.discord_client_id || '';
      var redirectUri = process.env.discord_redirect_uri || '';
      var discordAuthUrl = 'https://discord.com/api/oauth2/authorize'
        + '?client_id=' + encodeURIComponent(clientId)
        + '&redirect_uri=' + encodeURIComponent(redirectUri)
        + '&response_type=code'
        + '&scope=identify'
        + '&state=' + encodeURIComponent(state);

      // Store state in a short-lived cookie for CSRF verification on callback
      res.setHeader('Set-Cookie', 'geoguide_oauth_state=' + state
        + '; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=600');
      res.setHeader('Location', discordAuthUrl);
      return res.status(302).end();
    }

    // GET /api/auth?action=callback&code=XXX&state=YYY
    if (method === 'GET' && action === 'callback') {
      var code = (req.query && req.query.code) || '';
      var stateParam = (req.query && req.query.state) || '';

      // Verify state against cookie to prevent CSRF
      var storedState = getCookie(req.headers.cookie, 'geoguide_oauth_state');
      if (!storedState || storedState !== stateParam) {
        return res.status(400).json({ error: 'Invalid state parameter' });
      }

      if (!code) {
        return res.status(400).json({ error: 'Missing code parameter' });
      }

      // Exchange code for token
      var clientId = process.env.discord_client_id || '';
      var clientSecret = process.env.discord_client_secret || '';
      var redirectUri = process.env.discord_redirect_uri || '';

      var tokenBody = 'client_id=' + encodeURIComponent(clientId)
        + '&client_secret=' + encodeURIComponent(clientSecret)
        + '&grant_type=authorization_code'
        + '&code=' + encodeURIComponent(code)
        + '&redirect_uri=' + encodeURIComponent(redirectUri);

      var tokenRes = await fetch('https://discord.com/api/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenBody,
      });

      if (!tokenRes.ok) {
        console.error('Discord token exchange failed:', tokenRes.status);
        return res.status(502).json({ error: 'Authentication failed' });
      }

      var tokenData = await tokenRes.json();
      var accessToken = tokenData.access_token;

      if (!accessToken) {
        console.error('Discord token exchange: no access_token in response');
        return res.status(502).json({ error: 'Authentication failed' });
      }

      // Get Discord user info
      var userRes = await fetch('https://discord.com/api/users/@me', {
        headers: { 'Authorization': 'Bearer ' + accessToken },
      });

      if (!userRes.ok) {
        console.error('Discord user fetch failed:', userRes.status);
        return res.status(502).json({ error: 'Authentication failed' });
      }

      var discordUser = await userRes.json();
      var discordId = discordUser.id;
      var discordUsername = discordUser.username;
      var avatarUrl = null;

    await ensureSchema();
      if (discordUser.avatar) {
        avatarUrl = 'https://cdn.discordapp.com/avatars/' + discordId + '/' + discordUser.avatar + '.png';
      }

      // Ensure tables exist

      // Upsert user
      var now = new Date().toISOString();
      var newUserId = uuid();

      await tursoFetch(
        "INSERT INTO users (id, discord_id, username, avatar_url, role, status, created_at) VALUES (?, ?, ?, ?, 'user', 'active', ?) ON CONFLICT(discord_id) DO UPDATE SET username = ?, avatar_url = ?, status = 'active'",
        [newUserId, discordId, discordUsername, avatarUrl || '', now, discordUsername, avatarUrl || '']
      );

      // Get the user id (may be existing if upsert updated)
      var userRows = await tursoFetch(
        "SELECT id FROM users WHERE discord_id = ?",
        [discordId]
      );
      var userId = (userRows.rows[0] && userRows.rows[0][0].value) || newUserId;

      // Reject banned users
      var userStatus = await tursoFetch(
        "SELECT status FROM users WHERE id = ?",
        [userId]
      );
      var statusVal = (userStatus.rows[0] && userStatus.rows[0][0].value) || 'active';
      if (statusVal === 'banned') {
        res.setHeader('Set-Cookie', [
          'geoguide_sid=deleted; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
          'geoguide_oauth_state=deleted; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0'
        ]);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(403).send('<!DOCTYPE html><html><head><title>Banned</title><link rel="stylesheet" href="/css/style.css"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="text-align:center;padding:80px 20px"><h1 style="font-family:var(--font-display)">Account Banned</h1><p style="color:var(--ink-faded)">Your account has been banned. Contact an admin if you believe this is a mistake.</p><p><a href="/">Back to home</a></p></body></html>');
      }

      // Create session
      var sessionId = uuid();
      var expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await tursoFetch(
        "INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
        [sessionId, userId, expiresAt, now]
      );

      // CSRF token for double-submit cookie pattern
      var csrfToken = uuid();
      // Set session cookie + csrf cookie + clear state cookie, then redirect home
      var cookies = [
        'geoguide_sid=' + sessionId + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
        'geoguide_csrf=' + csrfToken + '; Secure; SameSite=Lax; Path=/; Max-Age=2592000',
        'geoguide_oauth_state=deleted; HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=0'
      ];
      res.setHeader('Set-Cookie', cookies);
      res.setHeader('Location', '/');
      return res.status(302).end();
    }

    // GET /api/auth?action=me
    if (method === 'GET' && action === 'me') {
      var meUser = await getSessionUser(req);
      // Ensure CSRF cookie exists for existing sessions (backfill)
      var existingCsrf = getCookie(req.headers.cookie, 'geoguide_csrf');
      if (meUser && !existingCsrf) {
        var newCsrf = uuid();
        res.setHeader('Set-Cookie', 'geoguide_csrf=' + newCsrf + '; Secure; SameSite=Lax; Path=/; Max-Age=2592000');
      }
      return res.status(200).json({ user: meUser });
    }

    // POST /api/auth { action: "logout" }
    if (method === 'POST') {
      if (!checkCsrf(req)) return res.status(403).json({ error: 'Invalid CSRF token' });
      var body = typeof req.body === 'object' ? req.body : {};
      var bodyAction = body.action;

      if (bodyAction === 'logout') {
        var sid = getCookie(req.headers.cookie, 'geoguide_sid');

        if (sid) {
          try {
            await tursoFetch("DELETE FROM sessions WHERE id = ?", [sid]);
          } catch(e) { /* session may not exist */ }
        }

        var clearCookie = 'geoguide_sid=deleted'
          + '; HttpOnly'
          + '; Secure'
          + '; SameSite=Lax'
          + '; Path=/'
          + '; Max-Age=0';

        res.setHeader('Set-Cookie', clearCookie);
        return res.status(200).json({ ok: true });
      }

      if (bodyAction === 'admin-auth') {
        var password = body.password ? String(body.password) : '';
        var adminPw = process.env.admin_password;
        if (!adminPw) return res.status(500).json({ error: 'Admin password not configured' });

        var me = await getSessionUser(req);
        if (!me || me.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });

        // Rate limit: max 5 FAILED admin-auth attempts per user per 10 minutes
        if (!_adminAuthTableReady) {
          _adminAuthTableReady = true;
          // One-time cleanup: remove attempts recorded by old logic (which counted successes too)
        }
        var rateWindow = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        var rateResult = await tursoFetch(
          "SELECT COUNT(*) as cnt FROM admin_auth_attempts WHERE user_id = ? AND created_at > ?",
          [me.id, rateWindow]
        );
        var attemptCount = Number((rateResult.rows[0] && rateResult.rows[0][0].value)) || 0;
        if (attemptCount >= 5) {
          return res.status(429).json({ error: 'Too many attempts. Please wait 10 minutes.' });
        }

        if (password !== adminPw) {
          // Record failed attempt
          await tursoFetch(
            "INSERT INTO admin_auth_attempts (user_id, created_at) VALUES (?, ?)",
            [me.id, new Date().toISOString()]
          );
          return res.status(403).json({ error: 'Invalid admin password' });
        }

        // Clear failed attempts on success
        await tursoFetch("DELETE FROM admin_auth_attempts WHERE user_id = ?", [me.id]);

        var key = await sha256(adminPw + ':' + me.id);
        res.setHeader('Set-Cookie',
          'geoguide_admin_key=' + key +
          '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=86400'
        );
        return res.status(200).json({ success: true });
      }

      return res.status(400).json({ error: 'Unknown action' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (e) {
    console.error('auth error:', e.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

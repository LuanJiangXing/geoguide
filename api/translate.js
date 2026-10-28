/**
 * DeepSeek translate proxy — POST /api/translate
 *
 * Request:  { text: string, target: 'zh' | 'en' }
 * Response: { translated: string }  |  { error: string }
 */

const { checkCsrf, getSessionUser, checkRateLimit } = require('./_lib/turso.js');

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const TIMEOUT_MS = 5000;

module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Auth
    var user = await getSessionUser(req);
    if (!user) {
      return res.status(401).json({ error: 'Login required' });
    }

    // CSRF
    var csrfOk = checkCsrf(req);
    if (!csrfOk) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }

    // Validate input
    var text = (req.body && req.body.text || '').trim();
    var target = (req.body && req.body.target || '').trim();

    if (!text || text.length === 0) {
      return res.status(400).json({ error: 'Text is required' });
    }
    if (text.length > 2000) {
      return res.status(400).json({ error: 'Text too long (max 2000 characters)' });
    }
    if (target !== 'zh' && target !== 'en') {
      return res.status(400).json({ error: 'Target must be "zh" or "en"' });
    }

    // Rate limit: 10 per minute per user
    var limited = await checkRateLimit('translate', 'user_id', user.id, 'created_at', 10, 1, true);
    if (limited) {
      return res.status(429).json({ error: 'Too many requests. Try again later.' });
    }

    // Build prompt
    var langName = target === 'zh' ? 'Chinese' : 'English';
    var systemPrompt = 'You are a translator. Translate the following text to ' + langName
      + '. Only return the translation, no explanations, no notes, no quotation marks.';

    // Call DeepSeek
    var controller = new AbortController();
    var timeoutId = setTimeout(function() { controller.abort(); }, TIMEOUT_MS);

    var dsRes;
    try {
      dsRes = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + DEEPSEEK_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: text }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }

    if (!dsRes.ok) {
      console.error('DeepSeek API error:', dsRes.status);
      return res.status(502).json({ error: 'Translation service unavailable' });
    }

    var data = await dsRes.json();
    var translated = (data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content || '').trim();

    if (!translated) {
      return res.status(502).json({ error: 'Empty translation result' });
    }

    return res.status(200).json({ translated: translated });
  } catch (e) {
    if (e.name === 'AbortError') {
      return res.status(504).json({ error: 'Translation timed out' });
    }
    console.error('translate handler error:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

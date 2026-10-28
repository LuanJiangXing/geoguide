const fs = require('fs');
const path = require('path');
const { tursoFetch, normalizeStreetview, extractPanoId } = require('./turso.js');

const DEFAULT_DESCRIPTION = 'Explore more region-guessing META on GeoGuide.';

/**
 * Format and intelligently truncate the title so it displays cleanly in social embeds.
 * Caps the point name at ~52 chars (with word boundary truncation) so the full title
 * with ' | GeoGuide' remains <= 65 chars (at most 2 lines in Discord).
 */
function formatOgTitle(rawName) {
  var name = stripMarkdown(rawName || 'Region', 100).trim();
  var maxNameLen = 52;
  if (name.length > maxNameLen) {
    var cut = name.lastIndexOf(' ', maxNameLen - 3);
    if (cut > maxNameLen * 0.6) {
      name = name.slice(0, cut) + '...';
    } else {
      name = name.slice(0, maxNameLen - 3) + '...';
    }
  }
  return name + ' | GeoGuide';
}

/**
 * HTML attribute and text escaper.
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Strip Markdown formatting and clean up text for meta description tags.
 */
function stripMarkdown(text, maxLength) {
  if (!text) return '';
  maxLength = maxLength || 180;
  var s = String(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#+\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (s.length <= maxLength) return s;
  var cut = s.lastIndexOf(' ', maxLength);
  if (cut > maxLength * 0.7) {
    return s.slice(0, cut) + '...';
  }
  return s.slice(0, maxLength) + '...';
}

/**
 * Resolve an image URL for the Street View location.
 * Uses square 1:1 aspect ratio (w=600&h=600) for balanced right-side thumbnail cards.
 */
function resolveStreetViewImageUrl(svRaw, origin, rawLink) {
  var svData = svRaw;
  if (typeof svData === 'string') {
    try { svData = JSON.parse(svData || '{}'); } catch (e) { svData = {}; }
  }
  var sv = null;
  if (Array.isArray(svData)) {
    sv = svData.find(function(item) { return item && (item.pano || item.pano_id || item.panoid); }) || svData[0];
  } else {
    sv = svData;
  }

  // 1. Panorama ID: check sv object or extract from rawLink
  var pano = sv ? (sv.pano || sv.pano_id || sv.panoid) : null;
  if (!pano && rawLink) {
    pano = extractPanoId(rawLink);
  }

  if (pano && typeof pano === 'string') {
    var yaw = (sv && Number(sv.heading)) || 0;
    var pitch = (sv && Number(sv.pitch)) || 0;
    return 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid='
      + encodeURIComponent(pano)
      + '&cb_client=maps_sv.tactile&w=600&h=600&yaw=' + yaw + '&pitch=' + pitch;
  }

  // 2. Lat/Lng static streetview (if coordinates and key exist)
  if (sv && typeof sv.lat === 'number' && typeof sv.lng === 'number' && (sv.lat !== 0 || sv.lng !== 0)) {
    var apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (apiKey) {
      return 'https://maps.googleapis.com/maps/api/streetview?size=600x600'
        + '&location=' + encodeURIComponent(sv.lat + ',' + sv.lng)
        + '&heading=' + (Number(sv.heading) || 0)
        + '&pitch=' + (Number(sv.pitch) || 0)
        + '&fov=90&key=' + encodeURIComponent(apiKey);
    }
  }

  return origin + '/images/icon-512.png';
}

/**
 * Generate full HTML response with Open Graph and Twitter Card tags.
 * Default is 'summary' with 1:1 square image (600x600), positioning Street View
 * neatly on the right side without letterboxing into a tiny strip.
 */
function renderOgHtml(options) {
  var title = options.title || 'GeoGuide';
  var description = options.description || DEFAULT_DESCRIPTION;
  var origin = options.origin || 'https://geoguide-gamma.vercel.app';
  var imageUrl = options.imageUrl || (origin + '/images/icon-512.png');
  var canonicalUrl = options.canonicalUrl || (origin + '/explore');
  var themeColor = options.themeColor || '#4A7C59';
  var cardType = options.cardType || 'summary';

  var descTags = '';
  if (description) {
    descTags = '  <meta name="description" content="' + escapeHtml(description) + '">\n'
      + '  <meta property="og:description" content="' + escapeHtml(description) + '">\n'
      + '  <meta name="twitter:description" content="' + escapeHtml(description) + '">\n';
  }

  return '<!DOCTYPE html>\n'
    + '<html lang="en">\n'
    + '<head>\n'
    + '  <meta charset="UTF-8">\n'
    + '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    + '  <title>' + escapeHtml(title) + '</title>\n'
    + descTags
    + '  <!-- Brand Favicon & Icons -->\n'
    + '  <link rel="icon" type="image/svg+xml" href="' + escapeHtml(origin) + '/favicon.svg">\n'
    + '  <link rel="icon" type="image/png" sizes="32x32" href="' + escapeHtml(origin) + '/images/icon-32.png">\n'
    + '  <link rel="icon" type="image/png" sizes="192x192" href="' + escapeHtml(origin) + '/images/icon-192.png">\n'
    + '  <link rel="apple-touch-icon" href="' + escapeHtml(origin) + '/images/icon-192.png">\n'
    + '\n'
    + '  <!-- Open Graph / Discord / Facebook / Telegram -->\n'
    + '  <meta property="og:site_name" content="GeoGuide">\n'
    + '  <meta property="og:type" content="website">\n'
    + '  <meta property="og:title" content="' + escapeHtml(title) + '">\n'
    + '  <meta property="og:url" content="' + escapeHtml(canonicalUrl) + '">\n'
    + '  <meta property="og:image" content="' + escapeHtml(imageUrl) + '">\n'
    + '  <meta property="og:image:width" content="600">\n'
    + '  <meta property="og:image:height" content="600">\n'
    + '\n'
    + '  <!-- Twitter Card: summary for balanced right-side thumbnail card -->\n'
    + '  <meta name="twitter:card" content="' + escapeHtml(cardType) + '">\n'
    + '  <meta name="twitter:title" content="' + escapeHtml(title) + '">\n'
    + '  <meta name="twitter:image" content="' + escapeHtml(imageUrl) + '">\n'
    + '\n'
    + '  <!-- Discord Embed Color Bar -->\n'
    + '  <meta name="theme-color" content="' + escapeHtml(themeColor) + '">\n'
    + '\n'
    + '  <!-- Client-side instant redirect for browsers that opened this preview directly -->\n'
    + '  <meta http-equiv="refresh" content="0; url=' + escapeHtml(canonicalUrl) + '">\n'
    + '  <script>window.location.replace(' + JSON.stringify(canonicalUrl) + ');</script>\n'
    + '</head>\n'
    + '<body style="font-family:sans-serif;padding:40px;background:#1a231b;color:#e6f4ea;text-align:center;">\n'
    + '  <p style="font-size:18px;">Opening <a href="' + escapeHtml(canonicalUrl) + '" style="color:#8dbf9a;text-decoration:underline;">' + escapeHtml(title) + '</a>...</p>\n'
    + '</body>\n'
    + '</html>';
}

/**
 * Handle social crawler Open Graph request.
 */
async function handleOgPreview(req, res) {
  try {
    var regionId = (req.query && (req.query.region || req.query.id) || '').trim();
    var countryId = (req.query && req.query.country || '').trim();

    var proto = req.headers['x-forwarded-proto'] || 'https';
    var host = req.headers['x-forwarded-host'] || req.headers.host || 'geoguide-gamma.vercel.app';
    var origin = proto + '://' + host;

    // 1. If regionId is provided, query the specific submission
    if (regionId) {
      var regionResult = await tursoFetch(
        "SELECT s.id, s.name, s.description, s.detailed_description, s.streetview, s.country_id, s.link FROM submissions s WHERE s.id = ? AND s.is_deleted = 0",
        [regionId]
      );

      if (regionResult.rows.length > 0) {
        var row = regionResult.rows[0];
        var rawName = row[1].value || 'Region';
        var svRaw = row[4].value || '';
        var rowCountryId = (row[5] && row[5].value) || countryId || '';
        var rawLink = (row[6] && row[6].value) || '';

        // 格式：超长智能截断标题 -> [点位名称] | GeoGuide
        var title = formatOgTitle(rawName);

        // Check if submission has street view or pano
        var hasSv = false;
        try {
          var parsedSv = typeof svRaw === 'string' ? JSON.parse(svRaw || '{}') : svRaw;
          if (Array.isArray(parsedSv)) {
            hasSv = parsedSv.some(function(item) { return item && (item.pano || item.lat); });
          } else if (parsedSv && (parsedSv.pano || parsedSv.lat)) {
            hasSv = true;
          }
        } catch (e) {}
        if (!hasSv && rawLink && extractPanoId(rawLink)) {
          hasSv = true;
        }

        var imageUrl = hasSv
          ? (origin + '/images/og/' + encodeURIComponent(regionId) + '.jpg')
          : (origin + '/images/icon-512.png');
        var canonicalUrl = origin + '/explore?country=' + encodeURIComponent(rowCountryId) + '&region=' + encodeURIComponent(regionId);

        var html = renderOgHtml({
          title: title,
          description: DEFAULT_DESCRIPTION,
          imageUrl: imageUrl,
          canonicalUrl: canonicalUrl,
          origin: origin,
          cardType: 'summary'
        });

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
        return res.status(200).send(html);
      }
    }

    // 2. If countryId is provided (without regionId or region not found)
    if (countryId) {
      var countryResult = await tursoFetch(
        "SELECT name FROM countries WHERE id = ?",
        [countryId]
      );
      var rawCName = (countryResult.rows.length > 0 && countryResult.rows[0][0].value) || (countryId.charAt(0).toUpperCase() + countryId.slice(1));
      var cTitle = formatOgTitle(rawCName);
      var cCanonical = origin + '/explore?country=' + encodeURIComponent(countryId);

      var cHtml = renderOgHtml({
        title: cTitle,
        description: DEFAULT_DESCRIPTION,
        imageUrl: origin + '/images/icon-512.png',
        canonicalUrl: cCanonical,
        origin: origin,
        cardType: 'summary'
      });

      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
      return res.status(200).send(cHtml);
    }

    // 3. Fallback for general Explore page
    var defaultHtml = renderOgHtml({
      title: 'Explore | GeoGuide',
      description: DEFAULT_DESCRIPTION,
      imageUrl: origin + '/images/icon-512.png',
      canonicalUrl: origin + '/explore',
      origin: origin,
      cardType: 'summary'
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    return res.status(200).send(defaultHtml);
  } catch (err) {
    console.error('handleOgPreview error:', err);
    var errOrigin = 'https://geoguide-gamma.vercel.app';
    var errHtml = renderOgHtml({
      title: 'Explore | GeoGuide',
      description: DEFAULT_DESCRIPTION,
      imageUrl: errOrigin + '/images/icon-512.png',
      canonicalUrl: errOrigin + '/explore',
      origin: errOrigin,
      cardType: 'summary'
    });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).send(errHtml);
  }
}

/**
 * Proxy and cache Street View thumbnail images for Discord / social embeds.
 * Requests a square 1:1 image (w=600&h=600) so Discord renders a full square thumbnail on the right.
 * GET /images/og/:region.jpg -> /api/submissions?action=image&region=:region
 */
async function handleOgImage(req, res) {
  var rawRegion = (req.query && (req.query.region || req.query.path || req.query.id) || '').trim();
  var regionId = rawRegion.replace(/\.(jpg|jpeg|png|webp)$/i, '');

  var proto = req.headers['x-forwarded-proto'] || 'https';
  var host = req.headers['x-forwarded-host'] || req.headers.host || 'geoguide-gamma.vercel.app';
  var origin = proto + '://' + host;

  function serveFallback() {
    try {
      var fallbackPath = path.join(process.cwd(), 'public', 'images', 'icon-512.png');
      if (!fs.existsSync(fallbackPath)) {
        fallbackPath = path.join(__dirname, '..', '..', 'public', 'images', 'icon-512.png');
      }
      if (fs.existsSync(fallbackPath)) {
        var buf = fs.readFileSync(fallbackPath);
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
        return res.status(200).send(buf);
      }
    } catch (e) {
      console.warn('serveFallback read error:', e.message);
    }
    return res.redirect(302, origin + '/images/icon-512.png');
  }

  if (!regionId) {
    return serveFallback();
  }

  try {
    var regionResult = await tursoFetch(
      "SELECT streetview, link FROM submissions WHERE id = ? AND is_deleted = 0",
      [regionId]
    );

    if (!regionResult.rows || regionResult.rows.length === 0) {
      return serveFallback();
    }

    var row = regionResult.rows[0];
    var svRaw = row[0].value || '';
    var rawLink = (row[1] && row[1].value) || '';

    var svData = svRaw;
    if (typeof svData === 'string') {
      try { svData = JSON.parse(svData || '{}'); } catch (e) { svData = {}; }
    }
    var sv = null;
    if (Array.isArray(svData)) {
      sv = svData.find(function(item) { return item && (item.pano || item.pano_id || item.panoid); }) || svData[0];
    } else {
      sv = svData;
    }

    var pano = sv ? (sv.pano || sv.pano_id || sv.panoid) : null;
    if (!pano && rawLink) {
      pano = extractPanoId(rawLink);
    }

    var googleUrl = null;
    if (pano && typeof pano === 'string') {
      var yaw = (sv && Number(sv.heading)) || 0;
      var pitch = (sv && Number(sv.pitch)) || 0;
      // 1:1 square thumbnail (600x600) fully fills Discord right-side thumbnail frame
      googleUrl = 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid='
        + encodeURIComponent(pano)
        + '&cb_client=maps_sv.tactile&w=600&h=600&yaw=' + yaw + '&pitch=' + pitch;
    } else if (sv && typeof sv.lat === 'number' && typeof sv.lng === 'number' && (sv.lat !== 0 || sv.lng !== 0)) {
      var apiKey = process.env.GOOGLE_MAPS_API_KEY;
      if (apiKey) {
        googleUrl = 'https://maps.googleapis.com/maps/api/streetview?size=600x600'
          + '&location=' + encodeURIComponent(sv.lat + ',' + sv.lng)
          + '&heading=' + (Number(sv.heading) || 0)
          + '&pitch=' + (Number(sv.pitch) || 0)
          + '&fov=90&key=' + encodeURIComponent(apiKey);
      }
    }

    if (!googleUrl) {
      return serveFallback();
    }

    // Fetch Street View thumbnail with 3.5s timeout and browser headers
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 3500);

    var gRes = await fetch(googleUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.google.com/'
      },
      signal: controller.signal
    });
    clearTimeout(timer);

    if (gRes.ok) {
      var contentType = gRes.headers.get('content-type') || 'image/jpeg';
      if (contentType.startsWith('image/')) {
        var arrayBuf = await gRes.arrayBuffer();
        var buffer = Buffer.from(arrayBuf);
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400');
        return res.status(200).send(buffer);
      }
    }

    return serveFallback();
  } catch (err) {
    console.error('handleOgImage error:', err.message || err);
    return serveFallback();
  }
}

module.exports = {
  formatOgTitle: formatOgTitle,
  stripMarkdown: stripMarkdown,
  escapeHtml: escapeHtml,
  resolveStreetViewImageUrl: resolveStreetViewImageUrl,
  renderOgHtml: renderOgHtml,
  handleOgPreview: handleOgPreview,
  handleOgImage: handleOgImage
};

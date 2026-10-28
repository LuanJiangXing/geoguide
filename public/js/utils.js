/**
 * HTML 转义 — 通过 textContent 防 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * Country data — loaded once from /api/countries.
 * window._countryMap: full records keyed by id.
 * countryNames: id → name mapping for backward compatibility.
 */
var countryNames = {};

(function loadCountries() {
  if (typeof window === 'undefined') return;
  fetch('/api/countries')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      var map = {};
      (data.countries || []).forEach(function(c) {
        countryNames[c.id] = c.name;
        map[c.id] = {
          name: c.name,
          flag: c.flag,
          bounds_sw: c.bounds_sw,
          bounds_ne: c.bounds_ne,
          active: c.active,
          sort_order: c.sort_order,
          region_count: c.region_count
        };
      });
      // If API returned empty (table exists but has no rows), use fallback
      if (Object.keys(map).length === 0) throw new Error('Empty countries response');
      window._countryMap = map;
      // Dispatch event so dependent modules know data is ready
      window.dispatchEvent(new CustomEvent('countries-ready', { detail: map }));
    })
    .catch(function(err) {
      console.error('Failed to load countries:', err);
      // No hardcoded fallback — every hardcoded list we've had went stale.
      // Downstream code degrades gracefully with countryNames[cid] || cid.
    });
})();

/**
 * Sort country IDs by sort_order then alphabetically.
 * @param {object} map — { id: { sort_order, ... } }
 * @returns {string[]}
 */
function sortCountryIds(map) {
  return Object.keys(map).sort(function(a, b) {
    var sa = map[a].sort_order != null ? map[a].sort_order : 999;
    var sb = map[b].sort_order != null ? map[b].sort_order : 999;
    if (sa !== sb) return sa - sb;
    return a.localeCompare(b);
  });
}

/**
 * Build a Google Maps Street View embed URL.
 * @param {object} sv — { lat, lng, heading, pitch, fov }
 * @param {string} apiKey
 * @returns {string}
 */
function buildStreetViewUrl(sv, apiKey) {
  var fov = Number(sv.fov) || 90;
  if (fov < 10 || fov > 100) fov = 90;  // Google Embed API requires 10-100
  // A specific panorama ID (e.g. a historical capture) wins over coordinates.
  var target = sv.pano
    ? '&pano=' + encodeURIComponent(sv.pano)
    : '&location=' + encodeURIComponent(sv.lat + ',' + sv.lng);
  return 'https://www.google.com/maps/embed/v1/streetview'
    + '?key=' + encodeURIComponent(apiKey)
    + target
    + '&heading=' + (sv.heading || 0)
    + '&pitch=' + (sv.pitch || 0)
    + '&fov=' + fov;
}

/**
 * Extract the Street View panorama ID from a Google Maps URL (see the server-side
 * twin in api/_lib/turso.js). Historical captures are only reachable via their
 * pano ID, so this is what enables rendering old imagery.
 * @param {string} link
 * @returns {string|null}
 */
function extractPanoId(link) {
  if (!link) return null;
  var m = null;
  // !1s<id> in the data= segment — only on street-view / photo-sphere URLs
  // (place URLs also use !1s for their place ID, so require a SV marker).
  if (/,3a,/.test(link) || /!1e\d/.test(link)) {
    m = link.match(/!1s([^!]+)/);
  }
  // explicit panoid= / pano= query params
  if (!m) m = link.match(/[?&](?:panoid|pano)=([^&]+)/);
  if (!m || !m[1]) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
}

/**
 * Resolve a Google Maps link to Street View coordinates and orientation.
 * Full URLs are parsed client-side instantly. Short links (goo.gl, maps.app.goo.gl)
 * require a server-side redirect follow and need the user to be logged in.
 *
 * @param {string} url
 * @returns {Promise<{lat: number, lng: number, heading: number, pitch: number, fov: number} | null>}
 */
async function resolveLinkUrl(url) {
  if (!url) return null;

  // Client-side regex for full URLs (covers 99% of cases, zero delay, no auth)
  var m = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) {
    var hm = url.match(/([\d.]+)h/);
    var tm = url.match(/([\d.]+)t/);
    var ym = url.match(/([\d.]+)y/);
    var t = tm ? parseFloat(tm[1]) : 90;
    var pano = extractPanoId(url);
    return {
      lat: parseFloat(m[1]),
      lng: parseFloat(m[2]),
      heading: hm ? parseFloat(hm[1]) : 0,
      pitch: parseFloat((t - 90).toFixed(2)),
      fov: ym ? parseFloat(ym[1]) : 90,
      pano: pano || undefined
    };
  }

  // Short link: server-side resolution needed (requires login + CSRF)
  if (!window._csrfToken) return null;

  try {
    var resp = await fetch('/api/submit?action=resolve-link', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': window._csrfToken
      },
      body: JSON.stringify({ link: url })
    });
    if (!resp.ok) return null;
    var data = await resp.json();
    if (data.error || (data.lat === 0 && data.lng === 0)) return null;
    return {
      lat: data.lat,
      lng: data.lng,
      heading: data.heading || 0,
      pitch: data.pitch || 0,
      fov: data.fov || 90,
      pano: data.pano || undefined
    };
  } catch (_) {
    return null;
  }
}

/**
 * 名称显示 — 下划线转空格
 * @param {string} raw
 * @returns {string}
 */
function displayName(raw) {
  return (raw || '').replace(/_/g, ' ');
}

/**
 * 固定调色板（16 色，数组顺序即优先级）：
 *   1) 8 个高饱和、非绿主色（醒目，地图上易辨认）
 *   2) 2 个绿色（避免与植被混淆，颜色紧张时才用）
 *   3) 6 个浅色变体（对比度低，最后才用）
/**
 * 固定调色板（16 色，分级与色族管理）：
 *   1) 8 个高饱和、非绿主色（分为 4 大互斥色族，醒目，地图上易辨认）
 *   2) 2 个绿色备选（避免与植被混淆，严重冲突时才作为保底备选）
 *   3) 6 个浅色变体（对比度低，极值兜底）
 * 相邻色相刻意冷热交替拉开，确保重叠区域视觉上清晰可辨。
 * @returns {Array<{fill: string, stroke: string, h: number, s: number, l: number, tier: number, family: string}>}
 */
function buildPalette() {
  const colors = [
    // 第一层：4 大主色族醒目主色（冷热交替，拉开色相角）
    { h: 0,   s: 70, l: 50, tier: 1, family: 'red' },      // 0: 红
    { h: 216, s: 78, l: 50, tier: 1, family: 'blue' },     // 1: 蓝
    { h: 48,  s: 92, l: 54, tier: 1, family: 'yellow' },   // 2: 黄
    { h: 274, s: 64, l: 56, tier: 1, family: 'purple' },   // 3: 紫
    { h: 28,  s: 86, l: 52, tier: 1, family: 'orange' },   // 4: 橙
    { h: 186, s: 76, l: 46, tier: 1, family: 'cyan' },     // 5: 青
    { h: 320, s: 70, l: 54, tier: 1, family: 'magenta' },  // 6: 品红
    { h: 344, s: 68, l: 52, tier: 1, family: 'rose' },     // 7: 玫红

    // 第二层：绿色（备选，严禁过早提拔，避免与底图植被混淆）
    { h: 140, s: 55, l: 44, tier: 2, family: 'green' },    // 8: 绿
    { h: 96,  s: 55, l: 46, tier: 2, family: 'olive' },    // 9: 橄榄绿

    // 第三层：浅色变体（对比度低，极值兜底）
    { h: 0,   s: 48, l: 70, tier: 3, family: 'light_red' },     // 10
    { h: 216, s: 52, l: 70, tier: 3, family: 'light_blue' },    // 11
    { h: 48,  s: 60, l: 72, tier: 3, family: 'light_yellow' },  // 12
    { h: 274, s: 50, l: 70, tier: 3, family: 'light_purple' },  // 13
    { h: 28,  s: 56, l: 70, tier: 3, family: 'light_orange' },  // 14
    { h: 320, s: 50, l: 70, tier: 3, family: 'light_magenta' }  // 15
  ];
  return colors.map(function(c) {
    return {
      h: c.h,
      s: c.s,
      l: c.l,
      tier: c.tier,
      family: c.family,
      fill: `hsl(${c.h}, ${c.s}%, ${c.l}%)`,
      stroke: `hsl(${c.h}, ${c.s}%, ${Math.max(0, c.l - 16)}%)`
    };
  });
}

/**
 * 把经度 wrap 回 [-180, 180]。
 * 绘图工具在跨越反经线（worldCopyJump 开启时把地图拖到世界副本东侧）会产出
 * [180,360) 甚至更外的经度；Leaflet 渲染矢量时不会自动 wrap，会把线画到
 * 360° 之外的世界副本上而落在屏幕外。对已在 [-180,180] 内的值幂等（原样返回）。
 * @param {number} lng
 * @returns {number}
 */
function wrapLng(lng) {
  if (typeof lng !== 'number' || !isFinite(lng)) return lng;
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

/**
 * 就地递归把 GeoJSON coordinates 里每个坐标对的经度 wrap 回 [-180,180]。
 * 支持 Point / MultiPoint / LineString / MultiLineString / Polygon / MultiPolygon
 * 的嵌套结构。坐标对判定与 regionBBox.walkCoords 一致：数组首元素是数字即坐标对。
 * @param {Array} coords
 * @returns {Array}
 */
function wrapGeoCoordinates(coords) {
  if (!Array.isArray(coords)) return coords;
  if (typeof coords[0] === 'number') {
    coords[0] = wrapLng(coords[0]);
    return coords;
  }
  for (var i = 0; i < coords.length; i++) wrapGeoCoordinates(coords[i]);
  return coords;
}

/**
 * 计算一个 region 所有几何合并后的整体边界框（bbox）。
 * 支持单个 geometry、geometry 数组，以及 GeometryCollection。
 * GeoJSON 坐标为 [lng, lat]。
 * @param {object} geo — region.geojson
 * @returns {{minLng:number,minLat:number,maxLng:number,maxLat:number}|null}
 */
function regionBBox(geo) {
  let geometries;
  if (Array.isArray(geo)) geometries = geo;
  else if (geo && geo.type) geometries = [geo];
  else return null;

  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;

  function walkCoords(coords) {
    if (!Array.isArray(coords) || coords.length === 0) return;
    if (typeof coords[0] === 'number') {
      const lng = wrapLng(coords[0]), lat = coords[1];
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (let i = 0; i < coords.length; i++) walkCoords(coords[i]);
  }

  function walkGeometry(g) {
    if (!g) return;
    if (g.type === 'GeometryCollection') {
      const sub = g.geometries || [];
      for (let i = 0; i < sub.length; i++) walkGeometry(sub[i]);
    } else if (g.coordinates) {
      walkCoords(g.coordinates);
    }
  }

  for (let i = 0; i < geometries.length; i++) walkGeometry(geometries[i]);

  if (minLng === Infinity) return null;
  return { minLng: minLng, minLat: minLat, maxLng: maxLng, maxLat: maxLat };
}

/**
 * 计算一个 region 合并后的地理外接框中心，返回 [lat, lng]。
 * 无法计算时返回 null。用于微小提交「最小圆点」的定位。
 * @param {object} region — 含 geojson 字段
 * @returns {[number, number]|null}
 */
function regionBBoxCenter(region) {
  const bbox = regionBBox(region.geojson);
  if (!bbox) return null;
  return [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];
}

/**
 * 两个边界框是否相交（含边界相切）。
 * @returns {boolean}
 */
function bboxOverlap(a, b) {
  if (!a || !b) return false;
  return a.minLng <= b.maxLng && a.maxLng >= b.minLng &&
         a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

/**
 * 环形色相距离计算（0° ~ 180°）
 */
function hueDistance(h1, h2) {
  var diff = Math.abs(h1 - h2) % 360;
  return diff > 180 ? 360 - diff : diff;
}

// 广义色系（用于重叠冷热互斥）
var TONE_MAP = {
  red: 'warm', orange: 'warm', yellow: 'warm', rose: 'warm',
  blue: 'cool_blue', cyan: 'cool_blue',
  purple: 'cool_purple', magenta: 'cool_purple',
  green: 'green', olive: 'green'
};

/**
 * 贪心为所有 region 分配颜色：
 * 1. 空间相邻/重叠（bbox 相交）的 region 保证不同色，且优先跨色系/色族分配；
 * 2. 多层重叠（3个及以上）极大化色相差，强制冷暖/大色族交替；
 * 3. 绿色严格按需压底，杜绝同色系深浅绿叠加；
 * 4. 按 id 升序（支持数字与 UUID 字符串）贪心，保证跨会话结果 100% 确定。
 * @param {Array} regions
 * @returns {object} id → { fill, stroke }
 */
function assignRegionColors(regions) {
  const palette = buildPalette();
  const colorMap = {};
  const ordered = regions.slice().sort(function(a, b) {
    const sa = String((a && a.id) || '');
    const sb = String((b && b.id) || '');
    return sa.localeCompare(sb);
  });

  const colored = [];  // { bbox, index, color }
  const usage = new Array(palette.length).fill(0);

  ordered.forEach(function(region) {
    const bbox = regionBBox(region.geojson);
    const neighbors = [];
    for (let i = 0; i < colored.length; i++) {
      if (bboxOverlap(bbox, colored[i].bbox)) neighbors.push(colored[i]);
    }

    const forbiddenIndices = {};
    const neighborFamilies = {};
    const neighborTones = {};
    let hasGreenNeighbor = false;

    neighbors.forEach(function(n) {
      forbiddenIndices[n.index] = true;
      const c = palette[n.index];
      if (c) {
        neighborFamilies[c.family] = true;
        const tone = TONE_MAP[c.family] || c.family;
        neighborTones[tone] = true;
        if (c.tier === 2) hasGreenNeighbor = true;
      }
    });

    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < palette.length; i++) {
      // 相同颜色绝对禁止
      if (forbiddenIndices[i]) continue;
      const cand = palette[i];

      // 计算与所有邻居的最小色相距离
      let minHueDiff = 180;
      for (let j = 0; j < neighbors.length; j++) {
        const nc = palette[neighbors[j].index];
        if (nc) {
          const d = hueDistance(cand.h, nc.h);
          if (d < minHueDiff) minHueDiff = d;
        }
      }

      let score = 0;
      // 1. Tier 层级基础分：主色(Tier 1)绝对压制，绿色(Tier 2)和浅色(Tier 3)仅作保底备选
      if (cand.tier === 1) score += 50000;
      else if (cand.tier === 2) score += 5000;
      else score += 0;

      if (neighbors.length > 0) {
        const candTone = TONE_MAP[cand.family] || cand.family;

        // 2. 冷暖/色系完全互斥奖励（确保 3+ 重叠时各层分别落在冷暖不同大类）
        if (!neighborTones[candTone]) {
          score += 20000;
        } else if (!neighborFamilies[cand.family]) {
          score += 8000;
        }

        // 3. 绿色重叠绝对压制（杜绝深绿叠浅绿/黄绿）
        if (cand.tier === 2 && hasGreenNeighbor) {
          score -= 50000;
        }

        // 4. 色相角差惩罚与极大化奖励
        if (minHueDiff < 60) {
          score -= (60 - minHueDiff) * 500;
        } else {
          score += minHueDiff * 20;
        }
      }

      // 5. 微观全局频次平衡（仅在同等级候选色间作为 tie-breaker）
      score -= usage[i] * 5;

      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex === -1) bestIndex = 0; // 极值保底
    colorMap[region.id] = palette[bestIndex];
    usage[bestIndex]++;
    colored.push({ bbox: bbox, index: bestIndex, color: palette[bestIndex] });
  });

  return colorMap;
}

/**
 * Meters per pixel at the current map center and zoom.
 * @param {L.Map} map
 * @returns {number}
 */
function metersPerPixel(map) {
  var center = map.getCenter();
  return 40075016.686 / (256 * Math.pow(2, map.getZoom())) * Math.cos(center.lat * Math.PI / 180);
}

/**
 * Dynamic line weight: ~500m geographic width, clamped to [2, 10] px.
 * @param {L.Map} map
 * @returns {number}
 */
function computeLineWeight(map) {
  return Math.max(2, Math.min(10, Math.round(500 / metersPerPixel(map))));
}

/**
 * 站内共享的图标字形。**只有这一份** —— 同一个图标出现在两个页面时不要再抄一遍
 * path，抄了就会有第三个同步点（本仓库已有 SOURCE_RULES 两份、OSM 瓦片 URL
 * 两个前车之鉴）。`public/my-submissions.html` 的卡片动作行与
 * `public/js/modal.js` 的弹窗 Edit 按钮都读这里，两处必须是**同一支笔**。
 *
 * 造型刻意避开素材站的通用形：笔尖（没有橡皮限位线）、闭合的眼睑（不是
 * 「眼睛 + 斜杠」）、无棱的桶（不是三条竖线）。站内原有的 2px 圆头线稿正是
 * 最典型的「看上去很 AI」的一类，2026-10-01 用户明确要求换掉。
 *
 * 笔法：viewBox 24、无填充、描边走 currentColor、1.8px、圆头圆角。
 * 尺寸由调用方的 CSS 定（卡片动作行 18px）。
 */
var GEOGUIDE_ICONS = {
  view:     '<path d="M3 12c2.6-4.2 5.6-6.2 9-6.2s6.4 2 9 6.2c-2.6 4.2-5.6 6.2-9 6.2S5.6 16.2 3 12z"/><circle cx="12" cy="12" r="2.5"/>',
  edit:     '<path d="M4.5 19.5l.9-3.6L16.2 5.1a2.1 2.1 0 0 1 3 3L8.4 18.9l-3.9.6z"/><path d="M14.6 6.7l3 3"/>',
  hide:     '<path d="M3 11c2.6 4.2 5.6 6.2 9 6.2s6.4-2 9-6.2"/><path d="M12 17.2V20M5.6 15.4l-1.4 2.3M18.4 15.4l1.4 2.3"/>',
  unhide:   '<path d="M3 12c2.6-4.2 5.6-6.2 9-6.2s6.4 2 9 6.2c-2.6 4.2-5.6 6.2-9 6.2S5.6 16.2 3 12z"/><circle cx="12" cy="12" r="2.5"/>',
  // Delete 与 Delete Forever 共用同一个桶字形，是有意的：两者**永远不会同屏**
  //（前者只在 active/hidden，后者只在 trash），所以不存在混淆。
  delete:   '<path d="M5 7h14M10 7V4.8h4V7M6.6 7l1 12.4a1.6 1.6 0 0 0 1.6 1.4h5.6a1.6 1.6 0 0 0 1.6-1.4L17.4 7"/>',
  restore:  '<path d="M5.6 8.4A8 8 0 1 1 4 13.6"/><path d="M4.8 3.6v5.2h5.2"/>',
  download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.2h14"/>',
  share:    '<path d="M4 17v-1a5 5 0 0 1 5-5h8"/><polyline points="13 7 17 11 13 15"/>',
  logout:   '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'
};

/**
 * 把一个字形包成完整的 `<svg>` 字符串。
 *
 * `kindOrPaths` 传 `GEOGUIDE_ICONS` 的键；也可以直接传一段 path 标记 ——
 * 页面自己独有的字形（如 my-submissions 那个折角纸页）走这条路，
 * 不必为了共用笔法把它塞进共享表。
 *
 * `aria-hidden="true"`：图标一律是装饰，名字由**外层按钮**的 aria-label 承担。
 */
function geoguideIconSvg(kindOrPaths) {
  var paths = GEOGUIDE_ICONS[kindOrPaths] || kindOrPaths || '';
  return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none"'
    + ' stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + paths + '</svg>';
}

/**
 * 六项 reaction 的**唯一真源**。探索弹窗（js/modal.js 的 _renderReactionRow）、
 * 审核页的 flagged 徽章（review.html）、投稿人卡片的计数（my-submissions.html /
 * profile.html）、首页轮播的 👍（index.html）全部从这里取。
 *
 * 顺序 = 界面上的显示顺序。图标是自托管 Twemoji SVG（public/images/twemoji/）——
 * 不用系统 emoji 字体，理由同首页那个 👍（index.html）：各平台画法差别很大。
 *
 * `file` 存的是 codepoint（资产的事实），路径是渲染的决定 —— 两者分开，
 * 于是 `?v=` 缓存版本号只在 reactionIconSrc 一处出现。**不要在各页面自己拼路径。**
 *
 * SERVER TWIN：`api/reactions.js` 的 type 白名单是**另一份硬编码**（服务端是不同
 * 语言，模块无法共享）。加/改类型必须两边同时改，否则请求会被 400 拒绝。
 */
var GEOGUIDE_REACTIONS = [
  // goat 的悬浮提示就是字面的 "GOAT"，不再是那句 "A standout meta — the greatest
  // of all time"：用户明确要的就是 goat = GOAT，多出来的解释反而让这个梗变形。
  { key: 'goat',    file: '1f410', label: 'GOAT',       tooltip: 'GOAT' },
  { key: 'heart',   file: '2764',  label: 'Thanks',     tooltip: 'Thank the contributor for sharing this meta' },
  { key: 'useful',  file: '1f44d', label: 'Useful',     tooltip: 'Accurate and helpful' },
  { key: 'useless', file: '1f44e', label: 'Not Useful', tooltip: 'Correct but not helpful' },
  { key: 'wrong',   file: '274c',  label: 'Improper',   tooltip: 'Contains incomplete or wrong descriptions' },
  { key: 'error',   file: '1f6a7', label: 'Error',      tooltip: 'Technical issue: broken link, wrong location, etc.' }
];

/**
 * reaction 图标的**唯一出口**。不要在各页面自己拼 'images/twemoji/' + file ——
 * 那样搬目录或换缓存版本号时又会各改各的（本仓库在 SOURCE_RULES、OSM 瓦片 URL、
 * GEOGUIDE_ICONS 上已因复制栽过三次）。未知 key 返回空串，调用方自行兜底。
 */
function reactionIconSrc(key) {
  for (var i = 0; i < GEOGUIDE_REACTIONS.length; i++) {
    if (GEOGUIDE_REACTIONS[i].key === key) {
      return 'images/twemoji/' + GEOGUIDE_REACTIONS[i].file + '.svg?v=1';
    }
  }
  return '';
}

/**
 * 把一条带 `<key>_count` 字段的对象（提交行 / 收藏行）渲染成「图标 + 计数」徽章行。
 * **只渲染非零项**；六项全零返回 null，调用方据此整块不渲染（沿用 buildMetaLine
 * 「两端都空则不占高度」的约定）。
 *
 * 两个消费者共用这一份：my-submissions.html 卡片第四行右端、profile.html 的收藏卡。
 * **不要再各写一份** —— 图标路径（reactionIconSrc）与「只显非零」的规则都只在这里。
 *
 * 每格 role="img" + aria-label：图标本身是装饰（alt=""），读屏器要念出「12 Useful」
 * 才有意义。空 span 上挂 aria-label 是无效标注（见 my-submissions-cards spec §3.2）。
 */
function buildReactionCounts(obj) {
  var shown = GEOGUIDE_REACTIONS.filter(function(r) {
    return (Number(obj && obj[r.key + '_count']) || 0) > 0;
  });
  if (!shown.length) return null;

  var wrap = document.createElement('span');
  wrap.className = 'reaction-counts';
  shown.forEach(function(r) {
    var n = Number(obj[r.key + '_count']) || 0;
    var item = document.createElement('span');
    item.className = 'reaction-count reaction-count--' + r.key;
    item.setAttribute('role', 'img');
    item.setAttribute('aria-label', n + ' ' + r.label);
    item.title = n + ' ' + r.label;

    var src = reactionIconSrc(r.key);
    if (src) {
      var img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.setAttribute('aria-hidden', 'true');
      item.appendChild(img);
    }
    var num = document.createElement('span');
    num.className = 'reaction-count__n';
    num.textContent = String(n);
    item.appendChild(num);
    wrap.appendChild(item);
  });
  return wrap;
}

/**
 * Submission source attribution — front-end validation rules.
 *
 * SERVER TWIN: `api/_lib/source.js` holds a byte-for-byte copy of this object
 * (different language, so the module cannot be shared). If you change a regex
 * here you MUST change the twin there. `scripts/test-source-rules-parity.js`
 * extracts the four literals from both files and fails if they drift apart.
 *
 * Only the domain + non-empty path are validated, never the path content.
 */
var SOURCE_RULES = {
  plonkit:  /^https:\/\/(www\.)?plonkit\.net\/\S+$/,
  rmrg:     /^https:\/\/(www\.)?rmrg\.me\/\S+$/,
  geohints: /^https:\/\/(www\.)?geohints\.com\/\S+$/,
  other:    /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/\S+$/i
};

/**
 * Display metadata per source type. `icon` is null for the text-only badges.
 * The icons are self-hosted: the CSP img-src allow-list does not include
 * plonkit.net / rmrg.me, so hot-linking them would be blocked by the browser
 * (same reason the 👍 glyph lives in public/images/, see index.html).
 */
var SOURCE_BADGES = {
  plonkit:  { label: 'Plonk It', icon: 'images/source-plonkit.webp' },
  rmrg:     { label: 'RMRG',     icon: 'images/source-rmrg.png' },
  geohints: { label: 'GeoHints', icon: null },
  other:    { label: 'Source',   icon: null }
};

/**
 * Submission source attribution — build the clickable badge shown wherever a
 * submission's details are rendered (explore modal, homepage Most Useful card,
 * my-submissions, review page).
 *
 * Returns `null` when there is nothing to show, so callers skip the slot
 * entirely instead of leaving an empty placeholder.
 *
 * Never built from a string: text goes through textContent and the url through
 * the `.href` property, so an untrusted url cannot inject markup. The url is
 * additionally re-checked against its type's SOURCE_RULES entry — the server
 * already normalizes/rejects on write (api/_lib/source.js), this is defence in
 * depth so a `javascript:` href can never be rendered even if a bad row were to
 * reach the client.
 *
 * @param {string} sourceType  'plonkit' | 'rmrg' | 'geohints' | 'other' ('' = none)
 * @param {string} sourceUrl   the cited url
 * @returns {Element|null}
 */
function buildSourceBadge(sourceType, sourceUrl) {
  var type = (sourceType == null) ? '' : String(sourceType).trim();
  var url = (sourceUrl == null) ? '' : String(sourceUrl).trim();
  var meta = SOURCE_BADGES[type];
  // No type, unknown type, missing url, or a url that fails its own rule → nothing.
  if (!meta || !url) return null;
  if (!SOURCE_RULES[type] || !SOURCE_RULES[type].test(url)) return null;

  var a = document.createElement('a');
  a.className = 'source-badge source-badge--' + type;
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  // The icon-only variants would otherwise announce as a bare "link".
  a.setAttribute('aria-label', 'Source: ' + meta.label);

  if (meta.icon) {
    var img = document.createElement('img');
    img.className = 'source-badge__icon';
    img.src = meta.icon;
    img.alt = '';
    img.setAttribute('aria-hidden', 'true');
    img.loading = 'lazy';
    // Never leave a broken image: fall back to the text label (same trick as the
    // homepage 👍 icon). An alt="" broken img is visually "nothing at all".
    img.onerror = function() { this.replaceWith(document.createTextNode(meta.label)); };
    a.appendChild(img);
  } else {
    a.appendChild(document.createTextNode(meta.label));
  }
  return a;
}

/**
 * 构造提交（Meta）在 Explore 页面上的直达分享链接。
 * @param {object} item — 包含 id 与 country_id（或 region）的对象
 * @returns {string} 绝对 URL
 */
function buildExploreShareUrl(item) {
  if (!item || !item.id) return '';
  var cid = item.country_id || item.region || 'south-africa';
  return window.location.origin + '/explore?country=' + encodeURIComponent(cid) + '&region=' + encodeURIComponent(item.id);
}

/**
 * 将指定文本复制到系统剪贴板。
 * 优先使用 navigator.clipboard，并在不支持或权限受阻时 fallback 到隐藏 textarea + execCommand。
 * @param {string} text
 * @param {function} [onSuccess]
 * @param {function} [onError]
 */
function copyToClipboard(text, onSuccess, onError) {
  if (!text) {
    if (onError) onError(new Error('Empty text'));
    return;
  }
  if (navigator.clipboard && window.isSecureContext && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).then(function() {
      if (onSuccess) onSuccess();
    }).catch(function() {
      execCopy();
    });
  } else {
    execCopy();
  }

  function execCopy() {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      ta.style.top = '0';
      ta.setAttribute('readonly', '');
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) {
        if (onSuccess) onSuccess();
      } else {
        if (onError) onError(new Error('execCommand failed'));
      }
    } catch (e) {
      if (onError) onError(e);
    }
  }
}

/**
 * 解析标签字符串，支持 "Category:Tag" 与纯 "Tag" 格式。
 * @param {string} t
 * @returns {{ category: string|null, name: string }}
 */
function parseTag(t) {
  if (!t || typeof t !== 'string') return { category: null, name: '' };
  var idx = t.indexOf(':');
  if (idx === -1) return { category: null, name: t.trim() };
  return { category: t.slice(0, idx).trim(), name: t.slice(idx + 1).trim() };
}

/**
 * 获取用于 UI 显示的纯净标签名（去除分类前缀）。
 * @param {string} t
 * @returns {string}
 */
function formatTagName(t) {
  return parseTag(t).name;
}

/**
 * 获取包含分类的完整标签文本（用于 title/tooltip 等辅助展示）。
 * @param {string} t
 * @returns {string}
 */
function formatTagFull(t) {
  var p = parseTag(t);
  return p.category ? (p.category + ': ' + p.name) : p.name;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseTag: parseTag,
    formatTagName: formatTagName,
    formatTagFull: formatTagFull,
    wrapLng: wrapLng,
    wrapGeoCoordinates: wrapGeoCoordinates,
    regionBBox: regionBBox,
    regionBBoxCenter: regionBBoxCenter,
    bboxOverlap: bboxOverlap,
    assignRegionColors: assignRegionColors,
    buildPalette: buildPalette,
    metersPerPixel: metersPerPixel,
    computeLineWeight: computeLineWeight,
    geoguideIconSvg: geoguideIconSvg,
    GEOGUIDE_ICONS: GEOGUIDE_ICONS,
    GEOGUIDE_REACTIONS: GEOGUIDE_REACTIONS,
    reactionIconSrc: reactionIconSrc,
    buildReactionCounts: buildReactionCounts,
    SOURCE_RULES: SOURCE_RULES,
    SOURCE_BADGES: SOURCE_BADGES,
    buildSourceBadge: buildSourceBadge,
    buildExploreShareUrl: buildExploreShareUrl,
    copyToClipboard: copyToClipboard
  };
}

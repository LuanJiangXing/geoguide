/**
 * 地图初始化与区域渲染模块
 * 依赖：utils.js (escapeHtml, displayName, assignRegionColors)
 * 被依赖：modal.js (openModal)
 */

// 模块间共享状态挂载到 window，让 search.js、app.js 也能访问
window._polygonLayers = new Map();   // id → L.GeoJSON layer

// 局部引用
var _polygonLayers = window._polygonLayers;

// 悬停管理（map 级 mousemove 驱动，确定性重算，消除跨图层事件竞态）：
//  _hoverState   —— 当前渲染的悬停内容 { ids, mode, tooltips, styled }
//  _hoverRegions —— renderRegions 时的 regions 引用
//  _hoverLatLng  —— 最近一次指针经纬度（rAF 节流用）
//  _hoverRaf     —— rAF 是否已排程
var _hoverState = null;
var _hoverRegions = [];
var _hoverLatLng = null;
var _hoverRaf = false;
// 最近一次光标的容器坐标（px）。地图 moveend 时用它把「静止光标」换算成新视图下的
// latlng 重算命中——否则只 zoom/pan 不移动鼠标时没有 mousemove，弹窗会残留。
var _hoverContainerPoint = null;

// 弹窗左上角重叠标签栏状态
var _overlapTabsState = {
  repositionBound: false,  // resize 监听是否已绑定
  scrollBound: false,      // 横向滚动（箭头/滚轮/scroll/resize）是否已绑定
  scrollUpdate: null       // setupHorizontalScroll 返回的刷新函数：内容变了刷新箭头显隐
};

/**
 * Ray-casting point-in-polygon. Coords are GeoJSON [lng, lat].
 */
function pointInPolygon(lng, lat, ring) {
  var inside = false;
  for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    var xi = ring[i][0], yi = ring[i][1];
    var xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Check if a lat/lng falls inside any geometry of a region.
 * Handles Polygon and MultiPolygon (area overlap).
 * LineString/MultiLineString overlap is left to Leaflet's built-in
 * hit testing — two overlapping LineStrings are rare in practice.
 */
function regionContainsPoint(region, lat, lng) {
  var geo = region.geojson;
  var geometries = Array.isArray(geo) ? geo : [geo];
  for (var i = 0; i < geometries.length; i++) {
    var g = geometries[i];
    if (!g || !g.type) continue;
    if (g.type === 'Polygon') {
      for (var j = 0; j < g.coordinates.length; j++) {
        if (pointInPolygon(lng, lat, g.coordinates[j])) return true;
      }
    } else if (g.type === 'MultiPolygon') {
      for (var j = 0; j < g.coordinates.length; j++) {
        for (var k = 0; k < g.coordinates[j].length; k++) {
          if (pointInPolygon(lng, lat, g.coordinates[j][k])) return true;
        }
      }
    }
  }
  return false;
}

/**
 * Find all visible region IDs whose geometry covers (lat, lng), excluding excludeId.
 * Returns array of region IDs — empty if none overlap.
 */
function findOverlappingRegions(regions, lat, lng, excludeId) {
  var ids = [];
  for (var i = 0; i < regions.length; i++) {
    var r = regions[i];
    if (r.id === excludeId) continue;
    if (r._countryVisible === false || r._searchVisible === false) continue;
    if (regionContainsPoint(r, lat, lng)) ids.push(r.id);
  }
  return ids;
}

function getCountryBounds(countryId) {
  var c = (window._countryMap || {})[countryId];
  if (c) return [c.bounds_sw, c.bounds_ne];
  return [[-34.5, 17.0], [-22.5, 32.5]]; // fallback: South Africa
}

/**
 * 初始化 Leaflet 地图
 * @param {string} elementId
 * @returns {L.Map}
 */
function initMap(elementId, initialBounds) {
  var opts = { minZoom: 2, zoomSnap: 0.25, worldCopyJump: true };
  // If bounds are provided, pre-compute a center/zoom close to the fitBounds
  // result so the initial render is already near the correct view
  if (initialBounds) {
    opts.center = [
      (initialBounds[0][0] + initialBounds[1][0]) / 2,
      (initialBounds[0][1] + initialBounds[1][1]) / 2
    ];
    opts.zoom = 5; // fallback zoom — fitBounds will correct this
  } else {
    opts.center = [-28.6, 25.0];
    opts.zoom = 6;
  }
  const map = L.map(elementId, opts);

  var osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    noWrap: false
  }).addTo(map);

  // Reset view button
  var ResetControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var btn = L.DomUtil.create('button', 'map-reset-btn');
      btn.innerHTML = '⌂';
      btn.title = 'Reset view';
      btn.setAttribute('aria-label', 'Reset map view');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', function() {
        var bounds = getCountryBounds(_activeRegion);
        map.fitBounds(bounds, { padding: [20, 20] });
      });
      return btn;
    }
  });
  map.addControl(new ResetControl());

  // Contributors overview button
  var ContributorsControl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function() {
      var btn = L.DomUtil.create('button', 'map-contrib-btn');
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>';
      btn.title = 'Contributors';
      btn.setAttribute('aria-label', 'Show contributors for this country');
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, 'click', function() {
        openContributorsPanel(_activeRegion);
      });
      return btn;
    }
  });
  map.addControl(new ContributorsControl());

  // Scale bar (metric)
  L.control.scale({ imperial: false, metric: true, position: 'bottomleft' }).addTo(map);

  // If bounds were provided, fit the map to them now — this overrides the initial
  // center/zoom guess and ensures the first frame is already at the correct view
  if (initialBounds) {
    map.fitBounds(initialBounds, { padding: [20, 20] });
  }

  // 底图切换（OSM ↔ Google 道路图）；basemap.js 未加载时静默跳过
  if (typeof window.initBasemapSwitcher === 'function') {
    window.initBasemapSwitcher(map, osmLayer);
  }

  // 控件列装齐了 —— 通知 explore 把放大镜与筛选也放出来。
  // 那两个在 HTML 里（parse 阶段就存在），而这一列要等 Leaflet 从 unpkg 下来才建得起来；
  // 不压一下就会先冒出两个按钮浮在还没出来的地图上，过一会儿另外四个才一起出现。
  // 监听与闸门在 explore.html / style.css（`.map-tools.is-ready`）。
  document.dispatchEvent(new CustomEvent('mapready'));

  return map;
}

// Expose getCountryBounds so app.js can pass the right bounds to initMap
window._getCountryBounds = getCountryBounds;

/**
 * 构建 Point 几何的定位图钉图标（自定义 SVG + divIcon）。
 * 颜色取自区域配色（colors.fill / colors.stroke），针尖锚定在坐标点上。
 * @param {{fill:string,stroke:string}} colors
 * @returns {L.DivIcon}
 */
function pointPinIcon(colors) {
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40">'
    + '<path d="M15 1C7.3 1 1 7.3 1 15c0 10.6 14 24 14 24s14-13.4 14-24C29 7.3 22.7 1 15 1z" '
    + 'fill="' + colors.fill + '" stroke="' + colors.stroke + '" stroke-width="1.5"/>'
    + '<circle cx="15" cy="14" r="5" fill="#fff"/></svg>';
  return L.divIcon({ className: 'region-point-pin', html: svg, iconSize: PIN_ICON_SIZE, iconAnchor: PIN_ICON_ANCHOR, tooltipAnchor: [0, -38] });
}

/**
 * 在地图上渲染所有区域
 * @param {L.Map} map
 * @param {Array} regions
 */
function renderRegions(map, regions) {
  const colorMap = assignRegionColors(regions);

  // 悬停管理器：单次绑定 map 级 mousemove，regions 引用随渲染更新
  _hoverRegions = regions;
  if (!map._hoverManagerBound) {
    map._hoverManagerBound = true;
    map.on('mousemove', onMapHoverMove);
    map.on('mouseout', onMapHoverLeave);
    map.on('moveend', onMapMoveEnd);
  }
  regions.forEach(function(region) {
    const feature = geometryLayer(region.geojson, region);
    if (!feature) return;
    const colors = colorMap[region.id];

    var lw = computeLineWeight(map);

    const geoLayer = L.geoJSON(feature, {
      style: function(feat) {
        var fl = feat.geometry && feat.geometry.type === 'LineString';
        if (fl) {
          return { color: colors.stroke, weight: lw, opacity: 1, fillOpacity: 0 };
        }
        return { fillColor: colors.fill, color: colors.stroke, fillOpacity: 0.52, weight: 2.5 };
      },
      pointToLayer: function(feat, latlng) {
        var marker = L.marker(latlng, { icon: pointPinIcon(colors), interactive: true });
        marker._isPoint = true;
        return marker;
      },
      onEachFeature: function(feat, layer) {
        var featIsLine = feat.geometry && feat.geometry.type === 'LineString';
        var featHasArrow = featIsLine && feat.properties && feat.properties.arrow;

        // Add arrow decorators for arrow-enabled LineStrings
        // Defer to next tick: onEachFeature fires before layer is on map,
        // so polyline._parts aren't computed yet; polylineDecorator needs them.
        if (featHasArrow && typeof L.polylineDecorator !== 'undefined') {
          setTimeout(function() {
            try {
              // Flatten LatLngs (handles LineString, MultiLineString, and L.LatLng objects)
              function walk(arr, out) {
                if (!arr) return;
                // L.LatLng leaf object (has .lat and .lng)
                if (arr.lat !== undefined && arr.lng !== undefined) { out.push(arr); return; }
                if (!arr.length) return;
                // Raw coordinate array [lat, lng]
                if (typeof arr[0] === 'number') { out.push(arr); return; }
                for (var i = 0; i < arr.length; i++) walk(arr[i], out);
              }
              function linePixelLen() {
                var pts = []; walk(layer.getLatLngs(), pts);
                if (pts.length < 2) return 0;
                var total = 0;
                for (var i = 1; i < pts.length; i++) {
                  var a = map.latLngToContainerPoint(pts[i - 1]);
                  var b = map.latLngToContainerPoint(pts[i]);
                  total += Math.sqrt(Math.pow(b.x - a.x, 2) + Math.pow(b.y - a.y, 2));
                }
                return total;
              }
              function makePattern() {
                var len = linePixelLen();
                var lw = computeLineWeight(map);
                var px = Math.max(5, Math.min(20, Math.round(lw * 2)));
                var sym = L.Symbol.arrowHead({ pixelSize: px, polygon: false, pathOptions: { color: colors.stroke, weight: 3 } });
                var repeatPx = Math.max(100, Math.min(450, Math.round(Math.max(len, 0) / 1.8)));
                var offsetPx;
                if (len < 3) {
                  // Extremely short line — any offset>0 risks falling
                  // beyond the projected path; put arrow at the start
                  offsetPx = 0;
                } else if (len < repeatPx) {
                  offsetPx = Math.round(len / 2);
                } else {
                  offsetPx = Math.round(repeatPx / 3);
                }
                return [{ offset: offsetPx, repeat: repeatPx, symbol: sym }];
              }
              // Create initial decorator; only add to map if this region is
              // currently visible (country + search) and not collapsed to a dot.
              // renderRegions runs before switchCountry on first load, so hidden
              // countries' decorators must not be added yet.
              var arrowDecorator = L.polylineDecorator(layer, {
                patterns: makePattern()
              });
              if (featureArrowsVisible(map, feat, region)) {
                arrowDecorator.addTo(map);
              }
              // When zoom changes, destroy and recreate so pixelSize stays
              // at true 14 screen-pixels (L.Symbol bakes geographic size at creation)
              var onZoom = function() {
                try {
                  if (arrowDecorator) map.removeLayer(arrowDecorator);
                  arrowDecorator = L.polylineDecorator(layer, {
                    patterns: makePattern()
                  });
                  // Only add to map if this region is currently visible and
                  // not collapsed to a dot
                  if (featureArrowsVisible(map, feat, region)) {
                    arrowDecorator.addTo(map);
                  }
                  layer._arrowDecorator = arrowDecorator;
                } catch(e) {}
              };
              map.on('zoomend', onZoom);
              layer._arrowDecorator = arrowDecorator;
            } catch(e) { console.error('arrow decorator error:', e); }
          }, 0);
        }

        // Store metadata for zoom-based style updates
        layer._isLine = featIsLine;
        layer._colors = colors;

        // For LineString features, the visible stroke can be too narrow to
        // click. Create an invisible wider polyline as the click target.
        var interactiveLayer = layer;
        if (featIsLine) {
          // Disable interaction on the visible (narrow) line
          layer.setStyle({ interactive: false });
          // Build transparent click target with minimum 28px width
          var coords = feat.geometry.coordinates;
          var latlngs;
          if (feat.geometry.type === 'MultiLineString') {
            latlngs = coords.map(function(cs) {
              return cs.map(function(c) { return [c[1], c[0]]; });
            });
          } else {
            latlngs = coords.map(function(c) { return [c[1], c[0]]; });
          }
          interactiveLayer = L.polyline(latlngs, {
            weight: Math.max(28, lw + 24),
            opacity: 0,
            fillOpacity: 0,
            interactive: true
          }).addTo(map);
          // Link layers for visibility toggling in switchCountry
          layer._clickTarget = interactiveLayer;
          interactiveLayer._visibleLayer = layer;
          // Mark as click target so zoomend can update its weight
          interactiveLayer._isClickTarget = true;
        }

        // 悬停统一由 map 级 mousemove 管理器驱动（regionsAtPoint 确定性重算），
        // 这里只保留 click —— Leaflet 命中测试仍保证点中的是最上层形状。
        interactiveLayer.on({
          click: function(e) {
            handleRegionClick(region, regions, e);
          }
        });

        // 微小提交圆点：每个几何（含 Point）各自创建，缩到几乎看不见时由 refreshRegionDot 显示。
        // 放在 onEachFeature 内按 feature 独立计算外接框，避免多几何提交（region.geojson 为数组）
        // 被合并外接框拖住，导致单个小 shape 已缩成点却不显示圆点。
        // Point 也创建圆点：zoom out 到 POINT_DOT_ZOOM 以下时图钉收成圆点，与线/多边形一致。
        if (feat.geometry) {
          const center = geometryCenter(feat.geometry);
          if (center) {
            const dot = L.circleMarker(center, {
              radius: DOT_BASE_RADIUS,
              fillColor: colors.fill,
              fillOpacity: 1,
              color: DOT_BASE_STROKE,
              weight: DOT_BASE_WEIGHT,
              opacity: 1,
              interactive: true
            });
            // 悬停同样由 map 级管理器驱动（Point/MultiPoint 走 nearGeometry 邻近判定）
            dot.on({
              click: function(e) { handleRegionClick(region, regions, e); }
            });
            layer._dot = dot;
          }
        }
      }
    }).addTo(map);

    _polygonLayers.set(region.id, geoLayer);

    geoLayer._region = region;
    refreshRegionDot(map, geoLayer);
  });

  // Zoom listener: update line weights to scale with map zoom
  if (!map._lineWeightListener) {
    map._lineWeightListener = true;
    map.on('zoomend', function() {
      var lw = computeLineWeight(map);
      var clickWeight = Math.max(28, lw + 24);
      _polygonLayers.forEach(function(geoLayer) {
        geoLayer.eachLayer(function(l) {
          if (l._isLine) {
            l.setStyle({ weight: lw });
          }
          // Update invisible click target weight for LineStrings
          if (l._clickTarget && l._clickTarget._isClickTarget) {
            l._clickTarget.setStyle({ weight: clickWeight });
          }
        });
      });
    });
  }

  // Zoom listener: 微小提交圆点的显示/隐藏随缩放更新
  if (!map._dotListener) {
    map._dotListener = true;
    map.on('zoomend', function() {
      _polygonLayers.forEach(function(geoLayer) {
        refreshRegionDot(map, geoLayer);
      });
    });
  }
}

// 微小提交圆点：当提交屏幕外接框对角线小于此像素值时显示最小圆点
const DOT_THRESHOLD_PX = 12;

// 点几何（Point）：缩放到此级别及以下（zoom out 更远）时，定位图钉收成最小圆点，
// 避免绝对尺寸的 pin 在 zoom out 时显得过大、与其他已收成圆点的提交不一致。
// 缩放高于此级别（zoom in）时还原为图钉。
const POINT_DOT_ZOOM = 7;

// 圆点悬停命中半径（px）：指针距可见圆点中心 ≤ 此值即命中该 region。
// 与 nearGeometry 的 12px 近邻容差一致，保证圆点的可见/点击区与悬浮命中区重合——
// 否则圆点(r=5)比收成圆点前的原始几何(<12px 对角线)大，鼠标在圆点上已变点击状
// 却不出悬浮窗，且悬浮范围只剩几何那一小块。
const DOT_HIT_RADIUS = 12;

// 圆点基础样式（未悬停）：创建处与还原处共用，避免两处样式漂移。
const DOT_BASE_RADIUS = 5;
const DOT_BASE_STROKE = '#ffffff';
const DOT_BASE_WEIGHT = 1.5;

// 圆点悬停样式：半径放大 + 描边由白换成高亮色（单卡=该 region 自身描边色，
// 重叠堆叠=调色板同序号色，与该卡片左边框同色）。
// 半径 8 仍小于 DOT_HIT_RADIUS(12)：放大后圆点不会跑出自己的命中/点击区。
const DOT_HOVER_RADIUS = 8;
const DOT_HOVER_WEIGHT = 2.5;

// 定位图钉图标尺寸与锚点：iconSize [30,40]、iconAnchor [15,40]（针尖=坐标点，图钉向上伸出）。
// 悬浮命中区与点击区共用这两组值，保证「看得见的图钉＝可悬浮＝可点击」，不会再次漂移。
const PIN_ICON_SIZE = [30, 40];
const PIN_ICON_ANCHOR = [15, 40];

/**
 * 计算单个 geometry 在当前缩放下的屏幕外接框对角线像素值。
 * @param {L.Map} map
 * @param {object} geom — 单个 GeoJSON 几何对象
 * @returns {number|null}
 */
function geometryScreenDiagonalPx(map, geom) {
  const bbox = regionBBox(geom);
  if (!bbox) return null;
  const nw = map.latLngToContainerPoint([bbox.minLat, bbox.minLng]);
  const se = map.latLngToContainerPoint([bbox.maxLat, bbox.maxLng]);
  return Math.hypot(se.x - nw.x, se.y - nw.y);
}

/**
 * 计算单个 geometry 的地理外接框中心，返回 [lat, lng]。
 * 无法计算时返回 null。用于多几何提交按 feature 各自定位「最小圆点」。
 * @param {object} geom — 单个 GeoJSON 几何对象
 * @returns {[number, number]|null}
 */
function geometryCenter(geom) {
  const bbox = regionBBox(geom);
  if (!bbox) return null;
  return [(bbox.minLat + bbox.maxLat) / 2, (bbox.minLng + bbox.maxLng) / 2];
}

/**
 * 记录/移除 region 的可见圆点中心，供 regionsAtPoint 的 dotAtPoint 命中判定用。
 * region 可见圆点列表保存在 region._activeDotLatLngs（[{dot, ll}]）。
 */
function trackActiveDot(region, dot) {
  if (!region._activeDotLatLngs) region._activeDotLatLngs = [];
  for (var i = 0; i < region._activeDotLatLngs.length; i++) {
    if (region._activeDotLatLngs[i].dot === dot) return; // 已跟踪
  }
  region._activeDotLatLngs.push({ dot: dot, ll: dot.getLatLng() });
}

function untrackActiveDot(region, dot) {
  if (!region._activeDotLatLngs) return;
  region._activeDotLatLngs = region._activeDotLatLngs.filter(function(e) { return e.dot !== dot; });
}

/**
 * 套用/还原圆点的悬停样式。
 * 圆点收起来后，屏幕上唯一可见的就是它本身，而悬停上色只改几何 layer——
 * 不在这里补上，悬浮一个已收成圆点的提交就没有任何可见反馈。
 * @param {L.CircleMarker} dot
 * @param {string|null} stroke — 高亮描边色；传 null 还原为基础样式
 */
function applyDotHover(dot, stroke) {
  // 圆点未显示（几何够大或被隐藏）时不碰：不在图上的 layer 改了也看不见，
  // 等它真正上图时由 refreshRegionDot 决定初始样式。
  if (!dot || !dot._map) return;
  dot.setRadius(stroke ? DOT_HOVER_RADIUS : DOT_BASE_RADIUS);
  dot.setStyle({
    color: stroke || DOT_BASE_STROKE,
    weight: stroke ? DOT_HOVER_WEIGHT : DOT_BASE_WEIGHT
  });
}

/**
 * 当前悬停状态下该 region 的圆点高亮色；未在悬停中返回 null。
 * 与卡片左边框同色：单卡用 region 自身描边色，重叠堆叠用调色板同序号色。
 * 供 refreshRegionDot 在悬停中新建圆点时取用，避免圆点出生是灰的、卡片却开着。
 * @param {object} region
 * @returns {string|null}
 */
function hoverDotStroke(region) {
  var s = _hoverState;
  if (!s || !region) return null;
  var idx = s.ids.indexOf(region.id);
  if (idx < 0) return null;
  if (s.mode === 'stack') {
    var palette = buildPalette();
    return palette[idx % palette.length].stroke;
  }
  var stroke = null;
  var layer = _polygonLayers.get(region.id);
  if (layer) {
    layer.eachLayer(function(l) {
      if (stroke === null && l._colors) stroke = l._colors.stroke;
    });
  }
  return stroke;
}

/**
 * 刷新单个 region 的圆点可见性：仅当 region 可见（国家 + 搜索均未隐藏）
 * 且屏幕外接框对角线足够小时显示，否则移除。
 * @param {L.Map} map
 * @param {L.GeoJSON} geoLayer — 含 _dot 与 _region 引用
 */
function refreshRegionDot(map, geoLayer) {
  const region = geoLayer._region;
  const visible = region && region._countryVisible !== false && region._searchVisible !== false;
  geoLayer.eachLayer(function(l) {
    const dot = l._dot;
    if (!dot) return;
    if (!visible) {
      map.removeLayer(dot);
      untrackActiveDot(region, dot);
      if (l._isPoint) setPointVisible(l, false);
      return;
    }
    let collapsed;
    if (l._isPoint) {
      collapsed = map.getZoom() <= POINT_DOT_ZOOM;
    } else {
      const feat = l.feature;
      const diagPx = (feat && feat.geometry) ? geometryScreenDiagonalPx(map, feat.geometry) : null;
      collapsed = diagPx != null && diagPx < DOT_THRESHOLD_PX;
    }
    if (collapsed) {
      // 悬停中缩放出圆点：出生即套用悬停样式，否则卡片开着、圆点却是未高亮的
      if (!map.hasLayer(dot)) {
        dot.addTo(map);
        applyDotHover(dot, hoverDotStroke(region));
      }
      trackActiveDot(region, dot);
      if (l._isPoint) setPointVisible(l, false);
    } else {
      map.removeLayer(dot);
      untrackActiveDot(region, dot);
      if (l._isPoint) setPointVisible(l, true);
    }
  });
}

/**
 * 显隐 Point 图钉（marker）：同时处理 opacity 与 pointer-events，
 * 避免收成圆点后透明的图钉仍拦截点击（marker pane 在 overlay pane 之上）。
 */
function setPointVisible(marker, show) {
  marker.setOpacity(show ? 1 : 0);
  var pe = marker.getElement && marker.getElement();
  if (pe) pe.style.pointerEvents = show ? 'auto' : 'none';
}

/**
 * 箭头装饰器是否应显示：国家 + 搜索均可见，且该 feature 未缩成圆点。
 * 与 refreshRegionDot 共用 DOT_THRESHOLD_PX 阈值，并按单个 feature 外接框判断，
 * 保证多几何提交（region.geojson 为数组）里小 feature 缩成点时箭头同步消失，
 * 而不是被整个 region 的合并外接框拖住导致圆点与箭头同时出现。
 * @param {L.Map} map
 * @param {object} feat — 单个 GeoJSON feature（含 geometry）
 * @param {object} region — 所属 region（用于国家/搜索可见性判定）
 */
function featureArrowsVisible(map, feat, region) {
  if (region._countryVisible === false || region._searchVisible === false) return false;
  var diagPx = (feat && feat.geometry) ? geometryScreenDiagonalPx(map, feat.geometry) : null;
  return diagPx == null || diagPx >= DOT_THRESHOLD_PX;
}

/**
 * 将 geojson 字段转为标准 GeoJSON Feature 或 FeatureCollection
 * Accepts legacy single geometry object or new geometry array
 */
function geometryLayer(geo, region) {
  // Normalize to array (backward compat: single geometry → [geometry])
  var geometries;
  if (Array.isArray(geo)) {
    geometries = geo;
  } else if (geo && geo.type) {
    geometries = [geo];
  } else {
    return null;
  }

  var features = geometries.map(function(g) {
    // 把经度 wrap 回 [-180,180]：跨越反经线（worldCopyJump）绘制时 geoman 会产出
    // [180,360) 的经度，Leaflet 渲染矢量不会自动 wrap，会把线画到屏幕外。见 utils.js wrapGeoCoordinates。
    if (g && g.coordinates) wrapGeoCoordinates(g.coordinates);
    var feature = {
      type: 'Feature',
      properties: { id: region.id, name: region.name },
      geometry: g
    };
    // Per-geometry arrow flag (LineString only)
    if (g.type === 'LineString' && (g.arrow === true || (g.properties && g.properties.arrow === true))) {
      feature.properties.arrow = true;
    }
    return feature;
  });

  if (features.length === 1) return features[0];
  return { type: 'FeatureCollection', features: features };
}

/**
 * 构建悬停卡片 HTML
 * @param {object} region
 * @param {number} overlapCount — 底部「N more beneath」计数；0/undefined 时不显示
 * @param {string} [color] — 卡片左边框颜色（重叠多卡片时用可区分色）
 */
function buildHoverContent(region, overlapCount, color) {
  const container = document.createElement('div');
  container.className = 'region-hover-card';
  if (color) container.style.borderLeftColor = color;

  const title = document.createElement('div');
  title.className = 'region-hover-card__title';
  title.textContent = displayName(region.name);

  const desc = document.createElement('div');
  desc.className = 'region-hover-card__desc';
  desc.textContent = region.description || '';

  container.appendChild(title);
  container.appendChild(desc);

  if (overlapCount && overlapCount > 0) {
    var under = document.createElement('div');
    under.className = 'region-hover-card__overlap';
    under.textContent = overlapCount + ' more beneath';
    container.appendChild(under);
  }

  return container;
}

/**
 * 构建某个 region 的悬停卡片内容（含「下方还有 N 个」重叠提示）。
 * @param {object} region
 * @param {Array} regions
 * @param {{lat:number,lng:number}} latlng
 * @returns {HTMLElement}
 */
/**
 * 把 id 数组解析为 region 对象数组（保持传入顺序；找不到的 id 跳过）。
 * @param {Array} regions
 * @param {Array<string>} ids
 * @returns {Array}
 */
function resolveRegions(regions, ids) {
  var out = [];
  if (!ids || !ids.length) return out;
  for (var i = 0; i < ids.length; i++) {
    for (var j = 0; j < regions.length; j++) {
      if (regions[j].id === ids[i]) { out.push(regions[j]); break; }
    }
  }
  return out;
}

/* ---------------- map 级悬停管理器 ---------------- */

/**
 * 点到线段（容器坐标，px）的最短距离。
 */
function distToSegment(p, a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  if (dx === 0 && dy === 0) return p.distanceTo(a);
  var t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  var cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.sqrt((p.x - cx) * (p.x - cx) + (p.y - cy) * (p.y - cy));
}

/**
 * Point/MultiPoint/LineString/MultiLineString 的近邻命中（容器坐标，按 px 容差）。
 * regionContainsPoint 只覆盖 Polygon/MultiPolygon，线/点型几何走这里。
 */
function nearGeometry(region, lat, lng, map, tolPx) {
  var geo = region.geojson;
  var geometries = Array.isArray(geo) ? geo : [geo];
  var p = map.latLngToContainerPoint([lat, lng]);
  for (var i = 0; i < geometries.length; i++) {
    var g = geometries[i];
    if (!g || !g.type || !g.coordinates) continue;
    if (g.type === 'LineString' || g.type === 'MultiLineString') {
      var lines = g.type === 'MultiLineString' ? g.coordinates : [g.coordinates];
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        for (var s = 0; s < line.length - 1; s++) {
          var a = map.latLngToContainerPoint([line[s][1], line[s][0]]);
          var b = map.latLngToContainerPoint([line[s + 1][1], line[s + 1][0]]);
          if (distToSegment(p, a, b) <= tolPx) return true;
        }
      }
    } else if (g.type === 'Point') {
      var q = map.latLngToContainerPoint([g.coordinates[1], g.coordinates[0]]);
      if (p.distanceTo(q) <= tolPx) return true;
    } else if (g.type === 'MultiPoint') {
      for (var pi = 0; pi < g.coordinates.length; pi++) {
        var q2 = map.latLngToContainerPoint([g.coordinates[pi][1], g.coordinates[pi][0]]);
        if (p.distanceTo(q2) <= tolPx) return true;
      }
    }
  }
  return false;
}

/**
 * 圆点命中：region 收成圆点时，指针距任一可见圆点中心 ≤ DOT_HIT_RADIUS 即命中。
 * 只对当前可见圆点生效（dotAtPoint 用 region._activeDotLatLngs，由 refreshRegionDot 维护）。
 */
function dotAtPoint(region, containerPoint) {
  var dots = region._activeDotLatLngs;
  if (!dots || !dots.length) return false;
  var map = window._geoguideMap;
  for (var i = 0; i < dots.length; i++) {
    if (map.latLngToContainerPoint(dots[i].ll).distanceTo(containerPoint) <= DOT_HIT_RADIUS) return true;
  }
  return false;
}

/**
 * 图钉命中：Point 图钉当前可见（zoom > POINT_DOT_ZOOM，未收成圆点）时，
 * 指针落入任一图钉的图标屏幕矩形即命中——与点击区完全重合。
 * 图钉坐标点 = 针尖（iconAnchor，底部中心），图标从针尖向上 iconSize[1]、左右各 iconSize[0]/2。
 * zoom ≤ POINT_DOT_ZOOM 时图钉已隐藏（收成圆点走 dotAtPoint），这里直接不生效。
 */
function pinAtPoint(region, containerPoint) {
  var map = window._geoguideMap;
  if (!map || map.getZoom() <= POINT_DOT_ZOOM) return false;
  var geoLayer = window._polygonLayers && window._polygonLayers.get(region.id);
  if (!geoLayer) return false;
  var halfW = PIN_ICON_SIZE[0] / 2;
  var h = PIN_ICON_SIZE[1];
  var hit = false;
  geoLayer.eachLayer(function(l) {
    if (hit || !l._isPoint || !map.hasLayer(l)) return;
    var anchor = map.latLngToContainerPoint(l.getLatLng());
    if (containerPoint.x >= anchor.x - halfW && containerPoint.x <= anchor.x + halfW
        && containerPoint.y >= anchor.y - h && containerPoint.y <= anchor.y) {
      hit = true;
    }
  });
  return hit;
}

/**
 * 指针 (lat,lng) 下命中的所有可见 region，顶层在前。
 * 复用 regionContainsPoint（多边形）+ nearGeometry（线/点）+ dotAtPoint（收成圆点）。
 * regions 数组顺序即添加顺序（底层→顶层），reverse 后顶层在前。
 */
function regionsAtPoint(regions, lat, lng) {
  var map = window._geoguideMap;
  if (!map) return [];
  var hit = [];
  var p = map.latLngToContainerPoint([lat, lng]);
  for (var i = 0; i < regions.length; i++) {
    var r = regions[i];
    if (r._countryVisible === false || r._searchVisible === false) continue;
    if (!r.geojson) continue;
    if (regionContainsPoint(r, lat, lng) || nearGeometry(r, lat, lng, map, 12) || dotAtPoint(r, p) || pinAtPoint(r, p)) {
      hit.push(r);
    }
  }
  hit.reverse();
  return hit;
}

/**
 * map 级 mousemove：记录最新指针，rAF 合并节流后重算并渲染。
 */
function onMapHoverMove(e) {
  _hoverLatLng = e.latlng;
  _hoverContainerPoint = e.containerPoint;
  if (_hoverRaf) return;
  _hoverRaf = true;
  requestAnimationFrame(function() {
    _hoverRaf = false;
    var ll = _hoverLatLng;
    if (!ll) return;
    renderHover(regionsAtPoint(_hoverRegions, ll.lat, ll.lng), ll);
  });
}

/**
 * 指针离开地图容器：清除悬停。
 */
function onMapHoverLeave() {
  _hoverLatLng = null;
  _hoverContainerPoint = null;
  clearHover();
}

/**
 * 地图移动结束（zoom/pan/setView）：鼠标没动时没有 mousemove，弹窗不会自己重算。
 * 用静止光标的容器坐标换算成新视图下的 latlng 重新判定——命中则重锚/更新，
 * 不命中则清空，避免「先悬浮再只 zoom」后弹窗残留在已不在命中区的位置。
 */
function onMapMoveEnd() {
  var map = window._geoguideMap;
  if (!map || !_hoverContainerPoint) return;
  var ll = map.containerPointToLatLng(_hoverContainerPoint);
  _hoverLatLng = ll;
  renderHover(regionsAtPoint(_hoverRegions, ll.lat, ll.lng), ll);
}

/**
 * 按指针位置渲染悬停：空→清除；单→单卡片+高亮；多→堆叠多卡片+上色。
 * 同一 ids 集合时只重锚 tooltip（跟随鼠标），不重建。
 */
function renderHover(set, latlng) {
  var ids = [];
  for (var i = 0; i < set.length; i++) ids.push(set[i].id);
  if (_hoverState && _hoverState.ids.length === ids.length) {
    var same = true;
    for (var s = 0; s < ids.length; s++) {
      if (_hoverState.ids[s] !== ids[s]) { same = false; break; }
    }
    if (same) {
      clampHoverToMap(window._geoguideMap, latlng);
      return;
    }
  }
  clearHover();
  if (set.length === 0) return;
  if (set.length === 1) showSingleHover(set[0], latlng);
  else showOverlapStack(set, latlng);
}

/**
 * 清除当前悬停：移除全部 tooltip + 恢复全部临时上色形状原色。
 */
function clearHover() {
  if (_hoverState) {
    _hoverState.tooltips.forEach(function(t) {
      if (!t) return;
      if (t._map) t.remove();
      // Leaflet 的 fadeAnimation 会让 onRemove 延迟 200ms 才真正移除容器，
      // 悬停卡片需要立即消失——直接同步摘除，避免旧卡片残影/残留计数。
      var el = t.getElement && t.getElement();
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (_hoverState.styled && _hoverState.styled.length) {
      restoreOverlapColors(_hoverState.styled);
    }
    _hoverState = null;
  }
}

/** 悬停卡片距地图上下沿保留的最小间距（px）。 */
var HOVER_EDGE_GAP = 6;

/**
 * 当前会挡住悬停卡片的浮层矩形（地图左上角展开着的标签筛选栏）；没有就返回 null。
 *
 * 为什么只能靠位移绕开、不能靠层级：卡片是 Leaflet tooltip，住在 `.leaflet-map-pane` 里，
 * 而那个 pane 带 `z-index: 400` 且带 transform（平移用）—— 它自己就是一个层叠上下文。
 * 卡片在它内部无论设多高的 z-index（tooltip pane 默认 650）都出不了这一层，而筛选栏所在的
 * `.map-tools` 是 1001。实测把 `.leaflet-tooltip-pane` 提到 1100 完全无效：计算值确实是 1100，
 * 画序仍是筛选栏在上。抬 `.leaflet-map-pane` 倒是有效，但那会把瓦片一起抬到搜索框上面。
 *
 * 只看 `.tag-filter__panel`：`hidden` 时它没有 rect，正好等于「没展开」。
 * `getElementById` 在别的页面（my-submissions 等）返回 null，所以这里对共享的 map.js 是安全的。
 */
function hoverOccluder() {
  var panel = document.getElementById('tag-filter-panel');
  if (!panel || panel.hidden) return null;
  var r = panel.getBoundingClientRect();
  return (r.width && r.height) ? r : null;
}

/**
 * 悬停卡片竖直夹取：把当前这一组卡片整体平移回地图可视区内。
 *
 * 卡片画在 #map 内部，而 Leaflet 的 .leaflet-container 是 overflow:hidden。
 * 堆叠模式固定 direction:'top' 一律向上长、单卡 direction:'auto' 上下居中，
 * 光标一靠近上沿就会把上半截顶出地图，被裁掉之后文字看不全。
 * （2026-09-18 起地图上沿不再有那条工具栏，但左上角仍有 `.map-tools` 浮层，
 *  而且 overflow:hidden 这条裁剪从来没变——夹取照旧需要。）
 *
 * 卡片相对光标的上下偏移只在构建时量一次（deltas），之后每次跟随鼠标纯算术平移，
 * 不触发 layout。**顶部优先**：装不下时宁可靠着上沿，也不让文字被上沿裁掉。
 * 横向不动——左右由 Leaflet 的 direction:'auto' 自己挑边。
 *
 * 另有一个遮挡源：左上角展开着的标签筛选栏（见 hoverOccluder）。它层级上压不过，
 * 所以当卡片横向与它相交时，把上边界压到它下沿以下，让卡片整体下滑绕开。
 * 只在**确实放得下**时才这么挪（belowOcc <= maxShift）：挪完能被下沿裁掉，还不如原地被盖住。
 */
function clampHoverToMap(map, latlng) {
  var s = _hoverState;
  if (!map || !s || !s.tooltips.length) return;
  // 边界取容器的实际矩形，不要用 map.getSize()：Leaflet 缓存尺寸，国家栏晚一步撑开时
  // 它比 #map 真实高度大（实测 769 vs 725），下沿会算松、卡片照样越界。
  var contRect = map.getContainer().getBoundingClientRect();
  var pt = map.latLngToContainerPoint(latlng);
  var cursorY = contRect.top + pt.y;
  var cursorX = contRect.left + pt.x;
  if (!s.deltas) {
    var top = Infinity, bottom = -Infinity, left = Infinity, right = -Infinity;
    s.tooltips.forEach(function(t) {
      var el = t.getElement();
      if (!el) return;
      var r = el.getBoundingClientRect();
      top = Math.min(top, r.top - cursorY);
      bottom = Math.max(bottom, r.bottom - cursorY);
      left = Math.min(left, r.left - cursorX);
      right = Math.max(right, r.right - cursorX);
    });
    if (!isFinite(top)) return;
    s.deltas = { top: top, bottom: bottom, left: left, right: right };
  }
  // 顶部不越界所需的最小位移 / 底部不越界允许的最大位移（整体可平移的区间）
  var minShift = contRect.top + HOVER_EDGE_GAP - cursorY - s.deltas.top;
  var maxShift = contRect.bottom - HOVER_EDGE_GAP - cursorY - s.deltas.bottom;
  // 筛选栏挡在卡片路径上 → 把上边界换成它的下沿，卡片滑到它下面去。
  // 横向相交才需要挪：不相交的卡片本来就露在筛选栏外面。
  var occ = hoverOccluder();
  if (occ && cursorX + s.deltas.right > occ.left && cursorX + s.deltas.left < occ.right) {
    var belowOcc = occ.bottom + HOVER_EDGE_GAP - cursorY - s.deltas.top;
    if (belowOcc > minShift && belowOcc <= maxShift) minShift = belowOcc;
  }
  var shift = minShift > maxShift ? minShift : Math.min(Math.max(0, minShift), maxShift);
  if (shift === s.shift) {
    s.tooltips.forEach(function(t) { if (t && t._map) t.setLatLng(latlng); });
    return;
  }
  s.shift = shift;
  s.tooltips.forEach(function(t) {
    if (!t || !t._map) return;
    if (!t._hoverBaseOffset) {
      var o = t.options.offset || [0, 0];
      t._hoverBaseOffset = [o[0], o[1]];
    }
    t.options.offset = [t._hoverBaseOffset[0], t._hoverBaseOffset[1] + shift];
    t.setLatLng(latlng);
  });
}

/**
 * 单形状悬停：一张卡片 + 高亮形状（与旧鼠标移入高亮一致）。
 */
function showSingleHover(region, latlng) {
  var map = window._geoguideMap;
  if (!map) return;
  var layer = _polygonLayers.get(region.id);
  if (layer) {
    layer.eachLayer(function(l) {
      // 同一提交分散在多处时全部一起变：每个 feature 的可见圆点 + 几何形状
      applyDotHover(l._dot, (l._colors || {}).stroke);
      if (l._isPoint) return;
      var colors = l._colors || {};
      if (l._isLine) {
        l.setStyle({ color: colors.stroke, weight: computeLineWeight(map) + 2, opacity: 1, fillOpacity: 0 });
      } else {
        l.setStyle({ fillColor: colors.fill, color: colors.stroke, fillOpacity: 0.68, weight: 3.6 });
      }
    });
  }
  if (window._prefetchReactions) window._prefetchReactions(region.id);
  var tip = L.tooltip({ direction: 'auto', className: 'region-hover-shell', opacity: 1 });
  tip.setContent(buildHoverContent(region, 0));
  tip.setLatLng(latlng);
  tip.openOn(map);
  _hoverState = { ids: [region.id], mode: 'single', tooltips: [tip], styled: [region] };
  clampHoverToMap(map, latlng);
}

/**
 * 重叠悬停：每项一张卡片，统一宽度（取最宽），向上堆叠；重叠形状上可区分描边。
 * 幂等由 renderHover 的 ids 判定保证。
 */
function showOverlapStack(overlap, latlng) {
  var map = window._geoguideMap;
  if (!map) return;
  var palette = buildPalette();
  var tooltips = [];
  var count = Math.min(5, overlap.length);
  for (var i = 0; i < count; i++) {
    // 第 5 张卡片尾部显示超出部分的「N more beneath」
    var extra = (i === count - 1) ? Math.max(0, overlap.length - count) : 0;
    var border = palette[i % palette.length].stroke; // 与形状描边同色
    var tip = L.tooltip({
      direction: 'top',
      className: 'region-hover-shell region-hover-shell--stack',
      opacity: 1,
      offset: [0, 0]
    });
    tip.setContent(buildHoverContent(overlap[i], extra, border));
    tip.setLatLng(latlng);
    tip.openOn(map);
    tooltips.push(tip);
  }
  // 等宽：取最宽一张，统一宽度（短描述不再让卡片一长一短）
  var cards = tooltips.map(function(t) {
    var el = t.getElement();
    return el && el.querySelector('.region-hover-card');
  });
  var maxW = 0;
  cards.forEach(function(c) { if (c) maxW = Math.max(maxW, c.offsetWidth); });
  cards.forEach(function(c) { if (c) c.style.width = maxW + 'px'; });
  // 上色（自身底色 + 可区分描边）+ 按测量高度向上堆叠
  applyOverlapColors(overlap);
  if (window._prefetchReactions) window._prefetchReactions(overlap[0].id);
  var cum = 0;
  for (var i = 0; i < tooltips.length; i++) {
    var el = tooltips[i].getElement();
    var h = el ? el.getBoundingClientRect().height : 60;
    tooltips[i].options.offset = [0, -cum];
    tooltips[i].setLatLng(latlng); // 用新 offset 重新定位
    cum += h + 6;
  }
  var ids = [];
  for (var j = 0; j < overlap.length; j++) ids.push(overlap[j].id);
  _hoverState = { ids: ids, mode: 'stack', tooltips: tooltips, styled: overlap };
  clampHoverToMap(map, latlng);
}

/**
 * 悬停时给重叠形状上可区分色：**保留各形状自身底色**，只把描边换成
 * buildPalette() 前 N 色的深色变体（与卡片左边框同色），并轻度加亮。
 * 避免整片颜色突变，形状本体仍可辨认。
 */
function applyOverlapColors(overlap) {
  var map = window._geoguideMap;
  if (!map) return;
  var palette = buildPalette();
  overlap.forEach(function(region, i) {
    var stroke = palette[i % palette.length].stroke;
    var layer = _polygonLayers.get(region.id);
    if (!layer) return;
    layer.eachLayer(function(l) {
      // 圆点与该 region 的卡片左边框同色；同一提交的全部 part（含分散在多处的圆点）一起变
      applyDotHover(l._dot, stroke);
      if (l._isPoint) return;
      var base = l._colors || {};
      if (l._isLine) {
        l.setStyle({ color: stroke, weight: computeLineWeight(map) + 2, opacity: 1, fillOpacity: 0 });
      } else {
        l.setStyle({
          fillColor: base.fill,
          color: stroke,
          fillOpacity: Math.min(0.85, (typeof base.fillOpacity === 'number' ? base.fillOpacity : 0.52) + 0.2),
          weight: 4
        });
      }
    });
  });
}

/**
 * 恢复重叠形状原色：依据各 layer._colors + 当前 zoom 权重，与现有 mouseout 恢复逻辑一致。
 * @param {Array} overlap
 */
function restoreOverlapColors(overlap) {
  var map = window._geoguideMap;
  overlap.forEach(function(region) {
    var layer = _polygonLayers.get(region.id);
    if (!layer) return;
    layer.eachLayer(function(l) {
      applyDotHover(l._dot, null); // 圆点还原白描边 + 基础半径
      if (l._isPoint) return;
      var colors = l._colors;
      if (!colors) return;
      if (region._countryVisible === false || region._searchVisible === false) {
        l.setStyle(l._isLine ? { opacity: 0 } : { opacity: 0, fillOpacity: 0 });
      } else if (l._isLine) {
        l.setStyle({ color: colors.stroke, weight: computeLineWeight(map), opacity: 1, fillOpacity: 0 });
      } else {
        l.setStyle({ fillColor: colors.fill, color: colors.stroke, fillOpacity: 0.52, weight: 2.5 });
      }
    });
  });
}

/**
 * 把标签栏容器对齐到弹窗左上角外侧（浏览器 new-tab 观感）。
 *
 * 左右两边都钉住 —— 弹窗是居中的，只钉 left 再配一个按整屏量的 max-width 会随屏幕变宽而出屏
 * （1920 上 +326px）。两边都钉住后条子宽度恒等于弹窗宽，这正是标签条该有的宽度。
 */
function repositionOverlapTabs() {
  var container = document.getElementById('overlap-tabs');
  var modal = document.getElementById('modal');
  if (!container || container.hidden) return;
  if (!modal || modal.hidden) return;
  var rect = modal.getBoundingClientRect();
  container.style.left = rect.left + 'px';
  container.style.right = Math.max(0, window.innerWidth - rect.right) + 'px';
  container.style.top = rect.top + 'px';
  container.style.transform = 'translateY(-100%)';
  // 条子的宽窄刚刚变了 —— 箭头显隐取决于 track 的 scrollWidth/clientWidth，必须重算。
  // 放在这里而不是别处：只有这里同时保证了「容器不 hidden」和「left/right 已落定」。
  if (_overlapTabsState.scrollUpdate) _overlapTabsState.scrollUpdate();
}

/**
 * modal 的 transform 过渡结束时重定位标签栏，使其精确对齐最终位置。
 *
 * **不要在这里自我摘除监听器。** 不止「打开动画」会改 modal 的 transform —— 窗口 resize 也会：
 * 窄屏断点改 modal 的宽度（≤600px 起 96vw）甚至把 transform 设成 none（≤500px 全屏），
 * Firefox 会用 0.3s 过渡把 transform 动画过去。resize 处理器当下读到的是**动画中间**的 rect
 * （实测 1280→390 时 left 被写成 -195px，条子一半在屏外），必须靠这次 transitionend 再对齐一次。
 * 生命周期的摘除交给 hideOverlapTabs（closeModal / openModal 都会调它）。
 */
function onModalTransitionEnd(e) {
  if (e.propertyName === 'transform') repositionOverlapTabs();
}

/**
 * 在弹窗左上角外侧显示重叠条目标签栏（仅重叠 ≥2 时调用）。
 * @param {Array} regions
 * @param {Array<string>} overlapIds
 * @param {string} currentId
 */
function showOverlapTabs(regions, overlapIds, currentId) {
  var container = document.getElementById('overlap-tabs');
  var track = document.getElementById('overlap-tabs-track');
  if (!container || !track) return;

  // 注意：清空 innerHTML **不会**把 scrollLeft 归零（实测重建后仍是原值，浏览器不做 clamp），
  // 所以切标签时条子停在原滚动位置 —— 这是想要的（换个标签不该把条子甩回开头），别去"修"它。
  track.innerHTML = '';
  resolveRegions(regions, overlapIds).forEach(function(region) {
    var id = region.id;
    var btn = document.createElement('button');
    btn.className = 'overlap-tab' + (id === currentId ? ' is-active' : '');
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', id === currentId ? 'true' : 'false');
    btn.dataset.regionId = id;

    var rec = (window._countryMap || {})[region.region];
    if (rec && rec.flag) {
      var f = rec.flag;
      var flagImg = document.createElement('img');
      flagImg.className = 'overlap-tab__flag';
      flagImg.src = f.indexOf('http') === 0 ? f : 'https://flagcdn.com/w80/' + f + '.png';
      flagImg.alt = '';
      flagImg.setAttribute('aria-hidden', 'true');
      btn.appendChild(flagImg);
    }

    var label = document.createElement('span');
    label.className = 'overlap-tab__label';
    label.textContent = displayName(region.name);
    btn.appendChild(label);
    // 名字被收缩截断时以 title 补偿完整文本（屏幕阅读器本来就读完整文本，这条给鼠标用户）
    btn.title = displayName(region.name);

    btn.addEventListener('click', function() {
      openModal(region);
      showOverlapTabs(regions, overlapIds, region.id);
    });

    track.appendChild(btn);
  });

  container.hidden = false;

  if (!_overlapTabsState.repositionBound) {
    window.addEventListener('resize', repositionOverlapTabs);
    _overlapTabsState.repositionBound = true;
  }

  // 滚动只绑一次 —— 这个函数每次点标签都会重跑，重复 addEventListener 会叠加监听器。
  if (!_overlapTabsState.scrollBound) {
    _overlapTabsState.scrollUpdate = setupHorizontalScroll(
      track,
      document.getElementById('overlap-tabs-left'),
      document.getElementById('overlap-tabs-right')
    );
    _overlapTabsState.scrollBound = true;
  }
  // 必须在 container.hidden = false 之后：元素 hidden 时 scrollWidth/clientWidth 都是 0，
  // update() 会判为「不溢出」而把箭头永久藏住。repositionOverlapTabs 落地 left/right 的同时
  // 会刷新箭头显隐，所以这里直接调它而不是单独调 update。
  repositionOverlapTabs();

  // 打开动画后对齐 modal 左上角（rAF 粗对齐 + transitionend 精确对齐）
  requestAnimationFrame(repositionOverlapTabs);
  var modal = document.getElementById('modal');
  if (modal) {
    modal.removeEventListener('transitionend', onModalTransitionEnd);
    modal.addEventListener('transitionend', onModalTransitionEnd);
  }
}

/**
 * 隐藏重叠标签栏（modal.js closeModal / openModal 经 window.hideOverlapTabs 调用）。
 */
function hideOverlapTabs() {
  var container = document.getElementById('overlap-tabs');
  if (container) container.hidden = true;
  if (_overlapTabsState.repositionBound) {
    window.removeEventListener('resize', repositionOverlapTabs);
    _overlapTabsState.repositionBound = false;
  }
  var modal = document.getElementById('modal');
  if (modal) modal.removeEventListener('transitionend', onModalTransitionEnd);
}
window.hideOverlapTabs = hideOverlapTabs;

/* ===== 国家范围入口（scope === 'country'）=================================================
 *
 * 它的**入口 UI** 刻意不走 Leaflet 图层：这里走一条完全独立的、宿主在地图容器上的 DOM 浮层，
 * 于是 regionsAtPoint / pinAtPoint / 圆点收点这一整套"几何语义"的逻辑无需为它加任何例外。
 *
 * ⚠️ 别被这句话误导成"它不在 _polygonLayers 里"——它在。写入侧给这类条目存的是
 * `geojson = []`（api/submit.js:230，空**数组**而非 null），而 renderRegions 里
 * `if (!feature) return` 拦不住空数组：geometryLayer([]) 返回
 * `{type:'FeatureCollection', features: []}`，是真值，于是 map.js:375 照常把它注册进去。
 * 那是个没有要素、点不中任何东西的图层，对几何侧无害，但**读 _polygonLayers 的代码会看到它**
 * （例如 explore 的标签面板按 region.tags 统计当前国家有哪些标签，国家级 META 的标签因此
 * 照样计入）。详见 spec/frontend/country-meta-entry.md。
 *
 * 代价是它不进地图坐标系：固定贴在顶部正中，zoom/pan 都不动。这是有意的 —— explore 一次
 * 只显示一个国家，屏幕上永远最多一个入口，固定位置保证它任何缩放下都可见可点。
 */

/**
 * 取某国家的全部国家范围条目（沿用接口给数组的顺序）。
 * @param {Array} regions
 * @param {string} countryId
 */
function countryMetaFor(regions, countryId) {
  return (regions || []).filter(function(r) {
    return r.scope === 'country' && r.region === countryId;
  });
}

/**
 * 刷新顶部入口：有国家范围条目 → 星标；没有 → 一句鼓励提交的文案 + 链接。
 * 只在 switchCountry 的末尾调用（初始加载与每次切国家都会走到）。
 *
 * 注意：**不随搜索/标签筛选联动**。它代表国家级内容，不属于"区域"筛选的范畴；而且搜索走的
 * 是 search.js 那条独立路径（直接调 refreshRegionDot，不经 switchCountry），要联动就得在
 * 那里再插一刀。代价是搜索把形状全过滤掉时星标仍在 —— 判断是入口不该消失，利大于弊。
 *
 * @param {Array} regions
 * @param {string} countryId
 */
function updateCountryMetaEntry(regions, countryId) {
  var wrap = document.getElementById('country-meta-entry');
  if (!wrap) return;
  var btn = document.getElementById('country-meta-btn');
  var empty = document.getElementById('country-meta-empty');
  var textEl = document.getElementById('country-meta-empty-text');
  var linkEl = document.getElementById('country-meta-empty-link');

  var list = countryMetaFor(regions, countryId);
  var has = list.length > 0;

  if (btn) {
    btn.hidden = !has;
    if (has) {
      // 点击时不必重新过滤：把当前国家的 id 列表挂在这个按钮上。
      btn._countryMetaIds = list.map(function(r) { return r.id; });
      btn.setAttribute('aria-label', list.length === 1
        ? 'Open the country-wide guide'
        : 'Open one of ' + list.length + ' country-wide guides');
    } else {
      btn._countryMetaIds = [];
    }
  }
  if (empty) empty.hidden = has;
  if (!has) {
    if (textEl) textEl.textContent = 'No country-wide META yet.';
    if (linkEl) {
      linkEl.textContent = 'Share your META~';
      // 带上国家预选，别让用户落到一个空白提交页再自己选一遍。
      linkEl.href = '/submit?country=' + encodeURIComponent(countryId || '');
    }
  }
  wrap.hidden = false;
}

/**
 * 按 id 打开某个 region，并在它是国家范围、且该国有 ≥2 条时摆出标签栏。
 * 星标点击与 ?region= 深链**共用这一个入口** —— 别再各写一份。
 * @param {string} id
 * @returns {boolean} 是否找到了该条目
 */
function openRegionById(id) {
  var region = null;
  for (var i = 0; i < _hoverRegions.length; i++) {
    if (_hoverRegions[i].id === id) { region = _hoverRegions[i]; break; }
  }
  if (!region) return false;

  openModal(region);
  if (region.scope === 'country') {
    var list = countryMetaFor(_hoverRegions, region.region);
    if (list.length > 1) {
      showOverlapTabs(_hoverRegions, list.map(function(r) { return r.id; }), id);
      return true;
    }
  }
  // region 范围（或国家范围但只有 1 条）：openModal 开头已经调过 hideOverlapTabs()。
  return true;
}
window._openRegionById = openRegionById;

// 星标点击
(function bindCountryMetaClick() {
  var btn = document.getElementById('country-meta-btn');
  if (!btn) return;
  btn.addEventListener('click', function() {
    var ids = btn._countryMetaIds || [];
    if (!ids.length) return;
    openRegionById(ids[0]);
  });
})();

// 搜索框展开时入口下移一行让位 —— **只在真的会被压住时才让**。
// 用 MutationObserver 盯 aria-expanded，而不是给 #map-search-toggle 加 click ——
// 搜索也会被程序化地收起（清空按钮等），click 监听会漏掉那一路。
//
// 早先这里只看 aria-expanded，于是**宽屏上入口也会无缘无故往下跳**：搜索框是从左上角那枚
// 放大镜右侧展开的固定宽度（x≈60 起，见 .search-chip__field），而入口一直在正中，1280 宽下
// 两者隔着三百多像素。判据改成量出来的横向交集。
// 只看横向是安全的：入口让位只改 top，左右不动，所以这个判据不会自己把自己推翻、来回震荡。
(function bindCountryMetaShift() {
  var toggle = document.getElementById('map-search-toggle');
  var wrap = document.getElementById('country-meta-entry');
  if (!toggle || !wrap) return;
  var sync = function() {
    var shift = false;
    if (toggle.getAttribute('aria-expanded') === 'true') {
      var field = document.getElementById('map-search-field');
      // 展开顺序在 setOpen：先 field.hidden = false 再 setAttribute，而 MutationObserver 是
      // 微任务、两个赋值之后才跑，所以这里读到的 field 一定已经可见。
      if (field && !field.hidden) {
        shift = field.getBoundingClientRect().right > wrap.getBoundingClientRect().left;
      }
    }
    wrap.classList.toggle('is-shifted', shift);
  };
  new MutationObserver(sync).observe(toggle, { attributes: true, attributeFilter: ['aria-expanded'] });
  // 窗口宽度变了，两者是否重叠也跟着变；展开状态下 resize 不重算会留下过期状态。
  window.addEventListener('resize', sync);
  sync();
})();

/**
 * 处理点击某个 region（形状或圆点）：比较篮 / 打开详情（重叠时挂标签栏）。
 * @param {object} region
 * @param {Array} regions
 * @param {L.LeafletMouseEvent} e
 */
function handleRegionClick(region, regions, e) {
  if (region._countryVisible === false || region._searchVisible === false) return;
  L.DomEvent.stopPropagation(e);
  if (window._compareBasket && window._compareBasket.getSlots().length > 0) {
    window._compareBasket.add(region);
    return;
  }
  var rawLat = e.latlng.lat;
  var rawLng = e.latlng.lng;
  var overlapping = [region.id].concat(
    findOverlappingRegions(regions, rawLat, rawLng, region.id)
  );
  // 始终打开默认（最上层）条目；切换只通过标签栏（不再顺序循环）
  openModal(region);
  if (overlapping.length > 1) {
    showOverlapTabs(regions, overlapping, region.id);
  } else {
    hideOverlapTabs();
  }
}

/**
 * 当前激活的国家/地区
 */
let _activeRegion = null;

/**
 * 初始化国家切换标签栏
 * @param {Array} regions
 * @param {string} defaultRegion — 默认显示的国家，如 "south-africa"
 */
function initCountryTabs(regions, defaultRegion) {
  const bar = document.getElementById('country-bar');
  bar.innerHTML = '';

  var countryMap = window._countryMap || {};

  function flagUrl(rec) {
    var f = rec.flag;
    if (!f) return '';
    if (f.startsWith('http')) return f;
    return 'https://flagcdn.com/w80/' + f + '.png';
  }

  // Collect country ids that have data, plus all from _countryMap
  var ids = Object.keys(countryMap);
  if (ids.length === 0) {
    // Fallback: extract from regions data
    var seen = {};
    regions.forEach(function(r) { seen[r.region] = true; });
    ids = Object.keys(seen);
  }

  // Sort by _countryMap sort_order, then alphabetically
  ids = sortCountryIds(countryMap);

  ids.forEach(function(id) {
    var rec = countryMap[id];
    var displayName = rec ? rec.name : id;

    const btn = document.createElement('button');
    btn.className = 'country-tab';
    btn.setAttribute('role', 'tab');

    if (rec && rec.flag) {
      var flagImg = document.createElement('img');
      flagImg.className = 'country-tab__flag';
      flagImg.src = flagUrl(rec);
      flagImg.alt = '';
      flagImg.setAttribute('aria-hidden', 'true');
      flagImg.loading = 'lazy';
      btn.appendChild(flagImg);
    }

    var label = document.createElement('span');
    label.textContent = displayName;
    btn.appendChild(label);

    btn.dataset.region = id;
    btn.addEventListener('click', function() { switchCountry(regions, id); });
    bar.appendChild(btn);

    if (id === defaultRegion) {
      btn.classList.add('is-active');
      _activeRegion = id;
    }
  });

  // If defaultRegion wasn't in the list, activate the first tab
  if (!_activeRegion && ids.length > 0) {
    _activeRegion = ids[0];
    var firstBtn = bar.querySelector('.country-tab');
    if (firstBtn) firstBtn.classList.add('is-active');
  }

  setupCountryScroll(bar);

  switchCountry(regions, _activeRegion || defaultRegion);
}

/**
 * 横向滚动条的通用交互：左右箭头（位于滚动容器外，保持固定）+ 鼠标滚轮转横向滚动。
 * 内容溢出时箭头显示、不溢出时隐藏；滚到端点时对应箭头 disabled。
 *
 * 页脚国家栏与弹窗重叠标签栏共用这一份 —— 两处只差容器和箭头的取法。
 * @param {HTMLElement} bar — 滚动容器
 * @param {HTMLElement} left — 左箭头
 * @param {HTMLElement} right — 右箭头
 * @returns {Function} update —— 内容变化后调用它刷新箭头显隐/端点态
 */
function setupHorizontalScroll(bar, left, right) {
  if (!bar || !left || !right) return function() {};

  function update() {
    const max = bar.scrollWidth - bar.clientWidth;
    const overflow = max > 1;
    left.hidden = !overflow;
    right.hidden = !overflow;
    if (!overflow) return;
    left.disabled = bar.scrollLeft <= 0;
    right.disabled = bar.scrollLeft >= max - 1;
  }

  const step = function() { return Math.max(120, bar.clientWidth * 0.7); };
  left.addEventListener('click', function() { bar.scrollBy({ left: -step(), behavior: 'smooth' }); });
  right.addEventListener('click', function() { bar.scrollBy({ left: step(), behavior: 'smooth' }); });

  // 鼠标滚轮转横向滚动，比点击箭头更自然流畅
  bar.addEventListener('wheel', function(e) {
    const max = bar.scrollWidth - bar.clientWidth;
    if (max <= 0) return;
    const delta = e.deltaY !== 0 ? e.deltaY : e.deltaX;
    const target = bar.scrollLeft + delta;
    // 到两端时把滚动交还给页面（不 preventDefault），避免页面被锁死
    if (target < 0 || target > max) return;
    e.preventDefault();
    bar.scrollLeft = target;
  }, { passive: false });

  bar.addEventListener('scroll', update);
  window.addEventListener('resize', update);
  update();
  return update;
}

/**
 * 国家栏横向滚动（签名的行为与外层调用点保持不变）。
 * @param {HTMLElement} bar — 滚动容器（.country-bar）
 */
function setupCountryScroll(bar) {
  const row = bar.parentElement;
  return setupHorizontalScroll(
    bar,
    row && row.querySelector('.country-scroll--left'),
    row && row.querySelector('.country-scroll--right')
  );
}

/**
 * 切换国家
 */
function switchCountry(regions, regionName) {
  _activeRegion = regionName;
  if (typeof closeContributorsPanel === 'function') closeContributorsPanel();

  // 进入国家即预取贡献者数据，使贡献者面板打开时无需再请求
  if (typeof window._prefetchContributors === 'function') window._prefetchContributors(regionName);

  // 同步 URL（replaceState 不增加历史记录，避免回退时逐国跳转）
  var url = new URL(window.location);
  url.searchParams.set('country', regionName);
  window.history.replaceState(null, '', url.toString());

  // 更新标签样式
  document.querySelectorAll('.country-tab').forEach(function(btn) {
    btn.classList.toggle('is-active', btn.dataset.region === regionName);
  });

  // 更新地图可见性
  regions.forEach(function(r) {
    const visible = (r.region === regionName);
    r._countryVisible = visible;
    const layer = _polygonLayers.get(r.id);
    if (layer) {
      const searchVisible = r._searchVisible !== false;
      const show = visible && searchVisible;
      layer.eachLayer(function(l) {
        if (l._isPoint) {
          l.setOpacity(show ? 1 : 0);
          var pe = l.getElement && l.getElement();
          if (pe) pe.style.pointerEvents = show ? 'auto' : 'none';
          return; // 点无 arrow decorator / click target / _path
        }
        var feat = l.feature;
        var isLine = feat && feat.geometry && feat.geometry.type === 'LineString';
        if (isLine) {
          l.setStyle({
            opacity: show ? 1 : 0,
            pointerEvents: show ? 'auto' : 'none'
          });
        } else {
          l.setStyle({
            opacity: show ? 1 : 0,
            fillOpacity: show ? 0.52 : 0,
            pointerEvents: show ? 'auto' : 'none'
          });
        }
        // Toggle arrow decorator visibility (country + search visible and not
        // collapsed to a dot)
        if (l._arrowDecorator) {
          if (featureArrowsVisible(window._geoguideMap, l.feature, r)) {
            l._arrowDecorator.addTo(window._geoguideMap);
          } else {
            window._geoguideMap.removeLayer(l._arrowDecorator);
          }
        }
        // Force pointer-events on the SVG element itself — Leaflet's
        // setStyle silently ignores pointerEvents, so without this
        // hidden regions still show a pointer cursor on hover.
        //
        // 线是例外：可见细线**永远**不能接指针事件。线另有一条 28px 宽的不可见
        // clickTarget 负责命中，只有它带 leaflet-interactive（pointer 光标）和
        // click 处理器。可见线在 DOM 里压在那条 clickTarget 上面（先加靶、后加线），
        // 一旦给它 auto，指针正好压住线时就被它抢走 —— 它没有那些 class 和处理器，
        // 于是光标退回容器继承来的 grab，点击也无人响应。
        // 多边形的可见路径自己就是点击层，所以那条分支保持原样。
        var pathEl = l._path;
        if (pathEl) {
          pathEl.style.pointerEvents = (show && !isLine) ? 'auto' : 'none';
        }
        // Toggle invisible click target for LineStrings
        if (l._clickTarget) {
          if (show) {
            l._clickTarget.addTo(window._geoguideMap);
          } else {
            window._geoguideMap.removeLayer(l._clickTarget);
          }
        }
      });
      refreshRegionDot(window._geoguideMap, layer);
    }

  });

  // 清除贡献者筛选（范围限定当前国家），并重新应用搜索/标签筛选
  if (window._selectedContributors) {
    window._selectedContributors = null;
    document.dispatchEvent(new CustomEvent('contribfilter:change'));
  }

  // 适配地图视图到当前国家
  var bounds = getCountryBounds(regionName);
  if (window._geoguideMap) {
    window._geoguideMap.fitBounds(bounds, { padding: [20, 20] });
  }

  // 国家范围入口（星标 / 空态）。挂在这里是因为「切国家」是它唯一的刷新时机 ——
  // 初始加载时 initCountryTabs 也会调一次 switchCountry，所以首屏就位。
  // 搜索/标签筛选**有意不联动**，理由见 updateCountryMetaEntry 的说明。
  updateCountryMetaEntry(regions, regionName);

  // 标签筛选面板按当前国家收窄（只列该国 region 真正带有的标签），切国家是它唯一的刷新时机
  // —— 与上一行 updateCountryMetaEntry 同一个理由，所以挂在同一处。
  // 用 document 事件而不是直接调用：面板在 explore.html 的内联脚本里，map.js 不该知道它存在。
  // **不能复用上面那个 `contribfilter:change`** —— 它裹在 `if (window._selectedContributors)`
  // 里，是个条件触发，拿它当「国家已切换」的信号会在多数情况下静默丢事件。
  document.dispatchEvent(new CustomEvent('countryfilter:change', { detail: { country: regionName } }));
}

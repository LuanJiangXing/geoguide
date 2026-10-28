/**
 * GeoGuide 首页世界地图
 *
 * 依赖：
 *  - window._countryMap：由 index.html 内联脚本构建，形如
 *    { <id>: { name, flag, region_count, ... } }
 *  - public/images/world.svg：每个国家一个 <path id="<小写 iso2>" aria-label="<英文名>">
 *
 * 行为：有 region 贡献（region_count>0）→ 绿色；其余 → 灰色。
 *       点击绿色/有条目的灰国家 → /explore?country=<id>；
 *       点击无条目的灰国家 → 打开提案弹窗并预选该国。
 */
(function() {
  'use strict';

  // 非 ISO-2 的 flag（flagcdn 细分码）→ 父级 ISO-2 覆盖映射。
  // 台湾/香港/澳门在 world.svg 中各有独立 path，各匹配自己的国家条目；
  // 无独立条目时经 TERRITORY_PARENT 回退到 cn（仍表现为中国的一部分）。
  var FLAG_OVERRIDES = { 'us-hi': 'us' };
  var TERRITORY_PARENT = { 'hk': 'cn', 'tw': 'cn', 'mo': 'cn' };
  // 领土显示名 + 跳转目标 id：显示名覆盖 DB 国家名（Hong Kong SAR/Macau SAR/Chinese Taipei）；
  // id 只在对应 id 是国家记录时生效（否则回退该领土现有条目 id）。noFlag：台湾不显示旗帜。
  var TERRITORY_LABELS = {
    'hk': { name: 'Hong Kong SAR', id: 'hongkong' },
    'mo': { name: 'Macau SAR',     id: 'macau' },
    'tw': { name: 'Chinese Taipei', id: 'taiwan', noFlag: true }
  };

  function isoFor(flag) {
    var f = (flag || '').toLowerCase();
    return FLAG_OVERRIDES[f] || f;
  }

  var _injected = false;

  function setHomeView(view) {
    var isMap = view === 'map';
    var cards = document.getElementById('countries');
    var map = document.getElementById('world-map');
    var cardsBtn = document.getElementById('view-cards-btn');
    var mapBtn = document.getElementById('view-map-btn');
    if (cards) cards.hidden = isMap;
    if (map) map.hidden = !isMap;
    if (cardsBtn) { cardsBtn.classList.toggle('is-active', !isMap); cardsBtn.setAttribute('aria-selected', isMap ? 'false' : 'true'); }
    if (mapBtn) { mapBtn.classList.toggle('is-active', isMap); mapBtn.setAttribute('aria-selected', isMap ? 'true' : 'false'); }
  }

  function renderWorldMap(countryMap) {
    if (_injected) return;
    _injected = true;

    var section = document.getElementById('world-map');
    var host = document.getElementById('world-map-svg');
    if (!section || !host) return;

    countryMap = countryMap || window._countryMap || {};

    // 切换按钮
    var cardsBtn = document.getElementById('view-cards-btn');
    var mapBtn = document.getElementById('view-map-btn');
    if (cardsBtn) cardsBtn.addEventListener('click', function() { setHomeView('cards'); });
    // 懒加载：首次需要地图时才拉取 SVG（约 1.2MB）；默认视图为地图时由 showWorldMap 触发
    if (mapBtn) mapBtn.addEventListener('click', function() { setHomeView('map'); loadMap(); });
    // 首页默认视图为地图：供 index.html 在 #world-map 可见后调用（loadMap 幂等，重复调用不会重复拉取）
    window.showWorldMap = function() {
      setHomeView('map');
      loadMap();
    };

    // iso2 -> [ { id, name, flag, region_count } ]（同一 iso 可映射多条，如 us 与 us-hi）
    var byIso = {};
    Object.keys(countryMap).forEach(function(id) {
      var c = countryMap[id];
      var iso = isoFor(c.flag);
      if (!iso) return;
      (byIso[iso] = byIso[iso] || []).push({
        id: id,
        name: c.name,
        flag: c.flag,
        region_count: c.region_count || 0
      });
    });

    // 该 iso 点击应跳转的条目：优先有贡献的，否则取第一条。
    // 领土（hk/tw/mo）无独立国家条目时，回退到父级 cn 的条目（仍表现为中国的一部分）。
    function entryFor(iso) {
      var list = byIso[iso] || [];
      if (!list.length) {
        var parent = TERRITORY_PARENT[iso];
        if (parent) return entryFor(parent);
        return null;
      }
      for (var i = 0; i < list.length; i++) if (list[i].region_count > 0) return list[i];
      return list[0];
    }

    // 小国圆点：bbox 过小的国家在地图上几乎点不到，叠加一个可点的圆点
    function addSmallCountryDots(svg) {
      var SMALL_AREA_THRESHOLD = 20; // viewBox 单位²（约 4.5×4.5 像素）
      var NS = 'http://www.w3.org/2000/svg';
      // #world-map 默认 hidden，直接 append 会让 getBBox 返回 0，故先离屏挂载测量
      var probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-10000px;top:0;width:900px;';
      document.body.appendChild(probe);
      probe.appendChild(svg);

      var count = 0;
      var placedDots = [];   // 已放置的领土小国圆点（viewBox 坐标）
      var DOT_MIN_SEP = 11;  // 圆点最小中心距（viewBox 单位，≈9px）。港澳中心距仅 ~1.6，
                             // 若不推开，r=6 的两个圆点几乎完全重叠，后加入的（Macau）盖住前一个，HK 点不到
      Array.prototype.forEach.call(svg.querySelectorAll('path'), function(p) {
        var bbox;
        try { bbox = p.getBBox(); } catch (e) { return; }
        if (!bbox || (bbox.width * bbox.height) > SMALL_AREA_THRESHOLD) return;
        // 领土无独立国家条目时（继承 cn），其位置已有中国本体，无需叠加小国圆点
        if (p.getAttribute('data-territory-own') === '0') return;
        var isTerritory = !!TERRITORY_LABELS[p.getAttribute('id')];

        var cx = bbox.x + bbox.width / 2;
        var cy = bbox.y + bbox.height / 2;
        // 相邻领土圆点重叠 → 把后加入的沿远离已有圆点的方向推开，保证每个都可点击
        if (isTerritory) {
          for (var k = 0; k < placedDots.length; k++) {
            var dx = cx - placedDots[k].cx;
            var dy = cy - placedDots[k].cy;
            var dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < DOT_MIN_SEP) {
              var push = DOT_MIN_SEP - dist;
              if (dist < 0.5) { dx = -8; dy = 2; dist = Math.sqrt(68); } // 完全重合时给默认方向
              cx += dx / dist * push;
              cy += dy / dist * push;
            }
          }
          placedDots.push({ cx: cx, cy: cy });
        }

        var dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', cx);
        dot.setAttribute('cy', cy);
        dot.setAttribute('r', '6');
        dot.setAttribute('class', 'country-dot' + (p.classList.contains('has-regions') ? ' country-dot--has-regions' : ''));

        dot.setAttribute('data-flag', p.getAttribute('data-flag') || '');
        dot.setAttribute('data-name', p.getAttribute('data-name') || '');
        dot.setAttribute('data-regions', p.getAttribute('data-regions') || '0');
        if (p.hasAttribute('data-china-part')) dot.setAttribute('data-china-part', '1');
        var geoId = p.getAttribute('data-geo-id');
        if (geoId) {
          dot.setAttribute('data-geo-id', geoId);
          dot.setAttribute('tabindex', '0');
          dot.setAttribute('role', 'link');
          dot.setAttribute('aria-label', p.getAttribute('aria-label'));
        } else {
          var propose = p.getAttribute('data-propose');
          if (propose) dot.setAttribute('data-propose', propose);
        }
        svg.appendChild(dot);
        count++;
      });

      probe.removeChild(svg);
      document.body.removeChild(probe);
      return count;
    }

    // SVG 体积约 1.2MB，懒加载：首次切「地图」视图才 fetch，且只 fetch 一次。
    var _mapLoaded = false;
    var _loadingMap = false;
    function loadMap() {
      if (_mapLoaded || _loadingMap) return;
      _loadingMap = true;
      // 以下 fetch 链保持原有缩进（最小 diff）
      fetch('images/world.svg?v=4')
      .then(function(r) { if (!r.ok) throw new Error('world.svg HTTP ' + r.status); return r.text(); })
      .then(function(text) {
        var tmp = document.createElement('div');
        tmp.innerHTML = text;
        var svg = tmp.querySelector('svg');
        if (!svg) throw new Error('world.svg 解析失败');

        // 缩放状态（首页地图是静态 SVG，用 transform 实现缩放 + 平移）
        var ZOOM_MIN = 1, ZOOM_MAX = 16;
        var DOT_RADIUS = 6;       // scale=1 时小国圆点半径（viewBox 单位，与 addSmallCountryDots 初始 r 一致）
        var DOT_HIDE_SCALE = 4;   // 放大到该倍数后隐藏小国圆点（小国本身已大到可点，无需辅助点）
        var _zoom = { scale: 1, tx: 0, ty: 0 };
        var _drag = null;      // 拖动中的起点信息
        var _didPan = false;   // 本次按下后是否发生过拖动（用于抑制点击跳转）

        // 某 iso 下的区域总数（同一 iso 可能映射多条，如 us + us-hi；领土无独立条目时回退 cn）
        function regionTotal(iso) {
          var list = byIso[iso] || [];
          if (!list.length) {
            var parent = TERRITORY_PARENT[iso];
            if (parent) return regionTotal(parent);
            return 0;
          }
          return list.reduce(function(s, e) { return s + (e.region_count || 0); }, 0);
        }

        Array.prototype.forEach.call(svg.querySelectorAll('path'), function(p) {
          var iso = p.getAttribute('id');
          if (p.classList.contains('nine-dash-line') || iso === 'cn' || iso === 'hk' || iso === 'mo' || iso === 'tw') {
            p.setAttribute('data-china-part', '1');
          }
          if (p.classList.contains('nine-dash-line')) return; // 九段线是装饰线，不参与着色/点击
          var entry = entryFor(iso);
          var total = regionTotal(iso);
          var own = (byIso[iso] || []).length > 0;   // 领土是否有自有国家条目
          var label = TERRITORY_LABELS[iso];         // hk/mo/tw 的显示名 + 跳转目标
          // 领土有无独立条目（无则继承 cn，不叠加小国圆点）
          if (TERRITORY_PARENT[iso]) {
            p.setAttribute('data-territory-own', own ? '1' : '0');
          }
          p.setAttribute('data-flag', entry ? entry.flag : iso);   // flagcdn 接受小写 ISO-2 码
          p.setAttribute('data-regions', total);
          if (entry) {
            if (entry.region_count > 0) p.classList.add('has-regions');
            p.setAttribute('data-geo-id', entry.id);
            p.setAttribute('data-name', entry.name);
            p.setAttribute('tabindex', '0');
            p.setAttribute('role', 'link');
            // 领土自有条目：显示名覆盖为官方英文名；跳转目标优先 label.id（若确为国家记录）
            if (label && own) {
              p.setAttribute('data-name', label.name);
              if (label.id && countryMap[label.id]) p.setAttribute('data-geo-id', label.id);
              if (label.noFlag) p.setAttribute('data-no-flag', '1');
            }
            p.setAttribute('aria-label', 'View ' + p.getAttribute('data-name'));
          } else {
            // 无任何条目：提议添加。领土按官方英文名提议（继承 cn 时不会走到这里）
            var aria = p.getAttribute('aria-label') || '';
            p.setAttribute('data-propose', aria);
            p.setAttribute('data-name', label ? label.name : aria);
            if (label && label.noFlag) p.setAttribute('data-no-flag', '1');
          }
        });

        // 小国圆点（bbox 过小难以点击）
        addSmallCountryDots(svg);

        svg.addEventListener('click', function(e) {
          if (_didPan) { _didPan = false; return; }
          var el = e.target && e.target.closest ? e.target.closest('[data-geo-id], [data-propose]') : null;
          if (!el) return;
          var geoId = el.getAttribute('data-geo-id');
          if (geoId) {
            window.location.href = '/explore?country=' + encodeURIComponent(geoId);
          } else {
            var name = el.getAttribute('data-propose');
            if (name && typeof window.openProposalModal === 'function') {
              window.openProposalModal(name);
            }
          }
        });
        svg.addEventListener('keydown', function(e) {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          var el = e.target && e.target.closest ? e.target.closest('[data-geo-id]') : null;
          if (!el) return;
          e.preventDefault();
          window.location.href = '/explore?country=' + encodeURIComponent(el.getAttribute('data-geo-id'));
        });

        // 悬浮卡片：国旗 + 国家名 + 区域数（跟随鼠标，不拦截点击）
        var tip = document.createElement('div');
        tip.className = 'world-map__tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.hidden = true;
        var tipFlag = document.createElement('img');
        tipFlag.className = 'world-map__tooltip__flag';
        tipFlag.alt = '';
        tipFlag.onerror = function() { this.style.display = 'none'; };
        var tipText = document.createElement('div');
        tipText.className = 'world-map__tooltip__text';
        var tipName = document.createElement('span');
        tipName.className = 'world-map__tooltip__name';
        var tipCount = document.createElement('span');
        tipCount.className = 'world-map__tooltip__count';
        tipText.appendChild(tipName);
        tipText.appendChild(tipCount);
        tip.appendChild(tipFlag);
        tip.appendChild(tipText);

        var _tipKey = null;
        function hideTip() { _tipKey = null; tip.hidden = true; }
        function positionTip(e) {
          var rect = host.getBoundingClientRect();
          var x = e.clientX - rect.left;
          var y = e.clientY - rect.top;
          var off = 14;
          var tw = tip.offsetWidth;
          var th = tip.offsetHeight;
          var left = x + off;
          var top = y + off;
          if (left + tw > rect.width && tw <= rect.width) left = x - off - tw;
          if (top + th > rect.height && th <= rect.height) top = y - off - th;
          if (left < 0) left = 0;
          if (top < 0) top = 0;
          tip.style.left = left + 'px';
          tip.style.top = top + 'px';
        }
        function showTip(el, e) {
          var flag = el.getAttribute('data-flag') || '';
          var name = el.getAttribute('data-name') || el.getAttribute('data-propose') || '';
          if (el.getAttribute('data-no-flag') === '1') flag = ''; // 台湾不显示旗帜
          var regions = parseInt(el.getAttribute('data-regions') || '0', 10);
          var isEntry = el.hasAttribute('data-geo-id');
          tipFlag.src = flag ? ('https://flagcdn.com/w80/' + flag + '.png') : '';
          tipFlag.style.display = flag ? '' : 'none';
          tipFlag.alt = name;
          tipName.textContent = name;
          if (isEntry && regions > 0) {
            tipCount.textContent = regions + ' regions';
          } else if (isEntry) {
            tipCount.textContent = '0 regions';
          } else {
            tipCount.textContent = 'Add your meta';
          }
          tip.hidden = false;
          positionTip(e);
        }

        var _chinaHovered = false;
        function updateChinaHover(hovered) {
          if (_chinaHovered === hovered) return;
          _chinaHovered = hovered;
          var parts = svg.querySelectorAll('[data-china-part="1"]');
          for (var i = 0; i < parts.length; i++) {
            parts[i].classList.toggle('is-china-hovered', hovered);
          }
        }

        svg.addEventListener('mousemove', function(e) {
          var el = e.target && e.target.closest ? e.target.closest('[data-geo-id], [data-propose]') : null;
          var isChina = !!(el && el.getAttribute('id') === 'cn');
          updateChinaHover(isChina);
          if (!el) { hideTip(); return; }
          var key = el.getAttribute('data-geo-id') || el.getAttribute('data-propose') || '';
          if (key !== _tipKey) { _tipKey = key; showTip(el, e); }
          else { positionTip(e); }
        });
        svg.addEventListener('mouseleave', function() {
          hideTip();
          updateChinaHover(false);
        });
        svg.addEventListener('focusin', function(e) {
          var el = e.target && e.target.closest ? e.target.closest('[data-geo-id], [data-propose]') : null;
          updateChinaHover(!!(el && el.getAttribute('id') === 'cn'));
        });
        svg.addEventListener('focusout', function() {
          updateChinaHover(false);
        });

        // 缩放控件：右下角 +/- 按钮 + 滚轮缩放 + 拖动平移
        function clampScale(s) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, s)); }
        function applyZoom() {
          var W = host.clientWidth || 1;
          var H = host.clientHeight || 1;
          var s = _zoom.scale;
          // 平移量夹紧，保证放大的地图始终铺满容器（不露白边）；scale=1 时自然归零
          _zoom.tx = Math.min(0, Math.max(W * (1 - s), _zoom.tx));
          _zoom.ty = Math.min(0, Math.max(H * (1 - s), _zoom.ty));
          svg.style.transformOrigin = '0 0';
          svg.style.transform = 'translate(' + _zoom.tx + 'px,' + _zoom.ty + 'px) scale(' + s + ')';
          updateDots(s);
        }
        // 小国圆点随缩放调整：屏幕尺寸保持恒定（r 与 scale 成反比），放大到阈值后隐藏
        function updateDots(s) {
          var hide = s >= DOT_HIDE_SCALE - 0.001;
          var r = DOT_RADIUS / s;
          Array.prototype.forEach.call(svg.querySelectorAll('.country-dot'), function(dot) {
            dot.style.display = hide ? 'none' : '';
            dot.setAttribute('r', String(r));
          });
        }
        function updateZoomButtons() {
          zoomIn.disabled = _zoom.scale >= ZOOM_MAX - 0.001;
          zoomOut.disabled = _zoom.scale <= ZOOM_MIN + 0.001;
        }
        function zoomAt(factor, cx, cy) {
          var ns = clampScale(_zoom.scale * factor);
          factor = ns / _zoom.scale;
          _zoom.tx = cx - factor * (cx - _zoom.tx);
          _zoom.ty = cy - factor * (cy - _zoom.ty);
          _zoom.scale = ns;
          applyZoom();
          updateZoomButtons();
        }

        var zoomCtrl = document.createElement('div');
        zoomCtrl.className = 'world-map__zoom';
        var zoomIn = document.createElement('button');
        zoomIn.type = 'button';
        zoomIn.setAttribute('aria-label', 'Zoom in');
        zoomIn.textContent = '+';
        var zoomOut = document.createElement('button');
        zoomOut.type = 'button';
        zoomOut.setAttribute('aria-label', 'Zoom out');
        zoomOut.textContent = '−';
        zoomCtrl.appendChild(zoomIn);
        zoomCtrl.appendChild(zoomOut);

        zoomIn.addEventListener('click', function(e) {
          e.stopPropagation();
          var rect = host.getBoundingClientRect();
          zoomAt(1.5, rect.width / 2, rect.height / 2);
        });
        zoomOut.addEventListener('click', function(e) {
          e.stopPropagation();
          var rect = host.getBoundingClientRect();
          zoomAt(1 / 1.5, rect.width / 2, rect.height / 2);
        });

        // 滚轮缩放（围绕鼠标位置）
        host.addEventListener('wheel', function(e) {
          e.preventDefault();
          var rect = host.getBoundingClientRect();
          zoomAt(e.deltaY < 0 ? 1.15 : 0.87, e.clientX - rect.left, e.clientY - rect.top);
        }, { passive: false });

        // 拖动平移（仅放大后；拖过即抑制后续点击跳转）
        host.addEventListener('mousedown', function(e) {
          if (e.target && e.target.closest && e.target.closest('.world-map__zoom')) return;
          // 每次按下都重置拖动标志：若上次拖动结束在地图外（未触发 click 清除 _didPan），
          // 遗留的 true 会吞掉本次点击。重置保证每个新手势从干净状态开始。
          _didPan = false;
          if (_zoom.scale <= ZOOM_MIN + 0.001) return;
          _drag = { x: e.clientX, y: e.clientY, tx: _zoom.tx, ty: _zoom.ty };
        });
        window.addEventListener('mousemove', function(e) {
          if (!_drag) return;
          var dx = e.clientX - _drag.x, dy = e.clientY - _drag.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) {
            _didPan = true;
            _zoom.tx = _drag.tx + dx;
            _zoom.ty = _drag.ty + dy;
            applyZoom();
          }
        });
        window.addEventListener('mouseup', function() { _drag = null; });

        updateZoomButtons();
        host.appendChild(zoomCtrl);
        host.appendChild(tip);
        host.appendChild(svg);
        _mapLoaded = true;
        _loadingMap = false;
      })
      .catch(function(err) {
        _loadingMap = false;
        console.warn('World map failed to load:', err && err.message);
        // 降级：隐藏地图视图并禁用「地图」按钮，卡片视图照常
        if (section) section.hidden = true;
        if (mapBtn) { mapBtn.disabled = true; mapBtn.title = 'Map unavailable'; }
        setHomeView('cards');
      });
    }
  }

  window.renderWorldMap = renderWorldMap;
})();

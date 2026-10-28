/**
 * 初始化搜索和标签筛选
 * @param {Array} regions — 全部区域数据
 */
function initSearch(regions) {
  const searchInput = document.getElementById('search-input');

  // 搜索输入:180ms 防抖 + IME 守卫。
  // 防抖:每敲一个字符 applyFilters 都要遍历全部 region 并逐个改 Leaflet 图层样式。
  // IME 守卫:中文组词过程中 input 会连发若干半截拼音,不过滤到中间态、也就不会闪。
  // 组词结束(compositionend)与回车立即结算,不等防抖。语义仍是 applyFilters(regions, value)。
  var searchTimer = null;
  function runSearchNow() {
    clearTimeout(searchTimer);
    applyFilters(regions, searchInput.value);
  }
  searchInput.addEventListener('input', function(e) {
    if (e.isComposing) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() { applyFilters(regions, searchInput.value); }, 180);
  });
  searchInput.addEventListener('compositionend', runSearchNow);
  searchInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') runSearchNow();
  });

  // 监听来自标签下拉菜单的筛选变化
  document.addEventListener('tagfilter:change', function() {
    applyFilters(regions, searchInput.value);
  });

  // 监听贡献者筛选变化
  document.addEventListener('contribfilter:change', function() {
    applyFilters(regions, searchInput.value);
  });
}

/**
 * 应用搜索 + 标签 + 国家三重筛选
 */
function applyFilters(regions, query) {
  const q = (query || '').toLowerCase().trim();
  const tagsByCategory = window._selectedTagsByCategory || {};
  let visibleCount = 0;

  regions.forEach(function(region) {
    let visible = true;

    // 文本搜索
    if (q && region.name.toLowerCase().indexOf(q) === -1) {
      visible = false;
    }

    // 标签筛选：同 category 内 OR（任一 tag 命中即可），跨 category 为 AND。
    // 含子标签继承：选父标签 = 也匹配所有子标签。
    const activeCats = Object.keys(tagsByCategory).filter(function(c) {
      return tagsByCategory[c] && tagsByCategory[c].length > 0;
    });
    if (activeCats.length > 0) {
      const childrenMap = window._tagChildrenMap || {};
      const scopedChildren = window._scopedChildrenMap || {};
      const legacyTagToCats = window._legacyTagToCats || {};
      const matchAllCats = activeCats.every(function(catName) {
        const wanted = tagsByCategory[catName];
        const regionTags = region.tags || [];
        // OR within the category: region matches if it has ANY wanted tag
        return wanted.some(function(t) {
          return regionTags.some(function(rt) {
            var p = typeof parseTag === 'function' ? parseTag(rt) : { category: null, name: rt };
            var rtName = p.name;
            var rtCat = p.category;

            // Check if tag name matches wanted or a child of wanted
            var nameMatches = (rtName === t);
            if (!nameMatches) {
              var children = scopedChildren[catName + ':' + t] || childrenMap[t];
              if (children && children.length > 0) {
                nameMatches = children.indexOf(rtName) !== -1;
              }
            }
            if (!nameMatches) return false;

            // Name matches! Now verify category match
            if (rtCat) {
              // rt explicitly specified category: MUST match catName
              return rtCat === catName;
            } else {
              // Legacy tag without category prefix
              var cats = legacyTagToCats[rtName];
              if (cats && cats.length > 0) {
                return cats.indexOf(catName) !== -1;
              }
              // Fallback if not found in catalog
              return true;
            }
          });
        });
      });
      if (!matchAllCats) visible = false;
    }

    // 贡献者筛选：默认全选（=显示全部）。取消勾选某位贡献者即排除其提交；
    // 无 user_id 的提交不归属任何贡献者，始终显示。
    const contrib = window._selectedContributors;
    if (contrib) {
      const uid = region.user_id || '';
      if (uid && (contrib.user_ids || []).indexOf(uid) === -1) {
        visible = false;
      }
    }

    // 国家筛选（由 countryTabs 模块控制，这里不覆盖）
    // 此处仅叠加搜索和标签条件

    // 更新地图图层可见性
    const layer = window._polygonLayers && window._polygonLayers.get(region.id);
    if (layer) {
      if (visible) {
        if (region._countryVisible !== false) {
          // 先置可见，featureArrowsVisible 依赖 _searchVisible 判定
          region._searchVisible = true;
          layer.eachLayer(function(l) {
            if (l._isPoint) { l.setOpacity(1); var pe=l.getElement&&l.getElement(); if(pe) pe.style.pointerEvents='auto'; return; }
            var feat = l.feature;
            var isLine = feat && feat.geometry && feat.geometry.type === 'LineString';
            if (isLine) {
              l.setStyle({ opacity: 1, pointerEvents: 'auto' });
            } else {
              l.setStyle({ opacity: 1, fillOpacity: 0.52, pointerEvents: 'auto' });
            }
            // Show arrow decorator (only if not collapsed to a dot)
            if (l._arrowDecorator && featureArrowsVisible(window._geoguideMap, l.feature, region)) {
              l._arrowDecorator.addTo(window._geoguideMap);
            }
          });
        }
      } else {
        layer.eachLayer(function(l) {
          if (l._isPoint) { l.setOpacity(0); var pe=l.getElement&&l.getElement(); if(pe) pe.style.pointerEvents='none'; return; }
          var feat = l.feature;
          var isLine = feat && feat.geometry && feat.geometry.type === 'LineString';
          if (isLine) {
            l.setStyle({ opacity: 0, pointerEvents: 'none' });
          } else {
            l.setStyle({ opacity: 0, fillOpacity: 0, pointerEvents: 'none' });
          }
          // Hide arrow decorator
          if (l._arrowDecorator && window._geoguideMap) {
            window._geoguideMap.removeLayer(l._arrowDecorator);
          }
        });
        region._searchVisible = false;
      }
      if (typeof refreshRegionDot === 'function' && window._geoguideMap) {
        refreshRegionDot(window._geoguideMap, layer);
      }
    }

    if (visible) visibleCount++;
  });

  // 更新实时区域的可见区域计数
  const statusEl = document.getElementById('filter-status');
  if (statusEl) {
    statusEl.textContent = visibleCount + ' / ' + regions.length + ' regions visible';
  }
}

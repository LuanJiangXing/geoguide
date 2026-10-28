/**
 * GeoGuide 应用入口
 * 加载数据 → 初始化地图 → 渲染区域 → 绑定交互
 */
(function() {
  'use strict';

  document.addEventListener('DOMContentLoaded', function() {
    fetch('/api/submissions?_t=' + Date.now()).then(function(r) { return r.text(); })
      .then(function(t) { return JSON.parse(t); })
      .catch(function() { return []; })
      .then(function(liveSubmissions) {
        const regions = normalizeRecords(liveSubmissions);
        if (!regions || regions.length === 0) {
          throw new Error('数据文件为空');
        }

        // 暴露供 search 模块使用
        regions.forEach(function(r) {
          r._countryVisible = true;
          r._searchVisible = true;
        });

        // 读取 URL 中的 country 参数（提前到 initMap 之前，避免初始视图二次跳变）
        var urlParams = new URLSearchParams(window.location.search);
        var defaultCountry = urlParams.get('country') || 'south-africa';

        // 初始化各模块 — 传入默认国家的 bounds，确保首帧就是正确的缩放级别
        var bounds = getCountryBounds(defaultCountry);
        const map = initMap('map', bounds);

        // 暴露 map 给全局（供 country tabs fitBounds 等使用）
        window._geoguideMap = map;

        renderRegions(map, regions);

        // 确保 polygon 层已在 window 上（由 map.js 维护）
        window._polygonLayers = window._polygonLayers || new Map();

        // Auto-open region modal from ?region= URL param.
        // 走 map.js 的 _openRegionById 而不是直接 openModal：国家范围条目还要把该国的
        // 标签栏一并摆出来（见 map.js 里那个函数的说明）。两条入口一条路，别再分叉。
        var regionParam = urlParams.get('region');
        if (regionParam) {
          setTimeout(function() {
            if (window._openRegionById) window._openRegionById(regionParam);
          }, 500);
        }

        initCountryTabs(regions, defaultCountry);
        initSearch(regions);

        console.log('GeoGuide ready — ' + regions.length + ' regions loaded.');
      })
      .catch(function(err) {
        var el = document.getElementById('load-error');
        var msg = document.getElementById('load-error-msg');
        if (el && msg) {
          msg.textContent = '无法加载数据文件：' + err.message
            + '。请确保通过本地静态服务器访问（非 file:// 协议）。';
          el.hidden = false;
        }
        console.error('GeoGuide data load failed:', err);
        // 地图这条路走完了（走不通）也要放行 mapready —— explore 的放大镜与筛选被 CSS 闸门
        // 压在它后面（见 map.js 派发处的说明）。不放行的话地图一旦起不来，那两个会被永久藏住，
        // 连「筛选面板能独立取 /api/tags」这点可用性也一起没了。
        document.dispatchEvent(new CustomEvent('mapready'));
      });
  });

  /**
   * 兼容多种 JSON 结构
   */
  function normalizeRecords(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && raw.regions) return raw.regions;
    if (raw && raw.items) return raw.items;
    if (raw && raw.type === 'FeatureCollection') {
      return raw.features.map(function(f) { return f.properties || f; });
    }
    return [raw];
  }
})();

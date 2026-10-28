/**
 * 底图切换：OSM ↔ Google 标准道路图（roadmap）
 * 依赖（需在本文件之前加载）：
 *   - Leaflet（L）
 *   - leaflet.gridlayer.googlemutant（L.gridLayer.googleMutant）
 *   - config.js（window.__GEOCONFIG__.GOOGLE_MAPS_API_KEY）
 * 用法：initBasemapSwitcher(map, osmLayer)
 */
(function () {
  var _gmapsCbCounter = 0;

  function initBasemapSwitcher(map, osmLayer) {
    if (!map || !osmLayer) return;

    var key = window.__GEOCONFIG__ && window.__GEOCONFIG__.GOOGLE_MAPS_API_KEY;
    var googleLayer = null;     // googlemutant 图层实例（懒创建、复用，避免重复计费）
    var loadPromise = null;     // 在途的脚本加载 Promise（去重）
    var preloadScheduled = false;
    var selectionToken = 0;     // 选择令牌：异步加载完成时忽略用户已切换的选择
    var btnOsm = null;
    var btnGoogle = null;

    // 极简提示（不依赖页面级 showToast；explore/submit 均无全局 showToast）
    function notify(msg) {
      var el = document.createElement('div');
      el.className = 'basemap-toast';
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 3500);
    }

    // 动态加载 Google Maps JS SDK。仅下载脚本、不创建地图实例，因此不消耗配额。
    function loadGoogleMaps() {
      if (window.google && window.google.maps) return Promise.resolve();
      if (loadPromise) return loadPromise;
      loadPromise = new Promise(function (resolve, reject) {
        var cb = '__ggGmapsReady' + (++_gmapsCbCounter);
        window[cb] = function () {
          try { delete window[cb]; } catch (e) { window[cb] = undefined; }
          resolve();
        };
        var s = document.createElement('script');
        s.src = 'https://maps.googleapis.com/maps/api/js?key=' + encodeURIComponent(key) + '&callback=' + cb + '&loading=async';
        s.async = true;
        s.onerror = function () {
          try { delete window[cb]; } catch (e) {}
          loadPromise = null;
          reject(new Error('Google Maps script failed to load'));
        };
        document.head.appendChild(s);
      });
      return loadPromise;
    }

    // 创建（并缓存）googlemutant 图层实例。首次调用才真正创建地图实例。
    function getGoogleLayer() {
      if (googleLayer) return Promise.resolve(googleLayer);
      return loadGoogleMaps().then(function () {
        if (!googleLayer) {
          googleLayer = L.gridLayer.googleMutant({ type: 'roadmap', maxZoom: 21 });
        }
        return googleLayer;
      });
    }

    // 空闲时预下载 Google Maps JS 脚本（不创建实例、不耗配额）
    function schedulePreload() {
      if (preloadScheduled) return;
      preloadScheduled = true;
      if (!key) return;   // 无 key 时不预加载；点击时 showGoogle 会立即提示
      var doLoad = function () {
        loadGoogleMaps().catch(function () { /* 静默；点击时按需重试 */ });
      };
      if (window.requestIdleCallback) {
        window.requestIdleCallback(doLoad, { timeout: 3000 });
      } else {
        setTimeout(doLoad, 2000);
      }
    }

    function setActive(which) {
      if (btnOsm) btnOsm.classList.toggle('is-active', which === 'osm');
      if (btnGoogle) btnGoogle.classList.toggle('is-active', which === 'google');
      // 让样式层知道当前是哪张底图 —— Google 会在**左下角**画自己的水印，比例尺要让位。
      // 挂在 setActive 而不是各个 showXxx 里：成功切换、加载失败回退、主动切回 OSM
      // 三条路径都收敛到这一个函数，漏一条就会留下错位的水印间隙。
      if (document.body) document.body.classList.toggle('basemap-google', which === 'google');
    }

    function showGoogle() {
      if (!key) {
        notify('未配置 Google Maps API Key');
        return;
      }
      var token = ++selectionToken;
      getGoogleLayer().then(function (layer) {
        if (token !== selectionToken) return;   // 用户已切换选择，忽略
        if (map.hasLayer(osmLayer)) map.removeLayer(osmLayer);
        if (!map.hasLayer(layer)) map.addLayer(layer);
        setActive('google');
      }).catch(function () {
        if (token !== selectionToken) return;
        if (!map.hasLayer(osmLayer)) map.addLayer(osmLayer);
        setActive('osm');
        notify('Google Maps 加载失败，已切回 OSM');
      });
    }

    function showOsm() {
      selectionToken++;   // 使任何 pending 的 Google 切换失效
      if (googleLayer && map.hasLayer(googleLayer)) map.removeLayer(googleLayer);
      if (!map.hasLayer(osmLayer)) map.addLayer(osmLayer);
      setActive('osm');
    }

    // Google 认证失败（无效 key / API 未启用 / 配额用尽）时回退到 OSM。
    // Google Maps JS 检测到认证失败时会调用全局 gm_authFailure（若已定义）。
    window.gm_authFailure = function () {
      showOsm();
      notify('Google Maps 认证失败，已切回 OSM');
    };

    // 右上角 segmented control
    var Switcher = L.Control.extend({
      options: { position: 'topright' },
      onAdd: function () {
        var wrap = L.DomUtil.create('div', 'basemap-switch');

        btnOsm = L.DomUtil.create('button', 'basemap-switch__btn is-active');
        btnOsm.type = 'button';
        btnOsm.textContent = 'OSM';
        btnOsm.setAttribute('aria-label', 'Switch to OpenStreetMap basemap');

        btnGoogle = L.DomUtil.create('button', 'basemap-switch__btn');
        btnGoogle.type = 'button';
        btnGoogle.textContent = 'Google';
        btnGoogle.setAttribute('aria-label', 'Switch to Google roadmap basemap');

        L.DomEvent.disableClickPropagation(wrap);
        L.DomEvent.disableScrollPropagation(wrap);

        L.DomEvent.on(btnOsm, 'click', function () { showOsm(); });
        L.DomEvent.on(btnGoogle, 'click', function () { showGoogle(); });

        wrap.appendChild(btnOsm);
        wrap.appendChild(btnGoogle);
        return wrap;
      }
    });
    map.addControl(new Switcher());

    schedulePreload();
  }

  window.initBasemapSwitcher = initBasemapSwitcher;
})();

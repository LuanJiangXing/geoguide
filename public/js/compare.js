/**
 * Region Compare Basket & Compare View
 * Depends: utils.js (escapeHtml, displayName), marked.js, DOMPurify
 * Consumed by: modal.js (Compare button), map.js (+Compare on hover)
 */
(function() {
  'use strict';

  // --- Basket state ---
  var compareSlots = [];        // max 2, each is a region object
  var floatingBar = null;       // DOM element
  var compareOverlay = null;    // DOM element

  // --- Public API ---
  window._compareBasket = {
    add: addToCompare,
    remove: removeFromCompare,
    dismiss: dismissCompare,
    getSlots: function() { return compareSlots.slice(); }
  };

  function addToCompare(region) {
    if (!region || !region.id) return;
    // 国家范围条目（scope === 'country'）暂不支持对比。挡在这里而不是只藏按钮：
    // 地图点击路径（map.js 的 handleRegionClick）也会走到这个函数，
    // 只在 UI 上藏按钮的话，篮子非空时点星标仍会把它塞进去。
    if (region.scope === 'country') return;

    // Toggle: if already in slots, remove it
    for (var i = 0; i < compareSlots.length; i++) {
      if (compareSlots[i].id === region.id) {
        compareSlots.splice(i, 1);
        renderFloatingBar();
        return;
      }
    }

    // If 2 slots full, replace slot 2
    if (compareSlots.length >= 2) {
      compareSlots[1] = region;
    } else {
      compareSlots.push(region);
    }

    renderFloatingBar();

    // Auto-open when both slots filled
    if (compareSlots.length === 2) {
      _openCompareView();
    }
  }

  function removeFromCompare(regionId) {
    compareSlots = compareSlots.filter(function(r) { return r.id !== regionId; });
    renderFloatingBar();
  }

  function dismissCompare() {
    compareSlots = [];
    removeFloatingBar();
  }

  // --- Floating Bar ---

  function removeFloatingBar() {
    if (floatingBar) {
      floatingBar.remove();
      floatingBar = null;
    }
  }

  function renderFloatingBar() {
    removeFloatingBar();
    if (compareSlots.length === 0) return;

    floatingBar = document.createElement('div');
    floatingBar.className = 'compare-bar';
    floatingBar.setAttribute('role', 'status');
    floatingBar.setAttribute('aria-live', 'polite');

    var label = document.createElement('span');
    label.className = 'compare-bar__label';
    label.innerHTML = 'Comparing: <strong>' +
      escapeHtml(displayName(compareSlots[0].name)) + '</strong> + ?';

    var hint = document.createElement('span');
    hint.className = 'compare-bar__hint';
    hint.textContent = 'Click another region on the map';

    var dismissBtn = document.createElement('button');
    dismissBtn.className = 'compare-bar__dismiss';
    dismissBtn.setAttribute('aria-label', 'Cancel compare');
    dismissBtn.innerHTML = '&times;';
    dismissBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      dismissCompare();
    });

    floatingBar.appendChild(label);
    floatingBar.appendChild(hint);
    floatingBar.appendChild(dismissBtn);
    document.body.appendChild(floatingBar);
  }

  // --- Compare Overlay ---

  function _openCompareView() {
    if (compareSlots.length !== 2) return;
    removeFloatingBar();

    var r0 = compareSlots[0];
    var r1 = compareSlots[1];

    compareOverlay = document.createElement('div');
    compareOverlay.className = 'compare-overlay';
    compareOverlay.setAttribute('role', 'dialog');
    compareOverlay.setAttribute('aria-label', 'Compare regions');

    // Header
    var header = document.createElement('div');
    header.className = 'compare-overlay__header';
    header.innerHTML =
      '<h2 class="compare-overlay__title">Compare</h2>' +
      '<div class="compare-overlay__header-actions">' +
        '<button class="icon-btn compare-overlay__close" title="Exit compare">&times;</button>' +
      '</div>';

    // Column builder
    function buildColumn(region) {
      var col = document.createElement('div');
      col.className = 'compare-col';

      var name = document.createElement('h3');
      name.className = 'compare-col__name';
      name.textContent = displayName(region.name);
      col.appendChild(name);

      // Street View carousel (supports multi-streetview)
      var svWrap = document.createElement('div');
      svWrap.className = 'compare-col__streetview';
      var GOOGLE_API_KEY = window.__GEOCONFIG__ && window.__GEOCONFIG__.GOOGLE_MAPS_API_KEY;

      var streetviews = Array.isArray(region.streetview) ? region.streetview.slice(0, 5)
        : (region.streetview && typeof region.streetview.lat === 'number' ? [region.streetview] : []);
      var links = Array.isArray(region.link) ? region.link.slice(0, 5)
        : (typeof region.link === 'string' ? [region.link] : []);

      if (streetviews.length === 0 || !GOOGLE_API_KEY) {
        var msg = !GOOGLE_API_KEY && streetviews.length > 0
          ? 'Google Maps API Key not configured'
          : 'No Street View available';
        svWrap.innerHTML = '<div class="compare-col__no-sv">' + msg + '</div>';
      } else {
        // Build carousel
        var carousel = document.createElement('div');
        carousel.className = 'comp-carousel';

        // Left arrow
        var arrowLeft = document.createElement('button');
        arrowLeft.className = 'comp-carousel__arrow comp-carousel__arrow--left';
        arrowLeft.setAttribute('aria-label', 'Previous street view');
        arrowLeft.setAttribute('type', 'button');
        arrowLeft.innerHTML = '&lsaquo;';

        // Viewport
        var viewport = document.createElement('div');
        viewport.className = 'comp-carousel__viewport';
        var iframe = document.createElement('iframe');
        iframe.className = 'compare-col__iframe';
        iframe.allowFullscreen = true;
        iframe.referrerPolicy = 'no-referrer-when-downgrade';
        viewport.appendChild(iframe);

        // Placeholder for failed loads
        var placeholder = document.createElement('div');
        placeholder.className = 'comp-carousel__placeholder';
        placeholder.hidden = true;
        placeholder.innerHTML =
          '<div class="comp-carousel__placeholder-icon" aria-hidden="true">&#9888;</div>' +
          '<p class="comp-carousel__placeholder-text">Unable to load this Street View</p>';
        viewport.appendChild(placeholder);

        // Right arrow
        var arrowRight = document.createElement('button');
        arrowRight.className = 'comp-carousel__arrow comp-carousel__arrow--right';
        arrowRight.setAttribute('aria-label', 'Next street view');
        arrowRight.setAttribute('type', 'button');
        arrowRight.innerHTML = '&rsaquo;';

        carousel.appendChild(arrowLeft);
        carousel.appendChild(viewport);
        carousel.appendChild(arrowRight);
        svWrap.appendChild(carousel);

        // Counter
        var counter = document.createElement('div');
        counter.className = 'comp-carousel__counter';
        svWrap.appendChild(counter);

        // Dots
        var dots = document.createElement('div');
        dots.className = 'comp-carousel__dots';
        svWrap.appendChild(dots);

        var multi = streetviews.length > 1;
        arrowLeft.hidden = !multi;
        arrowRight.hidden = !multi;
        counter.hidden = !multi;
        dots.hidden = !multi;

        // Build dot buttons
        for (var i = 0; i < streetviews.length; i++) {
          var dot = document.createElement('button');
          dot.className = 'comp-carousel__dot' + (i === 0 ? ' is-active' : '');
          dot.setAttribute('aria-label', 'Street View ' + (i + 1));
          dot.setAttribute('type', 'button');
          (function(idx) { dot.addEventListener('click', function() { showStreetview(idx); }); })(i);
          dots.appendChild(dot);
        }

        var currentIndex = 0;

        function showStreetview(index) {
          currentIndex = index;
          var sv = streetviews[index];
          var link = links[index] || '';

          // Update dots
          var allDots = dots.querySelectorAll('.comp-carousel__dot');
          allDots.forEach(function(d, i) { d.classList.toggle('is-active', i === index); });

          // Update counter
          if (multi) {
            counter.textContent = (index + 1) + ' / ' + streetviews.length;
          }

          // Update arrow disabled state
          arrowLeft.classList.toggle('comp-carousel__arrow--disabled', index === 0);
          arrowRight.classList.toggle('comp-carousel__arrow--disabled', index >= streetviews.length - 1);

          if (sv && typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0)) {
            var url = buildStreetViewUrl(sv, GOOGLE_API_KEY);
            placeholder.hidden = true;
            iframe.hidden = false;
            iframe.src = url;
          } else {
            iframe.hidden = true;
            placeholder.hidden = false;
          }
        }

        // Arrow click handlers
        arrowLeft.addEventListener('click', function(e) {
          e.stopPropagation();
          if (currentIndex > 0) showStreetview(currentIndex - 1);
        });
        arrowRight.addEventListener('click', function(e) {
          e.stopPropagation();
          if (currentIndex < streetviews.length - 1) showStreetview(currentIndex + 1);
        });

        // Show first
        showStreetview(0);
      }
      col.appendChild(svWrap);

      // Description
      var desc = document.createElement('div');
      desc.className = 'compare-col__desc';
      if (region.description) {
        desc.innerHTML = DOMPurify.sanitize(marked.parse(region.description));
      }
      col.appendChild(desc);

      // Tags
      if (region.tags && region.tags.length) {
        var tagsDiv = document.createElement('div');
        tagsDiv.className = 'compare-col__tags';
        region.tags.forEach(function(t) {
          var span = document.createElement('span');
          span.className = 'compare-col__tag';
          span.textContent = typeof formatTagName === 'function' ? formatTagName(t) : t;
          if (typeof formatTagFull === 'function') span.title = formatTagFull(t);
          tagsDiv.appendChild(span);
        });
        col.appendChild(tagsDiv);
      }

      // Reactions
      var reactionsDiv = document.createElement('div');
      reactionsDiv.className = 'compare-col__reactions';
      reactionsDiv.innerHTML = '<span style="font-size:12px;color:var(--ink-subtle);">Loading...</span>';
      col.appendChild(reactionsDiv);
      fetch('/api/reactions?region_id=' + encodeURIComponent(region.id))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (window._renderReactionRow) {
            window._renderReactionRow(reactionsDiv, region.id, data);
          }
        })
        .catch(function() { reactionsDiv.innerHTML = ''; });

      return col;
    }

    var body = document.createElement('div');
    body.className = 'compare-overlay__body';
    body.appendChild(buildColumn(r0));
    body.appendChild(buildColumn(r1));

    compareOverlay.appendChild(header);
    compareOverlay.appendChild(body);

    // Close handler
    header.querySelector('.compare-overlay__close').addEventListener('click', function() {
      _closeCompareView();
    });

    document.body.appendChild(compareOverlay);
    document.body.style.overflow = 'hidden';
    header.querySelector('.compare-overlay__close').focus();
  }

  function _closeCompareView() {
    if (compareOverlay) {
      compareOverlay.remove();
      compareOverlay = null;
    }
    compareSlots = [];
    document.body.style.overflow = '';
  }

  // Escape key to close compare overlay
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && compareOverlay) {
      _closeCompareView();
    }
  });
})();

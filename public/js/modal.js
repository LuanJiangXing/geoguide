// Track current user for reactions permission check
if (window._authReady) {
  window._authReady.then(function(u) { window.__currentUser = u; });
}

// Prefetch cache — reactions data loaded on hover, consumed instantly on click
var _reactionsCache = {};
var _reactionsPending = {};

// --- Translation cache ---
var _translateCache = {}; // key: "regionId:field:target" → translated string

/**
 * Detect whether text is already predominantly in the target language.
 * Conservative: high bar to avoid false positives on mixed text.
 * Chinese: >60% CJK AND ≥3 CJK characters.
 * English: >70% Latin AND zero CJK characters.
 */
function _isAlreadyTargetLang(text, target) {
  if (!text) return false;
  var cjk = 0;
  var latin = 0;
  for (var i = 0; i < text.length; i++) {
    var code = text.charCodeAt(i);
    if (code < 128 && ((code >= 65 && code <= 90) || (code >= 97 && code <= 122))) {
      latin++;
    } else if (code >= 0x4E00 && code <= 0x9FFF) {
      cjk++;
    }
  }
  var meaningful = cjk + latin;
  if (meaningful === 0) return false;
  if (target === 'zh') return cjk >= 3 && (cjk / meaningful) > 0.6;
  if (target === 'en') return cjk === 0 && (latin / meaningful) > 0.7;
  return false;
}

/** Simple toast — appends a temporary message bar at page top */
function _showTranslateToast(msg, clickable) {
  var existing = document.querySelector('.translate-toast');
  if (existing) existing.remove();
  var toast = document.createElement('div');
  toast.className = 'translate-toast';
  toast.textContent = msg;
  toast.setAttribute('role', 'alert');
  if (clickable) {
    toast.style.pointerEvents = 'auto';
    toast.style.cursor = 'pointer';
    toast.style.textDecoration = 'underline';
    toast.addEventListener('click', function() { window.location.href = '/api/auth?action=login'; });
  }
  document.body.appendChild(toast);
  // Fade in
  requestAnimationFrame(function() { toast.classList.add('is-visible'); });
  // Auto-dismiss
  setTimeout(function() {
    toast.classList.remove('is-visible');
    setTimeout(function() { if (toast.parentNode) toast.remove(); }, 300);
  }, 4000);
}

/**
 * Build a three-position translation toggle slider and insert it into containerEl.
 * @param {string} regionId
 * @param {string} field - 'name' or 'description'
 * @param {HTMLElement} containerEl
 * @param {function(string): void} onReplace - called with translated text to update DOM
 * @param {HTMLElement} [beforeEl] - if given, insert before this node instead of appending
 */
function _buildTranslateToggle(regionId, field, originalText, onReplace, containerEl, beforeEl) {
  if (!originalText || originalText.trim().length === 0) return;

  var wrapper = document.createElement('span');
  wrapper.className = 'lang-toggle lang-toggle--' + field;

  var labelL = document.createElement('span');
  labelL.className = 'lang-toggle__label lang-toggle__label--l';
  labelL.textContent = '中';

  var track = document.createElement('span');
  track.className = 'lang-toggle__track';
  track.setAttribute('role', 'slider');
  track.setAttribute('aria-label', field === 'name' ? 'Translate title' : (field === 'note' ? 'Translate note' : (field === 'detail' ? 'Translate detailed description' : 'Translate description')));
  track.setAttribute('aria-valuenow', '0'); // -1=zh, 0=orig, 1=en
  track.tabIndex = 0;

  var thumb = document.createElement('span');
  thumb.className = 'lang-toggle__thumb';
  track.appendChild(thumb);

  var labelR = document.createElement('span');
  labelR.className = 'lang-toggle__label lang-toggle__label--r';
  labelR.textContent = 'EN';

  wrapper.appendChild(labelL);
  wrapper.appendChild(track);
  wrapper.appendChild(labelR);
  containerEl.insertBefore(wrapper, beforeEl || null);

  // 点击标签（中/EN）或空隙时也阻止 summary 折叠（toggle 可能嵌套在 <summary> 内）
  wrapper.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
  });

  // Track state on the DOM element
  track._state = 0;          // -1=zh, 0=orig, 1=en
  track._loading = false;    // true during API call
  track._originalText = originalText;
  track._regionId = regionId;
  track._field = field;
  track._onReplace = onReplace;

  // Click-to-position: click track to move thumb to nearest endpoint
  track.addEventListener('click', function(e) {
    e.preventDefault();   // 阻止嵌套在 <summary> 内的 toggle 触发展开/折叠
    e.stopPropagation();
    if (track._loading) return;
    var rect = track.getBoundingClientRect();
    var x = e.clientX - rect.left;
    var third = rect.width / 3;
    var newState;
    if (x < third) {
      newState = -1; // zh
    } else if (x > 2 * third) {
      newState = 1;  // en
    } else {
      newState = 0;  // original
    }
    _setToggleState(track, newState);
  });

  // Keyboard: left/right arrow keys (stopPropagation so they don't also
  // switch street views via the document-level handler)
  track.addEventListener('keydown', function(e) {
    if (track._loading) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      var next = track._state + (e.key === 'ArrowLeft' ? -1 : 1);
      if (next < -1) next = -1;
      if (next > 1) next = 1;
      _setToggleState(track, next);
    }
  });
}

/**
 * Move toggle to a new state (-1 zh, 0 original, 1 en). Triggers translation if needed.
 */
function _setToggleState(track, newState) {
  if (track._loading) return;

  // Back to original: restore immediately
  if (newState === 0) {
    track._state = 0;
    track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
    track.setAttribute('aria-valuenow', '0');
    track._onReplace(track._originalText);
    return;
  }

  // Already at this state — no-op
  if (track._state === newState) return;

  var targetLang = newState === -1 ? 'zh' : 'en';
  var cacheKey = track._regionId + ':' + track._field + ':' + targetLang;

  // Check cache
  if (_translateCache[cacheKey]) {
    track._state = newState;
    track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
    track.classList.add(newState === -1 ? 'lang-toggle__track--zh' : 'lang-toggle__track--en');
    track.setAttribute('aria-valuenow', String(newState));
    track._onReplace(_translateCache[cacheKey]);
    return;
  }

  // Already in target language — use original, skip API
  if (_isAlreadyTargetLang(track._originalText, targetLang)) {
    _translateCache[cacheKey] = track._originalText;
    track._state = newState;
    track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
    track.classList.add(newState === -1 ? 'lang-toggle__track--zh' : 'lang-toggle__track--en');
    track.setAttribute('aria-valuenow', String(newState));
    track._onReplace(track._originalText);
    return;
  }

  // Start loading + call API
  track._loading = true;
  track.classList.add('lang-toggle__track--loading');

  fetch('/api/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': window._csrfToken || '' },
    body: JSON.stringify({ text: track._originalText, target: targetLang })
  })
    .then(function(r) { return r.json().then(function(d) { return { status: r.status, data: d }; }); })
    .then(function(res) {
      track._loading = false;
      track.classList.remove('lang-toggle__track--loading');

      var data = res.data;
      if (data && data.translated) {
        _translateCache[cacheKey] = data.translated;
        track._state = newState;
        track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
        track.classList.add(newState === -1 ? 'lang-toggle__track--zh' : 'lang-toggle__track--en');
        track.setAttribute('aria-valuenow', String(newState));
        track._onReplace(data.translated);
      } else {
        // API error — snap back to original
        track._state = 0;
        track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
        track.setAttribute('aria-valuenow', '0');
        track._onReplace(track._originalText);
        if (res.status === 401) {
          _showTranslateToast('请登录后使用翻译功能 · Please log in to use translation', true);
        } else {
          _showTranslateToast('翻译失败，请稍后再试 · Translation failed, please try again later');
        }
      }
    })
    .catch(function() {
      track._loading = false;
      track.classList.remove('lang-toggle__track--loading');
      // Snap back
      track._state = 0;
      track.classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en');
      track.setAttribute('aria-valuenow', '0');
      track._onReplace(track._originalText);
      _showTranslateToast('翻译失败，请稍后再试 · Translation failed, please try again later');
    });
}

// --- Favorites (bookmark star) in modal header ---
// Star state rides the per-region /api/reactions response (favorited), which is
// single-use cached and re-fetched on each modal open, so no session store needed.
var _favBtn = null;         // built-once star element in .modal__header
var _favBusy = false;       // debounce — prevent double-click toggle

function setFavButton(on) {
  if (!_favBtn) return;
  _favBtn.textContent = on ? '★' : '☆';
  _favBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
}

function showLoginToast(text) {
  var t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2d5a3d;color:#fff;padding:10px 20px;border-radius:8px;font-size:14px;z-index:10001;cursor:pointer;text-decoration:underline;white-space:nowrap;';
  t.textContent = text;
  t.addEventListener('click', function() { window.location.href = '/api/auth?action=login'; });
  document.body.appendChild(t);
  setTimeout(function() {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
  }, 4000);
}

function handleFavoriteClick(e) {
  if (e) e.stopPropagation();
  if (!_favBtn || _favBusy) return;
  // Guest (no reaction data yet → client auth cache): prompt login, never flip the star
  var authed = (_favBtn._authed != null) ? _favBtn._authed : !!window.__currentUser;
  if (!authed) {
    showLoginToast('Login with Discord to save regions →');
    return;
  }
  var regionId = _favBtn._regionId;
  if (!regionId) return;
  var wasOn = _favBtn.getAttribute('aria-pressed') === 'true';
  var target = !wasOn;
  _favBtn._authed = true;
  setFavButton(target);   // optimistic: flip the star first, backend reconciles in the background
  _favBusy = true;
  fetch('/api/reactions', {
    method: wasOn ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': window._csrfToken || '' },
    body: JSON.stringify({ action: 'favorite', region_id: regionId })
  })
    .then(function(r) {
      if (r.status === 401) { var err = new Error('unauthorized'); err.code = 401; throw err; }
      return r.json();
    })
    .then(function(data) {
      // If the modal already switched to another region, don't flip that star
      if (_favBtn && _favBtn._regionId !== regionId) return;
      if (!data || data.favorited == null) { setFavButton(wasOn); return; }
      setFavButton(!!data.favorited);  // reconcile with server truth
    })
    .catch(function(err) {
      if (_favBtn && _favBtn._regionId !== regionId) return;
      setFavButton(wasOn);  // rollback on network error / expired session
      if (err && err.code === 401) showLoginToast('Login with Discord to save regions →');
    })
    .then(function() { _favBusy = false; });
}

window._prefetchReactions = function(regionId) {
  if (_reactionsCache[regionId] || _reactionsPending[regionId]) return;
  _reactionsPending[regionId] = true;
  fetch('/api/reactions?region_id=' + encodeURIComponent(regionId))
    .then(function(r) { return r.json(); })
    .then(function(data) {
      _reactionsCache[regionId] = data;
      delete _reactionsPending[regionId];
    })
    .catch(function() { delete _reactionsPending[regionId]; });
};

var _reactionDebounce = {};
var _streetviewDebounce = null;

// --- Street View (Maps Embed iframe) ---
var _svShowToken = 0;        // 递增的展示令牌，用于丢弃过期的 iframe 加载

// --- Reaction row ---
//
// 六项 reaction 的元数据**只有一份**：utils.js 的 GEOGUIDE_REACTIONS
// （key / file / label / tooltip）。**不要在本文件再抄一份** —— 抄了就是第二个同步点。
// 图标路径的唯一出口是 utils.js 的 reactionIconSrc(key)。
//
// 按钮只显示「图标 + 计数」，不显示文字 label —— label 只进 title / aria-label（D2，
// 对齐 davidtao）。激活态的类名 is-active--<key> 由 key 派生；色值规则在 css/style.css。
//
// 后端契约：GET/POST/DELETE /api/reactions 扁平返回六个计数键 + `user_reactions`
//（标量已删：旧版单值状态无法表达「六项独立」，两侧同次部署切换，见 design §4.2/§4.3）。
// 服务端白名单在 api/reactions.js，加类型必须两边同时改（utils.js 的表里也这么写着）。

function reactionActiveClass(key) {
  return 'is-active--' + key;
}

// 图标 = 自托管 Twemoji SVG。取不到 src（未知 key）时退回 label 文字，绝不留下空 img。
function buildReactionIcon(rt) {
  var src = typeof reactionIconSrc === 'function' ? reactionIconSrc(rt.key) : '';
  var el = document.createElement(src ? 'img' : 'span');
  el.className = 'modal__reaction-icon';
  if (src) {
    el.src = src;
    el.alt = '';
    el.setAttribute('aria-hidden', 'true');
  } else {
    el.className += ' modal__reaction-icon--fallback';
    el.textContent = rt.label;
  }
  return el;
}

// 重绘按钮内容 = 图标 + 计数（动画中显示 ✓）。计数同时写进 data-count —— 乐观更新
// 从它读，不再从 textContent 正则解析（内容换成 <img> 后那条正则不再可靠）。
function paintReactionBtn(btn, rt, count, check) {
  btn.innerHTML = '';
  btn.appendChild(buildReactionIcon(rt));
  var num = document.createElement('span');
  num.className = 'modal__reaction-count';
  num.textContent = check ? '✓' : String(count);
  btn.appendChild(num);
  btn.dataset.count = String(count);
}

// Exported for compare.js — renders reaction buttons into any container
window._renderReactionRow = function(container, regionId, data) {
  container.innerHTML = '';
  container.dataset.regionId = regionId;
  container.className = 'compare-col__reactions';
  // 六项独立：user_reactions 是数组。未登录为 []（直接遍历，少一个判空）。
  var mine = data.user_reactions || [];
  var mineSet = {};
  for (var m = 0; m < mine.length; m++) mineSet[mine[m]] = true;

  // Prompt label — encourages users to give feedback
  var prompt = document.createElement('div');
  prompt.className = 'modal__reactions-prompt';
  prompt.textContent = 'Is this meta helpful?';
  container.appendChild(prompt);

  GEOGUIDE_REACTIONS.forEach(function(rt) {
    var count = data[rt.key] || 0;
    var isActive = !!mineSet[rt.key];

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'modal__reaction-btn modal__reaction-btn--' + rt.key
      + (isActive ? ' ' + reactionActiveClass(rt.key) : '');
    paintReactionBtn(btn, rt, count, false);
    btn.setAttribute('aria-label', 'Mark as ' + rt.label);
    btn.title = rt.tooltip;
    btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    btn.addEventListener('click', function() {
      if (!data.authenticated) {
        // Animate button then prompt login — no backend request
        btn.classList.add('is-animating');
        paintReactionBtn(btn, rt, count, true);
        setTimeout(function() {
          btn.classList.remove('is-animating');
          paintReactionBtn(btn, rt, count, false);
        }, 600);
        showLoginToast('Login with Discord to rate regions →');
        return;
      }
      var active = btn.classList.contains(reactionActiveClass(rt.key));
      submitReaction(regionId, rt.key, container, active);
    });

    container.appendChild(btn);
  });

};

function submitReaction(regionId, type, rowEl, isCancel) {
  // Debounce per region — prevent double-clicks
  if (_reactionDebounce[regionId]) return;
  _reactionDebounce[regionId] = true;
  setTimeout(function() { delete _reactionDebounce[regionId]; }, 300);

  var clickedBtn = rowEl.querySelector('.modal__reaction-btn--' + type);
  var clickedType = null;
  for (var i = 0; i < GEOGUIDE_REACTIONS.length; i++) {
    if (GEOGUIDE_REACTIONS[i].key === type) { clickedType = GEOGUIDE_REACTIONS[i]; break; }
  }

  // Read current state for all types. 计数从 data-count 读 —— 不能从 textContent 正则解析，
  // 内容换成「图标 <img> + 数字」之后那条正则不再可靠。
  var prev = {};
  GEOGUIDE_REACTIONS.forEach(function(rt) {
    var btn = rowEl.querySelector('.modal__reaction-btn--' + rt.key);
    if (btn) {
      prev[rt.key] = {
        btn: btn,
        active: btn.classList.contains(reactionActiveClass(rt.key)),
        count: parseInt(btn.dataset.count, 10) || 0
      };
    }
  });

  // Optimistic: toggle ONLY this type; the other five stay exactly as they are (D1 ——
  // 六项独立，没有任何互斥分支). 点未激活→激活并 +1；点已激活→取消并 -1。
  var newState = {};
  GEOGUIDE_REACTIONS.forEach(function(rt) {
    var p = prev[rt.key];
    newState[rt.key] = { active: p ? p.active : false, count: p ? p.count : 0 };
    if (rt.key === type) {
      newState[rt.key].active = !isCancel;
      newState[rt.key].count = Math.max(0, newState[rt.key].count + (isCancel ? -1 : 1));
    }
  });

  // Track latest state so the animation timeout can use the server-reconciled counts
  var _latestState = newState;

  // Animation feedback — show ✓ and lock the clicked button for 0.6s
  if (clickedBtn && clickedType) {
    clickedBtn.classList.add('is-animating');
    paintReactionBtn(clickedBtn, clickedType, newState[type].count, true);
    setTimeout(function() {
      clickedBtn.classList.remove('is-animating');
      // Apply final state to this button (use latest state in case server already responded)
      var s = _latestState[type] || { active: false, count: 0 };
      paintReactionBtn(clickedBtn, clickedType, s.count, false);
      clickedBtn.className = 'modal__reaction-btn modal__reaction-btn--' + type
        + (s.active ? ' ' + reactionActiveClass(type) : '');
      clickedBtn.setAttribute('aria-pressed', s.active ? 'true' : 'false');
    }, 600);
  }

  // Apply optimistic update immediately (skip animating button — it shows ✓)
  function applyState(state) {
    _latestState = state;
    GEOGUIDE_REACTIONS.forEach(function(rt) {
      var btn = rowEl.querySelector('.modal__reaction-btn--' + rt.key);
      if (!btn) return;
      if (btn.classList.contains('is-animating')) return; // skip during animation
      var s = state[rt.key];
      paintReactionBtn(btn, rt, s.count, false);
      btn.className = 'modal__reaction-btn modal__reaction-btn--' + rt.key
        + (s.active ? ' ' + reactionActiveClass(rt.key) : '');
      btn.setAttribute('aria-pressed', s.active ? 'true' : 'false');
    });
  }

  applyState(newState);

  // Save previous for rollback
  var prevState = {};
  GEOGUIDE_REACTIONS.forEach(function(rt) {
    if (prev[rt.key]) {
      prevState[rt.key] = { active: prev[rt.key].active, count: prev[rt.key].count };
    }
  });

  // Fire API request in background — reconcile with server truth on response
  fetch('/api/reactions', {
    method: isCancel ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json', 'x-csrf-token': window._csrfToken || '' },
    body: JSON.stringify({ region_id: regionId, type: type })
  })
    .then(function(r) {
      if (r.status === 401) {
        window.location.href = '/api/auth?action=login';
        return;
      }
      return r.json();
    })
    .then(function(data) {
      if (!data) return;
      if (rowEl.dataset.regionId !== regionId) return;
      // Reconcile with server truth. user_reactions 是数组，六项一视同仁 —— 没有 error 特判。
      var mine = data.user_reactions || [];
      var serverState = {};
      GEOGUIDE_REACTIONS.forEach(function(rt) {
        serverState[rt.key] = {
          active: mine.indexOf(rt.key) > -1,
          count: data[rt.key] || 0
        };
      });
      applyState(serverState);
    })
    .catch(function() {
      // Rollback on network error
      if (rowEl.dataset.regionId !== regionId) return;
      applyState(prevState);
    });
}

/**
 * Render the Street View carousel for a multi-streetview submission.
 * Stores carousel state on the modal DOM element.
 */
function renderCarousel(region) {
  var pano = document.getElementById('streetview-pano');
  var placeholder = document.getElementById('sv-placeholder');
  var placeholderLink = document.getElementById('sv-placeholder-link');
  var arrowLeft = document.getElementById('sv-arrow-left');
  var arrowRight = document.getElementById('sv-arrow-right');
  var counter = document.getElementById('sv-counter');
  var dots = document.getElementById('sv-dots');
  var hint = document.querySelector('#modal-streetview .modal__streetview-hint');

  var streetviews = Array.isArray(region.streetview) ? region.streetview.slice(0, 5)
    : (region.streetview && typeof region.streetview.lat === 'number' ? [region.streetview] : []);
  var links = Array.isArray(region.link) ? region.link.slice(0, 5)
    : (typeof region.link === 'string' ? [region.link] : []);

  var modal = document.getElementById('modal');
  var renderGen = (modal._renderGen || 0) + 1;
  modal._renderGen = renderGen;
  modal._svIndex = 0;
  modal._svList = streetviews;
  modal._svLinks = links;

  // No streetviews at all
  if (streetviews.length === 0) {
    pano.innerHTML = '';
    pano.hidden = true;
    placeholder.hidden = true;
    if (hint) { hint.hidden = false; hint.textContent = 'Click a region to view Street View'; }
    arrowLeft.hidden = true;
    arrowRight.hidden = true;
    counter.hidden = true;
    dots.hidden = true;
    modal._showStreetviewFn = null;
    return;
  }

  // Single streetview — hide carousel controls
  var multi = streetviews.length > 1;
  arrowLeft.hidden = !multi;
  arrowRight.hidden = !multi;
  counter.hidden = !multi;
  dots.hidden = !multi;

  // Render dots
  dots.innerHTML = '';
  for (var i = 0; i < streetviews.length; i++) {
    var dot = document.createElement('button');
    dot.className = 'sv-dots__dot' + (i === 0 ? ' is-active' : '');
    dot.setAttribute('aria-label', 'Street View ' + (i + 1));
    dot.setAttribute('type', 'button');
    (function(idx) { dot.addEventListener('click', function() { showStreetview(idx); }); })(i);
    dots.appendChild(dot);
  }

  function showStreetview(index) {
    modal._svIndex = index;
    var sv = streetviews[index];
    var link = links[index] || '';

    // Update dots
    var allDots = dots.querySelectorAll('.sv-dots__dot');
    allDots.forEach(function(d, i) { d.classList.toggle('is-active', i === index); });

    // Update counter
    counter.textContent = (index + 1) + ' / ' + streetviews.length;

    // Update arrow disabled state
    arrowLeft.classList.toggle('sv-carousel__arrow--disabled', index === 0);
    arrowRight.classList.toggle('sv-carousel__arrow--disabled', index >= streetviews.length - 1);

    var valid = sv && (sv.pano || (typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0)));
    if (valid) {
      // 有效条目（pano=历史捕获，或坐标）统一走 Embed iframe：
      // buildStreetViewUrl（utils.js）生成 pano 优先 / location 回退的 URL，
      // heading/pitch/fov 内联进 URL，无需 JS API。
      placeholder.hidden = true;

      if (_streetviewDebounce) clearTimeout(_streetviewDebounce);
      if (hint) { hint.textContent = 'Loading Street View...'; hint.hidden = false; }

      // 立即清空旧 iframe，避免切换时闪现上一个街景
      pano.innerHTML = '';
      pano.hidden = true;
      var showToken = ++_svShowToken;

      _streetviewDebounce = setTimeout(function() {
        _streetviewDebounce = null;
        if (modal._renderGen !== renderGen) return;

        var apiKey = window.__GEOCONFIG__ && window.__GEOCONFIG__.GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
          if (hint) {
            hint.textContent = 'Google Maps API Key not configured (Street View disabled)';
            hint.hidden = false;
          }
          return;
        }
        var url = buildStreetViewUrl(sv, apiKey);
        if (!url) return;

        var frame = document.createElement('iframe');
        frame.className = 'modal__sv-iframe';
        frame.setAttribute('allowfullscreen', '');
        frame.setAttribute('loading', 'eager');
        frame.referrerPolicy = 'no-referrer-when-downgrade';  // Embed referrer 白名单需要完整 referrer
        frame.style.border = '0';
        frame.style.width = '100%';
        frame.style.height = '100%';
        frame.src = url;
        frame.addEventListener('load', function() {
          // 丢弃过期加载：同一 modal 重开 / 快速切换时 renderGen 或 showToken 已变
          if (showToken !== _svShowToken || modal._renderGen !== renderGen) return;
          pano.hidden = false;
          if (hint) hint.hidden = true;
        });
        pano.appendChild(frame);

        // 兜底：iframe 被拦截等情况下可能不触发 load，别让「Loading」卡住
        setTimeout(function() {
          if (showToken !== _svShowToken || modal._renderGen !== renderGen) return;
          if (hint) hint.hidden = true;
        }, 6000);
      }, 500);
    } else {
      // 无坐标无 pano — 显示占位符
      if (_streetviewDebounce) { clearTimeout(_streetviewDebounce); _streetviewDebounce = null; }
      pano.innerHTML = '';
      pano.hidden = true;
      placeholder.hidden = false;
      if (hint) hint.hidden = true;
      placeholderLink.href = link || '#';
      placeholderLink.hidden = !link;
    }
  }

  // Store showStreetview so arrow/key handlers can call it
  modal._showStreetviewFn = showStreetview;

  // Determine which streetviews have no usable coordinates (lat:0/lng:0) and
  // therefore must be resolved from their link before they can be shown.
  // Streetviews that already have coordinates render immediately — old
  // submissions that store `zoom` instead of `fov` simply fall back to the
  // default fov=90. Not re-resolving those for exact fov avoids the ~1-3s
  // server round-trip on short-link entries (the source of the "3s before the
  // street view appears" regression) while the resolve-first approach still
  // guarantees the panorama loads exactly once.
  var needsResolve = streetviews.map(function(sv) {
    // 有 pano 的条目（历史捕获）无需坐标即可直接渲染 iframe
    return !(sv && (sv.pano || (typeof sv.lat === 'number' && (sv.lat !== 0 || sv.lng !== 0))));
  });
  var anyNeedResolve = needsResolve.some(function(x) { return x; });

  // Show the first streetview right away when it already has coordinates. If
  // the first entry has no coordinates, hold it behind a loading state until
  // the link resolution below completes.
  if (!needsResolve[0]) {
    showStreetview(0);
  } else {
    pano.hidden = true;
    placeholder.hidden = true;
    if (hint) { hint.textContent = 'Loading Street View...'; hint.hidden = false; }
  }

  if (!anyNeedResolve) return;

  // Resolve only the coordinate-less entries in the background, filling them
  // into the shared streetviews array as they complete so the arrows/dots can
  // reach them once resolved.
  var wasWaitingOnFirst = needsResolve[0];
  Promise.all(links.map(function(link, i) {
    if (!needsResolve[i] || !link) return Promise.resolve(null);
    return resolveLinkUrl(link).catch(function() { return null; });
  })).then(function(resolved) {
    // A newer renderCarousel (or modal close→reopen) superseded this one.
    if (modal._renderGen !== renderGen) return;

    for (var i = 0; i < resolved.length; i++) {
      var fresh = resolved[i];
      if (!fresh || (fresh.lat === 0 && fresh.lng === 0)) continue;
      streetviews[i] = fresh;
    }
    modal._svList = streetviews;

    // If the first entry was the one we held back for resolution, show it now
    // (or its placeholder if resolution failed).
    if (wasWaitingOnFirst && (modal._svIndex || 0) === 0) {
      showStreetview(0);
    }
  });
}

// Carousel arrow button handlers (bind once)
(function bindCarouselControls() {
  var arrowLeft = document.getElementById('sv-arrow-left');
  var arrowRight = document.getElementById('sv-arrow-right');
  if (arrowLeft) {
    arrowLeft.addEventListener('click', function() {
      var m = document.getElementById('modal');
      if (m._showStreetviewFn && (m._svIndex || 0) > 0) {
        m._showStreetviewFn(m._svIndex - 1);
      }
    });
  }
  if (arrowRight) {
    arrowRight.addEventListener('click', function() {
      var m = document.getElementById('modal');
      var list = m._svList || [];
      if (m._showStreetviewFn && (m._svIndex || 0) < list.length - 1) {
        m._showStreetviewFn(m._svIndex + 1);
      }
    });
  }
})();

/**
 * 打开详情弹窗
 * @param {Object} region
 */
function openModal(region) {
  // 任何弹窗打开都先隐藏重叠标签栏；仅重叠点击路径会随后重新 showOverlapTabs
  if (window.hideOverlapTabs) window.hideOverlapTabs();

  const modal = document.getElementById('modal');
  const backdrop = document.getElementById('backdrop');
  const title = document.getElementById('modal-title');
  const tags = document.getElementById('modal-tags');
  const desc = document.getElementById('modal-desc');
  const gallery = document.getElementById('modal-gallery');
  const source = document.getElementById('modal-source');
  const streetviewWrap = document.getElementById('modal-streetview');
  const hint = streetviewWrap.querySelector('.modal__streetview-hint');

  // 标题
  title.textContent = displayName(region.name);

  // Translation toggle — name (inline with the submitter, inside .modal__meta)
  var titleContainer = document.getElementById('modal-title');
  var metaRow = document.querySelector('.modal__meta');
  // Remove any previous toggle (modal re-used)
  var oldNameToggle = metaRow.querySelector('.lang-toggle--name');
  if (oldNameToggle) oldNameToggle.remove();
  _buildTranslateToggle(region.id, 'name', region.name, function(translated) {
    titleContainer.textContent = displayName(translated);
  }, metaRow);

  // Compare + Edit buttons: hide initially, show together after lazy ownership check
  // so neither button jumps when the other appears
  var headerDiv = document.querySelector('.modal__header');
  if (headerDiv) {
    var closeBtn = document.getElementById('modal-close');

    // Compare button (build once, reuse)
    var compareBtn = headerDiv.querySelector('.modal__compare-btn');
    if (!compareBtn) {
      compareBtn = document.createElement('button');
      compareBtn.className = 'icon-btn modal__compare-btn';
      compareBtn.title = 'Compare this region with another region';
      compareBtn.setAttribute('aria-label', 'Compare this region with another region');
      compareBtn.textContent = '⇄ Compare';
      if (closeBtn) {
        closeBtn.parentNode.insertBefore(compareBtn, closeBtn);
      }
      compareBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (compareBtn._region) {
          window._compareBasket.add(compareBtn._region);
          closeModal();
        }
      });
    }
    compareBtn._region = region;

    // Edit button (build once, reuse)
    var editBtn = headerDiv.querySelector('.modal__edit-btn');
    if (!editBtn) {
      editBtn = document.createElement('a');
      editBtn.className = 'icon-btn modal__edit-btn';
      editBtn.title = 'Edit this submission';
      editBtn.setAttribute('aria-label', 'Edit this submission');
      // 与 /my-submissions 卡片动作行**同一支笔**，path 在 js/utils.js 的
      // GEOGUIDE_ICONS（唯一来源）。用户 2026-10-02 要求两处图案一致。
      // 名字由按钮自己的 aria-label 承担，所以 svg 是 aria-hidden。
      editBtn.innerHTML = geoguideIconSvg('edit');
      if (closeBtn) {
        closeBtn.parentNode.insertBefore(editBtn, closeBtn);
      }
    }

    // Favorite star (build once, reuse) — always visible, not gated on ownership
    var favBtn = headerDiv.querySelector('.modal__fav-btn');
    if (!favBtn) {
      favBtn = document.createElement('button');
      favBtn.type = 'button';
      favBtn.className = 'icon-btn modal__fav-btn';
      favBtn.textContent = '☆';
      favBtn.title = 'Save this region to your favorites';
      favBtn.setAttribute('aria-label', 'Save this region to your favorites');
      favBtn.setAttribute('aria-pressed', 'false');
      if (closeBtn) {
        closeBtn.parentNode.insertBefore(favBtn, closeBtn);
      }
      favBtn.addEventListener('click', handleFavoriteClick);
    }
    _favBtn = favBtn;
    favBtn._regionId = region.id;
    favBtn._authed = null;   // filled when the per-region reaction data arrives
    setFavButton(false);     // start unfilled; renderReactionButtons flips it from data.favorited

    // Share button (build once, reuse) — always visible
    var shareBtn = headerDiv.querySelector('.modal__share-btn');
    if (!shareBtn) {
      shareBtn = document.createElement('button');
      shareBtn.type = 'button';
      shareBtn.className = 'icon-btn modal__share-btn';
      shareBtn.title = 'Copy share link';
      shareBtn.setAttribute('aria-label', 'Copy share link');
      shareBtn.innerHTML = geoguideIconSvg('share');
      if (closeBtn) {
        closeBtn.parentNode.insertBefore(shareBtn, closeBtn);
      }
      shareBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (shareBtn._region) {
          copyToClipboard(buildExploreShareUrl(shareBtn._region), function() {
            shareBtn.innerHTML = '<span style="font-size:14px;font-weight:bold;color:var(--status-approved,#2e7d32);">✓</span>';
            shareBtn.title = 'Link copied!';
            setTimeout(function() {
              shareBtn.innerHTML = geoguideIconSvg('share');
              shareBtn.title = 'Copy share link';
            }, 1000);
          }, function() {
            shareBtn.title = 'Failed to copy';
            setTimeout(function() { shareBtn.title = 'Copy share link'; }, 1000);
          });
        }
      });
    }
    shareBtn._region = region;

    // Hide both until ownership check completes — prevents layout jump
    compareBtn.style.display = 'none';
    editBtn.style.display = 'none';
    editBtn.href = '/submit?edit=' + region.id;

    // Show buttons together after lazy check.
    // 国家范围条目不参与对比（compare.js 的 addToCompare 也会拒绝它）——藏掉按钮，
    // 免得点下去毫无反应，那比没有按钮更让人困惑。判断放在这里而不是上面一次性设置，
    // 因为 showActions 才是这条路径上最后写 display 的地方，别处设了也会被它覆盖。
    function showActions(showEdit) {
      compareBtn.style.display = (region.scope === 'country') ? 'none' : '';
      if (showEdit) editBtn.style.display = '';
    }

    if (window.__currentUser) {
      fetch('/api/user-submissions?action=check-owner&id=' + encodeURIComponent(region.id))
        .then(function(r) { return r.json(); })
        .then(function(data) {
          showActions(data && data.is_owner);
        })
        .catch(function() { showActions(false); });
    } else {
      // Not logged in — show compare only, no need to wait
      showActions(false);
    }
  }

  // 标签
  tags.innerHTML = '';
  if (region.tags && region.tags.length) {
    region.tags.forEach(function(t) {
      const span = document.createElement('span');
      span.className = 'modal__tag';
      span.textContent = typeof formatTagName === 'function' ? formatTagName(t) : t;
      if (typeof formatTagFull === 'function') span.title = formatTagFull(t);
      tags.appendChild(span);
    });
  }

  // Markdown 教学文本
  desc.innerHTML = '';
  if (region.description) {
    desc.innerHTML = DOMPurify.sanitize(marked.parse(region.description));
  }

  var descContainer = document.getElementById('modal-desc');

  // Detailed description — 默认折叠的下拉区，非空时才显示，避免占用空间
  var oldDetail = descContainer.parentNode.querySelector('.modal__detailed');
  if (oldDetail) oldDetail.remove();
  var detail = null;
  var detailBody = null;
  if (region.detailed_description) {
    detail = document.createElement('details');
    detail.className = 'modal__detailed';
    detail.style.cssText = 'margin-top:8px;font-size:14px;';
    var detailSummary = document.createElement('summary');
    detailSummary.textContent = 'Detailed description';
    detailSummary.style.cssText = 'cursor:pointer;font-weight:600;';
    detailBody = document.createElement('div');
    detailBody.style.marginTop = '6px';
    detailBody.innerHTML = DOMPurify.sanitize(marked.parse(region.detailed_description));
    detail.appendChild(detailSummary);
    detail.appendChild(detailBody);
    descContainer.insertAdjacentElement('afterend', detail);

    // Translation toggle — detailed description（放在展开区内，展开后才可见）
    _buildTranslateToggle(region.id, 'detail', region.detailed_description, function(translated) {
      detailBody.innerHTML = DOMPurify.sanitize(marked.parse(translated));
    }, detail, detailBody);
  }

  // Translation toggle — description（紧跟 short description）
  var oldToggleRow = descContainer.parentNode.querySelector('.modal__toggle-row');
  if (oldToggleRow) oldToggleRow.remove();
  var toggleRow = document.createElement('div');
  toggleRow.className = 'modal__toggle-row';
  if (region.description) {
    _buildTranslateToggle(region.id, 'desc', region.description, function(translated) {
      descContainer.innerHTML = DOMPurify.sanitize(marked.parse(translated));
    }, toggleRow, null);
  }
  if (toggleRow.childNodes.length > 0) {
    descContainer.insertAdjacentElement('afterend', toggleRow);
  }

  // 图片
  gallery.innerHTML = '';
  if (region.image) {
    const figure = document.createElement('figure');
    figure.className = 'modal__figure';

    const pic = document.createElement('img');
    pic.className = 'modal__image';
    pic.src = region.image;
    pic.alt = region.name;
    pic.loading = 'lazy';

    figure.appendChild(pic);
    gallery.appendChild(figure);
  }

  // 贡献者
  source.innerHTML = '';
  if (region.source) {
    source.innerHTML = '<span class="modal__source-label">贡献者：</span>' + escapeHtml(region.source);
  }

  // 提交者
  var submittedEl = document.getElementById('modal-submitted');
  submittedEl.innerHTML = '';
  if (region.submitted_by) {
    submittedEl.innerHTML = '<span class="modal__source-label">Submitted by </span>' + escapeHtml(region.submitted_by);
  } else {
    console.log('modal: no submitted_by for', region.id);
  }

  // Reactions
  var reactionsRow = document.getElementById('modal-reactions');
  if (!reactionsRow) {
    reactionsRow = document.createElement('div');
    reactionsRow.id = 'modal-reactions';
    reactionsRow.className = 'modal__reactions';
    // Insert after source in the modal left column
    var sourceEl = document.getElementById('modal-source');
    if (sourceEl && sourceEl.parentNode) {
      sourceEl.parentNode.insertBefore(reactionsRow, sourceEl.nextSibling);
    }
  }

  // 来源标注（plonkit / rmrg / geohints / other）—— buildSourceBadge 统一生成，
  // 未标注时返回 null，这里整块不渲染。重开弹窗要先把上一次的行摘掉。
  //
  // 位置：紧贴在 reactions 行**上方**。这段必须写在 reactions 行创建之后 ——
  // 首次打开时那个节点还不存在，先插入就没有参照物可插。顺带一提，旧版是
  // appendChild 到左栏末尾，于是徽章一直挂在 reactions 下面。
  var oldSourceBadge = reactionsRow.parentNode.querySelector('.modal__source-badge');
  if (oldSourceBadge) oldSourceBadge.remove();
  var sourceBadge = buildSourceBadge(region.source_type, region.source_url);
  if (sourceBadge) {
    var sourceBadgeRow = document.createElement('div');
    sourceBadgeRow.className = 'modal__source-badge';
    sourceBadgeRow.appendChild(sourceBadge);
    reactionsRow.parentNode.insertBefore(sourceBadgeRow, reactionsRow);
  }

  // Reset reactions row
  reactionsRow.innerHTML = '';
  reactionsRow.dataset.regionId = region.id;

  function renderReactionButtons(data) {
    if (reactionsRow.dataset.regionId !== region.id) return;
    window._renderReactionRow(reactionsRow, region.id, data);
    // Override container class back to modal layout
    reactionsRow.className = 'modal__reactions';
    // 这里曾有五行给「登录/加载提示」加 `grid-column:1/-1`（后改 flex-basis）的代码，
    // 2026-10-04 删掉 —— 它是**死代码**：:1007 那个 "Loading reactions..." 确实是真
    // <span> 直接子节点，但 `_renderReactionRow` 开头的 `container.innerHTML = ''`
    // 在本行之前就把它清掉了，查询恒为 null（插桩实测 3 次全 null，子节点恒为
    // [DIV, BUTTON×6]）。删之前它唯一的效果是命中第一颗按钮内部的计数 span。
    // Sync favorite star from the same per-region response
    if (_favBtn && _favBtn._regionId === region.id) {
      _favBtn._authed = !!data.authenticated;
      setFavButton(!!data.favorited);
    }
  }

  // Use cached data if available (prefetched on hover), otherwise fetch
  if (_reactionsCache[region.id]) {
    renderReactionButtons(_reactionsCache[region.id]);
    delete _reactionsCache[region.id]; // single-use cache — discard after rendering
  } else {
    reactionsRow.innerHTML = '<span style="font-size:12px;color:var(--ink-subtle);">Loading reactions...</span>';
    fetch('/api/reactions?region_id=' + encodeURIComponent(region.id))
      .then(function(r) { return r.json(); })
      .then(function(data) {
        renderReactionButtons(data);
      })
      .catch(function() {
        reactionsRow.innerHTML = ''; // silent fail, hide row
      });
  }

  // Street View carousel
  var GOOGLE_API_KEY = window.__GEOCONFIG__ && window.__GEOCONFIG__.GOOGLE_MAPS_API_KEY;
  if (GOOGLE_API_KEY) {
    renderCarousel(region);
  } else {
    var pano = document.getElementById('streetview-pano');
    var placeholder = document.getElementById('sv-placeholder');
    var arrowLeft = document.getElementById('sv-arrow-left');
    var arrowRight = document.getElementById('sv-arrow-right');
    var counter = document.getElementById('sv-counter');
    var dots = document.getElementById('sv-dots');
    if (pano) { pano.innerHTML = ''; pano.hidden = true; }
    if (placeholder) placeholder.hidden = true;
    if (arrowLeft) arrowLeft.hidden = true;
    if (arrowRight) arrowRight.hidden = true;
    if (counter) counter.hidden = true;
    if (dots) dots.hidden = true;
    if (hint) {
      hint.hidden = false;
      hint.textContent = 'Google Maps API Key not configured (Street View disabled)';
    }
  }

  // 清除待执行的关闭计时器，防止竞态
  if (modal._closeTimer) {
    clearTimeout(modal._closeTimer);
    modal._closeTimer = null;
  }

  // 显示
  modal.hidden = false;
  backdrop.hidden = false;
  backdrop.removeAttribute('aria-hidden');
  document.body.style.overflow = 'hidden';

  // 入场动画
  requestAnimationFrame(function() {
    modal.classList.add('is-open');
    backdrop.classList.add('is-open');
  });

  // Sync URL for shareable region links
  if (window.history && window.history.replaceState) {
    var url = new URL(window.location.href);
    var cid = region.country_id || region.region;
    if (cid) url.searchParams.set('country', cid);
    url.searchParams.set('region', region.id);
    window.history.replaceState({ regionId: region.id }, '', url.toString());
  }

  // 焦点管理 — 聚焦弹窗容器（tabindex="-1"）而非关闭按钮，避免程序化聚焦
  // 触发 :focus-visible 绿色外框（新页面加载后浏览器会把 script focus 当键盘输入）
  document.getElementById('modal').focus();
}

/**
 * 关闭弹窗
 */
function closeModal() {
  const modal = document.getElementById('modal');
  const backdrop = document.getElementById('backdrop');

  // Exit fullscreen if active, so the panorama doesn't keep rendering
  var fsEl = document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement;
  if (fsEl) {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    }
  }

  modal.classList.remove('is-open');
  backdrop.classList.remove('is-open');

  // 关闭弹窗时隐藏重叠标签栏（若存在）
  if (window.hideOverlapTabs) window.hideOverlapTabs();

  // Remove region param from URL
  if (window.history && window.history.replaceState) {
    var url = new URL(window.location.href);
    url.searchParams.delete('region');
    window.history.replaceState({}, '', url.toString());
  }

  // 等动画结束再隐藏
  // Cancel pending Street View load
  if (_streetviewDebounce) {
    clearTimeout(_streetviewDebounce);
    _streetviewDebounce = null;
  }

  modal._closeTimer = setTimeout(function() {
    modal.hidden = true;
    backdrop.hidden = true;

    // Reset translation toggles to original state
    var toggles = modal.querySelectorAll('.lang-toggle__track');
    for (var i = 0; i < toggles.length; i++) {
      toggles[i]._state = 0;
      toggles[i]._loading = false;
      toggles[i].classList.remove('lang-toggle__track--zh', 'lang-toggle__track--en', 'lang-toggle__track--loading');
      toggles[i].setAttribute('aria-valuenow', '0');
      if (toggles[i]._onReplace && toggles[i]._originalText) {
        toggles[i]._onReplace(toggles[i]._originalText);
      }
    }

    backdrop.setAttribute('aria-hidden', 'true');
    // Don't clear overflow if compare overlay is open
    if (!document.querySelector('.compare-overlay')) {
      document.body.style.overflow = '';
    }
    // 停止渲染街景：清空 iframe 容器并丢弃在途加载
    _svShowToken++;
    var svPano = document.getElementById('streetview-pano');
    if (svPano) svPano.innerHTML = '';
    modal._closeTimer = null;
  }, 250);
}

/**
 * Toggle Street View fullscreen
 */
function toggleFullscreen() {
  var sv = document.getElementById('modal-streetview');
  if (!sv) return;

  // Check if any element is currently fullscreen
  var fsEl = document.fullscreenElement
    || document.webkitFullscreenElement
    || document.mozFullScreenElement;

  if (fsEl) {
    // Exit fullscreen
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    } else if (document.mozCancelFullScreen) {
      document.mozCancelFullScreen();
    }
  } else {
    // Enter fullscreen on the Street View container
    if (sv.requestFullscreen) {
      sv.requestFullscreen();
    } else if (sv.webkitRequestFullscreen) {
      sv.webkitRequestFullscreen();
    } else if (sv.mozRequestFullScreen) {
      sv.mozRequestFullScreen();
    }
  }
}

document.addEventListener('DOMContentLoaded', function() {
  // 关闭按钮
  document.getElementById('modal-close').addEventListener('click', closeModal);

  // 点击遮罩关闭
  document.getElementById('backdrop').addEventListener('click', function(e) {
    if (e.target === e.currentTarget) closeModal();
  });

  // Escape 键 — exit fullscreen first, or close modal
  document.addEventListener('keydown', function(e) {
    var modal = document.getElementById('modal');
    if (e.key === 'Escape' && !modal.hidden) {
      var fsEl = document.fullscreenElement
        || document.webkitFullscreenElement
        || document.mozFullScreenElement;
      if (fsEl) {
        // Exit fullscreen but keep modal open
        if (document.exitFullscreen) {
          document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
          document.mozCancelFullScreen();
        }
      } else {
        closeModal();
      }
    }
  });

  // Keyboard shortcuts (skip if typing in an input):
  //   F — fullscreen; ←/→ — switch street view
  document.addEventListener('keydown', function(e) {
    var modal = document.getElementById('modal');
    if (modal.hidden) return;

    // Don't trigger when user is typing
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      toggleFullscreen();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      var list = modal._svList || [];
      if (list.length > 1) {
        if (e.key === 'ArrowLeft' && (modal._svIndex || 0) > 0) {
          e.preventDefault();
          if (modal._showStreetviewFn) modal._showStreetviewFn(modal._svIndex - 1);
        } else if (e.key === 'ArrowRight' && (modal._svIndex || 0) < list.length - 1) {
          e.preventDefault();
          if (modal._showStreetviewFn) modal._showStreetviewFn(modal._svIndex + 1);
        }
      }
    }
  });
});

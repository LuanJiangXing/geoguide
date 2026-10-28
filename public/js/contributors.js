/**
 * Explore 页面贡献者概览弹窗
 * 依赖：utils.js（window._countryMap, countryNames）
 * 被依赖：map.js（按钮点击调用 openContributorsPanel / closeContributorsPanel）
 */

var _contribPanel = null;
var _contribOpenCountry = null;
var _contribOpenList = null;  // 当前面板展示的贡献者数组
var _contribCache = {};    // countryId → array of contributor objects
var _contribPending = {};  // countryId → in-flight fetch promise

function buildContribPanel() {
  var panel = document.createElement('div');
  panel.id = 'contrib-panel';
  panel.className = 'contrib-panel';
  panel.hidden = true;

  var header = document.createElement('div');
  header.className = 'contrib-panel__header';

  var titleWrap = document.createElement('div');
  var title = document.createElement('div');
  title.className = 'contrib-panel__title';
  title.textContent = 'Contributors';
  var subtitle = document.createElement('div');
  subtitle.className = 'contrib-panel__subtitle';
  titleWrap.appendChild(title);
  titleWrap.appendChild(subtitle);

  var closeBtn = document.createElement('button');
  closeBtn.className = 'contrib-panel__close';
  closeBtn.setAttribute('aria-label', 'Close contributors panel');
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', closeContributorsPanel);

  header.appendChild(titleWrap);
  header.appendChild(closeBtn);

  var actions = document.createElement('div');
  actions.className = 'contrib-panel__actions';

  var selectAllBtn = document.createElement('button');
  selectAllBtn.type = 'button';
  selectAllBtn.id = 'contrib-select-all';
  selectAllBtn.className = 'contrib-panel__action';
  selectAllBtn.textContent = 'Select all';
  selectAllBtn.hidden = true;
  selectAllBtn.addEventListener('click', _selectAllContributors);

  var deselectAllBtn = document.createElement('button');
  deselectAllBtn.type = 'button';
  deselectAllBtn.id = 'contrib-deselect-all';
  deselectAllBtn.className = 'contrib-panel__action';
  deselectAllBtn.textContent = 'Deselect all';
  deselectAllBtn.hidden = true;
  deselectAllBtn.addEventListener('click', _deselectAllContributors);

  actions.appendChild(selectAllBtn);
  actions.appendChild(deselectAllBtn);

  var list = document.createElement('div');
  list.className = 'contrib-panel__list';

  panel.appendChild(header);
  panel.appendChild(actions);
  panel.appendChild(list);

  document.body.appendChild(panel);
  return panel;
}

function getCountryName(countryId) {
  if (window._countryMap && window._countryMap[countryId] && window._countryMap[countryId].name) {
    return window._countryMap[countryId].name;
  }
  return countryNames[countryId] || countryId;
}

// Fetch (and cache) the contributor list for a country. Dedupes concurrent calls.
function _loadContributors(countryId) {
  if (_contribCache[countryId]) return Promise.resolve(_contribCache[countryId]);
  if (_contribPending[countryId]) return _contribPending[countryId];
  var p = fetch('/api/submissions?action=contributors&country=' + encodeURIComponent(countryId) + '&limit=0')
    .then(function(resp) { if (!resp.ok) throw new Error('HTTP ' + resp.status); return resp.json(); })
    .then(function(data) {
      var contributors = (data && data.contributors) || [];
      _contribCache[countryId] = contributors;
      delete _contribPending[countryId];
      return contributors;
    })
    .catch(function(err) {
      delete _contribPending[countryId];
      throw err;
    });
  _contribPending[countryId] = p;
  return p;
}

// Prefetch contributors+notes on country entry so the panel opens without a fetch.
window._prefetchContributors = function(countryId) {
  if (!countryId) return;
  _loadContributors(countryId).catch(function() { /* silent */ });
};

/**
 * 把面板夹进视口。
 *
 * 原来只夹了按钮自身的 top（`Math.min(r.top, innerHeight - 8)`），**面板自己多高完全没算** ——
 * 头部 + 操作栏 + 列表最多约 400px，于是只要「按钮 top + 面板高 > 视口高」，面板就整个掉出下边缘
 * （窗口矮一点必现）。CSS 那条 `max-height: calc(100vh - 16px)` 救不了：它从面板自己的 top 起算，
 * 等于允许面板占满整屏、也就等于不设限。
 *
 * 所以：先量自然高度，再让 top 同时满足「贴着按钮」和「整块装得下」，最后把 max-height 收成
 * `视口 - top - 8`，让列表去滚，而不是把面板顶出屏幕。
 *
 * 必须在 `hidden = false` 之后调用 —— 面板 hidden 时 offsetHeight 恒为 0，量出来的是假高度。
 * 内容一变（Loading… → 真实行数）就要再调一次，否则夹的是上一轮的高度。
 */
function positionContribPanel() {
  if (!_contribPanel || _contribPanel.hidden) return;
  var vh = window.innerHeight;

  // 先撤掉上一轮的挤压再量，否则量到的是「上一轮被压过的高度」，一轮比一轮矮
  _contribPanel.style.maxHeight = '';
  var natural = _contribPanel.offsetHeight;

  var desired = 8;
  var btn = document.querySelector('.map-contrib-btn');
  if (btn) {
    var r = btn.getBoundingClientRect();
    // **中线对齐按钮中线**，不是顶部对齐。此前用 `r.top`：面板从按钮顶端往下铺，矮面板看着像
    // 挂在按钮下面，高面板又整块偏下 —— 无论哪种，面板与按钮都不成一条视觉轴。
    desired = Math.max(8, Math.min(r.top + r.height / 2 - natural / 2, vh - 8));
    _contribPanel.style.left = (r.right + 8) + 'px';
  }

  var top = Math.max(8, Math.min(desired, vh - natural - 8));
  _contribPanel.style.top = top + 'px';
  _contribPanel.style.maxHeight = (vh - top - 8) + 'px';
}

// 视口变矮后要重新夹（含手机横竖屏切换）：面板是 position:fixed，不会跟着视口重排。
// 面板关着时 positionContribPanel 第一句就 return，这条常驻监听是廉价的。
window.addEventListener('resize', positionContribPanel);

function openContributorsPanel(countryId) {
  if (!_contribPanel) _contribPanel = buildContribPanel();

  // 互斥：打开贡献者面板时关闭标签筛选面板
  if (typeof window.closeTagFilterPanel === 'function') {
    window.closeTagFilterPanel();
  }

  // Toggle: if already open for the same country, close.
  if (!_contribPanel.hidden && _contribOpenCountry === countryId) {
    closeContributorsPanel();
    return;
  }
  _contribOpenCountry = countryId;

  var subtitle = _contribPanel.querySelector('.contrib-panel__subtitle');
  subtitle.textContent = getCountryName(countryId);

  var list = _contribPanel.querySelector('.contrib-panel__list');

  // 先显示再摆位：摆位要量 offsetHeight，而 hidden 时它恒为 0。
  _contribPanel.hidden = false;
  positionContribPanel();

  // Prefetched on country entry — render instantly if already cached.
  if (_contribCache[countryId]) {
    renderContributors(list, _contribCache[countryId], countryId);
    positionContribPanel();
    return;
  }

  list.innerHTML = '<div class="contrib-panel__status">Loading…</div>';
  positionContribPanel();
  _loadContributors(countryId)
    .then(function(contributors) {
      if (_contribOpenCountry !== countryId) return; // stale response, ignore
      renderContributors(list, contributors, countryId);
      positionContribPanel();   // Loading… 换成真实行数，高度会变
    })
    .catch(function() {
      if (_contribOpenCountry !== countryId) return;
      list.innerHTML = '<div class="contrib-panel__status">Failed to load contributors.</div>';
      positionContribPanel();
    });
}

function toggleContribFilter(c, countryId) {
  var uid = c.user_id || '';
  var sel = _ensureContribSelection(countryId, _contribOpenList || []);
  var idx = sel.user_ids.indexOf(uid);
  if (idx !== -1) {
    sel.user_ids.splice(idx, 1);
  } else {
    sel.user_ids.push(uid);
  }
  _syncContribSelectionUI();
  document.dispatchEvent(new CustomEvent('contribfilter:change'));
}

// 确保当前国家有显式的选中集合：首次打开时默认全选（全选 = 显示全部提交，避免「全不勾选却显示全部」的歧义）
function _ensureContribSelection(countryId, contributors) {
  var sel = window._selectedContributors;
  if (!sel || sel.country_id !== countryId) {
    window._selectedContributors = {
      country_id: countryId,
      user_ids: contributors.map(function(c) { return c.user_id || ''; })
    };
  }
  return window._selectedContributors;
}

function _selectAllContributors() {
  var countryId = _contribOpenCountry;
  if (!countryId) return;
  var contributors = _contribOpenList || [];
  window._selectedContributors = {
    country_id: countryId,
    user_ids: contributors.map(function(c) { return c.user_id || ''; })
  };
  _syncContribSelectionUI();
  document.dispatchEvent(new CustomEvent('contribfilter:change'));
}

function _deselectAllContributors() {
  var countryId = _contribOpenCountry;
  if (!countryId) return;
  window._selectedContributors = { country_id: countryId, user_ids: [] };
  _syncContribSelectionUI();
  document.dispatchEvent(new CustomEvent('contribfilter:change'));
}

// 多选：更新面板高亮与 select all / deselect all 按钮可见性（不重建列表，保留备注展开状态）
function _syncContribSelectionUI() {
  var sel = window._selectedContributors;
  var selectedIds = sel ? sel.user_ids : [];
  var rows = document.querySelectorAll('.contrib-panel__row');
  rows.forEach(function(row) {
    var uid = row.getAttribute('data-user-id');
    var active = selectedIds.indexOf(uid) !== -1;
    row.classList.toggle('is-filtered', active);
    var btn = row.querySelector('.contrib-panel__filter');
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.textContent = active ? '●' : '○';
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  });

  var total = (_contribOpenList || []).length;
  var allSelected = total > 0 && selectedIds.length >= total;
  var noneSelected = selectedIds.length === 0;
  var selectAllBtn = document.getElementById('contrib-select-all');
  var deselectAllBtn = document.getElementById('contrib-deselect-all');
  if (selectAllBtn) selectAllBtn.hidden = total === 0 || allSelected;  // 未全选时显示 select all
  if (deselectAllBtn) deselectAllBtn.hidden = noneSelected;             // 有选中时显示 deselect all
}

function renderContributors(list, contributors, countryId) {
  _contribOpenList = contributors;
  list.innerHTML = '';
  if (contributors.length === 0) {
    list.innerHTML = '<div class="contrib-panel__status">No contributors yet.</div>';
    _syncContribSelectionUI();
    return;
  }

  // 首次打开默认全选：全选 = 显示全部提交
  var selectedIds = _ensureContribSelection(countryId, contributors).user_ids;

  contributors.forEach(function(c) {
    var row = document.createElement('div');
    row.className = 'contrib-panel__row';
    row.setAttribute('data-user-id', c.user_id || '');
    if (c.note) row.classList.add('contrib-panel__row--has-note');

    var isFiltered = selectedIds.indexOf(c.user_id || '') !== -1;
    if (isFiltered) row.classList.add('is-filtered');

    var filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className = 'contrib-panel__filter';
    filterBtn.textContent = isFiltered ? '●' : '○';
    filterBtn.title = 'Toggle this contributor in the filter';
    filterBtn.setAttribute('aria-label', 'Filter to ' + c.username);
    filterBtn.setAttribute('aria-pressed', isFiltered ? 'true' : 'false');
    if (isFiltered) filterBtn.classList.add('is-active');
    filterBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleContribFilter(c, countryId);
    });

    var name = document.createElement('span');
    name.className = 'contrib-panel__name';
    name.textContent = c.username;

    var count = document.createElement('span');
    count.className = 'contrib-panel__count';
    count.textContent = c.count + (c.count === 1 ? ' submission' : ' submissions');
    if (c.note) {
      var marker = document.createElement('span');
      marker.className = 'contrib-panel__note-marker';
      marker.textContent = ' ▸';
      marker.title = 'Has a note';
      count.appendChild(marker);
    }

    row.appendChild(filterBtn);
    row.appendChild(name);
    row.appendChild(count);

    if (c.note) {
      var noteDiv = document.createElement('div');
      noteDiv.className = 'contrib-panel__note';
      noteDiv.hidden = true;

      var noteLabel = document.createElement('div');
      noteLabel.className = 'contrib-panel__note-label';
      noteLabel.textContent = 'Note';

      var noteText = document.createElement('div');
      noteText.className = 'contrib-panel__note-text';
      noteText.textContent = c.note;

      noteDiv.appendChild(noteLabel);
      noteDiv.appendChild(noteText);

      // Translation toggle — reuses modal.js's global toggle (explore.html loads modal.js)
      _buildTranslateToggle(
        c.user_id + ':' + countryId,
        'note',
        c.note,
        function(translated) { noteText.textContent = translated; },
        noteDiv,
        noteText
      );

      noteDiv.addEventListener('click', function(e) {
        e.stopPropagation();
      });

      row.appendChild(noteDiv);
      row.addEventListener('click', function(e) {
        if (e.target.closest && e.target.closest('.lang-toggle')) return;
        if (e.target.closest && e.target.closest('.contrib-panel__note')) return;
        if (_contribMouseDownTarget && _contribMouseDownTarget.closest && _contribMouseDownTarget.closest('.contrib-panel__note')) return;
        if (window.getSelection && window.getSelection().toString().trim().length > 0) return;
        noteDiv.hidden = !noteDiv.hidden;
      });
    }

    list.appendChild(row);
  });

  _syncContribSelectionUI();
}

function closeContributorsPanel() {
  if (_contribPanel) _contribPanel.hidden = true;
  _contribOpenCountry = null;
}

var _contribMouseDownTarget = null;
document.addEventListener('mousedown', function(e) {
  _contribMouseDownTarget = e.target;
});
document.addEventListener('touchstart', function(e) {
  _contribMouseDownTarget = e.target;
}, { passive: true });

// Close on outside click.
document.addEventListener('click', function(e) {
  if (!_contribPanel || _contribPanel.hidden) return;
  var btn = document.querySelector('.map-contrib-btn');
  if (btn && (btn.contains(e.target) || (btn.contains(_contribMouseDownTarget)))) return;
  if (_contribPanel.contains(e.target)) return;
  // If mouse gesture started inside the panel (e.g. dragging to select note text), do not close.
  if (_contribMouseDownTarget && _contribPanel.contains(_contribMouseDownTarget)) return;
  closeContributorsPanel();
});

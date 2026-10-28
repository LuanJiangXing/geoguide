// 「放大镜 → 点开在右侧展开输入框」的搜索控件。
//
// explore 与 my-submissions 共用这一份实现。「两处行为完全一致」不能靠两份代码长得像 ——
// 那会随下一次改动悄悄漂移 —— 只能靠同一份代码。样式同理,共用 style.css 的 .search-chip 一节。
//
// 页面契约:**恰好一个** .search-chip 容器,内含
//   .search-chip__toggle  放大镜按钮
//   .search-chip__field   展开层(初始 hidden)
//   .search-chip__input   真正的输入框
//   .search-chip__clear   清词按钮
//
// 过滤本身由使用方自己监听 __input 的 input 事件(explore 是 search.js,my-submissions 是页面里
// 那段防抖 refetch)—— 本模块只管显隐、聚焦与清词,所以清词后要手动派发一次 input,
// 否则使用方会停留在上一次的过滤结果上。
(function () {
  function initBox(box) {
    if (box._searchChipInited) return;
    box._searchChipInited = true;

    var toggle = box.querySelector('.search-chip__toggle');
    var field = box.querySelector('.search-chip__field');
    var input = box.querySelector('.search-chip__input');
    var clear = box.querySelector('.search-chip__clear');
    if (!toggle || !field || !input || !clear) return;

    function syncClear() { clear.hidden = input.value === ''; }
    function fire() { input.dispatchEvent(new Event('input', { bubbles: true })); }

    function setOpen(open) {
      field.hidden = !open;
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) input.focus();
    }

    toggle.addEventListener('click', function () {
      if (field.hidden) {
        setOpen(true);
        syncClear();
      } else {
        // 展开态再点 = 清词并收起。
        var had = input.value !== '';
        input.value = '';
        syncClear();
        if (had) fire();
        setOpen(false);
      }
    });

    input.addEventListener('input', syncClear);

    document.addEventListener('click', function (e) {
      if (box.contains(e.target)) return;
      if (field.hidden || input.value !== '') return;
      setOpen(false);
    });

    clear.addEventListener('click', function () {
      input.value = '';
      syncClear();
      fire();
      input.focus();
    });

    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (input.value) {
        input.value = '';   // 有词:先清词,保持展开
        syncClear();
        fire();
      } else {
        setOpen(false);     // 空:收起,焦点回到按钮
        toggle.focus();
      }
    });
  }

  function initAll() {
    var boxes = document.querySelectorAll('.search-chip');
    for (var i = 0; i < boxes.length; i++) initBox(boxes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAll);
  } else {
    initAll();
  }
  window.initSearchChips = initAll;
})();

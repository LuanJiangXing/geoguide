// 主题引导 + 浅/深二态切换。
//
// ⚠️ 本文件必须是 <head> 里的一个**同步**脚本 —— **不能加 async，也不能加 defer**。
//
// 但注意：**不是**因为白闪。实测（变异测试）表明，把本文件挪到 css/style.css 之后、
// 甚至加上 defer，都不出现白闪：rAF 回调按定义就发生在首次绘制之前，所以只要那时
// `data-theme` 已设，首绘前就一定是设好的。
//
// 真正不能加 defer 的理由是**与 auth.js 的时序**：defer 会让本文件排到 auth.js 之后执行，
// 那时 window.__theme 还不存在，导航里的主题按钮就挂不上（实测过，那次红了 3 条断言）。
// 页面上的表现是「按钮不见了，其它一切正常」——很容易被当成 flaky 忽略掉。
//
// 契约（.trellis/spec/frontend/theme-system.md）：
//   localStorage['geoguide_theme'] ∈ 'light' | 'dark'，**缺失即 'light'**
//   <html data-theme> ∈ 'light' | 'dark'
//
// 为什么 CSS 里没有 @media (prefers-color-scheme)：那样深色调色板要写两遍
// （一份给媒体查询、一份给 [data-theme]），是个必然漂移的同步点。这里把结果直接
// 落到 DOM，CSS 只需要一个 :root[data-theme="dark"] 块。
// 代价：JS 关闭时永远是浅色 —— 本站内容全部由 fetch + JS 渲染，JS 关闭本来就不可用。
(function () {
  var KEY = 'geoguide_theme';
  var THEMES = ['light', 'dark'];
  var DEFAULT = 'light';
  var root = document.documentElement;

  function systemTheme() {
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
      ? 'dark' : 'light';
  }

  function writePref(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* 存不下也不影响本次会话 */ }
  }

  // 曾经有过第三态 'auto'（跟随系统）。现在只有浅/深两个。
  // ⚠️ 老用户的存储里可能还留着 'auto' —— 直接当脏值回落到 DEFAULT 的话，
  // 一个深色系统的用户下次进站会**从深色突然变成浅色**。所以这里做一次迁移：
  // 把 'auto' 解析成他**此刻正在看的**那套主题并固化下来，升级前后观感不变。
  function readPref() {
    var v = null;
    try { v = localStorage.getItem(KEY); } catch (e) { v = null; }   // 隐私模式/禁用存储
    if (v === 'auto') {
      v = systemTheme();      // 迁移：保留用户当前看到的那一套
      writePref(v);
      return v;
    }
    return THEMES.indexOf(v) >= 0 ? v : DEFAULT;   // 含 null 与脏值
  }

  function apply(theme) {
    root.setAttribute('data-theme', theme);
    return theme;
  }

  // ---- 首屏：同步执行，不等任何事件 ----
  var pref = readPref();
  apply(pref);

  // ---- 对外接口 ----
  function set(theme) {
    if (THEMES.indexOf(theme) < 0) return;
    pref = theme;
    writePref(pref);
    apply(pref);          // ⚠️ 写 DOM 的是这一步，不是派发事件
    document.dispatchEvent(new CustomEvent('theme:change', { detail: { theme: pref } }));
  }

  function cycle() { set(pref === 'light' ? 'dark' : 'light'); }

  // 图标用字形而不是图片：跟站点其它地方（★ / › / ⚠）一致，且不需要额外的网络请求。
  // title 是**用户可见**的（悬停提示 + 读屏标签），所以用英文 —— 站内其余文案
  // 一律英文，这里曾经是中文，是个漏网的。
  var LABEL = {
    light: { icon: '☀', title: 'Switch to dark mode' },   // ☀
    dark:  { icon: '☾', title: 'Switch to light mode' }   // ☾
  };

  // 把切换按钮挂进导航。
  // ⚠️ **必须**由 auth.js 在重建导航之后调用，不能把按钮写在 HTML 的 <nav> 里 ——
  // auth.js 的 initNav() 会执行 `nav.innerHTML = ''`，写死的按钮会被那次重建抹掉。
  // 放在本模块而不是 auth.js，是因为按钮的图标/标题要跟主题状态保持同步。
  function mount(parent) {
    if (!parent || parent.querySelector('.nav__theme')) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nav__theme';

    function sync() {
      var l = LABEL[pref];
      btn.textContent = l.icon;
      btn.title = l.title;
      btn.setAttribute('aria-label', l.title);   // 标题即动作描述，读屏与悬停一致
    }

    btn.addEventListener('click', cycle);
    document.addEventListener('theme:change', sync);
    // sync() 直接读 pref，所以挂载时即使晚于首屏（auth.js 的导航是异步建的）也拿到当前值。
    sync();
    parent.appendChild(btn);
    return btn;
  }

  window.__theme = {
    get: function () { return pref; },
    theme: function () { return root.getAttribute('data-theme'); },
    set: set,
    cycle: cycle,
    mount: mount
  };
})();

// 深色模式与主题切换 —— 首屏时序、三态持久化、原生控件配色、对比度。
//
// WHY 这些断言不能靠截图：本环境读不了图。而且"看起来还行"正是深色模式最容易骗过人的地方 ——
// 暖色系令牌换到深底后，--ink-faded / --ink-subtle 这类"浅灰文字"会静默跌破对比度，
// 肉眼看是"有点淡"，算出来才知道是 3.1:1。所以对比度**用计算色值算**。
//
// Usage: node scripts/test-theme.js
//        BASE_URL=http://localhost:8123 node scripts/test-theme.js
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const KEY = 'geoguide_theme';
const PAGES = ['index.html', 'explore.html', 'my-submissions.html', 'review.html', 'submit.html', 'profile.html'];

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// 在页面里跑：对比度检查。WCAG 2.x 相对亮度 + (L1+0.05)/(L2+0.05)。
const CONTRAST = () => {
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { rgb: [p[0], p[1], p[2]], a: p.length > 3 ? p[3] : 1 };
  };
  // 往上找到第一个不透明的背景（含 alpha 的先忽略，宁可漏报也不误报）
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement.parentNode) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.95) return c.rgb;
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.5;
  };
  const hasText = (el) => Array.prototype.some.call(el.childNodes, (n) => n.nodeType === 3 && n.textContent.trim().length > 1);

  const out = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    if (!hasText(el) || !visible(el)) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = bgOf(el);
    const L1 = lum(fg.rgb), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const bold = parseInt(cs.fontWeight, 10) >= 700;
    // WCAG 大字号：>=24px，或 >=18.66px 且粗体
    const large = px >= 24 || (px >= 18.66 && bold);
    out.push({
      sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''),
      text: el.textContent.trim().slice(0, 24),
      ratio: +ratio.toFixed(2), px, large,
      need: large ? 3 : 4.5,
      fg: cs.color, bg: 'rgb(' + bg.join(',') + ')',
    });
  }
  return out;
};

(async () => {
  const browser = await firefox.launch({ headless: true });

  // ---------- AC2 / AC8：首屏时序 + data-theme 永不为 auto ----------
  console.log('--- 首屏主题落定（AC2）与取值域（AC8） ---');
  for (const scheme of ['light', 'dark']) {
    for (const stored of [null, 'light', 'dark', 'auto', 'garbage']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });
      await ctx.addInitScript(([k, v]) => {
        window.__ff = null;
        if (v !== null) { try { localStorage.setItem(k, v); } catch (e) {} }
        requestAnimationFrame(() => { window.__ff = document.documentElement.getAttribute('data-theme'); });
      }, [KEY, stored]);
      const p = await ctx.newPage();
      await p.goto(BASE + '/index.html', { waitUntil: 'load' });
      const r = await p.evaluate(() => ({
        ff: window.__ff, now: document.documentElement.getAttribute('data-theme'),
      }));
      // 只有浅/深两态。「跟随系统」已移除：
      //   缺失 / 脏值 → 默认浅色（深色做默认不合理）
      //   'auto'      → 老用户的遗留值，迁移成**他此刻正在看的**那套，升级前后观感不变
      const want = stored === 'dark' ? 'dark'
        : stored === 'auto' ? (scheme === 'dark' ? 'dark' : 'light')
        : 'light';
      ok(r.now === want, `系统 ${scheme} + 存储 ${String(stored)} → ${want}`, { got: r.now });
      ok(r.ff === want, `同上：**首帧**就是 ${want}（无白闪）`, { firstFrame: r.ff });
      ok(r.now === 'light' || r.now === 'dark', 'AC8：data-theme 从不是 auto', { got: r.now });
      if (stored === 'auto') {
        // 迁移必须**落盘**，否则每次进来都要重算一遍，而且用户之后再改系统偏好会被再次带走
        const persisted = await p.evaluate((k) => { try { return localStorage.getItem(k); } catch (e) { return '(读不到)'; } }, KEY);
        ok(persisted === want, `'auto' 已迁移并落盘为 ${want}`, { persisted });
      }
      await ctx.close();
    }
  }

  // ---------- 结构性断言：theme.js 必须是 head 里的**同步**脚本 ----------
  // ⚠️ 为什么光有「首帧属性已设」不够：那条断言在把 theme.js 改成 `defer` 之后**依然全绿**。
  // rAF 回调按定义发生在首次绘制之前，所以「首帧已设」确实等价于「首绘前已设」——
  // 也就是说 `defer` 在这个页面上并没有造成白闪，那条断言测不出它。
  // 但 sync 这个性质本身是有代价的，且**实测过**：加了 defer 之后 theme.js 会排在
  // auth.js 之后执行，`window.__theme` 还不存在，导航按钮就挂不上（跑的当次红了 3 条）。
  // 所以这里直接断言载体本身，而不是绕过它去测一个测不到的后果。
  {
    const fs = require('fs');
    const path = require('path');
    for (const name of PAGES) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8');
      const head = src.slice(src.indexOf('<head>'), src.indexOf('</head>'));
      const tag = (head.match(/<script[^>]*js\/theme\.js[^>]*>/) || [])[0];
      ok(!!tag, `${name}：<head> 里有 js/theme.js`, { tag });
      if (tag) {
        ok(!/\b(async|defer)\b/.test(tag), `${name}：theme.js 是同步脚本（无 async/defer）`, { tag });
      }
    }
  }

  // ---------- AC3：三态持久化 ----------
  console.log('\n--- 三态持久化（AC3） ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    // 二态：light ⇄ dark。⚠️ 断言「每一次点击配色都真的变了」——
    // 三态那版就是在这一点上栽的（从 auto 出发的第一下可能什么都没变），
    // 所以这条要一直守着，防止将来又引入一个「点了但看不出」的状态。
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await p.evaluate(() => [window.__theme.get(), window.__theme.theme()]));
      await p.evaluate(() => window.__theme.cycle());
    }
    ok(JSON.stringify(seen.map((x) => x[0])) === JSON.stringify(['light', 'dark', 'light', 'dark']),
      '二态循环 light→dark→light→dark', { prefs: seen.map((x) => x[0]) });
    ok(JSON.stringify(seen.map((x) => x[1])) === JSON.stringify(['light', 'dark', 'light', 'dark']),
      '每一次点击配色都真的变了', { themes: seen.map((x) => x[1]) });

    // 设为 dark 后刷新，应当保持
    await p.evaluate(() => window.__theme.set('dark'));
    await p.reload({ waitUntil: 'load' });
    const after = await p.evaluate(() => ({ t: document.documentElement.getAttribute('data-theme'), p: window.__theme.get() }));
    ok(after.t === 'dark' && after.p === 'dark', '设为 dark 后刷新仍然深色', after);

    // 清掉存储后回到「跟随系统」
    await p.evaluate(() => { try { localStorage.removeItem('geoguide_theme'); } catch (e) {} });
    await p.reload({ waitUntil: 'load' });
    const cleared = await p.evaluate(() => window.__theme.get());
    ok(cleared === 'light', '清除存储后回到默认（浅色）', { got: cleared });
    await ctx.close();
  }
  {
    // ⚠️ 这条专门守「跟随系统」真的被去掉了：**深色系统 + 无存储，首访必须是浅色**。
    // 如果哪天有人把 auto 加回来，这条会立刻红。
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    const first = await p.evaluate(() => [window.__theme.get(), document.documentElement.getAttribute('data-theme')]);
    ok(first[0] === 'light' && first[1] === 'light',
      '深色系统 + 无存储 → 首访仍是浅色（跟随系统已移除）', { pref: first[0], theme: first[1] });
    const seen = [];
    for (let i = 0; i < 4; i++) {
      seen.push(await p.evaluate(() => [window.__theme.get(), window.__theme.theme()]));
      await p.evaluate(() => window.__theme.cycle());
    }
    ok(JSON.stringify(seen.map((x) => x[0])) === JSON.stringify(['light', 'dark', 'light', 'dark']),
      '深色系统下的二态循环与系统设置无关', { prefs: seen.map((x) => x[0]) });
    await ctx.close();
  }

  // ---------- AC4：color-scheme ----------
  console.log('\n--- 原生控件配色（AC4） ---');
  // ⚠️ 必须**显式写存储**，不能像改之前那样靠 `colorScheme: 'dark'` 进深色 ——
  // 跟随系统已移除，深色系统 + 无存储现在是浅色。靠系统偏好会让这条在浅色下空跑通过。
  for (const want of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, want]);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    const cs = await p.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    ok(cs === want, `主题 ${want} 时 color-scheme=${want}`, { got: cs });
    await ctx.close();
  }

  // ---------- 导航里的切换按钮 ----------
  // ⚠️ 按钮是 theme.js 的 mount() **动态创建**的，没有任何 HTML 里写着它。
  // 所以「页面上找不到按钮」是本模块四种失败方式里最可能的一种，值得逐页断言：
  // ① auth.js 没挂成 ② auth.js 挂了但它的 nav.innerHTML='' 又抹掉了 ③ theme.js 没加载
  // ④ .nav__links 不存在。每条都表现为"按钮不在"，而页面其它部分一切正常。
  console.log('\n--- 导航里的切换按钮 ---');
  for (const name of PAGES) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/' + name, { waitUntil: 'load' });
    await p.waitForTimeout(800);
    const r = await p.evaluate(() => {
      const b = document.querySelector('.nav__theme');
      if (!b) return { missing: true, hasNav: !!document.querySelector('.nav'), hasLinks: !!document.querySelector('.nav__links') };
      const before = document.documentElement.getAttribute('data-theme');
      b.click();
      const box = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        before, after: document.documentElement.getAttribute('data-theme'),
        pref: window.__theme.get(), h: Math.round(box.height), w: Math.round(box.width),
        title: b.title, glyph: b.textContent.trim(),
        fontPx: parseFloat(cs.fontSize),
        border: cs.borderTopStyle + '/' + cs.borderTopWidth,
        hasBg: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
      };
    });
    if (r.missing) {
      ok(false, `${name}：导航里有 .nav__theme`, r);
    } else {
      ok(r.before === 'light' && r.after === 'dark', `${name}：点一下 light→dark`, { before: r.before, after: r.after, pref: r.pref });
      ok(r.h >= 32, `${name}：按钮高 ${r.h}px（走 --mid 档，非写死 44）`, { w: r.w, h: r.h });
      // 2026-09-28 用户要求：只留浅/深两态、去掉边框、把太阳/月亮放大。
      // 三条都钉住 —— 都是「改回去也照样能跑」的那种，不测就没人挡得住。
      ok(r.glyph === '☀' || r.glyph === '☾', `${name}：只显示太阳或月亮（无第三态）`, { glyph: r.glyph });
      ok(r.border === 'none/0px' && !r.hasBg, `${name}：无边框无底色`, { border: r.border, hasBg: r.hasBg });
      ok(r.fontPx >= 20, `${name}：图标字号 ${r.fontPx}px（已放大）`, { fontPx: r.fontPx });
    }
    await ctx.close();
  }

  // ---------- AC5：JS 画布要重取令牌 ----------
  // ⚠️ 断言的是**画布真的被用新色值画过**，不是「重绘函数被调用了」。
  // 做法：在页面脚本之前给 CanvasRenderingContext2D.fillStyle 装一个记录器，
  // 收集所有被赋过的值，再看深色那份令牌色有没有出现在里面。
  // 星图不能用 getImageData 验证 —— 头像跨域会把画布弄脏（源码里有注明），读像素会抛 SecurityError。
  console.log('\n--- JS 画布重取令牌（AC5）---');
  const FILL_RECORDER = () => {
    window.__fills = new Set();
    const d = Object.getOwnPropertyDescriptor(CanvasRenderingContext2D.prototype, 'fillStyle');
    Object.defineProperty(CanvasRenderingContext2D.prototype, 'fillStyle', {
      configurable: true,
      get() { return d.get.call(this); },
      set(v) { try { window.__fills.add(String(v)); } catch (e) {} d.set.call(this, v); },
    });
  };

  // reduced 那一档才是最会漏的：renderNow() 画完一帧就不排下一帧了，
  // 不在 theme:change 里手动补一帧的话，星图会停在旧配色上，而且只在开了
  // prefers-reduced-motion 的机器上复现。
  for (const [label, reducedMotion] of [['常规（动画循环）', 'no-preference'], ['降低动态效果（静态一帧）', 'reduce']]) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light', reducedMotion });
    await ctx.addInitScript(FILL_RECORDER);
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
    });
    await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    // ⚠️ 必须给贡献者名单，否则 initConstellation 拿到空数组直接 return，画布上一次填充都不会发生 ——
    // 断言就变成**空断言**（第一版就是这样：记录到 0 种颜色，看似"没坏"，其实什么都没测）。
    // 前提断言 `lightFills.length > 0` 就是用来挡这个的。
    // 头像留空：跨域图会让画布 tainted，且这里也不需要真图（会走首字母占位路径）。
    // ⚠️ Playwright 路由后注册者优先，所以这条要排在通用 **/api/** 之后。
    await ctx.route('**/api/submissions**', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ contributors: [
        { user_id: 'u1', username: 'alice', count: 12, avatar_url: '' },
        { user_id: 'u2', username: 'bob', count: 7, avatar_url: '' },
        { user_id: 'u3', username: 'carol', count: 3, avatar_url: '' },
      ] }),
    }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await p.waitForTimeout(1200);
    // ⚠️ 星图在首屏之下，不滚进视口的话 IntersectionObserver 判它不可见，
    // 动画循环根本不会启动（这是**正确行为** —— 不该为了测试去改产品代码）。
    // 症状是「记录到 0 种填充色」，和"重绘钩子失效"长得一模一样，很容易误判。
    await p.evaluate(() => {
      const el = document.getElementById('constellation-stage') || document.getElementById('constellation-canvas');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
    });
    await p.waitForTimeout(900);
    const r = await p.evaluate(async () => {
      const wait = (n) => new Promise((res) => { let i = 0; const t = () => (++i >= n ? res() : requestAnimationFrame(t)); requestAnimationFrame(t); });
      // ⚠️ 先取初始渲染留下的记录，**再**清空 —— 不要先清空再等几帧：
      // 降低动态效果那一档只画一帧（renderNow），清空之后不会再有任何绘制，
      // 前提断言会拿到 0 而误报成"星图没画"。动画档则一直在画，两种模式都能取到。
      const lightFills = Array.from(window.__fills);
      window.__fills.clear();
      const darkPaper = getComputedStyle(document.documentElement).getPropertyValue('--paper-light').trim();
      window.__theme.set('dark');
      await wait(6);
      const darkFills = Array.from(window.__fills);
      const darkPaperNow = getComputedStyle(document.documentElement).getPropertyValue('--paper-light').trim();
      return { lightFills, darkFills, darkPaper, darkPaperNow, theme: document.documentElement.getAttribute('data-theme') };
    });
    // 前提：深浅两套的 --paper-light 必须真的不同，否则这条断言是空的
    ok(r.lightFills.length > 0, `${label}：星图确实在往画布上画（记录到 ${r.lightFills.length} 种填充色）`, { got: r.lightFills.slice(0, 5) });
    ok(r.darkPaperNow !== r.darkPaper, `${label}：--paper-light 在深色下确实变了（${r.darkPaper} → ${r.darkPaperNow}）`, {});
    ok(r.darkFills.includes(r.darkPaperNow),
      `${label}：切换后画布**用新的 --paper-light 画过**`,
      { 深色应有: r.darkPaperNow, 实际记录: r.darkFills.slice(0, 8) });
    await ctx.close();
  }

  // review.html 的两个 Chart.js 图表：颜色在 JS 配置里，CSS 够不到。
  // Chart.js 来自 CDN，测试里被 abort，所以这里做**源码级**断言而不是运行时断言 ——
  // 它守的是「有人把颜色又写死回去」这个回归，强度弱于上面那条，但比没有强。
  {
    const fs = require('fs');
    const src = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'review.html'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    ok(/document\.addEventListener\('theme:change',\s*retintCharts\)/.test(code),
      'review.html 注册了 theme:change → retintCharts');
    ok(!/grid:\s*\{\s*color:\s*'#/.test(code),
      'review.html 的图表网格线不再写死颜色（否则深色下是一条看不见的线）',
      { 命中: (code.match(/grid:\s*\{\s*color:\s*'#[^']*'/g) || []) });
    ok(!/ticks:\s*\{[^}]*font:\s*\{\s*size:\s*10\s*\}\s*\}[^}]*\}[^}]*grid/.test(code) || /color:\s*ct\.text/.test(code),
      'review.html 的刻度文字给了颜色（不给就吃 Chart.js 默认 #666，深色下是灰字压深底）');
  }

  // ---------- 地图控件：底盘保持浅色，前景色就必须跟着**不翻** ----------
  // 底图已决策保持浅色，所以地图上那几个钮的底盘是写死的 #fff。既然底盘不翻，前景也不能翻 ——
  // 但共享规则原来写的是 `color: var(--ink-charcoal)`，深色下翻成 #ece5d8 米白：白底米白字形，
  // 看着就像禁用态（实测 1.25:1 / 1.98:1，浅色是 15.32:1 / 7.95:1）。
  // 紧挨着它们的 Leaflet 自带 +/- 用 leaflet.css 的 color:black，深色下依然是黑字 ——
  // 同一列两套观感，所以这不是审美偏好，是自洽性问题。
  //
  // 判据取「深浅两色**逐字相同**」：底盘相同，前景就该相同。比任何阈值都严格，也更难糊弄。
  // ⚠️ .map-reset/-contrib/-expand 由 js/map.js 在 mapready 时创建，而 Leaflet 在本测试里
  //    拉不到（外部请求一律 abort），所以这里把类名注入页面直接量**规则**，而不是等按钮出现。
  console.log('\n--- 地图控件前景色（深色下必须与浅色逐字相同） ---');
  {
    const INJECT = () => {
      const host = document.querySelector('.map-shell') || document.body;
      const read = (el) => { const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundColor }; };
      const made = [];
      const out = { injected: {}, real: {}, barGrad: null, modalGrad: null };
      for (const cls of ['map-reset-btn', 'map-contrib-btn', 'map-expand-btn']) {
        const b = document.createElement('button');
        b.className = cls;
        b.textContent = '↻';
        host.appendChild(b);
        made.push(b);
        out.injected[cls] = read(b);
      }
      for (const b of made) b.remove();
      for (const sel of ['.search-chip__toggle', '.tag-filter__toggle']) {
        const el = document.querySelector(sel);
        out.real[sel] = el ? read(el) : null;
      }
      const bar = document.querySelector('.country-bar-row');
      out.barGrad = bar ? getComputedStyle(bar).backgroundImage : null;
      const ml = document.querySelector('.modal__left');
      out.modalGrad = ml ? getComputedStyle(ml).backgroundImage : null;
      const msChip = document.querySelector('.my-submissions .search-chip__toggle');
      out.msChip = msChip ? read(msChip) : null;
      return out;
    };
    const grab = async (page, theme) => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
      await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, theme]);
      await ctx.route('**/*', (r) => {
        const u = r.request().url();
        return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
      });
      await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      const p = await ctx.newPage();
      await p.goto(BASE + '/' + page, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1500);
      const r = await p.evaluate(INJECT);
      await ctx.close();
      return r;
    };

    const LIGHT_WARM = '245, 240, 227';   // 浅色 --paper-warm / --border-warm 的写死残留
    const LIGHT_BORDER = '217, 208, 188';
    const l = await grab('explore.html', 'light');
    const d = await grab('explore.html', 'dark');

    for (const cls of Object.keys(l.injected)) {
      const a = l.injected[cls], b = d.injected[cls];
      ok(a.color === b.color && a.bg === b.bg,
        `${cls} 深浅两色逐字相同（底盘是白的，前景就不能翻）`, { light: a, dark: b });
    }
    for (const sel of Object.keys(l.real)) {
      ok(!!l.real[sel] && !!d.real[sel], `explore 上找得到 ${sel}`);
      if (!l.real[sel] || !d.real[sel]) continue;
      const a = l.real[sel], b = d.real[sel];
      ok(a.color === b.color && a.bg === b.bg, `explore 的 ${sel} 深浅两色逐字相同`, { light: a, dark: b });
    }
    ok(!!l.barGrad && l.barGrad.indexOf(LIGHT_WARM) > -1, '底栏渐变浅色一侧没被改动', { got: l.barGrad });
    ok(!!d.barGrad && d.barGrad.indexOf(LIGHT_WARM) === -1,
      '底栏渐变在深色下不再残留写死的浅色（那正是「上深下浅」的来源）', { got: d.barGrad });
    ok(!!d.modalGrad && d.modalGrad.indexOf(LIGHT_BORDER) === -1,
      '弹窗左栏的装订线阴影在深色下不再残留写死的浅色', { got: d.modalGrad });

    // ⚠️ 唯一的例外，且是**有意**的：my-submissions 的放大镜被改成了无底无框、坐在**页面**上，
    // 不在白色底盘上，所以它必须继续跟主题（深色下变浅）。谁要是顺手把这条也"统一"掉，就瞎了。
    const ms = await grab('my-submissions.html', 'dark');
    const msLight = await grab('my-submissions.html', 'light');
    if (ms.msChip && msLight.msChip) {
      ok(ms.msChip.color !== msLight.msChip.color,
        'my-submissions 的放大镜**仍然跟主题**（它无底无框、坐在页面上，不在白色底盘上）',
        { light: msLight.msChip.color, dark: ms.msChip.color });
    }
  }

  // ---------- AC7：对比度 ----------
  // ⚠️ 深浅两侧的标准**故意不一样**，这不是放水：
  //   深色 —— 严格 AA。这是本轮新做的，没有历史包袱。
  //   浅色 —— 只守「没有新增不达标」。既有浅色主题里 --ink-faded(#7a7265) 压在
  //           --paper-warm(#f5f0e3) 上就是 **4.17:1**，本来就低于 AA。而本轮承诺
  //           浅色零视觉变化（AC1），修它等于改浅色渲染 —— 那是另一件事。
  //           所以浅色只断言：**所有**不达标项的前景色必须都是 --ink-faded。
  //           冒出任何别的颜色，就说明是本轮引入的回归。
  const INK_FADED = 'rgb(122, 114, 101)';   // #7a7265
  console.log('\n--- 对比度（AC7） ---');
  for (const scheme of ['light', 'dark']) {
    let total = 0, bad = [];
    for (const name of PAGES) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
      // ⚠️ 同上：靠系统偏好进深色已经行不通，必须显式写存储，否则深色那一轮实际跑的是浅色。
      await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY, scheme]);
      await ctx.route('**/*', (r) => {
        const u = r.request().url();
        return (u.startsWith(BASE) || u.startsWith('data:')) ? r.continue() : r.abort();
      });
      await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
      const p = await ctx.newPage();
      await p.goto(BASE + '/' + name, { waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(1200);
      const rows = await p.evaluate(CONTRAST);
      total += rows.length;
      bad = bad.concat(rows.filter((r) => r.ratio < r.need - 0.05).map((r) => ({ page: name, ...r })));
      await ctx.close();
    }
    if (scheme === 'dark') {
      ok(bad.length === 0, `深色：${total} 个文字元素全部达到 AA`, bad.length ? bad.slice(0, 8) : { checked: total });
    } else {
      const foreign = bad.filter((r) => r.fg !== INK_FADED);
      ok(foreign.length === 0,
        `浅色：无**新增**不达标（历史遗留的 --ink-faded 4.17:1 除外）`,
        { 历史遗留: bad.length, 检查了: total, 新增: foreign.slice(0, 6) });
    }
  }

  await browser.close();
  console.log(fails ? `\n== FAILURES: ${fails}` : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

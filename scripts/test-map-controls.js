#!/usr/bin/env node
/**
 * 地图控件检查：Leaflet 控件的几何、字形居中，以及样式表级联顺序。
 *
 * 为什么不能直接用 test-style-parity.js：leaflet.css 来自 unpkg（非同源），
 * 那个脚本会 abort 所有非同源请求 —— 于是 leaflet 自己的规则完全不参与级联。
 * `.leaflet-control-zoom a` 这类「两边同优先级、谁在后面谁赢」的冲突它看不见，
 * 而这正是本脚本要测的东西。本脚本放行 unpkg，只挡住瓦片图片。
 *
 * 用法：
 *   BASE_URL=http://localhost:8123 node scripts/test-map-controls.js --snapshot /tmp/map.json
 *   BASE_URL=http://localhost:8123 node scripts/test-map-controls.js --compare  /tmp/map.json
 *   BASE_URL=http://localhost:8123 node scripts/test-map-controls.js --selfcheck
 *   BASE_URL=http://localhost:8123 node scripts/test-map-controls.js --selfcheck --touch
 *
 * `--touch` 给上下文加 hasTouch，于是 `pointer: coarse` 为真 —— 控件档位应随之从 36 抬到 44。
 * **两个上下文都要跑**：只跑默认的那个，触屏例外层就是没被测过的代码。
 * 默认（不加 --touch）是 pointer: fine，也就是 2026-09-28 分档改造之前所有测试跑的环境。
 *
 * 本环境读不了图片，所以「+/- 是否居中」不靠截图，靠量：取控件文字/图标自身的
 * client rect，和它所在盒子的中心比。偏移超过 TOLERANCE 就是没居中 —— 这正是
 * my-submissions 上曾经出现的 bug（盒子被我们的 min-height 撑到 44px，
 * 但 leaflet 的 line-height:30px + display:block 把字形顶到了上半部分）。
 */
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:8123').replace(/\/$/, '');
const TOLERANCE = 2;           // px，字形中心与盒子中心的最大允许偏移
const TIER_TOLERANCE = 1;      // px，控件盒子与档位值之间允许的偏差

// 控件档位来自 `--mid`（见 .trellis/spec/frontend/touch-targets.md）。
// ⚠️ 原来这里写死 MIN_TARGET = 40，那是「44 是默认」时代留下的余量常量：档位一变它就骗人。
// 还有一层更隐蔽的问题:它量的是**盒子**不是命中区 —— 缩放锚点在 `.leaflet-bar` 里,bar 的
// 2px 边框落在锚点**之外**,所以锚点宽 = 档位 − 4,外框才与旁边那列齐平。
// 下面两个数是**政策值**:改它们等于改政策,断言写死是为了让改动必须是有意的。
const TIER_DESKTOP = 36;       // pointer: fine
const TIER_TOUCH = 44;         // pointer: coarse
const TOUCH = process.argv.includes('--touch');

const USER = { id: 1, username: 'probe', avatar: null, is_admin: 1, is_reviewer: 1 };

// explore 的地图只在 regions 非空时才创建（app.js 空数组直接 throw）。
// 一条南非境内的小多边形就够，控件几何与它无关。
const PROBE_REGION = {
  id: 'probe-region',
  name: 'Probe Region',
  country: 'south-africa',
  geojson: {
    type: 'Polygon',
    coordinates: [[[24.0, -30.0], [25.0, -30.0], [25.0, -29.0], [24.0, -29.0], [24.0, -30.0]]],
  },
};

// 只放行 unpkg（leaflet.css / leaflet.js）。瓦片一律挡掉：图片加载与否不影响
// 控件的计算样式，但会让页面在加载中反复重排，采样就不稳定了。
const ALLOW = ['unpkg.com'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 采样

const SAMPLE = () => {
  // 取「字形/图标」真正的绘制矩形，而不是它所在的盒子。
  const glyphRect = (el) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.textContent.trim()) {
        const rg = document.createRange();
        rg.selectNodeContents(n);
        const rc = rg.getClientRects()[0];
        if (rc) return rc;
      }
      if (n.nodeType === 1) {
        const rc = n.getBoundingClientRect();
        if (rc.width && rc.height) return rc;
      }
    }
    return null;
  };

  const describe = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const g = glyphRect(el);
    return {
      box: [Math.round(r.width), Math.round(r.height)],
      // 字形中心相对盒子中心的偏移；null = 没有可测的字形
      offset: g
        ? [
            +(g.x + g.width / 2 - (r.x + r.width / 2)).toFixed(1),
            +(g.y + g.height / 2 - (r.y + r.height / 2)).toFixed(1),
          ]
        : null,
      display: cs.display,
      lineHeight: cs.lineHeight,
      fontSize: cs.fontSize,
      textIndent: cs.textIndent,
    };
  };

  const controls = {};
  document.querySelectorAll('.leaflet-control-zoom a').forEach((a) => {
    controls['zoom-' + a.className.replace(/.*leaflet-control-zoom-/, '').split(' ')[0]] = describe(a);
  });
  document.querySelectorAll('.map-expand-btn').forEach((b) => { controls['expand'] = describe(b); });

  // 同一个角里的控件会纵向堆叠，多个控件挤在一起就可能压住彼此。
  // 注意 Leaflet 的 DOM 类名是 `.leaflet-top.leaflet-left`，
  // `.leaflet-topleft` 只存在于 JS 的 position 选项里 —— 写错会静默变成空检查。
  const CORNERS = {
    topleft: '.leaflet-top.leaflet-left',
    topright: '.leaflet-top.leaflet-right',
    bottomleft: '.leaflet-bottom.leaflet-left',
    bottomright: '.leaflet-bottom.leaflet-right',
  };
  const corners = {};
  for (const [corner, sel] of Object.entries(CORNERS)) {
    const c = document.querySelector(sel);
    if (!c) continue;
    corners[corner] = [...c.querySelectorAll('.leaflet-control')].map((el) => {
      const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.right), Math.round(r.bottom)];
    });
  }

  const mapEl = document.getElementById('my-map') || document.getElementById('map');
  const img = document.querySelector('.leaflet-container .leaflet-map-pane');
  const expandWrap = document.getElementById('my-map-wrap');

  return {
    // 这一轮的环境与档位：断言要**跟着它走**，而不是跟着写死的数字走
    coarse: matchMedia('(pointer: coarse)').matches,
    tier: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--mid')) || 0,
    compact: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--compact')) || 0,
    stylesheetOrder: [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => {
      const u = new URL(l.href);
      return u.hostname === location.hostname ? 'local/' + u.pathname.split('/').pop() : u.hostname + '/' + u.pathname.split('/').pop();
    }),
    controls,
    corners,
    // `.map-tools` 那一列（探索页的两个工具钮）的底边到缩放控件顶边的距离。
    // 这个值必须是一个**固定的**小间隙（Leaflet 自己的 10px 边距），因为它由
    // `--map-tools-h` 推出来，而 `--map-tools-h` 必须等于「工具列的真实高度」。
    // ⚠️ 两者一旦脱钩（比如按钮降档而 --map-tools-h 还写死旧值），这里就会多出一段**静默的
    // 空白** —— 下面那圈「重叠」断言完全看不见间隙，所以必须单独量这一条。
    // 2026-09-28 分档改造时就真的脱钩过：按钮 44→36，工具列只占 72，而 --map-tools-h 仍是 88。
    toolsGap: (() => {
      const t = document.querySelector('.map-tools');
      const z = document.querySelector('.leaflet-control-zoom');
      if (!t || !z) return null;
      return Math.round(z.getBoundingClientRect().top - t.getBoundingClientRect().bottom);
    })(),
    mapHeight: mapEl ? Math.round(mapEl.getBoundingClientRect().height) : null,
    // leaflet 自己记的尺寸 vs DOM 实际尺寸：两者不一致说明改完高度没 invalidateSize()
    leafletSize: (() => {
      const m = window.myMap || window.map;
      if (!m || !m.getSize) return null;
      const s = m.getSize();
      return [Math.round(s.x), Math.round(s.y)];
    })(),
    // leaflet 的 getSize() 用的是 clientWidth/clientHeight（不含边框），所以要拿同样的
    // 盒子来比。#my-map 有 1px 边框，用 getBoundingClientRect 会比出恒定的 2px 假差异。
    domSize: mapEl ? [mapEl.clientWidth, mapEl.clientHeight] : null,
    hasMapPane: !!img,
    // 横向宽度由 .my-submissions 这一列决定：地图是 width:100%，100% 取的是这列的
    // 内容盒。只测地图宽度的话，列被卡住时读到的数字「正常」，看不出问题。
    mainWidth: (() => {
      const m = document.querySelector('main.my-submissions');
      return m ? m.clientWidth : null;
    })(),
    bodyClasses: document.body.className,
    expandPressed: expandWrap ? expandWrap.classList.contains('is-large') : null,
    // 按钮自身的状态：图标要换、aria-expanded 要跟着变，否则读屏用户不知道当前是哪个态
    expandAria: (() => { const b = document.querySelector('.map-expand-btn'); return b ? b.getAttribute('aria-expanded') : null; })(),
    expandLabel: (() => { const b = document.querySelector('.map-expand-btn'); return b ? b.getAttribute('aria-label') : null; })(),
    expandIcon: (() => {
      const b = document.querySelector('.map-expand-btn');
      const p = b && b.querySelector('polyline');
      return p ? p.getAttribute('points') : null;
    })(),
  };
};

async function stableSample(page) {
  let prev = null, prevKey = '';
  for (let i = 0; i < 10; i++) {
    const cur = await page.evaluate(SAMPLE);
    const key = JSON.stringify(cur);
    if (prev && key === prevKey) return { data: cur, settled: true, tries: i + 1 };
    prev = cur; prevKey = key;
    await sleep(250);
  }
  return { data: prev, settled: false, tries: 10 };
}

async function newCtx(browser) {
  // hasTouch 是让 `pointer: coarse` 变真的唯一开关 —— firefox 与 chromium 都认（已实测）。
  // 默认上下文是 `pointer: fine`，也就是改造前所有测试跑的那个环境。
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, hasTouch: TOUCH });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    return ALLOW.some((h) => u.includes(h)) ? r.continue() : r.abort();
  });
  const j = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await ctx.route(/\/api\/auth/, (r) => { r.fulfill(j({ user: USER })); });
  await ctx.route(/\/api\/profile/, (r) => { r.fulfill(j({ user: USER, submissions: [] })); });
  await ctx.route(/\/api\/pageview/, (r) => { r.fulfill(j({ ok: true })); });
  await ctx.route(/\/api\/regions/, (r) => { r.fulfill(j({ regions: [], total: 0 })); });
  await ctx.route(/\/api\/countries/, (r) => { r.fulfill(j({ countries: [] })); });
  // explore 的 app.js 在 regions 为空时会 throw，地图根本不会建 —— 必须给一条真数据。
  // my-submissions 不用这个端点，多给一条不影响它。
  await ctx.route(/\/api\/submissions(\?|$)/, (r) => { r.fulfill(j([PROBE_REGION])); });
  await ctx.route(/\/api\/user-submissions/, (r) => {
    const u = r.request().url();
    if (u.includes('action=map')) return r.fulfill(j({ submissions: [] }));
    if (u.includes('action=countries')) return r.fulfill(j({ countries: [] }));
    if (u.includes('action=notifications')) return r.fulfill(j({ notifications: [] }));
    return r.fulfill(j({ submissions: [], total: 0, page: 1 }));
  });
  return ctx;
}

// 打开页面并切到地图视图
async function openMap(browser, path) {
  const ctx = await newCtx(browser);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(BASE + path, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  if (path.includes('my-submissions')) {
    await page.click('#view-tabs .review-tab[data-view="map"]').catch(() => {});
  }
  await page.waitForSelector('.leaflet-control-zoom a', { timeout: 15000 });
  await page.waitForTimeout(600);
  return { ctx, page, errs };
}

// ---------------------------------------------------------------- 断言

function assertControls(label, data, fails) {
  const c = data.controls;
  // 先确认「环境真的翻了」和「档位真的是这个值」—— 这两条不成立，下面所有几何断言都是空转
  const wantTier = TOUCH ? TIER_TOUCH : TIER_DESKTOP;
  if (data.coarse !== TOUCH) fails.push(`${label}: pointer:coarse 是 ${data.coarse}，期望 ${TOUCH}（hasTouch 没生效？）`);
  if (Math.abs(data.tier - wantTier) > TIER_TOLERANCE) {
    fails.push(`${label}: --mid 是 ${data.tier}px，期望 ${wantTier}px（触屏档 ${TIER_TOUCH} / 桌面档 ${TIER_DESKTOP}）`);
  }
  // 缩放锚点：宽 = 档位 − 4（bar 的左右各 2px 边框落在锚点之外），高 = 档位（边框不影响高度）
  const wantW = data.tier - 4;
  const want = ['zoom-in', 'zoom-out'];
  for (const k of want) {
    if (!c[k]) { fails.push(`${label}: 找不到控件 ${k}（页面没渲染出缩放控件？）`); continue; }
    const [w, h] = c[k].box;
    if (Math.abs(w - wantW) > TIER_TOLERANCE || Math.abs(h - data.tier) > TIER_TOLERANCE) {
      fails.push(`${label}: ${k} 是 ${w}×${h}，期望 ${wantW}×${data.tier}（--mid ${data.tier}，宽再减掉 bar 的左右各 2px 边框）`);
    }
    if (!c[k].offset) { fails.push(`${label}: ${k} 量不到字形`); continue; }
    const [dx, dy] = c[k].offset;
    if (Math.abs(dx) > TOLERANCE || Math.abs(dy) > TOLERANCE) {
      fails.push(`${label}: ${k} 的字形没居中，偏移 dx=${dx} dy=${dy}（display=${c[k].display} line-height=${c[k].lineHeight}）`);
    }
  }

  // 非空断言：选择器写错时 corners 会是空的，下面那圈重叠检查就静默失效了。
  // 这个坑真踩过（把 .leaflet-top.leaflet-left 写成了 .leaflet-topleft）。
  const tl = (data.corners || {}).topleft || [];
  if (tl.length < 2) {
    fails.push(`${label}: topleft 只找到 ${tl.length} 个控件，至少应有缩放控件 —— 角选择器是不是写错了？`);
  }

  // `.map-tools` 列底边 → 缩放控件顶边：必须正好是 Leaflet 自己的 10px 边距。
  // 「重叠」断言看不见间隙，所以静默的空白只能靠这条守。（只对探索页成立：只有它有 .map-tools）
  if (data.toolsGap !== null && data.toolsGap !== undefined) {
    const GAP = 10;
    if (Math.abs(data.toolsGap - GAP) > TOLERANCE) {
      fails.push(`${label}: 工具列到缩放控件之间有 ${data.toolsGap}px 间隙，期望 ${GAP}px —— ` +
        `--map-tools-h 与工具列的真实高度脱钩了（它必须 = 档位 × 2）`);
    }
  }

  // 同一个角里的控件不能互相压住
  for (const [corner, rects] of Object.entries(data.corners || {})) {
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const [ax, ay, ar, ab] = rects[i];
        const [bx, by, br, bb] = rects[j];
        const ox = Math.min(ar, br) - Math.max(ax, bx);
        const oy = Math.min(ab, bb) - Math.max(ay, by);
        if (ox > 0 && oy > 0) {
          fails.push(`${label}: ${corner} 里第 ${i} 个和第 ${j} 个控件重叠 ${ox}×${oy}px`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------- 主流程

(async () => {
  const mode = process.argv.includes('--selfcheck') ? 'selfcheck'
    : process.argv.includes('--snapshot') ? 'snapshot'
    : process.argv.includes('--compare') ? 'compare' : null;
  const argPath = (flag) => { const i = process.argv.indexOf(flag); return i > -1 ? process.argv[i + 1] : null; };
  if (!mode) { console.error('用法: --snapshot <out.json> | --compare <in.json> | --selfcheck'); process.exit(2); }

  const fs = require('fs');
  console.log(`环境: pointer: ${TOUCH ? 'coarse（--touch）' : 'fine（默认）'}，期望 --mid = ${TOUCH ? TIER_TOUCH : TIER_DESKTOP}px`);
  const browser = await firefox.launch({ headless: true });
  const results = {};
  const fails = [];

  try {
    for (const path of ['/explore.html', '/my-submissions.html']) {
      const { ctx, page, errs } = await openMap(browser, path);

      if (mode === 'selfcheck') {
        // 红检查：把缩放按钮的字形故意推偏，采样器必须报出来
        const before = await stableSample(page);
        await page.evaluate(() => {
          const a = document.querySelector('.leaflet-control-zoom-in');
          a.style.paddingTop = '30px';
        });
        const after = await page.evaluate(SAMPLE);
        const moved = JSON.stringify(before.data.controls['zoom-in']?.offset) !== JSON.stringify(after.controls['zoom-in']?.offset);
        console.log(`${moved ? 'PASS' : 'FAIL'} selfcheck ${path} 采样器看得见字形偏移`);
        if (!moved) fails.push(`${path}: selfcheck 没看见偏移 —— 后面的结果都不可信`);
        await ctx.close();
        continue;
      }

      const { data, settled } = await stableSample(page);
      if (!settled) fails.push(`${path}: 采样不稳定（10 次读数未收敛）`);
      if (errs.length) fails.push(`${path}: 页面 JS 报错 ${JSON.stringify(errs)}`);
      if (!data.hasMapPane) fails.push(`${path}: 地图没渲染出来（leaflet 没跑起来？）`);
      assertControls(path, data, fails);

      if (data.stylesheetOrder.length !== 2) {
        fails.push(`${path}: 期望 2 个样式表，实际 ${data.stylesheetOrder.length}`);
      } else if (data.stylesheetOrder[0] !== 'local/style.css' && data.stylesheetOrder[1] !== 'local/style.css') {
        fails.push(`${path}: 没找到本地 style.css`);
      } else if (data.stylesheetOrder[data.stylesheetOrder.length - 1] !== 'local/style.css') {
        fails.push(`${path}: style.css 不是最后一张样式表（顺序 ${data.stylesheetOrder.join(' -> ')}）—— leaflet 会反超我们的覆盖`);
      }

      // 放大按钮（只有 my-submissions 有）
      if (path.includes('my-submissions')) {
        if (!data.controls.expand) {
          fails.push(`${path}: 找不到 .map-expand-btn（地图放大按钮没渲染）`);
        } else {
          const [w, h] = data.controls.expand.box;
          if (Math.abs(w - data.tier) > TIER_TOLERANCE || Math.abs(h - data.tier) > TIER_TOLERANCE) {
            fails.push(`${path}: 放大按钮 ${w}×${h}，期望 ${data.tier}×${data.tier}（= --mid，与同列其它控件齐平）`);
          }
          const off = data.controls.expand.offset;
          if (off && (Math.abs(off[0]) > TOLERANCE || Math.abs(off[1]) > TOLERANCE)) {
            fails.push(`${path}: 放大按钮图标没居中，偏移 ${off}`);
          }
          const small = data.mapHeight;
          const beforeIcon = data.expandIcon;
          const beforeLabel = data.expandLabel;
          if (data.expandAria !== 'false') fails.push(`${path}: 初始 aria-expanded=${data.expandAria}，应为 'false'`);
          if (!beforeIcon || !beforeLabel) fails.push(`${path}: 初始图标或 aria-label 缺失`);
          await page.click('.map-expand-btn');
          await page.waitForTimeout(500);
          const grown = await page.evaluate(SAMPLE);
          if (!(grown.mapHeight > small)) {
            fails.push(`${path}: 点放大后地图没变高（${small} -> ${grown.mapHeight}）`);
          }
          if (!grown.expandPressed) fails.push(`${path}: 放大后没打上 is-large`);
          if (grown.expandAria !== 'true') fails.push(`${path}: 放大后 aria-expanded=${grown.expandAria}，应为 'true'`);
          if (grown.expandIcon === beforeIcon) fails.push(`${path}: 放大后图标没换（仍是 ${grown.expandIcon}）`);
          if (grown.expandLabel === beforeLabel) fails.push(`${path}: 放大后 aria-label 没换（仍是 ${grown.expandLabel}）`);
          if (grown.leafletSize && grown.domSize && grown.leafletSize[1] !== grown.domSize[1]) {
            fails.push(`${path}: 放大后 leaflet 内部尺寸 ${grown.leafletSize} ≠ DOM ${grown.domSize} —— 漏了 invalidateSize()`);
          }
          await page.click('.map-expand-btn');
          await page.waitForTimeout(500);
          const back = await page.evaluate(SAMPLE);
          if (Math.abs(back.mapHeight - small) > 2) fails.push(`${path}: 收回后没回到原高度（${small} -> ${back.mapHeight}）`);
          if (back.leafletSize && back.domSize && back.leafletSize[1] !== back.domSize[1]) {
            fails.push(`${path}: 收回后 leaflet 内部尺寸 ${back.leafletSize} ≠ DOM ${back.domSize}`);
          }

          // 窄屏：#my-map 在 max-width:600px 里有 height:50vh，放大规则必须压过它。
          // 这是「一条规则就够」这个判断真正会翻车的地方，宽屏测不到。
          await page.setViewportSize({ width: 500, height: 700 });
          await page.waitForTimeout(500);
          const narrowSmall = (await page.evaluate(SAMPLE)).mapHeight;
          await page.click('.map-expand-btn');
          await page.waitForTimeout(500);
          const narrowBig = await page.evaluate(SAMPLE);
          if (!(narrowBig.mapHeight > narrowSmall)) {
            fails.push(`${path}: 窄屏 500px 下放大无效（${narrowSmall} -> ${narrowBig.mapHeight}）—— .is-large 没压过 @media 里的 50vh`);
          }
          if (narrowBig.leafletSize && narrowBig.domSize && narrowBig.leafletSize[1] !== narrowBig.domSize[1]) {
            fails.push(`${path}: 窄屏放大后 leaflet 内部尺寸 ${narrowBig.leafletSize} ≠ DOM ${narrowBig.domSize}`);
          }
          await page.click('.map-expand-btn');
          await page.waitForTimeout(400);
          const narrowBack = await page.evaluate(SAMPLE);
          if (Math.abs(narrowBack.mapHeight - narrowSmall) > 2) {
            fails.push(`${path}: 窄屏收回后没回到原高度（${narrowSmall} -> ${narrowBack.mapHeight}）`);
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.waitForTimeout(400);

          // 放大要「两个方向都变」。只断言高度的话，宽度被 900px 卡死也照样全绿 ——
          // 这正是线上反馈的那个 bug：放大后只有上下变宽。
          await page.click('.map-expand-btn');
          await page.waitForTimeout(400);
          const mapWide = await page.evaluate(SAMPLE);
          if (!(mapWide.mainWidth > data.mainWidth)) {
            fails.push(`${path}: 放大后内容栏没变宽（${data.mainWidth} -> ${mapWide.mainWidth}），地图宽度仍被 900px 卡住`);
          }
          if (mapWide.mainWidth > 1400) {
            fails.push(`${path}: 放大后内容栏 ${mapWide.mainWidth}px 超过 1400 上限`);
          }

          // 上限只有在视口宽到会被 max-width 截住时才生效。1280 的视口下这一列本来就
          // 只有 1280，1400 那条永远碰不到 —— 得把视口撑到 1600 才测得到它。
          await page.setViewportSize({ width: 1600, height: 900 });
          await page.waitForTimeout(500);
          const wide = await page.evaluate(SAMPLE);
          if (wide.mainWidth !== 1400) {
            fails.push(`${path}: 1600px 视口下内容栏 ${wide.mainWidth}px，应为 1400（上限没生效或列溢出了）`);
          }
          const overflow = await page.evaluate(() => ({
            scrollW: document.documentElement.scrollWidth,
            clientW: document.documentElement.clientWidth,
            mapRight: Math.round(document.getElementById('my-map').getBoundingClientRect().right),
          }));
          if (overflow.scrollW > overflow.clientW) {
            fails.push(`${path}: 放大态出现横向溢出（scrollWidth ${overflow.scrollW} > clientWidth ${overflow.clientW}）`);
          }
          if (overflow.mapRight > overflow.clientW + 1) {
            fails.push(`${path}: 地图右边缘 ${overflow.mapRight} 超出视口 ${overflow.clientW}`);
          }
          await page.setViewportSize({ width: 1280, height: 900 });
          await page.waitForTimeout(400);

          // 放大态不得漏进列表视图：地图视图下列表本来是隐藏的，以前这个状态没有可见
          // 副作用，现在它会放宽 <main> —— 漏出去就是把列表卡片一起拉宽。
          await page.click('#view-tabs button[data-view="list"]');
          await page.waitForTimeout(500);
          const listView = await page.evaluate(SAMPLE);
          if (listView.mainWidth === null) {
            fails.push(`${path}: 列表视图下找不到 main.my-submissions`);
          } else if (Math.abs(listView.mainWidth - data.mainWidth) > 2) {
            fails.push(`${path}: 切到列表后内容栏仍是放宽的（${listView.mainWidth}，应回到 ${data.mainWidth}）—— 放大态漏进了列表视图`);
          }
          if (!listView.expandPressed) {
            fails.push(`${path}: 切到列表后地图的放大状态被重置了（切回来应该还是放大的）`);
          }

          await page.click('#view-tabs button[data-view="map"]');
          await page.waitForTimeout(500);
          const backToMap = await page.evaluate(SAMPLE);
          if (Math.abs(backToMap.mainWidth - mapWide.mainWidth) > 2) {
            fails.push(`${path}: 切回地图视图后内容栏没恢复放宽（${mapWide.mainWidth} -> ${backToMap.mainWidth}）`);
          }
          if (backToMap.leafletSize && backToMap.domSize && backToMap.leafletSize[1] !== backToMap.domSize[1]) {
            fails.push(`${path}: 视图来回切换后 leaflet 内部尺寸 ${backToMap.leafletSize} ≠ DOM ${backToMap.domSize} —— 隐藏期间尺寸被记成 0 了`);
          }
        }
      }

      results[path] = data;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  if (mode === 'snapshot') {
    fs.writeFileSync(argPath('--snapshot'), JSON.stringify(results, null, 2));
    console.log('-> ' + argPath('--snapshot'));
  }

  if (mode === 'compare') {
    const base = JSON.parse(fs.readFileSync(argPath('--compare'), 'utf8'));
    for (const [path, cur] of Object.entries(results)) {
      const before = base[path] || {};
      const diffs = [];
      const walk = (a, b, p) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
        if (isObj(a) && isObj(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], p ? p + '.' + k : k); return; }
        diffs.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      };
      walk(before, cur, '');
      if (diffs.length) {
        console.log(`FAIL ${path} 有 ${diffs.length} 处差异：`);
        diffs.forEach((d) => console.log('    ' + d));
        fails.push(`${path}: 与基线有差异`);
      } else {
        console.log(`PASS ${path} 与基线一致`);
      }
    }
  }

  console.log(mode === 'selfcheck' ? '\n== 红检查结束' : fails.length ? '\n== FAILURES: ' + fails.length : '\n== ALL PASS');
  fails.forEach((f) => console.log('  FAIL ' + f));
  process.exit(fails.length ? 1 : 0);
})();

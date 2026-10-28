// Playwright harness for the six-way independent reaction model (2026-10-04).
//
// Why this needs its own script. Three contracts here cannot be read off a stylesheet
// or a single API response:
//
//   1. Six types are FULLY INDEPENDENT (D1). The bug this guards against is the old
//      `mainGroup` mutual exclusion quietly coming back: activating one of
//      useful/useless/wrong would extinguish the other two. The optimistic update
//      is where that lives, and only an *optimistic-state* read catches it — see the
//      note below.
//   2. The icons are self-hosted Twemoji SVGs, not system emoji characters (D2/D4).
//      A regression that draws text emoji looks fine on one OS and wrong on another,
//      which is exactly what the homepage already decided against.
//   3. The reaction state is an ARRAY (`user_reactions`), not the old scalar. A
//      frontend left on the scalar reads `undefined` and silently never highlights.
//
// plus the backend half (checkBackend): the REAL api/reactions.js handler loaded in-process
// against a stubbed ./_lib/turso.js that records every SQL statement. It is the only place
// "POSTing a reaction issues ZERO DELETEs" and "the favorites branch (same file) is intact"
// are asserted directly — neither is observable over the browser path.
//
// ⚠️ The AC3 assertion below MUST read the OPTIMISTIC state, not the reconciled one.
// We learned this the hard way: an assertion that only checks "after both clicks the
// two buttons are lit" stays GREEN under the mutual-exclusion mutation, because the
// async server reply re-corrects the polluted optimistic state back to server truth.
// Such an assertion bites the *mock server*, not the frontend logic.
//
//   And it must watch the button that was NOT clicked. `applyState` (modal.js) skips
//   buttons carrying `is-animating`; the clicked button shows a ✓ for 600ms and its
//   class does not change in that window. The untouched button is not in the animation
//   window, so a mutual-exclusion branch that turns it off clears its highlight immediately.
//
//   Method: mock the write with ~1200ms latency → read at 350ms (optimistic) and again
//   after 1500ms (reconciled). 350ms sits inside "600ms animation not done, 1200ms reply
//   not back". Measured: the mutual-exclusion injection reddens all optimistic assertions
//   while the reconciled ones stay green (the latter is near-vacuous for AC3 — kept, but
//   never cited as AC3 evidence).
//
// RED CHECKS — verified red before this was trusted (`RED=<name> node scripts/test-reactions.js`):
//   exclusive → re-inject the mainGroup DELETE in submitReaction → AC3 optimistic assertions fail
//   emoji     → swap buildReactionIcon back to text emoji          → "six distinct SVGs" fails
//   scalar    → read `user_reaction` instead of `user_reactions`   → array/reconcile assertions fail
// Each mutation is applied to public/js/modal.js ON DISK, asserts it actually changed the
// file, and is restored byte-for-byte (`diff -q` against a pre-mutation backup) in a finally.
//
// Usage:
//   setsid nohup .../serve public -p 3999 &      # local static server on 3999
//   node scripts/test-reactions.js
//   BASE_URL=http://localhost:3999 node scripts/test-reactions.js
//   RED=exclusive BASE_URL=http://localhost:3999 node scripts/test-reactions.js
//   kill $(lsof -ti :3999)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { firefox } = require('playwright');
const { createClient } = require('@libsql/client');

const BASE = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/$/, '');
const RED = process.env.RED || '';
const MODAL = path.join(__dirname, '..', 'public', 'js', 'modal.js');
const BACKUP = path.join(os.tmpdir(), 'modal.js.reactions-restore-check');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) pass++; else fail++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra === undefined ? '' : '  ' + JSON.stringify(extra)));
}

// --- red-check mutations (on-disk, always restored) ------------------------------------------
const MUTATIONS = {
  // Put the old mutual exclusion back into submitReaction's optimistic block.
  exclusive(src) {
    const anchor = '  // Track latest state so the animation timeout can use the server-reconciled counts\n  var _latestState = newState;';
    const inject = '  var MAIN_GROUP = [\'useful\', \'useless\', \'wrong\'];\n'
      + '  if (MAIN_GROUP.indexOf(type) > -1) {\n'
      + '    MAIN_GROUP.forEach(function(g) { if (g !== type) newState[g].active = false; });\n'
      + '  }\n\n' + anchor;
    return src.includes(anchor) ? src.replace(anchor, inject) : src;
  },
  // Draw system emoji characters instead of the self-hosted Twemoji SVGs.
  emoji(src) {
    const from = `function buildReactionIcon(rt) {
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
}`;
    const to = `function buildReactionIcon(rt) {
  var EMOJI = { goat: '🐐', heart: '❤️', useful: '👍', useless: '👎', wrong: '❌', error: '🚧' };
  var el = document.createElement('span');
  el.className = 'modal__reaction-icon';
  el.textContent = EMOJI[rt.key] || '?';
  return el;
}`;
    return src.includes(from) ? src.replace(from, to) : src;
  },
  // Read the removed scalar field instead of the array (both render + reconcile sites).
  scalar(src) {
    const from = 'var mine = data.user_reactions || [];';
    const to = 'var mine = data.user_reaction ? [data.user_reaction] : [];';
    return src.split(from).join(to);
  },
};

// --- fixtures --------------------------------------------------------------------------------
const COUNTRIES = [
  { id: 'south-africa', name: 'South Africa', flag: 'za', bounds_sw: [-34.5, 17], bounds_ne: [-22.5, 32.5], active: 1, sort_order: 0 },
];

// Contributor card fixture: goat / useful / wrong are non-zero, heart / useless / error are 0.
const CARD_ROW = {
  id: 'card-1', name: 'A favorited region', description: 'Body', detailed_description: '',
  source_type: '', source_url: '', country_id: 'south-africa', scope: 'region',
  tags: [], geojson: { type: 'Polygon', coordinates: [] }, streetview: [], link: '',
  status: 'approved', created_at: '2026-01-05T00:00:00Z', reviewed_at: '', reject_reason: '',
  is_hidden: 0, user_id: 1, edit_target_id: null,
  goat_count: 5, heart_count: 0, useful_count: 12, useless_count: 0, wrong_count: 2, error_count: 0,
};
// All-zero row — the whole counts block must not render.
const CARD_ROW_EMPTY = Object.assign({}, CARD_ROW, {
  id: 'card-2', name: 'Fresh region', goat_count: 0, heart_count: 0, useful_count: 0,
  useless_count: 0, wrong_count: 0, error_count: 0,
});

const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// --- 1..7) explore modal: optimistic independence, SVG icons, array state ---------------------
async function checkExplore(browser) {
  const ctx = await browser.newContext();
  const mine = new Set();
  const counts = { goat: 3, heart: 8, useful: 14, useless: 2, wrong: 1, error: 0 };

  // Least-specific first — Playwright gives precedence to the LAST matching route.
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:')) return r.continue();
    return r.abort();
  });
  await ctx.route('**/api/reactions*', async (route) => {
    const req = route.request();
    if (req.method() === 'POST' || req.method() === 'DELETE') {
      const t = JSON.parse(req.postData() || '{}').type;
      if (req.method() === 'POST') { if (!mine.has(t)) { mine.add(t); counts[t] = (counts[t] || 0) + 1; } }
      else { if (mine.has(t)) { mine.delete(t); counts[t] = Math.max(0, (counts[t] || 0) - 1); } }
      await new Promise((r) => setTimeout(r, 1200));   // leave room for the optimistic window
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify(Object.assign({}, counts, { user_reactions: [...mine], authenticated: true, favorited: false })),
    });
  });

  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message));
  await p.goto(BASE + '/explore', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForFunction(() => typeof window._renderReactionRow === 'function'
    && Array.isArray(window.GEOGUIDE_REACTIONS), null, { timeout: 20000 });
  await p.evaluate(() => { window._csrfToken = 'test'; });

  await p.evaluate(() => {
    const c = document.createElement('div'); c.id = 'probe-row'; document.body.appendChild(c);
    window._renderReactionRow(c, 'r-test', {
      goat: 3, heart: 8, useful: 14, useless: 2, wrong: 1, error: 0,
      user_reactions: [], authenticated: true, favorited: false,
    });
  });

  // 1 + 2) six buttons, six distinct self-hosted SVGs, no text labels
  const shape = await p.evaluate(() => {
    const btns = [...document.querySelectorAll('#probe-row .modal__reaction-btn')];
    return {
      n: btns.length,
      srcs: btns.map((x) => { const i = x.querySelector('img'); return i ? i.getAttribute('src') : null; }),
      keys: btns.map((x) => (x.className.match(/modal__reaction-btn--(\w+)/) || [])[1]),
      texts: btns.map((x) => x.textContent),
    };
  });
  ok(shape.n === 6, 'AC1 反应条六个按钮', shape.n);
  ok(new Set(shape.srcs).size === 6 && shape.srcs.every((s) => /images\/twemoji\/.+\.svg/.test(s || '')),
    'AC1/D4 六个互不相同的自托管 Twemoji SVG（不是系统 emoji 字符）', shape.srcs);
  ok(JSON.stringify(shape.keys) === JSON.stringify(['goat', 'heart', 'useful', 'useless', 'wrong', 'error']),
    'key 顺序与 GEOGUIDE_REACTIONS 一致', shape.keys);
  ok(shape.texts.every((t) => !/[A-Za-z]{3,}/.test(t)), 'D2 按钮无文字 label', shape.texts);

  // 6) AC6 — a legacy row that only ever had `useful` still renders its count
  const legacy = await p.evaluate(() => {
    const c = document.createElement('div'); c.id = 'probe-legacy'; document.body.appendChild(c);
    window._renderReactionRow(c, 'r-legacy', {
      goat: 0, heart: 0, useful: 7, useless: 0, wrong: 0, error: 0,
      user_reactions: ['useful'], authenticated: true, favorited: false,
    });
    const btn = c.querySelector('.modal__reaction-btn--useful');
    return {
      count: btn.querySelector('.modal__reaction-count').textContent,
      active: btn.className.indexOf('is-active--useful') > -1,
    };
  });
  ok(legacy.count === '7' && legacy.active, 'AC6 只有 useful 的旧数据照常渲染出计数并高亮', legacy);

  // 7) guest: user_reactions [] → nothing highlighted, no error
  const guest = await p.evaluate(() => {
    const c = document.createElement('div'); c.id = 'probe-guest'; document.body.appendChild(c);
    window._renderReactionRow(c, 'r-guest', {
      goat: 0, heart: 0, useful: 0, useless: 0, wrong: 0, error: 0,
      user_reactions: [], authenticated: false, favorited: false,
    });
    const btns = [...c.querySelectorAll('.modal__reaction-btn')];
    return { n: btns.length, active: btns.filter((b) => /is-active--/.test(b.className)).length };
  });
  ok(guest.n === 6 && guest.active === 0, '未登录 user_reactions: [] → 六项都不高亮', guest);

  const readActive = () => p.evaluate(() => {
    const o = {};
    document.querySelectorAll('#probe-row .modal__reaction-btn').forEach((x) => {
      const k = (x.className.match(/modal__reaction-btn--(\w+)/) || [])[1];
      o[k] = x.className.indexOf('is-active--' + k) > -1;
    });
    return o;
  });

  // Two-phase read: 350ms lands inside "600ms animation running, 1200ms reply not back".
  const click = async (k) => {
    await p.click('#probe-row .modal__reaction-btn--' + k);
    await p.waitForTimeout(350);
    const optimistic = await readActive();
    await p.waitForTimeout(1500);
    return { optimistic, reconciled: await readActive() };
  };

  const r1 = await click('useful');
  ok(r1.reconciled.useful, '点 useful → useful 激活', r1.reconciled);

  const r2 = await click('useless');
  // ★ AC3 — optimistic: the untouched button (useful) must STILL be lit this instant.
  ok(r2.optimistic.useful === true,
    '★AC3 乐观态★ 点 useless 时 useful 当场仍亮（有互斥分支的话这里立刻变 false）', r2.optimistic);
  ok(r2.reconciled.useful && r2.reconciled.useless,
    '★AC3 对账态★ 服务端返回后两者同时亮（数组表达得了，标量表达不了）', r2.reconciled);

  const r3 = await click('wrong');
  ok(r3.optimistic.useful && r3.optimistic.useless,
    '★AC3 乐观态★ 点第三项时前两项都还亮着', r3.optimistic);
  ok(r3.reconciled.useful && r3.reconciled.useless && r3.reconciled.wrong,
    '★AC3 对账态★ 三项同时亮', r3.reconciled);

  // 5) cancelling one type touches ONLY that type
  const r4 = await click('useful');
  ok(r4.optimistic.useless === true && r4.optimistic.wrong === true,
    '取消 useful 时其余两项不受影响（乐观态）', r4.optimistic);
  ok(!r4.reconciled.useful && r4.reconciled.useless && r4.reconciled.wrong,
    '取消 useful 只熄灭它自己（对账态）', r4.reconciled);

  // 4) server truth is an array, and re-rendering from it reproduces the same actives
  const srv = await p.evaluate(() => fetch('/api/reactions?region_id=r-test').then((r) => r.json()));
  ok(JSON.stringify(srv.user_reactions.slice().sort()) === JSON.stringify(['useless', 'wrong']),
    '服务端 user_reactions 是数组且与界面一致', srv.user_reactions);
  const rerender = await p.evaluate((data) => {
    const c = document.createElement('div'); c.id = 'probe-refetch'; document.body.appendChild(c);
    window._renderReactionRow(c, 'r-refetch', data);
    return [...c.querySelectorAll('.modal__reaction-btn')]
      .filter((b) => /is-active--/.test(b.className))
      .map((b) => (b.className.match(/modal__reaction-btn--(\w+)/) || [])[1]);
  }, srv);
  ok(JSON.stringify(rerender.slice().sort()) === JSON.stringify(['useless', 'wrong']),
    'AC3 重新拉取服务端数据后同样的两项仍亮', rerender);

  ok(errs.length === 0, '无 JS 报错', errs);
  await ctx.close();
}

// --- 7b) reaction bar layout: one row of six, wrap (never overflow) when it doesn't fit --------
//
// 2026-10-04: 容器从 grid(1fr 1fr 1fr) 换成 flex-wrap。换的原因不是审美 —— `1fr` 的最小尺寸
// 是 min-content，按钮挤到装不下时 grid **不换行而是捅出容器**。实测 768px 视口（左栏内容宽
// 148px）旧规则溢出 4.6 / 27.5 / 50.4px（一位数 / 两位数 / 三位数计数）。
//
// 所以这里断言的是**几何**，不是样式表里的字面量：一个 `display: flex` 的字符串断言既能被
// `flex-direction: column` 满足、也看不见「6 个是不是真的一行」。渲染进真实的
// .modal > .modal__body > .modal__left（宽度 = 70vw × 38% − 56px 内边距），量按钮的实坐标。
async function checkReactionBarLayout(browser) {
  const COUNTS = [ // 一位数 / 两位数 / 三位数三档，位数多的先撞墙
    { label: '一位数', c: { goat: 3, heart: 8, useful: 4, useless: 2, wrong: 1, error: 7 } },
    { label: '两位数', c: { goat: 31, heart: 88, useful: 14, useless: 22, wrong: 11, error: 47 } },
    { label: '三位数', c: { goat: 131, heart: 188, useful: 114, useless: 122, wrong: 111, error: 147 } },
  ];
  // [viewport, 期望一行放得下几位数的计数] —— 实测表见 style.css 的 .modal__reactions 注释
  const CASES = [[1920, 3], [1440, 2], [1280, 1], [768, 0]];

  for (const [w, oneRowUpTo] of CASES) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 900 } });
    await ctx.route('**/*', (r) => {
      const u = r.request().url();
      if (u.startsWith(BASE) || u.startsWith('data:')) return r.continue();
      return r.abort();
    });
    await ctx.route('**/api/**', (r) => r.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ user_reactions: [], authenticated: false, regions: [] }),
    }));
    const p = await ctx.newPage();
    await p.goto(BASE + '/explore', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await p.waitForFunction(() => typeof window._renderReactionRow === 'function', null, { timeout: 20000 });

    for (let i = 0; i < COUNTS.length; i++) {
      const { label, c } = COUNTS[i];
      const m = await p.evaluate((counts) => {
        let host = document.getElementById('probe-modal');
        if (host) host.remove();
        host = document.createElement('div');
        host.id = 'probe-modal';
        host.className = 'modal is-open';
        host.style.transform = 'none'; host.style.top = '0'; host.style.left = '0';
        host.innerHTML = '<div class="modal__body"><div class="modal__left">'
          + '<div class="modal__desc">Left column filler text.</div><div id="probe-row"></div>'
          + '</div><div class="modal__right"></div></div>';
        document.body.appendChild(host);

        const row = host.querySelector('#probe-row');
        window._renderReactionRow(row, 'r-layout', Object.assign({}, counts, { user_reactions: [], authenticated: true }));
        row.className = 'modal__reactions';                    // 与 modal.js:987 的恢复处一致

        const cs = getComputedStyle(row);
        const btns = [...row.querySelectorAll('.modal__reaction-btn')];
        const top = btns[0].getBoundingClientRect().top;
        const perRow = {};
        btns.forEach((b) => { const t = Math.round(b.getBoundingClientRect().top - top); perRow[t] = (perRow[t] || 0) + 1; });
        const r = row.getBoundingClientRect();
        return {
          display: cs.display, wrap: cs.flexWrap,
          rows: Object.values(perRow),
          // 正数 = 有按钮捅出容器（旧 grid 的病症）；负数 = 右侧还剩多少没占满
          spill: +(btns[btns.length - 1].getBoundingClientRect().right - r.right).toFixed(1),
          container: +r.width.toFixed(1),
          goatTitle: (row.querySelector('.modal__reaction-btn--goat') || {}).title,
        };
      }, c);

      ok(m.display === 'flex' && m.wrap === 'wrap', `响应条容器是 flex + wrap（${w}px）`, { display: m.display, wrap: m.wrap });
      ok(m.spill <= 0, `★核心★ ${w}px / ${label}计数：没有按钮捅出容器（旧 grid 在 768px 会溢出 50px）`, m.spill);
      if (i < oneRowUpTo) {
        ok(m.rows.length === 1 && m.rows[0] === 6, `★核心★ ${w}px / ${label}计数：六个按钮排在**一行**`, m.rows);
      }
      if (i === 0) {
        ok(m.goatTitle === 'GOAT', 'goat 的悬浮提示就是字面的 GOAT', m.goatTitle);
      }
    }
    await ctx.close();
  }
}

// --- 8) review page flagged badges share the same icon source (R3 / AC5) ----------------------
async function checkReviewBadge(browser) {
  const ctx = await browser.newContext();
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:')) return r.continue();
    return r.abort();
  });
  const p = await ctx.newPage();
  await p.goto(BASE + '/review.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForFunction(() => typeof window.flaggedBadgePart === 'function'
    && typeof window.reactionIconSrc === 'function', null, { timeout: 20000 });
  const rev = await p.evaluate(() => ({
    u: flaggedBadgePart('useless', 7),
    w: flaggedBadgePart('wrong', 6),
    e: flaggedBadgePart('error', 1),
    su: reactionIconSrc('useless'), sw: reactionIconSrc('wrong'), se: reactionIconSrc('error'),
  }));
  ok(rev.u.indexOf(rev.su) > -1 && /images\/twemoji\/1f44e\.svg/.test(rev.u),
    'AC5 审核页 useless 徽章用探索弹窗同一份 Twemoji 图标', rev.u);
  ok(rev.w.indexOf(rev.sw) > -1, 'AC5 审核页 wrong 徽章同源', rev.w);
  ok(rev.e.indexOf(rev.se) > -1, 'AC5 审核页 error 徽章同源', rev.e);
  ok(!/[👍👎❌⚠️🚧🐐❤️]/.test(rev.u + rev.w + rev.e), 'AC5 徽章里没有硬编码的文字 emoji');
  // The icon is decorative (alt="" aria-hidden); without a text alternative the badge is just a
  // bare number to a screen reader. Each part must carry role="img" + aria-label like the cards.
  ok(/role="img"[^>]*aria-label="7 Not Useful"/.test(rev.u)
    && /role="img"[^>]*aria-label="6 Improper"/.test(rev.w)
    && /role="img"[^>]*aria-label="1 Error"/.test(rev.e),
    'AC5 flagged 徽章给读屏器保留了含义（role=img + aria-label）', rev.u);
  await ctx.close();
}

// --- 9) contributor card renders icon+count for non-zero types only (D6) ---------------------
async function checkContributorCards(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:')) return r.continue();
    return r.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
  });
  await ctx.route(/\/api\/auth/, (r) => r.fulfill(j({ user: { id: 1, username: 'probe' } })));
  await ctx.route(/\/api\/pageview/, (r) => r.fulfill(j({ ok: true })));
  await ctx.route(/\/api\/countries/, (r) => r.fulfill(j({ countries: COUNTRIES })));
  await ctx.route(/\/api\/user-submissions/, (r) => {
    const req = r.request();
    if (req.method() === 'POST') return r.fulfill(j({ success: true }));
    const u = new URL(req.url());
    if (u.searchParams.get('action') === 'countries') return r.fulfill(j({ countries: COUNTRIES }));
    return r.fulfill(j({ submissions: [CARD_ROW, CARD_ROW_EMPTY], total: 2, page: 1, pageSize: 18 }));
  });

  const p = await ctx.newPage();
  await p.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await p.waitForSelector('#my-results .review-item', { timeout: 15000 });
  await p.waitForTimeout(600);

  const cards = await p.evaluate(() => [...document.querySelectorAll('#my-results .review-item')].map((c) => {
    const wrap = c.querySelector('.review-item__counts');
    return {
      has: !!wrap,
      keys: wrap ? [...wrap.querySelectorAll('.reaction-count')]
        .map((x) => (x.className.match(/reaction-count--(\w+)/) || [])[1]) : null,
      srcs: wrap ? [...wrap.querySelectorAll('.reaction-count img')].map((x) => x.getAttribute('src')) : null,
      aria: wrap ? [...wrap.querySelectorAll('.reaction-count')].map((x) => x.getAttribute('aria-label')) : null,
    };
  }));
  ok(cards.length === 2, '投稿人卡片渲染两张', cards.length);
  ok(JSON.stringify(cards[0].keys) === JSON.stringify(['goat', 'useful', 'wrong']),
    'D6 卡片只渲染非零项（goat/useful/wrong；heart/useless/error 为 0 不出现）', cards[0].keys);
  ok(cards[0].srcs.every((s) => /images\/twemoji\/.+\.svg/.test(s || '')),
    'D6 卡片计数用自托管 Twemoji SVG', cards[0].srcs);
  ok(JSON.stringify(cards[0].aria) === JSON.stringify(['5 GOAT', '12 Useful', '2 Improper']),
    'D6 每格 role=img + aria-label 交代含义', cards[0].aria);
  ok(cards[1].has === false, '六项全零时整块计数行不渲染', cards[1]);
  await ctx.close();
}

// --- 10) backend handler, in-process -----------------------------------------------------------
// api/reactions.js cannot be reached over HTTP in the sandbox, so load the REAL handler with a
// stubbed ./_lib/turso.js that records every SQL statement (same in-process-handler shape the
// export test uses). This is the only place two contracts are directly checkable:
//   - the ★ core ★ property: POSTing a reaction issues ZERO DELETE statements (mutual exclusion
//     is gone at the write path, not just in the optimistic UI);
//   - the favorites branch, which shares this file, still inserts/reads correctly — the refactor
//     touched the same module and could have broken it silently.
async function checkBackend() {
  const tursoPath = require.resolve(path.join(__dirname, '..', 'api', '_lib', 'turso.js'));
  const recorded = [];
  let currentUser = { id: 'u1' };
  const captureFav = { sql: null };   // fill with the favorites-list SQL when seen
  const favorites = [];
  const rows = [];                    // { region, user, type }

  const stub = {
    ensureSchema: async () => {},
    cleanupTrash: async () => {},
    checkCsrf: () => true,
    checkRateLimit: async () => false,
    getSessionUser: async () => currentUser,
    tursoFetch: async (sql, args) => {
      recorded.push(sql);
      if (/FROM favorites f JOIN/.test(sql)) captureFav.sql = sql;
      if (/INSERT INTO favorites/.test(sql)) { favorites.push({ r: args[0], u: args[1] }); return { rows: [], cols: [] }; }
      if (/SELECT status, is_deleted, is_hidden FROM submissions/.test(sql)) {
        return { cols: [{ name: 'status' }, { name: 'is_deleted' }, { name: 'is_hidden' }],
                 rows: [[{ value: 'approved' }, { value: 0 }, { value: 0 }]] };
      }
      if (/ALTER TABLE/.test(sql)) { throw new Error('duplicate column'); }
      if (/SELECT COUNT\(\*\) as cnt FROM reactions WHERE user_id/.test(sql)) return { cols: [{ name: 'cnt' }], rows: [[{ value: 0 }]] };
      return { rows: [], cols: [] };
    },
    tursoBatch: async (queries) => {
      queries.forEach((q) => recorded.push(q.sql));
      return queries.map((q) => {
        if (/INSERT OR REPLACE INTO reactions/.test(q.sql)) {
          const [region, user, type] = q.args;
          if (!rows.some((x) => x.region === region && x.user === user && x.type === type)) rows.push({ region, user, type });
          return { rows: [], cols: [] };
        }
        if (/DELETE FROM reactions/.test(q.sql)) {
          const [region, user, type] = q.args;
          for (let i = rows.length - 1; i >= 0; i--) if (rows[i].region === region && rows[i].user === user && rows[i].type === type) rows.splice(i, 1);
          return { rows: [], cols: [] };
        }
        if (/SELECT type, COUNT\(\*\) as cnt/.test(q.sql)) {
          const counts = {};
          rows.filter((x) => x.region === q.args[0]).forEach((x) => { counts[x.type] = (counts[x.type] || 0) + 1; });
          return { cols: [{ name: 'type' }, { name: 'cnt' }], rows: Object.keys(counts).map((t) => [{ value: t }, { value: counts[t] }]) };
        }
        if (/SELECT type FROM reactions WHERE region_id = \? AND user_id = \?/.test(q.sql)) {
          return { cols: [{ name: 'type' }], rows: rows.filter((x) => x.region === q.args[0] && x.user === q.args[1]).map((x) => [{ value: x.type }]) };
        }
        return { rows: [], cols: [] };
      });
    },
  };
  require.cache[tursoPath] = { id: tursoPath, filename: tursoPath, loaded: true, exports: stub };
  const handler = require(path.join(__dirname, '..', 'api', 'reactions.js'));
  const newRes = () => ({ _status: 0, _json: null, status(c) { this._status = c; return this; }, json(j) { this._json = j; return this; } });
  const calls = () => recorded.splice(0);   // drain the statement log

  let res = newRes();
  await handler({ method: 'POST', body: { region_id: 'r1', type: 'useful' }, query: {}, headers: {} }, res);
  ok(res._status === 200 && res._json.useful === 1 && Array.isArray(res._json.user_reactions)
    && res._json.user_reactions.indexOf('useful') > -1, '后端 POST useful → 200、计数 1、user_reactions 是数组', res._json);
  ok(Object.keys(res._json).sort().join(',') === 'error,goat,heart,useful,useless,user_reactions,wrong',
    '后端响应恰为六个计数键 + user_reactions（无 user_reaction/user_error）', Object.keys(res._json));
  ok(!calls().some((s) => /DELETE/.test(s)), '★后端核心★ POST useful 发出 0 条 DELETE（写路径无互斥）');

  res = newRes();
  await handler({ method: 'POST', body: { region_id: 'r1', type: 'useless' }, query: {}, headers: {} }, res);
  ok(!calls().some((s) => /DELETE/.test(s)) && res._json.useful === 1 && res._json.useless === 1,
    'useful 已激活时 POST useless 也不发 DELETE，两者计数并存', res._json);

  res = newRes();
  await handler({ method: 'POST', body: { region_id: 'r1', type: 'bogus' }, query: {}, headers: {} }, res);
  ok(res._status === 400 && /goat, heart, useful, useless, wrong, or error/.test(res._json.error),
    '非法 type → 400，文案列出六个', res._json);

  res = newRes();
  await handler({ method: 'GET', query: { region_id: 'r1' }, headers: {} }, res);
  ok(res._status === 200 && res._json.goat === 0 && res._json.heart === 0 && res._json.useful === 1
    && res._json.useless === 1 && res._json.wrong === 0 && res._json.error === 0,
    'GET region 返回六个平铺计数键', res._json);
  ok(Array.isArray(res._json.user_reactions) && res._json.favorited === false,
    'GET region 带 user_reactions 数组与 favorited', res._json);

  currentUser = null;
  res = newRes();
  await handler({ method: 'GET', query: { action: 'favorites' }, headers: {} }, res);
  ok(res._status === 401, '收藏列表未登录 → 401（仍为登录私有）', res._json);
  currentUser = { id: 'u1' };

  res = newRes();
  await handler({ method: 'POST', body: { action: 'favorite', region_id: 'r1' }, query: {}, headers: {} }, res);
  ok(res._status === 200 && res._json.favorited === true && favorites.length === 1,
    '收藏分支未被重构伤到：POST favorite 写入并返回 favorited=true', res._json);

  calls(); res = newRes();
  await handler({ method: 'GET', query: { action: 'favorites' }, headers: {} }, res);
  ok(['goat', 'heart', 'useful', 'useless', 'wrong', 'error'].every((t) =>
    captureFav.sql && captureFav.sql.indexOf("'" + t + "'") > -1 && captureFav.sql.indexOf(t + '_count') > -1),
    '收藏列表标量子查询覆盖全部六项计数', captureFav.sql);
  ok(res._status === 200 && Array.isArray(res._json.regions), '收藏列表返回 regions 数组', res._json);

  // --- action=top: 首页 Most Useful 的入场券 -----------------------------------
  // 「goat / heart / useful 任一 >= 2」是整个行为，全在一条 HAVING 里。**跑真 SQLite，
  // 不 grep 字符串** —— 一条 `indexOf(">= 2")` 对旧的「只算 useful」版本同样为真，
  // 那正是这段要挡回的回归。SQL 也不是本文件里抄的一份：从真 handler 发出的语句里捞，
  // 抄一份就等于给「改了一处另一处没改」留门。
  calls();
  res = newRes();
  await handler({ method: 'GET', query: { action: 'top' }, headers: {} }, res);
  const topSql = recorded.filter((s) => /FROM reactions r JOIN submissions s/.test(s)).pop();
  ok(!!topSql, 'action=top 发出了聚合语句', topSql);
  if (topSql) await checkTopMeta(topSql);
}

// 真 SQLite（@libsql/client 本地文件库）跑 action=top 那条语句。夹具覆盖每一种入场/排除理由。
async function checkTopMeta(sql) {
  const file = path.join(os.tmpdir(), 'geoguide-top-meta-' + process.pid + '.db');
  const db = createClient({ url: 'file:' + file });
  try {
    await db.execute('CREATE TABLE submissions (id TEXT PRIMARY KEY, name TEXT, country_id TEXT, status TEXT, is_deleted INTEGER, is_hidden INTEGER)');
    await db.execute('CREATE TABLE reactions (region_id TEXT, user_id TEXT, type TEXT)');
    const sub = (id, name, status, del, hid) =>
      db.execute({ sql: 'INSERT INTO submissions VALUES (?,?,?,?,?,?)', args: [id, name, 'c-' + id, status, del, hid] });
    const rx = (region, user, type) =>
      db.execute({ sql: 'INSERT INTO reactions VALUES (?,?,?)', args: [region, user, type] });

    await sub('A', 'Two goats', 'approved', 0, 0);      // 只靠 goat 入场
    await sub('B', 'Two hearts', 'approved', 0, 0);     // 只靠 heart 入场
    await sub('C', 'One useful', 'approved', 0, 0);     // useful=1 —— 不够门槛
    await sub('D', 'Hidden goats', 'approved', 0, 1);   // 达标但 is_hidden
    await sub('E', 'Pending hearts', 'pending', 0, 0);  // 达标但未批准
    await sub('F', 'Mixed sum six', 'approved', 0, 0);  // 1+2+3，靠 heart/useful 入场
    await sub('G', 'Negatives only', 'approved', 0, 0); // 全是负向反应
    await rx('A', 'u1', 'goat'); await rx('A', 'u2', 'goat');
    await rx('B', 'u1', 'heart'); await rx('B', 'u2', 'heart');
    await rx('C', 'u1', 'useful');
    await rx('D', 'u1', 'goat'); await rx('D', 'u2', 'goat');
    await rx('E', 'u1', 'heart'); await rx('E', 'u2', 'heart');
    await rx('F', 'u1', 'goat'); await rx('F', 'u2', 'heart'); await rx('F', 'u3', 'heart');
    await rx('F', 'u4', 'useful'); await rx('F', 'u5', 'useful'); await rx('F', 'u6', 'useful');
    await rx('G', 'u1', 'useless'); await rx('G', 'u2', 'wrong'); await rx('G', 'u3', 'error');

    let rs;
    try { rs = await db.execute(sql); }
    catch (e) { ok(false, 'action=top 的 SQL 能被 SQLite 执行', e.message); return; }

    const rows = rs.rows;
    const ids = rows.map((r) => r.region_id);
    const sum = (r) => Number(r.goat_count) + Number(r.heart_count) + Number(r.useful_count);
    const f = rows.find((r) => r.region_id === 'F');

    ok(ids.includes('A'), '★核心★ 只有 goat >= 2 的地区能上首页', ids);
    ok(ids.includes('B'), '★核心★ 只有 heart >= 2 的地区能上首页', ids);
    ok(!ids.includes('C'), 'useful 只有 1 的地区仍被门槛挡掉', ids);
    ok(!ids.includes('D') && !ids.includes('E'), '达标但 hidden / 未批准的地区不上榜', ids);
    ok(!ids.includes('G'), 'useless/wrong/error 再多也不入场（负向反应不是正向信号）', ids);
    ok(!!f && Number(f.goat_count) === 1 && Number(f.heart_count) === 2 && Number(f.useful_count) === 3,
      '三项计数分别返回，且 goat=1 的项不会把 heart/useful 的达标顶掉', f);
    ok(rows.every((r, i) => i === 0 || sum(rows[i - 1]) >= sum(r)), '按三项之和降序',
      rows.map((r) => r.region_id + ':' + sum(r)));
    ok(rows.find((r) => r.region_id === 'A').name === 'Two goats', '返回地区名（卡片标题用）', rows[0]);
  } finally {
    try { await db.close(); } catch (e) { /* ignore */ }
    try { fs.unlinkSync(file); } catch (e) { /* ignore */ }
  }
}

(async () => {
  const original = fs.readFileSync(MODAL, 'utf8');
  let mutated = original;
  if (RED) {
    const apply = MUTATIONS[RED];
    if (!apply) { console.error('unknown RED=' + RED + ' (expected exclusive|emoji|scalar)'); process.exitCode = 2; return; }
    mutated = apply(original);
    if (mutated === original) {
      console.error('MUTATION ' + RED + ' did not change modal.js — anchor pattern not found (stale red check)');
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(BACKUP, original);
    fs.writeFileSync(MODAL, mutated);
    console.log('!! RED=' + RED + ' — modal.js mutated on disk (' + (mutated.length - original.length) + ' byte delta)\n');
  }

  const browser = await firefox.launch({ headless: true });
  try {
    // Backend contract first — node-only, independent of the browser. Inside the try so a
    // throw still hits the RED-mode restore in the finally.
    await checkBackend();
    await checkExplore(browser);
    await checkReactionBarLayout(browser);
    await checkReviewBadge(browser);
    await checkContributorCards(browser);
  } finally {
    await browser.close();
    if (RED) {
      fs.writeFileSync(MODAL, original);
      try {
        cp.execSync('diff -q ' + JSON.stringify(BACKUP) + ' ' + JSON.stringify(MODAL));
        console.log('\nRESTORED ' + RED + ': modal.js byte-identical to the pre-mutation backup (diff -q clean)');
      } catch (e) {
        console.error('\nRESTORE FAILED: modal.js differs from the pre-mutation backup');
        process.exitCode = 1;
      }
    }
  }

  console.log('\n' + (fail === 0 ? '== ALL PASS (' + pass + ')' : '== ' + fail + ' FAILED, ' + pass + ' passed'));
  if (fail !== 0) process.exitCode = 1;
})();

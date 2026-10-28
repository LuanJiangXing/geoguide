// Playwright harness for the homepage "Recent Updates" All | Mine filter.
//
// Why this needs its own script: the section has five distinct states, and four of them are
// invisible to `test-style-parity.js` because they only differ in WHICH nodes exist:
//
//   All                     → up to 5 site-wide items, each carrying "by <user>"
//   Mine + logged out       → login gate replaces the list
//   Mine + 0 approved       → "No approved submissions yet. (Share your META~)"
//   Mine + 1 country, ≤3    → the list, plus the "one country so far" nudge
//   Mine + everything else  → up to 5 of the user's own items, NO "by <user>"
//
// Two of those are easy to get subtly wrong in ways that still render something plausible:
// filtering without matching user_id (Mine silently shows everyone), and leaving the nudge
// unguarded (it fires for a 7-item/3-country contributor, where its premise is false).
//
// RED CHECKS — verified red before this was trusted (`RED=<name> node scripts/test-recent-filter.js`):
//   nofilter → drop `s.user_id === user.id`       -> "Mine 只列自己的条目" fails (7 assertions total)
//   nonudge  → widen `source.length <= 3` to 99   -> "5 条 1 个国家时不出鼓励语" fails
//   nogate   → force `recentGate.hidden = true`   -> "未登录点 Mine 出现登录提示" fails
// Each mutation asserts it actually applied, so a stale pattern can't pass as a green red-check.
//
// The nonudge fixture is deliberate: the ≤3 guard only has an observable effect on a contributor
// with MORE than 3 items in a single country, so `u4` (5 items, 1 country) is the case that
// discriminates. Without it, widening the guard changes nothing and the red check stays green —
// which is how a vacuous assertion hides.
//
// Usage: node scripts/test-recent-filter.js
//        BASE_URL=http://localhost:3999 node scripts/test-recent-filter.js
//        RED=nofilter BASE_URL=http://localhost:3999 node scripts/test-recent-filter.js
'use strict';

const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const RED = process.env.RED || '';
const INDEX_PATH = path.join(__dirname, '..', 'public', 'index.html');

// --- fixtures -----------------------------------------------------------------------------
// 14 approved submissions, strictly descending created_at, interleaved across contributors so
// that All mode's top 5 is a genuine mix rather than one user's block.
//   u1 = 7 items over 3 countries → cap + no nudge
//   u2 = 2 items in 1 country     → nudge + "fewer than 5 shows only that many"
//   u3 = 0 items                  → the empty nudge
//   u4 = 5 items in 1 country     → filler, so All ≠ Mine for u1
const PLAN = [
  ['u4', 'turkey'], ['u1', 'canada'], ['u2', 'canada'], ['u1', 'turkey'], ['u4', 'turkey'],
  ['u1', 'canada'], ['u2', 'canada'], ['u4', 'turkey'], ['u1', 'paraguay'], ['u1', 'canada'],
  ['u4', 'turkey'], ['u1', 'paraguay'], ['u4', 'turkey'], ['u1', 'turkey'],
];
const NAMES = { u1: 'Alice', u2: 'Bob', u3: 'Carol', u4: 'Dave' };

// created_at 与 first_approved_at 刻意排成**相反**的方向，且月份不同（7 月 vs 9 月）：
// 只要首页的日期还读的是 created_at，断言里那个 "Sep …" 就会变成 "Jul …"，一眼能看出来。
const SUBMISSIONS = PLAN.map(([uid, country], i) => ({
  id: 's' + i,
  name: 'Region ' + i,
  region: country,
  user_id: uid,
  submitted_by: NAMES[uid],
  created_at: '2026-07-' + String(1 + i).padStart(2, '0') + 'T00:00:00Z',
  first_approved_at: '2026-09-' + String(20 - i).padStart(2, '0') + 'T00:00:00Z',
}));

const ME = { u1: 'alice', u2: 'bob', u3: 'carol', u4: 'dave' };

// Which submission ids belong to whom, derived from PLAN so the two can't drift apart.
const idsOf = (uid) => PLAN.map(([u], i) => (u === uid ? 's' + i : null)).filter(Boolean);

// A non-empty country list is required: `utils.js:41` throws on an empty one by design, and the
// resulting console error would make the "no JS errors" assertion fail for a fixture reason.
const COUNTRIES = {
  countries: ['canada', 'turkey', 'paraguay'].map((id, i) => ({
    id, name: id.charAt(0).toUpperCase() + id.slice(1), flag: id.slice(0, 2),
    bounds_sw: [0, 0], bounds_ne: [1, 1], active: true, sort_order: i, region_count: 1,
  })),
};

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// --- red-check mutation ---------------------------------------------------------------------
let indexBody = null;
if (RED) {
  const original = fs.readFileSync(INDEX_PATH, 'utf8');
  const swaps = {
    nofilter: ['s.user_id === user.id', 'true'],
    nonudge: ['if (mine && source.length <= 3) {', 'if (mine && source.length <= 99) {'],
    nogate: ['recentGate.hidden = !(mine && !user);', 'recentGate.hidden = true;'],
  };
  const swap = swaps[RED];
  if (!swap) throw new Error('unknown RED: ' + RED);
  indexBody = original.replace(swap[0], swap[1]);
  if (indexBody === original) throw new Error('RED=' + RED + ' did not apply — pattern not found');
  console.log('!! RED=' + RED + ' — serving a mutated index.html\n');
}

async function openPage(browser, meUser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // Least-specific FIRST — Playwright gives precedence to the LAST matching route.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await ctx.route('**/api/auth*', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ user: meUser ? { id: meUser, username: ME[meUser], avatar_url: '' } : null }),
  }));
  await ctx.route('**/api/countries*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(COUNTRIES) }));
  await ctx.route('**/api/reactions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"regions":[]}' }));
  await ctx.route('**/api/submissions*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUBMISSIONS) }));
  if (indexBody !== null) {
    await ctx.route('**/index.html', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: indexBody }));
  }
  const page = await ctx.newPage();
  const errs = [];
  const reqUrls = [];
  page.on('request', (r) => { if (r.url().indexOf('/api/submissions') !== -1) reqUrls.push(r.url()); });
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/world\.svg|flagcdn|favicon/i.test(m.text())) errs.push('console: ' + m.text().slice(0, 140));
  });
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('#recent-filter-all', { state: 'visible', timeout: 15000 });
  await page.waitForTimeout(600);
  return { ctx, page, errs, reqUrls };
}

const SNAP = () => {
  const vis = (id) => { const el = document.getElementById(id); return el && !el.hidden; };
  const items = Array.prototype.map.call(document.querySelectorAll('#recent-list .recent-update-item'), (a) => ({
    text: a.textContent,
    by: !!Array.prototype.some.call(a.querySelectorAll('span'), (s) => /^by /.test(s.textContent)),
    href: a.getAttribute('href'),
    date: (a.querySelector('.recent-update-item__date') || {}).textContent || '',
  }));
  const note = document.getElementById('recent-note');
  return {
    items,
    gate: vis('recent-gate'),
    gateHref: (document.querySelector('#recent-gate a') || {}).href || '',
    gateText: (document.querySelector('#recent-gate p') || {}).textContent || '',
    note: vis('recent-note'),
    noteText: (document.getElementById('recent-note-text') || {}).textContent || '',
    noteLink: (document.getElementById('recent-note-link') || {}).textContent || '',
    noteHref: (document.getElementById('recent-note-link') || {}).getAttribute
      ? document.getElementById('recent-note-link').getAttribute('href') : '',
    empty: vis('recent-empty'),
    allActive: document.getElementById('recent-filter-all').classList.contains('is-active'),
    mineActive: document.getElementById('recent-filter-mine').classList.contains('is-active'),
    allSel: document.getElementById('recent-filter-all').getAttribute('aria-selected'),
    mineSel: document.getElementById('recent-filter-mine').getAttribute('aria-selected'),
  };
};

(async () => {
  const browser = await firefox.launch({ headless: true });

  console.log('--- 1) All: up to 5 site-wide items, each credited ---');
  {
    const { ctx, page, errs, reqUrls } = await openPage(browser, 'u1');
    const s = await page.evaluate(SNAP);
    ok(s.items.length === 5, `All 最多 5 条（实际 ${s.items.length}）`);
    ok(s.items.every((i) => i.by), 'All 的每条都带 "by <用户名>"', s.items.map((i) => i.by));
    ok(s.allActive && !s.mineActive && s.allSel === 'true', '默认选中 All');
    ok(!s.gate && !s.note && !s.empty, 'All 且有条目时：无登录提示、无鼓励语、无空状态');
    // 排序由服务端做，mock 下前端断言不了顺序 —— 能断言的是"首页确实主动要了那份排序"。
    // 这条与 scripts/test-submissions-order.js 的「不带参数走旧子句」互为两面。
    ok(reqUrls.some((u) => /\/api\/submissions\?order=approved$/.test(u)),
      '首页按 order=approved 拉取（而不是默认那份）', reqUrls);
    // 夹具里 created_at 是 7 月、first_approved_at 是 9 月：显示成 Jul 就说明读错了字段。
    ok(s.items[0].date === 'Sep 20', '条目显示的是通过时间，不是提交时间', { got: s.items[0].date });
    ok(s.items.every((i) => /^Sep /.test(i.date)), '每一条的日期都来自 first_approved_at',
      s.items.map((i) => i.date));
    ok(errs.length === 0, '无 JS 报错', errs);
    await ctx.close();
  }

  console.log('--- 2) Mine as a 7-item / 3-country contributor: capped, own items only, no nudge ---');
  {
    const { ctx, page } = await openPage(browser, 'u1');
    await page.click('#recent-filter-mine');
    await page.waitForTimeout(150);
    const s = await page.evaluate(SNAP);
    ok(s.mineActive && !s.allActive && s.mineSel === 'true', '点 Mine 后选中态与 aria-selected 都切过去');
    ok(s.items.length === 5, `Mine 也封顶 5 条（实际 ${s.items.length}，该用户共 7 条）`);
    ok(s.items.every((i) => /^\/explore\?country=[a-z-]+&region=s\d+$/.test(i.href)),
      'Mine 的每条仍是 /explore?country=…&region=… 链接', s.items.map((i) => i.href));
    // 直接盯着"筛没筛"本身：这几条必须全是 u1 的提交 id。上面那条 href 形状断言对
    // 谁的内容都成立，替换不掉这一条。
    const mineIds = idsOf('u1');
    ok(s.items.every((i) => mineIds.indexOf(i.href.replace(/.*&region=/, '')) >= 0),
      'Mine 只列自己的条目', { shown: s.items.map((i) => i.href.replace(/.*&region=/, '')), mineIds });
    ok(!s.items.some((i) => i.by), 'Mine 不再显示 "by 自己"');
    ok(!s.note, '3 个国家 7 条时不出现"只提交了一个国家"的鼓励语');
    // Switch back — the All list must come back intact, not stay filtered.
    await page.click('#recent-filter-all');
    await page.waitForTimeout(150);
    const back = await page.evaluate(SNAP);
    ok(back.items.length === 5 && back.items.some((i) => i.by) && back.allActive, '点回 All 恢复全站列表');
    await ctx.close();
  }

  console.log('--- 2b) Mine as a 5-item / 1-country contributor: the >3 half of the nudge guard ---');
  {
    const { ctx, page } = await openPage(browser, 'u4');
    await page.click('#recent-filter-mine');
    await page.waitForTimeout(150);
    const s = await page.evaluate(SNAP);
    const mineIds = idsOf('u4');
    ok(s.items.length === 5 && s.items.every((i) => mineIds.indexOf(i.href.replace(/.*&region=/, '')) >= 0),
      'Mine 只列自己的条目', { shown: s.items.map((i) => i.href.replace(/.*&region=/, '')), mineIds });
    // 只有一个国家，但有 5 条 —— 已经开过头了，再劝他"去开第二个国家"是多余的。
    ok(!s.note, '5 条 1 个国家时不出鼓励语（≤3 那条守卫的另一半）');
    await ctx.close();
  }

  console.log('--- 3) Mine as a 2-item / 1-country contributor: show 2, then nudge ---');
  {
    const { ctx, page } = await openPage(browser, 'u2');
    await page.click('#recent-filter-mine');
    await page.waitForTimeout(150);
    const s = await page.evaluate(SNAP);
    ok(s.items.length === 2, `不足 5 条就只显示实际条数（实际 ${s.items.length}）`);
    ok(s.note, '出现鼓励语');
    ok(s.noteText === "Just one country so far. There's a whole world left to map.",
      '鼓励语文案正确', s.noteText);
    ok(s.noteLink === 'Submit a region →' && s.noteHref === '/submit',
      '鼓励语的链接文字与目标正确', { text: s.noteLink, href: s.noteHref });
    await ctx.close();
  }

  console.log('--- 4) Mine with 0 approved ---');
  {
    const { ctx, page } = await openPage(browser, 'u3');
    await page.click('#recent-filter-mine');
    await page.waitForTimeout(150);
    const s = await page.evaluate(SNAP);
    ok(s.items.length === 0 && s.note, '列表为空并出现鼓励语');
    // 数据源是"已批准的"，所以这里不能写成"你还没提交过" —— 刚提交待审的人会看到它。
    ok(s.noteText === 'No approved submissions yet.', '文案说的是 approved，不是"没提交过"', s.noteText);
    ok(s.noteLink === '(Share your META~)' && s.noteHref === '/submit', '链接文字与目标正确',
      { text: s.noteLink, href: s.noteHref });
    ok(!s.empty, 'Mine 的空状态由鼓励语承担，不显示全站空状态');
    await ctx.close();
  }

  console.log('--- 5) Mine while logged out: login gate replaces the list ---');
  {
    const { ctx, page } = await openPage(browser, null);
    ok(!(await page.evaluate(SNAP)).gate, '未登录时 All 不显示登录提示');
    await page.click('#recent-filter-mine');
    await page.waitForTimeout(150);
    const s = await page.evaluate(SNAP);
    ok(s.gate, '未登录点 Mine 出现登录提示');
    ok(s.items.length === 0 && !s.note && !s.empty, '登录提示出现时列表与其它状态都让位');
    ok(/^https?:\/\/[^/]+\/api\/auth\?action=login$/.test(s.gateHref), '登录按钮指向 /api/auth?action=login', s.gateHref);
    ok(s.gateText === 'Please log in with Discord to see your own submissions.', '登录提示文案', s.gateText);
    // 回到 All 必须能恢复 —— 登录提示不能把 All 一起吃掉。
    await page.click('#recent-filter-all');
    await page.waitForTimeout(150);
    const back = await page.evaluate(SNAP);
    ok(!back.gate && back.items.length === 5, '未登录时点回 All 恢复正常列表');
    await ctx.close();
  }

  console.log('--- 6) the control looks like home map/cards, and shares its row with the title ---');
  {
    const { ctx, page } = await openPage(browser, 'u1');
    const geo = await page.evaluate(() => {
      const read = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor, borderW: cs.borderTopWidth, borderC: cs.borderTopColor,
          radius: cs.borderTopLeftRadius, font: cs.fontSize, minH: cs.minHeight, color: cs.color,
        };
      };
      const head = document.querySelector('.recent-updates__header').getBoundingClientRect();
      const title = document.querySelector('#recent-updates .recent-updates__title').getBoundingClientRect();
      const filter = document.querySelector('.recent-updates__filter').getBoundingClientRect();
      const section = document.querySelector('#recent-updates').getBoundingClientRect();
      return {
        head, title, filter, section,
        sameRow: title.top < filter.bottom && filter.top < title.bottom,
        gaps: { filter: read('.recent-updates__filter .view-toggle__btn.is-active'), mapActive: read('#view-map-btn'),
          mine: read('#recent-filter-mine'), cards: read('#view-cards-btn') },
        docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    const eq = (a, b) => a && b && Object.keys(a).every((k) => a[k] === b[k]);
    const diff = (a, b) => Object.keys(a).filter((k) => a[k] !== b[k]);
    ok(eq(geo.gaps.filter, geo.gaps.mapActive), '选中的 Mine/All 与 map/cards 的选中态逐属性相等',
      { mine: diff(geo.gaps.filter, geo.gaps.mapActive) });
    ok(eq(geo.gaps.mine, geo.gaps.cards), '未选中的按钮与 map/cards 的未选中态逐属性相等',
      { mine: diff(geo.gaps.mine, geo.gaps.cards) });
    ok(geo.sameRow, '标题与筛选在同一行', { titleTop: Math.round(geo.title.top), filterTop: Math.round(geo.filter.top) });
    ok(geo.filter.left > geo.title.right, '筛选在标题右侧');
    ok(geo.filter.right <= geo.section.right + 0.5, '筛选右边缘不越出区块',
      { filterRight: Math.round(geo.filter.right), sectionRight: Math.round(geo.section.right) });
    ok(geo.docOverflow <= 0, `1440 下无横向溢出`, geo.docOverflow);
    // 390：wrap 是兜底，两个按钮要么同行要么整块落到第二行，任何情况都不许顶出视口。
    await page.setViewportSize({ width: 390, height: 760 });
    await page.waitForTimeout(200);
    const narrow = await page.evaluate(() => {
      const head = document.querySelector('.recent-updates__header').getBoundingClientRect();
      const filter = document.querySelector('.recent-updates__filter').getBoundingClientRect();
      const title = document.querySelector('#recent-updates .recent-updates__title').getBoundingClientRect();
      return {
        filterRight: Math.round(filter.right), titleRight: Math.round(title.right),
        headRight: Math.round(head.right), docOverflow: document.documentElement.scrollWidth - window.innerWidth,
        wrapped: filter.top >= title.bottom,
      };
    });
    ok(narrow.docOverflow <= 0, '390 下无横向溢出', narrow);
    ok(narrow.filterRight <= narrow.headRight + 0.5, '390 下筛选不越出这一行',
      { filterRight: narrow.filterRight, headRight: narrow.headRight });
    await ctx.close();
  }

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

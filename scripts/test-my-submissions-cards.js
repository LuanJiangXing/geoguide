// Contract harness for the /my-submissions card layout.
//
// Why this script exists. Three of the card contracts are **runtime-geometry**
// contracts — they cannot be read off the CSS and cannot be checked from a
// stylesheet diff:
//
//   1. Same-row cards are equal height. `align-self: stretch` on the card plus
//      `margin-top: auto` on the action row is what makes it work; put the
//      stretch on the *container* instead and it still looks right — but it
//      drags `.trash-bar` up with it.
//   2. Tags are dropped **whole** when they no longer fit, by measuring after
//      layout. `overflow: hidden` would leave a half tag on screen, which reads
//      as a complete short tag — worse than dropping it.
//   3. The status triangle is clipped out of a square. `overflow: hidden` on the
//      card is what rounds its corner — and the same declaration clips keyboard
//      focus rings, which this repo has been bitten by twice (overlap tab track,
//      footer .country-bar). Section 10 measures that in the focused state.
//
// The download button's per-tab presence (active yes / hidden yes / trash no) is
// a *semantic* contract and is pinned by scripts/test-submission-export.js B5;
// this script only re-checks it so a card-layout change cannot quietly drop it.
// It happened once: the design table listed hidden as "edit / unhide" and the
// download vanished. B5 caught it.
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-my-submissions-cards.js
//   kill $(lsof -ti :3999)
'use strict';

const { firefox } = require('playwright');

const BASE = (process.env.BASE_URL || 'http://localhost:3999').replace(/\/$/, '');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL'), name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}

const COUNTRIES = [
  { id: 'south-africa', name: 'South Africa', flag: 'za', bounds_sw: [-34.5, 17], bounds_ne: [-22.5, 32.5], active: 1, sort_order: 0 },
  { id: 'paraguay', name: 'Paraguay', flag: 'py', bounds_sw: [-27.6, -62.6], bounds_ne: [-19.3, -54.3], active: 1, sort_order: 1 },
  // 有国家名但**没有 flag 码** —— 用来验「没有对应再写字」那条回退
  { id: 'atlantis', name: 'Atlantis', flag: '', bounds_sw: [-1, -1], bounds_ne: [1, 1], active: 1, sort_order: 2 }
];

const row = (o) => Object.assign({
  id: 0, name: '', description: '', detailed_description: '', source_type: '', source_url: '',
  country_id: 'south-africa', scope: 'region', tags: [], geojson: { type: 'Polygon', coordinates: [] },
  streetview: [], link: '', status: 'pending', created_at: '2026-01-05T00:00:00Z', reviewed_at: '',
  reject_reason: '', is_hidden: 0, goat_count: 0, heart_count: 0, useful_count: 0,
  useless_count: 0, wrong_count: 0, error_count: 0, user_id: 1, edit_target_id: null
}, o);

// 同一排三张，内容量刻意拉开：富内容 / 几乎空 / 中等。
// 「几乎空」那张是等高的**非空洞性**前提 —— 没有它，三张一样高也能假绿。
const ACTIVE = [
  row({ id: 1, name: 'A very long submission title that will absolutely not fit on one line at all',
        description: 'Body copy long enough to wrap onto a second line so the clamp is exercised.',
        detailed_description: 'Extra notes here.', status: 'approved',
        tags: ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'],
        goat_count: 5, useful_count: 12, useless_count: 3 }),
  row({ id: 2, name: 'Short', description: 'x', status: 'pending', country_id: 'paraguay', tags: [] }),
  row({ id: 3, name: 'Medium length title here', description: 'Another body.', status: 'rejected',
        reject_reason: 'Region too broad', country_id: 'atlantis', tags: ['solo'], detailed_description: 'notes' })
];
const HIDDEN = [row({ id: 11, name: 'Hidden one', description: 'h', is_hidden: 1, status: 'approved', tags: ['t'] })];
const TRASH = [row({ id: 21, name: 'Trashed', description: 't', is_deleted: 1, deleted_at: '2026-08-07T00:00:00Z', status: 'approved' })];

const j = (b) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

(async () => {
  const browser = await firefox.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  const errors = [];

  // 外网一律短路：flagcdn / unpkg / OSM 在这个环境里连不上，
  // 不挡掉的话 waitForLoadState 会一直挂在那里，红得毫无信息量。
  const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
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
    const st = u.searchParams.get('status') || '';
    const list = st === 'hidden' ? HIDDEN : st === 'trash' ? TRASH : ACTIVE;
    return r.fulfill(j({ submissions: list, total: list.length, page: 1, pageSize: 18 }));
  });

  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('#my-results .review-item', { timeout: 15000 });
  await p.waitForTimeout(700);   // countries-ready 重渲染 + 标签裁剪 + 防抖

  // ---------------------------------------------------------------- 1) 容器
  const container = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#my-results .review-item')];
    const tops = {};
    cards.forEach((c) => { const t = Math.round(c.getBoundingClientRect().top); tops[t] = (tops[t] || 0) + 1; });
    return { maxWidth: getComputedStyle(document.querySelector('main.my-submissions')).maxWidth,
             perRow: Object.values(tops) };
  });
  check('容器 max-width 1400px', container.maxWidth === '1400px', container.maxWidth);
  check('一行仍是 3 张（加宽容器不是改列数）',
    container.perRow.length > 0 && container.perRow.every((n) => n === 3), container.perRow);

  // ---------------------------------------------------------------- 2) 三角
  const tri = await p.evaluate(() => {
    const c = document.querySelector('#my-results .review-item');
    const t = c.querySelector('.review-item__status');
    const cs = getComputedStyle(t), cr = c.getBoundingClientRect(), r = t.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), clip: cs.clipPath,
             bg: cs.backgroundColor, pos: cs.position,
             top: Math.round(r.top - cr.top), right: Math.round(cr.right - r.right),
             overflow: getComputedStyle(c).overflow,
             role: t.getAttribute('role'), label: t.getAttribute('aria-label'), title: t.title };
  });
  check('三角 26×26 且 clip-path 切出右侧那半', tri.w === 26 && tri.h === 26 && /polygon/.test(tri.clip), [tri.w, tri.h, tri.clip]);
  check('三角底色 = 该条状态色（approved #4a7c59）', tri.bg === 'rgb(74, 124, 89)', tri.bg);
  check('卡片 overflow hidden（不然三角的直角戳出圆角）', tri.overflow === 'hidden', tri.overflow);
  check('三角贴住右上角', tri.pos === 'absolute' && tri.top <= 2 && tri.right <= 2, [tri.top, tri.right]);
  check('★三角带 role=img★（空 span 上挂 aria-label 是无效标注）', tri.role === 'img', tri.role);
  check('三角 aria-label / title 带状态词', /Approved/.test(tri.label) && tri.title === tri.label, [tri.label, tri.title]);

  const badges = await p.evaluate(() => ({
    n: document.querySelectorAll('#my-results .status-badge').length,
    text: document.querySelector('#my-results .review-item').textContent
  }));
  check('卡片里不再有状态胶囊（三角取代了它）', badges.n === 0, badges.n);
  check('卡片可见文字里没有 Pending/Approved/Rejected', !/Pending|Approved|Rejected/.test(badges.text));

  // ---------------------------------------------------------------- 3) 标题单行
  const name = await p.evaluate(() => {
    const c = document.querySelector('#my-results .review-item');
    const n = c.querySelector('.review-item__name'), t = c.querySelector('.review-item__status');
    const ns = getComputedStyle(n), nr = n.getBoundingClientRect(), tr = t.getBoundingClientRect();
    return { clipped: n.scrollWidth > n.clientWidth, tt: ns.textOverflow, ws: ns.whiteSpace,
             h: Math.round(nr.height),
             contentRight: Math.round(nr.right - parseFloat(ns.paddingRight)),
             triLeft: Math.round(tr.left) };
  });
  check('超长标题单行省略', name.clipped && name.tt === 'ellipsis' && name.ws === 'nowrap', name);
  check('标题内容盒不越过三角左缘（右内边距 ≥ 三角宽）', name.contentRight <= name.triLeft,
    [name.contentRight, name.triLeft]);

  // ------------------------------------------- 3b) 标题链接（只有 approved 的卡有）
  // explore 只收 status='approved' AND is_deleted=0 AND is_hidden=0，
  // 其余三类跳过去必然落空（而且那边是静默失败），所以干脆不给链接。
  const link = await p.evaluate(() => {
    function grab(id) {
      const el = document.getElementById('submission-' + id).querySelector('.review-item__name');
      const a = el.querySelector('a');
      const cs = getComputedStyle(el);
      return {
        isAnchor: !!a,
        href: a ? a.getAttribute('href') : null,
        target: a ? a.getAttribute('target') : null,
        text: el.textContent,
        sr: a && a.querySelector('.sr-only') ? a.querySelector('.sr-only').textContent : null,
        srCount: a ? a.querySelectorAll('.sr-only').length : 0,
        cursor: getComputedStyle(a || el).cursor,
        title: el.getAttribute('title'),
        overflow: cs.textOverflow, ws: cs.whiteSpace,
        h: Math.round(el.getBoundingClientRect().height),
        padRight: parseFloat(cs.paddingRight),
        clipped: el.scrollWidth > el.clientWidth,
        aDisplay: a ? getComputedStyle(a).display : null
      };
    }
    return { approved: grab(1), pending: grab(2), rejected: grab(3) };
  });

  check('★approved 卡的标题是真 <a>★（不是 JS onclick 跳转）', link.approved.isAnchor, link.approved);
  check('href = /explore?country=…&region=<id>（两个参数都在）',
    link.approved.href === '/explore?country=south-africa&region=1', link.approved.href);
  check('★当前标签页打开★（没有 target=_blank）', !link.approved.target, link.approved.target);
  check('★只有 approved 有链接★：pending / rejected 的标题仍是纯文本',
    !link.pending.isAnchor && !link.rejected.isAnchor, [link.pending.isAnchor, link.rejected.isAnchor]);
  check('不可跳时 title 说明原因（pending）', /pending review/.test(link.pending.title || ''), link.pending.title);
  check('不可跳时 title 说明原因（rejected）', /rejected/.test(link.rejected.title || ''), link.rejected.title);
  check('★只有链接是手型光标★', link.approved.cursor === 'pointer'
    && link.pending.cursor !== 'pointer' && link.rejected.cursor !== 'pointer',
    [link.approved.cursor, link.pending.cursor, link.rejected.cursor]);
  check('★无障碍名包含可见文字★（WCAG 2.5.3）且交代去处',
    link.approved.srCount === 1 && /Explore/.test(link.approved.sr || '')
    && link.approved.text.startsWith('A very long'),
    { sr: link.approved.sr, srCount: link.approved.srCount });
  check('加链接没有改变截断行为（仍单行省略）',
    link.approved.overflow === 'ellipsis' && link.approved.ws === 'nowrap' && link.approved.clipped,
    link.approved);
  check('加链接没有改变行高（与非链接卡逐字相同）',
    link.approved.h === link.pending.h && link.approved.h === link.rejected.h,
    [link.approved.h, link.pending.h, link.rejected.h]);
  check('右内边距没被动过（仍 ≥ 三角宽 26px）', link.approved.padRight >= 26, link.approved.padRight);
  check('<a> 是 inline（不引入盒子、不撑高）', link.approved.aDisplay === 'inline', link.approved.aDisplay);

  // AC10：「有链接」与「submissionBucket(s).key === 'approved'」必须逐一对应 ——
  // 链接用的是后者当判据，所以两边不等就意味着判据漂了。
  const predicate = await p.evaluate(() => {
    const synth = [
      { tag: 'approved', s: { status: 'approved', is_hidden: 0, is_deleted: 0 }, expectLink: true },
      { tag: 'pending', s: { status: 'pending', is_hidden: 0, is_deleted: 0 }, expectLink: false },
      { tag: 'rejected', s: { status: 'rejected', is_hidden: 0, is_deleted: 0 }, expectLink: false },
      { tag: 'approved-but-hidden', s: { status: 'approved', is_hidden: 1, is_deleted: 0 }, expectLink: false },
      { tag: 'approved-but-trashed', s: { status: 'approved', is_hidden: 0, is_deleted: 1 }, expectLink: false }
    ];
    return synth.map((x) => ({ tag: x.tag, key: submissionBucket(x.s).key, expectLink: x.expectLink }));
  });
  check('★判据与 explore 的取数条件一致★：bucket=approved 才可跳（含 is_hidden / is_deleted 两个否决位）',
    predicate.every((x) => (x.key === 'approved') === x.expectLink), predicate);

  // ---------------------------------------------------------------- 4) 国旗
  const flag = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#my-results .review-item')];
    const withFlag = cards.find((c) => c.querySelector('.review-item__flag'));
    const noFlag = cards.find((c) => c.querySelector('.review-item__country'));
    const img = withFlag && withFlag.querySelector('.review-item__flag');
    return { src: img && img.getAttribute('src'), alt: img && img.getAttribute('alt'),
             title: img && img.title, aria: img && img.getAttribute('aria-label'),
             fallback: noFlag && noFlag.querySelector('.review-item__country').textContent };
  });
  check('国旗 src 命中 flagcdn w40', /flagcdn\.com\/w40\/za\.png/.test(flag.src || ''), flag.src);
  check('国旗是装饰（alt="" + aria-hidden）', flag.alt === '', flag.alt);
  check('国名另挂在 title / aria-label 上（不然只看得见一面旗）',
    flag.title === 'South Africa' && flag.aria === 'South Africa', [flag.title, flag.aria]);
  check('没有 flag 码的国家退回写国家名', flag.fallback === 'Atlantis', flag.fallback);

  // ---------------------------------------------------------------- 5) 标签裁剪
  const tags = await p.evaluate(() => {
    const rows = [...document.querySelectorAll('#my-results .review-item__line2')];
    let worst = -Infinity;
    const kept = rows.map((r) => {
      const box = r.querySelector('.review-item__tags');
      const limit = box.getBoundingClientRect().right;
      const kids = [...box.children];
      kids.forEach((k) => { worst = Math.max(worst, k.getBoundingClientRect().right - limit); });
      return { all: box._all.length, shown: kids.length, wrap: getComputedStyle(box).flexWrap };
    });
    return { worst: Math.round(worst * 100) / 100, kept };
  });
  check('没有任何标签越过容器右缘（是整颗丢掉，不是被 CSS 裁半颗）', tags.worst <= 0.5, tags.worst);
  check('标签行 nowrap（放不下就丢，不是换行）', tags.kept.every((k) => k.wrap === 'nowrap'), tags.kept);
  check('★非空洞性★ 确实发生了裁剪', tags.kept.some((k) => k.shown < k.all), tags.kept);
  check('★非空洞性★ 有标签的卡没被丢光',
    tags.kept.filter((k) => k.all > 0).every((k) => k.shown > 0), tags.kept);

  // ---------------------------------------------------------------- 6) meta 行
  const meta = await p.evaluate(() => [...document.querySelectorAll('#my-results .review-item')].map((c) => {
    const m = c.querySelector('.review-item__meta');
    const counts = c.querySelector('.review-item__counts');
    return { has: !!m, h: m ? Math.round(m.getBoundingClientRect().height) : null,
             detail: !!c.querySelector('.review-item__detail'),
             countKeys: counts ? [...counts.querySelectorAll('.reaction-count')]
               .map((x) => (x.className.match(/reaction-count--(\w+)/) || [])[1]) : null,
             countSrcs: counts ? [...counts.querySelectorAll('.reaction-count img')]
               .map((x) => x.getAttribute('src')) : null,
             countAria: counts ? [...counts.querySelectorAll('.reaction-count')]
               .map((x) => x.getAttribute('aria-label')) : null,
             counts: counts ? counts.textContent : null };
  }));
  check('有 detailed description 时该行出现且只占一行', meta[0].has && meta[0].detail && meta[0].h <= 20, meta[0]);
  check('detail 与计数都没有时整行不渲染（不占高度）', !meta[1].has, meta[1]);
  // D6：六项「图标 + 计数」，**只渲染非零项**（goat=5 / useful=12 / useless=3；
  // heart/wrong/error 都是 0，不得出现）。
  check('计数发在右端且是亮着的三项（只显非零）',
    JSON.stringify(meta[0].countKeys) === JSON.stringify(['goat', 'useful', 'useless']), meta[0].countKeys);
  check('每一项是自托管 Twemoji SVG（不是文字 emoji）',
    meta[0].countSrcs.every((s) => /images\/twemoji\/.+\.svg/.test(s || '')), meta[0].countSrcs);
  check('图标是装饰、名字由 role=img + aria-label 承担',
    JSON.stringify(meta[0].countAria) === JSON.stringify(['5 GOAT', '12 Useful', '3 Not Useful']), meta[0].countAria);
  check('六项计数都是 0 时不出现', meta[1].counts === null, meta[1].counts);
  check('第四行两端各自可选（只有 detail、没有计数）', meta[2].detail && meta[2].counts === null, meta[2]);

  // ---------------------------------------------------------------- 7) 动作行
  const actions = await p.evaluate(() => {
    const c = document.querySelector('#my-results .review-item');
    const cs = getComputedStyle(c);
    const btns = [...c.querySelectorAll('.review-item__actions button')];
    const rects = btns.map((b) => b.getBoundingClientRect());
    return {
      kinds: btns.map((b) => b.className.split('--')[1]),
      gaps: rects.slice(1, -1).map((r, i) => Math.round(r.left - rects[i].right)),
      lastRight: Math.round(rects[rects.length - 1].right),
      contentRight: Math.round(c.getBoundingClientRect().right
        - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)),
      boxW: Math.round(rects[0].width),
      svgWs: btns.map((b) => Math.round(b.querySelector('svg').getBoundingClientRect().width)),
      labels: btns.map((b) => b.getAttribute('aria-label'))
    };
  });
  check('active 动作行是 edit/hide/delete/download',
    actions.kinds.join(',') === 'edit,hide,delete,download', actions.kinds);
  check('相邻间距 ≤34px', actions.gaps.every((g) => g <= 34), actions.gaps);
  check('★下载（最后一个）右缘贴住卡片内容盒★ —— 这就是「右下角」',
    Math.abs(actions.lastRight - actions.contentRight) <= 1, [actions.lastRight, actions.contentRight]);
  check('命中区 32px（--compact 档，不自己发明）', actions.boxW === 32, actions.boxW);
  check('字形 18px', actions.svgWs.every((w) => w === 18), actions.svgWs);
  check('每个按钮都有 aria-label', actions.labels.every((l) => l && l.length > 3), actions.labels);

  // ---------------------------------------------------------------- 8) 等高
  const equal = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#my-results .review-item')];
    const byTop = {};
    cards.forEach((c) => {
      const t = Math.round(c.getBoundingClientRect().top);
      const cs = getComputedStyle(c);
      const a = c.querySelector('.review-item__actions').getBoundingClientRect();
      (byTop[t] = byTop[t] || { h: [], gap: [], meta: [] });
      byTop[t].h.push(Math.round(c.getBoundingClientRect().height));
      byTop[t].gap.push(Math.round(c.getBoundingClientRect().bottom
        - parseFloat(cs.borderBottomWidth) - parseFloat(cs.paddingBottom) - a.bottom));
      byTop[t].meta.push(!!c.querySelector('.review-item__meta'));
    });
    const rows = Object.values(byTop);
    return { heights: rows[0] ? rows[0].h : [], gaps: rows[0] ? rows[0].gap : [],
             allEqual: rows.every((r) => new Set(r.h).size === 1),
             gapsEqual: rows.every((r) => new Set(r.gap).size === 1),
             metas: rows[0] ? rows[0].meta : [] };
  });
  check('同排卡片高度逐一相等', equal.allEqual, equal.heights);
  check('图标行到卡片底边的距离逐一相等（空白全压在动作行上方）', equal.gapsEqual, equal.gaps);
  check('★非空洞性★ 这一排里「有 meta」和「没有 meta」的卡都在',
    equal.metas.some(Boolean) && equal.metas.some((v) => !v), equal.metas);

  const scope = await p.evaluate(() => ({
    container: getComputedStyle(document.getElementById('my-results')).alignItems,
    card: getComputedStyle(document.querySelector('#my-results .review-item')).alignSelf
  }));
  check('★stretch 挂在卡片上，不是容器的 align-items★（否则 .trash-bar 会被一起拉高）',
    scope.card === 'stretch' && scope.container === 'flex-start', scope);

  // ---------------------------------------------------------------- 9) 深色
  await p.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await p.waitForTimeout(400);
  const dark = await p.evaluate(() => {
    const c = document.querySelector('#my-results .review-item');
    return { tri: getComputedStyle(c.querySelector('.review-item__status')).backgroundColor,
             icon: getComputedStyle(c.querySelector('.review-item__icon')).color };
  });
  check('深色下三角保持状态原色', dark.tri === 'rgb(74, 124, 89)', dark.tri);
  check('深色下图标前景走 --ink-faded 的深色值（不是浅色值）', dark.icon === 'rgb(168, 157, 138)', dark.icon);
  await p.evaluate(() => document.documentElement.removeAttribute('data-theme'));
  await p.waitForTimeout(300);

  // ---------------------------------------------------------------- 10) 焦点环
  // 卡片是 overflow:hidden（三角要圆角），而它会**裁掉键盘焦点环** ——
  // 本仓库在 overlap 标签栏与页脚 .country-bar 上各踩过一次。
  // 必须真按 Tab 走到按钮上再量：没聚焦时 outline-style 是 none，量出来的数是假的。
  await p.evaluate(() => document.body.focus());
  const ring = [];
  for (let i = 0; i < 60 && ring.length < 4; i++) {
    await p.keyboard.press('Tab');
    const info = await p.evaluate(() => {
      const a = document.activeElement;
      if (!a || !a.classList.contains('review-item__icon')) return null;
      const card = a.closest('.review-item');
      const cs = getComputedStyle(card), as = getComputedStyle(a);
      const cr = card.getBoundingClientRect(), r = a.getBoundingClientRect();
      const clip = { t: cr.top + parseFloat(cs.borderTopWidth), l: cr.left + parseFloat(cs.borderLeftWidth),
                     r: cr.right - parseFloat(cs.borderRightWidth), b: cr.bottom - parseFloat(cs.borderBottomWidth) };
      return { kind: a.className.split('--')[1], outline: as.outlineStyle,
               need: parseFloat(as.outlineWidth) + parseFloat(as.outlineOffset),
               min: Math.min(r.top - clip.t, r.left - clip.l, clip.r - r.right, clip.b - r.bottom) };
    });
    if (info) ring.push(info);
  }
  check('★非空洞性★ 60 次 Tab 内聚焦到了四个卡片图标', ring.length === 4, ring.map((r) => r.kind));
  check('焦点环在聚焦态下真的存在', ring.every((r) => r.outline === 'solid'), ring.map((r) => r.outline));
  check('★焦点环不被 overflow:hidden 裁掉★',
    ring.every((r) => r.min >= r.need), ring.map((r) => [r.kind, r.min, r.need]));

  // ---------------------------------------------------------------- 11) 窄屏
  await p.setViewportSize({ width: 700, height: 1000 });
  await p.waitForTimeout(500);
  const narrow = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('#my-results .review-item')];
    const tops = {};
    cards.forEach((c) => { const t = Math.round(c.getBoundingClientRect().top); tops[t] = (tops[t] || 0) + 1; });
    return { dir: getComputedStyle(cards[0]).flexDirection, perRow: Object.values(tops) };
  });
  check('≤767px 每张卡独占一行、竖排', narrow.dir === 'column' && narrow.perRow.every((n) => n === 1), narrow);
  await p.setViewportSize({ width: 1500, height: 1000 });
  await p.waitForTimeout(400);

  // ---------------------------------------------------------------- 12) 各 tab
  await p.click('#visibility-tabs button[data-visibility="hidden"]');
  await p.waitForSelector('#my-results .review-item', { timeout: 10000 });
  await p.waitForTimeout(400);
  const hid = await p.evaluate(() => ({
    kinds: [...document.querySelectorAll('#my-results .review-item__actions button')].map((b) => b.className.split('--')[1]),
    chip: !!document.querySelector('#my-results .review-item__chip--hidden'),
    titleIsAnchor: !!document.querySelector('#my-results .review-item__name a'),
    title: document.querySelector('#my-results .review-item__name').getAttribute('title'),
    tri: getComputedStyle(document.querySelector('#my-results .review-item__status')).backgroundColor
  }));
  check('hidden 动作行是 edit/unhide/download', hid.kinds.join(',') === 'edit,unhide,download', hid.kinds);
  check('★hidden 也有下载图标★（导出契约覆盖 active 与 hidden；漏过一次）',
    hid.kinds.indexOf('download') !== -1, hid.kinds);
  check('hidden 的 Hidden 徽章降级成 chip', hid.chip, hid.chip);
  check('★Hidden tab 的标题不是链接★（hidden 不上 explore）',
    hid.titleIsAnchor === false, hid.titleIsAnchor);
  check('Hidden 的标题说明原因', /hidden submissions are private/.test(hid.title || ''), hid.title);
  check('★hidden 三角用状态色，不是灰★（全灰在 Hidden tab 上零信息量）',
    hid.tri === 'rgb(74, 124, 89)', hid.tri);

  await p.click('#visibility-tabs button[data-visibility="trash"]');
  await p.waitForSelector('#my-results .review-item', { timeout: 10000 });
  await p.waitForTimeout(400);
  const trash = await p.evaluate(() => ({
    cards: document.querySelectorAll('#my-results .review-item').length,
    kinds: [...document.querySelectorAll('#my-results .review-item__actions button')].map((b) => b.className.split('--')[1]),
    titleIsAnchor: !!document.querySelector('#my-results .review-item__name a'),
    title: document.querySelector('#my-results .review-item__name').getAttribute('title'),
    tri: getComputedStyle(document.querySelector('#my-results .review-item__status')).backgroundColor
  }));
  check('★非空洞性★ Trash 卡确实渲染出来了（否则下面两条空转）', trash.cards > 0, trash.cards);
  check('★Trash 没有下载★（后端也 404，这是语义契约不是几何）',
    trash.kinds.indexOf('download') === -1, trash.kinds);
  check('Trash 动作是 restore/delete', trash.kinds.join(',') === 'restore,delete', trash.kinds);
  check('Trash 三角走灰色档', trash.tri === 'rgb(160, 152, 138)', trash.tri);
  check('★Trash tab 的标题不是链接★（Trash 不上 explore）',
    trash.titleIsAnchor === false, trash.titleIsAnchor);
  check('Trash 的标题说明原因', /in Trash/.test(trash.title || ''), trash.title);

  check('无 JS 报错', errors.length === 0, errors.slice(0, 3));

  await browser.close();
  console.log(failures ? ('\n== FAILURES: ' + failures) : '\n== ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });

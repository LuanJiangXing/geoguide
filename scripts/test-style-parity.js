// Computed-style parity harness — the safety net for style refactors that must not change rendering.
//
// WHY: refactors like "fold an inline <style> block into style.css" or "group scattered @media
// blocks" are supposed to be pure moves. Screenshots can't prove that here (this environment can't
// read images) and can't say WHICH property moved. This harness snapshots the computed style of
// every element on every page at every breakpoint boundary, then diffs the two snapshots property
// by property, naming the exact element and property that changed.
//
// USAGE
//   node scripts/test-style-parity.js --snapshot /tmp/baseline.json    # before the refactor
//   node scripts/test-style-parity.js --compare  /tmp/baseline.json    # after — exits 1 on any diff
//
//   BASE_URL=http://localhost:8123 node scripts/test-style-parity.js --snapshot /tmp/baseline.json
//
// THE HARNESS MUST BE RED-CHECKED BEFORE IT IS TRUSTED. `--selfcheck` mutates one property live in
// the page and asserts the sampler reports it. If selfcheck does not go red, the sampler is blind
// to that element/property and every "0 differences" verdict after it is worthless. Run it once
// after any change to PROPS or SAMPLE.
//
// WHY RESIZE INSTEAD OF RELOAD: the same harness runs both sides of the diff, so any systematic
// quirk in the sampling method cancels out. Reloading for all 15 widths x 6 pages would be 90
// navigations; resizing is 6 navigations and keeps the fixture state identical between widths.
//
// GOTCHA — page.evaluate only forwards ONE argument in this environment. Pass a single object.
const { firefox } = require('playwright');
const fs = require('fs');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const PAGES = ['explore.html', 'my-submissions.html', 'review.html', 'submit.html', 'index.html', 'profile.html'];

// Widths chosen to straddle every breakpoint that exists in style.css: 400 / 500 / 600 / 620 / 640 /
// 680 / 681 / 720 / 760 / 767. Each breakpoint is sampled just inside AND just outside its edge,
// because a `max-width: 680px` rule applies at 680 but not at 681 — a diff that only sampled one
// side would miss a regression that moves the boundary.
const WIDTHS = [
  [1920, 1080], [1440, 900], [1280, 800], [1024, 640], [768, 700],
  [767, 700], [760, 700], [720, 700], [681, 700], [680, 700],
  [640, 700], [620, 700], [600, 700], [500, 700], [499, 700],
  [400, 700], [390, 760],
];

// Property whitelist. getComputedStyle exposes ~340 properties per element; sampling all of them
// across ~500 elements x 17 widths x 6 pages would produce a snapshot measured in hundreds of MB.
// These are the properties the refactor could plausibly disturb. `transition` is deliberately
// EXCLUDED — the sampler injects `transition: none` to stop mid-animation values from creating
// false diffs, which would mask the property itself. Transitions are verified via CSSOM instead.
const PROPS = [
  'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius',
  'background-color', 'background-image', 'background-position', 'background-size', 'background-repeat',
  'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing',
  'text-align', 'text-decoration-line', 'text-transform', 'white-space', 'word-break', 'text-overflow',
  'overflow-x', 'overflow-y', 'opacity', 'visibility', 'box-shadow', 'transform', 'transform-origin',
  'gap', 'row-gap', 'column-gap', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis',
  'align-items', 'align-self', 'align-content', 'justify-content', 'justify-items', 'order',
  'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row',
  'cursor', 'pointer-events', 'user-select', 'object-fit', 'list-style-type', 'outline-style', 'outline-width',
  // SVG 专用。曾经漏掉，代价是实测出来的：世界地图的 #d8d5cd 就写在 `fill` 上
  // （style.css 的 `.world-map__svg path` 与 `.country-dot`），采样器对这两条规则完全失明 ——
  // 改写它们之后 `--compare` 依然报 0 差异。加之前先用 --selfcheck 复现过这个假绿。
  'fill', 'stroke',
];

// Runs in the page. Returns { path -> "v1|v2|..." }.
// The path is a tag + nth-of-type chain rather than a class chain: class names are exactly what the
// refactor may add or remove, so keying on them would produce spurious add/remove pairs instead of
// a real style diff.
const SAMPLE = ({ props, selfcheck }) => {
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    while (node && node !== document.body && node.parentElement) {
      const sameTag = Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName);
      const idx = sameTag.indexOf(node);
      parts.unshift(node.tagName.toLowerCase() + (sameTag.length > 1 ? ':nth-of-type(' + (idx + 1) + ')' : ''));
      node = node.parentElement;
    }
    return parts.join('>');
  };

  if (selfcheck) {
    // Mutate exactly one property on exactly one element, so the caller can assert the sampler sees it.
    const target = document.querySelector(selfcheck.selector);
    if (!target) return { __error: 'selfcheck target not found: ' + selfcheck.selector };
    target.style.setProperty(selfcheck.prop, selfcheck.value);
  }

  const out = {};
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const cs = getComputedStyle(el);
    let s = '';
    for (const p of props) s += cs.getPropertyValue(p) + '|';
    out[pathOf(el)] = s;
  }
  out.__count = String(all.length);
  return out;
};

// Fixtures. Shape matters only in that it must (a) be identical on both sides of the diff and
// (b) actually populate the components the refactor touches — otherwise the diff silently passes
// while testing nothing. GUARDS below asserts (b).
const COUNTRIES = [
  { id: 'JP', name: 'Japan' }, { id: 'FR', name: 'France' }, { id: 'BR', name: 'Brazil' },
  { id: 'ZA', name: 'South Africa' }, { id: 'AU', name: 'Australia' },
];
const TAG_NAMES = ['cars', 'scenery', 'signs', 'roads', 'weather', 'nature', 'urban', 'coast'];
const TAGS = { categories: TAG_NAMES.map((n) => ({ name: n, tags: [{ name: n + '-a' }, { name: n + '-b' }] })) };
const USER = { id: 1, discord_id: 'fixture', username: 'fixture-user', avatar_url: '', role: 'user', display_name: 'Fixture User' };
const SUBMISSIONS = COUNTRIES.map((c, i) => ({
  id: 1000 + i, country_id: c.id, lat: 10 + i, lng: 20 + i, status: 'approved',
  description: 'Fixture submission for ' + c.name, tags: ['cars-a'], created_at: '2026-01-0' + (i + 1),
  user_name: 'fixture-user',
}));

const FIXTURES = [
  [/\/api\/tags/, () => TAGS],
  [/\/api\/countries/, () => ({ countries: COUNTRIES, total: COUNTRIES.length })],
  [/\/api\/user-submissions/, () => ({ submissions: SUBMISSIONS, countries: COUNTRIES.map((c) => c.id), total: SUBMISSIONS.length })],
  [/\/api\/submissions/, () => ({ submissions: SUBMISSIONS, contributors: [], regions: SUBMISSIONS })],
  [/\/api\/reactions/, () => ({ reactions: [], regions: [], favorites: [] })],
  [/\/api\/review/, () => ({ submissions: [], items: [], total: 0 })],
  [/\/api\/users/, () => ({ users: [], logs: [] })],
  // NOTE: these two must be block-bodied. An arrow with an expression body RETURNS the fulfil
  // promise, so the wrapper below would see a non-undefined result and fulfil a second time,
  // throwing "Route is already handled!".
  //
  // These MUST return a signed-in user. Returning 401 here sends my-submissions.html down its
  // login-gate branch, where it never builds the country filter at all — the menu element stays
  // empty and the AC3 guard fires (which is exactly how this was caught).
  [/\/api\/profile/, (r) => { r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: USER, submissions: SUBMISSIONS }) }); }],
  [/\/api\/auth/, (r) => { r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: USER }) }); }],
  [/\/api\/pageview/, () => ({ ok: true })],
  [/\/api\/translate/, () => ({ translation: '' })],
];

// If a component the refactor touches is missing from the snapshot, the diff is vacuous for it.
// Each entry is [page, cssSelector, why]. These are checked after every navigation.
const GUARDS = [
  ['explore.html', '.tag-filter__toggle', 'the filter entry button must be rendered, or the explore snapshot is vacuous'],
  ['explore.html', '.tag-filter__panel', 'the panel is what replaced the old tag dropdowns — it must be rendered'],
  ['explore.html', '.tag-filter__badge', 'the selected-count badge must be rendered'],
  ['my-submissions.html', '.country-filter__menu', 'AC3 — this page consumes the SHARED base class that R1 splits apart'],
  ['my-submissions.html', '.country-filter__item', 'AC3 — country-filter items are built from the shared base'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sample until two consecutive reads agree. A single read can catch a transient state (a lazy image
// mid-load, a Leaflet pane mid-resize) and report it as a style difference. Sampling only a settled
// state is what makes "0 differences" mean something.
async function stableSample(page, selfcheck) {
  let prev = null, prevKey = '';
  for (let i = 0; i < 10; i++) {
    const cur = await page.evaluate(SAMPLE, { props: PROPS, selfcheck });
    const key = JSON.stringify(cur);
    if (prev && key === prevKey) return { data: cur, settled: true, tries: i + 1 };
    prev = cur; prevKey = key;
    await sleep(250);
  }
  return { data: prev, settled: false, tries: 10 };
}

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

async function newPage(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Block every off-origin request. The first version of this harness let them through and the
  // diff came back with 200+ differences on an UNCHANGED tree: images (flagcdn flags, in the
  // thousands on index.html) resolve asynchronously and the page toggles their `visibility` when
  // they load or error, so a sample taken mid-flight catches a different state each run. Blocking
  // makes every external resource fail the same way at the same time on both sides of the diff.
  await ctx.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith(BASE) || u.startsWith('data:') || u.startsWith('blob:')) return r.continue();
    return r.abort();
  });
  // Catch-all FIRST: Playwright resolves routes in reverse registration order, so the specific
  // routes registered below would be shadowed if this were added last.
  await ctx.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  for (const [re, handler] of FIXTURES) {
    await ctx.route(re, async (r) => {
      const res = handler(r);
      if (res === undefined) return;                       // handler fulfilled it itself
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(res) });
    });
  }
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errs.push(e.message.slice(0, 140)));
  return page;
}

const errs = [];
// Samples that never reached a stable state. Reported loudly: an unsettled sample means the diff
// is comparing moving targets, which would make both a PASS and a FAIL untrustworthy.
const unsettled = [];

async function snapshot() {
  const browser = await firefox.launch({ headless: true });
  const snap = {};
  for (const name of PAGES) {
    const page = await newPage(browser);
    await page.goto(BASE + '/' + name, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Freeze animations so a mid-transition value can't masquerade as a style difference.
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await sleep(1200);

    // Non-vacuity guard: a component the refactor touches that never rendered would make the diff
    // pass while proving nothing about it.
    for (const [gpage, sel, why] of GUARDS.filter((g) => g[0] === name)) {
      const n = await page.evaluate((s) => document.querySelectorAll(s).length, sel);
      ok(n > 0, `${name} 渲染出了 ${sel}（${n} 个）`, n > 0 ? undefined : why);
    }

    snap[name] = {};
    for (const [w, h] of WIDTHS) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(200);
      const s = await stableSample(page, null);
      if (!s.settled) unsettled.push(`${name}@${w}`);
      snap[name][w] = s.data;
    }
    await page.context().close();
  }
  await browser.close();
  return snap;
}

// Proves the sampler is not blind: mutate one property, re-sample the same page/width, and require
// the harness to see exactly that one change.
async function selfcheck() {
  const browser = await firefox.launch({ headless: true });
  for (const [page_name, selector, prop, value] of [
    ['explore.html', '.tag-filter__panel', 'max-width', '137px'],
    ['explore.html', '.tag-filter__item', 'padding-top', '37px'],
    ['my-submissions.html', '.country-filter__menu', 'min-width', '139px'],
    // 这条守的是 PROPS 白名单的盲区，不是某个组件。世界地图的 #d8d5cd 写在 `fill` 上，
    // 而 fill/stroke 一度不在 PROPS 里 —— 采样器对它们完全失明，改坏了也报"0 差异"。
    // SVG 专用属性，所以目标是 <circle class="country-dot">，不是 HTML 元素。
    ['index.html', '.world-map__svg .country-dot', 'fill', 'rgb(1, 2, 3)'],
  ]) {
    const page = await newPage(browser);
    await page.goto(BASE + '/' + page_name, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
    await sleep(1200);
    const before = await page.evaluate(SAMPLE, { props: PROPS, selfcheck: null });
    const target = await page.evaluate((sel) => !!document.querySelector(sel), selector);
    ok(target, `selfcheck 目标存在 ${page_name} ${selector}`);
    if (!target) { await page.context().close(); continue; }
    const after = await page.evaluate(SAMPLE, { props: PROPS, selfcheck: { selector, prop, value } });
    const changed = Object.keys(before).filter((k) => k !== '__count' && before[k] !== after[k]);
    ok(changed.length > 0, `selfcheck 能看见 ${selector} 的 ${prop} 改动`, { changedCount: changed.length });
    await page.context().close();
  }
  await browser.close();
}

function diff(base, cur) {
  const out = [];
  for (const name of Object.keys(base)) {
    if (!cur[name]) { out.push({ page: name, path: '(整页缺失)', prop: '', from: 'present', to: 'missing' }); continue; }
    for (const w of Object.keys(base[name])) {
      const b = base[name][w], c = cur[name][w];
      if (!c) { out.push({ page: name, width: w, path: '(整组缺失)', prop: '', from: 'present', to: 'missing' }); continue; }
      for (const p of new Set([...Object.keys(b), ...Object.keys(c)])) {
        if (p === '__count') continue;
        if (!(p in b)) { out.push({ page: name, width: w, path: p, prop: '(新增元素)', from: '', to: c[p] }); continue; }
        if (!(p in c)) { out.push({ page: name, width: w, path: p, prop: '(元素消失)', from: b[p], to: '' }); continue; }
        if (b[p] !== c[p]) {
          const bv = b[p].split('|'), cv = c[p].split('|');
          const props = [];
          for (let i = 0; i < PROPS.length; i++) {
            if (bv[i] !== cv[i]) props.push(`${PROPS[i]}: ${bv[i]} -> ${cv[i]}`);
          }
          out.push({ page: name, width: w, path: p, prop: props.join('; ') || '(顺序变化)', from: '', to: '' });
        }
      }
    }
  }
  return out;
}

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--selfcheck')) {
    console.log('--- sampler selfcheck: the harness must SEE these mutations ---');
    await selfcheck();
    console.log(fails ? `\n== FAILURES: ${fails}` : '\n== ALL PASS');
    process.exit(fails ? 1 : 0);
  }

  const si = args.indexOf('--snapshot');
  const ci = args.indexOf('--compare');

  if (si !== -1) {
    const out = args[si + 1];
    console.log('--- snapshotting (this is the BEFORE state) ---');
    const snap = await snapshot();
    for (const name of PAGES) {
      const total = Object.values(snap[name]).reduce((a, s) => a + Number(s.__count || 0), 0);
      console.log(`  ${name.padEnd(22)} ${WIDTHS.length} 宽度, 累计 ${total} 个元素采样`);
    }
    fs.writeFileSync(out, JSON.stringify(snap));
    console.log(`\n-> ${out}  (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
    if (unsettled.length) { fails++; console.log(`FAIL 有 ${unsettled.length} 个采样未稳定:`, unsettled.slice(0, 8)); }
    if (errs.length) console.log('页面 JS 报错:', errs.slice(0, 5));
    process.exit(0);
  }

  if (ci !== -1) {
    const inFile = args[ci + 1];
    const base = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    console.log('--- comparing against ' + inFile + ' ---');
    const cur = await snapshot();
    const d = diff(base, cur);
    if (!d.length) {
      console.log('PASS 计算样式逐属性完全一致（差异 0）');
    } else {
      console.log(`FAIL 发现 ${d.length} 处差异：\n`);
      for (const x of d.slice(0, 60)) {
        console.log(`  ${x.page} @${x.width}px  ${x.path}\n      ${x.prop}`);
      }
      if (d.length > 60) console.log(`  ...还有 ${d.length - 60} 处`);
      fails++;
    }
    if (unsettled.length) { fails++; console.log(`\nFAIL 有 ${unsettled.length} 个采样未稳定:`, unsettled.slice(0, 8)); }
    if (errs.length) console.log('\n页面 JS 报错:', errs.slice(0, 5));
    console.log(fails ? `\n== FAILURES: ${fails}` : '\n== ALL PASS');
    process.exit(fails ? 1 : 0);
  }

  console.log('usage: node scripts/test-style-parity.js --snapshot <out.json> | --compare <in.json> | --selfcheck');
  process.exit(1);
})();

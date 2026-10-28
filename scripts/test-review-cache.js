// Playwright harness for the admin review console: its resident data cache, and the lazy mini-maps.
//
// Contract A — cache. Each of the seven modules keeps its data in `_cache` keyed by module/filter;
// returning to a tab you have already opened must NOT re-request it and must NOT rebuild the DOM.
// Loaders default to "the data may have changed" (invalidate, then fetch); only navigation calls
// pass `{reuse:true}` to skip. Approve/reject splices the row out of the cached list and re-renders
// with zero network; sibling submissions filters are invalidated so Approved cannot silently miss
// what you just approved, while the other modules keep serving cache. See
// .trellis/spec/frontend/review-console-cache.md.
//
// Contract B — mini-map readiness. The IntersectionObserver callback is routinely delivered BEFORE
// `ensureLeaflet()` resolves (measured: unlock <1s after page load ⇒ callback at ~843ms, Leaflet at
// ~1139ms). The observer used to call `L.map()` right there; the throw was swallowed by the catch
// and the element was already unobserved, so that mini-map stayed blank for good and the console
// kept only one quiet error. It now waits on the promise. **Red check:** make the observer call
// `L.map()` directly again — "mini-map still renders when Leaflet arrives late" goes red, and only
// that one (the page itself stays green, because the throw is caught). Section B uses a stub that
// is *deliberately delivered late* so the race is reproduced every run instead of depending on CDN
// latency; that is also why it is hermetic.
//
// Contract C — a lazily-loaded library must be awaited before it is used. `loadAnalytics` fired
// `_loadScript(Chart.js)` and then built `new Chart(...)` in a promise ordered against nothing. On a
// slow or unreachable CDN the ReferenceError landed mid-`.then` — and because the summary cards are
// assigned before the chart block while Top Pages / Visitors / Recent are assigned after it, only
// the top half of the panel painted, with a bare console.error as the only trace. Reload could not
// recover either: `_loadScript` cached the rejected promise, so the script was never re-requested
// (measured: the request count stayed at 1). Fix is three-part — await the library, guard the chart
// block so it can never take the tables down with it, and drop the cache entry on failure.
// **Red checks (all four measured, see review-console-cache.md §6):** make `chartReady` a resolved
// promise → 5 red; drop the `chartOk` guard → 6 red, reproducing the original half-rendered panel;
// delete the `_scriptCache` cleanup → 3 red; hollow out `showAnalyticsError` → 1 red.
//
// **Red check for section A:** comment out the `invalidate()` inside `skipIfCached`, or the
// `dropFromSubmissionsCache` call in the batch-approve handler — the corresponding assertions go red.
// The three defects this file was written to lock down (container-vs-key `_shown`, batch ids being
// strings while `s.id` is a number, `wireReload` calling `.forEach` on a string) were all invisible
// to static reading and all shipped-breaking.
//
// Usage: node scripts/test-review-cache.js
//        BASE_URL=http://localhost:3999 node scripts/test-review-cache.js
//
// GOTCHA: the local `python3 -m http.server` does no extensionless routing, so the URL must carry
// `.html`. Start it with `setsid` — a plain `&` server dies when the Bash tool times out, surfacing
// later as NS_ERROR_CONNECTION_REFUSED.
//
// GOTCHA: `GET /api/auth?action=me` must return an *admin* user. Returning `null` sends the page
// down its "not admin" branch, which hides the password gate and shows Access Denied — the unlock
// click then never happens.
const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

const POLY = { type: 'Polygon', coordinates: [[[139.7, 35.6], [139.8, 35.6], [139.8, 35.7], [139.7, 35.7], [139.7, 35.6]]] };

const REVIEW_PENDING = {
  submissions: [
    { id: 1, name: 'Alpha', description: 'a', tags: [], country_id: 'japan', status: 'pending', scope: null, geojson: null, streetview: null, link: null, user_id: 1, created_at: '2026-09-01' },
    { id: 2, name: 'Beta', description: 'b', tags: [], country_id: 'japan', status: 'pending', scope: null, geojson: null, streetview: null, link: null, user_id: 1, created_at: '2026-09-02' },
  ],
  pending_tags: [], country_proposals: [], notes: [],
};
// 小地图那一段要真的有几何可画 —— 用上面那份 `geojson: null` 的数据等于什么都没测。
const REVIEW_PENDING_WITH_GEOMETRY = {
  submissions: REVIEW_PENDING.submissions.map((s) => Object.assign({}, s, { geojson: [POLY] })),
  pending_tags: [], country_proposals: [], notes: [],
};
const REVIEW_APPROVED = {
  submissions: [
    { id: 9, name: 'Gamma', description: 'g', tags: [], country_id: 'japan', status: 'approved', scope: null, geojson: null, streetview: null, link: null, user_id: 1, created_at: '2026-08-01' },
  ],
  pending_tags: [], country_proposals: [], notes: [],
};

// Section C. Analytics is the one module that draws with a *lazily loaded* library, so its fixture
// has to be non-empty: the whole point is that the tables below the charts survive a chart failure.
const PAGEVIEW_STATS = {
  range: '30d',
  daily_views: [{ date: '2026-09-20', count: 5 }, { date: '2026-09-21', count: 9 }],
  top_pages: [{ page: '/', count: 12 }, { page: '/explore', count: 7 }],
  devices: { desktop: 10, mobile: 4, tablet: 1 },
  total_views: 15,
  unique_ips: 6,
  visitors: [{ username: 'tester', visits: 3, last_visit: '2026-09-21T10:00:00Z', first_visit: '2026-09-01T10:00:00Z' }],
  recent: [{ page: '/', username: 'tester', created_at: '2026-09-21T10:00:00Z' }],
};

// Stand-in for Chart.js. Records every construction so the assertions can tell "the chart was
// drawn" from "the code reached the chart block and threw".
const CHART_STUB = `
window.__chartCalls = [];
window.Chart = function (ctx, cfg) {
  window.__chartCalls.push(cfg.type);
  this.data = cfg.data; this.options = cfg.options;
  this.update = function () {}; this.destroy = function () {};
};
`;

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

// Counts requests per endpoint, folding away the `_=` cache-buster. The status/type/action query
// is kept because it is what distinguishes one module's endpoint from another's.
function makeCounter() {
  const counts = {};
  const tally = (url) => {
    const u = new URL(url);
    const key = u.pathname
      + (u.searchParams.get('status') ? '?status=' + u.searchParams.get('status') : '')
      + (u.searchParams.get('type') ? '?type=' + u.searchParams.get('type') : '')
      + (u.searchParams.get('action') ? '?action=' + u.searchParams.get('action') : '');
    counts[key] = (counts[key] || 0) + 1;
    return key;
  };
  return { counts, tally };
}

// Minimal Leaflet stand-in. Records when it became available and tags the container the way the
// real library does, which is what the assertion looks for.
const LEAFLET_STUB = `
window.__leafletStubAt = Date.now();
window.L = {
  map: function (el) { el.classList.add('leaflet-container'); return {}; },
  tileLayer: function () { return { addTo: function () { return this; } }; },
  geoJSON: function () { return { addTo: function () { return this; },
    getBounds: function () { return { isValid: function () { return false; } }; } }; }
};
`;

async function newPage(browser, counter, opts) {
  const o = opts || {};
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept().catch(() => {}));

  await page.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  // Chart.js. Default is "unreachable" — that is what this harness has always done, and it is also
  // the real-world case that broke Analytics (cdnjs is frequently unreachable). `o.chart` turns it
  // on; `chartDelay` delivers it later than the JSON, which is the race; `chartFailHits: n` fails
  // the first n requests and then succeeds, so a retry can be watched actually re-request.
  // ⚠️ Two requests are in play before the user sees anything: the page-entry preload (hit 1) and
  // the one loadAnalytics makes when the tab opens (hit 2). Failing only hit 1 proves nothing about
  // the render path — the de-poisoning repairs it on the next call. Use chartFailHits: 2 to make the
  // failure land where the charts actually need the library.
  await page.route('**/cdnjs.cloudflare.com/**', async (r) => {
    o.chartHits = (o.chartHits || 0) + 1;
    if (!o.chart) return r.abort();
    if (o.chartFailHits && o.chartHits <= o.chartFailHits) return r.abort();
    if (o.chartDelay) await new Promise((res) => setTimeout(res, o.chartDelay));
    return r.fulfill({ contentType: 'application/javascript', body: CHART_STUB });
  });
  if (o.lateLeaflet) {
    // 故意晚 1500ms 才交付：观察者必然先触发，把竞态变成每次都发生的确定性事件。
    // 3000ms 而不是「一点点」：脚本请求在页面解析期（预加载那段）就发出了，等 newPage 返回时
    // 已经过去了几百毫秒，余量太小会让「Leaflet 还没到时不该画」那条断言偶发地失败。
    await page.route('**/unpkg.com/leaflet@1.9.4/dist/leaflet.js', async (r) => {
      await new Promise((res) => setTimeout(res, 3000));
      await r.fulfill({ contentType: 'application/javascript', body: LEAFLET_STUB });
    });
  } else {
    await page.route('**/unpkg.com/**', (r) => r.abort());
  }

  await page.route('**/api/pageview**', (r) => {
    counter.tally(r.request().url());
    if (o.failStats) { o.failStats = false; return r.fulfill({ status: 500, json: { error: 'boom' } }); }
    return r.fulfill({ json: PAGEVIEW_STATS });
  });
  await page.route('**/api/tags**', (r) => { counter.tally(r.request().url()); r.fulfill({ json: { categories: [{ name: 'Theme', sort_order: 0, tags: [{ id: 1, name: 'forest' }] }] } }); });
  await page.route('**/api/countries**', (r) => { counter.tally(r.request().url()); r.fulfill({ json: { countries: [], is_super_admin: true, country_proposals: [] } }); });
  await page.route('**/api/users**', (r) => {
    counter.tally(r.request().url());
    if (o.failUsers) { o.failUsers = false; return r.fulfill({ status: 500, json: { error: 'boom' } }); }
    return r.fulfill({ json: { users: [{ id: 1, username: 'tester', avatar_url: '', created_at: '2026-01-01' }], logs: [] } });
  });
  await page.route('**/api/review**', (r) => {
    const req = r.request();
    if (req.method() === 'PATCH') return r.fulfill({ json: { success: true, verified: 'approved', ok: true } });
    const status = new URL(req.url()).searchParams.get('status');
    counter.tally(req.url());
    if (status === 'approved') return r.fulfill({ json: REVIEW_APPROVED });
    return r.fulfill({ json: o.withGeometry ? REVIEW_PENDING_WITH_GEOMETRY : REVIEW_PENDING });
  });
  await page.route('**/api/auth**', (r) => (r.request().method() === 'POST'
    ? r.fulfill({ json: { ok: true, role: 'admin' } })
    : r.fulfill({ json: { user: { id: 1, username: 'tester', role: 'admin' } } })));

  await page.goto(BASE + '/review.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.fill('#admin-password-input', 'x');
  await page.click('#admin-password-submit');
  await page.waitForSelector('#review-main:not([hidden])', { timeout: 10000 });
  // `_loadScript` 的拒绝是**本 harness 自己**造成的（上面按需 abort 掉了那几个 CDN），
  // 不是页面缺陷 —— 别把它们算成未捕获错误。
  return { page, errors, realErrors: () => errors.filter((e) => !/^Failed to load https:\/\/cdn/.test(e)) };
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const counter = makeCounter();
  const { page, realErrors } = await newPage(browser, counter);
  await page.waitForTimeout(400);

  // The submissions and notes preloads hit the same URL, so 2 is the floor, not 1. What matters is
  // that unlocking does not add a third — that would mean it ignored the preload.
  ok((counter.counts['/api/review?status=pending'] || 0) === 2,
    'A: unlocking reuses the preload (pending not fetched again)',
    counter.counts['/api/review?status=pending']);

  // ── returning to a tab: no request, no rebuild ─────────────────────────────
  await page.click('#primary-tabs .review-tab[data-module="users"]');
  await page.waitForSelector('#user-grid > *', { timeout: 10000 });
  await page.evaluate(() => { document.querySelector('#user-grid > *').dataset.probeMark = 'first-render'; });
  await page.click('#primary-tabs .review-tab[data-module="audit"]');
  await page.waitForTimeout(200);
  await page.click('#primary-tabs .review-tab[data-module="submissions"]');
  await page.waitForTimeout(200);
  await page.click('#primary-tabs .review-tab[data-module="users"]');
  await page.waitForTimeout(300);
  ok((counter.counts['/api/users'] || 0) === 1, 'A: second visit to Users makes no request', counter.counts['/api/users']);
  ok(await page.evaluate(() => {
    const el = document.querySelector('#user-grid > *');
    return el ? el.dataset.probeMark === 'first-render' : false;
  }), 'A: second visit to Users does not rebuild the DOM (no Loading flash)');

  // ── submissions filters: each combination fetched once, and the container
  //    must show the combination you asked for (the shared-#review-list trap) ──
  await page.click('#primary-tabs .review-tab[data-module="submissions"]');
  await page.waitForTimeout(300);
  const approvedBefore = counter.counts['/api/review?status=approved'] || 0;
  for (const s of ['approved', 'pending', 'approved', 'pending']) {
    await page.click(`#status-tabs .review-tab[data-status="${s}"]`);
    await page.waitForTimeout(300);
  }
  ok((counter.counts['/api/review?status=approved'] || 0) - approvedBefore === 1,
    'A: switching back to a status filter does not refetch it',
    (counter.counts['/api/review?status=approved'] || 0) - approvedBefore);
  ok((await page.locator('#review-list .review-item').count()) === 2,
    'A: the container holds the filter you asked for, not the previous one',
    await page.locator('#review-list .review-item').count());

  // ── single approve: zero network, row gone, other modules untouched ────────
  const snapshot = Object.assign({}, counter.counts);
  const before = await page.locator('#review-list .review-item').count();
  await page.locator('#review-list .review-item', { hasText: 'Alpha' })
    .locator('button', { hasText: 'Approve' }).first().click();
  await page.waitForTimeout(500);
  ok((counter.counts['/api/review?status=pending'] || 0) === (snapshot['/api/review?status=pending'] || 0),
    'A: single approve fires no GET /api/review');
  ok((await page.locator('#review-list .review-item').count()) === before - 1,
    'A: single approve drops the row locally');
  ok(!(await page.locator('#review-list').innerText()).includes('Loading'),
    'A: single approve shows no Loading placeholder');
  const touched = ['/api/tags', '/api/users', '/api/users?type=audit_logs', '/api/countries', '/api/pageview?action=stats']
    .filter((k) => (counter.counts[k] || 0) !== (snapshot[k] || 0));
  ok(touched.length === 0, 'A: approve touches no other module', touched);

  // ── the sibling filter was invalidated, so it refetches once on next visit ─
  const apprBefore = counter.counts['/api/review?status=approved'] || 0;
  await page.click('#status-tabs .review-tab[data-status="approved"]');
  await page.waitForTimeout(400);
  const apprAfter = counter.counts['/api/review?status=approved'] || 0;
  ok(apprAfter - apprBefore === 1, 'A: the sibling filter refetches once after an approve', apprAfter - apprBefore);
  await page.click('#status-tabs .review-tab[data-status="pending"]');
  await page.waitForTimeout(250);
  await page.click('#status-tabs .review-tab[data-status="approved"]');
  await page.waitForTimeout(400);
  ok((counter.counts['/api/review?status=approved'] || 0) === apprAfter,
    'A: and then settles back onto the cache');

  // ── batch approve: every selected row goes at once, still zero network ─────
  await page.click('#status-tabs .review-tab[data-status="pending"]');
  await page.waitForTimeout(300);
  await page.click('#review-reload-btn');
  await page.waitForTimeout(500);
  const batchRequests = counter.counts['/api/review?status=pending'] || 0;
  const boxes = page.locator('#review-list .review-item__checkbox input');
  const boxCount = await boxes.count();
  for (let i = 0; i < boxCount; i++) await boxes.nth(i).check();
  await page.waitForTimeout(200);
  await page.click('#batch-approve-btn');
  await page.waitForTimeout(600);
  ok((counter.counts['/api/review?status=pending'] || 0) === batchRequests, 'A: batch approve fires no GET /api/review');
  ok((await page.locator('#review-list .review-item').count()) === 0,
    'A: batch approve drops every selected row',
    await page.locator('#review-list .review-item').count());

  // ── every module has a Reload that really refetches ───────────────────────
  // countries is 2: it invalidates countries + both proposals keys, and the reload refetches
  // countries itself and its proposals table (same URL, so the counter sees 2).
  const reloads = [
    ['users-reload-btn', '/api/users', 'users', 1],
    ['audit-reload-btn', '/api/users?type=audit_logs', 'audit', 1],
    ['notes-reload-btn', '/api/review?status=pending', 'notes', 1],
    ['analytics-reload-btn', '/api/pageview?action=stats', 'analytics', 1],
    ['tags-reload-btn', '/api/tags', 'tags', 1],
    ['countries-reload-btn', '/api/countries', 'countries', 2],
  ];
  for (const [btnId, key, mod, expected] of reloads) {
    await page.click(`#primary-tabs .review-tab[data-module="${mod}"]`);
    await page.waitForTimeout(300);
    const b = counter.counts[key] || 0;
    await page.click('#' + btnId);
    await page.waitForTimeout(500);
    ok((counter.counts[key] || 0) - b === expected, `A: ${btnId} forces a refetch`, (counter.counts[key] || 0) - b);
  }
  await page.click('#primary-tabs .review-tab[data-module="submissions"]');
  await page.waitForTimeout(300);
  await page.click('#status-tabs .review-tab[data-status="pending"]');
  await page.waitForTimeout(300);
  const rb = counter.counts['/api/review?status=pending'] || 0;
  await page.click('#review-reload-btn');
  await page.waitForTimeout(500);
  ok((counter.counts['/api/review?status=pending'] || 0) - rb === 1,
    'A: #review-reload-btn really refetches (it used to serve stale cache)');

  // ── a failed load must not be cached, or the retry never happens ──────────
  // 失败必须发生在**点击时**。预加载在页面解析期就打出去了；如果一开始就让它失败，等我们点
  // Users 时它早已重新取成功，这条断言就变成测空气。
  const failOpts = { failUsers: false };
  const counter2 = makeCounter();
  const second = await newPage(browser, counter2, failOpts);
  await second.page.waitForTimeout(400);
  await second.page.click('#primary-tabs .review-tab[data-module="users"]');
  await second.page.waitForSelector('#user-grid > *', { timeout: 10000 });

  failOpts.failUsers = true;                        // 下一次 users 请求返回 500
  await second.page.click('#users-reload-btn');     // 强制重取 → 失败
  await second.page.waitForTimeout(700);
  ok((await second.page.locator('#user-grid').innerText()).includes('Load failed'),
    'A: a failed load shows a visible error, not an endless Loading');
  await second.page.click('#primary-tabs .review-tab[data-module="submissions"]');
  await second.page.waitForTimeout(200);
  const usersPre = counter2.counts['/api/users'] || 0;
  await second.page.click('#primary-tabs .review-tab[data-module="users"]');
  await second.page.waitForTimeout(700);
  ok((counter2.counts['/api/users'] || 0) - usersPre === 1, 'A: the failure was not cached — returning retries');
  ok((await second.page.locator('#user-grid').innerText()).includes('tester'), 'A: and the retry renders');

  // ── section B: the mini-map waits for Leaflet instead of racing it ────────
  const counter3 = makeCounter();
  const third = await newPage(browser, counter3, { lateLeaflet: true, withGeometry: true });
  await third.page.waitForTimeout(600);   // 列表已渲染、观察者已触发；Leaflet 还没到
  ok(!(await third.page.evaluate(() => !!document.querySelector('#review-list .review-item__map.leaflet-container'))),
    'B: no mini-map is drawn before Leaflet exists (the old code threw here and gave up)');
  await third.page.waitForTimeout(3500);  // 等那个晚到的桩交付
  ok(await third.page.evaluate(() => !!document.querySelector('#review-list .review-item__map.leaflet-container')),
    'B: mini-map still renders when Leaflet arrives late');
  ok(third.realErrors().length === 0, 'B: no uncaught page errors', third.realErrors().slice(0, 3));

  // ── section C: Analytics draws with a lazily-loaded library ───────────────
  // The module used to fire `_loadScript(Chart.js)` and then construct `new Chart(...)` inside a
  // promise that was in no way ordered against it. When the library lost that race — slow or
  // unreachable CDN, and cdnjs is unreachable for a lot of users — the ReferenceError was swallowed
  // by a bare console.error. Because the summary cards are assigned *before* the chart block and
  // Top Pages / Visitors / Recent are assigned *after* it, only the top half of the panel painted.
  // Reload could not recover either: `_loadScript` cached the rejected promise forever, so the
  // second attempt never even re-requested the script.
  //
  // **Red checks:** drop the `chartReady` await → C3 goes red (the tables go down with the charts);
  // remove the `delete _scriptCache[src]` in `_loadScript` → C4 goes red; drop the error banner →
  // C5 goes red.

  // C1/C2 — the library never arrives. The tables must still render, and each chart slot must say
  // why it is empty instead of leaving a blank box behind.
  const counterA = makeCounter();
  const an = await newPage(browser, counterA, {});
  await an.page.click('#primary-tabs .review-tab[data-module="analytics"]');
  await an.page.waitForTimeout(1000);
  ok((await an.page.locator('#top-pages-list').innerText()).includes('/explore'),
    'C: Top Pages renders even though Chart.js never loaded',
    JSON.stringify(await an.page.locator('#top-pages-list').innerText()));
  ok((await an.page.locator('#visitors-tbody tr').count()) === 1,
    'C: the visitors table renders too',
    await an.page.locator('#visitors-tbody tr').count());
  ok((await an.page.locator('#analytics-panel .analytics-chart-note').count()) === 2,
    'C: both chart slots explain themselves instead of staying blank',
    await an.page.locator('#analytics-panel .analytics-chart-note').count());
  ok((await an.page.locator('#stat-total').innerText()).trim() === '15', 'C: the summary cards still fill in');
  ok(!(await an.page.locator('#analytics-error').isVisible()),
    'C: no error banner when the stats call succeeded (the banner is not always-on)');

  // C3 — the library arrives, but only well after the JSON did. Nothing may be half-rendered.
  const counterB = makeCounter();
  const slow = await newPage(browser, counterB, { chart: true, chartDelay: 2000 });
  await slow.page.click('#primary-tabs .review-tab[data-module="analytics"]');
  await slow.page.waitForTimeout(4500);   // comfortably past the delayed delivery
  ok((await slow.page.evaluate(() => (window.__chartCalls || []).length)) === 2,
    'C: a chart library that arrives late is still awaited — both charts get drawn',
    await slow.page.evaluate(() => (window.__chartCalls || []).length));
  ok((await slow.page.locator('#top-pages-list').innerText()).includes('/explore'),
    'C: and the tables are there too — the panel is never half-rendered');
  ok((await slow.page.locator('.analytics-chart-note').count()) === 0,
    'C: no stale "library missing" note once the library lands');

  // C4 — a failed fetch of the library must not poison every later attempt.
  // The first two requests fail (page-entry preload, then the one the tab-open makes); the third —
  // the one the Reload button triggers — must actually go out and succeed. If `_loadScript` keeps
  // the rejected promise, hit 2 never even happens and Reload can never recover.
  const counterC = makeCounter();
  const retryOpts = { chart: true, chartFailHits: 2 };
  const retry = await newPage(browser, counterC, retryOpts);
  await retry.page.click('#primary-tabs .review-tab[data-module="analytics"]');
  await retry.page.waitForTimeout(1000);
  ok((await retry.page.locator('.analytics-chart-note').count()) === 2,
    'C: a library that failed twice leaves both chart slots explaining themselves',
    await retry.page.locator('.analytics-chart-note').count());
  ok((await retry.page.locator('#top-pages-list').innerText()).includes('/explore'),
    'C: and the tables are unaffected by the missing library');
  const hitsBefore = retryOpts.chartHits;   // 2 — the failed attempts did reach the network
  await retry.page.click('#analytics-reload-btn');
  await retry.page.waitForTimeout(1500);
  ok(retryOpts.chartHits === hitsBefore + 1,
    'C: Reload actually re-requests the library (a rejected promise must not be cached)',
    [hitsBefore, retryOpts.chartHits]);
  ok((await retry.page.evaluate(() => (window.__chartCalls || []).length)) === 2,
    'C: and the retry recovers — the charts are drawn',
    await retry.page.evaluate(() => (window.__chartCalls || []).length));
  ok((await retry.page.locator('.analytics-chart-note').count()) === 0,
    'C: the "library missing" notes are cleared once it works');

  // C5 — a failed stats fetch says so, instead of a console.error nobody sees.
  const counterD = makeCounter();
  const statsOpts = { chart: true, failStats: false };
  const stats = await newPage(browser, counterD, statsOpts);
  await stats.page.click('#primary-tabs .review-tab[data-module="analytics"]');
  await stats.page.waitForTimeout(700);
  statsOpts.failStats = true;             // the next stats request returns 500
  await stats.page.click('#analytics-reload-btn');
  await stats.page.waitForTimeout(900);
  // Guard the text read: on the unfixed page the element does not exist at all, and a bare
  // `.innerText()` would blow the harness up with a 30s timeout instead of reporting a red line.
  const banner = stats.page.locator('#analytics-error');
  const bannerText = (await banner.count()) ? (await banner.innerText()).trim() : '';
  ok(bannerText.length > 0, 'C: a failed stats fetch shows a visible error in the panel', bannerText);
  ok(!(await stats.page.locator('#analytics-loading').isVisible()),
    'C: and the spinner is not left running');

  ok(realErrors().length === 0, 'A: no uncaught page errors', realErrors().slice(0, 3));

  await browser.close();
  console.log(fails === 0 ? '\n== ALL PASS' : `\n== ${fails} FAILURE(S)`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH:', e.message); process.exit(2); });

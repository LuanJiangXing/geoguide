// Playwright harness for two things:
//   1. profile.html favorites empty state links to the homepage, not /explore
//   2. review.html "+ Add Country" prefills name / flag / bounds from the country ID
// Usage: node scripts/test-country-prefill.js
// Requires a dev server serving public/ (default http://localhost:3000, override with BASE_URL).
// All /api/* calls are route-mocked, so no login or database is needed.
const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

let fails = 0;
const ok = (cond, label, extra) => {
  if (!cond) fails++;
  console.log((cond ? 'PASS ' : 'FAIL ') + label + (extra !== undefined ? '  ' + JSON.stringify(extra) : ''));
};

const COUNTRIES = JSON.stringify({
  is_super_admin: true,
  countries: [
    { id: 'south-africa', name: 'South Africa', flag: 'za', bounds_sw: [-34.5, 17.0], bounds_ne: [-22.5, 32.5], active: true, sort_order: 0, region_count: 6 },
    { id: 'paraguay', name: 'Paraguay', flag: 'py', bounds_sw: [-27.6, -62.6], bounds_ne: [-19.3, -54.3], active: true, sort_order: 1, region_count: 2 }
  ]
});

(async () => {
  const browser = await firefox.launch({ headless: true });

  // ---------- 1) profile.html favorites empty state ----------
  console.log('--- 1) profile favorites empty state ---');
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('/api/')) {
        if (u.includes('/api/auth')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"u1","username":"tester","role":"user"}}' });
        if (u.includes('/api/reactions') && u.includes('action=favorites')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"regions":[]}' });
        if (u.includes('/api/reactions')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        if (u.includes('/api/profile')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'u1', username: 'tester', role: 'user' }, stats: { total: 0, approved: 0, pending: 0, rejected: 0, hidden: 0, trash: 0 }, rank: { position: null, total_contributors: 0 }, notes: [] }) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (/\.(png|jpg|jpeg)(\?|$)/.test(u)) return route.abort();
      return route.continue();
    });
    await page.goto(BASE + '/profile.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => {
      const l = document.getElementById('favorites-list');
      return l && l.querySelector('a');
    }, null, { timeout: 20000 });

    const info = await page.evaluate(() => {
      const a = document.querySelector('#favorites-list a');
      return { href: a.getAttribute('href'), resolved: a.href };
    });
    // /explore 没有 country 参数时 app.js 会兜底到南非，所以空状态必须指向首页
    ok(info.href === '/', '空收藏时 map 链接指向首页 /', { href: info.href });
    ok(!/explore/.test(info.href), '不再指向 /explore（原会兜底到南非）', { href: info.href });
    ok(errs.length === 0, '无 JS 报错', errs);
    await page.close();
  }

  // ---------- 2) review.html country prefill ----------
  console.log('--- 2) review.html add-country prefill ---');
  {
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message.slice(0, 200)));
    await page.route('**/*', (route) => {
      const u = route.request().url();
      if (u.includes('/api/')) {
        if (u.includes('/api/auth')) {
          if (route.request().method() === 'POST') return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":{"id":"u1","username":"admin","role":"admin"}}' });
        }
        if (u.includes('/api/countries')) return route.fulfill({ status: 200, contentType: 'application/json', body: COUNTRIES });
        if (u.includes('/api/review')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ submissions: [], total: 0 }) });
        if (u.includes('/api/submissions')) return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        if (u.includes('/api/tags')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"categories":[]}' });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
      if (/\.(png|jpg|jpeg)(\?|$)/.test(u)) return route.abort();
      return route.continue();
    });

    await page.goto(BASE + '/review.html', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#admin-password-input', { timeout: 20000 });
    await page.fill('#admin-password-input', 'pw');
    await page.click('#admin-password-submit');
    await page.waitForFunction(() => document.getElementById('review-main') && !document.getElementById('review-main').hidden, null, { timeout: 20000 });
    await page.click('#primary-tabs .review-tab[data-module="countries"]');
    await page.waitForFunction(() => !document.getElementById('country-manager').hidden, null, { timeout: 10000 });
    await page.click('#add-country-btn');
    await page.waitForFunction(() => document.getElementById('country-form-row').style.display !== 'none', null, { timeout: 5000 });

    const read = () => page.evaluate(() => {
      const v = (id) => document.getElementById(id).value;
      const h = document.getElementById('cf-prefill-hint');   // 修复前不存在，别让探针挂掉
      return {
        id: v('cf-id'), name: v('cf-name'), flag: v('cf-flag'),
        sw: [v('cf-sw-lat'), v('cf-sw-lng')], ne: [v('cf-ne-lat'), v('cf-ne-lng')],
        hint: h ? h.textContent : null
      };
    });
    const reopen = async () => { await page.click('#cf-cancel-btn'); await page.click('#add-country-btn'); };
    const typeId = async (v) => { await page.fill('#cf-id', v); await page.waitForTimeout(600); };

    await typeId('china');
    let s = await read();
    ok(s.name === 'China', 'china → name 自动填成 China', { name: s.name });
    ok(s.flag === 'cn', 'china → flag 自动填成 cn', { flag: s.flag });
    ok(s.sw[0] === '20.26' && s.sw[1] === '73.61' && s.ne[0] === '53.56' && s.ne[1] === '134.75', 'china → swne 四格都填上', { sw: s.sw, ne: s.ne });
    ok(/Prefilled/.test(s.hint), '有预填提示', { hint: s.hint });

    // 上游 name.common 已改成 Türkiye，按旧名搜仍要命中
    await reopen(); await typeId('turkey');
    s = await read();
    ok(s.name === 'Türkiye' && s.flag === 'tr', 'turkey（上游已改名 Türkiye）仍能命中', { name: s.name, flag: s.flag });

    await reopen(); await typeId('jp');
    s = await read();
    ok(s.name === 'Japan' && s.flag === 'jp', '输入 ISO2「jp」也能命中', { name: s.name, flag: s.flag });

    await reopen(); await typeId('South Africa');
    s = await read();
    ok(s.name === 'South Africa' && s.flag === 'za', '"South Africa"（带空格）也命中', { name: s.name, flag: s.flag });

    // 手改过的字段不能被后来的预填冲掉
    await reopen(); await typeId('china');
    await page.fill('#cf-name', 'My Custom China');
    await typeId('japan');
    s = await read();
    ok(s.name === 'My Custom China', '手改过的 name 不被预填覆盖', { name: s.name });
    ok(s.flag === 'jp', '未手改的 flag 跟着新 ID 更新', { flag: s.flag });

    // 回归：马来西亚被南海切成两半，纯距离阈值会把半岛丢掉，只剩婆罗洲
    await reopen(); await typeId('malaysia');
    s = await read();
    ok(Number(s.sw[1]) < 105 && Number(s.ne[1]) > 115,
      'malaysia 的框同时覆盖半岛(<105E)和婆罗洲(>115E)', { sw: s.sw, ne: s.ne });
    ok(Number(s.ne[0]) > 6 && Number(s.sw[0]) < 2, 'malaysia 南北范围完整', { sw: s.sw, ne: s.ne });

    // 回归：挪威的框不该被链式并入的斯瓦尔巴(80.5N)撑到北极圈
    await reopen(); await typeId('norway');
    s = await read();
    ok(Number(s.ne[0]) < 72, 'norway 不含斯瓦尔巴（北界在 72N 以内）', { ne: s.ne });

    await reopen(); await typeId('hawaii');
    s = await read();
    ok(s.name === '' && s.flag === '', '查不到的国家不填任何值', { name: s.name, flag: s.flag });
    ok(/No match/.test(s.hint), '查不到时明确提示', { hint: s.hint });

    // 编辑已有国家：ID 框禁用，预填不该改到既有数据
    await page.click('#cf-cancel-btn');
    await page.click('#country-table-body tr[data-country-id="paraguay"] button.review-btn--undo');
    await page.waitForTimeout(400);
    s = await read();
    ok(s.name === 'Paraguay' && s.flag === 'py' && s.sw[0] === '-27.6', '编辑态回填的是该国家自身的值', { name: s.name, flag: s.flag, sw: s.sw });
    ok((await page.evaluate(() => document.getElementById('cf-id').disabled)) === true, '编辑态 ID 框禁用（预填不会改到已有国家）');

    ok(errs.length === 0, '无 JS 报错', errs);
    await page.close();
  }

  await browser.close();
  console.log(fails ? ('\n== FAILURES: ' + fails) : '\n== ALL PASS');
  process.exit(fails ? 1 : 0);
})();

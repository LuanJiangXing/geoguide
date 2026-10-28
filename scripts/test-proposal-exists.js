// Playwright harness for the "mark proposal as already-exists" feature.
// Usage: node scripts/test-proposal-exists.js <render-pending|render-exists|mark-action|empty>
// Requires the dev server on http://localhost:3000 (check: curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/review)
const { firefox } = require('playwright');
const MODE = process.argv[2] || 'render-pending';

const MOCK_PROPOSALS = [
  { proposed_name: 'MockLand', proposal_type: 'country', votes: 3, proposers: 'alice, bob', provide_count: 1, learn_count: 1, unknown_count: 1, latest: '2026-08-17T00:00:00.000Z' }
];

(async () => {
  const browser = await firefox.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.goto('http://localhost:3000/review', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // The proposal functions are globals; wait until the inline script defines them.
  await page.waitForFunction(() =>
    typeof window.renderProposals === 'function' &&
    typeof window.loadProposals === 'function' &&
    typeof window.setProposalStatus === 'function', null, { timeout: 15000 });

  // Neutralize page-load preloads so loadProposals exercises its own fetch path.
  await page.evaluate(() => { window._preload = {}; });

  let pass = false;

  if (MODE === 'render-pending') {
    await page.evaluate((proposals) => {
      window.fetch = function () {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ country_proposals: proposals }) });
      };
      loadProposals('pending');
    }, MOCK_PROPOSALS);
    await page.waitForFunction(() => {
      const b = document.getElementById('country-proposals-body');
      return b && b.textContent.indexOf('MockLand') !== -1;
    }, null, { timeout: 10000 });
    pass = await page.evaluate(() => {
      const b = document.getElementById('country-proposals-body');
      return b.textContent.indexOf('Mark as exists') !== -1 && b.textContent.indexOf('Undo') === -1;
    });
  } else if (MODE === 'render-exists') {
    await page.evaluate((proposals) => {
      window.fetch = function () {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ country_proposals: proposals }) });
      };
      loadProposals('exists');
    }, MOCK_PROPOSALS);
    await page.waitForFunction(() => {
      const b = document.getElementById('country-proposals-body');
      return b && b.textContent.indexOf('MockLand') !== -1;
    }, null, { timeout: 10000 });
    pass = await page.evaluate(() => {
      const b = document.getElementById('country-proposals-body');
      return b.textContent.indexOf('Undo') !== -1 && b.textContent.indexOf('Mark as exists') === -1;
    });
  } else if (MODE === 'mark-action') {
    await page.evaluate(() => {
      window.__requests = [];
      window.fetch = function (url, opts) {
        window.__requests.push({ url: String(url), method: (opts && opts.method) || 'GET', body: (opts && opts.body) ? JSON.parse(opts.body) : null });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, country_proposals: [] }) });
      };
      setProposalStatus('MockLand', 'country', 'exists');
    });
    await page.waitForFunction(() => window.__requests && window.__requests.length >= 2, null, { timeout: 10000 });
    pass = await page.evaluate(() => {
      const reqs = window.__requests || [];
      const patch = reqs.find(r => r.method === 'PATCH');
      const reload = reqs.find(r => r.method === 'GET' && r.url.indexOf('proposal_status=pending') !== -1);
      return !!patch && patch.url.indexOf('/api/countries') !== -1 &&
        patch.body && patch.body.action === 'proposal_set_status' &&
        patch.body.proposed_name === 'MockLand' && patch.body.proposal_type === 'country' &&
        patch.body.status === 'exists' && !!reload;
    });
  } else if (MODE === 'empty') {
    await page.evaluate(() => {
      window.fetch = function () {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ country_proposals: [] }) });
      };
      loadProposals('pending');
    });
    await page.waitForFunction(() => {
      const b = document.getElementById('country-proposals-body');
      return b && b.textContent.indexOf('No pending proposals') !== -1;
    }, null, { timeout: 10000 });
    pass = await page.evaluate(() => {
      const w = document.getElementById('country-proposals-wrapper');
      return w && w.hidden === false;
    });
  }

  console.log((pass ? 'PASS' : 'FAIL'), MODE);
  await browser.close();
  process.exit(pass ? 0 : 1);
})();

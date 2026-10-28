// Regression test for the lingering batch bar in public/review.html.
//
// SYMPTOM (as reported): tick "Select All" on the pending tab, do NOT press the batch
// Approve, then approve one item on its own. The "N selected" bar stays on screen.
//
// TWO defects, both fixed here:
//
//   1. Policy. `reviewAction` (single approve / reject / undo) was the only path that
//      mutated the list without calling `clearBatchSelection()` — tab switches, the
//      country filter, and the batch approve/reject paths all did. An earlier fix
//      (f7153b9) reconciled the model, the checkboxes and Select All, which made the
//      three agree with each other but left the bar itself on screen. Acting on a single
//      item now ends the multi-select context and drops the whole selection.
//
//   2. A missed exit. `loadSubmissions()` has FOUR exits and only three reconciled.
//      The `!hasSubmissions && !hasPendingTags` early return — the common "the list is
//      now empty" one — was skipped, so the bar kept its last count over zero rows and
//      could not clear itself. Defect 1 masks this today (the selection is empty by the
//      time that branch runs), but the invariant belongs to the render, not the caller:
//      any future path that empties the list without clearing first would hit it again.
//
// The assertions are policy-specific on purpose. Preserve-or-clear used to be an open
// question; it is settled (clear), so this test pins it rather than straddling it.
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-review-batch-selection.js
//   kill $(lsof -ti :3999)
'use strict';

const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3999';
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL'), name + (detail === undefined ? '' : ' — ' + detail));
}

function submission(id, name) {
  return {
    id: id, name: name, description: 'd', tags: [], status: 'pending',
    country_id: 'south-africa', link: 'https://maps.app.goo.gl/' + id, submitted_by: 'tester',
    detailed_description: '', useless_count: 0, wrong_count: 0, error_count: 0,
    source_type: '', source_url: ''
  };
}

const MOCK_COUNTRIES = {
  countries: [{
    id: 'south-africa', name: 'South Africa', flag: 'za',
    bounds_sw: [-35, 16], bounds_ne: [-22, 33], active: 1, sort_order: 1, region_count: 3
  }]
};

// Stateful: the single approve must actually remove its item from the next GET, otherwise
// the re-render would not happen and there would be nothing to desync.
let pending = [submission('sub-1', 'One'), submission('sub-2', 'Two'), submission('sub-3', 'Three')];
let patchCount = 0;

async function installRoutes(context) {
  await context.route('**/*', function (route) {
    const req = route.request();
    const url = req.url();
    const json = function (body) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    };

    if (/\/api\/countries(\?|$)/.test(url)) return json(MOCK_COUNTRIES);
    if (/\/api\/auth(\?|$)/.test(url)) {
      return json({ user: { id: 1, username: 'tester', display_name: 'Tester', role: 'admin' } });
    }
    if (/\/api\/review(\?|$)/.test(url)) {
      if (req.method() === 'PATCH') {
        patchCount++;
        let body = {};
        try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
        // Single reviewAction sends { id, status }; the batch sends { action, ids, ... }.
        if (body.id && body.status === 'approved') {
          pending = pending.filter(function (s) { return s.id !== body.id; });
        }
        return json({ success: true });
      }
      return json({ submissions: pending, pending_tags: [] });
    }
    if (/\/data\/changelog\.json/.test(url)) return json([]);
    // Every other /api/* call must still answer with JSON — a 404 HTML page would make
    // `response.json()` throw inside the page and muddy the failure.
    if (url.indexOf('/api/') !== -1) return json({});
    return route.continue();
  });
}

async function snapshot(page) {
  return page.evaluate(function () {
    var cbs = document.querySelectorAll('#review-list .review-item__checkbox input');
    var checked = document.querySelectorAll('#review-list .review-item__checkbox input:checked');
    var bar = document.getElementById('batch-bar');
    var countText = document.getElementById('batch-count').textContent || '';
    var m = countText.match(/(\d+)/);
    return {
      items: document.querySelectorAll('#review-list .review-item').length,
      checkboxes: cbs.length,
      checked: checked.length,
      barVisible: !bar.hidden,
      barText: countText.trim(),
      barCount: m ? parseInt(m[1], 10) : null,
      selectAllChecked: document.getElementById('select-all-checkbox').checked
    };
  });
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  await installRoutes(context);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', function (err) { pageErrors.push(String((err && err.message) || err)); });

  await page.goto(BASE + '/review.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.loadSubmissions === 'function'; }, null, { timeout: 15000 });
  await page.evaluate(function () {
    var pw = document.getElementById('admin-password-input');
    if (pw) pw.value = 'harness';
    document.getElementById('admin-password-submit').click();
  });
  await page.waitForSelector('#review-list .review-item__checkbox', { timeout: 15000 });

  // --- Baseline: Select All on its own must be self-consistent ------------------
  await page.evaluate(function () {
    document.getElementById('select-all-checkbox').click();
  });
  const before = await snapshot(page);
  check('B1 Select All ticks every row', before.checkboxes === 3 && before.checked === 3, JSON.stringify(before));
  check('B2 Select All shows the batch bar with the right count',
    before.barVisible && before.barCount === 3, JSON.stringify(before));
  check('B3 Select All leaves its own box ticked', before.selectAllChecked === true);

  // --- The repro: approve ONE item while all three are selected -----------------
  await page.evaluate(function () {
    var card = document.querySelector('#review-list .review-item');
    var approve = Array.prototype.find.call(card.querySelectorAll('button'), function (b) {
      return b.textContent.trim() === 'Approve';
    });
    approve.click();
  });
  await page.waitForFunction(function () {
    return document.querySelectorAll('#review-list .review-item').length === 2;
  }, null, { timeout: 15000 });
  // The re-render is synchronous inside loadSubmissions, but give the bar a tick to settle.
  await page.waitForFunction(function () {
    return document.querySelectorAll('#review-list .review-item__checkbox').length === 2;
  }, null, { timeout: 15000 });

  const after = await snapshot(page);
  check('R0 the single approve hit the API and the list re-rendered',
    patchCount === 1 && after.items === 2, 'patch=' + patchCount + ' items=' + after.items);

  // --- The reported symptom: the bar must not outlive the action -----------------
  check('P1 a single approve drops every tick', after.checked === 0, JSON.stringify(after));
  check('P2 a single approve hides the batch bar', after.barVisible === false, JSON.stringify(after));
  check('P3 a single approve unticks Select All', after.selectAllChecked === false, JSON.stringify(after));

  // --- Ticking still works after the clear (the bar must come back) --------------
  await page.evaluate(function () {
    document.querySelectorAll('#review-list .review-item__checkbox input')[0].click();
  });
  const ticked = await snapshot(page);
  check('P4 ticking one row after the clear reports a real count',
    ticked.barVisible === true && ticked.barCount === 1 && ticked.checked === 1,
    JSON.stringify(ticked));

  // --- Clear must leave every surface agreeing ----------------------------------
  await page.evaluate(function () {
    document.getElementById('batch-clear-btn').click();
  });
  const cleared = await snapshot(page);
  check('I5 Clear leaves nothing selected anywhere',
    cleared.checked === 0 && !cleared.barVisible && cleared.selectAllChecked === false,
    JSON.stringify(cleared));

  // --- The empty-list exit must reconcile too -----------------------------------
  await page.evaluate(function () {
    document.getElementById('select-all-checkbox').click();
  });
  const reselected = await snapshot(page);
  check('E0 Select All re-ticked the remaining rows',
    reselected.checked === 2 && reselected.barVisible === true, JSON.stringify(reselected));

  // Approve the rest one at a time. The last one empties the list and takes the
  // `!hasSubmissions && !hasPendingTags` early return — the exit that used to skip the
  // reconciler and leave the bar frozen over zero rows.
  for (var guard = 0; guard < 5; guard++) {
    const now = await snapshot(page);
    if (now.items === 0) break;
    await page.evaluate(function () {
      var card = document.querySelector('#review-list .review-item');
      var approve = Array.prototype.find.call(card.querySelectorAll('button'), function (b) {
        return b.textContent.trim() === 'Approve';
      });
      approve.click();
    });
    await page.waitForTimeout(400);
  }
  const emptied = await snapshot(page);
  check('E1 an emptied list hides the bar',
    emptied.items === 0 && emptied.barVisible === false, JSON.stringify(emptied));
  check('E2 an emptied list leaves no stale count behind',
    emptied.barCount === 0 && emptied.barText === '0 selected', JSON.stringify(emptied));
  check('E3 an emptied list unticks Select All', emptied.selectAllChecked === false, JSON.stringify(emptied));

  check('D1 no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  console.log(failures ? ('\n== FAILURES: ' + failures) : '\n== ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch(function (e) { console.error(e); process.exit(1); });

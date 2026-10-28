// Playwright harness for the submission source attribution feature (front-end half).
//
//   A. buildSourceBadge() contract (public/js/utils.js)
//   B. homepage Most Useful card structure — no nested <a>, badge sits above the
//      overlay link and is the element actually hit at its own centre
//   C. submit page source picker — chip toggle, live validation, and the
//      "invalid source blocks submission" rule (no request leaves the page)
//
// Usage:
//   python3 -m http.server 3999 -d public &
//   node scripts/test-source-badge.js
//   kill $(lsof -ti :3999)
//
// The API is mocked: this sandbox has no Turso credentials, so nothing here
// proves real backend behaviour — only the client-side rendering/validation.
const { firefox } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3999';
let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log((ok ? 'PASS' : 'FAIL'), name + (detail === undefined ? '' : ' — ' + detail));
}

const MOCK_SUBMISSIONS = [
  {
    id: 'sub-1', name: 'Mock One', description: 'has a source', tags: [],
    geojson: {}, streetview: {}, link: 'https://maps.app.goo.gl/x',
    country_id: 'south-africa', created_at: '2026-01-01', submitted_by: 'tester',
    detailed_description: '', source_type: 'other', source_url: 'https://example.com/page'
  },
  {
    id: 'sub-2', name: 'Mock Two', description: 'no source', tags: [],
    geojson: {}, streetview: {}, link: 'https://maps.app.goo.gl/y',
    country_id: 'south-africa', created_at: '2026-01-02', submitted_by: 'tester',
    detailed_description: '', source_type: '', source_url: ''
  }
];
const MOCK_COUNTRIES = {
  countries: [{
    id: 'south-africa', name: 'South Africa', flag: 'za',
    bounds_sw: [-35, 16], bounds_ne: [-22, 33], active: 1, sort_order: 1, region_count: 2
  }]
};
// Shape expected by public/my-submissions.html's loadTab()
const MOCK_USER_SUBMISSIONS = [
  {
    id: 'sub-1', name: 'Mock One', description: 'has a source', tags: [], status: 'approved',
    country_id: 'south-africa', created_at: '2026-01-01', useful_count: 0, useless_count: 0,
    is_hidden: 0, is_deleted: 0, source_type: 'other', source_url: 'https://example.com/page'
  },
  {
    id: 'sub-2', name: 'Mock Two', description: 'no source', tags: [], status: 'approved',
    country_id: 'south-africa', created_at: '2026-01-02', useful_count: 0, useless_count: 0,
    is_hidden: 0, is_deleted: 0, source_type: '', source_url: ''
  }
];
// Shape expected by public/review.html's loadSubmissions()
const MOCK_REVIEW_SUBMISSIONS = [
  {
    id: 'sub-1', name: 'Mock One', description: 'has a source', tags: [], status: 'pending',
    country_id: 'south-africa', link: 'https://maps.app.goo.gl/x', submitted_by: 'tester',
    detailed_description: '', useless_count: 0, wrong_count: 0, error_count: 0,
    source_type: 'plonkit', source_url: 'https://www.plonkit.net/brazil'
  },
  {
    id: 'sub-2', name: 'Mock Two', description: 'no source', tags: [], status: 'pending',
    country_id: 'south-africa', link: 'https://maps.app.goo.gl/y', submitted_by: 'tester',
    detailed_description: '', useless_count: 0, wrong_count: 0, error_count: 0,
    source_type: '', source_url: ''
  }
];
const MOCK_REACTIONS = {
  regions: [
    { region_id: 'sub-1', name: 'Mock One', country_id: 'south-africa', useful_count: 9 },
    { region_id: 'sub-2', name: 'Mock Two', country_id: 'south-africa', useful_count: 7 }
  ]
};

let submitPostCount = 0;

async function installRoutes(context) {
  await context.route('**/*', function (route) {
    const req = route.request();
    const url = req.url();
    const json = function (body) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    };
    if (/\/api\/countries(\?|$)/.test(url)) return json(MOCK_COUNTRIES);
    if (/\/api\/reactions\?action=top/.test(url)) return json(MOCK_REACTIONS);
    if (/\/api\/reactions\?region_id=/.test(url)) {
      return json({ useful_count: 0, useless_count: 0, wrong_count: 0, favorited: false, authenticated: false });
    }
    if (/\/api\/submissions\?action=contributors/.test(url)) return json({ contributors: [] });
    if (/\/api\/submissions(\?|$)/.test(url)) return json(MOCK_SUBMISSIONS);
    if (/\/api\/user-submissions\?status=/.test(url)) {
      return json({ submissions: MOCK_USER_SUBMISSIONS, total: MOCK_USER_SUBMISSIONS.length });
    }
    if (/\/api\/review\?status=/.test(url)) {
      return json({ submissions: MOCK_REVIEW_SUBMISSIONS, pending_tags: [] });
    }
    if (/\/api\/auth(\?|$)/.test(url)) {
      return json({ user: { id: 1, username: 'tester', display_name: 'Tester', role: 'admin' } });
    }
    if (/\/data\/changelog\.json/.test(url)) return json([]);
    if (/\/api\/submit(\?|$)/.test(url)) {
      if (req.method() === 'POST') submitPostCount++;
      return json({ success: true });
    }
    // Every other /api/* call must still get JSON — otherwise the static server
    // answers with a 404 HTML page and `response.json()` throws.
    if (url.indexOf('/api/') !== -1) return json({});
    if (url.indexOf(BASE) === 0) return route.continue();   // page assets
    return route.continue();                                // unpkg / flagcdn / tiles
  });
}

(async () => {
  const browser = await firefox.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
  await installRoutes(context);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', function (err) { pageErrors.push(String(err && err.message || err)); });

  // ---------------------------------------------------------------- A + B
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.buildSourceBadge === 'function'; }, null, { timeout: 15000 });

  // --- A. pure function contract -----------------------------------------
  const a = await page.evaluate(function () {
    function probe(type, url) {
      const el = buildSourceBadge(type, url);
      if (!el) return { el: null };
      const img = el.querySelector('img');
      return {
        el: el.tagName,
        cls: el.className,
        href: el.getAttribute('href'),
        target: el.getAttribute('target'),
        rel: el.getAttribute('rel'),
        aria: el.getAttribute('aria-label') || '',
        text: el.textContent.trim(),
        hasImg: !!img,
        imgAlt: img ? img.getAttribute('alt') : null,
        imgAriaHidden: img ? img.getAttribute('aria-hidden') : null,
        imgSrc: img ? img.getAttribute('src') : null
      };
    }
    // Broken icon must fall back to text, never an alt="" broken img.
    var broken = buildSourceBadge('plonkit', 'https://www.plonkit.net/brazil');
    var brokenImg = broken.querySelector('img');
    brokenImg.dispatchEvent(new Event('error'));
    var fallback = {
      noImgLeft: !broken.querySelector('img'),
      text: broken.textContent.trim(),
      nameStillThere: !!broken.getAttribute('aria-label')
    };
    return {
      emptyType: buildSourceBadge('', 'https://example.com/x'),
      emptyUrl: buildSourceBadge('plonkit', ''),
      bothEmpty: buildSourceBadge('', ''),
      unknownType: buildSourceBadge('bogus', 'https://example.com/x'),
      wrongDomain: probe('plonkit', 'https://evil.example.com/x'),
      jsScheme: probe('other', 'javascript:alert(1)'),
      bareDomain: probe('plonkit', 'https://plonkit.net/'),
      plonkit: probe('plonkit', 'https://www.plonkit.net/brazil'),
      rmrg: probe('rmrg', 'https://rmrg.me/guides/x'),
      geohints: probe('geohints', 'https://geohints.com/meta/bollards'),
      other: probe('other', 'https://example.com/some/page'),
      fallback: fallback
    };
  });

  check('A1 no type → null', a.emptyType === null);
  check('A2 no url → null', a.emptyUrl === null);
  check('A3 both empty → null', a.bothEmpty === null);
  check('A4 unknown type → null', a.unknownType === null);
  check('A5 wrong domain for type → null', a.wrongDomain.el === null);
  check('A6 javascript: url → null', a.jsScheme.el === null);
  check('A7 bare domain (no path) → null', a.bareDomain.el === null);

  check('A8 plonkit returns an <a>', a.plonkit.el === 'A', a.plonkit.el);
  check('A9 plonkit href preserved', a.plonkit.href === 'https://www.plonkit.net/brazil', a.plonkit.href);
  check('A10 plonkit target=_blank', a.plonkit.target === '_blank');
  check('A11 plonkit rel has noopener', /noopener/.test(a.plonkit.rel || '') && /noreferrer/.test(a.plonkit.rel || ''), a.plonkit.rel);
  check('A12 plonkit has a readable name', !!a.plonkit.aria, a.plonkit.aria);
  check('A13 plonkit uses the self-hosted icon', a.plonkit.hasImg && a.plonkit.imgSrc === 'images/source-plonkit.webp', a.plonkit.imgSrc);
  check('A14 icon is decorative (alt="" + aria-hidden)', a.plonkit.imgAlt === '' && a.plonkit.imgAriaHidden === 'true');

  check('A15 rmrg uses its own icon', a.rmrg.hasImg && a.rmrg.imgSrc === 'images/source-rmrg.png', a.rmrg.imgSrc);
  check('A16 geohints is text, no icon', !a.geohints.hasImg && a.geohints.text === 'GeoHints', a.geohints.text);
  check('A17 other shows "Source" (not "Others")', !a.other.hasImg && a.other.text === 'Source', a.other.text);
  check('A18 text-only badges still have a readable name', !!a.geohints.aria && !!a.other.aria,
    a.geohints.aria + ' / ' + a.other.aria);
  check('A19 broken icon falls back to text (no broken img)', a.fallback.noImgLeft && a.fallback.text === 'Plonk It' && a.fallback.nameStillThere,
    JSON.stringify(a.fallback));

  // --- B. homepage card structure -----------------------------------------
  await page.waitForSelector('.useful-card .source-badge', { timeout: 15000 });

  const b = await page.evaluate(function () {
    const cards = Array.prototype.slice.call(document.querySelectorAll('.useful-card'));
    const card = cards[0];
    const plain = cards[1];
    if (!card) return { cards: cards.length };
    card.scrollIntoView({ block: 'center' });
    const badge = card.querySelector('.source-badge');
    const rect = badge ? badge.getBoundingClientRect() : null;
    const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
    const overlay = card.querySelector('.useful-card__link');
    return {
      cards: cards.length,
      hasOverlay: !!overlay,
      overlayHref: overlay ? overlay.getAttribute('href') : '',
      nestedAnchors: card.querySelectorAll('a a').length,
      anchorCount: card.querySelectorAll('a').length,
      badgeText: badge ? badge.textContent.trim() : '',
      badgeAria: badge ? (badge.getAttribute('aria-label') || '') : '',
      badgeRel: badge ? (badge.getAttribute('rel') || '') : '',
      badgeTarget: badge ? badge.getAttribute('target') : '',
      badgeHref: badge ? badge.getAttribute('href') : '',
      hitIsBadge: !!(hit && (hit === badge || badge.contains(hit))),
      hitTag: hit ? (hit.className || hit.tagName) : null,
      plainHasBadge: !!(plain && plain.querySelector('.source-badge')),
      plainExists: !!plain,
      // The overlay is position:absolute; inset:0, so it only covers its own card
      // if .useful-card establishes a containing block. Without position:relative
      // it resolves against .useful-carousel__track and every overlay ends up
      // 1800px wide, with the last one on top winning every click. Measuring the
      // width is the only way to see that -- the href attribute stays correct.
      overlayW: overlay ? Math.round(overlay.getBoundingClientRect().width) : null,
      cardW: Math.round(card.getBoundingClientRect().width),
      ownership: cards.map(function (c, i) {
        const r = c.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        // Cards scrolled out of the carousel's overflow-x are unreachable by
        // elementFromPoint; skip them rather than reporting a false failure.
        if (cx < 0 || cx > window.innerWidth || cy < 0 || cy > window.innerHeight) {
          return { i: i, inView: false };
        }
        const h = document.elementFromPoint(cx, cy);
        const own = c.querySelector('.useful-card__link');
        // Identity, not href equality: with the bug a card still resolves to *a*
        // link, just the wrong one.
        return { i: i, inView: true, ownLink: !!(h && own && (h === own || own.contains(h))) };
      })
    };
  });

  check('B1 two cards rendered', b.cards >= 2, 'cards=' + b.cards);
  check('B2 card root is a <div> with an overlay link', b.hasOverlay, 'overlay=' + b.hasOverlay);
  check('B3 overlay link points at explore', /\/explore\?country=south-africa&region=sub-1/.test(b.overlayHref || ''), b.overlayHref);
  check('B4 NO nested <a> inside the card', b.nestedAnchors === 0, 'nested=' + b.nestedAnchors);
  check('B5 card has exactly overlay + badge anchors', b.anchorCount === 2, 'anchors=' + b.anchorCount);
  check('B6 badge renders "Source" text', b.badgeText === 'Source', b.badgeText);
  check('B7 badge link has a readable name', !!b.badgeAria, b.badgeAria);
  check('B8 badge rel has noopener', /noopener/.test(b.badgeRel || ''), b.badgeRel);
  check('B9 badge opens in a new tab', b.badgeTarget === '_blank');
  check('B10 badge href is the cited url', b.badgeHref === 'https://example.com/page', b.badgeHref);
  check('B11 badge is hit at its own centre (above the overlay)', b.hitIsBadge, 'hit=' + b.hitTag);
  check('B12 a card with no source renders no badge', b.plainExists && !b.plainHasBadge);
  const reachable = (b.ownership || []).filter(function (o) { return o.inView; });
  check('B13 overlay link fills its own card, not the whole track',
    b.overlayW != null && Math.abs(b.overlayW - b.cardW) < 4,
    'overlay=' + b.overlayW + 'px card=' + b.cardW + 'px');
  check('B14 every visible card is covered by its OWN overlay',
    reachable.length > 0 && reachable.every(function (o) { return o.ownLink; }),
    JSON.stringify(reachable));

  // ---------------------------------------------------------------- C
  submitPostCount = 0;
  // .html suffix: `python3 -m http.server` has no clean-URL rewriting.
  // domcontentloaded, not load: the page pulls Leaflet + friends from unpkg and
  // the `load` event is not a reliable signal here (the inline scripts we test
  // run during parsing anyway).
  await page.goto(BASE + '/submit.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.sourceErrorFor === 'function'; }, null, { timeout: 15000 });

  const rules = await page.evaluate(function () {
    function bad(t, u) { return !!sourceErrorFor(t, u); }
    return {
      plonkitBare: !bad('plonkit', 'https://plonkit.net/brazil'),
      plonkitWww: !bad('plonkit', 'https://www.plonkit.net/brazil'),
      plonkitWrong: bad('plonkit', 'https://evil.example.com/x'),
      rmrgWwwOptional: !bad('rmrg', 'https://rmrg.me/guides/x') && !bad('rmrg', 'https://www.rmrg.me/guides/x'),
      geohintsOk: !bad('geohints', 'https://geohints.com/meta/bollards'),
      geohintsAnyPath: !bad('geohints', 'https://geohints.com/anything'),
      geohintsWrong: bad('geohints', 'https://evil.example.com/x'),
      otherJs: bad('other', 'javascript:alert(1)'),
      otherOk: !bad('other', 'https://example.com/page'),
      bareDomainRejected: bad('plonkit', 'https://plonkit.net/')
    };
  });
  check('C1 plonkit.net path accepted', rules.plonkitBare);
  check('C2 www.plonkit.net accepted', rules.plonkitWww);
  check('C3 foreign domain rejected for plonkit', rules.plonkitWrong);
  check('C4 rmrg.me accepted with and without www', rules.rmrgWwwOptional);
  check('C5 geohints.com path accepted', rules.geohintsOk);
  check('C6 path content is NOT checked', rules.geohintsAnyPath);
  check('C7 foreign domain rejected for geohints', rules.geohintsWrong);
  check('C8 javascript: rejected for other', rules.otherJs);
  check('C9 https url accepted for other', rules.otherOk);
  check('C10 bare domain rejected (needs a path)', rules.bareDomainRejected);

  const toggle = await page.evaluate(function () {
    const wrap = document.getElementById('source-url-wrap');
    const chip = document.querySelector('#source-chips .source-chip[data-source="geohints"]');
    chip.click();
    const opened = !wrap.hidden && chip.getAttribute('aria-pressed') === 'true';
    chip.click();
    const closed = wrap.hidden && chip.getAttribute('aria-pressed') === 'false';
    return { opened, closed };
  });
  check('C11 clicking a chip reveals the url box', toggle.opened);
  check('C12 clicking it again deselects and collapses', toggle.closed);

  const validation = await page.evaluate(function () {
    const chip = document.querySelector('#source-chips .source-chip[data-source="plonkit"]');
    chip.click();
    const input = document.getElementById('source-url');
    const status = document.getElementById('source-status');
    input.value = 'https://www.plonkit.net/brazil';
    input.dispatchEvent(new Event('blur'));
    const okShown = status.textContent === '✓' && /is-resolved/.test(status.className);
    input.value = 'https://evil.example.com/x';
    input.dispatchEvent(new Event('blur'));
    const errShown = status.textContent === '✗' && /is-failed/.test(status.className);
    const errText = document.getElementById('source-error').textContent;
    return { okShown, errShown, errText };
  });
  check('C13 valid url shows ✓', validation.okShown);
  check('C14 invalid url shows ✗ with an example', validation.errShown && /plonkit\.net/.test(validation.errText), validation.errText);

  // The four examples are the wildcard forms given in the requirement, verbatim.
  // They were once "improved" into real-looking concrete pages, which is exactly
  // the guessing this asserts against.
  const examples = await page.evaluate(function () {
    const out = {};
    const chips = document.querySelectorAll('#source-chips .source-chip');
    const input = document.getElementById('source-url');
    for (const chip of chips) {
      chip.click();
      out[chip.getAttribute('data-source')] = input.placeholder;
      chip.click();   // deselect before the next one
    }
    return out;
  });
  const EXPECTED = {
    plonkit: 'https://www.plonkit.net/*/*',
    rmrg: 'https://rmrg.me/*',
    geohints: 'https://geohints.com/meta/*',
    other: 'https://example.com/*'
  };
  Object.keys(EXPECTED).forEach(function (k) {
    check('C18/' + k + ' hint is the given pattern, not a made-up page',
      examples[k] === EXPECTED[k], k + '=' + JSON.stringify(examples[k]));
  });

  // "other" + javascript: must be rejected and must NOT send a request.
  await page.evaluate(function () {
    document.querySelector('#source-chips .source-chip[data-source="other"]').click();
    document.getElementById('source-url').value = 'javascript:alert(1)';
    document.getElementById('region-name').value = 'Harness Region';
    document.getElementById('region-desc').value = 'harness description';
    const sel = document.getElementById('region-country');
    if (!Array.prototype.some.call(sel.options, function (o) { return o.value === 'south-africa'; })) {
      const o = document.createElement('option');
      o.value = 'south-africa';
      sel.appendChild(o);
    }
    sel.value = 'south-africa';
  });
  const before = submitPostCount;
  await page.evaluate(function () { document.getElementById('submit-btn').click(); });
  await page.waitForTimeout(400);
  const blocked = submitPostCount === before;
  const afterSubmit = await page.evaluate(function () {
    return {
      status: document.getElementById('source-status').textContent,
      feedback: document.getElementById('form-feedback').textContent
    };
  });
  check('C15 javascript: shows ✗ on submit attempt', afterSubmit.status === '✗');
  check('C16 invalid source blocks submission (0 requests sent)', blocked,
    'requests=' + (submitPostCount - before));
  check('C17 user gets an explanatory message', /source/i.test(afterSubmit.feedback || ''), afterSubmit.feedback);

  // --- H. chip appearance & a11y -------------------------------------------
  // The environment cannot read images, so the chip's look is asserted as
  // computed style and geometry rather than by eye.
  const h = await page.evaluate(function () {
    const chips = Array.prototype.slice.call(document.querySelectorAll('#source-chips .source-chip'));
    const plonkit = document.querySelector('#source-chips .source-chip[data-source="plonkit"]');
    const geohints = document.querySelector('#source-chips .source-chip[data-source="geohints"]');
    const icon = plonkit.querySelector('.source-chip__icon');
    const before = {
      border: getComputedStyle(plonkit).borderTopWidth,
      bg: getComputedStyle(plonkit).backgroundColor,
      borderGeohints: getComputedStyle(geohints).borderTopWidth,
      bgGeohints: getComputedStyle(geohints).backgroundColor,
      iconOpacityIdle: parseFloat(getComputedStyle(icon).opacity),
      height: Math.round(plonkit.getBoundingClientRect().height),
      // Icon-only buttons need a name on the button itself: the <img> is
      // aria-hidden and alt="", so without aria-label a screen reader
      // announces nothing but "button".
      plonkitName: (plonkit.getAttribute('aria-label') || '').trim(),
      rmrgName: (document.querySelector('#source-chips .source-chip[data-source="rmrg"]').getAttribute('aria-label') || '').trim(),
      plonkitHasText: plonkit.textContent.trim(),
      geohintsHasText: geohints.textContent.trim(),
      chipCount: chips.length
    };
    plonkit.click();
    return before;
  });
  // The icon has `transition: opacity .12s`, so reading computed style in the
  // same tick returns an interpolated mid-transition value. Let it settle.
  await page.waitForTimeout(250);
  const hPressed = await page.evaluate(function () {
    const plonkit = document.querySelector('#source-chips .source-chip[data-source="plonkit"]');
    const icon = plonkit.querySelector('.source-chip__icon');
    const v = parseFloat(getComputedStyle(icon).opacity);
    plonkit.click();   // leave the picker deselected for anything downstream
    return v;
  });

  check('H1 chips have no border', h.border === '0px' && h.borderGeohints === '0px', 'plonkit=' + h.border + ' geohints=' + h.borderGeohints);
  check('H2 chips have no background fill', /rgba\(0, 0, 0, 0\)|transparent/.test(h.bg) && /rgba\(0, 0, 0, 0\)|transparent/.test(h.bgGeohints), h.bg);
  check('H3 icon-only chips carry no visible text', h.plonkitHasText === '', JSON.stringify(h.plonkitHasText));
  check('H4 text chips still carry their label', h.geohintsHasText === 'GeoHints', h.geohintsHasText);
  check('H5 icon-only chips have an accessible name', h.plonkitName === 'Plonk It' && h.rmrgName === 'RMRG', h.plonkitName + ' / ' + h.rmrgName);
  check('H6 selected state reads through icon opacity', h.iconOpacityIdle < 0.6 && hPressed === 1, 'idle=' + h.iconOpacityIdle + ' pressed=' + hPressed);
  check('H7 dropping the border did not shrink the touch target', h.height >= 36, 'height=' + h.height + 'px');
  check('H8 four chips remain', h.chipCount === 4, 'chips=' + h.chipCount);

  check('D1 no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

  // ---------------------------------------------------------------- E
  // explore modal (public/js/modal.js)
  await page.goto(BASE + '/explore.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.openModal === 'function'; }, null, { timeout: 15000 });
  const e = await page.evaluate(function () {
    // No description → skip the marked/DOMPurify path, which needs CDN libs.
    openModal({ id: 'm1', name: 'Mock One', tags: [], source_type: 'geohints', source_url: 'https://geohints.com/meta/bollards' });
    const row = document.querySelector('.modal__source-badge');
    const badge = row ? row.querySelector('.source-badge') : null;
    const shown = badge ? {
      text: badge.textContent.trim(),
      href: badge.getAttribute('href'),
      aria: badge.getAttribute('aria-label') || ''
    } : null;
    // Re-open a region that has no source: the previous row must be removed.
    openModal({ id: 'm2', name: 'Mock Two', tags: [] });
    const cleared = document.querySelector('.modal__source-badge') === null;
    return { shown, cleared };
  });
  check('E1 explore modal renders the badge', !!(e.shown && e.shown.text === 'GeoHints'), JSON.stringify(e.shown));
  check('E2 modal badge href + readable name', !!(e.shown && e.shown.href === 'https://geohints.com/meta/bollards' && e.shown.aria), JSON.stringify(e.shown));
  check('E3 no-source region removes the previous badge', e.cleared);

  // E4-E8 cover the two placement rules of the explore modal. They assert **geometry and
  // computed style**, not CSS source text: the badge's position is decided in modal.js
  // (insertBefore vs appendChild) and its look is a shared component's, so a grep of the
  // stylesheet would prove nothing about what the user actually sees.
  //
  // RED CHECK (verified): restoring `leftColumn.appendChild(sourceBadgeRow)` turns E4 red;
  // restoring the toggle's container to `titleContainer.parentNode` turns E7 red.
  const e2 = await page.evaluate(function () {
    openModal({
      id: 'm3', name: 'Mock Three', tags: [], submitted_by: 'tester',
      source_type: 'plonkit', source_url: 'https://www.plonkit.net/brazil'
    });
    const badgeRow = document.querySelector('.modal__source-badge');
    const reactions = document.getElementById('modal-reactions');
    const meta = document.querySelector('.modal__meta');
    const submitted = document.getElementById('modal-submitted');
    const toggle = meta ? meta.querySelector('.lang-toggle--name') : null;

    // Document order, not visual order — "above" here means "comes first in the DOM".
    const badgeBeforeReactions = !!(badgeRow && reactions &&
      (badgeRow.compareDocumentPosition(reactions) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);

    const badge = badgeRow ? badgeRow.querySelector('.source-badge') : null;
    const icon = badgeRow ? badgeRow.querySelector('.source-badge__icon') : null;
    const cs = badge ? getComputedStyle(badge) : null;

    // "Same row" has to mean overlapping client rects: a block child would stack instead.
    const subRect = submitted ? submitted.getBoundingClientRect() : null;
    const togRect = toggle ? toggle.getBoundingClientRect() : null;
    const overlap = (subRect && togRect)
      ? Math.min(subRect.bottom, togRect.bottom) - Math.max(subRect.top, togRect.top) : 0;

    return {
      badgeBeforeReactions: badgeBeforeReactions,
      border: cs ? cs.borderTopWidth : null,
      bg: cs ? cs.backgroundColor : null,
      paddingLeft: cs ? cs.paddingLeft : null,
      fontSize: cs ? parseFloat(cs.fontSize) : null,
      iconWidth: icon ? parseFloat(getComputedStyle(icon).width) : null,
      toggleInMeta: !!(toggle && meta && meta.contains(toggle)),
      submittedInMeta: !!(submitted && meta && meta.contains(submitted)),
      overlap: overlap,
      subText: submitted ? submitted.textContent.trim() : ''
    };
  });

  check('E4 badge sits above the reactions row', e2.badgeBeforeReactions);
  check('E5 badge has no border, no fill, no padding',
    e2.border === '0px' && /rgba\(0, 0, 0, 0\)|transparent/.test(e2.bg) && e2.paddingLeft === '0px',
    'border=' + e2.border + ' bg=' + e2.bg + ' padding=' + e2.paddingLeft);
  check('E6 badge type grew from the old 11px and the icon followed',
    e2.fontSize >= 13 && e2.iconWidth >= 15, 'font=' + e2.fontSize + ' icon=' + e2.iconWidth);
  check('E7 translate toggle lives in .modal__meta with the submitter',
    e2.toggleInMeta && e2.submittedInMeta, e2.subText);
  check('E8 toggle and submitter overlap on one row', e2.overlap > 0, 'overlap=' + e2.overlap + 'px');

  // ---------------------------------------------------------------- F
  // my-submissions list card (public/my-submissions.html, createSubmissionCard)
  await page.goto(BASE + '/my-submissions.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#my-results .review-item', { timeout: 15000 });
  const f = await page.evaluate(function () {
    const items = document.querySelectorAll('#my-results .review-item');
    const badges = document.querySelectorAll('#my-results .source-badge');
    const b = badges[0] || null;
    return {
      items: items.length,
      badges: badges.length,
      text: b ? b.textContent.trim() : '',
      href: b ? b.getAttribute('href') : '',
      aria: b ? (b.getAttribute('aria-label') || '') : ''
    };
  });
  check('F1 my-submissions renders both cards', f.items === 2, 'items=' + f.items);
  check('F2 exactly the attributed card shows a badge', f.badges === 1, 'badges=' + f.badges);
  check('F3 badge text + href + name', f.text === 'Source' && f.href === 'https://example.com/page' && !!f.aria,
    JSON.stringify(f));

  // Hidden / Trash render through different card builders. A submission keeps
  // its attribution wherever it sits, so the badge must follow it there.
  const visTabs = ['hidden', 'trash'];
  for (const vis of visTabs) {
    await page.click('#visibility-tabs .review-tab[data-visibility="' + vis + '"]');
    await page.waitForTimeout(700);
    const fv = await page.evaluate(function () {
      return {
        items: document.querySelectorAll('#my-results .review-item').length,
        badges: document.querySelectorAll('#my-results .source-badge').length,
        text: (document.querySelector('#my-results .source-badge') || {}).textContent || ''
      };
    });
    check('F4/' + vis + ' tab renders the badge too',
      fv.items > 0 && fv.badges === 1, vis + ': ' + JSON.stringify(fv));
  }

  // ---------------------------------------------------------------- G
  // review page list card + read-only badge inside the inline edit form
  await page.goto(BASE + '/review.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(function () { return typeof window.loadSubmissions === 'function'; }, null, { timeout: 15000 });
  await page.evaluate(function () {
    var pw = document.getElementById('admin-password-input');
    if (pw) pw.value = 'harness';
    document.getElementById('admin-password-submit').click();
  });
  await page.waitForSelector('#review-list .review-item', { timeout: 15000 });

  const g = await page.evaluate(function () {
    const items = document.querySelectorAll('#review-list .review-item');
    const badges = document.querySelectorAll('#review-list .source-badge');
    const b = badges[0] || null;
    return {
      items: items.length,
      badges: badges.length,
      text: b ? b.textContent.trim() : '',
      href: b ? b.getAttribute('href') : '',
      aria: b ? (b.getAttribute('aria-label') || '') : ''
    };
  });
  check('G1 review list renders both cards', g.items === 2, 'items=' + g.items);
  check('G2 exactly the attributed card shows a badge', g.badges === 1, 'badges=' + g.badges);
  check('G3 review badge text + href + name',
    g.href === 'https://www.plonkit.net/brazil' && !!g.aria && g.text === '', JSON.stringify(g));

  const gEdit = await page.evaluate(function () {
    const card = document.querySelector('#review-list .review-item');
    const editBtn = Array.prototype.find.call(card.querySelectorAll('button'), function (btn) {
      return btn.textContent.trim() === 'Edit';
    });
    if (!editBtn) return { opened: false };
    editBtn.click();
    const slot = document.getElementById('edit-source-sub-1');
    const badge = slot ? slot.querySelector('.source-badge') : null;
    const inputsInSlot = slot ? slot.querySelectorAll('input, select, textarea').length : -1;
    return {
      opened: true,
      hasBadge: !!badge,
      badgeHref: badge ? badge.getAttribute('href') : '',
      inputsInSlot: inputsInSlot
    };
  });
  check('G4 admin edit form shows the source read-only', !!gEdit.hasBadge, JSON.stringify(gEdit));
  check('G5 that read-only slot has no input control', gEdit.inputsInSlot === 0, 'inputs=' + gEdit.inputsInSlot);

  await browser.close();
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch(function (err) {
  console.error('HARNESS ERROR:', err && err.stack || err);
  process.exit(1);
});

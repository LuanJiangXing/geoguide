# GeoGuide Code Redundancy Audit

> **Date:** 2026-07-16 | **Scope:** Full codebase

---

## 1. Duplicated Functions (API)

### 1.1 `uuid()` — 5 copies

All identical: `return crypto.randomUUID();`

| File | Line | Notes |
|------|------|-------|
| `api/auth.js` | 3–5 | top-level function |
| `api/setup.js` | 3–5 | top-level function |
| `api/tags.js` | 8–10 | top-level function |
| `api/submit.js` | 173–175 | inline `var uuid` inside POST handler |
| `api/submit.js` | 294–296 | same inline inside PATCH handler |

**Fix:** add `uuid()` to `_lib/turso.js`, import everywhere.

### 1.2 `resolveStreetview()` — 2 copies

47 lines, byte-for-byte identical.

| File | Line |
|------|------|
| `api/submit.js` | 4–50 |
| `api/review.js` | 4–47 |

**Fix:** move to `_lib/turso.js` (or a new `_lib/streetview.js`).

### 1.3 `getCookie()` — duplicated despite import

| File | Line | Notes |
|------|------|-------|
| `api/_lib/turso.js` | 108–112 | canonical (private to module) |
| `api/auth.js` | 7–11 | identical copy, even though turso.js is already imported |

**Fix:** export `getCookie` from `_lib/turso.js`.

### 1.4 `safeJson()` — 2 copies

| File | Line |
|------|------|
| `api/review.js` | 105–108 |
| `api/user-submissions.js` | 40–43 |

**Fix:** add to `_lib/turso.js`.

---

## 2. Duplicated Functions (Frontend)

### 2.1 `escapeHtml()` — 3 copies

| File | Line | Notes |
|------|------|-------|
| `js/utils.js` | 6–9 | canonical |
| `review.html` | 381–385 | inline, doesn't load utils.js |
| `my-submissions.html` | 207–212 | inline, doesn't load utils.js |

**Fix:** load `utils.js` in review.html and my-submissions.html.

### 2.2 `countryNames` object — 2 copies

| File | Line |
|------|------|
| `review.html` | 206 |
| `my-submissions.html` | 148 |

**Fix:** move to `js/utils.js`.

---

## 3. Duplicated SQL Patterns

### 3.1 `CREATE TABLE IF NOT EXISTS submissions` — 5 files

Schema is inconsistent across files (some missing `user_id`, `edit_target_id`).

| File | Line |
|------|------|
| `api/setup.js` | 48 |
| `api/review.js` | 70 |
| `api/submit.js` | 93 |
| `api/submissions.js` | 14 |
| `api/contributors.js` | 12 |

### 3.2 `ALTER TABLE ADD COLUMN` — 16 calls across 6 files

Defensive migration in every endpoint. Should be centralized in `setup.js`.

| File | Columns added |
|------|---------------|
| `api/review.js` | country_id, edit_target_id, reject_reason (×2) |
| `api/submit.js` | country_id, user_id, edit_target_id, parent_id |
| `api/setup.js` | user_id, edit_target_id, parent_id |
| `api/users.js` | status |
| `api/auth.js` | status, display_name |
| `api/tags.js` | parent_id |
| `api/contributors.js` | display_name |

### 3.3 `CREATE TABLE IF NOT EXISTS tags` — in 3 files

| File | Line | Notes |
|------|------|-------|
| `api/setup.js` | 56 | includes parent_id |
| `api/tags.js` | 20 | includes parent_id |
| `api/submit.js` | 177, 298 | missing parent_id |

### 3.4 `CREATE TABLE IF NOT EXISTS reactions` — 3 times in one file

`api/reactions.js` lines 9, 34, 93 — identical SQL in GET/GET/POST handlers.

**Fix:** call once at the top of the handler.

---

## 4. CSS Issues

### 4.1 Duplicate rules across breakpoints

| Selector | Lines | Notes |
|----------|-------|-------|
| `.nav` | 969, 993 | identical at 767px and 680px |
| `.nav__links` | 970, 994 | identical at 767px and 680px |
| `.modal__header` | 568, 1034 | identical at 400px and 1024px |
| `.modal__left` | 570, 1035 | identical at 400px and 1024px |

### 4.2 `.review-btn--undo` = `.review-btn--edit`

Lines 962–963: byte-for-byte identical CSS. Should share a base class.

### 4.3 `.tag-dropdown` defined twice

| Location | Lines | Colors |
|----------|------|--------|
| `explore.html` inline `<style>` | 14–116 | `var(--paper-light)`, `var(--soil-dark)` |
| `css/style.css` base | 1044–1099 | `var(--paper-warm)`, `var(--earth-terracotta)` |

### 4.4 `min-height: 44px` repeated 28 times

Should be a CSS variable: `--touch-target: 44px`.

### 4.5 Bugs

- **`.toggle-propose`** line 1125: duplicate `min-height: 44px` (copy-paste)
- **`.tag-dropdown__item`** lines 1089/1095: `display: block` overridden by `display: flex` below (dead code)

---

## 5. Duplicated HTML

### 5.1 "Login Required" gate

Identical HTML block in `my-submissions.html` (43–47) and `profile.html` (81–85).

### 5.2 Review tab switching logic

`review.html` repeats `forEach + removeClass + addClass` for country, status, and action tabs. Could be a helper.

---

## 6. Low Priority

| # | Issue |
|---|-------|
| 1 | `config.example.js` and `config.js` structurally overlap; no sync mechanism |
| 2 | `checkAdmin()` in `tags.js` is only called once — could be inlined |
| 3 | `window._authReady` vs `window.__profileData` naming inconsistency |
| 4 | `tursoBatch` underutilized — only profile.js uses it; other batch queries run sequential fetch |

---

## Summary by Priority

| Pri | Area | Est. effort |
|-----|------|:---:|
| **P0** | Move `uuid()`, `resolveStreetview()`, `getCookie()`, `safeJson()` to `_lib/turso.js` | 20 min |
| **P0** | Load `utils.js` in review.html, my-submissions.html; move `countryNames` to utils | 10 min |
| **P1** | Centralize SQL migrations to `setup.js`, remove from other endpoints | 30 min |
| **P1** | Merge duplicate CSS selectors, fix dead-code bugs | 20 min |
| **P2** | CSS variable for `min-height: 44px` (28→1) | 10 min |
| **P2** | Merge identical review-btn styles | 5 min |
| **P2** | Deduplicate "Login Required" gate | 10 min |

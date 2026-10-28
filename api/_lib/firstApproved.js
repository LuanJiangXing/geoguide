// The `first_approved_at` backfill clause: which rows still need a value.
//
// Why this one string lives in a tracked module instead of inside the script that uses it:
// `scripts/backfill-*.js` is gitignored by convention (.gitignore:37) — those are one-off
// scripts run by hand against production, and they stay out of the repo. But the clause is a
// contract worth locking down ("running the backfill twice must not overwrite values it already
// froze"), and a test cannot assert against a file that isn't in the repo. So the clause lives
// here, the ignored script requires it, and scripts/test-first-approved-sql.js verifies it on a
// real SQLite. See .trellis/spec/frontend/first-approved-order.md §6.

// The last two conditions are what make the backfill re-runnable: rows that already carry a
// value — including rows it filled in on a previous run — are never touched.
const BACKFILL_WHERE = "status = 'approved' AND reviewed_at IS NOT NULL AND reviewed_at != ''"
  + " AND (first_approved_at IS NULL OR first_approved_at = '')";

const BACKFILL_SQL = 'UPDATE submissions SET first_approved_at = reviewed_at WHERE ' + BACKFILL_WHERE;

module.exports = { BACKFILL_WHERE, BACKFILL_SQL };

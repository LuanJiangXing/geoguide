// Tag proposal → submission merge logic (pure functions, db injected).
//
// Invariant: a tag name entering the public catalog (tags.status = 'approved')
// and entering its linked submission's submissions.tags array is ONE action.
// Two entry points share these helpers:
//   - admin approving a pending tag (single or batch) → approveTagWithMerge
//   - trusted user submitting proposed_tags → insertProposedTagAuto
//
// All functions take `db` (i.e. tursoFetch) as the first argument so the merge
// logic can be unit-tested with a fake db. tursoFetch response shape:
//   { rows: [[{value: ...}, ...], ...], cols: [{name: ...}, ...] }

const { uuid } = require('./turso.js');

// Parse a stored submissions.tags value into an array of tag-name strings.
// The column holds a JSON string; defensive fallback for bad/legacy data.
function parseTags(raw) {
  if (typeof raw === 'string') {
    try {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* fall through to empty */ }
    return [];
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

// Find an already-approved catalog tag with the same name+category.
// Returns the tag id or null. `excludeId` prevents matching the row being
// approved itself (defensive — a pending row wouldn't match status='approved').
async function findApprovedTag(db, name, category, excludeId) {
  var result = await db(
    "SELECT id FROM tags WHERE name = ? AND category = ? AND status = 'approved' AND id != ? LIMIT 1",
    [name, category, excludeId || '']
  );
  return result.rows.length > 0 ? result.rows[0][0].value : null;
}

// Merge `name` into one submission row's tags array (dedup by exact match).
// No-op when the row doesn't exist (orphan proposal → silently skipped).
async function mergeIntoRow(db, name, submissionId, category) {
  var result = await db("SELECT tags FROM submissions WHERE id = ?", [submissionId]);
  if (result.rows.length === 0) return;
  var raw = result.rows[0][0] && result.rows[0][0].value;
  var tags = parseTags(raw);
  var scopedName = category ? (category + ':' + name) : name;
  if (tags.indexOf(scopedName) === -1 && tags.indexOf(name) === -1) {
    tags.push(scopedName);
    await db("UPDATE submissions SET tags = ? WHERE id = ?", [tags, submissionId]);
  }
}

// Merge `name` into the submission, and if that row is a draft
// (edit_target_id set) also merge into the original row. This covers both
// timings: the draft later gets merged (tag carries over) or the draft gets
// rejected (tag still lives on the original approved submission).
async function mergeNameIntoSubmission(db, name, submissionId, category) {
  if (!submissionId) return;
  var row = await db("SELECT edit_target_id, tags FROM submissions WHERE id = ?", [submissionId]);
  if (row.rows.length === 0) return; // orphan proposal → skip silently
  var r = row.rows[0];
  var targetId = (r[0] && r[0].value) || null;
  var tags = parseTags(r[1] ? r[1].value : null);
  var scopedName = category ? (category + ':' + name) : name;
  if (tags.indexOf(scopedName) === -1 && tags.indexOf(name) === -1) {
    tags.push(scopedName);
    await db("UPDATE submissions SET tags = ? WHERE id = ?", [tags, submissionId]);
  }
  if (targetId) {
    await mergeIntoRow(db, name, targetId, category);
  }
}

// Approve a pending tag and merge its name into the linked submission.
// 1. Row gone → no-op.
// 2. AC6 dedup: an approved tag with the same name+category already exists in
//    the catalog → DELETE this duplicate proposal row (no duplicate catalog
//    entry) and just merge the name into the submission.
// 3. Otherwise mark the row approved, then merge.
async function approveTagWithMerge(db, tagId) {
  if (!tagId) return;
  var result = await db("SELECT name, category, submission_id FROM tags WHERE id = ?", [tagId]);
  if (result.rows.length === 0) return; // already deleted → no-op
  var r = result.rows[0];
  var name = r[0].value;
  var category = (r[1] && r[1].value) || null;
  var submissionId = (r[2] && r[2].value) || null;

  var existingId = await findApprovedTag(db, name, category, tagId);
  if (existingId) {
    await db("DELETE FROM tags WHERE id = ?", [tagId]);
    await mergeNameIntoSubmission(db, name, submissionId, category);
    return;
  }

  await db("UPDATE tags SET status = 'approved' WHERE id = ?", [tagId]);
  await mergeNameIntoSubmission(db, name, submissionId, category);
}

// Trusted-user path: proposal is approved at submit time. If a catalog tag
// with the same name+category already exists, don't create a duplicate row —
// just merge the name into the submission. Otherwise insert as approved and
// merge.
async function insertProposedTagAuto(db, userId, name, category, submissionId) {
  if (!name || !category) return;
  var existingId = await findApprovedTag(db, name, category, '');
  if (existingId) {
    await mergeNameIntoSubmission(db, name, submissionId, category);
    return;
  }
  await db(
    "INSERT INTO tags (id, name, category, user_id, status, created_at, submission_id) VALUES (?, ?, ?, ?, 'approved', ?, ?)",
    [uuid(), name, category, userId || '', new Date().toISOString(), submissionId || null]
  );
  await mergeNameIntoSubmission(db, name, submissionId, category);
}

module.exports = { findApprovedTag, mergeNameIntoSubmission, approveTagWithMerge, insertProposedTagAuto };

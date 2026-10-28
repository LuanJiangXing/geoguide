// Unit tests for api/_lib/tagMerge.js — run directly with:
//   node api/_lib/tagMerge.test.js
// Uses a fake `db` (tursoFetch-shaped) so no Turso/network is involved.

const { findApprovedTag, mergeNameIntoSubmission, approveTagWithMerge, insertProposedTagAuto } = require('./tagMerge.js');

let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { passed++; console.log('  ok — ' + label); }
  else { failed++; console.log('  FAIL — ' + label); }
}
function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Fake db: route SQL statements by predicate, record every call.
function makeDb() {
  var calls = [];
  var routes = [];
  function db(sql, args) {
    args = args || [];
    calls.push({ sql: sql, args: args });
    for (var i = 0; i < routes.length; i++) {
      if (routes[i].test(sql, args)) return routes[i].respond(sql, args);
    }
    return { cols: [], rows: [] }; // default: no rows
  }
  db.calls = calls;
  db.on = function(test, respond) { routes.push({ test: test, respond: respond }); return db; };
  db.callsMatching = function(substr) {
    return calls.filter(function(c) { return c.sql.indexOf(substr) !== -1; });
  };
  return db;
}

function rows1(vals) { return { cols: [], rows: [vals.map(function(v) { return { value: v }; })] }; }
function rows0() { return { cols: [], rows: [] }; }

async function main() {
  // ---- mergeNameIntoSubmission ----
  console.log('mergeNameIntoSubmission:');
  {
    var db = makeDb();
    await mergeNameIntoSubmission(db, 'newtag', null);
    assert(db.calls.length === 0, 'empty submissionId → no DB calls');
    await mergeNameIntoSubmission(db, 'newtag', '');
    assert(db.calls.length === 0, 'empty-string submissionId → no DB calls');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', '["other","newtag"]']);
      });
    await mergeNameIntoSubmission(db, 'newtag', 'sub1');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 0, 'tag already present → no update');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', 'not-json{']);
      });
    await mergeNameIntoSubmission(db, 'newtag', 'sub1');
    var updates = db.callsMatching('UPDATE submissions SET tags');
    assert(updates.length === 1, 'bad JSON → one update, no crash');
    assert(deepEqual(updates[0].args[0], ['newtag']), 'bad JSON → tags rebuilt as ["newtag"]');
    assert(updates[0].args[1] === 'sub1', 'update targets the submission id');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['orig1', '["keep"]']);
      })
      .on(function(s, args) { return s.indexOf('SELECT tags') === 0; }, function() {
        return rows1(['["keep","other"]']);
      });
    await mergeNameIntoSubmission(db, 'newtag', 'draft1'); // AC5: draft + original both merged
    var updates = db.callsMatching('UPDATE submissions SET tags');
    assert(updates.length === 2, 'draft (edit_target_id set) → draft AND original both updated');
    assert(updates[0].args[1] === 'draft1' && deepEqual(updates[0].args[0], ['keep', 'newtag']), 'draft row updated first');
    assert(updates[1].args[1] === 'orig1' && deepEqual(updates[1].args[0], ['keep', 'other', 'newtag']), 'original row merged (dedup preserved)');
  }
  {
    var db = makeDb(); // no rows anywhere
    await mergeNameIntoSubmission(db, 'newtag', 'orphan-sub');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 0, 'orphan submission id → silently skipped');
  }

  // ---- approveTagWithMerge ----
  console.log('approveTagWithMerge:');
  {
    var db = makeDb(); // SELECT name... returns no rows
    await approveTagWithMerge(db, 'gone');
    assert(db.callsMatching("status = 'approved'").length === 0, 'row already gone → no-op');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT name, category') === 0; }, function() {
        return rows1(['dup', 'Car', 'sub1']);
      })
      .on(function(s) { return s.indexOf('SELECT id FROM tags') === 0; }, function() {
        return rows1(['cat1']); // AC6: catalog already has approved same-name tag
      })
      .on(function(s) { return s.indexOf('DELETE FROM tags') === 0; }, function() { return rows0(); })
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', '["x"]']);
      });
    await approveTagWithMerge(db, 'prop1');
    assert(db.callsMatching('DELETE FROM tags').length === 1, 'AC6: duplicate proposal row deleted');
    assert(db.callsMatching('UPDATE tags SET status').length === 0, 'AC6: no catalog status update (dup avoided)');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 1, 'AC6: name still merged into submission');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT name, category') === 0; }, function() {
        return rows1(['fresh', 'Car', 'sub1']);
      })
      .on(function(s) { return s.indexOf('SELECT id FROM tags') === 0; }, function() {
        return rows0(); // no existing approved same-name
      })
      .on(function(s) { return s.indexOf('UPDATE tags SET status') === 0; }, function() { return rows0(); })
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', '["x"]']);
      });
    await approveTagWithMerge(db, 'prop1');
    assert(db.callsMatching('UPDATE tags SET status').length === 1, 'normal path → row marked approved');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 1, 'normal path → merged into submission');
  }

  // ---- insertProposedTagAuto ----
  console.log('insertProposedTagAuto:');
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT id FROM tags') === 0; }, function() {
        return rows1(['cat1']); // catalog already has the name
      })
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', '["x"]']);
      });
    await insertProposedTagAuto(db, 'u1', 'existing', 'Car', 'sub1');
    assert(db.callsMatching('INSERT INTO tags').length === 0, 'name already in catalog → no INSERT');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 1, 'name already in catalog → still merged into submission');
  }
  {
    var db = makeDb()
      .on(function(s) { return s.indexOf('SELECT id FROM tags') === 0; }, function() {
        return rows0();
      })
      .on(function(s) { return s.indexOf('INSERT INTO tags') === 0; }, function() { return rows0(); })
      .on(function(s) { return s.indexOf('SELECT edit_target_id') === 0; }, function() {
        return rows1(['', '["x"]']);
      });
    await insertProposedTagAuto(db, 'u1', 'brandnew', 'Car', 'sub1');
    var inserts = db.callsMatching('INSERT INTO tags');
    assert(inserts.length === 1, 'new name → one INSERT');
    assert(inserts[0].args[1] === 'brandnew' && inserts[0].args[5] === 'sub1', 'INSERT with correct name + submission_id');
    assert(inserts[0].sql.indexOf("'approved'") !== -1, 'INSERT hardcodes status=approved');
    assert(db.callsMatching('UPDATE submissions SET tags').length === 1, 'new name → merged into submission');
  }
  {
    var db = makeDb();
    await insertProposedTagAuto(db, 'u1', '', 'Car', 'sub1');
    assert(db.calls.length === 0, 'missing name → no-op');
    await insertProposedTagAuto(db, 'u1', 'x', null, 'sub1');
    assert(db.calls.length === 0, 'missing category → no-op');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(function(e) {
  console.error('Test harness error:', e);
  process.exit(1);
});

'use strict';

// T1.2 — fake-turso.js: Turso's HTTP pipeline (BUILD_SPEC section 5.2) on node:sqlite (section 10).
//
// Several behaviours below (conditional-batch rollback, errors not aborting a pipeline, skipped steps counting as
// "not ok") are what the spec EXPECTS Turso to do. They are recorded as fact only once Phase 0 tests 2, 3 and 4 have
// run against the real service (docs/v2/phase0-results.md). Until then they are provisional.

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createFakeTurso, TOKENS } = require('./helpers/fake-turso');
const { createFakes } = require('./helpers/fakes');
const { loadApp, runInApp } = require('./helpers/load-app');

// ---- tiny Hrana helpers for tests (the production encoder is Db.arg_, ticket T1.4)
const int = value => ({ type: 'integer', value: String(value) });
const float = value => ({ type: 'float', value });
const text = value => ({ type: 'text', value });
const nul = () => ({ type: 'null' });
const stmt = (sql, args) => (args ? { sql, args } : { sql });
const exec = (sql, args) => ({ type: 'execute', stmt: stmt(sql, args) });
const batch = steps => ({ type: 'batch', batch: { steps } });
const close = { type: 'close' };
const ok = step => ({ type: 'ok', step });

function newTurso(setupSql) {
  const turso = createFakeTurso();
  if (setupSql) turso.db.exec(setupSql);
  return turso;
}
const count = (turso, table) => Number(turso.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

// ---------------------------------------------------------------- protocol shape

test('execute returns typed columns, rows, counters and a null baton', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)');
  const response = turso.run([
    exec('INSERT INTO t (name, score) VALUES (?, ?)', [text('ann'), float(1.5)]),
    exec('SELECT id, name, score, NULL AS nil FROM t'),
    close,
  ]);
  assert.equal(response.baton, null);
  assert.equal(response.results.length, 3);

  const [insert, select, closed] = response.results;
  assert.equal(insert.type, 'ok');
  assert.equal(insert.response.type, 'execute');
  assert.equal(insert.response.result.affected_row_count, 1);
  assert.equal(insert.response.result.last_insert_rowid, '1');
  assert.deepEqual(insert.response.result.rows, []);

  const result = select.response.result;
  assert.deepEqual(result.cols.map(c => c.name), ['id', 'name', 'score', 'nil']);
  assert.deepEqual(result.rows, [[int(1), text('ann'), float(1.5), nul()]]);
  assert.equal(typeof result.rows_read, 'number');
  assert.equal(typeof result.rows_written, 'number');
  assert.deepEqual(closed, { type: 'ok', response: { type: 'close' } });
});

test('a batch reports step_results and step_errors side by side', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  const response = turso.run([
    batch([
      { stmt: stmt('INSERT INTO t (v) VALUES (?)', [int(1)]) },
      { stmt: stmt('INSERT INTO t (v) VALUES (?)', [nul()]) },
      { stmt: stmt('SELECT COUNT(*) FROM t') },
    ]),
    close,
  ]);
  const { step_results: results, step_errors: errors } = response.results[0].response.result;
  assert.equal(response.results[0].response.type, 'batch');
  assert.equal(results[0].affected_row_count, 1);
  assert.equal(errors[0], null);
  assert.equal(results[1], null);
  assert.match(errors[1].message, /NOT NULL constraint failed: t\.v/);
  assert.deepEqual(Object.keys(errors[1]), ['message'], 'per-step errors carry just { message } (spec section 10)');
  assert.deepEqual(results[2].rows, [[int(1)]]);
  assert.equal(errors[2], null);
});

test('values are encoded as typed JSON: integers as decimal strings, exact beyond 2^53', () => {
  const turso = newTurso();
  const [{ response }] = turso.run([
    exec('SELECT ? AS big, ? AS neg, ? AS f, ? AS s, ? AS n', [
      int('9007199254740993'), int('-5'), float(0.25), text('héllo'), nul(),
    ]),
  ]).results;
  assert.deepEqual(response.result.rows[0], [int('9007199254740993'), int('-5'), float(0.25), text('héllo'), nul()]);
});

test('blobs round-trip as base64', () => {
  const turso = newTurso();
  const [{ response }] = turso.run([exec('SELECT ? AS b', [{ type: 'blob', base64: 'AP8=' }])]).results;
  assert.deepEqual(response.result.rows[0], [{ type: 'blob', base64: 'AP8=' }]);
});

test('UNIQUE and CHECK failures carry SQLite text that Db.gs can match on', () => {
  const turso = newTurso('CREATE TABLE u (email TEXT UNIQUE, n INTEGER CHECK (n >= 0))');
  turso.db.exec("INSERT INTO u VALUES ('a', 1)");
  const { step_errors: errors } = turso.run([batch([
    { stmt: stmt("INSERT INTO u VALUES ('a', 2)") },
    { stmt: stmt("INSERT INTO u VALUES ('b', -1)") },
  ])]).results[0].response.result;
  assert.match(errors[0].message, /UNIQUE constraint failed: u\.email/);
  assert.match(errors[1].message, /CHECK constraint failed/);
});

// ---------------------------------------------------------------- integer encoding (the binding trap)

test('integer arguments are bound as integers: integer division, typeof integer', () => {
  const turso = newTurso();
  const [{ response }] = turso.run([
    exec('SELECT typeof(?) AS ti, typeof(?) AS tf, (? - ?) / 1000 AS d', [
      int(5), float(5), int('1762160001001'), int('1762160000000'),
    ]),
  ]).results;
  assert.deepEqual(response.result.rows[0], [text('integer'), text('real'), int(1)]);
});

test('control: node:sqlite itself binds plain JS numbers as REAL, which is why the fake must use BigInt', () => {
  const db = new DatabaseSync(':memory:');
  const row = db.prepare('SELECT typeof(?) AS t, (? - ?) / 1000 AS d').get(5, 1762160001001, 1762160000000);
  assert.equal(row.t, 'real');
  assert.equal(row.d, 1.001);
});

// The timer-stop statement of BUILD_SPEC section 6.4, verbatim, against the columns and CHECKs of migration 001.
// duration_s is computed by SQL from bare `?` parameters, which is where plain-number binding goes wrong: the
// parameters become REAL, the division becomes float division, and the CHECK refuses the row. (Inserting integers
// straight into INTEGER columns would NOT show the trap, because column affinity converts them back.)
const TIMER_STOP_SCHEMA = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, hourly_rate_minor INTEGER, cost_rate_minor INTEGER);
  CREATE TABLE active_timers (
    user_id TEXT PRIMARY KEY, timer_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, project_id TEXT, task_id TEXT,
    description TEXT NOT NULL DEFAULT '', billable INTEGER NOT NULL DEFAULT 1, tag_ids_json TEXT NOT NULL DEFAULT '[]',
    started_at INTEGER NOT NULL, local_date TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE time_entries (
    id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, project_id TEXT, task_id TEXT,
    description TEXT NOT NULL DEFAULT '', start_at INTEGER NOT NULL, end_at INTEGER NOT NULL,
    duration_s INTEGER NOT NULL, local_date TEXT NOT NULL, billable INTEGER NOT NULL,
    hourly_rate_minor INTEGER, cost_rate_minor INTEGER, source TEXT NOT NULL, stop_reason TEXT,
    timer_id TEXT UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    CHECK (end_at >= start_at), CHECK (end_at - start_at <= 86400000), CHECK (duration_s = (end_at - start_at) / 1000));
  INSERT INTO projects VALUES ('p1', 12000, 5000);
  INSERT INTO active_timers (user_id, timer_id, workspace_id, project_id, started_at, local_date)
    VALUES ('u1', 't1', 'w1', 'p1', 1762160000000, '2025-11-03');`;

const TIMER_STOP_SQL = `INSERT INTO time_entries (id, workspace_id, user_id, project_id, task_id, description, start_at, end_at,
  duration_s, local_date, billable, hourly_rate_minor, cost_rate_minor, source, stop_reason, timer_id,
  created_at, updated_at)
SELECT ?, t.workspace_id, t.user_id, t.project_id, t.task_id, t.description, t.started_at,
       MIN(MAX(?, t.started_at), t.started_at + ?),
       (MIN(MAX(?, t.started_at), t.started_at + ?) - t.started_at) / 1000,
       t.local_date, t.billable,
       (SELECT hourly_rate_minor FROM projects WHERE id = t.project_id),
       (SELECT cost_rate_minor FROM projects WHERE id = t.project_id),
       'TIMER', ?, t.timer_id, ?, ?
FROM active_timers t WHERE t.user_id = ? AND t.timer_id = ?`;

const stopArgs = (entryId, endAt, capMs) => [
  text(entryId), int(endAt), int(capMs), int(endAt), int(capMs), text('USER'), int(endAt), int(endAt), text('u1'), text('t1'),
];

test('an odd-millisecond stop passes the duration_s CHECK (spec section 10)', () => {
  const turso = newTurso(TIMER_STOP_SCHEMA);
  const start = 1762160000000;
  const capMs = 14 * 3600 * 1000;
  const end = start + 1234567;                 // an odd number of milliseconds: 1234 whole seconds and 567 ms

  const [stop, read] = turso.run([
    exec(TIMER_STOP_SQL, stopArgs('e1', end, capMs)),
    exec('SELECT end_at, duration_s, typeof(duration_s) FROM time_entries WHERE id = ?', [text('e1')]),
  ]).results;
  assert.equal(stop.type, 'ok', JSON.stringify(stop));
  assert.equal(stop.response.result.affected_row_count, 1);
  assert.deepEqual(read.response.result.rows[0], [int(end), int(1234), text('integer')]);
});

test('the same stop statement is still capped at AUTO_STOP_HOURS and still refused for a wrong duration', () => {
  const turso = newTurso(TIMER_STOP_SCHEMA);
  const start = 1762160000000;
  const capMs = 14 * 3600 * 1000;

  // a stop far past the cap lands exactly on start + cap
  const [capped, read] = turso.run([
    exec(TIMER_STOP_SQL, stopArgs('e1', start + 20 * 3600 * 1000 + 999, capMs)),
    exec('SELECT end_at - start_at, duration_s FROM time_entries'),
  ]).results;
  assert.equal(capped.type, 'ok', JSON.stringify(capped));
  assert.deepEqual(read.response.result.rows[0], [int(capMs), int(14 * 3600)]);

  // the duration_s CHECK itself still bites
  turso.db.exec('DELETE FROM time_entries');
  const wrong = turso.run([exec(
    `INSERT INTO time_entries (id, workspace_id, user_id, start_at, end_at, duration_s, local_date, billable, source, created_at, updated_at)
     VALUES ('e2', 'w1', 'u1', ?, ?, ?, '2025-11-03', 1, 'TIMER', 0, 0)`,
    [int(start), int(start + 1234567), int(1235)])]).results[0];
  assert.equal(wrong.type, 'error');
  assert.match(wrong.error.message, /CHECK constraint failed/);
});

test('malformed arguments are refused as bad requests, not bound loosely', () => {
  const turso = newTurso();
  const cases = [
    [{ type: 'integer', value: 5 }, /integer value must be a decimal string/],
    [{ type: 'integer', value: '5.5' }, /integer value must be a decimal string/],
    [{ type: 'float', value: '1.5' }, /float value must be a number/],
    [{ type: 'text', value: 5 }, /text value must be a string/],
    [{ type: 'bool', value: true }, /unknown argument type/],
    [5, /unknown argument type/],
  ];
  for (const [arg, pattern] of cases) {
    const [result] = turso.run([exec('SELECT ?', [arg])]).results;
    assert.equal(result.type, 'error', JSON.stringify(arg));
    assert.match(result.error.message, pattern);
    assert.equal(result.error.code, 'BAD_REQUEST');
  }
  const [named] = turso.run([{ type: 'execute', stmt: { sql: 'SELECT :a', named_args: [{ name: 'a', value: int(1) }] } }]).results;
  assert.match(named.error.message, /named_args/);
});

// ---------------------------------------------------------------- transactions

function failingMiddleStepBatch() {
  // The shape of BUILD_SPEC section 5.2: every step after BEGIN depends on the previous one.
  return batch([
    { stmt: stmt('BEGIN IMMEDIATE') },
    { condition: ok(0), stmt: stmt('INSERT INTO t (v) VALUES (?)', [int(1)]) },
    { condition: ok(1), stmt: stmt('INSERT INTO t (v) VALUES (?)', [nul()]) },        // fails: NOT NULL
    { condition: ok(2), stmt: stmt('COMMIT') },
    { condition: { type: 'not', cond: ok(3) }, stmt: stmt('ROLLBACK') },
  ]);
}

test('conditional batch: a failing middle step skips COMMIT, runs ROLLBACK, and leaves no rows', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  const response = turso.run([failingMiddleStepBatch(), close]);
  const { step_results: results, step_errors: errors } = response.results[0].response.result;

  assert.equal(errors[2].message.includes('NOT NULL'), true);
  assert.equal(results[3], null, 'COMMIT is skipped: its condition was false');
  assert.equal(errors[3], null);
  assert.notEqual(results[4], null, 'ROLLBACK ran because COMMIT did not succeed');
  assert.equal(count(turso, 't'), 0, 'nothing from steps 1-2 survived');
  assert.equal(turso.db.isTransaction, false);
});

test('conditional batch: the all-success path commits and skips ROLLBACK', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  const response = turso.run([batch([
    { stmt: stmt('BEGIN IMMEDIATE') },
    { condition: ok(0), stmt: stmt('INSERT INTO t (v) VALUES (?)', [int(1)]) },
    { condition: ok(1), stmt: stmt('INSERT INTO t (v) VALUES (?)', [int(2)]) },
    { condition: ok(2), stmt: stmt('COMMIT') },
    { condition: { type: 'not', cond: ok(3) }, stmt: stmt('ROLLBACK') },
  ]), close]);
  const { step_results: results, step_errors: errors } = response.results[0].response.result;
  assert.ok(errors.every(e => e === null));
  assert.equal(results[4], null, 'ROLLBACK is skipped');
  assert.equal(count(turso, 't'), 2);
});

test('plain BEGIN / insert / failing insert / COMMIT pipeline does NOT roll back: the first insert is saved', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  const response = turso.run([
    exec('BEGIN IMMEDIATE'),
    exec('INSERT INTO t (v) VALUES (?)', [int(1)]),
    exec('INSERT INTO t (v) VALUES (?)', [nul()]),
    exec('COMMIT'),
    close,
  ]);
  assert.deepEqual(response.results.map(r => r.type), ['ok', 'ok', 'error', 'ok', 'ok'],
    'an error does not stop the pipeline');
  assert.equal(count(turso, 't'), 1, 'this is why every step after BEGIN carries a condition');
});

test('a transaction left open at the end of a pipeline is rolled back', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  turso.run([exec('BEGIN IMMEDIATE'), exec('INSERT INTO t (v) VALUES (?)', [int(1)]), close]);
  assert.equal(count(turso, 't'), 0);
  assert.equal(turso.db.isTransaction, false);

  // also when the client forgot the trailing close (no baton: each call is its own stream)
  turso.run([exec('BEGIN IMMEDIATE'), exec('INSERT INTO t (v) VALUES (?)', [int(2)])]);
  assert.equal(count(turso, 't'), 0);

  // and the next pipeline starts in autocommit mode
  const [{ response }] = turso.run([batch([{ condition: { type: 'is_autocommit' }, stmt: stmt('SELECT 1') }])]).results;
  assert.notEqual(response.result.step_results[0], null);
});

test('a pipeline that ends on a request error still rolls back what it left open', () => {
  const turso = newTurso('CREATE TABLE t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)');
  turso.run([exec('BEGIN IMMEDIATE'), exec('INSERT INTO t (v) VALUES (?)', [int(1)]), { type: 'nonsense' }]);
  assert.equal(count(turso, 't'), 0);
  assert.equal(turso.db.isTransaction, false);
});

// ---------------------------------------------------------------- the _assert pattern

test('assert insert: a false condition fails the step with NOT NULL, a true one writes nothing', () => {
  const turso = newTurso(`CREATE TABLE _assert (must_exist INTEGER NOT NULL);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO accounts VALUES ('u1', 'ACTIVE')`);
  const assertSql = 'INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT (EXISTS (SELECT 1 FROM accounts WHERE id = ? AND status = ?))';
  const { step_results: results, step_errors: errors } = turso.run([batch([
    { stmt: stmt(assertSql, [text('u1'), text('ACTIVE')]) },
    { stmt: stmt(assertSql, [text('u1'), text('INACTIVE')]) },
    { stmt: stmt(assertSql, [text('nobody'), text('ACTIVE')]) },
  ])]).results[0].response.result;

  assert.equal(errors[0], null);
  assert.notEqual(results[0], null);
  assert.match(errors[1].message, /NOT NULL constraint failed: _assert\.must_exist/);
  assert.match(errors[2].message, /NOT NULL constraint failed: _assert\.must_exist/);
  assert.equal(count(turso, '_assert'), 0, 'no row is ever left in _assert');
});

// ---------------------------------------------------------------- conditions

test('conditions: ok, error, not, and, or, is_autocommit; skipped steps are neither ok nor error', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER NOT NULL)');
  const mark = n => stmt('SELECT ' + n);
  const { step_results: results } = turso.run([batch([
    { stmt: stmt('INSERT INTO t VALUES (NULL)') },                                                 // 0 fails
    { condition: { type: 'error', step: 0 }, stmt: mark(1) },                                      // 1 runs
    { condition: ok(0), stmt: mark(2) },                                                           // 2 skipped
    { condition: { type: 'error', step: 2 }, stmt: mark(3) },                                      // 3 skipped (2 was skipped, not failed)
    { condition: { type: 'not', cond: ok(2) }, stmt: mark(4) },                                    // 4 runs
    { condition: { type: 'and', conds: [ok(1), { type: 'not', cond: ok(2) }] }, stmt: mark(5) },   // 5 runs
    { condition: { type: 'and', conds: [ok(1), ok(2)] }, stmt: mark(6) },                          // 6 skipped
    { condition: { type: 'or', conds: [ok(0), ok(1)] }, stmt: mark(7) },                           // 7 runs
    { condition: { type: 'or', conds: [ok(0), ok(2)] }, stmt: mark(8) },                           // 8 skipped
    { condition: { type: 'is_autocommit' }, stmt: mark(9) },                                       // 9 runs
  ])]).results[0].response.result;
  assert.deepEqual(results.map(r => r !== null), [false, true, false, false, true, true, false, true, false, true]);
});

test('is_autocommit is false inside a transaction', () => {
  const turso = newTurso();
  const { step_results: results } = turso.run([batch([
    { stmt: stmt('BEGIN IMMEDIATE') },
    { condition: { type: 'is_autocommit' }, stmt: stmt('SELECT 1') },
    { condition: { type: 'not', cond: { type: 'is_autocommit' } }, stmt: stmt('SELECT 2') },
    { stmt: stmt('ROLLBACK') },
  ])]).results[0].response.result;
  assert.deepEqual(results.map(r => r !== null), [true, false, true, true]);
});

test('a condition that points at a step that has not run yet is a bad request', () => {
  const turso = newTurso();
  const [result] = turso.run([batch([{ condition: ok(1), stmt: stmt('SELECT 1') }, { stmt: stmt('SELECT 2') }])]).results;
  assert.equal(result.type, 'error');
  assert.match(result.error.message, /step 1/);
  assert.equal(result.error.code, 'BAD_REQUEST');
});

// ---------------------------------------------------------------- read-only token

const WRITES = [
  "INSERT INTO t VALUES (1)",
  "UPDATE t SET v = 2",
  "DELETE FROM t",
  "DROP TABLE t",
  "CREATE TABLE x (a)",
  "BEGIN IMMEDIATE",
  "PRAGMA query_only = OFF",
  "WITH c AS (SELECT 9 AS v) INSERT INTO t SELECT v FROM c",
  "  /* sneaky */ INSERT INTO t VALUES (3)",
  "SELECT 1; INSERT INTO t VALUES (4)",
];

test('the read-only token cannot write: every write form is refused and nothing changes', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1)');
  for (const sql of WRITES) {
    const [direct] = turso.run([exec(sql)], TOKENS.ro).results;
    assert.equal(direct.type, 'error', sql);
    const { step_errors: errors } = turso.run([batch([{ stmt: stmt(sql) }])], TOKENS.ro).results[0].response.result;
    assert.notEqual(errors[0], null, sql);
  }
  assert.deepEqual(turso.db.prepare('SELECT v FROM t').all().map(r => Number(r.v)), [1]);
  assert.equal(turso.db.isTransaction, false);
});

test('the read-only token can SELECT, including WITH ... SELECT, comments first, and table-valued pragmas', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (1), (2)');
  const reads = [
    ['SELECT SUM(v) FROM t', int(3)],
    ['-- leading comment\nSELECT COUNT(*) FROM t', int(2)],
    ['/* c */ WITH c AS (SELECT v FROM t) SELECT MAX(v) FROM c', int(2)],
    ['SELECT page_count * page_size > 0 FROM pragma_page_count(), pragma_page_size()', int(1)],
    ['SELECT 1;', int(1)],
  ];
  for (const [sql, expected] of reads) {
    const [result] = turso.run([exec(sql)], TOKENS.ro).results;
    assert.equal(result.type, 'ok', sql + ' -> ' + JSON.stringify(result));
    assert.deepEqual(result.response.result.rows[0][0], expected, sql);
  }
});

test('read-only mode does not leak: the read-write token can write right after a read-only call', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER)');
  turso.run([exec('SELECT 1')], TOKENS.ro);
  const [result] = turso.run([exec('INSERT INTO t VALUES (1)')], TOKENS.rw).results;
  assert.equal(result.type, 'ok');
  assert.equal(count(turso, 't'), 1);
});

test('a statement string with a second statement is refused rather than half-executed', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER)');
  const [result] = turso.run([exec('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')]).results;
  assert.equal(result.type, 'error');
  assert.match(result.error.message, /exactly one/);
  assert.equal(count(turso, 't'), 0);
  // semicolons inside strings and comments are fine
  const [fine] = turso.run([exec("SELECT 'a;b' AS x -- trailing; comment")]).results;
  assert.equal(fine.type, 'ok');
});

// ---------------------------------------------------------------- request handling

test('unknown request types, requests after close, batons and malformed bodies are refused', () => {
  const turso = newTurso();
  const unknown = turso.run([{ type: 'describe' }]).results[0];
  assert.equal(unknown.type, 'error');
  assert.match(unknown.error.message, /unsupported request type "describe"/);

  const afterClose = turso.run([close, exec('SELECT 1')]).results;
  assert.equal(afterClose[0].type, 'ok');
  assert.equal(afterClose[1].type, 'error');
  assert.match(afterClose[1].error.message, /closed/);

  assert.equal(turso.handleBody(TOKENS.rw, { baton: 'abc', requests: [] }).status, 400);
  assert.equal(turso.handleBody(TOKENS.rw, { requests: 'no' }).status, 400);
  assert.equal(turso.handleBody(TOKENS.rw, null).status, 400);
  assert.equal(turso.handleBody('wrong-token', { requests: [] }).status, 401);
});

test('row counters add up writes and reads', () => {
  const turso = newTurso('CREATE TABLE t (v INTEGER)');
  const [write, read] = turso.run([
    exec('INSERT INTO t VALUES (1), (2), (3)'),
    exec('SELECT * FROM t'),
  ]).results;
  assert.equal(write.response.result.rows_written, 3);
  assert.ok(read.response.result.rows_read >= 3);
  assert.equal(read.response.result.rows_written, 0);
});

// ---------------------------------------------------------------- through UrlFetchApp

test('attached to the fakes, app code reaches it with fetch: tokens, paths and JSON are checked', () => {
  const fakes = createFakes();
  const turso = createFakeTurso();
  const origin = turso.attach(fakes);
  turso.db.exec('CREATE TABLE t (v INTEGER)');
  const ctx = loadApp({ fakes });

  const call = (token, path, body, method = 'post') => ctx.__plain(runInApp(ctx, `(function () {
    var r = UrlFetchApp.fetch(${JSON.stringify(origin + path)}, {
      method: ${JSON.stringify(method)}, contentType: 'application/json', muteHttpExceptions: true,
      headers: { Authorization: 'Bearer ' + ${JSON.stringify(token)} }, payload: ${JSON.stringify(body)} });
    return { status: r.getResponseCode(), body: r.getContentText() };
  })()`));

  const good = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: 'INSERT INTO t VALUES (?)', args: [int(7)] } }, close] });
  const ok200 = call(TOKENS.rw, '/v2/pipeline', good);
  assert.equal(ok200.status, 200);
  assert.equal(JSON.parse(ok200.body).results[0].response.result.affected_row_count, 1);
  assert.equal(count(turso, 't'), 1);

  assert.equal(call('nope', '/v2/pipeline', good).status, 401);
  assert.equal(call(TOKENS.rw, '/v2/other', good).status, 404);
  assert.equal(call(TOKENS.rw, '/v2/pipeline', good, 'get').status, 405);
  assert.equal(call(TOKENS.rw, '/v2/pipeline', 'not json').status, 400);

  const roWrite = call(TOKENS.ro, '/v2/pipeline', good);
  assert.equal(roWrite.status, 200);
  assert.equal(JSON.parse(roWrite.body).results[0].type, 'error');
  assert.equal(count(turso, 't'), 1, 'the read-only call wrote nothing');
});

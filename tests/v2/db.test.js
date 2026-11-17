'use strict';

// T1.4 — Db.gs: the Turso client (BUILD_SPEC sections 5.2 and 5.3): argument encoding, response decoding,
// Db.read_, the Db.tx_ builder, every error-mapping branch, duplicate request ids, rate limiting, usage counters.
//
// Tests run against fake-turso.js with the real migration 001 applied, so request_log, _assert and audit_log are the
// real tables. `notes` and `counter` are test-only tables.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');

let sequence = 0;

function setup() {
  const env = createEnv();
  env.run('Migrations.run_()');
  env.turso.db.exec(`
    CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL CHECK (length(body) <= 5));
    CREATE TABLE counter (n INTEGER NOT NULL);
    INSERT INTO counter VALUES (0);`);
  env.fakes.fetch.calls.length = 0;                 // forget the migration's calls
  return env;
}

// What Main will pass (section 5.3): the caller, the request id, the action, the payload hash and the time.
function ctxFor(env, overrides = {}) {
  sequence += 1;
  return {
    userId: 'u1', requestId: `req-${sequence}`, action: 'notes.add', payloadHash: 'a'.repeat(64),
    now: env.fakes.clock.now(), ...overrides,
  };
}

const auditRow = (ctx, overrides = {}) => ({
  ts: ctx.now, actor_user_id: ctx.userId, actor_role: 'USER', workspace_id: 'w1', entity_type: 'NOTE',
  entity_id: 'n1', action: 'NOTE_ADDED', before_json: null, after_json: '{"id":"n1"}', reason: null,
  request_id: ctx.requestId, ...overrides,
});

const plain = (env, value) => env.ctx.__plain(value);
const rows = (env, sql) => env.turso.db.prepare(sql).all().map(row => ({ ...row }));
const sent = env => env.fakes.fetch.calls.map(call => JSON.parse(call.payload));
const stepsOf = (env, call = 0) => sent(env)[call].requests[0].batch.steps;
const text = value => ({ type: 'text', value });
const integer = value => ({ type: 'integer', value: String(value) });

function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}
function expectCode(fn, code) {
  const err = thrown(fn);
  assert.ok(err, `expected ${code} but nothing was thrown`);
  assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message} ${JSON.stringify(err.details)}`);
  return err;
}

// An insert into notes in one transaction; the typical write.
function addNote(env, ctx, id, body = 'hi') {
  const tx = env.ctx.Db.tx_(ctx);
  tx.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', [id, body]).result({ id });
  return tx.commit();
}
const noteIds = env => rows(env, 'SELECT id FROM notes ORDER BY id').map(row => row.id);

// ---------------------------------------------------------------- argument encoding

test('arg_ encodes null, integers, floats, booleans and strings as Hrana values', () => {
  const env = createEnv();
  const arg = value => plain(env, env.ctx.Db.arg_(value));
  assert.deepEqual(arg(null), { type: 'null' });
  assert.deepEqual(arg(undefined), { type: 'null' });
  assert.deepEqual(arg(0), integer(0));
  assert.deepEqual(arg(-7), integer(-7));
  assert.deepEqual(arg(-0), integer(0));
  assert.deepEqual(arg(1762160000000), integer('1762160000000'));
  assert.deepEqual(arg(Number.MAX_SAFE_INTEGER), integer('9007199254740991'));
  assert.deepEqual(arg(2 ** 53), { type: 'float', value: 9007199254740992 }, 'not a safe integer, so it is a float');
  assert.deepEqual(arg(1.5), { type: 'float', value: 1.5 });
  assert.deepEqual(arg(true), integer(1));
  assert.deepEqual(arg(false), integer(0));
  assert.deepEqual(arg('héllo'), text('héllo'));
  assert.deepEqual(arg(''), text(''));
});

test('arg_ refuses everything else instead of guessing', () => {
  const env = createEnv();
  for (const value of [NaN, Infinity, -Infinity, {}, [1], new Date(0), 10n, () => 1, Symbol('x')]) {
    expectCode(() => env.ctx.Db.arg_(value), 'INTERNAL');
  }
});

// ---------------------------------------------------------------- response decoding and Db.read_

test('read_ returns one array of row objects per statement, from one HTTP call', () => {
  const env = setup();
  env.turso.db.exec("INSERT INTO notes VALUES ('a', 'one'), ('b', 'two')");
  const result = plain(env, env.ctx.Db.read_([
    { sql: 'SELECT id, body FROM notes ORDER BY id' },
    { sql: 'SELECT COUNT(*) AS n FROM notes WHERE id > ?', args: ['a'] },
    { sql: 'SELECT id FROM notes WHERE 0' },
  ]));
  assert.deepEqual(result, [[{ id: 'a', body: 'one' }, { id: 'b', body: 'two' }], [{ n: 1 }], []]);
  assert.equal(env.fakes.fetch.calls.length, 1);
});

test('read_ decodes integers, floats, text and null', () => {
  const env = setup();
  const [[row]] = plain(env, env.ctx.Db.read_([{
    sql: "SELECT ? AS i, ? AS neg, 2.5 AS f, 'x' AS t, NULL AS n, 9007199254740991 AS edge",
    args: [42, -3],
  }]));
  assert.deepEqual(row, { i: 42, neg: -3, f: 2.5, t: 'x', n: null, edge: 9007199254740991 });
});

test('read_ refuses an integer beyond the safe range and refuses blobs', () => {
  const env = setup();
  const big = expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT 9007199254740993 AS big' }]), 'INTERNAL');
  assert.match(big.details.error, /safe/i);
  const blob = expectCode(() => env.ctx.Db.read_([{ sql: "SELECT x'ff' AS b" }]), 'INTERNAL');
  assert.match(blob.details.error, /blob/i);
});

test('read_ sends no BEGIN and no conditions, uses the read-only token by default, and ends with close', () => {
  const env = setup();
  env.ctx.Db.read_([{ sql: 'SELECT 1' }, { sql: 'SELECT ?', args: [2] }]);
  const [call] = env.fakes.fetch.calls;
  assert.equal(call.url, env.origin + '/v2/pipeline');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer test-ro');
  assert.equal(call.contentType, 'application/json');
  assert.equal(call.muteHttpExceptions, true);
  const { requests } = JSON.parse(call.payload);
  assert.deepEqual(requests[1], { type: 'close' });
  assert.deepEqual(requests[0].batch.steps, [
    { stmt: { sql: 'SELECT 1', args: [] } },
    { stmt: { sql: 'SELECT ?', args: [integer(2)] } },
  ]);
});

test('read_ uses the read-write token only when asked, and refuses an unknown token name', () => {
  const env = setup();
  env.ctx.Db.read_([{ sql: 'SELECT 1' }], { token: 'rw' });
  assert.equal(env.fakes.fetch.calls[0].headers.Authorization, 'Bearer test-rw');
  expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT 1' }], { token: 'admin' }), 'INTERNAL');
});

test('read_ cannot write: the read-only token refuses, the error is INTERNAL, and nothing changes', () => {
  const env = setup();
  const err = expectCode(() => env.ctx.Db.read_([{ sql: "INSERT INTO notes VALUES ('x', 'y')" }]), 'INTERNAL');
  assert.match(err.details.error, /readonly/);
  assert.deepEqual(noteIds(env), []);
});

test('read_ with no statements makes no call', () => {
  const env = setup();
  assert.deepEqual(plain(env, env.ctx.Db.read_([])), []);
  assert.equal(env.fakes.fetch.calls.length, 0);
});

test('read_ maps a locked database to BUSY and a bad statement to INTERNAL with the SQL error in details', () => {
  const env = setup();
  env.turso.injectError({ match: 'SELECT 1', message: 'database is locked' });
  const busy = expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT 1' }]), 'BUSY');
  assert.equal(busy.retryable, true);

  const internal = expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT * FROM nowhere' }]), 'INTERNAL');
  assert.match(internal.details.error, /no such table: nowhere/);
  assert.equal(internal.retryable, false);
  assert.doesNotMatch(internal.message, /nowhere/, 'the message stays generic; the detail is for the log');
});

// ---------------------------------------------------------------- Db.tx_: what is sent

test('tx_ sends one call: BEGIN, request_log, rate limit, caller steps, audit, COMMIT, conditional ROLLBACK', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  tx.assert('free', 'NOT EXISTS (SELECT 1 FROM notes WHERE id = ?)', ['n1'], 'CONFLICT', 'taken')
    .exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi'])
    .select('rows', 'SELECT id FROM notes')
    .audit(auditRow(ctx))
    .result({ id: 'n1' });
  tx.commit();

  assert.equal(env.fakes.fetch.calls.length, 1);
  const { requests } = sent(env)[0];
  assert.deepEqual(requests[1], { type: 'close' });
  const steps = requests[0].batch.steps;
  const sql = steps.map(step => step.stmt.sql);

  assert.equal(sql[0], 'BEGIN IMMEDIATE');
  assert.match(sql[1], /^INSERT INTO request_log \(/);
  assert.match(sql[2], /^INSERT INTO _assert \(must_exist\) SELECT NULL WHERE NOT \(\(SELECT COUNT\(\*\) FROM request_log WHERE user_id = \? AND created_at > \?\) <= \?\)$/);
  assert.equal(sql[3], 'INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT (NOT EXISTS (SELECT 1 FROM notes WHERE id = ?))');
  assert.equal(sql[4], 'INSERT INTO notes (id, body) VALUES (?, ?)');
  assert.equal(sql[5], 'SELECT id FROM notes');
  assert.match(sql[6], /^INSERT INTO audit_log \(/);
  assert.equal(sql[7], 'COMMIT');
  assert.equal(sql[8], 'ROLLBACK');
  assert.equal(steps.length, 9);

  assert.equal(steps[0].condition, undefined);
  for (let i = 1; i <= 7; i += 1) assert.deepEqual(steps[i].condition, { type: 'ok', step: i - 1 }, `step ${i}`);
  assert.deepEqual(steps[8].condition, { type: 'not', cond: { type: 'ok', step: 7 } });

  assert.deepEqual(steps[1].stmt.args, [
    text('u1'), text(ctx.requestId), text('notes.add'), text('a'.repeat(64)), text('{"id":"n1"}'), integer(ctx.now),
  ]);
  assert.deepEqual(steps[2].stmt.args, [text('u1'), integer(ctx.now - 60000), integer(60)]);
  assert.deepEqual(steps[3].stmt.args, [text('n1')]);
  assert.equal(env.fakes.fetch.calls[0].headers.Authorization, 'Bearer test-rw', 'writes always use the read-write token');
});

test('audit rows go after every caller step, whatever order the calls were made in', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  tx.audit(auditRow(ctx)).exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi']);
  tx.commit();
  const sql = stepsOf(env).map(step => step.stmt.sql);
  assert.ok(sql.findIndex(s => s.startsWith('INSERT INTO notes')) < sql.findIndex(s => s.startsWith('INSERT INTO audit_log')));
});

test('the SYSTEM user skips the rate-limit step', () => {
  const env = setup();
  addNote(env, ctxFor(env, { userId: 'SYSTEM' }), 'n1');
  const sql = stepsOf(env).map(step => step.stmt.sql);
  assert.equal(sql.length, 5, 'BEGIN, request_log, insert, COMMIT, ROLLBACK');
  assert.ok(!sql.some(s => s.includes('created_at > ?')));
});

test('integer arguments are sent as integer values, so SQL integer maths stays integer', () => {
  const env = setup();
  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('set', 'UPDATE counter SET n = (? - ?) / 1000', [1762160001001, 1762160000000]);
  tx.commit();
  assert.deepEqual(stepsOf(env)[3].stmt.args, [integer('1762160001001'), integer('1762160000000')]);
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 1, 'integer division, not 1.001');
});

// ---------------------------------------------------------------- Db.tx_: what happens

test('a successful commit applies the writes, logs the request, writes the audit row, and returns the selects', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  tx.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi'])
    .select('mine', 'SELECT id, body FROM notes WHERE id = ?', ['n1'])
    .audit(auditRow(ctx))
    .result({ id: 'n1' });
  const outcome = plain(env, tx.commit());

  assert.deepEqual(outcome, { ok: true, selects: { mine: [{ id: 'n1', body: 'hi' }] } });
  assert.deepEqual(noteIds(env), ['n1']);
  const [log] = rows(env, 'SELECT * FROM request_log');
  assert.deepEqual({ ...log, created_at: Number(log.created_at) }, {
    user_id: 'u1', request_id: ctx.requestId, action: 'notes.add', payload_sha256: 'a'.repeat(64),
    result_json: '{"id":"n1"}', created_at: ctx.now,
  });
  const [audit] = rows(env, 'SELECT * FROM audit_log');
  assert.equal(Number(audit.seq), 1);
  assert.equal(audit.action, 'NOTE_ADDED');
  assert.equal(audit.request_id, ctx.requestId);
  assert.equal(audit.workspace_id, 'w1');
  assert.equal(audit.after_json, '{"id":"n1"}');
  assert.equal(audit.before_json, null);
  assert.deepEqual([audit.prev_hash, audit.record_hash, audit.key_version, audit.sealed_at], [null, null, null, null],
    'rows are unsealed until the sealer runs');
  assert.equal(rows(env, 'SELECT * FROM _assert').length, 0);
  assert.equal(env.turso.db.isTransaction, false);
});

test('without result() the stored result is {}; audit rows accumulate with rising seq', () => {
  const env = setup();
  const one = ctxFor(env);
  const two = ctxFor(env);
  env.ctx.Db.tx_(one).exec('n', 'UPDATE counter SET n = n + 1').audit(auditRow(one)).commit();
  env.ctx.Db.tx_(two).exec('n', 'UPDATE counter SET n = n + 1').audit(auditRow(two)).audit(auditRow(two, { action: 'SECOND' })).commit();
  assert.deepEqual(rows(env, 'SELECT result_json FROM request_log ORDER BY created_at, request_id').map(r => r.result_json), ['{}', '{}']);
  assert.deepEqual(rows(env, 'SELECT seq FROM audit_log ORDER BY seq').map(r => Number(r.seq)), [1, 2, 3]);
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 2);
});

test('select() sees the transaction\'s own writes, and several selects come back by label', () => {
  const env = setup();
  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi'])
    .select('after', 'SELECT COUNT(*) AS n FROM notes')
    .select('who', 'SELECT id FROM notes WHERE id = ?', ['n1']);
  assert.deepEqual(plain(env, tx.commit()).selects, { after: [{ n: 1 }], who: [{ id: 'n1' }] });
});

test('audit() refuses a row with a missing required field, at the call', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  for (const field of ['ts', 'actor_user_id', 'actor_role', 'entity_type', 'entity_id', 'action', 'request_id']) {
    const row = auditRow(ctx);
    delete row[field];
    expectCode(() => tx.audit(row), 'INTERNAL');
  }
  // fields the sealer owns, or that do not exist, are refused rather than silently dropped
  for (const extra of ['seq', 'prev_hash', 'record_hash', 'sealed_at', 'surprise']) {
    expectCode(() => tx.audit({ ...auditRow(ctx), [extra]: 'x' }), 'INTERNAL');
  }
  // nullable fields may be left out
  const slim = auditRow(ctx);
  for (const field of ['workspace_id', 'before_json', 'after_json', 'reason']) delete slim[field];
  assert.doesNotThrow(() => tx.audit(slim));
});

// ---------------------------------------------------------------- Db.tx_: asserts and exec errors

test('a failing assert throws its code, message and details, runs nothing after it, and leaves no trace', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  tx.assert('active', 'EXISTS (SELECT 1 FROM notes WHERE id = ?)', ['nope'], 'NOT_FOUND', 'No such note', { field: 'id' })
    .exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi'])
    .audit(auditRow(ctx));
  const err = expectCode(() => tx.commit(), 'NOT_FOUND');
  assert.equal(err.message, 'No such note');
  assert.deepEqual(plain(env, err.details), { field: 'id' });
  assert.deepEqual(noteIds(env), []);
  assert.equal(rows(env, 'SELECT * FROM request_log').length, 0, 'the request_log row was rolled back too');
  assert.equal(rows(env, 'SELECT * FROM audit_log').length, 0);
  assert.equal(rows(env, 'SELECT * FROM _assert').length, 0);
  assert.equal(env.turso.db.isTransaction, false);
});

test('a passing assert writes nothing; the first failing assert of several wins', () => {
  const env = setup();
  env.turso.db.exec("INSERT INTO notes VALUES ('a', 'x')");
  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.assert('one', 'EXISTS (SELECT 1 FROM notes WHERE id = ?)', ['a'], 'FORBIDDEN', 'never shown')
    .assert('two', 'EXISTS (SELECT 1 FROM notes WHERE id = ?)', ['b'], 'POLICY', 'second')
    .assert('three', 'EXISTS (SELECT 1 FROM notes WHERE id = ?)', ['c'], 'CONFLICT', 'third');
  assert.equal(expectCode(() => tx.commit(), 'POLICY').message, 'second');
});

test('a failed write is not remembered: the same request id is processed again, not treated as a duplicate', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const failing = () => {
    const tx = env.ctx.Db.tx_(ctx);
    tx.assert('never', '0', [], 'FORBIDDEN', 'no');
    return tx.commit();
  };
  expectCode(failing, 'FORBIDDEN');
  expectCode(failing, 'FORBIDDEN');
  assert.deepEqual(plain(env, addNote(env, ctx, 'n1')), { ok: true, selects: {} });
});

test('exec: a UNIQUE failure is CONFLICT, onError overrides the mapping, anything else is INTERNAL', () => {
  const env = setup();
  addNote(env, ctxFor(env), 'n1');

  const conflict = expectCode(() => addNote(env, ctxFor(env), 'n1'), 'CONFLICT');
  assert.match(conflict.message, /conflict/i);
  assert.equal(conflict.retryable, false);

  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'x'], { code: 'CONFLICT', message: 'A note with that id exists', details: { field: 'id' } });
  const custom = expectCode(() => tx.commit(), 'CONFLICT');
  assert.equal(custom.message, 'A note with that id exists');
  assert.deepEqual(plain(env, custom.details), { field: 'id' });

  const tooLong = expectCode(() => addNote(env, ctxFor(env), 'n2', 'far too long'), 'INTERNAL');
  assert.match(tooLong.details.error, /CHECK constraint failed/);
  assert.doesNotMatch(tooLong.message, /CHECK/);

  const mapped = env.ctx.Db.tx_(ctxFor(env));
  mapped.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n3', 'far too long'], { code: 'VALIDATION', message: 'Body too long' });
  assert.equal(expectCode(() => mapped.commit(), 'VALIDATION').message, 'Body too long');
  assert.deepEqual(noteIds(env), ['n1'], 'nothing from the failed transactions survived');
});

test('a failing exec rolls back the exec steps before it', () => {
  const env = setup();
  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('bump', 'UPDATE counter SET n = n + 1')
    .exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'far too long']);
  expectCode(() => tx.commit(), 'INTERNAL');
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 0);
  assert.equal(rows(env, 'SELECT * FROM request_log').length, 0);
});

test('a failing select or audit insert is INTERNAL', () => {
  const env = setup();
  const badSelect = env.ctx.Db.tx_(ctxFor(env));
  badSelect.select('x', 'SELECT * FROM nowhere');
  assert.match(expectCode(() => badSelect.commit(), 'INTERNAL').details.error, /no such table/);

  const ctx = ctxFor(env);
  env.turso.injectError({ match: 'INSERT INTO audit_log', message: 'disk I/O error' });
  const badAudit = env.ctx.Db.tx_(ctx);
  badAudit.exec('bump', 'UPDATE counter SET n = n + 1').audit(auditRow(ctx));
  expectCode(() => badAudit.commit(), 'INTERNAL');
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 0, 'the write did not survive its failed audit row');
});

// ---------------------------------------------------------------- Db.tx_: busy, commit failures

test('a BEGIN error is BUSY (retryable) and nothing is applied', () => {
  const env = setup();
  env.turso.injectError({ match: 'BEGIN IMMEDIATE', message: 'something unrelated' });
  const err = expectCode(() => addNote(env, ctxFor(env), 'n1'), 'BUSY');
  assert.equal(err.retryable, true);
  assert.deepEqual(noteIds(env), []);
});

test('a message with SQLITE_BUSY or "database is locked" is BUSY on any step, and beats onError', () => {
  const env = setup();
  env.turso.injectError({ match: 'INSERT INTO notes', message: 'SQLITE_BUSY: database is busy' });
  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('insert', 'INSERT INTO notes (id, body) VALUES (?, ?)', ['n1', 'hi'], { code: 'CONFLICT', message: 'x' });
  expectCode(() => tx.commit(), 'BUSY');

  env.turso.injectError({ match: 'UPDATE counter', message: 'database is locked' });
  const second = env.ctx.Db.tx_(ctxFor(env));
  second.exec('bump', 'UPDATE counter SET n = n + 1');
  expectCode(() => second.commit(), 'BUSY');

  env.turso.injectError({ match: 'INSERT INTO request_log', message: 'database is locked' });
  expectCode(() => addNote(env, ctxFor(env), 'n2'), 'BUSY');
});

test('a COMMIT that fails rolls back: INTERNAL for an ordinary error, BUSY for a locked database', () => {
  const env = setup();
  env.turso.injectError({ match: /^COMMIT$/, message: 'disk I/O error' });
  expectCode(() => addNote(env, ctxFor(env), 'n1'), 'INTERNAL');
  assert.deepEqual(noteIds(env), []);
  assert.equal(env.turso.db.isTransaction, false);

  env.turso.injectError({ match: /^COMMIT$/, message: 'database is locked' });
  expectCode(() => addNote(env, ctxFor(env), 'n2'), 'BUSY');
  assert.deepEqual(noteIds(env), []);
});

// ---------------------------------------------------------------- duplicate request ids

test('the same request id, action and payload hash returns the stored result and runs nothing again', () => {
  const env = setup();
  const ctx = ctxFor(env);
  const tx = env.ctx.Db.tx_(ctx);
  tx.exec('bump', 'UPDATE counter SET n = n + 1').result({ id: 'n1', version: 1 });
  tx.commit();

  env.fakes.fetch.calls.length = 0;
  const retry = env.ctx.Db.tx_(ctx);
  retry.exec('bump', 'UPDATE counter SET n = n + 1').result({ id: 'DIFFERENT' });
  assert.deepEqual(plain(env, retry.commit()), { duplicate: true, result: { id: 'n1', version: 1 } });
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 1, 'the update ran once');
  assert.equal(rows(env, 'SELECT * FROM request_log').length, 1);

  assert.equal(env.fakes.fetch.calls.length, 2, 'the failed batch, then one read of request_log');
  const lookup = stepsOf(env, 1)[0].stmt;
  assert.match(lookup.sql, /^SELECT action, payload_sha256, result_json FROM request_log WHERE user_id = \? AND request_id = \?$/);
  assert.deepEqual(lookup.args, [text('u1'), text(ctx.requestId)]);
  assert.equal(env.fakes.fetch.calls[1].headers.Authorization, 'Bearer test-rw', 'the lookup uses the read-write token');
});

test('the same request id with a different payload hash or action is VALIDATION, naming requestId', () => {
  const env = setup();
  const ctx = ctxFor(env);
  addNote(env, ctx, 'n1');

  for (const changed of [{ payloadHash: 'b'.repeat(64) }, { action: 'notes.other' }]) {
    const err = expectCode(() => addNote(env, { ...ctx, ...changed }, 'n2'), 'VALIDATION');
    assert.match(err.message, /request id/i);
    assert.deepEqual(plain(env, err.details), { field: 'requestId' });
  }
  assert.deepEqual(noteIds(env), ['n1']);
});

test('request ids are per user: another user may reuse the same id', () => {
  const env = setup();
  const ctx = ctxFor(env);
  addNote(env, ctx, 'n1');
  assert.deepEqual(plain(env, addNote(env, { ...ctx, userId: 'u2' }, 'n2')), { ok: true, selects: {} });
  assert.deepEqual(noteIds(env), ['n1', 'n2']);
});

// ---------------------------------------------------------------- rate limit

test('the limit+1st write inside a minute is RATE_LIMITED; the window slides; nothing is stored for the refused one', () => {
  const env = setup();
  const t0 = env.fakes.clock.now();
  for (const id of ['n1', 'n2', 'n3']) addNote(env, ctxFor(env, { rateLimit: 3 }), id);

  const err = expectCode(() => addNote(env, ctxFor(env, { rateLimit: 3 }), 'n4'), 'RATE_LIMITED');
  assert.equal(err.retryable, true);
  assert.deepEqual(noteIds(env), ['n1', 'n2', 'n3']);
  assert.equal(rows(env, 'SELECT * FROM request_log').length, 3);

  env.fakes.clock.set(t0 + 59999);
  expectCode(() => addNote(env, ctxFor(env, { rateLimit: 3 }), 'n4'), 'RATE_LIMITED');
  env.fakes.clock.set(t0 + 60000);             // created_at > now - 60000 is false for rows made at t0
  assert.doesNotThrow(() => addNote(env, ctxFor(env, { rateLimit: 3 }), 'n4'));
});

test('the default limit is 60 writes a minute, and it is per user', () => {
  const env = setup();
  for (let i = 1; i <= 60; i += 1) addNote(env, ctxFor(env), `n${i}`);
  expectCode(() => addNote(env, ctxFor(env), 'n61'), 'RATE_LIMITED');
  assert.doesNotThrow(() => addNote(env, ctxFor(env, { userId: 'u2' }), 'n61'));
});

test('SYSTEM is never rate limited', () => {
  const env = setup();
  for (let i = 1; i <= 8; i += 1) addNote(env, ctxFor(env, { userId: 'SYSTEM', rateLimit: 3 }), `n${i}`);
  assert.equal(noteIds(env).length, 8);
});

// ---------------------------------------------------------------- the database is unreachable

const UNAVAILABLE = [
  ['the fetch itself fails', env => env.fakes.fetch.failNext()],
  ['HTTP 503', env => env.fakes.fetch.respondNext(503, 'busy')],
  ['HTTP 401 (a bad or expired token)', env => env.fakes.fetch.respondNext(401, '{"error":"The JWT is invalid"}')],
  ['a response that is not JSON', env => env.fakes.fetch.garbageNext()],
  ['JSON without results', env => env.fakes.fetch.respondNext(200, '{"foo":1}')],
  ['a request-level error', env => env.fakes.fetch.respondNext(200, JSON.stringify({ baton: null, results: [{ type: 'error', error: { message: 'boom', code: 'X' } }] }))],
  ['step arrays of the wrong length', env => env.fakes.fetch.respondNext(200, JSON.stringify({ results: [
    { type: 'ok', response: { type: 'batch', result: { step_results: [], step_errors: [] } } }, { type: 'ok', response: { type: 'close' } }] }))],
];

for (const [label, arrange] of UNAVAILABLE) {
  test(`DB_UNAVAILABLE (retryable) for: ${label}; the token never appears in the error or the log`, () => {
    const env = setup();
    arrange(env);
    const write = expectCode(() => addNote(env, ctxFor(env), 'n1'), 'DB_UNAVAILABLE');
    assert.equal(write.retryable, true);
    arrange(env);
    const read = expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT 1' }]), 'DB_UNAVAILABLE');
    assert.equal(read.retryable, true);

    const everything = JSON.stringify([write.message, plain(env, write.details), read.message, plain(env, read.details), env.fakes.log.lines]);
    assert.doesNotMatch(everything, /test-r[ow]/);
  });
}

test('a non-200 status is never trusted, even when the body looks like a success', () => {
  const env = setup();
  const success = JSON.stringify({ results: [
    { type: 'ok', response: { type: 'batch', result: {
      step_results: [{ cols: [{ name: 'one' }], rows: [[{ type: 'integer', value: '1' }]], affected_row_count: 0, rows_read: 1, rows_written: 0 }],
      step_errors: [null] } } },
    { type: 'ok', response: { type: 'close' } }] });
  for (const status of [201, 204, 301, 429, 500, 502]) {
    env.fakes.fetch.respondNext(status, success);
    const err = expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT 1 AS one' }]), 'DB_UNAVAILABLE');
    assert.equal(err.details.status, status);
  }
});

test('unknown outcome, work not done: the retry with the same request id applies it normally', () => {
  const env = setup();
  const ctx = ctxFor(env);
  env.breakNthCall(1, { executeFirst: false });
  expectCode(() => addNote(env, ctx, 'n1'), 'DB_UNAVAILABLE');
  assert.deepEqual(noteIds(env), []);
  assert.deepEqual(plain(env, addNote(env, ctx, 'n1')), { ok: true, selects: {} });
  assert.deepEqual(noteIds(env), ['n1']);
});

test('unknown outcome, work done but the response lost: the retry gets the stored result, and nothing runs twice', () => {
  const env = setup();
  const ctx = ctxFor(env);
  env.breakNthCall(1, { executeFirst: true });
  const first = env.ctx.Db.tx_(ctx);
  first.exec('bump', 'UPDATE counter SET n = n + 1').result({ id: 'n1' });
  expectCode(() => first.commit(), 'DB_UNAVAILABLE');
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 1, 'it did commit');

  const retry = env.ctx.Db.tx_(ctx);
  retry.exec('bump', 'UPDATE counter SET n = n + 1').result({ id: 'n1' });
  assert.deepEqual(plain(env, retry.commit()), { duplicate: true, result: { id: 'n1' } });
  assert.equal(Number(rows(env, 'SELECT n FROM counter')[0].n), 1);
});

// ---------------------------------------------------------------- configuration

test('a missing URL or token is INTERNAL, and a trailing slash on the URL is tolerated', () => {
  for (const [property, call] of [
    ['TURSO_URL', env => env.ctx.Db.read_([{ sql: 'SELECT 1' }])],
    ['TURSO_RO_TOKEN', env => env.ctx.Db.read_([{ sql: 'SELECT 1' }])],
    ['TURSO_URL', env => addNote(env, ctxFor(env), 'n1')],
    ['TURSO_RW_TOKEN', env => addNote(env, ctxFor(env), 'n1')],
  ]) {
    const env = setup();
    env.fakes.properties.set(property, '');
    const err = expectCode(() => call(env), 'INTERNAL');
    assert.match(err.details.error, new RegExp(property));
    assert.equal(env.fakes.fetch.calls.length, 0, 'no call is made without a complete configuration');
  }

  const env = setup();
  env.fakes.properties.set('TURSO_URL', env.origin + '/');
  assert.deepEqual(plain(env, env.ctx.Db.read_([{ sql: 'SELECT 1 AS one' }])), [[{ one: 1 }]]);
  assert.equal(env.fakes.fetch.calls[0].url, env.origin + '/v2/pipeline');
});

// ---------------------------------------------------------------- misuse of the builder

test('the builder refuses a bad context, bad labels, unknown codes, and use after commit', () => {
  const env = setup();
  const good = ctxFor(env);
  for (const bad of [
    { requestId: '' }, { requestId: undefined }, { userId: '' }, { action: undefined },
    { payloadHash: undefined }, { now: 1.5 }, { now: 'soon' }, { rateLimit: 0 }, { rateLimit: 'many' },
  ]) {
    expectCode(() => env.ctx.Db.tx_({ ...good, ...bad }), 'INTERNAL');
  }
  expectCode(() => env.ctx.Db.tx_(null), 'INTERNAL');

  const tx = env.ctx.Db.tx_(ctxFor(env));
  tx.exec('same', 'UPDATE counter SET n = n + 1');
  expectCode(() => tx.exec('same', 'UPDATE counter SET n = n + 1'), 'INTERNAL');
  expectCode(() => tx.select('same', 'SELECT 1'), 'INTERNAL');
  expectCode(() => tx.assert('a', '1', [], 'TEAPOT', 'no'), 'INTERNAL');
  expectCode(() => tx.assert('b', 42, [], 'FORBIDDEN', 'no'), 'INTERNAL');
  expectCode(() => tx.exec('c', ''), 'INTERNAL');
  expectCode(() => tx.exec('d', 'UPDATE counter SET n = ?', [{}]), 'INTERNAL');

  tx.commit();
  expectCode(() => tx.commit(), 'INTERNAL');
  expectCode(() => tx.exec('late', 'SELECT 1'), 'INTERNAL');
  expectCode(() => tx.result({}), 'INTERNAL');
});

// ---------------------------------------------------------------- usage counters

test('every call adds its rows_read, rows_written and call count to the day\'s counter in the cache', () => {
  const env = setup();
  const key = 'usage:2026-11-05';
  const counter = () => {
    const raw = env.run(`CacheService.getScriptCache().get(${JSON.stringify(key)})`);
    return raw === null ? null : JSON.parse(raw);
  };
  assert.equal(counter(), null);

  env.turso.db.exec("INSERT INTO notes VALUES ('a', 'x'), ('b', 'y')");
  env.ctx.Db.read_([{ sql: 'SELECT * FROM notes' }]);
  const afterRead = counter();
  assert.equal(afterRead.calls, 1);
  assert.ok(afterRead.read >= 2, 'rows read counted');
  assert.equal(afterRead.written, 0);

  addNote(env, ctxFor(env), 'c');
  const afterWrite = counter();
  assert.equal(afterWrite.calls, 2);
  assert.ok(afterWrite.written >= 2, 'at least the note and its request_log row');
  assert.ok(afterWrite.read >= afterRead.read);
});

test('the counter is per UTC day, and a refused or failed call is still counted', () => {
  const env = setup();
  env.fakes.clock.set(Date.UTC(2026, 10, 5, 23, 59, 59));
  env.ctx.Db.read_([{ sql: 'SELECT 1' }]);
  env.fakes.clock.set(Date.UTC(2026, 10, 6, 0, 0, 1));
  expectCode(() => env.ctx.Db.read_([{ sql: 'SELECT * FROM nowhere' }]), 'INTERNAL');
  const cache = key => JSON.parse(env.run(`CacheService.getScriptCache().get(${JSON.stringify(key)})`));
  assert.equal(cache('usage:2026-11-05').calls, 1);
  assert.equal(cache('usage:2026-11-06').calls, 1);
});

test('a broken cache never breaks a database call', () => {
  const env = setup();
  env.run("CacheService = { getScriptCache: function () { throw new Error('cache down'); } }");
  assert.deepEqual(plain(env, env.ctx.Db.read_([{ sql: 'SELECT 1 AS one' }])), [[{ one: 1 }]]);
  assert.doesNotThrow(() => addNote(env, ctxFor(env), 'n1'));
});

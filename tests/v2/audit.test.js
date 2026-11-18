'use strict';

// T1.10 — Audit.gs (BUILD_SPEC section 5.5): the row builder with redaction, the sealer (an HMAC hash chain over the
// audit_log table), the verifier, and the checkpoint kept outside the database.
//
// Chains are checked twice: by the app (Audit.verify_) and independently here with node:crypto, so a mistake that the
// sealer and the verifier share would still be caught.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEnv } = require('./helpers/env');
const { insert } = require('./helpers/seed');
const { expectCode } = require('./helpers/asserts');

const KEY = 'a'.repeat(64);
const KEY2 = 'b'.repeat(64);
const GENESIS = '0'.repeat(64);

function setup() {
  const env = createEnv();
  env.run('Migrations.run_()');
  env.fakes.properties.set('AUDIT_KEY_VERSION', '1');
  env.fakes.properties.set('AUDIT_HMAC_KEY_v1', KEY);
  env.fakes.properties.set('ALERT_EMAIL', 'alerts@flink.test');
  env.fakes.fetch.calls.length = 0;
  return env;
}

const db = env => env.turso.db;
const all = (env, sql) => db(env).prepare(sql).all().map(row => ({ ...row }));
const plain = (env, value) => env.ctx.__plain(value);

// n unsealed rows with the next seq numbers, inserted directly (a real write goes through Db.tx_, tested below).
function addRows(env, n, label = 'x') {
  const start = all(env, 'SELECT COALESCE(MAX(seq), 0) AS n FROM audit_log')[0].n;
  for (let i = 1; i <= n; i++) {
    insert(db(env), 'audit_log', {
      ts: 1762160000000 + start + i, actor_user_id: i % 2 ? 'u1' : 'SYSTEM', actor_role: i % 2 ? 'USER' : 'SYSTEM',
      workspace_id: i % 3 ? 'w1' : null, entity_type: 'THING', entity_id: `e${start + i}`, action: 'THING_CHANGED',
      before_json: i % 4 ? `{"n":${i}}` : null, after_json: `{"label":"${label}","n":${i + 1}}`, reason: i % 5 ? null : 'because',
      request_id: `req-${start + i}`,
    });
  }
}

// Seals everything: one run seals at most 200 rows.
function sealAll(env) {
  const runs = [];
  for (;;) {
    const result = plain(env, env.ctx.Audit.seal_());
    runs.push(result);
    if (result.sealed === 0 || result.skipped) return runs;
  }
}

// The chain recomputed with node:crypto from the rows in the database.
function checkChainIndependently(env, keys = { 1: KEY }) {
  let previous = GENESIS;
  const rows = all(env, 'SELECT * FROM audit_log WHERE sealed_at IS NOT NULL ORDER BY seq');
  for (const row of rows) {
    const canonical = JSON.stringify([String(row.seq), String(row.ts), row.actor_user_id, row.actor_role, row.workspace_id,
      row.entity_type, row.entity_id, row.action, row.before_json, row.after_json, row.reason, row.request_id]);
    const expected = crypto.createHmac('sha256', keys[row.key_version]).update(`${previous}\n${canonical}`).digest('hex');
    assert.equal(row.prev_hash, previous, `seq ${row.seq}: prev_hash`);
    assert.equal(row.record_hash, expected, `seq ${row.seq}: record_hash`);
    previous = expected;
  }
  return { rows: rows.length, last: previous };
}

const events = env => all(env, 'SELECT event_type, success, detail_json FROM security_events ORDER BY id');
const mails = env => env.fakes.mail.sent;
const head = env => all(env, 'SELECT seq, hash FROM chain_head WHERE id = 1')[0];

// ---------------------------------------------------------------- Audit.redact_

test('redact_ drops the secret keys at any depth and leaves everything else, without touching its input', () => {
  const env = setup();
  const input = {
    id: 'u1', secret_enc: 'enc$v1$abc', pending_secret_enc: 'x', backup_hashes_json: '["h"]', enroll_code_hash: 'h', token_hash: 'h',
    keep: 1, nested: { token_hash: 'h', ok: true, deeper: [{ secret_enc: 's', fine: 'yes' }, 5, null] }, list: [1, 'a'], note: null,
  };
  const copy = JSON.parse(JSON.stringify(input));
  const out = plain(env, env.ctx.Audit.redact_(input));
  assert.deepEqual(out, { id: 'u1', keep: 1, nested: { ok: true, deeper: [{ fine: 'yes' }, 5, null] }, list: [1, 'a'], note: null });
  assert.deepEqual(input, copy, 'the input is unchanged');
});

test('redact_ drops only the exact key names, and passes non-objects through', () => {
  const env = setup();
  assert.deepEqual(plain(env, env.ctx.Audit.redact_({ secret: 1, secret_enc_extra: 2, Token_Hash: 3, token: 4, hash: 5 })),
    { secret: 1, secret_enc_extra: 2, Token_Hash: 3, token: 4, hash: 5 });
  for (const value of [null, undefined, 5, 'text', true]) assert.equal(env.ctx.Audit.redact_(value), value === undefined ? null : value);
  assert.deepEqual(plain(env, env.ctx.Audit.redact_([{ token_hash: 'h', a: 1 }])), [{ a: 1 }]);
});

// ---------------------------------------------------------------- Audit.row_

const handlerCtx = (env, overrides = {}) => ({
  user: { id: 'u1', role: 'ADMIN' }, requestId: 'req-1', now: env.fakes.clock.now(), ...overrides,
});

test('row_ builds the audit_log row of section 5.5 from a handler context', () => {
  const env = setup();
  const row = plain(env, env.ctx.Audit.row_(handlerCtx(env), {
    entityType: 'ACCOUNT', entityId: 'a1', action: 'USER_UPDATED', workspaceId: 'w1', reason: 'because',
    before: { role: 'USER', secret_enc: 'x' }, after: { role: 'ADMIN', b: 1, a: [2, 1] },
  }));
  assert.deepEqual(row, {
    ts: env.fakes.clock.now(), actor_user_id: 'u1', actor_role: 'ADMIN', workspace_id: 'w1', entity_type: 'ACCOUNT',
    entity_id: 'a1', action: 'USER_UPDATED', before_json: '{"role":"USER"}', after_json: '{"a":[2,1],"b":1,"role":"ADMIN"}',
    reason: 'because', request_id: 'req-1',
  });
});

test('row_ fills the gaps: no workspace, reason, before or after are null; a job is SYSTEM', () => {
  const env = setup();
  const row = plain(env, env.ctx.Audit.row_({ requestId: 'autostop:t1', now: 5 }, { entityType: 'TIMER', entityId: 't1', action: 'TIMER_STOPPED' }));
  assert.deepEqual(row, {
    ts: 5, actor_user_id: 'SYSTEM', actor_role: 'SYSTEM', workspace_id: null, entity_type: 'TIMER', entity_id: 't1',
    action: 'TIMER_STOPPED', before_json: null, after_json: null, reason: null, request_id: 'autostop:t1',
  });
});

test('row_ may carry a derived request id of its own (a read action that writes one audit row)', () => {
  const env = setup();
  const row = plain(env, env.ctx.Audit.row_(handlerCtx(env, { requestId: null }), {
    entityType: 'REPORT', entityId: 'x1', action: 'REPORT_EXPORTED', requestId: 'export:x1',
  }));
  assert.equal(row.request_id, 'export:x1');
  assert.equal(row.actor_user_id, 'u1');
});

test('row_ refuses what the table would refuse: missing names, no request id, no time', () => {
  const env = setup();
  const good = { entityType: 'T', entityId: 'e', action: 'A' };
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env), { ...good, entityType: '' }), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env), { ...good, entityId: undefined }), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env), { ...good, action: 5 }), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env, { requestId: null }), good), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env, { now: 'now' }), good), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env), { ...good, reason: 5 }), 'INTERNAL');
  expectCode(() => env.ctx.Audit.row_(handlerCtx(env), { ...good, workspaceId: 5 }), 'INTERNAL');
});

test('a row built by row_ goes through Db.tx_ into audit_log, with the secrets gone', () => {
  const env = setup();
  const ctx = handlerCtx(env);
  const tx = env.ctx.Db.tx_({ userId: 'u1', requestId: 'req-1', action: 'users.update', payloadHash: 'h'.repeat(64), now: ctx.now });
  tx.audit(env.ctx.Audit.row_(ctx, {
    entityType: 'ADMIN_MFA', entityId: 'u1', action: 'MFA_RESET', before: { secret_enc: 'enc$v1$TOPSECRET', enabled: 1 }, after: { enabled: 0 },
  }));
  tx.commit();
  const [stored] = all(env, 'SELECT * FROM audit_log');
  assert.equal(stored.before_json, '{"enabled":1}');
  assert.ok(!JSON.stringify(stored).includes('TOPSECRET'));
  assert.equal(stored.sealed_at, null);
});

// ---------------------------------------------------------------- the sealer

test('seal_ with nothing unsealed does one read and no write', () => {
  const env = setup();
  const result = plain(env, env.ctx.Audit.seal_());
  assert.equal(result.sealed, 0);
  assert.equal(env.fakes.fetch.calls.length, 1);
  assert.equal(env.fakes.lock.isHeld(), false);
});

test('seal_ seals a batch in one transaction: the head, every row and the checkpoint move together', () => {
  const env = setup();
  addRows(env, 5);
  env.fakes.fetch.calls.length = 0;
  const result = plain(env, env.ctx.Audit.seal_());
  assert.equal(env.fakes.fetch.calls.length, 2, 'one read pipeline, one write transaction');
  assert.deepEqual([result.sealed, result.fromSeq, result.toSeq], [5, 1, 5]);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NULL')[0].n, 0);
  const checked = checkChainIndependently(env);
  assert.equal(checked.rows, 5);
  assert.deepEqual(head(env), { seq: 5, hash: checked.last });
  const rows = all(env, 'SELECT key_version, sealed_at FROM audit_log');
  assert.ok(rows.every(row => row.key_version === 1 && row.sealed_at === env.fakes.clock.now()));
  const checkpoint = JSON.parse(env.fakes.properties.get('CHAIN_CHECKPOINT'));
  assert.deepEqual(checkpoint, { seq: 5, hash: checked.last, at: env.fakes.clock.now() });
});

test('seal_ uses the request id of section 5.5, so the write is a SYSTEM transaction', () => {
  const env = setup();
  addRows(env, 3);
  env.ctx.Audit.seal_();
  assert.deepEqual(all(env, 'SELECT user_id, request_id, action FROM request_log'), [{ user_id: 'SYSTEM', request_id: 'seal:1-3', action: 'audit.seal' }]);
});

test('the chain over 500 rows is built in batches of 200 and verifies, here and in the app', () => {
  const env = setup();
  addRows(env, 500);
  const runs = sealAll(env);
  assert.deepEqual(runs.map(run => run.sealed), [200, 200, 100, 0]);
  const checked = checkChainIndependently(env);
  assert.equal(checked.rows, 500);
  assert.deepEqual(head(env), { seq: 500, hash: checked.last });
  const verified = plain(env, env.ctx.Audit.verify_(0));
  assert.deepEqual(verified, { verifiedTo: 500, ok: true, problems: [], complete: true });
  assert.equal(events(env).length, 0);
  assert.equal(mails(env).length, 0);
  assert.equal(env.fakes.properties.get('ALARM_AUDIT'), null);
});

test('rows added while the chain is running are picked up by the next run, and the chain stays one chain', () => {
  const env = setup();
  addRows(env, 3);
  env.ctx.Audit.seal_();
  addRows(env, 4);
  env.ctx.Audit.seal_();
  assert.equal(checkChainIndependently(env).rows, 7);
  assert.deepEqual(plain(env, env.ctx.Audit.verify_(0)).problems, []);
});

test('the sealed hashes depend on the key: another key makes the independent check fail', () => {
  const env = setup();
  addRows(env, 3);
  env.ctx.Audit.seal_();
  assert.throws(() => checkChainIndependently(env, { 1: KEY2 }), /record_hash/);
});

test('without a key the sealer refuses, and nothing is sealed', () => {
  const env = setup();
  addRows(env, 2);
  env.fakes.properties.set('AUDIT_HMAC_KEY_v1', '');
  expectCode(() => env.ctx.Audit.seal_(), 'INTERNAL');
  env.fakes.properties.set('AUDIT_HMAC_KEY_v1', KEY);
  env.fakes.properties.set('AUDIT_KEY_VERSION', 'one');
  expectCode(() => env.ctx.Audit.seal_(), 'INTERNAL');
  env.fakes.properties.set('AUDIT_KEY_VERSION', '2');
  expectCode(() => env.ctx.Audit.seal_(), 'INTERNAL');         // no AUDIT_HMAC_KEY_v2
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL')[0].n, 0);
  assert.equal(env.fakes.lock.isHeld(), false, 'the lock is released on failure too');
});

test('key rotation: rows sealed with version 2 verify next to rows sealed with version 1', () => {
  const env = setup();
  addRows(env, 3);
  env.ctx.Audit.seal_();
  env.fakes.properties.set('AUDIT_HMAC_KEY_v2', KEY2);
  env.fakes.properties.set('AUDIT_KEY_VERSION', '2');
  addRows(env, 3);
  env.ctx.Audit.seal_();
  assert.deepEqual(all(env, 'SELECT key_version FROM audit_log ORDER BY seq').map(row => row.key_version), [1, 1, 1, 2, 2, 2]);
  checkChainIndependently(env, { 1: KEY, 2: KEY2 });
  assert.deepEqual(plain(env, env.ctx.Audit.verify_(0)).problems, []);
});

test('the checkpoint only moves forward', () => {
  const env = setup();
  addRows(env, 3);
  const ahead = JSON.stringify({ seq: 1000000, hash: 'f'.repeat(64), at: 1 });
  env.fakes.properties.set('CHAIN_CHECKPOINT', ahead);
  env.ctx.Audit.seal_();
  assert.equal(env.fakes.properties.get('CHAIN_CHECKPOINT'), ahead);

  const env2 = setup();
  addRows(env2, 3);
  env2.fakes.properties.set('CHAIN_CHECKPOINT', 'not json');
  env2.ctx.Audit.seal_();
  assert.equal(JSON.parse(env2.fakes.properties.get('CHAIN_CHECKPOINT')).seq, 3, 'an unreadable checkpoint is replaced');
});

test('two sealers cannot overlap: a sealer that cannot take the lock does nothing', () => {
  const env = setup();
  addRows(env, 3);
  env.fakes.lock.setHeldElsewhere(true);
  env.fakes.fetch.calls.length = 0;
  assert.deepEqual(plain(env, env.ctx.Audit.seal_()), { skipped: true, sealed: 0 });
  assert.equal(env.fakes.fetch.calls.length, 0);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NULL')[0].n, 3);
  env.fakes.lock.setHeldElsewhere(false);
  assert.equal(plain(env, env.ctx.Audit.seal_()).sealed, 3);
  assert.equal(env.fakes.lock.isHeld(), false);
});

test('if the chain head moves between the read and the write, nothing is sealed (CONFLICT)', () => {
  const env = setup();
  addRows(env, 3);
  let calls = 0;
  env.fakes.fetch.route(env.origin + '/', request => {
    calls += 1;
    if (calls === 2) db(env).exec('UPDATE chain_head SET seq = 99 WHERE id = 1');      // another sealer got in first
    return env.turso.handleHttp(request);
  }, { first: true });
  expectCode(() => env.ctx.Audit.seal_(), 'CONFLICT');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL')[0].n, 0);
  assert.equal(env.fakes.lock.isHeld(), false);
});

test('a sealer that dies before its write lands changes nothing, and the next run completes', () => {
  const env = setup();
  addRows(env, 6);
  env.breakNthCall(2, { executeFirst: false });
  expectCode(() => env.ctx.Audit.seal_(), 'DB_UNAVAILABLE');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL')[0].n, 0);
  assert.deepEqual(head(env), { seq: 0, hash: GENESIS });
  assert.equal(plain(env, env.ctx.Audit.seal_()).sealed, 6);
  checkChainIndependently(env);
});

test('a sealer whose write landed but whose answer was lost: the rerun finds nothing to do and the chain is whole', () => {
  const env = setup();
  addRows(env, 6);
  env.breakNthCall(2, { executeFirst: true });
  expectCode(() => env.ctx.Audit.seal_(), 'DB_UNAVAILABLE');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE sealed_at IS NOT NULL')[0].n, 6, 'the write did happen');
  assert.equal(plain(env, env.ctx.Audit.seal_()).sealed, 0);
  assert.equal(checkChainIndependently(env).rows, 6);
  assert.deepEqual(plain(env, env.ctx.Audit.verify_(0)).problems, []);
});

// ---------------------------------------------------------------- gaps

test('a gap in seq is written to security_events, mailed, and sealing carries on across it', () => {
  const env = setup();
  addRows(env, 6);
  db(env).exec('DELETE FROM audit_log WHERE seq IN (3, 4)');               // a gap in the middle
  const result = plain(env, env.ctx.Audit.seal_());
  assert.equal(result.sealed, 4);
  assert.deepEqual(result.gaps, [{ from: 3, to: 4 }]);
  const recorded = events(env);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].event_type, 'AUDIT_SEQ_GAP');
  assert.equal(recorded[0].success, 0);
  assert.deepEqual(JSON.parse(recorded[0].detail_json).gaps, [{ from: 3, to: 4 }]);
  assert.equal(mails(env).length, 1);
  assert.equal(mails(env)[0].to, 'alerts@flink.test');
  assert.match(mails(env)[0].subject, /audit/i);
  assert.match(mails(env)[0].body, /3.*4/s);
  // the chain links across the gap, and the verifier accepts a gap the sealer has already recorded
  assert.equal(checkChainIndependently(env).rows, 4);
  assert.deepEqual(plain(env, env.ctx.Audit.verify_(0)).problems, []);
});

test('a gap at the start (the first unsealed seq is not head + 1) is a gap too', () => {
  const env = setup();
  addRows(env, 5);
  db(env).exec('DELETE FROM audit_log WHERE seq IN (1, 2)');
  const result = plain(env, env.ctx.Audit.seal_());
  assert.deepEqual(result.gaps, [{ from: 1, to: 2 }]);
  assert.equal(events(env).length, 1);
});

test('several gaps are all reported', () => {
  const env = setup();
  addRows(env, 9);
  db(env).exec('DELETE FROM audit_log WHERE seq IN (2, 5, 6, 9)');
  assert.deepEqual(plain(env, env.ctx.Audit.seal_()).gaps, [{ from: 2, to: 2 }, { from: 5, to: 6 }]);
});

test('a gap that is found again after a failed seal is recorded and mailed only once', () => {
  const env = setup();
  addRows(env, 6);
  db(env).exec('DELETE FROM audit_log WHERE seq = 3');
  env.breakNthCall(3, { executeFirst: false });                              // read, event, then the seal write fails
  expectCode(() => env.ctx.Audit.seal_(), 'DB_UNAVAILABLE');
  assert.equal(events(env).length, 1);
  assert.equal(mails(env).length, 1);
  assert.equal(plain(env, env.ctx.Audit.seal_()).sealed, 5);
  assert.equal(events(env).length, 1, 'no second event');
  assert.equal(mails(env).length, 1, 'no second mail');
});

test('a gap is still recorded when there is no ALERT_EMAIL or the mail fails, and sealing goes on', () => {
  const env = setup();
  addRows(env, 4);
  db(env).exec('DELETE FROM audit_log WHERE seq = 2');
  env.fakes.properties.delete('ALERT_EMAIL');
  assert.equal(plain(env, env.ctx.Audit.seal_()).sealed, 3);
  assert.equal(events(env).length, 1);
  assert.equal(mails(env).length, 0);
  assert.ok(env.fakes.log.lines.some(line => line.level === 'warn' && /ALERT_EMAIL is not set/.test(line.text)), 'the missing address is logged');

  const env2 = setup();
  addRows(env2, 4);
  db(env2).exec('DELETE FROM audit_log WHERE seq = 2');
  env2.fakes.mail.failNext();
  assert.equal(plain(env2, env2.ctx.Audit.seal_()).sealed, 3);
  assert.equal(events(env2).length, 1);
});

test('an unsealed row below the chain head is reported and left alone, and the rows above it are sealed', () => {
  const env = setup();
  addRows(env, 3);
  env.ctx.Audit.seal_();
  addRows(env, 2);                                                           // seq 4 and 5
  db(env).exec('DELETE FROM audit_log WHERE seq = 2');
  db(env).exec("UPDATE audit_log SET seq = 2, sealed_at = NULL WHERE seq = 4");   // an old seq appears again, unsealed
  const result = plain(env, env.ctx.Audit.seal_());
  assert.equal(result.sealed, 1, 'only seq 5 is above the head');
  assert.deepEqual(result.gaps, [{ from: 4, to: 4 }]);
  assert.equal(events(env).filter(e => e.event_type === 'AUDIT_SEQ_GAP').length, 1, 'one event for everything found in this run');
  assert.deepEqual(JSON.parse(events(env)[0].detail_json).below, [2]);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE seq = 2 AND sealed_at IS NULL')[0].n, 1);
});

// ---------------------------------------------------------------- the verifier

function sealed500() {
  const env = setup();
  addRows(env, 500);
  sealAll(env);
  env.fakes.mail.reset();
  return env;
}

const problemsOf = (env, from = 0) => plain(env, env.ctx.Audit.verify_(from));

test('verify_ on an empty database is fine', () => {
  const env = setup();
  assert.deepEqual(problemsOf(env), { verifiedTo: 0, ok: true, problems: [], complete: true });
});

test('verify_ reads sealed rows in pages of 1,000 and ignores unsealed ones', () => {
  const env = setup();
  addRows(env, 2100);
  sealAll(env);
  addRows(env, 5);                                                           // unsealed
  env.fakes.fetch.calls.length = 0;
  const result = problemsOf(env);
  assert.deepEqual(result, { verifiedTo: 2100, ok: true, problems: [], complete: true });
  const pageReads = env.fakes.fetch.calls.map(call => JSON.parse(call.payload).requests[0].batch.steps.map(step => step.stmt.sql))
    .filter(sqls => sqls.some(sql => /FROM audit_log WHERE sealed_at IS NOT NULL AND seq >= /.test(sql)));
  assert.equal(pageReads.length, 3, '1,000 + 1,000 + 100');
});

test('tamper with one field: the row is named, the alarm goes off', () => {
  const env = sealed500();
  db(env).exec(`UPDATE audit_log SET after_json = '{"label":"edited"}' WHERE seq = 250`);
  const result = problemsOf(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(p => [p.seq, p.type]), [[250, 'RECORD_HASH']]);
  assert.equal(result.verifiedTo, 500);
  assert.equal(events(env).length, 1);
  assert.equal(events(env)[0].event_type, 'AUDIT_CHAIN_BROKEN');
  assert.equal(mails(env).length, 1);
  assert.equal(env.fakes.properties.get('ALARM_AUDIT'), '1');
});

test('every field of a sealed row is covered by its hash', () => {
  const columns = {
    ts: '1', actor_user_id: "'u2'", actor_role: "'ADMIN'", workspace_id: "'w9'", entity_type: "'OTHER'", entity_id: "'e9'",
    action: "'OTHER_ACTION'", before_json: "'{}'", after_json: "'{}'", reason: "'edited'", request_id: "'req-edited'",
  };
  for (const [column, value] of Object.entries(columns)) {
    const env = sealed500();
    db(env).exec(`UPDATE audit_log SET ${column} = ${value} WHERE seq = 77`);
    const result = problemsOf(env);
    assert.deepEqual(result.problems.map(p => [p.seq, p.type]), [[77, 'RECORD_HASH']], column);
  }
});

test('tamper with the stored hash links: the break is found where it happens', () => {
  const env = sealed500();
  db(env).exec(`UPDATE audit_log SET prev_hash = '${'1'.repeat(64)}' WHERE seq = 300`);
  const found = problemsOf(env).problems.map(p => [p.seq, p.type]);
  assert.ok(found.some(([seq, type]) => seq === 300 && type === 'PREV_HASH'), JSON.stringify(found));
});

test('delete a row from the middle of the chain: the next row no longer links', () => {
  const env = sealed500();
  db(env).exec('DELETE FROM audit_log WHERE seq = 123');
  const result = problemsOf(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(p => [p.seq, p.type]), [[124, 'PREV_HASH']]);
});

test('delete the newest sealed row and put the head back to match: the checkpoint outside the database catches it', () => {
  const env = sealed500();
  const previous = all(env, 'SELECT record_hash FROM audit_log WHERE seq = 499')[0].record_hash;
  db(env).exec('DELETE FROM audit_log WHERE seq = 500');
  db(env).exec(`UPDATE chain_head SET seq = 499, hash = '${previous}' WHERE id = 1`);
  const result = problemsOf(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map(p => p.type), ['CHECKPOINT_AHEAD']);
  assert.equal(events(env)[0].event_type, 'AUDIT_CHAIN_BROKEN');
});

test('delete the newest sealed row and leave the head alone: the head no longer matches the rows', () => {
  const env = sealed500();
  db(env).exec('DELETE FROM audit_log WHERE seq = 500');
  const types = problemsOf(env).problems.map(p => p.type);
  assert.ok(types.includes('HEAD_MISMATCH'), types.join());
  assert.ok(types.includes('CHECKPOINT_ROW_MISSING') || types.includes('CHECKPOINT_AHEAD'), types.join());
});

test('a checkpoint whose hash differs from the row at its seq is a problem', () => {
  const env = sealed500();
  env.fakes.properties.set('CHAIN_CHECKPOINT', JSON.stringify({ seq: 400, hash: 'e'.repeat(64), at: 1 }));
  assert.deepEqual(problemsOf(env).problems.map(p => [p.seq, p.type]), [[400, 'CHECKPOINT_HASH']]);
});

test('an unreadable checkpoint is a problem; a missing one is not (nothing was sealed yet, or setup is new)', () => {
  const env = sealed500();
  env.fakes.properties.set('CHAIN_CHECKPOINT', '{broken');
  assert.deepEqual(problemsOf(env).problems.map(p => p.type), ['CHECKPOINT_UNREADABLE']);
  const env2 = sealed500();
  env2.fakes.properties.delete('CHAIN_CHECKPOINT');
  assert.deepEqual(problemsOf(env2).problems, []);
});

test('the head must match the newest sealed row', () => {
  const env = sealed500();
  db(env).exec(`UPDATE chain_head SET hash = '${'2'.repeat(64)}' WHERE id = 1`);
  assert.deepEqual(problemsOf(env).problems.map(p => p.type), ['HEAD_MISMATCH']);
});

test('a row sealed with a key version that is no longer stored is a problem, not a crash', () => {
  const env = sealed500();
  db(env).exec('UPDATE audit_log SET key_version = 7 WHERE seq = 10');
  const result = problemsOf(env);
  assert.deepEqual(result.problems.map(p => [p.seq, p.type]), [[10, 'KEY_MISSING']]);
});

test('verifying from a seq checks only from there, linking to the row before it', () => {
  const env = sealed500();
  db(env).exec(`UPDATE audit_log SET after_json = '{"x":1}' WHERE seq = 100`);
  assert.deepEqual(problemsOf(env, 101), { verifiedTo: 500, ok: true, problems: [], complete: true });
  db(env).exec(`UPDATE audit_log SET after_json = '{"x":1}' WHERE seq = 300`);
  assert.deepEqual(problemsOf(env, 101).problems.map(p => p.seq), [300]);
  assert.deepEqual(problemsOf(env, 0).problems.map(p => p.seq), [100, 300]);
});

test('verifying from the middle of a chain with a gap still links to the row before, not to seq - 1', () => {
  const env = setup();
  addRows(env, 6);
  db(env).exec('DELETE FROM audit_log WHERE seq = 3');
  env.ctx.Audit.seal_();
  assert.deepEqual(problemsOf(env, 4).problems, []);
});

test('the verifier stops at its deadline and says how far it got', () => {
  const env = setup();
  addRows(env, 2100);
  sealAll(env);
  env.fakes.fetch.calls.length = 0;
  const result = plain(env, env.ctx.Audit.verify_(0, { deadlineMs: env.fakes.clock.now() }));
  assert.equal(env.fakes.fetch.calls.length, 1, 'one page and nothing else: the head and checkpoint need the whole chain');
  assert.equal(result.complete, false);
  assert.equal(result.verifiedTo, 1000, 'it finishes the page it is in');
  assert.equal(result.ok, true);
  const resumed = plain(env, env.ctx.Audit.verify_(result.verifiedTo + 1));
  assert.deepEqual(resumed, { verifiedTo: 2100, ok: true, problems: [], complete: true });
});

test('a problem is reported once per verification, with at most 100 problems listed', () => {
  const env = sealed500();
  db(env).exec("UPDATE audit_log SET reason = 'edited' WHERE seq BETWEEN 100 AND 299");
  const result = problemsOf(env);
  assert.equal(result.problems.length, 100);
  assert.equal(result.ok, false);
  assert.equal(events(env).length, 1);
  assert.equal(mails(env).length, 1);
  assert.ok(JSON.parse(events(env)[0].detail_json).problems.length <= 20, 'the event holds the first few only');
});

test('a broken chain with no ALERT_EMAIL still records the event and raises the alarm', () => {
  const env = sealed500();
  env.fakes.properties.delete('ALERT_EMAIL');
  db(env).exec("UPDATE audit_log SET reason = 'edited' WHERE seq = 5");
  assert.equal(problemsOf(env).ok, false);
  assert.equal(events(env).length, 1);
  assert.equal(env.fakes.properties.get('ALARM_AUDIT'), '1');
});

test('the alert mail names the problem types and seq numbers but never the content of a row', () => {
  const env = sealed500();
  db(env).exec(`UPDATE audit_log SET after_json = '{"label":"PRIVATE-CONTENT"}', actor_user_id = 'someone-private' WHERE seq = 250`);
  problemsOf(env);
  const body = mails(env)[0].body;
  assert.match(body, /250/);
  assert.match(body, /RECORD_HASH/);
  assert.ok(!body.includes('PRIVATE-CONTENT') && !body.includes('someone-private'));
  assert.ok(!JSON.stringify(events(env)).includes('PRIVATE-CONTENT'));
});

test('a clean verification touches nothing: no event, no mail, no alarm', () => {
  const env = sealed500();
  env.fakes.properties.set('ALARM_AUDIT', '1');                              // an earlier alarm is not cleared by a clean run
  problemsOf(env);
  assert.equal(events(env).length, 0);
  assert.equal(mails(env).length, 0);
  assert.equal(env.fakes.properties.get('ALARM_AUDIT'), '1');
});

test('verify_ takes a whole number of at least 0 and nothing else', () => {
  const env = setup();
  for (const bad of [-1, 1.5, '3', NaN, null, {}]) expectCode(() => env.ctx.Audit.verify_(bad), 'INTERNAL');
  assert.equal(plain(env, env.ctx.Audit.verify_(undefined)).ok, true);
});

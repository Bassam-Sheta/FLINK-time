'use strict';

// ActTimer.addStop_: the three verified statements of BUILD_SPEC section 6.4 that turn a running timer into one entry,
// added to a Db.tx_ transaction. timer.stop (T2.4), the auto-stop job (T2.7), archiving a workspace and removing a
// member (T2.1) and deactivating a user (T3.4) all stop timers this way, so it is tested once, here, on its own.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEnv } = require('./helpers/env');
const { seedWorld, insert } = require('./helpers/seed');
const { expectCode } = require('./helpers/asserts');

const HOUR = 3600000;
const MISSING = { code: 'NOT_FOUND', message: 'No such timer.' };

function setup() {
  const env = createEnv();
  const world = seedWorld(env);
  return { env, world };
}
const all = (env, sql) => env.turso.db.prepare(sql).all().map(row => ({ ...row }));

function startTimer(env, world, overrides = {}) {
  const row = {
    user_id: world.ids.user1, timer_id: crypto.randomUUID(), workspace_id: world.ids.w1, project_id: world.ids.open, task_id: null,
    description: 'working', billable: 1, tag_ids_json: JSON.stringify([world.ids.tagA]), started_at: env.fakes.clock.now() - 2 * HOUR,
    local_date: '2026-11-05', version: 1, ...overrides,
  };
  insert(env.turso.db, 'active_timers', row);
  return row;
}

function stop(env, timer, { endAt, capMs = 14 * HOUR, stopReason = 'USER', extra } = {}) {
  const now = env.fakes.clock.now();
  const entryId = crypto.randomUUID();
  const tx = env.ctx.Db.tx_({ userId: timer.user_id, requestId: crypto.randomUUID(), action: 'timer.stop', payloadHash: 'h'.repeat(64), now });
  env.ctx.ActTimer.addStop_(tx, {
    label: 'stop', entryId, userId: timer.user_id, timerId: timer.timer_id, endAt: endAt === undefined ? now : endAt, capMs, stopReason, now,
    missing: MISSING,
  });
  if (extra) extra(tx);
  tx.result({ entryId });
  tx.commit();
  return entryId;
}

test('stopping a timer writes exactly one entry, with the rates of the project, and removes the timer', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world);
  const entryId = stop(env, timer);
  const entries = all(env, 'SELECT * FROM time_entries');
  assert.equal(entries.length, 1);
  const entry = entries[0];
  assert.equal(entry.id, entryId);
  assert.deepEqual(
    [entry.workspace_id, entry.user_id, entry.project_id, entry.task_id, entry.description, entry.billable, entry.local_date, entry.source, entry.stop_reason, entry.timer_id, entry.deleted_at, entry.version],
    [timer.workspace_id, timer.user_id, timer.project_id, null, 'working', 1, '2026-11-05', 'TIMER', 'USER', timer.timer_id, null, 1]);
  assert.deepEqual([entry.start_at, entry.end_at, entry.duration_s], [timer.started_at, env.fakes.clock.now(), 2 * 3600]);
  assert.deepEqual([entry.hourly_rate_minor, entry.cost_rate_minor], [50000, 20000], 'the rates are copied, so a later rate change leaves old entries alone');
  assert.deepEqual([entry.created_at, entry.updated_at], [env.fakes.clock.now(), env.fakes.clock.now()]);
  assert.deepEqual(all(env, 'SELECT entry_id, tag_id, workspace_id FROM entry_tags'), [{ entry_id: entryId, tag_id: world.ids.tagA, workspace_id: world.ids.w1 }]);
  assert.equal(all(env, 'SELECT * FROM active_timers').length, 0);
});

test('an odd number of milliseconds still passes the duration CHECK (integer division, not floats)', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world, { started_at: env.fakes.clock.now() - 3601499 });
  stop(env, timer);
  const [entry] = all(env, 'SELECT start_at, end_at, duration_s FROM time_entries');
  assert.equal(entry.duration_s, 3601);
  assert.equal(entry.end_at - entry.start_at, 3601499);
});

test('the end is capped at the start plus the cap, and never before the start', () => {
  const { env, world } = setup();
  const now = env.fakes.clock.now();
  const long = startTimer(env, world, { started_at: now - 20 * HOUR });
  stop(env, long, { capMs: 14 * HOUR });
  const early = startTimer(env, world, { user_id: world.ids.user2, started_at: now - HOUR });
  stop(env, early, { endAt: now - 2 * HOUR });                    // a clock that went backwards
  const rows = all(env, 'SELECT user_id, start_at, end_at, duration_s FROM time_entries ORDER BY user_id');
  assert.deepEqual(rows.map(r => r.duration_s), [14 * 3600, 0]);
  assert.equal(rows[0].end_at, now - 20 * HOUR + 14 * HOUR);
  assert.equal(rows[1].end_at, rows[1].start_at);
});

test('a cap of 24 hours is the longest the database allows, and a longer cap is refused before anything is sent', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world, { started_at: env.fakes.clock.now() - 30 * HOUR });
  stop(env, timer, { capMs: 24 * HOUR });
  assert.equal(all(env, 'SELECT duration_s FROM time_entries')[0].duration_s, 24 * 3600);
  const timer2 = startTimer(env, world, { user_id: world.ids.user2, started_at: env.fakes.clock.now() - 30 * HOUR });
  expectCode(() => stop(env, timer2, { capMs: 25 * HOUR }), 'INTERNAL');
  assert.equal(all(env, 'SELECT * FROM active_timers').length, 1, 'the failed stop changed nothing');
});

test('a timer with no project or tags stops with null rates and no tags', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world, { project_id: null, tag_ids_json: '[]', description: '' });
  stop(env, timer);
  const [entry] = all(env, 'SELECT project_id, hourly_rate_minor, cost_rate_minor, description FROM time_entries');
  assert.deepEqual(entry, { project_id: null, hourly_rate_minor: null, cost_rate_minor: null, description: '' });
  assert.equal(all(env, 'SELECT * FROM entry_tags').length, 0);
});

test('stopping a timer that is not there is the error the caller asked for, and writes nothing', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world);
  const wrongId = { ...timer, timer_id: crypto.randomUUID() };
  const err = expectCode(() => stop(env, wrongId), 'NOT_FOUND');
  assert.equal(err.message, 'No such timer.');
  const wrongUser = { ...timer, user_id: world.ids.user2 };
  expectCode(() => stop(env, wrongUser), 'NOT_FOUND');
  assert.equal(all(env, 'SELECT * FROM time_entries').length, 0);
  assert.equal(all(env, 'SELECT * FROM active_timers').length, 1, "another user's timer id does not stop the timer");
});

test('stopping twice: the second stop is NOT_FOUND and there is still one entry', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world);
  stop(env, timer);
  expectCode(() => stop(env, timer), 'NOT_FOUND');
  assert.equal(all(env, 'SELECT * FROM time_entries').length, 1);
});

test('the stop is one atomic step with the rest of the transaction: a later failure puts the timer back', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world);
  expectCode(() => stop(env, timer, { extra: tx => tx.assert('later', '1 = 0', [], 'CONFLICT', 'Something else failed.') }), 'CONFLICT');
  assert.equal(all(env, 'SELECT * FROM time_entries').length, 0);
  assert.equal(all(env, 'SELECT * FROM entry_tags').length, 0);
  assert.equal(all(env, 'SELECT * FROM active_timers').length, 1);
});

test('several timers can be stopped in one transaction, each with its own label', () => {
  const { env, world } = setup();
  const timers = [startTimer(env, world), startTimer(env, world, { user_id: world.ids.user2 }), startTimer(env, world, { user_id: world.ids.user3 })];
  const now = env.fakes.clock.now();
  const tx = env.ctx.Db.tx_({ userId: 'SYSTEM', requestId: 'bulk', action: 'x', payloadHash: 'h'.repeat(64), now });
  timers.forEach((timer, i) => env.ctx.ActTimer.addStop_(tx, {
    label: `stop ${i}`, entryId: crypto.randomUUID(), userId: timer.user_id, timerId: timer.timer_id, endAt: now, capMs: 14 * HOUR, stopReason: 'USER', now, missing: MISSING,
  }));
  tx.commit();
  assert.equal(all(env, 'SELECT * FROM time_entries').length, 3);
  assert.equal(all(env, 'SELECT * FROM active_timers').length, 0);
  assert.equal(all(env, 'SELECT * FROM entry_tags').length, 3);
});

test('the stop reason is stored, and only a reason the table knows is accepted', () => {
  const { env, world } = setup();
  for (const [reason, user] of [['USER', 'user1'], ['AUTO_STOP', 'user2'], ['DEACTIVATION', 'user3']]) {
    stop(env, startTimer(env, world, { user_id: world.ids[user] }), { stopReason: reason });
  }
  assert.deepEqual(all(env, 'SELECT stop_reason FROM time_entries ORDER BY user_id').map(r => r.stop_reason), ['USER', 'AUTO_STOP', 'DEACTIVATION']);
  expectCode(() => stop(env, startTimer(env, world, { user_id: world.ids.admin1 }), { stopReason: 'WHATEVER' }), 'INTERNAL');
});

test('addStop_ checks what it is given: ids, whole milliseconds, a cap of at most 24 hours, and a missing-timer error', () => {
  const { env, world } = setup();
  const timer = startTimer(env, world);
  const tx = () => env.ctx.Db.tx_({ userId: 'u', requestId: 'r', action: 'a', payloadHash: 'h'.repeat(64), now: env.fakes.clock.now() });
  const good = { label: 'x', entryId: 'e1', userId: timer.user_id, timerId: timer.timer_id, endAt: 1, capMs: HOUR, stopReason: 'USER', now: 1, missing: MISSING };
  assert.doesNotThrow(() => env.ctx.ActTimer.addStop_(tx(), good));
  for (const bad of [{ label: '' }, { entryId: '' }, { userId: undefined }, { timerId: 5 }, { endAt: 1.5 }, { endAt: '1' }, { capMs: 0 }, { capMs: -1 },
    { capMs: 25 * HOUR }, { capMs: 1.5 }, { now: 'x' }, { stopReason: undefined }, { missing: undefined }, { missing: { code: 'NOPE', message: 'x' } }]) {
    expectCode(() => env.ctx.ActTimer.addStop_(tx(), { ...good, ...bad }), 'INTERNAL');
  }
});

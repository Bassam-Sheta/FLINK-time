'use strict';

// T2.4 — timer.start, timer.stop and timer.switch (BUILD_SPEC 6.2 and 6.4), through the real pipeline. The database, not
// the application, enforces that a user has one timer; a stop writes exactly one entry; the rules come from settings.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createActEnv, ok, failed } = require('./helpers/act');

const HOUR = 3600000;
const W3 = '00000000-0000-4000-8000-0000000000a3';
const now = t => t.env.fakes.clock.now();
const audits = (t, action) => t.rows(`SELECT * FROM audit_log WHERE action = '${action}' ORDER BY seq`);

function start(t, persona = 'user1', payload = {}, opts = {}) {
  return t.call(persona, 'timer.start', { clientAt: now(t), ...payload }, { ws: t.ids.w1, ...opts });
}
function stop(t, persona, timerId, payload = {}, opts = {}) {
  return t.call(persona, 'timer.stop', { timerId, clientAt: now(t), ...payload }, { ws: t.ids.w1, ...opts });
}
function swtch(t, persona, timerId, version, payload = {}, opts = {}) {
  return t.call(persona, 'timer.switch', { timerId, version, ...payload }, { ws: t.ids.w1, ...opts });
}
const running = (t, persona = 'user1') => ok(start(t, persona)).timer;
const timerRow = (t, user = 'user1') => t.one(`SELECT * FROM active_timers WHERE user_id = '${t.ids[user]}'`);
const policy = (response, rule) => { failed(response, 'POLICY'); assert.deepEqual(response.details, { rule }); };

// ---------------------------------------------------------------- timer.start

test('timer.start: starts a timer with the caller as owner, the workspace time zone date, and an audit row', () => {
  const t = createActEnv();
  const data = ok(start(t));
  assert.deepEqual(data.timer, {
    timerId: data.timer.timerId, workspaceId: t.ids.w1, projectId: null, taskId: null, description: '', billable: true, tagIds: [],
    startedAt: now(t), localDate: '2026-11-05', version: 1,
  });
  assert.deepEqual(Object.keys(data), ['timer']);
  const row = timerRow(t);
  assert.deepEqual([row.user_id, row.timer_id, row.workspace_id, row.started_at, row.local_date, row.tag_ids_json, row.version],
    [t.ids.user1, data.timer.timerId, t.ids.w1, now(t), '2026-11-05', '[]', 1]);
  const [audit] = audits(t, 'TIMER_STARTED');
  assert.deepEqual([audit.actor_user_id, audit.entity_type, audit.entity_id, audit.workspace_id], [t.ids.user1, 'TIMER', data.timer.timerId, t.ids.w1]);
  assert.deepEqual(JSON.parse(audit.after_json), { billable: true, description: '', projectId: null, startedAt: now(t), tagIds: [], taskId: null });
});

test('timer.start: project, task, description, billable and tags are stored and returned, and never a rate', () => {
  const t = createActEnv();
  const data = ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: '  Fix the thing  ', billable: false, tagIds: [t.ids.tagA] }));
  assert.deepEqual([data.timer.projectId, data.timer.taskId, data.timer.description, data.timer.billable, data.timer.tagIds],
    [t.ids.open, t.ids.task, 'Fix the thing', false, [t.ids.tagA]]);
  assert.ok(!/rate|cost|budget|minor/i.test(JSON.stringify(data)));
  assert.equal(timerRow(t).tag_ids_json, JSON.stringify([t.ids.tagA]));
});

test('timer.start: billable defaults to the task\'s default, else the project\'s, else true; an explicit value wins', () => {
  const t = createActEnv();
  const billable = body => ok(start(t, 'user1', body)).timer;
  const reset = () => { t.env.turso.db.exec('DELETE FROM active_timers'); };
  assert.equal(billable({}).billable, true);
  reset();
  t.env.turso.db.exec(`UPDATE projects SET billable_default = 0 WHERE id = '${t.ids.open}'`);
  assert.equal(billable({ projectId: t.ids.open }).billable, false, 'the project says no');
  reset();
  t.env.turso.db.exec(`UPDATE tasks SET billable_default = 1 WHERE id = '${t.ids.task}'`);
  assert.equal(billable({ projectId: t.ids.open, taskId: t.ids.task }).billable, true, 'the task overrides the project');
  reset();
  assert.equal(billable({ projectId: t.ids.open, taskId: t.ids.task, billable: false }).billable, false, 'what the user chose wins');
});

test('timer.start: the start is the client time when it is close to the server\'s and not in the future, else the server time', () => {
  const cases = [
    [-5000, -5000], [-120000, -120000], [-120001, 0], [5000, 0], [120000, 0], [-3600000, 0], [3600000, 0],
  ];
  for (const [offset, expected] of cases) {
    const t = createActEnv();
    const data = ok(start(t, 'user1', { clientAt: now(t) + offset }));
    assert.equal(data.timer.startedAt, now(t) + expected, `clientAt ${offset} ms from now`);
  }
});

test('timer.start: the skew is the TIMER_CLIENT_SKEW_SECONDS setting', () => {
  const t = createActEnv();
  t.setSetting('GLOBAL', 'TIMER_CLIENT_SKEW_SECONDS', 10);
  assert.equal(ok(start(t, 'user1', { clientAt: now(t) - 9000 })).timer.startedAt, now(t) - 9000);
  t.env.turso.db.exec('DELETE FROM active_timers');
  assert.equal(ok(start(t, 'user1', { clientAt: now(t) - 11000 })).timer.startedAt, now(t));
});

test('timer.start: the local date is the date in the workspace time zone, not in UTC', () => {
  const t = createActEnv();
  t.env.fakes.clock.set(Date.UTC(2026, 10, 5, 22, 30));                    // 00:30 on the 6th in Cairo (UTC+2)
  assert.equal(ok(start(t)).timer.localDate, '2026-11-06');
});

test('timer.start: a second timer is CONFLICT, even in another workspace, and the database is what says so', () => {
  const t = createActEnv();
  ok(start(t));
  const second = failed(start(t), 'CONFLICT');
  assert.match(second.message, /already running/i);
  assert.equal(t.rows('SELECT * FROM active_timers').length, 1);
  // the table's own rule, with no help from the handler: a second row for the same user is refused by the primary key
  assert.throws(() => t.insert('active_timers', { ...timerRow(t), timer_id: crypto.randomUUID() }), /UNIQUE|constraint/i);
});

test('timer.start: a retry with the same request id returns the same timer and starts one', () => {
  const t = createActEnv();
  const requestId = '99999999-9999-4999-8999-999999999999';
  const clientAt = now(t);                                      // a retry sends the very same request
  const first = ok(start(t, 'user1', { clientAt }, { requestId }));
  t.env.fakes.clock.advance(5000);
  const retry = ok(start(t, 'user1', { clientAt }, { requestId }));
  assert.deepEqual(retry, first);
  assert.equal(t.rows('SELECT * FROM active_timers').length, 1);
  assert.equal(audits(t, 'TIMER_STARTED').length, 1);
});

test('timer.start: a retry after the timer was stopped still answers, with no timer', () => {
  const t = createActEnv();
  const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const first = ok(start(t, 'user1', {}, { requestId }));
  ok(stop(t, 'user1', first.timer.timerId));
  assert.deepEqual(ok(start(t, 'user1', {}, { requestId })), { timer: null });
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0, 'nothing is started again');
});

test('timer.start: every role can start in a workspace they belong to; a non-member cannot, and neither can a Super Admin who is not one', () => {
  const t = createActEnv();
  for (const persona of ['user1', 'admin1', 'admin2']) {
    ok(start(t, persona));
    t.env.turso.db.exec('DELETE FROM active_timers');
  }
  failed(start(t, 'admin3'), 'FORBIDDEN');
  failed(start(t, 'user4'), 'FORBIDDEN');
  const sa = failed(start(t, 'sa'), 'FORBIDDEN');
  assert.match(sa.message, /member/i, 'the pipeline lets a Super Admin in; the transaction says they are not a member');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
});

test('timer.start: the workspace must be active, in the transaction too', () => {
  const t = createActEnv();
  failed(t.call('user4', 'timer.start', { clientAt: now(t) }, { ws: t.ids.w2 }), 'FORBIDDEN');
  ok(t.call('user1', 'workspaces.list'));                                   // fills user1's cached account
  t.env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${t.ids.w1}'`);
  const late = failed(start(t), 'FORBIDDEN');
  assert.match(late.message, /archived/i);
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
});

test('timer.start: a member removed after the cache was filled is refused by the transaction', () => {
  const t = createActEnv();
  ok(t.call('user2', 'workspaces.list'));
  t.env.turso.db.exec(`UPDATE workspace_members SET active = 0 WHERE user_id = '${t.ids.user2}'`);
  failed(start(t, 'user2'), 'FORBIDDEN');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
});

test('timer.start: the project must be an active project of this workspace that the caller may track (6.3)', () => {
  const t = createActEnv();
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
  const foreign = '00000000-0000-4000-8000-0000000000d3';
  t.insert('projects', { id: foreign, workspace_id: W3, client_id: null, name: 'Elsewhere', code: null, status: 'ACTIVE', restricted: 0, billable_default: 1, hourly_rate_minor: null,
    cost_rate_minor: null, estimate_minutes: null, budget_minor: null, start_date: null, end_date: null, color: null, created_at: 1, updated_at: 1, version: 1 });
  failed(start(t, 'user1', { projectId: foreign }), 'NOT_FOUND');
  failed(start(t, 'user1', { projectId: t.ids.archivedProject }), 'NOT_FOUND');
  failed(start(t, 'user1', { projectId: '00000000-0000-4000-8000-0000000000ff' }), 'NOT_FOUND');
  failed(start(t, 'user2', { projectId: t.ids.locked }), 'NOT_FOUND');          // restricted, no access row
  ok(start(t, 'user1', { projectId: t.ids.locked }));                             // restricted, with an access row
  t.env.turso.db.exec('DELETE FROM active_timers');
  ok(start(t, 'admin2', { projectId: t.ids.locked }));                            // Admins are never restricted
  t.env.turso.db.exec('DELETE FROM active_timers');
  ok(start(t, 'admin1', { projectId: t.ids.locked }));
  t.env.turso.db.exec(`UPDATE project_access SET can_track = 0 WHERE user_id = '${t.ids.user1}'; DELETE FROM active_timers`);
  failed(start(t, 'user1', { projectId: t.ids.locked }), 'NOT_FOUND');            // can_track = 0 grants nothing
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
});

test('timer.start: a project archived between the lookup and the write is refused by the transaction', () => {
  const t = createActEnv();
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) t.env.turso.db.exec(`UPDATE projects SET status = 'ARCHIVED' WHERE id = '${t.ids.open}'`);
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(start(t, 'user1', { projectId: t.ids.open }), 'NOT_FOUND');
});

test('timer.start: a task needs its project, must belong to it and be active', () => {
  const t = createActEnv();
  assert.equal(failed(start(t, 'user1', { taskId: t.ids.task }), 'VALIDATION').details.field, 'taskId');
  failed(start(t, 'user1', { projectId: t.ids.locked, taskId: t.ids.task }), 'NOT_FOUND', 'the task belongs to another project');
  t.env.turso.db.exec(`UPDATE tasks SET status = 'ARCHIVED' WHERE id = '${t.ids.task}'`);
  failed(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task }), 'NOT_FOUND');
  t.env.turso.db.exec(`UPDATE tasks SET status = 'ACTIVE' WHERE id = '${t.ids.task}'`);
  ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task }));
});

test('timer.start: tags must be active tags of the workspace; with FEATURE_TAGS off a non-empty list is POLICY', () => {
  const t = createActEnv();
  assert.equal(failed(start(t, 'user1', { tagIds: [t.ids.tagB] }), 'VALIDATION').details.field, 'tagIds');
  assert.equal(failed(start(t, 'user1', { tagIds: [t.ids.tagA, '00000000-0000-4000-8000-0000000000ff'] }), 'VALIDATION').details.field, 'tagIds');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
  t.setSetting(t.ids.w1, 'FEATURE_TAGS', false);
  policy(start(t, 'user1', { tagIds: [t.ids.tagA] }), 'FEATURE_TAGS');
  ok(start(t, 'user1', { tagIds: [] }));
});

test('timer.start: RULE_PROJECT_REQUIRED, RULE_TASK_REQUIRED and REQUIRE_DESCRIPTION are POLICY naming the rule, in that order', () => {
  const t = createActEnv();
  t.setSetting(t.ids.w1, 'RULE_PROJECT_REQUIRED', true);
  t.setSetting(t.ids.w1, 'RULE_TASK_REQUIRED', true);
  t.setSetting(t.ids.w1, 'REQUIRE_DESCRIPTION', true);
  policy(start(t), 'RULE_PROJECT_REQUIRED');
  policy(start(t, 'user1', { projectId: t.ids.open }), 'RULE_TASK_REQUIRED');
  policy(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task }), 'REQUIRE_DESCRIPTION');
  policy(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: '   ' }), 'REQUIRE_DESCRIPTION');
  ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: 'done' }));
  assert.equal(t.rows('SELECT * FROM active_timers').length, 1);
});

test('timer.start: the rules are per workspace and off by default; a global value applies where there is no override', () => {
  const t = createActEnv();
  ok(start(t));                                                             // nothing is required by default
  t.env.turso.db.exec('DELETE FROM active_timers');
  t.setSetting('GLOBAL', 'REQUIRE_DESCRIPTION', true);
  policy(start(t), 'REQUIRE_DESCRIPTION');
  t.setSetting(t.ids.w1, 'REQUIRE_DESCRIPTION', false);
  ok(start(t));
});

test('timer.start: a rule refusal is not a rate-limited write, and a retry of a refused request is refused again', () => {
  const t = createActEnv();
  t.setSetting(t.ids.w1, 'RULE_PROJECT_REQUIRED', true);
  const requestId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  policy(start(t, 'user1', {}, { requestId }), 'RULE_PROJECT_REQUIRED');
  policy(start(t, 'user1', {}, { requestId }), 'RULE_PROJECT_REQUIRED');
  assert.equal(t.rows('SELECT * FROM request_log').length, 0, 'a refused request leaves nothing behind');
});

test('timer.start: the clientAt is required and must be a time within ten years', () => {
  const t = createActEnv();
  for (const clientAt of [undefined, null, 'now', 1.5, now(t) + 11 * 366 * 24 * HOUR]) {
    const response = t.call('user1', 'timer.start', clientAt === undefined ? {} : { clientAt }, { ws: t.ids.w1 });
    assert.equal(failed(response, 'VALIDATION').details.field, 'clientAt');
  }
});

// ---------------------------------------------------------------- timer.stop

test('timer.stop: writes exactly one entry with the rates of the project, removes the timer, and answers without money', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: 'work', tagIds: [t.ids.tagA] })).timer;
  t.env.fakes.clock.advance(2 * HOUR + 1500);
  const data = ok(stop(t, 'user1', timer.timerId));
  const entries = t.rows('SELECT * FROM time_entries');
  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.deepEqual([e.user_id, e.workspace_id, e.project_id, e.task_id, e.description, e.billable, e.source, e.stop_reason, e.timer_id, e.local_date, e.version],
    [t.ids.user1, t.ids.w1, t.ids.open, t.ids.task, 'work', 1, 'TIMER', 'USER', timer.timerId, '2026-11-05', 1]);
  assert.deepEqual([e.start_at, e.end_at, e.duration_s, e.hourly_rate_minor, e.cost_rate_minor], [timer.startedAt, now(t), 7201, 50000, 20000]);
  assert.deepEqual(t.rows('SELECT tag_id FROM entry_tags'), [{ tag_id: t.ids.tagA }]);
  assert.equal(t.rows('SELECT * FROM active_timers').length, 0);
  assert.deepEqual(data.entry, {
    id: e.id, projectId: t.ids.open, taskId: t.ids.task, description: 'work', startAt: timer.startedAt, endAt: now(t), durationS: 7201,
    localDate: '2026-11-05', billable: true, tagIds: [t.ids.tagA],
  });
  assert.ok(!/rate|cost|budget|minor/i.test(JSON.stringify(data)));
  assert.deepEqual(Object.keys(data), ['entry']);
});

test('timer.stop: the audit row names the entry, and the request log stores only its id', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.clock.advance(60000);
  const data = ok(stop(t, 'user1', timer.timerId));
  const [audit] = audits(t, 'TIMER_STOPPED');
  assert.deepEqual([audit.actor_user_id, audit.entity_type, audit.entity_id, audit.workspace_id], [t.ids.user1, 'TIME_ENTRY', data.entry.id, t.ids.w1]);
  assert.deepEqual(JSON.parse(audit.after_json), { durationS: 60, endAt: now(t), projectId: null, startAt: timer.startedAt, stopReason: 'USER', taskId: null, timerId: timer.timerId });
  const logged = t.rows("SELECT result_json FROM request_log WHERE action = 'timer.stop'")[0];
  assert.deepEqual(JSON.parse(logged.result_json), { entryId: data.entry.id });
});

test('timer.stop: a retry with the same request id returns the same entry, once', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.clock.advance(HOUR);
  const requestId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const clientAt = now(t);
  const first = ok(stop(t, 'user1', timer.timerId, { clientAt }, { requestId }));
  t.env.fakes.clock.advance(HOUR);
  const retry = ok(stop(t, 'user1', timer.timerId, { clientAt }, { requestId }));
  assert.deepEqual(retry, first);
  assert.equal(t.rows('SELECT * FROM time_entries').length, 1);
  assert.equal(audits(t, 'TIMER_STOPPED').length, 1);
});

test('timer.stop: stopping twice with different request ids: the second is NOT_FOUND and there is still one entry', () => {
  const t = createActEnv();
  const timer = running(t);
  ok(stop(t, 'user1', timer.timerId));
  failed(stop(t, 'user1', timer.timerId), 'NOT_FOUND');
  assert.equal(t.rows('SELECT * FROM time_entries').length, 1);
});

test('timer.stop: another user\'s timer id, an unknown id, and a timer of another workspace are all NOT_FOUND and nothing moves', () => {
  const t = createActEnv();
  const mine = running(t, 'user1');
  const theirs = running(t, 'user2');
  failed(stop(t, 'user1', theirs.timerId), 'NOT_FOUND');
  failed(stop(t, 'user1', '00000000-0000-4000-8000-0000000000ff'), 'NOT_FOUND');
  failed(stop(t, 'admin1', mine.timerId), 'NOT_FOUND');                       // a workspace admin cannot stop someone else's timer
  failed(t.call('user1', 'timer.stop', { timerId: mine.timerId, clientAt: now(t) }, { ws: t.ids.w2 }), 'FORBIDDEN');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 2);
  assert.equal(t.rows('SELECT * FROM time_entries').length, 0);
});

test('timer.stop: the end is capped at AUTO_STOP_HOURS (14 by default) after the start, and never longer than 24 hours', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.clock.advance(20 * HOUR);
  ok(stop(t, 'user1', timer.timerId));
  assert.equal(t.one('SELECT duration_s FROM time_entries').duration_s, 14 * 3600);
  const audit = JSON.parse(audits(t, 'TIMER_STOPPED')[0].after_json);
  assert.deepEqual([audit.durationS, audit.endAt], [14 * 3600, timer.startedAt + 14 * HOUR], 'the audit row records the capped end, not the proposed one');

  const t2 = createActEnv();
  t2.setSetting('GLOBAL', 'AUTO_STOP_HOURS', 24);
  const long = running(t2);
  t2.env.fakes.clock.advance(30 * HOUR);
  ok(stop(t2, 'user1', long.timerId));
  assert.equal(t2.one('SELECT duration_s FROM time_entries').duration_s, 24 * 3600);

  const t3 = createActEnv();
  t3.setSetting('GLOBAL', 'AUTO_STOP_HOURS', 1);
  const short = running(t3);
  t3.env.fakes.clock.advance(3 * HOUR);
  ok(stop(t3, 'user1', short.timerId));
  assert.equal(t3.one('SELECT duration_s FROM time_entries').duration_s, 3600);
});

test('timer.stop: the end is the client time when it is close to the server\'s, else the server time, and never before the start', () => {
  const run = (advance, clientOffset) => {
    const t = createActEnv();
    const timer = running(t);
    t.env.fakes.clock.advance(advance);
    ok(stop(t, 'user1', timer.timerId, { clientAt: now(t) + clientOffset }));
    return t.one('SELECT start_at, end_at FROM time_entries');
  };
  let row = run(HOUR, -30000);
  assert.equal(row.end_at - row.start_at, HOUR - 30000, 'the client was a little earlier');
  row = run(HOUR, 30000);
  assert.equal(row.end_at - row.start_at, HOUR, 'a client time in the future is the server time');
  row = run(HOUR, -3 * HOUR);
  assert.equal(row.end_at - row.start_at, HOUR, 'a client time far off is the server time');
  row = run(100, -90000);
  assert.equal(row.end_at, row.start_at, 'an end before the start is the start: duration 0');
});

test('timer.stop: an odd number of milliseconds still passes the duration CHECK', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.clock.advance(HOUR + 999);
  ok(stop(t, 'user1', timer.timerId));
  assert.equal(t.one('SELECT duration_s FROM time_entries').duration_s, 3600);
});

test('timer.stop: the date stays the one the timer started with, even if the time zone changed since', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.turso.db.exec(`UPDATE workspaces SET timezone = 'Pacific/Kiritimati' WHERE id = '${t.ids.w1}'`);
  t.env.run('Cache.bump_(Cache.GEN_ACCT_)');
  t.env.fakes.clock.advance(HOUR);
  ok(stop(t, 'user1', timer.timerId));
  assert.equal(t.one('SELECT local_date FROM time_entries').local_date, '2026-11-05');
});

test('timer.stop: a timer stopped between the read and the write is NOT_FOUND from the transaction, and an archived workspace is refused', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) t.env.turso.db.exec('DELETE FROM active_timers');
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(stop(t, 'user1', timer.timerId), 'NOT_FOUND');
  assert.equal(t.rows('SELECT * FROM time_entries').length, 0);

  const t2 = createActEnv();
  const t2timer = running(t2);
  ok(t2.call('user1', 'workspaces.list'));
  t2.env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${t2.ids.w1}'`);
  failed(stop(t2, 'user1', t2timer.timerId), 'FORBIDDEN');
  assert.equal(t2.rows('SELECT * FROM active_timers').length, 1);
});

test('timer.stop: validation of the fields', () => {
  const t = createActEnv();
  assert.equal(failed(t.call('user1', 'timer.stop', { clientAt: now(t) }, { ws: t.ids.w1 }), 'VALIDATION').details.field, 'timerId');
  assert.equal(failed(t.call('user1', 'timer.stop', { timerId: 'x', clientAt: now(t) }, { ws: t.ids.w1 }), 'VALIDATION').details.field, 'timerId');
  assert.equal(failed(t.call('user1', 'timer.stop', { timerId: crypto.randomUUID() }, { ws: t.ids.w1 }), 'VALIDATION').details.field, 'clientAt');
});

// ---------------------------------------------------------------- timer.switch

test('timer.switch: changes the fields sent, leaves the rest and the start time, bumps the version, audits before and after', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open, description: 'one', billable: true })).timer;
  t.env.fakes.clock.advance(HOUR);
  const data = ok(swtch(t, 'user1', timer.timerId, 1, { description: 'two', billable: false, tagIds: [t.ids.tagA] }));
  assert.deepEqual(data.timer, { ...timer, description: 'two', billable: false, tagIds: [t.ids.tagA], version: 2 });
  assert.equal(timerRow(t).started_at, timer.startedAt, 'the start time does not move');
  assert.equal(timerRow(t).local_date, timer.localDate);
  const [audit] = audits(t, 'TIMER_UPDATED');
  assert.deepEqual([audit.entity_type, audit.entity_id, audit.actor_user_id], ['TIMER', timer.timerId, t.ids.user1]);
  assert.deepEqual(JSON.parse(audit.before_json), { billable: true, description: 'one', tagIds: [] });
  assert.deepEqual(JSON.parse(audit.after_json), { billable: false, description: 'two', tagIds: [t.ids.tagA] });
});

test('timer.switch: null clears the task, the description and the tags; an absent field is left alone', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: 'x', tagIds: [t.ids.tagA] })).timer;
  const data = ok(swtch(t, 'user1', timer.timerId, 1, { taskId: null, description: null, tagIds: null })).timer;
  assert.deepEqual([data.projectId, data.taskId, data.description, data.tagIds], [t.ids.open, null, '', []]);
  assert.equal(failed(swtch(t, 'user1', timer.timerId, 2, { billable: null }), 'VALIDATION').details.field, 'billable');
});

test('timer.switch: a new project drops the old task unless a task of the new project is sent; the project is checked like at start', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task })).timer;
  const moved = ok(swtch(t, 'user1', timer.timerId, 1, { projectId: t.ids.locked })).timer;
  assert.deepEqual([moved.projectId, moved.taskId], [t.ids.locked, null]);
  failed(swtch(t, 'user1', timer.timerId, 2, { projectId: t.ids.archivedProject }), 'NOT_FOUND');
  assert.equal(failed(swtch(t, 'user1', timer.timerId, 2, { taskId: t.ids.task }), 'NOT_FOUND').ok, false, 'that task belongs to the other project');
  ok(swtch(t, 'user1', timer.timerId, 2, { projectId: t.ids.open, taskId: t.ids.task }));
  assert.deepEqual(ok(swtch(t, 'user1', timer.timerId, 3, { projectId: null })).timer.projectId, null, 'null clears the project');
});

test('timer.switch: a restricted project cannot be switched to without access', () => {
  const t = createActEnv();
  const timer = running(t, 'user2');
  failed(swtch(t, 'user2', timer.timerId, 1, { projectId: t.ids.locked }), 'NOT_FOUND');
  assert.equal(timerRow(t, 'user2').project_id, null);
});

test('timer.switch: ALLOW_USER_PROJECT_SWITCH off refuses a changed project only; other edits and the same project are fine', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open })).timer;
  t.setSetting(t.ids.w1, 'ALLOW_USER_PROJECT_SWITCH', false);
  policy(swtch(t, 'user1', timer.timerId, 1, { projectId: t.ids.locked }), 'ALLOW_USER_PROJECT_SWITCH');
  policy(swtch(t, 'user1', timer.timerId, 1, { projectId: null }), 'ALLOW_USER_PROJECT_SWITCH');
  ok(swtch(t, 'user1', timer.timerId, 1, { projectId: t.ids.open, description: 'same project' }));
  ok(swtch(t, 'user1', timer.timerId, 2, { description: 'only the text' }));
  assert.equal(timerRow(t).project_id, t.ids.open);
});

test('timer.switch: the rules apply to the timer as it will be', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { projectId: t.ids.open, taskId: t.ids.task, description: 'x' })).timer;
  t.setSetting(t.ids.w1, 'RULE_PROJECT_REQUIRED', true);
  t.setSetting(t.ids.w1, 'RULE_TASK_REQUIRED', true);
  t.setSetting(t.ids.w1, 'REQUIRE_DESCRIPTION', true);
  policy(swtch(t, 'user1', timer.timerId, 1, { projectId: null }), 'RULE_PROJECT_REQUIRED');
  policy(swtch(t, 'user1', timer.timerId, 1, { taskId: null }), 'RULE_TASK_REQUIRED');
  policy(swtch(t, 'user1', timer.timerId, 1, { description: ' ' }), 'REQUIRE_DESCRIPTION');
  ok(swtch(t, 'user1', timer.timerId, 1, { billable: false }));
});

test('timer.switch: tags are checked, and FEATURE_TAGS off refuses a non-empty list but allows clearing', () => {
  const t = createActEnv();
  const timer = ok(start(t, 'user1', { tagIds: [t.ids.tagA] })).timer;
  assert.equal(failed(swtch(t, 'user1', timer.timerId, 1, { tagIds: [t.ids.tagB] }), 'VALIDATION').details.field, 'tagIds');
  t.setSetting(t.ids.w1, 'FEATURE_TAGS', false);
  policy(swtch(t, 'user1', timer.timerId, 1, { tagIds: [t.ids.tagA] }), 'FEATURE_TAGS');
  assert.deepEqual(ok(swtch(t, 'user1', timer.timerId, 1, { tagIds: [] })).timer.tagIds, []);
});

test('timer.switch: a stale version is CONFLICT, also when it moved between the read and the write', () => {
  const t = createActEnv();
  const timer = running(t);
  ok(swtch(t, 'user1', timer.timerId, 1, { description: 'a' }));
  failed(swtch(t, 'user1', timer.timerId, 1, { description: 'b' }), 'CONFLICT');
  assert.equal(timerRow(t).description, 'a');
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) t.env.turso.db.exec('UPDATE active_timers SET version = version + 1');
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(swtch(t, 'user1', timer.timerId, 2, { description: 'c' }), 'CONFLICT');
  assert.equal(timerRow(t).description, 'a');
});

test('timer.switch: only the caller\'s own timer, in this workspace; others\' ids are NOT_FOUND', () => {
  const t = createActEnv();
  const mine = running(t, 'user1');
  const theirs = running(t, 'user2');
  failed(swtch(t, 'user1', theirs.timerId, 1, { description: 'hijack' }), 'NOT_FOUND');
  failed(swtch(t, 'admin1', mine.timerId, 1, { description: 'hijack' }), 'NOT_FOUND');
  failed(swtch(t, 'user1', '00000000-0000-4000-8000-0000000000ff', 1, { description: 'x' }), 'NOT_FOUND');
  assert.deepEqual(t.rows('SELECT description FROM active_timers').map(r => r.description), ['', '']);
});

test('timer.switch: a retry with the same request id returns the same answer and changes it once', () => {
  const t = createActEnv();
  const timer = running(t);
  const requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const first = ok(swtch(t, 'user1', timer.timerId, 1, { description: 'once' }, { requestId }));
  const retry = ok(swtch(t, 'user1', timer.timerId, 1, { description: 'once' }, { requestId }));
  assert.deepEqual(retry, first);
  assert.equal(timerRow(t).version, 2);
  assert.equal(audits(t, 'TIMER_UPDATED').length, 1);
});

test('timer.switch: an archived workspace is refused, in the transaction too', () => {
  const t = createActEnv();
  const timer = running(t);
  ok(t.call('user1', 'workspaces.list'));
  t.env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${t.ids.w1}'`);
  failed(swtch(t, 'user1', timer.timerId, 1, { description: 'late' }), 'FORBIDDEN');
});

// ---------------------------------------------------------------- the timer belongs to one workspace

test('stop and switch: a timer that runs in another workspace is NOT_FOUND here, even for its owner', () => {
  const t = createActEnv();
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
  t.insert('workspace_members', { workspace_id: W3, user_id: t.ids.user1, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  t.env.run('Cache.bump_(Cache.GEN_ACCT_)');
  const elsewhere = crypto.randomUUID();
  t.insert('active_timers', { user_id: t.ids.user1, timer_id: elsewhere, workspace_id: W3, project_id: null, task_id: null, description: '', billable: 1, tag_ids_json: '[]',
    started_at: now(t) - HOUR, local_date: '2026-11-05', version: 1 });
  failed(stop(t, 'user1', elsewhere), 'NOT_FOUND');                               // the envelope says W1
  failed(swtch(t, 'user1', elsewhere, 1, { description: 'x' }), 'NOT_FOUND');
  assert.equal(t.rows('SELECT * FROM time_entries').length, 0);
  ok(t.call('user1', 'timer.stop', { timerId: elsewhere, clientAt: now(t) }, { ws: W3 }));      // in its own workspace it works
});

test('start: a user with a timer in one workspace cannot start another in a second one', () => {
  const t = createActEnv();
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
  t.insert('workspace_members', { workspace_id: W3, user_id: t.ids.user1, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  t.env.run('Cache.bump_(Cache.GEN_ACCT_)');
  ok(start(t));
  failed(t.call('user1', 'timer.start', { clientAt: now(t) }, { ws: W3 }), 'CONFLICT');
});

test('stop: a request that a twin already committed is answered from the log even if this one still saw the timer', () => {
  const t = createActEnv();
  const timer = running(t);
  t.env.fakes.clock.advance(HOUR);
  const requestId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const clientAt = now(t);
  const first = ok(stop(t, 'user1', timer.timerId, { clientAt }, { requestId }));
  // the twin read the timer before the first one committed: put the row back so the read finds it
  t.insert('active_timers', { user_id: t.ids.user1, timer_id: timer.timerId, workspace_id: t.ids.w1, project_id: null, task_id: null, description: '', billable: 1,
    tag_ids_json: '[]', started_at: timer.startedAt, local_date: '2026-11-05', version: 1 });
  const twin = ok(stop(t, 'user1', timer.timerId, { clientAt }, { requestId }));
  assert.deepEqual(twin, first);
  assert.equal(t.rows('SELECT * FROM time_entries').length, 1, 'no second entry');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 1, 'the twin changed nothing');
});

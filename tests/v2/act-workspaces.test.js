'use strict';

// T2.1 — ActWorkspaces.gs: workspaces.* and members.*, including members.setAdmin with the D6 limit.
// Every test calls the real action through handleClientRequest, so the pipeline's checks run too.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createActEnv, ok, failed } = require('./helpers/act');

const HOUR = 3600000;
const W3 = '00000000-0000-4000-8000-0000000000a3';

function workspace3(t, status = 'ACTIVE') {
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Workspace Three', status, timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
}
function timer(t, userKey, overrides = {}) {
  const row = {
    user_id: t.ids[userKey], timer_id: crypto.randomUUID(), workspace_id: t.ids.w1, project_id: t.ids.open, task_id: null, description: 'w',
    billable: 1, tag_ids_json: '[]', started_at: t.env.fakes.clock.now() - 2 * HOUR, local_date: '2026-11-05', version: 1, ...overrides,
  };
  t.insert('active_timers', row);
  return row;
}
const audits = (t, action) => t.rows(`SELECT * FROM audit_log WHERE action = '${action}' ORDER BY seq`);
const member = (t, workspace, user) => t.one(`SELECT * FROM workspace_members WHERE workspace_id = '${t.ids[workspace] || workspace}' AND user_id = '${t.ids[user]}'`);

// ---------------------------------------------------------------- workspaces.list

test('workspaces.list: a user sees only their own workspaces, with exactly the allowlisted fields', () => {
  const t = createActEnv();
  const data = ok(t.call('user1', 'workspaces.list'));
  assert.deepEqual(data.workspaces, [{ id: t.ids.w1, name: 'Workspace One', status: 'ACTIVE', timezone: 'Africa/Cairo', weekStart: 'SUN', wsRole: 'MEMBER' }]);
  const archived = ok(t.call('user4', 'workspaces.list')).workspaces;
  assert.deepEqual(archived.map(w => [w.id, w.status, w.wsRole]), [[t.ids.w2, 'ARCHIVED', 'MEMBER']]);
  assert.deepEqual(ok(t.call('admin3', 'workspaces.list')).workspaces, [], 'an Admin who belongs to nothing sees nothing');
});

test('workspaces.list: a workspace admin sees theirs with their role; an inactive membership is not listed', () => {
  const t = createActEnv();
  assert.deepEqual(ok(t.call('admin1', 'workspaces.list')).workspaces.map(w => [w.id, w.wsRole]).sort(), [[t.ids.w1, 'ADMIN'], [t.ids.w2, 'ADMIN']].sort());
  t.env.turso.db.exec(`UPDATE workspace_members SET active = 0 WHERE user_id = '${t.ids.user2}'`);
  assert.deepEqual(ok(t.call('user2', 'workspaces.list')).workspaces, []);
});

test('workspaces.list: a user\'s list needs no database call beyond the account', () => {
  const t = createActEnv();
  t.call('user1', 'workspaces.list');
  t.resetCalls();
  t.call('user1', 'workspaces.list');
  assert.equal(t.tursoCalls(), 0);
});

test('workspaces.list: a Super Admin sees every workspace with code and version, and their own role in it', () => {
  const t = createActEnv();
  workspace3(t);
  const list = ok(t.call('sa', 'workspaces.list')).workspaces;
  assert.deepEqual(list.map(w => w.code).sort(), ['W1', 'W2', 'W3']);
  assert.deepEqual(Object.keys(list[0]).sort(), ['code', 'id', 'name', 'status', 'timezone', 'version', 'weekStart', 'wsRole']);
  assert.ok(list.every(w => w.wsRole === null), 'the Super Admin belongs to none of them');
  t.insert('workspace_members', { workspace_id: W3, user_id: t.ids.sa, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  t.bumpAccounts();
  assert.equal(ok(t.call('sa', 'workspaces.list')).workspaces.find(w => w.code === 'W3').wsRole, 'MEMBER');
});

// ---------------------------------------------------------------- workspaces.create

const newWorkspace = { code: 'ALPHA', name: 'Alpha Team', timezone: 'Europe/Berlin', weekStart: 'MON' };

test('workspaces.create makes an ACTIVE workspace with an audit row, and the Super Admin can use it at once', () => {
  const t = createActEnv();
  const data = ok(t.call('sa', 'workspaces.create', newWorkspace));
  assert.deepEqual(data.workspace, { id: data.workspace.id, ...newWorkspace, status: 'ACTIVE', version: 1 });
  const row = t.one(`SELECT * FROM workspaces WHERE id = '${data.workspace.id}'`);
  assert.deepEqual([row.code, row.name, row.status, row.timezone, row.week_start, row.version, row.created_at, row.updated_at],
    ['ALPHA', 'Alpha Team', 'ACTIVE', 'Europe/Berlin', 'MON', 1, t.env.fakes.clock.now(), t.env.fakes.clock.now()]);
  const [audit] = audits(t, 'WORKSPACE_CREATED');
  assert.deepEqual([audit.actor_user_id, audit.actor_role, audit.entity_type, audit.entity_id, audit.workspace_id], [t.ids.sa, 'SUPER_ADMIN', 'WORKSPACE', data.workspace.id, data.workspace.id]);
  assert.deepEqual(JSON.parse(audit.after_json), { code: 'ALPHA', name: 'Alpha Team', status: 'ACTIVE', timezone: 'Europe/Berlin', weekStart: 'MON' });
  // the cached account of the Super Admin lists the new workspace at once, so the next request about it passes the pipeline
  ok(t.call('sa', 'members.list', {}, { ws: data.workspace.id }));
});

test('workspaces.create: a duplicate code is CONFLICT; a retry with the same request id returns the same workspace once', () => {
  const t = createActEnv();
  const first = ok(t.call('sa', 'workspaces.create', newWorkspace, { requestId: '11111111-1111-4111-8111-111111111111' }));
  failed(t.call('sa', 'workspaces.create', { ...newWorkspace, name: 'Another' }), 'CONFLICT');
  const retry = ok(t.call('sa', 'workspaces.create', newWorkspace, { requestId: '11111111-1111-4111-8111-111111111111' }));
  assert.deepEqual(retry, first);
  assert.equal(t.rows("SELECT * FROM workspaces WHERE code = 'ALPHA'").length, 1);
  assert.equal(audits(t, 'WORKSPACE_CREATED').length, 1);
});

test('workspaces.create: a bad code, name, time zone or week start is VALIDATION; only a Super Admin with a step-up may', () => {
  const t = createActEnv();
  for (const [field, value] of [['code', 'lower'], ['code', 'TOO-LONG-CODE-1234567890'], ['name', ''], ['timezone', 'Mars/Base'], ['weekStart', 'WED']]) {
    assert.equal(failed(t.call('sa', 'workspaces.create', { ...newWorkspace, [field]: value }), 'VALIDATION').details.field, field);
  }
  failed(t.call('admin1', 'workspaces.create', newWorkspace), 'FORBIDDEN');
  t.staleStepUp();
  failed(t.call('sa', 'workspaces.create', newWorkspace), 'STEP_UP_REQUIRED');
  assert.equal(t.rows('SELECT * FROM workspaces').length, 2);
});

// ---------------------------------------------------------------- workspaces.update

const update = (t, overrides = {}, opts = {}) => t.call('sa', 'workspaces.update',
  { version: 1, name: 'Renamed', timezone: 'Africa/Cairo', weekStart: 'SAT', ...overrides }, { ws: t.ids.w1, ...opts });

test('workspaces.update changes the name and week start, bumps the version and records before and after', () => {
  const t = createActEnv();
  const data = ok(update(t));
  assert.deepEqual(data, { workspace: { id: t.ids.w1, code: 'W1', name: 'Renamed', status: 'ACTIVE', timezone: 'Africa/Cairo', weekStart: 'SAT', version: 2 }, timezoneRewriteScheduled: false });
  const row = t.one(`SELECT name, week_start, version, updated_at FROM workspaces WHERE id = '${t.ids.w1}'`);
  assert.deepEqual(row, { name: 'Renamed', week_start: 'SAT', version: 2, updated_at: t.env.fakes.clock.now() });
  const [audit] = audits(t, 'WORKSPACE_UPDATED');
  assert.deepEqual(JSON.parse(audit.before_json), { name: 'Workspace One', timezone: 'Africa/Cairo', weekStart: 'SUN' });
  assert.deepEqual(JSON.parse(audit.after_json), { name: 'Renamed', timezone: 'Africa/Cairo', weekStart: 'SAT' });
  assert.equal(t.rows("SELECT * FROM export_state WHERE name LIKE 'tzrewrite:%'").length, 0, 'no rewrite when the time zone did not change');
});

test('workspaces.update: a stale version is CONFLICT and changes nothing', () => {
  const t = createActEnv();
  ok(update(t));
  failed(update(t, { name: 'Late' }), 'CONFLICT');
  assert.equal(t.one(`SELECT name FROM workspaces WHERE id = '${t.ids.w1}'`).name, 'Renamed');
  assert.equal(audits(t, 'WORKSPACE_UPDATED').length, 1);
});

test('workspaces.update: a time zone change schedules the local_date rewrite once, and a second change replaces its target', () => {
  const t = createActEnv();
  const data = ok(update(t, { timezone: 'Europe/Berlin' }));
  assert.equal(data.timezoneRewriteScheduled, true);
  const [job] = t.rows("SELECT * FROM export_state WHERE name LIKE 'tzrewrite:%'");
  assert.deepEqual([job.name, job.status, job.last_seq], ['tzrewrite:' + t.ids.w1, 'PENDING', 0]);
  assert.deepEqual(JSON.parse(job.cursor_json), { at: t.env.fakes.clock.now(), from: 'Africa/Cairo', to: 'Europe/Berlin' });
  ok(update(t, { version: 2, timezone: 'Asia/Tokyo' }));
  const jobs = t.rows("SELECT * FROM export_state WHERE name LIKE 'tzrewrite:%'");
  assert.equal(jobs.length, 1);
  assert.equal(JSON.parse(jobs[0].cursor_json).to, 'Asia/Tokyo');
  assert.equal(JSON.parse(jobs[0].cursor_json).from, 'Europe/Berlin', 'from is what the database held at the moment of this change');
});

test('workspaces.update: members see the new time zone at once, and an archived workspace cannot be updated', () => {
  const t = createActEnv();
  assert.equal(ok(t.call('user1', 'workspaces.list')).workspaces[0].timezone, 'Africa/Cairo');
  ok(update(t, { timezone: 'Europe/Berlin' }));
  assert.equal(ok(t.call('user1', 'workspaces.list')).workspaces[0].timezone, 'Europe/Berlin');
  failed(t.call('sa', 'workspaces.update', { version: 1, name: 'x', timezone: 'Africa/Cairo', weekStart: 'SUN' }, { ws: t.ids.w2 }), 'FORBIDDEN');
});

test('workspaces.update: the transaction itself refuses a workspace that was archived after the cache was filled', () => {
  const t = createActEnv();
  ok(t.call('sa', 'workspaces.list'));                                         // fills the Super Admin's cached account
  t.env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${t.ids.w1}'`);   // behind the cache's back
  const response = failed(update(t), 'FORBIDDEN');
  assert.match(response.message, /archived/i);
  assert.equal(t.one(`SELECT name FROM workspaces WHERE id = '${t.ids.w1}'`).name, 'Workspace One');
});

test('workspaces.update: only a Super Admin with a step-up; a retry with the same request id changes it once', () => {
  const t = createActEnv();
  failed(t.call('admin1', 'workspaces.update', { version: 1, name: 'x', timezone: 'Africa/Cairo', weekStart: 'SUN' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  t.staleStepUp();
  failed(update(t), 'STEP_UP_REQUIRED');
  t.freshStepUp();
  const id = '22222222-2222-4222-8222-222222222222';
  const first = ok(update(t, {}, { requestId: id }));
  assert.deepEqual(ok(update(t, {}, { requestId: id })), first);
  assert.equal(t.one(`SELECT version FROM workspaces WHERE id = '${t.ids.w1}'`).version, 2);
  assert.equal(audits(t, 'WORKSPACE_UPDATED').length, 1);
});

// ---------------------------------------------------------------- workspaces.archive

const archive = (t, overrides = {}, opts = {}) => t.call('sa', 'workspaces.archive', { version: 1, ...overrides }, { ws: t.ids.w1, ...opts });

test('workspaces.archive archives with a version bump and an audit row; writes there are refused from then on', () => {
  const t = createActEnv();
  assert.deepEqual(ok(archive(t)), { workspace: { id: t.ids.w1, status: 'ARCHIVED', version: 2 }, stoppedTimers: 0 });
  assert.deepEqual(t.one(`SELECT status, version FROM workspaces WHERE id = '${t.ids.w1}'`), { status: 'ARCHIVED', version: 2 });
  const [audit] = audits(t, 'WORKSPACE_ARCHIVED');
  assert.deepEqual([audit.actor_user_id, audit.entity_id, audit.workspace_id], [t.ids.sa, t.ids.w1, t.ids.w1]);
  assert.deepEqual(JSON.parse(audit.after_json), { status: 'ARCHIVED', stoppedTimers: 0 });
  failed(t.call('admin1', 'members.update', { userId: t.ids.user1, team: 'x' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  assert.equal(ok(t.call('user1', 'workspaces.list')).workspaces[0].status, 'ARCHIVED', 'members see it at once');
});

test('workspaces.archive stops every running timer in the workspace into an entry, by the SYSTEM, and leaves other workspaces alone', () => {
  const t = createActEnv();
  workspace3(t);
  const a = timer(t, 'user1');
  const b = timer(t, 'user2', { started_at: t.env.fakes.clock.now() - 90 * 60000 - 1500 });
  const elsewhere = timer(t, 'user3', { workspace_id: W3, project_id: null });
  const data = ok(archive(t));
  assert.equal(data.stoppedTimers, 2);
  const entries = t.rows('SELECT user_id, start_at, end_at, duration_s, stop_reason, timer_id, workspace_id FROM time_entries ORDER BY user_id');
  assert.deepEqual(entries.map(e => [e.user_id, e.duration_s, e.stop_reason, e.workspace_id]), [[t.ids.user1, 7200, 'USER', t.ids.w1], [t.ids.user2, 5401, 'USER', t.ids.w1]]);
  assert.ok(entries.every(e => e.end_at === t.env.fakes.clock.now()));
  assert.deepEqual(entries.map(e => e.timer_id).sort(), [a.timer_id, b.timer_id].sort());
  assert.deepEqual(t.rows('SELECT timer_id FROM active_timers'), [{ timer_id: elsewhere.timer_id }]);
  const stops = audits(t, 'TIMER_STOPPED');
  assert.equal(stops.length, 2);
  assert.ok(stops.every(s => s.actor_user_id === 'SYSTEM' && s.actor_role === 'SYSTEM' && s.workspace_id === t.ids.w1 && s.entity_type === 'TIME_ENTRY'));
  assert.deepEqual(JSON.parse(stops[0].after_json).stopReason, 'USER');
});

test('workspaces.archive caps a stopped entry at AUTO_STOP_HOURS', () => {
  const t = createActEnv();
  t.setSetting('GLOBAL', 'AUTO_STOP_HOURS', 1);
  timer(t, 'user1', { started_at: t.env.fakes.clock.now() - 3 * HOUR });
  ok(archive(t));
  assert.equal(t.one('SELECT duration_s FROM time_entries').duration_s, 3600);
});

test('workspaces.archive: a timer started while it runs makes it CONFLICT and changes nothing', () => {
  const t = createActEnv();
  const a = timer(t, 'user1');
  // a timer starts just before the transaction reaches the database
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) timer(t, 'user2');
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(archive(t), 'CONFLICT');
  assert.equal(t.one(`SELECT status, version FROM workspaces WHERE id = '${t.ids.w1}'`).status, 'ACTIVE');
  assert.equal(t.rows('SELECT * FROM active_timers').length, 2, 'both timers still run');
  assert.equal(t.rows('SELECT * FROM time_entries').length, 0);
  assert.ok(a);
});

test('workspaces.archive: a stale version is CONFLICT, an archived workspace is FORBIDDEN, and it is Super Admin with step-up only', () => {
  const t = createActEnv();
  failed(archive(t, { version: 9 }), 'CONFLICT');
  failed(t.call('admin1', 'workspaces.archive', { version: 1 }, { ws: t.ids.w1 }), 'FORBIDDEN');
  t.staleStepUp();
  failed(archive(t), 'STEP_UP_REQUIRED');
  t.freshStepUp();
  ok(archive(t));
  failed(archive(t, { version: 2 }), 'FORBIDDEN');
  assert.equal(audits(t, 'WORKSPACE_ARCHIVED').length, 1);
});

test('workspaces.archive: a retry after it worked stops nothing twice (the workspace is archived, so it is refused as any request would be)', () => {
  const t = createActEnv();
  timer(t, 'user1');
  const id = '33333333-3333-4333-8333-333333333333';
  ok(archive(t, {}, { requestId: id }));
  failed(archive(t, {}, { requestId: id }), 'FORBIDDEN');
  assert.equal(t.rows('SELECT * FROM time_entries').length, 1);
  assert.equal(t.rows("SELECT * FROM audit_log WHERE action = 'TIMER_STOPPED'").length, 1);
});

// ---------------------------------------------------------------- members.list

test('members.list: members with their account facts and workspace role, inactive ones marked, and nothing financial', () => {
  const t = createActEnv();
  const members = ok(t.call('admin1', 'members.list', {}, { ws: t.ids.w1 })).members;
  assert.deepEqual(members.map(m => [m.email, m.wsRole, m.active]).sort(), [
    ['admin1@flink.test', 'ADMIN', true], ['admin2@flink.test', 'MEMBER', true], ['gone@flink.test', 'MEMBER', false],
    ['user1@flink.test', 'MEMBER', true], ['user2@flink.test', 'MEMBER', true], ['user3@flink.test', 'MEMBER', true],
  ].sort());
  assert.deepEqual(Object.keys(members[0]).sort(), ['accountRole', 'accountStatus', 'active', 'department', 'displayName', 'email', 'jobTitle', 'team', 'userId', 'wsRole']);
  assert.equal(members.find(m => m.email === 'gone@flink.test').accountStatus, 'INACTIVE');
  assert.equal(ok(t.call('sa', 'members.list', {}, { ws: t.ids.w1 })).members.length, 6, 'a Super Admin who is not a member may list too');
});

test('members.list: needs a grant', () => {
  const t = createActEnv();
  failed(t.call('admin1', 'members.list', {}, { ws: t.ids.w1, grant: false }), 'CODE_REQUIRED');
});

// ---------------------------------------------------------------- members.add

const add = (t, persona, payload, opts = {}) => t.call(persona, 'members.add', payload, { ws: t.ids.w1, ...opts });

test('members.add: a workspace admin adds an active user as a MEMBER, and the user sees the workspace at once', () => {
  const t = createActEnv();
  assert.deepEqual(ok(t.call('user4', 'workspaces.list')).workspaces.map(w => w.id), [t.ids.w2]);
  const data = ok(add(t, 'admin1', { userId: t.ids.user4, department: 'Ops', team: 'Night', jobTitle: 'Lead' }));
  assert.deepEqual(data.member, { userId: t.ids.user4, wsRole: 'MEMBER', active: true, department: 'Ops', team: 'Night', jobTitle: 'Lead' });
  const row = member(t, 'w1', 'user4');
  assert.deepEqual([row.ws_role, row.active, row.department, row.team, row.job_title, row.version], ['MEMBER', 1, 'Ops', 'Night', 'Lead', 1]);
  assert.deepEqual(ok(t.call('user4', 'workspaces.list')).workspaces.map(w => w.id).sort(), [t.ids.w1, t.ids.w2].sort());
  const [audit] = audits(t, 'MEMBER_ADDED');
  assert.deepEqual([audit.actor_user_id, audit.entity_type, audit.entity_id, audit.workspace_id, audit.before_json], [t.ids.admin1, 'WORKSPACE_MEMBER', t.ids.user4, t.ids.w1, null]);
  assert.deepEqual(JSON.parse(audit.after_json), { wsRole: 'MEMBER', active: true, department: 'Ops', team: 'Night', jobTitle: 'Lead' });
});

test('members.add: someone who is already a member is CONFLICT; an unknown or inactive user is NOT_FOUND', () => {
  const t = createActEnv();
  failed(add(t, 'admin1', { userId: t.ids.user1 }), 'CONFLICT');
  failed(add(t, 'admin1', { userId: '00000000-0000-4000-8000-0000000000ff' }), 'NOT_FOUND');
  failed(add(t, 'admin1', { userId: t.ids.gone }), 'NOT_FOUND');
  assert.equal(audits(t, 'MEMBER_ADDED').length, 0);
});

test('members.add: a removed member comes back as a plain MEMBER with the new details, and the version moves on', () => {
  const t = createActEnv();
  t.env.turso.db.exec(`UPDATE workspace_members SET active = 0, ws_role = 'ADMIN', department = 'Old' WHERE workspace_id = '${t.ids.w1}' AND user_id = '${t.ids.admin2}'`);
  ok(add(t, 'admin1', { userId: t.ids.admin2, team: 'New' }));
  const row = member(t, 'w1', 'admin2');
  assert.deepEqual([row.active, row.ws_role, row.department, row.team, row.version], [1, 'MEMBER', null, 'New', 2]);
  const [audit] = audits(t, 'MEMBER_ADDED');
  assert.deepEqual(JSON.parse(audit.before_json), { active: false, wsRole: 'ADMIN' });
});

test('members.add: a workspace admin of another workspace cannot add here; an archived workspace takes no new members', () => {
  const t = createActEnv();
  workspace3(t);
  failed(t.call('admin1', 'members.add', { userId: t.ids.user4 }, { ws: W3 }), 'FORBIDDEN');
  failed(t.call('admin1', 'members.add', { userId: t.ids.user1 }, { ws: t.ids.w2 }), 'FORBIDDEN');
});

test('members.add: a Super Admin needs a fresh step-up, a workspace admin does not', () => {
  const t = createActEnv();
  t.staleStepUp();
  ok(add(t, 'admin1', { userId: t.ids.user4 }));
  failed(add(t, 'sa', { userId: t.ids.admin3 }), 'STEP_UP_REQUIRED');
  assert.equal(member(t, 'w1', 'admin3'), undefined);
  t.freshStepUp();
  ok(add(t, 'sa', { userId: t.ids.admin3 }));
});

test('members.add: a retry with the same request id returns the stored answer and adds one row', () => {
  const t = createActEnv();
  const id = '44444444-4444-4444-8444-444444444444';
  const first = ok(add(t, 'admin1', { userId: t.ids.user4 }, { requestId: id }));
  assert.deepEqual(ok(add(t, 'admin1', { userId: t.ids.user4 }, { requestId: id })), first);
  assert.equal(audits(t, 'MEMBER_ADDED').length, 1);
  assert.equal(member(t, 'w1', 'user4').version, 1);
  // the same id for a different request is refused, not answered with the first one's result
  const reused = failed(add(t, 'admin1', { userId: t.ids.admin3 }, { requestId: id }), 'VALIDATION');
  assert.equal(reused.details.field, 'requestId');
});

test('members.add: the transaction refuses a target who was deactivated between the lookup and the write', () => {
  const t = createActEnv();
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) t.env.turso.db.exec(`UPDATE accounts SET status = 'INACTIVE' WHERE id = '${t.ids.admin3}'`);
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(add(t, 'admin1', { userId: t.ids.admin3 }), 'NOT_FOUND');
  assert.equal(member(t, 'w1', 'admin3'), undefined);
});

test('members.add: the transaction refuses a second add that raced the first', () => {
  const t = createActEnv();
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) {
      t.insert('workspace_members', { workspace_id: t.ids.w1, user_id: t.ids.user4, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
    }
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(add(t, 'admin1', { userId: t.ids.user4 }), 'CONFLICT');
  assert.equal(audits(t, 'MEMBER_ADDED').length, 0);
});

// ---------------------------------------------------------------- members.update

const updateMember = (t, persona, payload, opts = {}) => t.call(persona, 'members.update', payload, { ws: t.ids.w1, ...opts });

test('members.update changes only the fields sent, null clears one, and it is audited with before and after', () => {
  const t = createActEnv();
  t.env.turso.db.exec(`UPDATE workspace_members SET department = 'Ops', team = 'Day', job_title = 'Tech' WHERE workspace_id = '${t.ids.w1}' AND user_id = '${t.ids.user1}'`);
  ok(updateMember(t, 'admin1', { userId: t.ids.user1, team: 'Night', jobTitle: null }));
  const row = member(t, 'w1', 'user1');
  assert.deepEqual([row.department, row.team, row.job_title, row.version], ['Ops', 'Night', null, 2]);
  const [audit] = audits(t, 'MEMBER_UPDATED');
  assert.deepEqual(JSON.parse(audit.before_json), { team: 'Day', jobTitle: 'Tech' });
  assert.deepEqual(JSON.parse(audit.after_json), { team: 'Night', jobTitle: null });
});

test('members.update: nothing to change is VALIDATION; a non-member or a removed member is NOT_FOUND', () => {
  const t = createActEnv();
  failed(updateMember(t, 'admin1', { userId: t.ids.user1 }), 'VALIDATION');
  failed(updateMember(t, 'admin1', { userId: t.ids.user4, team: 'x' }), 'NOT_FOUND');
  failed(updateMember(t, 'admin1', { userId: t.ids.gone, team: 'x' }), 'NOT_FOUND');
  assert.equal(audits(t, 'MEMBER_UPDATED').length, 0);
});

test('members.update: a Super Admin needs a step-up; the plain member of the workspace may not update at all', () => {
  const t = createActEnv();
  failed(updateMember(t, 'admin2', { userId: t.ids.user1, team: 'x' }), 'FORBIDDEN');
  t.staleStepUp();
  failed(updateMember(t, 'sa', { userId: t.ids.user1, team: 'x' }), 'STEP_UP_REQUIRED');
});

// ---------------------------------------------------------------- members.remove

const remove = (t, persona, payload, opts = {}) => t.call(persona, 'members.remove', payload, { ws: t.ids.w1, ...opts });

test('members.remove deactivates the membership and the person loses the workspace at once', () => {
  const t = createActEnv();
  ok(t.call('user3', 'workspaces.list'));
  assert.deepEqual(ok(remove(t, 'admin1', { userId: t.ids.user3 })), { removed: true, stoppedTimers: 0 });
  const row = member(t, 'w1', 'user3');
  assert.deepEqual([row.active, row.version], [0, 2]);
  assert.deepEqual(ok(t.call('user3', 'workspaces.list')).workspaces, []);
  failed(t.call('user3', 'projects.list', {}, { ws: t.ids.w1 }), 'FORBIDDEN');
  const [audit] = audits(t, 'MEMBER_REMOVED');
  assert.deepEqual(JSON.parse(audit.before_json), { active: true, wsRole: 'MEMBER' });
});

test('members.remove stops that user\'s running timer in this workspace, and only that one', () => {
  const t = createActEnv();
  workspace3(t);
  timer(t, 'user3');
  const other = timer(t, 'user2');
  t.insert('workspace_members', { workspace_id: W3, user_id: t.ids.user3, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  assert.equal(ok(remove(t, 'admin1', { userId: t.ids.user3 })).stoppedTimers, 1);
  assert.deepEqual(t.rows('SELECT user_id, stop_reason, duration_s FROM time_entries'), [{ user_id: t.ids.user3, stop_reason: 'USER', duration_s: 7200 }]);
  assert.deepEqual(t.rows('SELECT timer_id FROM active_timers'), [{ timer_id: other.timer_id }]);
  assert.equal(audits(t, 'TIMER_STOPPED')[0].actor_user_id, 'SYSTEM');
  assert.equal(member(t, W3, 'user3').active, 1, 'their membership elsewhere is untouched');
});

test('members.remove: a timer that starts while it runs makes it CONFLICT and changes nothing', () => {
  const t = createActEnv();
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) timer(t, 'user3');       // started just before the transaction
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(remove(t, 'admin1', { userId: t.ids.user3 }), 'CONFLICT');
  assert.equal(member(t, 'w1', 'user3').active, 1);
  assert.equal(t.rows('SELECT * FROM active_timers').length, 1);
});

test('members.remove: a non-member or one already removed is NOT_FOUND; the rest of the rules', () => {
  const t = createActEnv();
  failed(remove(t, 'admin1', { userId: t.ids.user4 }), 'NOT_FOUND');
  ok(remove(t, 'admin1', { userId: t.ids.user3 }));
  failed(remove(t, 'admin1', { userId: t.ids.user3 }), 'NOT_FOUND');
  failed(remove(t, 'admin2', { userId: t.ids.user1 }), 'FORBIDDEN');
  t.staleStepUp();
  failed(remove(t, 'sa', { userId: t.ids.user1 }), 'STEP_UP_REQUIRED');
});

// ---------------------------------------------------------------- members.setAdmin

const setAdmin = (t, payload, opts = {}) => t.call('sa', 'members.setAdmin', payload, { ws: t.ids.w1, ...opts });

test('members.setAdmin: grants workspace admin rights, and the new admin can use them at once', () => {
  const t = createActEnv();
  failed(t.call('admin2', 'members.list', {}, { ws: t.ids.w1 }), 'FORBIDDEN');
  assert.deepEqual(ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true })), { member: { userId: t.ids.admin2, wsRole: 'ADMIN' }, changed: true });
  assert.deepEqual([member(t, 'w1', 'admin2').ws_role, member(t, 'w1', 'admin2').version], ['ADMIN', 2]);
  ok(t.call('admin2', 'members.list', {}, { ws: t.ids.w1 }));
  const [audit] = audits(t, 'MEMBER_ADMIN_SET');
  assert.deepEqual([JSON.parse(audit.before_json), JSON.parse(audit.after_json), audit.actor_user_id], [{ wsRole: 'MEMBER' }, { wsRole: 'ADMIN' }, t.ids.sa]);
});

test('members.setAdmin: takes the rights away again, and asking for what already is changes nothing', () => {
  const t = createActEnv();
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }));
  assert.deepEqual(ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true })), { member: { userId: t.ids.admin2, wsRole: 'ADMIN' }, changed: false });
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: false }));
  assert.equal(member(t, 'w1', 'admin2').ws_role, 'MEMBER');
  failed(t.call('admin2', 'members.list', {}, { ws: t.ids.w1 }), 'FORBIDDEN');
  assert.deepEqual(ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: false })).changed, false);
  assert.equal(audits(t, 'MEMBER_ADMIN_SET').length, 2);
});

test('members.setAdmin: a User account cannot be a workspace admin; a non-member or removed member is NOT_FOUND', () => {
  const t = createActEnv();
  failed(setAdmin(t, { userId: t.ids.user1, isAdmin: true }), 'FORBIDDEN');
  failed(setAdmin(t, { userId: t.ids.admin3, isAdmin: true }), 'NOT_FOUND');
  failed(setAdmin(t, { userId: t.ids.gone, isAdmin: true }), 'NOT_FOUND');
  assert.equal(member(t, 'w1', 'user1').ws_role, 'MEMBER');
  assert.equal(audits(t, 'MEMBER_ADMIN_SET').length, 0);
});

test('members.setAdmin: a User who somehow holds ws_role ADMIN can still be demoted', () => {
  const t = createActEnv();
  t.env.turso.db.exec(`UPDATE workspace_members SET ws_role = 'ADMIN' WHERE workspace_id = '${t.ids.w1}' AND user_id = '${t.ids.user1}'`);
  ok(setAdmin(t, { userId: t.ids.user1, isAdmin: false }));
  assert.equal(member(t, 'w1', 'user1').ws_role, 'MEMBER');
});

test('members.setAdmin (D6): the global limit of 3 active workspaces applies, archived ones do not count', () => {
  const t = createActEnv();
  // admin2 becomes admin of three active workspaces, then a fourth is refused with POLICY naming the setting
  const spaces = ['0a', '0b', '0c'].map((s, i) => ({ id: `00000000-0000-4000-8000-0000000000${s}`, code: `X${i}` }));
  for (const space of spaces) {
    t.insert('workspaces', { id: space.id, code: space.code, name: space.code, status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 3, updated_at: 3, version: 1 });
    t.insert('workspace_members', { workspace_id: space.id, user_id: t.ids.admin2, ws_role: 'MEMBER', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  }
  t.bumpAccounts();
  t.insert('workspace_members', { workspace_id: t.ids.w2, user_id: t.ids.admin2, ws_role: 'ADMIN', active: 1, department: null, team: null, job_title: null, created_at: 1, updated_at: 1, version: 1 });
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { ws: spaces[0].id }));
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { ws: spaces[1].id }));
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { ws: spaces[2].id }));                // the archived W2 did not count
  const refused = failed(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }), 'POLICY');
  assert.deepEqual(refused.details, { rule: 'ADMIN_MAX_ACTIVE_WORKSPACES' });
  assert.equal(member(t, 'w1', 'admin2').ws_role, 'MEMBER');
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { ws: spaces[0].id }));                // already admin there: no change, not refused
});

test('members.setAdmin (D6): an account\'s own limit beats the global one, in both directions', () => {
  const t = createActEnv();
  t.env.turso.db.exec(`UPDATE accounts SET admin_ws_limit = 0 WHERE id = '${t.ids.admin2}'`);
  t.bumpAccounts();
  failed(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }), 'POLICY');                         // a limit of 0 allows none
  t.env.turso.db.exec(`UPDATE accounts SET admin_ws_limit = 1 WHERE id = '${t.ids.admin2}'`);
  ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }));
  t.setSetting('GLOBAL', 'ADMIN_MAX_ACTIVE_WORKSPACES', 1);
  t.env.turso.db.exec(`UPDATE accounts SET admin_ws_limit = NULL WHERE id = '${t.ids.admin1}'`);
  assert.equal(member(t, 'w1', 'admin1').ws_role, 'ADMIN');
  t.env.turso.db.exec(`UPDATE workspace_members SET ws_role = 'MEMBER' WHERE user_id = '${t.ids.admin1}'`);
  ok(setAdmin(t, { userId: t.ids.admin1, isAdmin: true }));                                       // the global limit is 1: the first is fine
});

test('members.setAdmin: Super Admin with a step-up only, and a retry changes it once', () => {
  const t = createActEnv();
  failed(t.call('admin1', 'members.setAdmin', { userId: t.ids.admin2, isAdmin: true }, { ws: t.ids.w1 }), 'FORBIDDEN');
  t.staleStepUp();
  failed(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }), 'STEP_UP_REQUIRED');
  t.freshStepUp();
  const id = '55555555-5555-4555-8555-555555555555';
  const first = ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { requestId: id }));
  assert.deepEqual(ok(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }, { requestId: id })), first);
  assert.equal(audits(t, 'MEMBER_ADMIN_SET').length, 1);
});

test('members.setAdmin: an archived workspace takes no change', () => {
  const t = createActEnv();
  failed(t.call('sa', 'members.setAdmin', { userId: t.ids.user4, isAdmin: false }, { ws: t.ids.w2 }), 'FORBIDDEN');
});

// ---------------------------------------------------------------- races: the transaction is the authority

// Runs `change` against the database just before the transaction of the request reaches it.
function before(t, change) {
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) change();
    return t.env.turso.handleHttp(request);
  }, { first: true });
}

test('race: workspaces.update and .archive refuse a version that moved between the read and the write', () => {
  const t = createActEnv();
  before(t, () => t.env.turso.db.exec(`UPDATE workspaces SET version = version + 1 WHERE id = '${t.ids.w1}'`));
  failed(update(t), 'CONFLICT');
  failed(archive(t), 'CONFLICT');
  assert.deepEqual(t.one(`SELECT name, status, version FROM workspaces WHERE id = '${t.ids.w1}'`), { name: 'Workspace One', status: 'ACTIVE', version: 3 });   // the hook moved it once per request
});

test('race: members.remove leaves a timer in another workspace running', () => {
  const t = createActEnv();
  workspace3(t);
  const elsewhere = timer(t, 'user3', { workspace_id: W3, project_id: null });
  assert.equal(ok(remove(t, 'admin1', { userId: t.ids.user3 })).stoppedTimers, 0);
  assert.deepEqual(t.rows('SELECT timer_id FROM active_timers'), [{ timer_id: elsewhere.timer_id }]);
});

test('race: members.setAdmin refuses a target whose account was changed to a User between the read and the write', () => {
  const t = createActEnv();
  before(t, () => t.env.turso.db.exec(`UPDATE accounts SET role = 'USER' WHERE id = '${t.ids.admin2}'`));
  failed(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }), 'FORBIDDEN');
  assert.equal(member(t, 'w1', 'admin2').ws_role, 'MEMBER');
});

test('race: members.setAdmin refuses a target who was removed between the read and the write', () => {
  const t = createActEnv();
  before(t, () => t.env.turso.db.exec(`UPDATE workspace_members SET active = 0 WHERE workspace_id = '${t.ids.w1}' AND user_id = '${t.ids.admin2}'`));
  failed(setAdmin(t, { userId: t.ids.admin2, isAdmin: true }), 'NOT_FOUND');
});

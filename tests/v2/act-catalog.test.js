'use strict';

// T2.2 — ActCatalog.gs: clients.*, projects.* (with the per-project `restricted` rule of section 6.3), tasks.* and
// projectAccess.set, and the field allowlists that keep money away from everyone who is not a workspace admin.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createActEnv, ok, failed } = require('./helpers/act');

const W3 = '00000000-0000-4000-8000-0000000000a3';
const MONEY = /rate|cost|budget|estimate|amount|money|minor/i;

function other(t) {                                    // an active workspace the workspace admin of W1 does not belong to
  t.insert('workspaces', { id: W3, code: 'W3', name: 'Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 2, updated_at: 2, version: 1 });
  t.insert('clients', { id: '00000000-0000-4000-8000-0000000000c3', workspace_id: W3, name: 'Elsewhere Ltd', status: 'ACTIVE', notes: null, created_at: 1, updated_at: 1, version: 1 });
  t.insert('projects', { id: '00000000-0000-4000-8000-0000000000d3', workspace_id: W3, client_id: null, name: 'Elsewhere project', code: null, status: 'ACTIVE', restricted: 0, billable_default: 1,
    hourly_rate_minor: null, cost_rate_minor: null, estimate_minutes: null, budget_minor: null, start_date: null, end_date: null, color: null, created_at: 1, updated_at: 1, version: 1 });
  t.insert('tasks', { id: '00000000-0000-4000-8000-0000000000e3', workspace_id: W3, project_id: '00000000-0000-4000-8000-0000000000d3', name: 'Elsewhere task', status: 'ACTIVE',
    estimate_minutes: null, billable_default: null, sort_order: 0, created_at: 1, updated_at: 1, version: 1 });
  return { client: '00000000-0000-4000-8000-0000000000c3', project: '00000000-0000-4000-8000-0000000000d3', task: '00000000-0000-4000-8000-0000000000e3' };
}
const audits = (t, action) => t.rows(`SELECT * FROM audit_log WHERE action = '${action}' ORDER BY seq`);
const wa = (t, action, payload, opts = {}) => t.call('admin1', action, payload, { ws: t.ids.w1, ...opts });
const genWs = t => t.env.run(`Cache.gen_(Cache.genWs_('${t.ids.w1}'))`);

// ---------------------------------------------------------------- clients

function addClient(t, name = 'Acme', notes = 'big') {
  return ok(wa(t, 'clients.create', { name, notes })).client;
}

test('clients.create: a full client for the workspace admin, an audit row, and the catalog generation moves', () => {
  const t = createActEnv();
  const gen = genWs(t);
  const client = addClient(t);
  assert.deepEqual(client, { id: client.id, name: 'Acme', status: 'ACTIVE', notes: 'big', version: 1 });
  assert.deepEqual(t.one(`SELECT workspace_id, name, status, notes, version, created_at FROM clients WHERE id = '${client.id}'`),
    { workspace_id: t.ids.w1, name: 'Acme', status: 'ACTIVE', notes: 'big', version: 1, created_at: t.env.fakes.clock.now() });
  const [audit] = audits(t, 'CLIENT_CREATED');
  assert.deepEqual([audit.actor_user_id, audit.entity_type, audit.entity_id, audit.workspace_id], [t.ids.admin1, 'CLIENT', client.id, t.ids.w1]);
  assert.deepEqual(JSON.parse(audit.after_json), { name: 'Acme', notes: 'big' });
  assert.equal(genWs(t), gen + 1);
});

test('clients.create: a duplicate name is CONFLICT in that workspace only; a retry returns the same client once', () => {
  const t = createActEnv();
  other(t);
  const requestId = '66666666-6666-4666-8666-666666666666';
  const first = ok(wa(t, 'clients.create', { name: 'Acme' }, { requestId }));
  failed(wa(t, 'clients.create', { name: 'Acme' }), 'CONFLICT');
  assert.deepEqual(ok(wa(t, 'clients.create', { name: 'Acme' }, { requestId })), first);
  assert.equal(t.rows("SELECT * FROM clients WHERE name = 'Acme'").length, 1);
  assert.equal(audits(t, 'CLIENT_CREATED').length, 1);
  ok(t.call('sa', 'clients.create', { name: 'Elsewhere Ltd' }, { ws: t.ids.w1 }));            // the name exists in W3, not here
});

test('clients.create: a plain member and a User are refused, so is an archived workspace; bad names are VALIDATION', () => {
  const t = createActEnv();
  failed(t.call('admin2', 'clients.create', { name: 'x' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  failed(t.call('user1', 'clients.create', { name: 'x' }, { ws: t.ids.w1 }), 'FORBIDDEN');
  failed(t.call('admin1', 'clients.create', { name: 'x' }, { ws: t.ids.w2 }), 'FORBIDDEN');
  for (const name of ['', '   ', 'a'.repeat(121), 'tab\there']) assert.equal(failed(wa(t, 'clients.create', { name }), 'VALIDATION').details.field, 'name');
  assert.equal(t.rows('SELECT * FROM clients').length, 0);
});

test('clients.list: a workspace admin sees all with notes and versions; anyone else only active ones, id name status', () => {
  const t = createActEnv();
  const a = addClient(t, 'Acme', 'secret note');
  const b = addClient(t, 'Beta', null);
  ok(wa(t, 'clients.archive', { id: b.id, version: 1 }));
  const admin = ok(wa(t, 'clients.list')).clients;
  assert.deepEqual(admin.map(c => [c.name, c.status, c.version]), [['Acme', 'ACTIVE', 1], ['Beta', 'ARCHIVED', 2]]);
  assert.equal(admin[0].notes, 'secret note');
  for (const persona of ['user1', 'admin2']) {
    const rows = ok(t.call(persona, 'clients.list', {}, { ws: t.ids.w1 })).clients;
    assert.deepEqual(rows, [{ id: a.id, name: 'Acme', status: 'ACTIVE' }], persona);
  }
});

test('clients.update: changes only what is sent, null clears the notes, the version moves, before and after are audited', () => {
  const t = createActEnv();
  const c = addClient(t);
  const renamed = ok(wa(t, 'clients.update', { id: c.id, version: 1, name: 'Acme Corp' })).client;
  assert.deepEqual(renamed, { id: c.id, name: 'Acme Corp', status: 'ACTIVE', notes: 'big', version: 2 });
  assert.equal(ok(wa(t, 'clients.update', { id: c.id, version: 2, name: 'Acme Corp', notes: null })).client.notes, null);
  const [first] = audits(t, 'CLIENT_UPDATED');
  assert.deepEqual([JSON.parse(first.before_json), JSON.parse(first.after_json)], [{ name: 'Acme' }, { name: 'Acme Corp' }]);
});

test('clients.update: a stale version is CONFLICT, a taken name is CONFLICT, and another workspace\'s client is NOT_FOUND', () => {
  const t = createActEnv();
  const ids = other(t);
  const a = addClient(t, 'Acme');
  addClient(t, 'Beta');
  failed(wa(t, 'clients.update', { id: a.id, version: 9, name: 'Acme' }), 'CONFLICT');
  failed(wa(t, 'clients.update', { id: a.id, version: 1, name: 'Beta' }), 'CONFLICT');
  failed(wa(t, 'clients.update', { id: ids.client, version: 1, name: 'Hijacked' }), 'NOT_FOUND');
  failed(wa(t, 'clients.update', { id: '00000000-0000-4000-8000-0000000000ff', version: 1, name: 'x' }), 'NOT_FOUND');
  assert.equal(t.one(`SELECT name FROM clients WHERE id = '${ids.client}'`).name, 'Elsewhere Ltd');
  assert.equal(t.one(`SELECT name, version FROM clients WHERE id = '${a.id}'`).version, 1);
});

test('clients.archive: archives once; again is CONFLICT; a stale version is CONFLICT; another workspace is NOT_FOUND', () => {
  const t = createActEnv();
  const ids = other(t);
  const c = addClient(t);
  failed(wa(t, 'clients.archive', { id: c.id, version: 5 }), 'CONFLICT');
  assert.deepEqual(ok(wa(t, 'clients.archive', { id: c.id, version: 1 })), { id: c.id, status: 'ARCHIVED', version: 2 });
  failed(wa(t, 'clients.archive', { id: c.id, version: 2 }), 'CONFLICT');
  failed(wa(t, 'clients.archive', { id: ids.client, version: 1 }), 'NOT_FOUND');
  assert.equal(t.one(`SELECT status FROM clients WHERE id = '${ids.client}'`).status, 'ACTIVE');
  assert.equal(audits(t, 'CLIENT_ARCHIVED').length, 1);
});

// ---------------------------------------------------------------- projects

const proj = (t, payload = {}, opts) => ok(wa(t, 'projects.create', { name: 'Apollo', ...payload }, opts)).project;

test('projects.create: defaults are unrestricted and billable; a workspace admin gets every field back', () => {
  const t = createActEnv();
  const p = proj(t);
  assert.deepEqual(p, { id: p.id, clientId: null, name: 'Apollo', code: null, billableDefault: true, color: null, status: 'ACTIVE', restricted: false,
    hourlyRateMinor: null, costRateMinor: null, estimateMinutes: null, budgetMinor: null, startDate: null, endDate: null, version: 1 });
  const row = t.one(`SELECT restricted, billable_default FROM projects WHERE id = '${p.id}'`);
  assert.deepEqual(row, { restricted: 0, billable_default: 1 });
});

test('projects.create: every field is stored, with the client checked, and the audit row holds what was set', () => {
  const t = createActEnv();
  const client = addClient(t);
  const p = proj(t, { code: 'APO', clientId: client.id, restricted: true, billableDefault: false, hourlyRateMinor: 50000, costRateMinor: 20000,
    estimateMinutes: 600, budgetMinor: 900000, startDate: '2026-01-01', endDate: '2026-12-31', color: '#336699' });
  assert.deepEqual([p.code, p.clientId, p.restricted, p.billableDefault, p.hourlyRateMinor, p.costRateMinor, p.estimateMinutes, p.budgetMinor, p.startDate, p.endDate, p.color],
    ['APO', client.id, true, false, 50000, 20000, 600, 900000, '2026-01-01', '2026-12-31', '#336699']);
  const row = t.one(`SELECT * FROM projects WHERE id = '${p.id}'`);
  assert.deepEqual([row.restricted, row.billable_default, row.hourly_rate_minor, row.client_id], [1, 0, 50000, client.id]);
  const [audit] = audits(t, 'PROJECT_CREATED');
  assert.equal(JSON.parse(audit.after_json).hourly_rate_minor, 50000);
});

test('projects.create: a client from another workspace or an archived one is NOT_FOUND; a duplicate name is CONFLICT', () => {
  const t = createActEnv();
  const ids = other(t);
  const client = addClient(t);
  ok(wa(t, 'clients.archive', { id: client.id, version: 1 }));
  failed(wa(t, 'projects.create', { name: 'A', clientId: ids.client }), 'NOT_FOUND');
  failed(wa(t, 'projects.create', { name: 'B', clientId: client.id }), 'NOT_FOUND');
  proj(t);
  failed(wa(t, 'projects.create', { name: 'Apollo' }), 'CONFLICT');
  assert.equal(t.rows('SELECT * FROM projects').length, 5, 'the seed has 3, W3 has 1, and one was added');
});

test('projects.create: a bad money amount, date order, code or colour is VALIDATION naming the field', () => {
  const t = createActEnv();
  const cases = [['hourlyRateMinor', -1], ['hourlyRateMinor', 1.5], ['budgetMinor', 'lots'], ['startDate', '2026-02-30'], ['code', 'lower'],
    ['color', ''], ['restricted', 'yes'], ['estimateMinutes', -5]];
  for (const [field, value] of cases) assert.equal(failed(wa(t, 'projects.create', { name: 'X', [field]: value }), 'VALIDATION').details.field, field, field);
  assert.equal(failed(wa(t, 'projects.create', { name: 'X', startDate: '2026-05-01', endDate: '2026-04-01' }), 'VALIDATION').details.field, 'endDate');
});

test('projects.update: changes what is sent, null clears a rate, a flag cannot be cleared, the version moves', () => {
  const t = createActEnv();
  const p = proj(t, { hourlyRateMinor: 100, costRateMinor: 50, restricted: true });
  const u = ok(wa(t, 'projects.update', { id: p.id, version: 1, name: 'Apollo 2', hourlyRateMinor: null, restricted: false })).project;
  assert.deepEqual([u.name, u.hourlyRateMinor, u.costRateMinor, u.restricted, u.version], ['Apollo 2', null, 50, false, 2]);
  assert.equal(failed(wa(t, 'projects.update', { id: p.id, version: 2, name: 'Apollo 2', restricted: null }), 'VALIDATION').details.field, 'restricted');
  const [audit] = audits(t, 'PROJECT_UPDATED');
  assert.deepEqual(JSON.parse(audit.before_json), { name: 'Apollo', hourly_rate_minor: 100, restricted: 1 });
});

test('projects.update: the end date is checked against the start date that is already stored', () => {
  const t = createActEnv();
  const p = proj(t, { startDate: '2026-05-01' });
  assert.equal(failed(wa(t, 'projects.update', { id: p.id, version: 1, name: 'Apollo', endDate: '2026-04-01' }), 'VALIDATION').details.field, 'endDate');
  ok(wa(t, 'projects.update', { id: p.id, version: 1, name: 'Apollo', endDate: '2026-06-01' }));
});

test('projects.update: a stale version, a duplicate name, a bad client and another workspace\'s project', () => {
  const t = createActEnv();
  const ids = other(t);
  const a = proj(t);
  proj(t, { name: 'Beta' });
  failed(wa(t, 'projects.update', { id: a.id, version: 7, name: 'Apollo' }), 'CONFLICT');
  failed(wa(t, 'projects.update', { id: a.id, version: 1, name: 'Beta' }), 'CONFLICT');
  failed(wa(t, 'projects.update', { id: a.id, version: 1, name: 'Apollo', clientId: ids.client }), 'NOT_FOUND');
  failed(wa(t, 'projects.update', { id: ids.project, version: 1, name: 'Hijacked' }), 'NOT_FOUND');
  assert.equal(t.one(`SELECT name FROM projects WHERE id = '${ids.project}'`).name, 'Elsewhere project');
});

test('projects.archive: archives, and nothing already tracked changes (a running timer and old entries keep their project)', () => {
  const t = createActEnv();
  assert.deepEqual(ok(wa(t, 'projects.archive', { id: t.ids.open, version: 1 })), { id: t.ids.open, status: 'ARCHIVED', version: 2 });
  failed(wa(t, 'projects.archive', { id: t.ids.open, version: 2 }), 'CONFLICT');
  assert.equal(ok(wa(t, 'projects.list')).projects.find(p => p.id === t.ids.open).status, 'ARCHIVED');
  assert.equal(ok(t.call('user1', 'projects.list', {}, { ws: t.ids.w1 })).projects.some(p => p.id === t.ids.open), false, 'users no longer see it');
});

test('projects.list for a workspace admin: every project, all the money, and who may track the restricted ones', () => {
  const t = createActEnv();
  const list = ok(wa(t, 'projects.list')).projects;
  assert.deepEqual(list.map(p => p.name), ['Project locked', 'Project open']);
  const open = list.find(p => p.id === t.ids.open);
  assert.deepEqual([open.hourlyRateMinor, open.costRateMinor, open.budgetMinor, open.restricted], [50000, 20000, 9000000, false]);
  assert.deepEqual(list.find(p => p.id === t.ids.locked).access, [{ userId: t.ids.user1, canTrack: true }]);
  assert.deepEqual(open.access, []);
});

test('projects.list for everyone else: only the active projects they may track (6.3), with exactly the allowlisted fields and no money', () => {
  const t = createActEnv();
  const names = persona => ok(t.call(persona, 'projects.list', {}, { ws: t.ids.w1 })).projects.map(p => p.name);
  assert.deepEqual(names('user1'), ['Project locked', 'Project open'], 'user1 has an access row for the restricted project');
  assert.deepEqual(names('user2'), ['Project open'], 'a restricted project is hidden from a User with no access row');
  assert.deepEqual(names('admin2'), ['Project locked', 'Project open'], 'Admins are never restricted');
  assert.deepEqual(names('sa'), ['Project locked', 'Project open'].sort(), 'nor Super Admins');
  for (const persona of ['user1', 'user2', 'admin2']) {
    const projects = ok(t.call(persona, 'projects.list', {}, { ws: t.ids.w1 })).projects;
    for (const project of projects) assert.deepEqual(Object.keys(project).sort(), ['billableDefault', 'clientId', 'code', 'color', 'id', 'name']);
    assert.ok(!MONEY.test(JSON.stringify(projects)), `${persona} was sent a money field`);
  }
});

test('projects.list: a can_track = 0 row does not grant access, and archived projects are not listed', () => {
  const t = createActEnv();
  t.env.turso.db.exec(`UPDATE project_access SET can_track = 0 WHERE user_id = '${t.ids.user1}'`);
  assert.deepEqual(ok(t.call('user1', 'projects.list', {}, { ws: t.ids.w1 })).projects.map(p => p.name), ['Project open']);
});

// ---------------------------------------------------------------- tasks

const task = (t, projectId, name = 'Design', extra = {}) => ok(wa(t, 'tasks.create', { projectId, name, ...extra })).task;

test('tasks.create: a task under an active project of this workspace, with defaults; audited', () => {
  const t = createActEnv();
  const k = task(t, t.ids.open, 'Design', { estimateMinutes: 90, billableDefault: false, sortOrder: 3 });
  assert.deepEqual(k, { id: k.id, projectId: t.ids.open, name: 'Design', billableDefault: false, sortOrder: 3, status: 'ACTIVE', estimateMinutes: 90, version: 1 });
  const plainTask = task(t, t.ids.open, 'Review');
  assert.deepEqual([plainTask.billableDefault, plainTask.sortOrder, plainTask.estimateMinutes], [null, 0, null]);
  assert.equal(audits(t, 'TASK_CREATED').length, 2);
});

test('tasks.create: another workspace\'s or an archived project is NOT_FOUND; a duplicate name is CONFLICT within the project only', () => {
  const t = createActEnv();
  const ids = other(t);
  failed(wa(t, 'tasks.create', { projectId: ids.project, name: 'x' }), 'NOT_FOUND');
  ok(wa(t, 'projects.archive', { id: t.ids.locked, version: 1 }));
  failed(wa(t, 'tasks.create', { projectId: t.ids.locked, name: 'x' }), 'NOT_FOUND');
  task(t, t.ids.open, 'Design');
  failed(wa(t, 'tasks.create', { projectId: t.ids.open, name: 'Design' }), 'CONFLICT');
  assert.equal(t.rows('SELECT * FROM tasks').length, 3, 'the seed task, one in W3, and the new one');
});

test('tasks.update: partial changes, a null estimate clears, a project cannot be changed, stale and foreign ids are refused', () => {
  const t = createActEnv();
  const ids = other(t);
  const k = task(t, t.ids.open, 'Design', { estimateMinutes: 30, sortOrder: 2 });
  const u = ok(wa(t, 'tasks.update', { id: k.id, version: 1, name: 'Design v2', estimateMinutes: null, sortOrder: 0 })).task;
  assert.deepEqual([u.name, u.estimateMinutes, u.sortOrder, u.projectId, u.version], ['Design v2', null, 0, t.ids.open, 2]);
  assert.equal(failed(wa(t, 'tasks.update', { id: k.id, version: 2, name: 'x', projectId: t.ids.locked }), 'VALIDATION').details.field, 'projectId');
  assert.equal(ok(wa(t, 'tasks.update', { id: k.id, version: 2, name: 'Design v2', sortOrder: null })).task.sortOrder, 0, 'clearing the order puts it back to 0');
  failed(wa(t, 'tasks.update', { id: k.id, version: 1, name: 'late' }), 'CONFLICT');
  failed(wa(t, 'tasks.update', { id: ids.task, version: 1, name: 'Hijacked' }), 'NOT_FOUND');
});

test('tasks.archive: archives once; foreign ids are NOT_FOUND', () => {
  const t = createActEnv();
  const ids = other(t);
  ok(wa(t, 'tasks.archive', { id: t.ids.task, version: 1 }));
  failed(wa(t, 'tasks.archive', { id: t.ids.task, version: 2 }), 'CONFLICT');
  failed(wa(t, 'tasks.archive', { id: ids.task, version: 1 }), 'NOT_FOUND');
});

test('tasks.list: a workspace admin sees every task; anyone else the active tasks of projects they may track, id name sort only', () => {
  const t = createActEnv();
  const hidden = task(t, t.ids.locked, 'Secret work');
  const archived = task(t, t.ids.open, 'Old');
  ok(wa(t, 'tasks.archive', { id: archived.id, version: 1 }));
  assert.deepEqual(ok(wa(t, 'tasks.list')).tasks.map(k => k.name).sort(), ['Old', 'Secret work', 'Task one']);
  assert.deepEqual(ok(t.call('user2', 'tasks.list', {}, { ws: t.ids.w1 })).tasks.map(k => k.name), ['Task one']);
  assert.deepEqual(ok(t.call('user1', 'tasks.list', {}, { ws: t.ids.w1 })).tasks.map(k => k.name).sort(), ['Secret work', 'Task one']);
  const user = ok(t.call('user2', 'tasks.list', {}, { ws: t.ids.w1 })).tasks[0];
  assert.deepEqual(Object.keys(user).sort(), ['billableDefault', 'id', 'name', 'projectId', 'sortOrder']);
  assert.deepEqual(ok(wa(t, 'tasks.list', { projectId: t.ids.locked })).tasks.map(k => k.id), [hidden.id]);
  assert.deepEqual(ok(t.call('user2', 'tasks.list', { projectId: t.ids.locked }, { ws: t.ids.w1 })).tasks, []);
});

// ---------------------------------------------------------------- project access

const setAccess = (t, payload, persona = 'admin1', opts = {}) => t.call(persona, 'projectAccess.set', payload, { ws: t.ids.w1, ...opts });

test('projectAccess.set: grants a user a restricted project, who then sees it and its tasks; the audit row says before and after', () => {
  const t = createActEnv();
  assert.deepEqual(ok(t.call('user2', 'projects.list', {}, { ws: t.ids.w1 })).projects.map(p => p.name), ['Project open']);
  assert.deepEqual(ok(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true })), { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true });
  assert.deepEqual(ok(t.call('user2', 'projects.list', {}, { ws: t.ids.w1 })).projects.map(p => p.name), ['Project locked', 'Project open']);
  const [grant] = audits(t, 'PROJECT_ACCESS_SET');
  assert.deepEqual([grant.before_json, JSON.parse(grant.after_json), grant.entity_id], [null, { canTrack: true }, `${t.ids.locked}:${t.ids.user2}`]);
  ok(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: false }));
  assert.deepEqual(ok(t.call('user2', 'projects.list', {}, { ws: t.ids.w1 })).projects.map(p => p.name), ['Project open']);
  assert.equal(t.rows("SELECT * FROM project_access WHERE user_id = '" + t.ids.user2 + "'").length, 1, 'one row, updated');
  assert.deepEqual(JSON.parse(audits(t, 'PROJECT_ACCESS_SET')[1].before_json), { canTrack: true });
});

test('projectAccess.set: the project must be in this workspace and the user an active member of it', () => {
  const t = createActEnv();
  const ids = other(t);
  failed(setAccess(t, { projectId: ids.project, userId: t.ids.user1, canTrack: true }), 'NOT_FOUND');
  failed(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user4, canTrack: true }), 'NOT_FOUND');
  failed(setAccess(t, { projectId: t.ids.locked, userId: t.ids.gone, canTrack: true }), 'NOT_FOUND');
  failed(setAccess(t, { projectId: '00000000-0000-4000-8000-0000000000ff', userId: t.ids.user1, canTrack: true }), 'NOT_FOUND');
  assert.equal(t.rows('SELECT * FROM project_access').length, 1);
});

test('projectAccess.set: workspace admins only, a retry is stored once, an archived workspace takes none', () => {
  const t = createActEnv();
  failed(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true }, 'admin2'), 'FORBIDDEN');
  failed(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true }, 'user1'), 'FORBIDDEN');
  const requestId = '77777777-7777-4777-8777-777777777777';
  const first = ok(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true }, 'admin1', { requestId }));
  assert.deepEqual(ok(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user2, canTrack: true }, 'admin1', { requestId })), first);
  assert.equal(audits(t, 'PROJECT_ACCESS_SET').length, 1);
  failed(t.call('admin1', 'projectAccess.set', { projectId: t.ids.archivedProject, userId: t.ids.user4, canTrack: true }, { ws: t.ids.w2 }), 'FORBIDDEN');
});

// ---------------------------------------------------------------- races and the archived workspace

test('race: a write to a workspace archived after the cache was filled is refused by the transaction', () => {
  const t = createActEnv();
  ok(wa(t, 'clients.list'));                                                   // the caller's account is cached with W1 active
  t.env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${t.ids.w1}'`);
  const response = failed(wa(t, 'clients.create', { name: 'Late' }), 'FORBIDDEN');
  assert.match(response.message, /archived/i);
  assert.equal(t.rows('SELECT * FROM clients').length, 0);
});

test('race: a version that moved between the read and the write is CONFLICT in every update and archive', () => {
  const t = createActEnv();
  const c = addClient(t);
  const k = task(t, t.ids.open);
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) {
      t.env.turso.db.exec('UPDATE clients SET version = version + 1; UPDATE projects SET version = version + 1; UPDATE tasks SET version = version + 1');
    }
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(wa(t, 'clients.update', { id: c.id, version: 1, name: 'x' }), 'CONFLICT');
  failed(wa(t, 'clients.archive', { id: c.id, version: 2 }), 'CONFLICT');
  failed(wa(t, 'projects.update', { id: t.ids.open, version: 1, name: 'x' }), 'CONFLICT');
  failed(wa(t, 'tasks.update', { id: k.id, version: 1, name: 'x' }), 'CONFLICT');
  failed(wa(t, 'tasks.archive', { id: k.id, version: 1 }), 'CONFLICT');
});

test('race: a project archived or a member removed between the read and the write fails the transaction', () => {
  const t = createActEnv();
  t.env.fakes.fetch.route(t.env.origin + '/', request => {
    if (request.payload.includes('BEGIN IMMEDIATE')) {
      t.env.turso.db.exec(`UPDATE projects SET status = 'ARCHIVED' WHERE id = '${t.ids.open}'; UPDATE workspace_members SET active = 0 WHERE user_id = '${t.ids.user3}'`);
    }
    return t.env.turso.handleHttp(request);
  }, { first: true });
  failed(wa(t, 'tasks.create', { projectId: t.ids.open, name: 'x' }), 'NOT_FOUND');
  failed(setAccess(t, { projectId: t.ids.locked, userId: t.ids.user3, canTrack: true }), 'NOT_FOUND');
});

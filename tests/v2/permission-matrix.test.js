'use strict';

// T1.9 — the permission matrix. Every action of BUILD_SPEC section 6.2 is run through the real request pipeline as
// each of five callers, in the caller's own workspace and in a workspace they do not belong to, and the outcome is
// compared with an expected allow/deny table WRITTEN HERE BY HAND from section 6.2, not generated from ACTIONS. An
// action added to ACTIONS without a row below fails; so does a row for an action that no longer exists.
//
// What the pipeline decides is the account role, the workspace (membership, workspace admin, archived) and whether a
// grant or a fresh step-up is needed. What it cannot decide is whose RECORD is touched: that needs the payload and the
// database, so "own", "other user" and "other workspace's record" are enforced inside the handlers (assert steps) and
// tested with each handler (IDOR tests in T2.4, T2.5, T3.4). The `handlerNeeds` column records the checks a handler
// adds on top of the pipeline's: a grant when scope = workspace, a step-up when someone else's entry is edited.
//
// The five callers, in this order in every pattern string:
//   U  a User who is a member of W1          (user1)
//   A  an Admin who is a member of nothing   (admin3)
//   M  an Admin who is a plain member of W1  (admin2)
//   W  the workspace admin of W1             (admin1)
//   S  a Super Admin, not a member           (sa)
// Y = the request reaches the handler, N = FORBIDDEN. "home" is W1, "other" is W3, a workspace none of them belongs
// to, "none" sends no workspace (only for ws: 'optional').

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEnv } = require('./helpers/env');
const { seedWorld, signIn, insert } = require('./helpers/seed');
const { readFilesJson } = require('./helpers/load-app');

const TOKEN = 'cd'.repeat(64);
const W3 = '00000000-0000-4000-8000-0000000000a3';

// ---------------------------------------------------------------- the expected table

const MEMBER = { home: 'YNYYY', other: 'NNNNY' };      // any member of the workspace, Super Admin from anywhere
const WA = { home: 'NNNYY', other: 'NNNNY' };          // workspace admins and Super Admins
const SA_WS = { home: 'NNNNY', other: 'NNNNY' };       // Super Admin only, about a workspace
const ANY = { home: 'YYYYY' };                         // every signed-in account, no workspace
const STAFF = { home: 'NYYYY' };                       // Admins and Super Admins, no workspace
const SA_ONLY = { home: 'NNNNY' };                     // Super Admin only, no workspace

// pattern, is it a write, what the PIPELINE requires ('' | 'grant' | 'stepup'), what the HANDLER adds ('' | 'grant' | 'stepup')
const row = (pattern, write, needs = '', handlerNeeds = '') => ({ ...pattern, write, needs, handlerNeeds });

const EXPECTED = {
  // session and admin codes
  'app.bootstrap': row({ none: 'YYYYY', home: 'YNYYY', other: 'NNNNY' }, false),
  'auth.status': row(STAFF, false),
  'auth.verifyCode': row(STAFF, true),
  'auth.stepUp': row(STAFF, true, 'grant'),
  'auth.logout': row(STAFF, true, 'grant'),
  'auth.enrollStart': row(STAFF, true),          // its own proof: an enrollment code or an ENROLL grant, checked in the handler
  'auth.enrollConfirm': row(STAFF, true),
  'auth.useBackupCode': row(STAFF, true),

  // timer: own only
  'timer.start': row(MEMBER, true),
  'timer.stop': row(MEMBER, true),
  'timer.switch': row(MEMBER, true),

  // entries: own, or a workspace admin for others
  'entries.list': row(MEMBER, false, '', 'grant'),       // a grant when it reads someone else's entries
  'entries.update': row(MEMBER, true, '', 'stepup'),     // a step-up when it edits someone else's entry
  'entries.delete': row(MEMBER, true, '', 'stepup'),
  'entries.bulk': row(MEMBER, true),

  // catalogue: every member reads, workspace admins write
  'clients.list': row(MEMBER, false),
  'clients.create': row(WA, true, 'grant'),
  'clients.update': row(WA, true, 'grant'),
  'clients.archive': row(WA, true, 'grant'),
  'projects.list': row(MEMBER, false),
  'projects.create': row(WA, true, 'grant'),
  'projects.update': row(WA, true, 'grant'),
  'projects.archive': row(WA, true, 'grant'),
  'tasks.list': row(MEMBER, false),
  'tasks.create': row(WA, true, 'grant'),
  'tasks.update': row(WA, true, 'grant'),
  'tasks.archive': row(WA, true, 'grant'),
  'projectAccess.set': row(WA, true, 'grant'),
  'tags.list': row(MEMBER, false),
  'tags.create': row(WA, true, 'grant'),
  'tags.update': row(WA, true, 'grant'),
  'tags.archive': row(WA, true, 'grant'),

  // workspaces and members
  'workspaces.list': row(ANY, false),
  'workspaces.create': row(SA_ONLY, true, 'stepup'),
  'workspaces.update': row(SA_WS, true, 'stepup'),
  'workspaces.archive': row(SA_WS, true, 'stepup'),
  'members.list': row(WA, false, 'grant'),
  'members.add': row(WA, true, 'grant', 'stepup'),       // a step-up when the caller is a Super Admin
  'members.update': row(WA, true, 'grant', 'stepup'),
  'members.remove': row(WA, true, 'grant', 'stepup'),
  'members.setAdmin': row(SA_WS, true, 'stepup'),

  // users: Super Admin only, every write with a step-up
  'users.list': row(SA_ONLY, false, 'grant'),
  'users.create': row(SA_ONLY, true, 'stepup'),
  'users.update': row(SA_ONLY, true, 'stepup'),
  'users.setAdminLimit': row(SA_ONLY, true, 'stepup'),
  'users.deactivate': row(SA_ONLY, true, 'stepup'),
  'users.activate': row(SA_ONLY, true, 'stepup'),
  'users.unlock': row(SA_ONLY, true, 'stepup'),
  'users.revokeGrants': row(SA_ONLY, true, 'stepup'),
  'users.issueEnrollCode': row(SA_ONLY, true, 'stepup'),

  // reports and live view
  'reports.summary': row(MEMBER, false, '', 'grant'),    // a grant when scope = workspace
  'reports.detailed': row(MEMBER, false, '', 'grant'),
  'reports.exportCsv': row(WA, false, 'grant', 'stepup'), // a step-up for the first page
  'live.list': row(WA, false, 'grant'),

  // settings, audit and health: Super Admin
  'settings.get': row(SA_ONLY, false, 'grant'),
  'settings.patch': row(SA_ONLY, true, 'stepup'),
  'audit.list': row(SA_ONLY, false, 'grant'),
  'audit.verify': row(SA_ONLY, false, 'stepup'),
  'security.events': row(SA_ONLY, false, 'grant'),
  'system.health': row(SA_ONLY, false, 'grant'),
};

// Which file holds each group of actions (BUILD_SPEC section 2); a group that shares a file puts its name in the
// handler's name: ActCatalog.clientsCreate_, ActWorkspaces.membersAdd_, ActSystem.authStatus_.
const MODULES = {
  timer: ['ActTimer', false], entries: ['ActEntries', false], reports: ['ActReports', false], users: ['ActUsers', false],
  clients: ['ActCatalog', true], projects: ['ActCatalog', true], tasks: ['ActCatalog', true],
  projectAccess: ['ActCatalog', true], tags: ['ActCatalog', true],
  workspaces: ['ActWorkspaces', true], members: ['ActWorkspaces', true],
  app: ['ActSystem', true], auth: ['ActSystem', true], live: ['ActSystem', true], settings: ['ActSystem', true],
  audit: ['ActSystem', true], security: ['ActSystem', true], system: ['ActSystem', true],
};
const expectedHandler = action => {
  const [group, verb] = action.split('.');
  const [module, shared] = MODULES[group];
  return `${module}.${shared ? group + verb[0].toUpperCase() + verb.slice(1) : verb}_`;
};

// ---------------------------------------------------------------- the world

const PERSONAS = ['user1', 'admin3', 'admin2', 'admin1', 'sa'];

// A value of each schema type that passes, for the required fields (the optional ones are left out).
function sampleValue(type, now) {
  const [kind, ...args] = type.replace(/\?$/, '').split(':');
  switch (kind) {
    case 'id': return '00000000-0000-4000-8000-0000000000b1';
    case 'ids': return [];
    case 'text': return 'a'.repeat(Math.max(Number(args[0]), 1));
    case 'code': return 'ABC';
    case 'email': return 'someone@flink.test';
    case 'bool': return true;
    case 'int': return Number(args[0]);
    case 'ms': return now;
    case 'date': return '2026-11-05';
    case 'enum': return args.join(':').split('|')[0];
    case 'tz': return 'Africa/Cairo';
    case 'cursor': return 'c';
    case 'any': return true;
    default: throw new Error(`no sample for schema type ${kind}`);
  }
}
function samplePayload(schema, now) {
  const payload = {};
  for (const [field, type] of Object.entries(schema)) if (!type.endsWith('?')) payload[field] = sampleValue(type, now);
  return payload;
}

// One app with the real ACTIONS, every handler replaced by a recorder, and a Grants.check_ that accepts any token with
// a fresh step-up, so that the grant never gets in the way of the role and workspace rules under test.
function setup() {
  const env = createEnv();
  const world = seedWorld(env);
  insert(env.turso.db, 'workspaces', {
    id: W3, code: 'W3', name: 'Workspace Three', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN',
    created_at: 1, updated_at: 1, version: 1,
  });
  const actions = env.ctx.__plain(env.ctx.ACTIONS);                // before the handlers are replaced
  env.run(`
    var Probe = { calls: [], stepupAt: ${env.fakes.clock.now()}, handler_: function (ctx) { Probe.calls.push(ctx.action); return { ok: 1 }; } };
    Grants.check_ = function () { return { kind: 'ADMIN', stepupAt: Probe.stepupAt }; };
    Object.keys(ACTIONS).forEach(function (name) { ACTIONS[name].handler = 'Probe.handler_'; });`);
  return { env, world, actions };
}

function request(env, world, action, entry, persona, scope, extra = {}) {
  const now = env.fakes.clock.now();
  const envelope = { v: 1, payload: samplePayload(entry.schema, now), grant: TOKEN, ...extra };
  if (entry.write) envelope.requestId = crypto.randomUUID();
  if (entry.ws !== false && scope === 'home') envelope.workspaceId = world.ids.w1;
  if (entry.ws !== false && scope === 'other') envelope.workspaceId = W3;
  signIn(env, world.emails[persona]);
  return env.ctx.__plain(env.ctx.handleClientRequest(action, envelope));
}

function outcome(response, label) {
  if (response.ok) return 'Y';
  assert.equal(response.code, 'FORBIDDEN', `${label}: expected the request to pass or be FORBIDDEN, got ${response.code}: ${response.message} ${JSON.stringify(response.details)}`);
  return 'N';
}

// ---------------------------------------------------------------- the table covers exactly the actions

test('every action in ACTIONS has a row in the expected table, and every row has an action', () => {
  const { actions } = setup();
  const defined = Object.keys(actions).sort();
  const expected = Object.keys(EXPECTED).sort();
  assert.deepEqual(defined.filter(name => !expected.includes(name)), [], 'actions with no expected row: add them to EXPECTED');
  assert.deepEqual(expected.filter(name => !defined.includes(name)), [], 'expected rows for actions that do not exist');
  assert.equal(defined.length, 60, 'section 6.2 lists 60 actions');
});

// ---------------------------------------------------------------- the matrix

for (const action of Object.keys(EXPECTED)) {
  test(`matrix: ${action}`, () => {
    const { env, world, actions } = setup();
    const entry = actions[action];
    assert.ok(entry, `${action} is not in ACTIONS`);
    const expected = EXPECTED[action];
    const scopes = ['home', 'other', 'none'].filter(scope => expected[scope] !== undefined);

    for (const scope of scopes) {
      const actual = PERSONAS.map(persona => outcome(
        request(env, world, action, entry, persona, scope),
        `${action} ${scope} ${persona}`)).join('');
      assert.equal(actual, expected[scope], `${action} in "${scope}" for [User, Admin non-member, Admin member, workspace admin, Super Admin]`);
    }
    // a workspace action cannot be called without saying which workspace (only ws: 'optional' can)
    if (expected.other !== undefined && expected.none === undefined) {
      const missing = request(env, world, action, entry, 'sa', 'none');
      assert.equal(missing.code, 'VALIDATION', `${action} without a workspaceId`);
      assert.equal(missing.details.field, 'workspaceId');
    }
    // a workspace action in a workspace-less setting, or the reverse, is a mistake in the table
    assert.equal(entry.ws === false, expected.other === undefined && expected.none === undefined,
      `${action}: the table has ${entry.ws === false ? 'workspace scopes for an action with no workspace' : 'no workspace scope for a workspace action'}`);
  });
}

test('matrix: an unknown caller never gets past the pipeline, whatever the action', () => {
  const { env, world, actions } = setup();
  env.run('Probe.calls.length = 0');
  const strangers = ['nobody@flink.test', world.emails.gone, 'user1@evil.test', ''];
  for (const action of Object.keys(actions)) {
    for (const email of strangers) {
      signIn(env, email);
      const response = env.ctx.__plain(env.ctx.handleClientRequest(action, { v: 1, payload: {}, grant: TOKEN, workspaceId: world.ids.w1, requestId: crypto.randomUUID() }));
      assert.equal(response.ok, false, `${action} as "${email}"`);
      assert.ok(['NOT_PROVISIONED', 'ACCOUNT_INACTIVE', 'FORBIDDEN', 'AUTH_UNAVAILABLE'].includes(response.code), `${action} as "${email}": ${response.code}`);
    }
  }
  assert.equal(env.run('Probe.calls.length'), 0);
});

// ---------------------------------------------------------------- grants and step-up

for (const action of Object.keys(EXPECTED)) {
  test(`grant: ${action} needs ${EXPECTED[action].needs || 'nothing'} from the pipeline`, () => {
    const { env, world, actions } = setup();
    const entry = actions[action];
    const { needs } = EXPECTED[action];
    const scope = entry.ws === false ? 'none' : 'home';
    const sa = (extra) => request(env, world, action, entry, 'sa', scope, extra);

    env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
    const fresh = sa();
    assert.equal(fresh.ok, true, `${action} with a fresh step-up: ${fresh.code}`);

    env.run('Probe.stepupAt = 0');
    const stale = sa();
    const withoutGrant = sa({ grant: undefined });
    if (needs === '') {
      assert.equal(stale.ok, true, `${action} needs no grant, so a stale step-up must not matter`);
      assert.equal(withoutGrant.ok, true, `${action} needs no grant from the pipeline`);
    } else if (needs === 'grant') {
      assert.equal(stale.ok, true, `${action} needs a grant but no fresh step-up`);
      assert.equal(withoutGrant.code, 'CODE_REQUIRED');
    } else {
      assert.equal(needs, 'stepup');
      assert.equal(stale.code, 'STEP_UP_REQUIRED');
      assert.equal(withoutGrant.code, 'CODE_REQUIRED');
    }
    // the five minutes: just inside passes, just outside does not
    if (needs === 'stepup') {
      env.run(`Probe.stepupAt = ${env.fakes.clock.now() - 300000}`);
      assert.equal(sa().ok, true);
      env.run(`Probe.stepupAt = ${env.fakes.clock.now() - 300001}`);
      assert.equal(sa().code, 'STEP_UP_REQUIRED');
    }
  });
}

// ---------------------------------------------------------------- archived workspaces are read-only (section 7.1, rule 5)

test('archived: in W2 a workspace admin and a Super Admin can read but not write', () => {
  const { env, world, actions } = setup();
  for (const [action, entry] of Object.entries(actions)) {
    if (entry.ws === false) continue;
    const expectedRead = !EXPECTED[action].write;
    // admin1 is ADMIN of W2 as well as W1; the Super Admin passes for any workspace
    for (const persona of ['admin1', 'sa'].filter(p => p === 'sa' || entry.roles.includes('ADMIN'))) {
      const response = request(env, world, action, entry, persona, 'none', { workspaceId: world.ids.w2 });
      const label = `${action} in the archived workspace as ${persona}`;
      if (expectedRead) {
        // a read as a plain member of W2 is allowed; admin-only reads need the workspace-admin role, which admin1 has
        assert.equal(response.ok, true, `${label}: ${response.code} ${response.message}`);
      } else {
        assert.equal(response.ok, false, label);
        assert.equal(response.code, 'FORBIDDEN', label);
        assert.match(response.message, /archived/i, label);
      }
    }
  }
});

test('archived: a member of W2 can read the catalogue and the timer state, and cannot start a timer', () => {
  const { env, world, actions } = setup();
  signIn(env, world.emails.user4);
  const call = (action) => {
    const entry = actions[action];
    const envelope = { v: 1, payload: samplePayload(entry.schema, env.fakes.clock.now()), workspaceId: world.ids.w2 };
    if (entry.write) envelope.requestId = crypto.randomUUID();
    return env.ctx.__plain(env.ctx.handleClientRequest(action, envelope));
  };
  for (const action of ['projects.list', 'tasks.list', 'tags.list', 'clients.list', 'entries.list', 'reports.summary', 'app.bootstrap']) {
    assert.equal(call(action).ok, true, action);
  }
  for (const action of ['timer.start', 'timer.stop', 'timer.switch', 'entries.update', 'entries.delete', 'entries.bulk']) {
    const response = call(action);
    assert.equal(response.code, 'FORBIDDEN', action);
    assert.match(response.message, /archived/i);
  }
});

// ---------------------------------------------------------------- the shape of every entry

test('shape: every entry has exactly the fields of section 6.1 with the right kinds of value', () => {
  const { actions } = setup();
  for (const [name, entry] of Object.entries(actions)) {
    assert.deepEqual(Object.keys(entry).sort(), ['grant', 'handler', 'readOnlyOk', 'roles', 'schema', 'stepUp', 'wsAdmin', 'ws', 'write'].sort(), name);
    assert.match(name, /^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/, `${name} is group.verb`);
    assert.ok(Array.isArray(entry.roles) && entry.roles.length > 0, `${name}: roles`);
    assert.equal(new Set(entry.roles).size, entry.roles.length, `${name}: roles repeat`);
    for (const role of entry.roles) assert.ok(['USER', 'ADMIN', 'SUPER_ADMIN'].includes(role), `${name}: role ${role}`);
    assert.ok([true, false, 'optional'].includes(entry.ws), `${name}: ws`);
    for (const flag of ['wsAdmin', 'grant', 'stepUp', 'write', 'readOnlyOk']) assert.equal(typeof entry[flag], 'boolean', `${name}: ${flag}`);
    assert.equal(typeof entry.schema, 'object');
    assert.equal(typeof entry.handler, 'string');
  }
});

test('shape: the flags agree with each other', () => {
  const { actions } = setup();
  for (const [name, entry] of Object.entries(actions)) {
    if (entry.wsAdmin) assert.equal(entry.ws, true, `${name}: a workspace-admin action needs a workspace`);
    if (entry.stepUp) assert.equal(entry.grant, true, `${name}: a step-up action says grant: true too`);
    if (entry.wsAdmin || entry.grant || entry.stepUp) {
      assert.ok(!entry.roles.includes('USER'), `${name}: users never have a grant and are never workspace admins`);
    }
    assert.ok(entry.roles.includes('SUPER_ADMIN'), `${name}: a Super Admin may do everything a lower role may`);
    if (entry.write) assert.equal(entry.readOnlyOk, false, `${name}: a write must never be allowed in an archived workspace`);
    if (entry.ws === false) assert.equal(entry.readOnlyOk, false, `${name}: readOnlyOk only means something with a workspace`);
    else assert.equal(entry.readOnlyOk, !entry.write, `${name}: reads work in archived workspaces, writes do not`);
  }
});

test('shape: write, grant and step-up flags equal the hand-written table', () => {
  const { actions } = setup();
  for (const [name, entry] of Object.entries(actions)) {
    const expected = EXPECTED[name];
    assert.equal(entry.write, expected.write, `${name}: write`);
    assert.equal(entry.grant, expected.needs !== '', `${name}: grant`);
    assert.equal(entry.stepUp, expected.needs === 'stepup', `${name}: stepUp`);
    assert.ok(['', 'grant', 'stepup'].includes(expected.handlerNeeds), name);
    if (expected.handlerNeeds === 'grant') assert.equal(expected.needs, '', `${name}: a handler adds a grant only where the pipeline asks for none`);
  }
});

test('shape: every schema is valid and satisfiable, and its sample payload passes validation', () => {
  const { env, actions } = setup();
  for (const [name, entry] of Object.entries(actions)) {
    env.ctx.Validate.checkSchema_(entry.schema);
    const payload = samplePayload(entry.schema, env.fakes.clock.now());
    assert.doesNotThrow(() => env.ctx.Validate.payload_(entry.schema, payload), name);
  }
});

test('shape: every handler is named for its action and file, and every handler file exists', () => {
  const { actions } = setup();
  const files = readFilesJson();
  for (const [name, entry] of Object.entries(actions)) {
    assert.equal(entry.handler, expectedHandler(name), `${name}: handler name`);
    assert.ok(files.includes(`${entry.handler.split('.')[0]}.gs`), `${name}: ${entry.handler} is in no file of files.json`);
    assert.match(entry.handler, /^[A-Z][A-Za-z]+\.[a-z][A-Za-z]*_$/, `${name}: handlers are private functions of a module`);
  }
});

test('shape: no action name is reachable by an inherited property, and names are unique', () => {
  const { actions } = setup();
  const names = Object.keys(actions);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.ok(!(name in Object.prototype), name);
});

// ---------------------------------------------------------------- spec facts that the table cannot show

test('the payload fields of timer.start are those of the example in section 6.1', () => {
  const { actions } = setup();
  assert.deepEqual(actions['timer.start'], {
    roles: ['USER', 'ADMIN', 'SUPER_ADMIN'], ws: true, wsAdmin: false, grant: false, stepUp: false, write: true, readOnlyOk: false,
    schema: { projectId: 'id?', taskId: 'id?', description: 'text:0:500?', billable: 'bool?', tagIds: 'ids:10?', clientAt: 'ms' },
    handler: 'ActTimer.start_',
  });
});

test('payload fields follow the catalogue of section 6.2', () => {
  const { actions } = setup();
  const fields = name => Object.keys(actions[name].schema).sort();
  assert.deepEqual(fields('timer.stop'), ['clientAt', 'timerId']);
  assert.deepEqual(fields('timer.switch'), ['billable', 'description', 'projectId', 'tagIds', 'taskId', 'timerId', 'version']);
  assert.deepEqual(fields('entries.list'), ['cursor', 'from', 'projectId', 'tagId', 'to', 'userId']);
  assert.deepEqual(fields('entries.update'), ['billable', 'description', 'endAt', 'id', 'projectId', 'startAt', 'tagIds', 'taskId', 'version']);
  assert.deepEqual(fields('entries.delete'), ['id', 'reason', 'version']);
  assert.deepEqual(fields('entries.bulk'), ['ids', 'op', 'value']);
  assert.equal(actions['entries.bulk'].schema.ids, 'ids:50');
  assert.equal(actions['entries.bulk'].schema.op, 'enum:setProject|setBillable|addTags|removeTags|delete');
  assert.deepEqual(fields('projects.create'), ['billableDefault', 'budgetMinor', 'clientId', 'code', 'color', 'costRateMinor', 'endDate',
    'estimateMinutes', 'hourlyRateMinor', 'name', 'restricted', 'startDate']);
  assert.deepEqual(fields('projectAccess.set'), ['canTrack', 'projectId', 'userId']);
  assert.equal(actions['tags.create'].schema.name, 'text:1:60');
  assert.deepEqual(fields('workspaces.create'), ['code', 'name', 'timezone', 'weekStart']);
  assert.equal(actions['workspaces.create'].schema.weekStart, 'enum:SUN|MON|SAT');
  assert.deepEqual(fields('members.setAdmin'), ['isAdmin', 'userId']);
  assert.deepEqual(fields('users.create'), ['displayName', 'email', 'employeeCode', 'role', 'workspaceIds']);
  assert.equal(actions['users.create'].schema.role, 'enum:USER|ADMIN');
  assert.equal(actions['users.create'].schema.workspaceIds, 'ids:20?');
  assert.equal(actions['users.setAdminLimit'].schema.limit, 'int:0:50?');
  assert.equal(actions['users.deactivate'].schema.reason, 'text:1:500');
  assert.deepEqual(fields('users.unlock'), ['id']);
  assert.deepEqual(fields('reports.summary'), ['billable', 'clientIds', 'from', 'groupBy', 'projectIds', 'scope', 'tagIds', 'to', 'userIds']);
  assert.equal(actions['reports.summary'].schema.groupBy, 'enum:user|project|client|tag|task|day|week|month');
  assert.equal(actions['reports.summary'].schema.scope, 'enum:own|workspace');
  // detailed: the same scope and filters as summary (no grouping), plus a cursor
  assert.deepEqual(fields('reports.detailed'), ['billable', 'clientIds', 'cursor', 'from', 'projectIds', 'scope', 'tagIds', 'to', 'userIds']);
  // export: workspace admins only, so no scope; the filters, a type, and the paging fields
  assert.deepEqual(fields('reports.exportCsv'), ['billable', 'clientIds', 'exportId', 'from', 'groupBy', 'page', 'projectIds', 'tagIds', 'to', 'type', 'userIds']);
  assert.equal(actions['reports.exportCsv'].schema.type, 'enum:summary|detailed');
  assert.equal(actions['auth.verifyCode'].schema.code, 'text:6:6');
  assert.equal(actions['auth.enrollStart'].schema.enrollCode, 'text:10:10?');
  assert.equal(actions['auth.useBackupCode'].schema.backupCode, 'text:10:10');
  assert.equal(actions['app.bootstrap'].schema.view, 'enum:user|admin|superadmin');
  assert.deepEqual(fields('audit.list'), ['actorUserId', 'cursor', 'entityType', 'fromSeq', 'workspaceId']);
  assert.equal(actions['settings.patch'].schema.value, 'any');
});

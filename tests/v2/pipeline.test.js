'use strict';

// T1.8 — the request pipeline of BUILD_SPEC section 4.4 (Auth.gs and Main.gs), step by step, in order.
//
// ACTIONS is empty until T1.9, so each test registers the small fixture actions it needs inside the app context and
// points them at a recording handler (Probe). Grants.check_ belongs to T3.3; tests that need a grant install a stub
// with the contract the pipeline relies on: Grants.check_(token, user, now) returns the grant or throws CODE_REQUIRED.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEnv } = require('./helpers/env');
const { seedWorld, signIn, insert } = require('./helpers/seed');
const { expectCode } = require('./helpers/asserts');

const ALL_ROLES = ['USER', 'ADMIN', 'SUPER_ADMIN'];
const TOKEN = 'ab'.repeat(64);                    // 128 hex characters, the shape of a grant token
const GENERIC_INTERNAL = 'An internal error occurred.';

function setup(options) {
  const env = createEnv();
  const world = seedWorld(env, options);
  env.run(`
    var Probe = {
      calls: [], grantCalls: [], result: { echo: true }, fail: null, stepupAt: 0, grantFails: false,
      handler_: function (ctx) {
        Probe.calls.push(ctx);
        if (Probe.fail) throw Probe.fail();
        return Probe.result;
      }
    };
    Grants.check_ = function (token, user, now) {
      Probe.grantCalls.push({ token: token, userId: user.id, now: now });
      if (Probe.grantFails) throw new AppError_('CODE_REQUIRED', 'Enter your authenticator code.');
      return { kind: 'ADMIN', stepupAt: Probe.stepupAt };
    };
    var Writer = {
      handler_: function (ctx) {
        var tx = Db.tx_(Auth.dbCtx_(ctx));
        tx.result({ written: true });
        var out = tx.commit();
        return out.duplicate ? { duplicate: true } : { written: true };
      }
    };`);
  return { env, world };
}

function register(env, name, spec = {}) {
  const entry = {
    roles: ALL_ROLES, ws: false, wsAdmin: false, grant: false, stepUp: false, write: false, readOnlyOk: false,
    schema: {}, handler: 'Probe.handler_', ...spec,
  };
  env.run(`ACTIONS[${JSON.stringify(name)}] = ${JSON.stringify(entry)};`);
}

const call = (env, action, envelope = { v: 1 }, email) => {
  if (email !== undefined) signIn(env, email);
  return env.ctx.__plain(env.ctx.handleClientRequest(action, envelope));
};
const tursoCalls = env => env.fakes.fetch.calls.length;
const probeCalls = env => env.ctx.Probe.calls.length;
const lastCtx = env => env.ctx.Probe.calls[env.ctx.Probe.calls.length - 1];
const logLines = env => env.fakes.log.lines.filter(line => line.level === 'log').map(line => line.text);

function failure(response, code) {
  assert.equal(response.ok, false, `expected ${code}, got success: ${JSON.stringify(response)}`);
  assert.equal(response.code, code, `expected ${code}, got ${response.code}: ${response.message} ${JSON.stringify(response.details)}`);
  return response;
}
function success(response) {
  assert.equal(response.ok, true, `expected success, got ${response.code}: ${response.message} ${JSON.stringify(response.details)}`);
  return response;
}

// ---------------------------------------------------------------- step 1: the action

test('step 1: an action that is not in ACTIONS is FORBIDDEN, before anything else is looked at', () => {
  const { env } = setup();
  signIn(env, '');                                     // a blank email would be AUTH_UNAVAILABLE at step 2
  const response = failure(call(env, 'nope.nothing', { v: 1 }), 'FORBIDDEN');
  assert.equal(response.retryable, false);
  assert.equal(tursoCalls(env), 0);
});

test('step 1: names that exist on every object are not actions', () => {
  const { env, world } = setup();
  signIn(env, world.emails.user1);
  for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    failure(call(env, name), 'FORBIDDEN');
  }
  assert.equal(tursoCalls(env), 0);
});

test('step 1: an action that is not a string is FORBIDDEN and never throws', () => {
  const { env, world } = setup();
  signIn(env, world.emails.user1);
  for (const name of [undefined, null, 5, {}, [], ['timer.start'], true]) {
    failure(call(env, name), 'FORBIDDEN');
  }
});

// ---------------------------------------------------------------- steps 2 and 3: who is calling

test('step 2: a blank email is AUTH_UNAVAILABLE', () => {
  const { env } = setup();
  register(env, 'probe.read');
  for (const email of ['', '   ', '\n']) {
    signIn(env, email);
    const response = failure(call(env, 'probe.read'), 'AUTH_UNAVAILABLE');
    assert.equal(response.retryable, false);
  }
  assert.equal(tursoCalls(env), 0);
  assert.equal(probeCalls(env), 0);
});

test('step 3: the email is trimmed and lower-cased before the lookup', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1 }, `  ${world.emails.user1.toUpperCase()} \n`));
  assert.equal(lastCtx(env).user.email, world.emails.user1);
  assert.equal(lastCtx(env).user.id, world.ids.user1);
});

test('step 3: the domain is the text after the LAST @ and must equal COMPANY_DOMAIN exactly', () => {
  const { env } = setup();
  register(env, 'probe.read');
  const refused = [
    'user1@evil.test',
    'user1@flink.test.evil.com',
    'user1@sub.flink.test',
    'user1@notflink.test',
    'user1@flink.test@evil.test',       // the last @ decides: evil.test
    'flink.test',                       // no @ at all
    '@flink.test',                      // nothing before the @
    `${'a'.repeat(250)}@flink.test`,    // longer than any address
    'user1@flinK.test',            // KELVIN SIGN lower-cases to a plain k: only ASCII addresses are accepted
    'user 1@flink.test',
  ];
  for (const email of refused) {
    const response = failure(call(env, 'probe.read', { v: 1 }, email), 'FORBIDDEN');
    assert.equal(response.retryable, false, email);
  }
  assert.equal(tursoCalls(env), 0, 'a wrong domain is refused without a database call');
  assert.equal(probeCalls(env), 0);
});

test('step 3: user@evil.test@flink.test passes the domain check but has no account', () => {
  const { env } = setup();
  register(env, 'probe.read');
  failure(call(env, 'probe.read', { v: 1 }, 'user1@evil.test@flink.test'), 'NOT_PROVISIONED');
  assert.equal(probeCalls(env), 0);
});

test('step 3: COMPANY_DOMAIN is compared without case or padding, and a missing one fails closed', () => {
  const padded = setup({ domain: '  Flink.TEST ' });
  register(padded.env, 'probe.read');
  success(call(padded.env, 'probe.read', { v: 1 }, padded.world.emails.user1));

  for (const domain of [false, '', '   ']) {
    const { env, world } = setup({ domain });
    if (domain !== false) env.fakes.properties.set('COMPANY_DOMAIN', domain);
    register(env, 'probe.read');
    const response = failure(call(env, 'probe.read', { v: 1 }, world.emails.user1), 'INTERNAL');
    assert.equal(response.message, GENERIC_INTERNAL);
    assert.equal(tursoCalls(env), 0);
    assert.equal(probeCalls(env), 0);
  }
});

test('Auth.domainOf_ returns the text after the last @, or null', () => {
  const { env } = setup();
  assert.equal(env.ctx.Auth.domainOf_('a@b.test'), 'b.test');
  assert.equal(env.ctx.Auth.domainOf_('a@b@c.test'), 'c.test');
  assert.equal(env.ctx.Auth.domainOf_('abc'), null);
  assert.equal(env.ctx.Auth.domainOf_(''), null);
  assert.equal(env.ctx.Auth.domainOf_('a@'), '');
});

// ---------------------------------------------------------------- step 4: the account

test('step 4: no account row is NOT_PROVISIONED, an inactive account is ACCOUNT_INACTIVE', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  const missing = failure(call(env, 'probe.read', { v: 1 }, `nobody@${world.DOMAIN}`), 'NOT_PROVISIONED');
  assert.equal(missing.retryable, false);
  const inactive = failure(call(env, 'probe.read', { v: 1 }, world.emails.gone), 'ACCOUNT_INACTIVE');
  assert.equal(inactive.retryable, false);
  assert.equal(probeCalls(env), 0);
});

test('step 4: a cold lookup is one Turso call, a warm one none, and it expires after 60 seconds', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1 }, world.emails.user1));
  assert.equal(tursoCalls(env), 1, 'account and memberships in one pipeline');
  success(call(env, 'probe.read'));
  assert.equal(tursoCalls(env), 1, 'served from the cache');
  assert.ok(env.fakes.cache.keys().includes(`acct:0:${world.emails.user1}`));

  env.fakes.clock.advance(59000);
  success(call(env, 'probe.read'));
  assert.equal(tursoCalls(env), 1);
  env.fakes.clock.advance(2000);
  success(call(env, 'probe.read'));
  assert.equal(tursoCalls(env), 2, 'the entry lives 60 seconds');
});

test('step 4: bumping gen:acct makes the next request read the account again', () => {
  const { env, world } = setup();
  register(env, 'probe.read', { roles: ['ADMIN'] });
  failure(call(env, 'probe.read', { v: 1 }, world.emails.user1), 'FORBIDDEN');
  env.turso.db.exec(`UPDATE accounts SET role = 'ADMIN' WHERE email = '${world.emails.user1}'`);
  failure(call(env, 'probe.read'), 'FORBIDDEN');       // still the cached USER
  env.run('Cache.bump_(Cache.GEN_ACCT_)');
  success(call(env, 'probe.read'));
});

test('step 4: an inactive account stays refused while cached and is refused again when read fresh', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1 }, world.emails.user2));
  env.turso.db.exec(`UPDATE accounts SET status = 'INACTIVE' WHERE email = '${world.emails.user2}'`);
  env.run('Cache.bump_(Cache.GEN_ACCT_)');
  failure(call(env, 'probe.read'), 'ACCOUNT_INACTIVE');
  failure(call(env, 'probe.read'), 'ACCOUNT_INACTIVE');
});

test('step 4: a database that cannot be read is DB_UNAVAILABLE and retryable', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  env.fakes.fetch.failNext();
  const response = failure(call(env, 'probe.read', { v: 1 }, world.emails.user1), 'DB_UNAVAILABLE');
  assert.equal(response.retryable, true);
  assert.equal(probeCalls(env), 0);
});

test('loadAccount_ returns only the allowlisted account fields, active memberships, and all workspaces for a Super Admin', () => {
  const { env, world } = setup();
  const user = env.ctx.__plain(env.ctx.Auth.loadAccount_(world.emails.user1));
  assert.deepEqual(Object.keys(user.user).sort(), [
    'adminWsLimit', 'authEpoch', 'displayName', 'email', 'employeeCode', 'id', 'isRoot', 'role', 'status', 'version',
  ]);
  assert.deepEqual(user.memberships, [{
    workspaceId: world.ids.w1, wsRole: 'MEMBER', name: 'Workspace One', status: 'ACTIVE', timezone: 'Africa/Cairo', weekStart: 'SUN',
  }]);
  assert.equal(user.workspaces, null, 'only a Super Admin carries the list of every workspace');

  const sa = env.ctx.__plain(env.ctx.Auth.loadAccount_(world.emails.sa));
  assert.deepEqual(sa.memberships, []);
  assert.deepEqual(sa.workspaces.map(workspace => workspace.id).sort(), [world.ids.w1, world.ids.w2].sort());
  assert.deepEqual(Object.keys(sa.workspaces[0]).sort(), ['id', 'name', 'status', 'timezone', 'weekStart']);

  assert.equal(env.ctx.Auth.loadAccount_(`nobody@${world.DOMAIN}`), null);
});

test('loadAccount_ leaves out inactive memberships', () => {
  const { env, world } = setup();
  env.turso.db.exec(`UPDATE workspace_members SET active = 0 WHERE user_id = '${world.ids.user3}'`);
  const account = env.ctx.__plain(env.ctx.Auth.loadAccount_(world.emails.user3));
  assert.deepEqual(account.memberships, []);
});

// ---------------------------------------------------------------- step 5: the role

test('step 5: the account role must be one of the action roles', () => {
  const { env, world } = setup();
  register(env, 'probe.admin', { roles: ['ADMIN', 'SUPER_ADMIN'] });
  register(env, 'probe.sa', { roles: ['SUPER_ADMIN'] });
  failure(call(env, 'probe.admin', { v: 1 }, world.emails.user1), 'FORBIDDEN');
  success(call(env, 'probe.admin', { v: 1 }, world.emails.admin1));
  success(call(env, 'probe.admin', { v: 1 }, world.emails.sa));
  failure(call(env, 'probe.sa', { v: 1 }, world.emails.admin1), 'FORBIDDEN');
  success(call(env, 'probe.sa', { v: 1 }, world.emails.root));
  assert.equal(probeCalls(env), 3);
});

test('step 5: the role is checked before the workspace, the grant and the payload', () => {
  const { env, world } = setup();
  register(env, 'probe.admin', { roles: ['ADMIN'], ws: true, grant: true, schema: { name: 'text:1:5' } });
  const response = failure(call(env, 'probe.admin', { v: 1, workspaceId: 'not an id', grant: 'bad', payload: {} }, world.emails.user1), 'FORBIDDEN');
  assert.deepEqual(response.details, {});
  assert.equal(env.ctx.Probe.grantCalls.length, 0);
});

// ---------------------------------------------------------------- step 6: the workspace

test('step 6: a workspace action needs a workspaceId that is an id', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  for (const workspaceId of [undefined, null, '', 'w1', 42, {}, '00000000-0000-4000-8000-00000000000G']) {
    const response = failure(call(env, 'probe.ws', { v: 1, workspaceId }, world.emails.user1), 'VALIDATION');
    assert.equal(response.details.field, 'workspaceId', String(workspaceId));
  }
  assert.equal(probeCalls(env), 0);
});

test('step 6: a member passes and the handler gets the workspace with the caller\'s role in it', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1));
  assert.deepEqual(env.ctx.__plain(lastCtx(env).workspace), {
    id: world.ids.w1, name: 'Workspace One', status: 'ACTIVE', timezone: 'Africa/Cairo', weekStart: 'SUN',
    wsRole: 'MEMBER', isWsAdmin: false,
  });
  assert.equal(env.ctx.__plain(lastCtx(env).memberships).length, 1);
});

test('step 6: not a member, an unknown workspace and an inactive membership all give the same FORBIDDEN', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  env.turso.db.exec(`UPDATE workspace_members SET active = 0 WHERE user_id = '${world.ids.user3}'`);
  const unknownId = '00000000-0000-4000-8000-0000000000ff';
  const answers = [
    call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w2 }, world.emails.user1),   // a workspace they are not in
    call(env, 'probe.ws', { v: 1, workspaceId: unknownId }, world.emails.user1),      // a workspace that does not exist
    call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.user3),   // a membership that was switched off
    call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.admin3),  // an Admin who is a member of nothing
  ];
  for (const answer of answers) failure(answer, 'FORBIDDEN');
  assert.deepEqual(answers[0], answers[1], 'the response never reveals whether the workspace exists');
  assert.deepEqual(answers[0], answers[2]);
  assert.deepEqual(answers[0], answers[3]);
  assert.equal(probeCalls(env), 0);
});

test('step 6: an archived workspace is open only to actions marked readOnlyOk', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { ws: true, write: true });
  register(env, 'probe.view', { ws: true, readOnlyOk: true });
  const archived = failure(call(env, 'probe.write', { v: 1, workspaceId: world.ids.w2, requestId: crypto.randomUUID() }, world.emails.user4), 'FORBIDDEN');
  assert.match(archived.message, /archived/i);
  success(call(env, 'probe.view', { v: 1, workspaceId: world.ids.w2 }, world.emails.user4));
  assert.equal(lastCtx(env).workspace.status, 'ARCHIVED');
});

test('step 6: workspace admin actions need an Admin or Super Admin who is ADMIN in that workspace', () => {
  const { env, world } = setup();
  register(env, 'probe.wa', { ws: true, wsAdmin: true });
  success(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, world.emails.admin1));
  assert.equal(lastCtx(env).workspace.isWsAdmin, true);
  assert.equal(lastCtx(env).workspace.wsRole, 'ADMIN');
  const onlyMember = failure(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, world.emails.admin2), 'FORBIDDEN');   // Admin, but only a member
  failure(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1), 'FORBIDDEN');
  const notMember = failure(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, world.emails.admin3), 'FORBIDDEN');   // not a member
  assert.deepEqual(onlyMember, notMember, 'a refused workspace admin action does not say why');
});

test('step 6: ws_role ADMIN on a plain User account does not make a workspace admin', () => {
  const { env, world } = setup();
  register(env, 'probe.wa', { ws: true, wsAdmin: true });
  register(env, 'probe.ws', { ws: true });
  env.turso.db.exec(`UPDATE workspace_members SET ws_role = 'ADMIN' WHERE user_id = '${world.ids.user1}'`);
  failure(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1), 'FORBIDDEN');
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }));
  assert.equal(lastCtx(env).workspace.wsRole, 'ADMIN');
  assert.equal(lastCtx(env).workspace.isWsAdmin, false);
});

test('step 6: a Super Admin passes every workspace check for a workspace that exists', () => {
  const { env, world } = setup();
  register(env, 'probe.wa', { ws: true, wsAdmin: true });
  register(env, 'probe.write', { ws: true, wsAdmin: true, write: true });
  register(env, 'probe.view', { ws: true, wsAdmin: true, readOnlyOk: true });
  for (const email of [world.emails.sa, world.emails.root]) {
    success(call(env, 'probe.wa', { v: 1, workspaceId: world.ids.w1 }, email));
    assert.equal(lastCtx(env).workspace.wsRole, null, 'a Super Admin who is not a member has no workspace role');
    assert.equal(lastCtx(env).workspace.isWsAdmin, true);
    assert.equal(lastCtx(env).workspace.name, 'Workspace One');
    success(call(env, 'probe.view', { v: 1, workspaceId: world.ids.w2 }));
    // Archived workspaces are read-only for everybody (BUILD_SPEC section 7.1, rule 5).
    failure(call(env, 'probe.write', { v: 1, workspaceId: world.ids.w2, requestId: crypto.randomUUID() }), 'FORBIDDEN');
  }
  failure(call(env, 'probe.wa', { v: 1, workspaceId: '00000000-0000-4000-8000-0000000000ff' }, world.emails.sa), 'FORBIDDEN');
});

test('step 6: a Super Admin who is also a member keeps the membership role', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  insert(env.turso.db, 'workspace_members', {
    workspace_id: world.ids.w1, user_id: world.ids.sa, ws_role: 'MEMBER', active: 1, department: null, team: null,
    job_title: null, created_at: 1, updated_at: 1, version: 1,
  });
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.sa));
  assert.equal(lastCtx(env).workspace.wsRole, 'MEMBER');
  assert.equal(lastCtx(env).workspace.isWsAdmin, true);
});

test('step 6: ws "optional" accepts no workspace, and checks one when it is given', () => {
  const { env, world } = setup();
  register(env, 'probe.maybe', { ws: 'optional', readOnlyOk: true });
  success(call(env, 'probe.maybe', { v: 1 }, world.emails.user1));
  assert.equal(lastCtx(env).workspace, null);
  success(call(env, 'probe.maybe', { v: 1, workspaceId: null }));
  assert.equal(lastCtx(env).workspace, null);
  success(call(env, 'probe.maybe', { v: 1, workspaceId: world.ids.w1 }));
  assert.equal(lastCtx(env).workspace.id, world.ids.w1);
  failure(call(env, 'probe.maybe', { v: 1, workspaceId: world.ids.w2 }), 'FORBIDDEN');
  failure(call(env, 'probe.maybe', { v: 1, workspaceId: 'junk' }), 'VALIDATION');
});

test('step 6: an action without ws ignores the workspaceId and gets no workspace', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1, workspaceId: 'junk' }, world.emails.user1));
  assert.equal(lastCtx(env).workspace, null);
});

test('step 6: memberships come from the cached account, so a second request needs no Turso call', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1));
  const after = tursoCalls(env);
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }));
  assert.equal(tursoCalls(env), after);
});

// ---------------------------------------------------------------- step 7: grant and step-up

test('step 7: a grant action without a grant is CODE_REQUIRED and never reaches Grants', () => {
  const { env, world } = setup();
  register(env, 'probe.grant', { grant: true });
  for (const grant of [undefined, null, '', 'short', 'AB'.repeat(64), 'zz'.repeat(64), `${TOKEN}0`, 12345, {}]) {
    const response = failure(call(env, 'probe.grant', { v: 1, grant }, world.emails.admin1), 'CODE_REQUIRED');
    assert.equal(response.retryable, false);
  }
  assert.equal(env.ctx.Probe.grantCalls.length, 0, 'a token of the wrong shape is refused without a lookup');
  assert.equal(probeCalls(env), 0);
});

test('step 7: a grant of the right shape goes to Grants.check_ with the user and the time', () => {
  const { env, world } = setup();
  register(env, 'probe.grant', { grant: true });
  success(call(env, 'probe.grant', { v: 1, grant: TOKEN }, world.emails.admin1));
  assert.deepEqual(env.ctx.__plain(env.ctx.Probe.grantCalls), [{ token: TOKEN, userId: world.ids.admin1, now: env.fakes.clock.now() }]);
  assert.equal(lastCtx(env).grant.kind, 'ADMIN');
});

test('step 7: what Grants.check_ refuses stays refused', () => {
  const { env, world } = setup();
  register(env, 'probe.grant', { grant: true });
  env.run('Probe.grantFails = true');
  failure(call(env, 'probe.grant', { v: 1, grant: TOKEN }, world.emails.admin1), 'CODE_REQUIRED');
  assert.equal(probeCalls(env), 0);
});

test('step 7: an action that needs no grant never looks at one, but hands the token to the handler', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1, grant: TOKEN }, world.emails.user1));
  assert.equal(env.ctx.Probe.grantCalls.length, 0);
  assert.equal(lastCtx(env).grant, null);
  assert.equal(lastCtx(env).grantToken, TOKEN, 'the handler may ask for the grant itself (step-up on someone else\'s entry)');
  success(call(env, 'probe.read', { v: 1, grant: 'garbage' }));
  assert.equal(lastCtx(env).grantToken, null, 'only a token of the right shape is passed on');
});

test('step 7: stepUp is fresh for exactly 5 minutes', () => {
  const { env, world } = setup();
  register(env, 'probe.step', { grant: true, stepUp: true });
  const now = env.fakes.clock.now();
  const envelope = { v: 1, grant: TOKEN };
  env.run(`Probe.stepupAt = ${now - 300000}`);
  success(call(env, 'probe.step', envelope, world.emails.admin1));              // exactly 5 minutes old: still fresh
  env.run(`Probe.stepupAt = ${now - 300001}`);
  const old = failure(call(env, 'probe.step', envelope), 'STEP_UP_REQUIRED');
  assert.equal(old.retryable, false);
  env.run('Probe.stepupAt = 0');
  failure(call(env, 'probe.step', envelope), 'STEP_UP_REQUIRED');
  env.run(`Probe.stepupAt = ${now}`);
  success(call(env, 'probe.step', envelope));
  assert.equal(probeCalls(env), 2);
});

test('step 7: stepUp without the grant flag still needs a valid grant first', () => {
  const { env, world } = setup();
  register(env, 'probe.step', { grant: false, stepUp: true });
  failure(call(env, 'probe.step', { v: 1 }, world.emails.admin1), 'CODE_REQUIRED');
  env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
  success(call(env, 'probe.step', { v: 1, grant: TOKEN }));
});

test('step 7: the workspace is checked before the grant', () => {
  const { env, world } = setup();
  register(env, 'probe.grant', { grant: true, ws: true, wsAdmin: true });
  failure(call(env, 'probe.grant', { v: 1, workspaceId: world.ids.w1, grant: TOKEN }, world.emails.admin2), 'FORBIDDEN');
  assert.equal(env.ctx.Probe.grantCalls.length, 0);
});

test('Auth.requireStepUp_ lets a handler ask for a fresh code, using the grant already checked when there is one', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  const now = env.fakes.clock.now();

  success(call(env, 'probe.read', { v: 1 }, world.emails.admin1));
  expectCode(() => env.ctx.Auth.requireStepUp_(lastCtx(env)), 'CODE_REQUIRED');           // no grant sent

  env.run('Probe.stepupAt = 0');
  success(call(env, 'probe.read', { v: 1, grant: TOKEN }));
  expectCode(() => env.ctx.Auth.requireStepUp_(lastCtx(env)), 'STEP_UP_REQUIRED');
  assert.equal(env.ctx.Probe.grantCalls.length, 1);

  env.run(`Probe.stepupAt = ${now}`);
  success(call(env, 'probe.read', { v: 1, grant: TOKEN }));
  const grant = env.ctx.Auth.requireStepUp_(lastCtx(env));
  assert.equal(grant.kind, 'ADMIN');

  env.run('Probe.grantFails = true');
  success(call(env, 'probe.read', { v: 1, grant: TOKEN }));
  expectCode(() => env.ctx.Auth.requireStepUp_(lastCtx(env)), 'CODE_REQUIRED');
});

test('Auth.requireStepUp_ reuses a grant the pipeline already validated', () => {
  const { env, world } = setup();
  register(env, 'probe.grant', { grant: true });
  env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
  success(call(env, 'probe.grant', { v: 1, grant: TOKEN }, world.emails.admin1));
  assert.equal(env.ctx.Probe.grantCalls.length, 1);
  env.ctx.Auth.requireStepUp_(lastCtx(env));
  assert.equal(env.ctx.Probe.grantCalls.length, 1, 'no second lookup');
});

// ---------------------------------------------------------------- step 8: the envelope and the payload

test('step 8: the payload is validated against the schema and the handler gets the normalised copy', () => {
  const { env, world } = setup();
  register(env, 'probe.pay', { schema: { name: 'text:1:10', note: 'text:0:20?', count: 'int:0:9?' } });
  success(call(env, 'probe.pay', { v: 1, payload: { name: '  Ann  ', count: 3 } }, world.emails.user1));
  assert.deepEqual(env.ctx.__plain(lastCtx(env).payload), { name: 'Ann', count: 3 });

  const missing = failure(call(env, 'probe.pay', { v: 1, payload: {} }), 'VALIDATION');
  assert.equal(missing.details.field, 'name');
  const unknown = failure(call(env, 'probe.pay', { v: 1, payload: { name: 'A', extra: 1 } }), 'VALIDATION');
  assert.equal(unknown.details.field, 'extra');
  const wrong = failure(call(env, 'probe.pay', { v: 1, payload: { name: 'A', count: '3' } }), 'VALIDATION');
  assert.equal(wrong.details.field, 'count');
  assert.equal(probeCalls(env), 1);
});

test('step 8: a missing payload counts as an empty one', () => {
  const { env, world } = setup();
  register(env, 'probe.none');
  success(call(env, 'probe.none', { v: 1 }, world.emails.user1));
  assert.deepEqual(env.ctx.__plain(lastCtx(env).payload), {});
  success(call(env, 'probe.none', { v: 1, payload: null }));
  failure(call(env, 'probe.none', { v: 1, payload: [] }), 'VALIDATION');
  failure(call(env, 'probe.none', { v: 1, payload: 'x' }), 'VALIDATION');
});

test('step 8: the envelope must be an object with v = 1 and only the known fields', () => {
  const { env, world } = setup();
  register(env, 'probe.none');
  signIn(env, world.emails.user1);
  for (const envelope of [undefined, null, 'x', 5, [], [{ v: 1 }]]) {
    // not through call(): its default envelope would replace an undefined one
    const response = failure(env.ctx.__plain(env.ctx.handleClientRequest('probe.none', envelope)), 'VALIDATION');
    assert.equal(response.details.field, 'envelope');
  }
  for (const v of [undefined, 0, 2, '1', null, true]) {
    const response = failure(call(env, 'probe.none', { v }), 'VALIDATION');
    assert.equal(response.details.field, 'v');
  }
  const extra = failure(call(env, 'probe.none', { v: 1, userId: world.ids.root }), 'VALIDATION');
  assert.equal(extra.details.field, 'userId');
  assert.equal(probeCalls(env), 0);
});

test('step 8: the grant is checked before the payload, and the payload before the request id', () => {
  const { env, world } = setup();
  register(env, 'probe.all', { roles: ['ADMIN'], write: true, grant: true, schema: { name: 'text:1:5' } });
  env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
  const bad = { v: 1, payload: {} };                        // no name, no requestId, no grant
  failure(call(env, 'probe.all', bad, world.emails.admin1), 'CODE_REQUIRED');
  const noName = failure(call(env, 'probe.all', { ...bad, grant: TOKEN }), 'VALIDATION');
  assert.equal(noName.details.field, 'name');
  const noId = failure(call(env, 'probe.all', { ...bad, grant: TOKEN, payload: { name: 'Ann' } }), 'VALIDATION');
  assert.equal(noId.details.field, 'requestId');
  success(call(env, 'probe.all', { ...bad, grant: TOKEN, payload: { name: 'Ann' }, requestId: crypto.randomUUID() }));
});

// ---------------------------------------------------------------- step 9: request id and payload hash

test('step 9: a write needs a requestId that is a UUID', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true });
  for (const requestId of [undefined, null, '', 'abc', 5, crypto.randomUUID().toUpperCase(), `${crypto.randomUUID()}x`, [crypto.randomUUID()]]) {
    const response = failure(call(env, 'probe.write', { v: 1, requestId }, world.emails.user1), 'VALIDATION');
    assert.equal(response.details.field, 'requestId', String(requestId));
  }
  assert.equal(probeCalls(env), 0);
  const requestId = crypto.randomUUID();
  success(call(env, 'probe.write', { v: 1, requestId }));
  assert.equal(lastCtx(env).requestId, requestId);
});

test('step 9: a read ignores the requestId and has no payload hash', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  success(call(env, 'probe.read', { v: 1, requestId: 'not even an id' }, world.emails.user1));
  assert.equal(lastCtx(env).requestId, null);
  assert.equal(lastCtx(env).payloadHash, null);
});

test('step 9: payloadHash is the SHA-256 of the canonical JSON of the normalised payload, whatever the key order', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, schema: { b: 'text:0:5', a: 'int:0:9' } });
  const expected = crypto.createHash('sha256').update('{"a":1,"b":"x"}').digest('hex');
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID(), payload: { b: ' x ', a: 1 } }, world.emails.user1));
  assert.equal(lastCtx(env).payloadHash, expected);
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID(), payload: { a: 1, b: 'x' } }));
  assert.equal(lastCtx(env).payloadHash, expected);
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID(), payload: { a: 2, b: 'x' } }));
  assert.notEqual(lastCtx(env).payloadHash, expected);
});

// ---------------------------------------------------------------- step 10: the handler's context

test('step 10: the handler gets the context of section 4.4 and nothing else sensitive', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, ws: true, grant: true, schema: { name: 'text:1:5' } });
  env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
  const requestId = crypto.randomUUID();
  success(call(env, 'probe.write', { v: 1, requestId, workspaceId: world.ids.w1, grant: TOKEN, payload: { name: 'Ann' } }, world.emails.admin1));
  const ctx = lastCtx(env);
  assert.deepEqual(Object.keys(ctx).sort(), [
    'action', 'grant', 'grantToken', 'memberships', 'now', 'payload', 'payloadHash', 'rateLimit', 'requestId', 'setting', 'user', 'workspace',
  ]);
  assert.equal(ctx.action, 'probe.write');
  assert.equal(ctx.now, env.fakes.clock.now());
  assert.deepEqual(Object.keys(env.ctx.__plain(ctx.user)).sort(), [
    'adminWsLimit', 'authEpoch', 'displayName', 'email', 'employeeCode', 'id', 'isRoot', 'role', 'status', 'version',
  ]);
  assert.equal(ctx.user.id, world.ids.admin1);
  assert.deepEqual(env.ctx.__plain(ctx.memberships).map(m => m.workspaceId).sort(), [world.ids.w1, world.ids.w2].sort());
});

test('step 10: a write loads the settings once and hands its rate limit to the transaction', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true });
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }, world.emails.user1));
  assert.equal(lastCtx(env).rateLimit, 60, 'the default of RATE_LIMIT_WRITES_PER_MIN');
  assert.equal(tursoCalls(env), 2, 'the account and the settings, one call each');
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }));
  assert.equal(tursoCalls(env), 2, 'both are cached now');

  insert(env.turso.db, 'settings', { scope: 'GLOBAL', key: 'RATE_LIMIT_WRITES_PER_MIN', value_json: '90', updated_at: 1, updated_by: 'x', version: 1 });
  env.run('Cache.bump_(Cache.GEN_SETTINGS_)');
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }));
  assert.equal(lastCtx(env).rateLimit, 90);
});

test('step 10: a read does not touch the settings until the handler asks, and then only once', () => {
  const { env, world } = setup();
  register(env, 'probe.ws', { ws: true });
  insert(env.turso.db, 'settings', { scope: world.ids.w1, key: 'PAST_ENTRY_EDIT_DAYS', value_json: '3', updated_at: 1, updated_by: 'x', version: 1 });
  insert(env.turso.db, 'settings', { scope: 'GLOBAL', key: 'AUTO_STOP_HOURS', value_json: '10', updated_at: 1, updated_by: 'x', version: 1 });
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1));
  assert.equal(tursoCalls(env), 1, 'just the account');
  const ctx = lastCtx(env);
  assert.equal(ctx.rateLimit, undefined);
  assert.equal(ctx.setting('PAST_ENTRY_EDIT_DAYS'), 3, 'the workspace override');
  assert.equal(ctx.setting('AUTO_STOP_HOURS'), 10);
  assert.equal(ctx.setting('FEATURE_TAGS'), true, 'the default');
  assert.equal(ctx.setting('PAST_ENTRY_EDIT_DAYS', world.ids.w2), 7, 'another workspace falls back to the default');
  assert.equal(tursoCalls(env), 2, 'the settings were read once for all four');
  expectCode(() => ctx.setting('NOT_A_SETTING'), 'INTERNAL');
});

test('step 10: ctx.setting reads the settings once per request, however often it is called', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, ws: true });
  env.run('var loads = 0; var realLoad = Config.load_; Config.load_ = function () { loads += 1; return realLoad(); };');
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID(), workspaceId: world.ids.w1 }, world.emails.user1));
  const ctx = lastCtx(env);
  ctx.setting('FEATURE_TAGS');
  ctx.setting('AUTO_STOP_HOURS');
  ctx.setting('PAST_ENTRY_EDIT_DAYS', world.ids.w2);
  assert.equal(env.run('loads'), 1, 'the pipeline loaded them for the rate limit; the handler reuses that snapshot');
});

test('step 10: the transaction context carries the user, request, action, hash, time and rate limit', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, schema: { n: 'int:0:9' } });
  const requestId = crypto.randomUUID();
  success(call(env, 'probe.write', { v: 1, requestId, payload: { n: 4 } }, world.emails.user1));
  assert.deepEqual(env.ctx.__plain(env.ctx.Auth.dbCtx_(lastCtx(env))), {
    userId: world.ids.user1, requestId, action: 'probe.write', payloadHash: lastCtx(env).payloadHash,
    now: env.fakes.clock.now(), rateLimit: 60,
  });
});

test('step 10: a write that goes through Db.tx_ is stored once, and a retry with the same id is a duplicate', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, handler: 'Writer.handler_' });
  const requestId = crypto.randomUUID();
  const first = success(call(env, 'probe.write', { v: 1, requestId }, world.emails.user1));
  assert.deepEqual(first.data, { written: true });
  const retry = success(call(env, 'probe.write', { v: 1, requestId }));
  assert.deepEqual(retry.data, { duplicate: true });
  const rows = env.turso.db.prepare('SELECT user_id, request_id, action FROM request_log').all().map(row => ({ ...row }));
  assert.deepEqual(rows, [{ user_id: world.ids.user1, request_id: requestId, action: 'probe.write' }]);
});

test('step 10: the rate limit setting is enforced end to end', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { write: true, handler: 'Writer.handler_' });
  insert(env.turso.db, 'settings', { scope: 'GLOBAL', key: 'RATE_LIMIT_WRITES_PER_MIN', value_json: '10', updated_at: 1, updated_by: 'x', version: 1 });
  signIn(env, world.emails.user1);
  for (let i = 0; i < 10; i++) success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }));
  const limited = failure(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }), 'RATE_LIMITED');
  assert.equal(limited.retryable, true);
  assert.equal(limited.details.retryAfterSeconds, 60);
  env.fakes.clock.advance(61000);
  success(call(env, 'probe.write', { v: 1, requestId: crypto.randomUUID() }));
});

test('step 10: a handler that does not exist is INTERNAL, and a registered action never runs an inherited function', () => {
  const { env, world } = setup();
  register(env, 'probe.missing', { handler: 'Probe.nothing_' });
  register(env, 'probe.nomodule', { handler: 'Nowhere.handler_' });
  register(env, 'probe.inherited', { handler: 'Probe.toString' });
  register(env, 'probe.shapeless', { handler: 'handler' });
  signIn(env, world.emails.user1);
  for (const name of ['probe.missing', 'probe.nomodule', 'probe.inherited', 'probe.shapeless']) {
    const response = failure(call(env, name), 'INTERNAL');
    assert.equal(response.message, GENERIC_INTERNAL);
  }
});

// ---------------------------------------------------------------- step 11: the response

test('step 11: success is { ok, data, serverNow } and nothing else', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  env.run('Probe.result = { list: [1, 2, { a: "b" }], name: "x" }');
  const response = call(env, 'probe.read', { v: 1 }, world.emails.user1);
  assert.deepEqual(response, { ok: true, data: { list: [1, 2, { a: 'b' }], name: 'x' }, serverNow: env.fakes.clock.now() });
});

test('step 11: a handler that returns nothing gives empty data', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  env.run('Probe.result = undefined');
  assert.deepEqual(call(env, 'probe.read', { v: 1 }, world.emails.user1).data, {});
});

test('step 11: an AppError_ becomes { ok: false, code, message, retryable, details } and nothing else', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  env.run(`Probe.fail = function () { return new AppError_('CONFLICT', 'Someone changed this; reload.'); }`);
  assert.deepEqual(call(env, 'probe.read', { v: 1 }, world.emails.user1), {
    ok: false, code: 'CONFLICT', message: 'Someone changed this; reload.', retryable: false, details: {},
  });
  env.run(`Probe.fail = function () { return new AppError_('BUSY', 'The database is busy; try again.'); }`);
  assert.equal(call(env, 'probe.read').retryable, true);
});

test('step 11: details are passed on only where section 4.3 defines them', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  signIn(env, world.emails.user1);
  const throwWith = (code, details) => env.run(`Probe.fail = function () { return new AppError_(${JSON.stringify(code)}, 'm', ${JSON.stringify(details)}); }`);

  throwWith('VALIDATION', { field: 'name', secret: 'x' });
  assert.deepEqual(call(env, 'probe.read').details, { field: 'name' });
  throwWith('POLICY', { rule: 'REQUIRE_DESCRIPTION', other: 1 });
  assert.deepEqual(call(env, 'probe.read').details, { rule: 'REQUIRE_DESCRIPTION' });
  throwWith('LOCKED_OUT', { until: 1762160000000, extra: 1 });
  assert.deepEqual(call(env, 'probe.read').details, { until: 1762160000000 });
  throwWith('LOCKED_OUT', { hard: true });
  assert.deepEqual(call(env, 'probe.read').details, { hard: true });
  throwWith('RATE_LIMITED', {});
  assert.deepEqual(call(env, 'probe.read').details, { retryAfterSeconds: 60 });
  // The Turso client puts the failing URL's text into DB_UNAVAILABLE details for the log; it must not reach the page.
  throwWith('DB_UNAVAILABLE', { reason: 'fetch failed', error: 'Address unavailable: https://db.example.turso.io/v2/pipeline' });
  assert.deepEqual(call(env, 'probe.read').details, {});
  throwWith('CONFLICT', { anything: 'else' });
  assert.deepEqual(call(env, 'probe.read').details, {});
  throwWith('NOT_FOUND', { id: 'x' });
  assert.deepEqual(call(env, 'probe.read').details, {});
});

test('step 11: INTERNAL is generic, carries a correlation id, and logs the real cause under that id', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  signIn(env, world.emails.user1);
  env.run(`Probe.fail = function () { return new AppError_('INTERNAL', 'secret message', { error: 'the cause' }); }`);
  const first = failure(call(env, 'probe.read'), 'INTERNAL');
  assert.equal(first.message, GENERIC_INTERNAL);
  assert.equal(first.retryable, false);
  assert.deepEqual(Object.keys(first.details), ['correlationId']);
  assert.match(first.details.correlationId, /^[0-9a-f-]{36}$/);
  const errors = env.fakes.log.lines.filter(line => line.level === 'error');
  assert.equal(errors.length, 1);
  assert.ok(errors[0].text.includes(first.details.correlationId));
  assert.ok(errors[0].text.includes('the cause'));
  assert.ok(!JSON.stringify(first).includes('secret message'));
  assert.ok(!JSON.stringify(first).includes('the cause'));

  env.run(`Probe.fail = function () { return new TypeError('x is not a function'); }`);
  const second = failure(call(env, 'probe.read'), 'INTERNAL');
  assert.notEqual(second.details.correlationId, first.details.correlationId);
  assert.equal(second.message, GENERIC_INTERNAL);
  assert.ok(!JSON.stringify(second).includes('not a function'));
});

test('step 11: a response that cannot be sent as JSON is INTERNAL, not a thrown error', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  signIn(env, world.emails.user1);
  env.run('var loop = {}; loop.self = loop; Probe.result = loop;');
  failure(call(env, 'probe.read'), 'INTERNAL');
  env.run('Probe.result = { big: 10n };');
  failure(call(env, 'probe.read'), 'INTERNAL');
  env.run('Probe.result = { when: new Date(0), missing: undefined, kept: 1 };');
  assert.deepEqual(call(env, 'probe.read').data, { when: '1970-01-01T00:00:00.000Z', kept: 1 }, 'the page gets plain JSON');
});

test('handleClientRequest never throws, even when the logger does', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  signIn(env, world.emails.user1);
  env.fakes.globals.console.log = () => { throw new Error('log broke'); };
  env.fakes.globals.console.error = () => { throw new Error('log broke'); };
  success(call(env, 'probe.read'));
  failure(call(env, 'nope.nothing'), 'FORBIDDEN');
  env.run(`Probe.fail = function () { return new Error('boom'); }`);
  const response = failure(call(env, 'probe.read'), 'INTERNAL');
  assert.match(response.details.correlationId, /^[0-9a-f-]{36}$/, 'the page still gets an id to quote');
});

// ---------------------------------------------------------------- step 11: the log line

test('step 11: one log line per request with the action, the outcome and the time, and nothing private', () => {
  const { env, world } = setup();
  register(env, 'probe.write', { roles: ['ADMIN', 'SUPER_ADMIN'], write: true, ws: true, grant: true, schema: { description: 'text:0:50' } });
  env.run(`Probe.stepupAt = ${env.fakes.clock.now()}`);
  const secrets = ['PRIVATE-DESCRIPTION-TEXT', TOKEN, world.emails.admin1, world.emails.user2];
  const envelope = {
    v: 1, requestId: crypto.randomUUID(), workspaceId: world.ids.w1, grant: TOKEN,
    payload: { description: 'PRIVATE-DESCRIPTION-TEXT' },
  };

  success(call(env, 'probe.write', envelope, world.emails.admin1));
  env.run(`Probe.fail = function () { return new AppError_('CONFLICT', 'Mentions ${world.emails.user2}'); }`);
  failure(call(env, 'probe.write', { ...envelope, requestId: crypto.randomUUID() }), 'CONFLICT');
  failure(call(env, 'probe.write', { ...envelope, payload: { description: 'PRIVATE-DESCRIPTION-TEXT', x: 1 } }), 'VALIDATION');
  failure(call(env, 'probe.write', { ...envelope, grant: undefined }), 'CODE_REQUIRED');
  failure(call(env, 'probe.write', envelope, world.emails.user1), 'FORBIDDEN');
  failure(call(env, 'probe.write', envelope, 'someone@evil.test'), 'FORBIDDEN');
  failure(call(env, 'attacker.chosen.name'), 'FORBIDDEN');

  const lines = logLines(env);
  assert.equal(lines.length, 7, 'exactly one line per request');
  for (const line of lines) {
    for (const secret of secrets) assert.ok(!line.includes(secret), `a log line contains ${secret}: ${line}`);
    assert.match(line, /^request action=\S+ outcome=\S+ ms=\d+/);
  }
  assert.match(lines[0], /^request action=probe\.write outcome=OK ms=\d+ user=/);
  assert.ok(lines[0].includes(world.ids.admin1), 'the caller is named by id, not by email');
  assert.match(lines[1], /outcome=CONFLICT/);
  assert.match(lines[2], /outcome=VALIDATION/);
  assert.match(lines[3], /outcome=CODE_REQUIRED/);
  assert.match(lines[4], /outcome=FORBIDDEN/);
  assert.match(lines[5], /action=probe\.write outcome=FORBIDDEN/);
  assert.match(lines[6], /action=\(unknown\) outcome=FORBIDDEN/, 'a name the caller made up is never logged');
  assert.ok(!lines[6].includes('attacker'));
  assert.ok(!lines[6].includes('user='), 'nobody is identified before the sign-in is checked');
});

test('step 11: the duration in the log line is the time the request took', () => {
  const { env, world } = setup();
  // The fake clock stands still unless a database call stalls it, so make the account lookup stall.
  register(env, 'probe.ws', { ws: true });
  env.fakes.fetch.stallNext(1500);
  success(call(env, 'probe.ws', { v: 1, workspaceId: world.ids.w1 }, world.emails.user1));
  assert.match(logLines(env)[0], / ms=1500 /);
});

test('log lines never carry a token or an email, even from an INTERNAL cause', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  signIn(env, world.emails.user1);
  const bearer = `eyJhbGciOiJFZERTQSJ9.${'A'.repeat(60)}.${'b'.repeat(60)}`;
  env.run(`Probe.fail = function () { return new AppError_('INTERNAL', 'x', { error: 'Authorization: Bearer ${bearer} for ${world.emails.user2} grant ${TOKEN}' }); }`);
  failure(call(env, 'probe.read'), 'INTERNAL');
  const text = env.fakes.log.lines.map(line => line.text).join('\n');
  assert.ok(!text.includes(bearer));
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes(world.emails.user2));
  assert.ok(text.includes('[redacted]'));
  assert.ok(text.includes('[email]'));
});

test('a database detail that names the Turso host is logged for the operator but not returned', () => {
  const { env, world } = setup();
  register(env, 'probe.read');
  env.fakes.fetch.failNext();
  const response = failure(call(env, 'probe.read', { v: 1 }, world.emails.user1), 'DB_UNAVAILABLE');
  assert.deepEqual(response.details, {});
  const warnings = env.fakes.log.lines.filter(line => line.level === 'warn');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].text, /DB_UNAVAILABLE/);
});

'use strict';

// T1.13 (gate) — the server rules of BUILD_SPEC section 7.1, one block each.
//
// What the pipeline alone can enforce is tested for real. What needs a handler that a later ticket builds is written
// as the test it will be, against the real ACTIONS, and marked `todo` with the ticket that must make it pass: node
// reports it without failing the run, and the ticket removes the `todo` when its handler exists. A todo test that
// starts passing early is fine; one that is still todo when its ticket is done is a defect in that ticket.
//
// Grants.check_ belongs to T3.3, so these tests install the same stub as the pipeline tests: it accepts any token and
// reports a fresh step-up.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv } = require('./helpers/env');
const { seedWorld, signIn } = require('./helpers/seed');

const TOKEN = 'ef'.repeat(64);
const todo = ticket => ({ todo: `${ticket}: the handler is not built yet` });

function setup() {
  const env = createEnv();
  const world = seedWorld(env);
  env.run(`Grants.check_ = function () { return { kind: 'ADMIN', stepupAt: ${env.fakes.clock.now()} }; };`);
  return { env, world };
}

// A request as `persona`, with a valid (stub) grant and a fresh step-up, the way the real page would send it.
function send(env, world, persona, action, payload, workspaceId) {
  signIn(env, world.emails[persona]);
  const entry = env.ctx.ACTIONS[action];
  const envelope = { v: 1, grant: TOKEN, payload };
  if (entry.write) envelope.requestId = crypto.randomUUID();
  if (workspaceId !== undefined) envelope.workspaceId = workspaceId;
  return env.ctx.__plain(env.ctx.handleClientRequest(action, envelope));
}
const refusedWith = (response, code, label) => {
  assert.equal(response.ok, false, `${label}: expected ${code}, the request was allowed`);
  assert.equal(response.code, code, `${label}: ${response.code} ${response.message}`);
};

// ---------------------------------------------------------------- the gate's suites exist

test('gate: the permission-matrix, transaction, tamper-detection and migration suites are all there', () => {
  for (const suite of ['permission-matrix', 'db', 'audit', 'migrations', 'migration-constraints', 'pipeline', 'fake-turso']) {
    assert.ok(fs.existsSync(path.join(__dirname, `${suite}.test.js`)), `${suite}.test.js is missing`);
  }
});

// ---------------------------------------------------------------- rule 1: nobody changes their own account

test('rule 1: users.update, users.setAdminLimit and users.deactivate are Super Admin actions with a step-up', () => {
  const { env, world } = setup();
  const own = world.ids.sa;
  for (const [action, payload] of [
    ['users.update', { id: own, version: 1, role: 'USER' }],
    ['users.setAdminLimit', { id: own, version: 1, limit: 1 }],
    ['users.deactivate', { id: own, version: 1, reason: 'test' }],
  ]) {
    refusedWith(send(env, world, 'admin1', action, payload), 'FORBIDDEN', `${action} as an Admin`);
    refusedWith(send(env, world, 'user1', action, payload), 'FORBIDDEN', `${action} as a User`);
  }
});

test('rule 1: a Super Admin cannot change their own role, status, email or admin limit, or deactivate themselves', todo('T3.4'), () => {
  const { env, world } = setup();
  const own = world.ids.sa;
  for (const [action, payload] of [
    ['users.update', { id: own, version: 1, role: 'USER' }],
    ['users.update', { id: own, version: 1, email: 'someone.else@flink.test' }],
    ['users.setAdminLimit', { id: own, version: 1, limit: 1 }],
    ['users.deactivate', { id: own, version: 1, reason: 'test' }],
  ]) {
    refusedWith(send(env, world, 'sa', action, payload), 'FORBIDDEN', `${action} on oneself`);
  }
});

// ---------------------------------------------------------------- rule 2: the root account

test('rule 2: the role of a Super Admin cannot be set through the app at all, so it cannot be demoted into or out of', () => {
  const { env, world } = setup();
  // users.create and users.update take USER or ADMIN only: SUPER_ADMIN is granted by ownerGrantSuperAdmin (setup.test.js).
  for (const role of ['SUPER_ADMIN', 'ROOT', 'admin', '']) {
    const created = send(env, world, 'sa', 'users.create', { email: 'new.person@flink.test', displayName: 'New', role });
    refusedWith(created, 'VALIDATION', `users.create role ${role}`);
    assert.equal(created.details.field, 'role');
    const updated = send(env, world, 'sa', 'users.update', { id: world.ids.user1, version: 1, role });
    refusedWith(updated, 'VALIDATION', `users.update role ${role}`);
  }
});

test('rule 2: the root cannot be demoted, deactivated, re-emailed or have its authenticator reset through the app', todo('T3.4'), () => {
  const { env, world } = setup();
  const root = world.ids.root;
  for (const [action, payload] of [
    ['users.update', { id: root, version: 1, role: 'USER' }],
    ['users.update', { id: root, version: 1, email: 'someone.else@flink.test' }],
    ['users.deactivate', { id: root, version: 1, reason: 'test' }],
    ['users.issueEnrollCode', { id: root }],
  ]) {
    refusedWith(send(env, world, 'sa', action, payload), 'FORBIDDEN', `${action} on the root`);
  }
});

test('rule 2: another Super Admin may unlock the root', todo('T3.4'), () => {
  const { env, world } = setup();
  const response = send(env, world, 'sa', 'users.unlock', { id: world.ids.root });
  assert.equal(response.ok, true, `${response.code} ${response.message}`);
});

// ---------------------------------------------------------------- rule 3: at least one Super Admin

test('rule 3: demoting or deactivating a Super Admin leaves at least one active Super Admin', todo('T3.4'), () => {
  const { env, world } = setup();
  env.turso.db.exec(`UPDATE accounts SET status = 'INACTIVE' WHERE id = '${world.ids.root}'`);   // only "sa" is left active
  env.run('Cache.bump_(Cache.GEN_ACCT_)');
  refusedWith(send(env, world, 'sa', 'users.deactivate', { id: world.ids.sa, version: 1, reason: 'test' }), 'FORBIDDEN', 'deactivating the last Super Admin');
  refusedWith(send(env, world, 'sa', 'users.update', { id: world.ids.sa, version: 1, role: 'ADMIN' }), 'FORBIDDEN', 'demoting the last Super Admin');
});

// ---------------------------------------------------------------- rule 4: only a Super Admin with step-up sets ws_role

test('rule 4: members.setAdmin is for Super Admins with a fresh step-up, and nobody else', () => {
  const { env, world } = setup();
  const payload = { userId: world.ids.user1, isAdmin: true };
  refusedWith(send(env, world, 'admin1', 'members.setAdmin', payload, world.ids.w1), 'FORBIDDEN', 'the workspace admin');
  refusedWith(send(env, world, 'admin2', 'members.setAdmin', payload, world.ids.w1), 'FORBIDDEN', 'an Admin who is a member');
  refusedWith(send(env, world, 'user1', 'members.setAdmin', payload, world.ids.w1), 'FORBIDDEN', 'a User');

  signIn(env, world.emails.sa);
  const noGrant = env.ctx.__plain(env.ctx.handleClientRequest('members.setAdmin', { v: 1, requestId: crypto.randomUUID(), workspaceId: world.ids.w1, payload }));
  refusedWith(noGrant, 'CODE_REQUIRED', 'no grant');
  env.run('Grants.check_ = function () { return { kind: "ADMIN", stepupAt: 0 }; };');
  refusedWith(send(env, world, 'sa', 'members.setAdmin', payload, world.ids.w1), 'STEP_UP_REQUIRED', 'a stale step-up');
});

test('rule 4: a workspace admin cannot slip a workspace role into members.add or members.update', () => {
  const { env, world } = setup();
  for (const field of ['wsRole', 'ws_role', 'role', 'isAdmin']) {
    for (const action of ['members.add', 'members.update']) {
      const response = send(env, world, 'admin1', action, { userId: world.ids.user1, [field]: 'ADMIN' }, world.ids.w1);
      refusedWith(response, 'VALIDATION', `${action} with ${field}`);
      assert.equal(response.details.field, field);
    }
  }
});

test('rule 4: granting workspace admin respects the Admin limit of the workspaces they administer (D6)', () => {
  const { env, world } = setup();
  env.turso.db.exec(`UPDATE accounts SET admin_ws_limit = 0 WHERE id = '${world.ids.admin2}'`);
  env.run('Cache.bump_(Cache.GEN_ACCT_)');
  const response = send(env, world, 'sa', 'members.setAdmin', { userId: world.ids.admin2, isAdmin: true }, world.ids.w1);
  refusedWith(response, 'POLICY', 'a limit of 0');
  assert.deepEqual(response.details, { rule: 'ADMIN_MAX_ACTIVE_WORKSPACES' });
});

// ---------------------------------------------------------------- rule 5: archived workspaces are read-only

test('rule 5: in an archived workspace every write is refused before it reaches a handler', () => {
  const { env, world } = setup();
  const writes = Object.entries(env.ctx.__plain(env.ctx.ACTIONS)).filter(([, entry]) => entry.ws !== false && entry.write);
  assert.ok(writes.length >= 25, 'there are many write actions in a workspace');
  for (const [action, entry] of writes) {
    for (const persona of ['admin1', 'sa'].filter(p => p === 'sa' || entry.roles.includes('ADMIN'))) {
      const response = send(env, world, persona, action, {}, world.ids.w2);
      // {} may also be a bad payload, but the workspace is checked before the payload
      refusedWith(response, 'FORBIDDEN', `${action} in the archived workspace as ${persona}`);
      assert.match(response.message, /archived/i);
    }
  }
});

test('rule 5: a write is refused by its transaction when the workspace was archived after the cache was filled', todo('T2.4'), () => {
  const { env, world } = setup();
  const start = { clientAt: env.fakes.clock.now() };
  assert.equal(send(env, world, 'user1', 'timer.stop', { timerId: world.ids.w1, clientAt: start.clientAt }, world.ids.w1).code !== 'FORBIDDEN', true);   // warms the cache
  env.turso.db.exec(`UPDATE workspaces SET status = 'ARCHIVED' WHERE id = '${world.ids.w1}'`);                                    // no cache bump
  refusedWith(send(env, world, 'user1', 'timer.start', start, world.ids.w1), 'FORBIDDEN', 'timer.start in a workspace archived a moment ago');
});

// ---------------------------------------------------------------- rule 6: no money for the user role

test('rule 6: a user-role caller never receives hourly_rate_minor, cost_rate_minor, budget_minor or a money total (projects, tasks)', () => {
  const { env, world } = setup();
  for (const persona of ['user1', 'user2', 'admin2']) {          // admin2 is an Admin account, but not a workspace admin
    for (const [action, id] of [['projects.list', world.ids.open], ['tasks.list', world.ids.task]]) {
      const response = send(env, world, persona, action, {}, world.ids.w1);
      assert.equal(response.ok, true, `${persona} ${action}: ${response.code} ${response.message}`);
      const text = JSON.stringify(response.data);
      assert.ok(text.includes(id), `${persona} gets the ${action} rows they may see`);
      assert.ok(!/rate|cost|budget|amount|money|minor|estimate/i.test(text), `${persona} ${action} holds a money field`);
    }
  }
});

test('rule 6: nor in reports', todo('T4.1'), () => {
  const { env, world } = setup();
  const response = send(env, world, 'user1', 'reports.summary',
    { scope: 'own', from: '2026-11-01', to: '2026-11-30', groupBy: 'project' }, world.ids.w1);
  assert.equal(response.ok, true, `${response.code} ${response.message}`);
  assert.ok(!/amountMinor|costMinor|rate|budget/i.test(JSON.stringify(response.data)));
});

// ---------------------------------------------------------------- rule 7: other people's records

test('rule 7: a User cannot read another user\'s entries, and an id outside the caller\'s scope is NOT_FOUND', todo('T2.5'), () => {
  const { env, world } = setup();
  const response = send(env, world, 'user1', 'entries.list', { from: '2026-11-01', to: '2026-11-30', userId: world.ids.user2 }, world.ids.w1);
  refusedWith(response, 'FORBIDDEN', 'a User listing another user\'s entries');
  const outside = send(env, world, 'user1', 'entries.update', { id: '00000000-0000-4000-8000-0000000000f1', version: 1, description: 'x' }, world.ids.w1);
  refusedWith(outside, 'NOT_FOUND', 'an entry that does not exist, or is not theirs, looks the same');
});

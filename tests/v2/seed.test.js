'use strict';

// The standard test world of tests/v2/helpers/seed.js (BUILD_SPEC section 10). Later tickets build on it, so its
// shape is pinned here: a change to the seed that would quietly change what those tests mean fails this one.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');
const { seedWorld, ids } = require('./helpers/seed');

function world() {
  const env = createEnv();
  const seeded = seedWorld(env);
  const all = sql => env.turso.db.prepare(sql).all().map(row => ({ ...row }));
  return { env, seeded, all };
}

test('the seed has the accounts of section 10: one root, a second Super Admin, Admins, Users and an inactive one', () => {
  const { all } = world();
  const accounts = all('SELECT email, role, status, is_root FROM accounts ORDER BY email');
  assert.equal(accounts.length, 10);
  assert.deepEqual(accounts.filter(a => a.is_root === 1).map(a => a.email), ['root@flink.test']);
  const count = role => accounts.filter(a => a.role === role).length;
  assert.deepEqual([count('SUPER_ADMIN'), count('ADMIN'), count('USER')], [2, 3, 5]);
  assert.deepEqual(accounts.filter(a => a.status === 'INACTIVE').map(a => a.email), ['gone@flink.test']);
});

test('the seed has W1 (active, Cairo, weeks start on Sunday) and W2 (archived)', () => {
  const { all } = world();
  assert.deepEqual(all('SELECT code, status, timezone, week_start FROM workspaces ORDER BY code'), [
    { code: 'W1', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN' },
    { code: 'W2', status: 'ARCHIVED', timezone: 'Africa/Cairo', week_start: 'MON' },
  ]);
});

test('the seed memberships: admin1 runs W1 and W2, admin2 is a plain member, admin3 and the Super Admins belong to nothing', () => {
  const { all } = world();
  const rows = all(`SELECT a.email, w.code, m.ws_role, m.active FROM workspace_members m
                    JOIN accounts a ON a.id = m.user_id JOIN workspaces w ON w.id = m.workspace_id ORDER BY a.email, w.code`);
  assert.deepEqual(rows, [
    { email: 'admin1@flink.test', code: 'W1', ws_role: 'ADMIN', active: 1 },
    { email: 'admin1@flink.test', code: 'W2', ws_role: 'ADMIN', active: 1 },
    { email: 'admin2@flink.test', code: 'W1', ws_role: 'MEMBER', active: 1 },
    { email: 'gone@flink.test', code: 'W1', ws_role: 'MEMBER', active: 0 },
    { email: 'user1@flink.test', code: 'W1', ws_role: 'MEMBER', active: 1 },
    { email: 'user2@flink.test', code: 'W1', ws_role: 'MEMBER', active: 1 },
    { email: 'user3@flink.test', code: 'W1', ws_role: 'MEMBER', active: 1 },
    { email: 'user4@flink.test', code: 'W2', ws_role: 'MEMBER', active: 1 },
  ]);
});

test('the seed catalog: an open and a restricted project (only user1 has access), a task, an active and an archived tag', () => {
  const { all } = world();
  assert.deepEqual(all('SELECT id, workspace_id, restricted, status FROM projects ORDER BY id').map(p => [p.id, p.restricted, p.status]), [
    [ids.open, 0, 'ACTIVE'], [ids.locked, 1, 'ACTIVE'], [ids.archivedProject, 0, 'ACTIVE'],
  ]);
  assert.deepEqual(all('SELECT project_id, user_id, can_track FROM project_access'), [
    { project_id: ids.locked, user_id: ids.user1, can_track: 1 },
  ]);
  assert.equal(all('SELECT * FROM tasks').length, 1);
  assert.deepEqual(all('SELECT id, status FROM tags ORDER BY id'), [
    { id: ids.tagA, status: 'ACTIVE' }, { id: ids.tagB, status: 'ARCHIVED' },
  ]);
  assert.equal(all('SELECT hourly_rate_minor FROM projects WHERE id = ?'.replace('?', `'${ids.open}'`))[0].hourly_rate_minor, 50000);
});

test('every seed id is a valid id, and the seeded integers are stored as integers', () => {
  const { env, all } = world();
  const pattern = env.run('Validate.UUID_PATTERN_');
  for (const [name, id] of Object.entries(ids)) assert.ok(pattern.test(id), `${name}: ${id}`);
  assert.equal(new Set(Object.values(ids)).size, Object.values(ids).length);
  assert.deepEqual(all("SELECT DISTINCT typeof(created_at) AS t, typeof(auth_epoch) AS e FROM accounts"), [{ t: 'integer', e: 'integer' }]);
});

test('the seed forgets the calls the migration made and sets COMPANY_DOMAIN', () => {
  const { env } = world();
  assert.equal(env.fakes.fetch.calls.length, 0);
  assert.equal(env.fakes.properties.get('COMPANY_DOMAIN'), 'flink.test');
});

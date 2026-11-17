'use strict';

/**
 * Builds the standard test world (BUILD_SPEC section 10) in the fake Turso of a createEnv(): migration 001 applied
 * through the app's own runner, then accounts, workspaces, members, projects, tasks and tags inserted directly.
 *
 *   const env = createEnv();
 *   const world = seedWorld(env);        // { ids, emails, DOMAIN }
 *   signIn(env, world.emails.user1);     // the next requests come from this Google account
 *
 * Everything is made up: example addresses on the reserved .test domain, ids that read as names.
 *
 *   accounts     root (SUPER_ADMIN, is_root), sa (SUPER_ADMIN), admin1 (ADMIN, workspace admin of W1 and W2),
 *                admin2 (ADMIN, plain member of W1), admin3 (ADMIN, member of nothing), user1-user3 (USER, members of
 *                W1), user4 (USER, member of W2 only), gone (USER, INACTIVE, still a member of W1 on paper)
 *   workspaces   W1 (Africa/Cairo, week starts SUN, ACTIVE), W2 (Africa/Cairo, week starts MON, ARCHIVED)
 *   projects     W1: open (unrestricted, with rates), locked (restricted; only user1 has access); W2: archivedProject
 *   tasks        W1: task on open; tags W1: tagA (ACTIVE), tagB (ARCHIVED)
 *
 * Integers are bound as BigInt on purpose: node:sqlite binds a plain JS number as REAL (BUILD_SPEC section 10).
 */

const DOMAIN = 'flink.test';
const T0 = Date.UTC(2026, 0, 1);            // created_at of everything in the seed; before the default test clock

const NAMES = [
  'root', 'sa', 'admin1', 'admin2', 'admin3', 'user1', 'user2', 'user3', 'user4', 'gone',
  'w1', 'w2', 'open', 'locked', 'archivedProject', 'task', 'tagA', 'tagB',
];

// 00000000-0000-4000-8000-000000000001 and so on: valid UUID text that is easy to recognise in a failing test.
const ids = Object.fromEntries(NAMES.map((name, index) => [
  name, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
]));

const emails = {
  root: `root@${DOMAIN}`, sa: `sa@${DOMAIN}`, admin1: `admin1@${DOMAIN}`, admin2: `admin2@${DOMAIN}`,
  admin3: `admin3@${DOMAIN}`, user1: `user1@${DOMAIN}`, user2: `user2@${DOMAIN}`, user3: `user3@${DOMAIN}`,
  user4: `user4@${DOMAIN}`, gone: `gone@${DOMAIN}`,
};

function insert(db, table, row) {
  const columns = Object.keys(row);
  const values = columns.map(name => (Number.isInteger(row[name]) ? BigInt(row[name]) : row[name]));
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
}

const stamps = { created_at: T0, updated_at: T0 };

function account(name, role, extra = {}) {
  return {
    id: ids[name], email: emails[name], display_name: `Test ${name}`, role, status: 'ACTIVE', employee_code: null,
    is_root: 0, auth_epoch: 1, admin_ws_limit: null, ...stamps, version: 1, ...extra,
  };
}

function member(workspace, user, wsRole = 'MEMBER', extra = {}) {
  return {
    workspace_id: ids[workspace], user_id: ids[user], ws_role: wsRole, active: 1, department: null, team: null,
    job_title: null, ...stamps, version: 1, ...extra,
  };
}

function seedWorld(env, options = {}) {
  env.run('Migrations.run_()');
  const db = env.turso.db;

  insert(db, 'accounts', account('root', 'SUPER_ADMIN', { is_root: 1 }));
  insert(db, 'accounts', account('sa', 'SUPER_ADMIN'));
  insert(db, 'accounts', account('admin1', 'ADMIN'));
  insert(db, 'accounts', account('admin2', 'ADMIN'));
  insert(db, 'accounts', account('admin3', 'ADMIN'));
  for (const name of ['user1', 'user2', 'user3', 'user4']) insert(db, 'accounts', account(name, 'USER'));
  insert(db, 'accounts', account('gone', 'USER', { status: 'INACTIVE' }));

  insert(db, 'workspaces', {
    id: ids.w1, code: 'W1', name: 'Workspace One', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', ...stamps, version: 1,
  });
  insert(db, 'workspaces', {
    id: ids.w2, code: 'W2', name: 'Workspace Two', status: 'ARCHIVED', timezone: 'Africa/Cairo', week_start: 'MON', ...stamps, version: 1,
  });

  insert(db, 'workspace_members', member('w1', 'admin1', 'ADMIN'));
  insert(db, 'workspace_members', member('w2', 'admin1', 'ADMIN'));
  insert(db, 'workspace_members', member('w1', 'admin2'));
  for (const name of ['user1', 'user2', 'user3']) insert(db, 'workspace_members', member('w1', name));
  insert(db, 'workspace_members', member('w2', 'user4'));
  insert(db, 'workspace_members', member('w1', 'gone', 'MEMBER', { active: 0 }));

  const project = (name, workspace, extra) => ({
    id: ids[name], workspace_id: ids[workspace], client_id: null, name: `Project ${name}`, code: null, status: 'ACTIVE',
    restricted: 0, billable_default: 1, hourly_rate_minor: null, cost_rate_minor: null, estimate_minutes: null,
    budget_minor: null, start_date: null, end_date: null, color: null, ...stamps, version: 1, ...extra,
  });
  insert(db, 'projects', project('open', 'w1', { hourly_rate_minor: 50000, cost_rate_minor: 20000, budget_minor: 9000000 }));
  insert(db, 'projects', project('locked', 'w1', { restricted: 1 }));
  insert(db, 'projects', project('archivedProject', 'w2'));
  insert(db, 'project_access', { workspace_id: ids.w1, project_id: ids.locked, user_id: ids.user1, can_track: 1, ...stamps });

  insert(db, 'tasks', {
    id: ids.task, workspace_id: ids.w1, project_id: ids.open, name: 'Task one', status: 'ACTIVE', estimate_minutes: null,
    billable_default: null, sort_order: 0, ...stamps, version: 1,
  });
  insert(db, 'tags', { id: ids.tagA, workspace_id: ids.w1, name: 'Tag A', color: null, status: 'ACTIVE', ...stamps, version: 1 });
  insert(db, 'tags', { id: ids.tagB, workspace_id: ids.w1, name: 'Tag B', color: null, status: 'ARCHIVED', ...stamps, version: 1 });

  if (options.domain !== false) env.fakes.properties.set('COMPANY_DOMAIN', options.domain || DOMAIN);
  env.fakes.fetch.calls.length = 0;           // forget the calls the migration made
  return { ids, emails, DOMAIN };
}

// The Google account that makes the next requests (what Session.getActiveUser().getEmail() returns).
function signIn(env, email) {
  env.fakes.session.setActiveEmail(email);
}

module.exports = { seedWorld, signIn, insert, ids, emails, DOMAIN, T0 };

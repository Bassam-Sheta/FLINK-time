'use strict';

// T1.3 — every CHECK and UNIQUE rule of migration 001 (BUILD_SPEC section 5.1) rejects a bad row.
//
// Each case inserts a known-good row (the control: it must succeed), then the same row with one column made bad,
// which must fail with the message of that specific constraint. The two coverage tests at the end read the rules out
// of the database itself, so a CHECK or UNIQUE added to a migration without a case here fails the suite.
//
// Foreign keys are off in the fake by default, so these inserts need no parent rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');

const env = createEnv();
env.run('Migrations.run_()');
const db = env.turso.db;

const long = n => 'x'.repeat(n);
const bind = value => (Number.isInteger(value) ? BigInt(value) : value);   // node:sqlite binds plain numbers as REAL

function insert(table, row) {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map(column => bind(row[column])));
}

// Runs fn, returns the error it threw (or null), and undoes everything it wrote.
function attempt(fn) {
  db.exec('SAVEPOINT constraint_case');
  try {
    try { fn(); return null; } catch (err) { return err; }
  } finally {
    db.exec('ROLLBACK TO constraint_case');
    db.exec('RELEASE constraint_case');
  }
}

// One valid row per table (columns with defaults are left out).
const GOOD = {
  accounts: { id: 'a1', email: 'ann@flink.test', display_name: 'Ann', role: 'USER', status: 'ACTIVE', created_at: 1, updated_at: 1 },
  workspaces: { id: 'w1', code: 'W1', name: 'Main', status: 'ACTIVE', timezone: 'Africa/Cairo', week_start: 'SUN', created_at: 1, updated_at: 1 },
  workspace_members: { workspace_id: 'w1', user_id: 'a1', ws_role: 'MEMBER', created_at: 1, updated_at: 1 },
  clients: { id: 'c1', workspace_id: 'w1', name: 'Acme', status: 'ACTIVE', created_at: 1, updated_at: 1 },
  projects: { id: 'p1', workspace_id: 'w1', name: 'Alpha', status: 'ACTIVE', created_at: 1, updated_at: 1 },
  tasks: { id: 't1', workspace_id: 'w1', project_id: 'p1', name: 'Design', status: 'ACTIVE', created_at: 1, updated_at: 1 },
  project_access: { workspace_id: 'w1', project_id: 'p1', user_id: 'a1', created_at: 1, updated_at: 1 },
  tags: { id: 'g1', workspace_id: 'w1', name: 'Urgent', status: 'ACTIVE', created_at: 1, updated_at: 1 },
  active_timers: { user_id: 'a1', timer_id: 'tm1', workspace_id: 'w1', started_at: 1000, local_date: '2026-11-05' },
  time_entries: { id: 'e1', workspace_id: 'w1', user_id: 'a1', start_at: 1000, end_at: 2000, duration_s: 1, local_date: '2026-11-05', billable: 1, source: 'TIMER', created_at: 1, updated_at: 1 },
  entry_tags: { entry_id: 'e1', tag_id: 'g1', workspace_id: 'w1' },
  settings: { scope: 'GLOBAL', key: 'K', value_json: '1', updated_at: 1, updated_by: 'a1' },
  admin_mfa: { user_id: 'a1', updated_at: 1 },
  admin_grants: { token_hash: 'h1', user_id: 'a1', kind: 'ADMIN', created_at: 1, last_seen_at: 1, expires_at: 2, auth_epoch: 1 },
  request_log: { user_id: 'a1', request_id: 'r1', action: 'x', payload_sha256: 's', result_json: '{}', created_at: 1 },
  audit_log: { seq: 1, ts: 1, actor_user_id: 'a1', actor_role: 'USER', entity_type: 'x', entity_id: '1', action: 'A', request_id: 'r1' },
  chain_head: { id: 1, seq: 0, hash: 'h', updated_at: 0 },
  security_events: { id: 1, ts: 1, event_type: 'X', success: 1 },
  export_state: { name: 'daily' },
  job_runs: { id: 100, job: 'j', started_at: 1, status: 'OK' },     // the runner already logged id 1
  schema_migrations: { version: 99, name: 'n', checksum: 'c', applied_at: 1 },
};

test('control: every table accepts its good row', () => {
  for (const [table, row] of Object.entries(GOOD)) {
    if (table === 'chain_head') continue;                              // seeded by the migration
    assert.equal(attempt(() => insert(table, row)), null, table);
  }
});

// ---------------------------------------------------------------- CHECK

// [table, what is wrong, columns to override, text the failing constraint contains]
const CHECK_CASES = [
  ['accounts', 'email with capitals', { email: 'Ann@Flink.test' }, 'lower(trim(email))'],
  ['accounts', 'email with a leading space', { email: ' ann@flink.test' }, 'lower(trim(email))'],
  ['accounts', 'email shorter than 3 characters', { email: 'a@' }, 'BETWEEN 3 AND 254'],
  ['accounts', 'email longer than 254 characters', { email: long(250) + '@x.test' }, 'BETWEEN 3 AND 254'],
  ['accounts', 'empty display name', { display_name: '' }, 'length(display_name)'],
  ['accounts', 'display name over 120 characters', { display_name: long(121) }, 'length(display_name)'],
  ['accounts', 'unknown role', { role: 'BOSS' }, 'role IN'],
  ['accounts', 'unknown status', { status: 'GONE' }, 'status IN'],
  ['accounts', 'is_root not 0 or 1', { is_root: 2 }, 'is_root IN'],
  ['accounts', 'admin_ws_limit above 50', { admin_ws_limit: 51 }, 'admin_ws_limit'],
  ['accounts', 'negative admin_ws_limit', { admin_ws_limit: -1 }, 'admin_ws_limit'],

  ['workspaces', 'empty name', { name: '' }, 'length(name)'],
  ['workspaces', 'name over 120 characters', { name: long(121) }, 'length(name)'],
  ['workspaces', 'unknown status', { status: 'GONE' }, 'status IN'],
  ['workspaces', 'week_start not SUN, MON or SAT', { week_start: 'FRI' }, 'week_start IN'],

  ['workspace_members', 'unknown ws_role', { ws_role: 'OWNER' }, 'ws_role IN'],
  ['workspace_members', 'active not 0 or 1', { active: 2 }, 'active IN'],

  ['clients', 'empty name', { name: '' }, 'length(name)'],
  ['clients', 'unknown status', { status: 'GONE' }, 'status IN'],

  ['projects', 'empty name', { name: '' }, 'length(name)'],
  ['projects', 'unknown status', { status: 'GONE' }, 'status IN'],
  ['projects', 'restricted not 0 or 1', { restricted: 2 }, 'restricted IN'],
  ['projects', 'billable_default not 0 or 1', { billable_default: 2 }, 'billable_default IN'],
  ['projects', 'negative hourly rate', { hourly_rate_minor: -1 }, 'hourly_rate_minor'],
  ['projects', 'negative cost rate', { cost_rate_minor: -1 }, 'cost_rate_minor'],
  ['projects', 'negative estimate', { estimate_minutes: -1 }, 'estimate_minutes'],
  ['projects', 'negative budget', { budget_minor: -1 }, 'budget_minor'],

  ['tasks', 'empty name', { name: '' }, 'length(name)'],
  ['tasks', 'unknown status', { status: 'GONE' }, 'status IN'],
  ['tasks', 'negative estimate', { estimate_minutes: -1 }, 'estimate_minutes'],
  ['tasks', 'billable_default not 0 or 1', { billable_default: 2 }, 'billable_default'],

  ['project_access', 'can_track not 0 or 1', { can_track: 2 }, 'can_track IN'],

  ['tags', 'empty name', { name: '' }, 'length(name)'],
  ['tags', 'name over 60 characters', { name: long(61) }, 'length(name)'],
  ['tags', 'unknown status', { status: 'GONE' }, 'status IN'],

  ['active_timers', 'billable not 0 or 1', { billable: 2 }, 'billable IN'],

  ['time_entries', 'billable not 0 or 1', { billable: 2 }, 'billable IN'],
  ['time_entries', 'unknown source', { source: 'WEB' }, 'source IN'],
  ['time_entries', 'unknown stop_reason', { stop_reason: 'CRASH' }, 'stop_reason'],
  ['time_entries', 'end before start', { start_at: 1000, end_at: 500, duration_s: 0 }, 'end_at >= start_at'],
  ['time_entries', 'longer than 24 hours', { start_at: 1000, end_at: 1000 + 86400001, duration_s: 86400 }, 'end_at - start_at <= 86400000'],
  ['time_entries', 'duration_s that does not match the times', { duration_s: 2 }, 'duration_s ='],

  ['admin_mfa', 'enabled not 0 or 1', { enabled: 2 }, 'enabled IN'],
  ['admin_mfa', 'hard_locked not 0 or 1', { hard_locked: 2 }, 'hard_locked IN'],

  ['admin_grants', 'unknown kind', { kind: 'OTHER' }, 'kind IN'],

  ['chain_head', 'a second chain head', { id: 2 }, 'id = 1'],

  ['security_events', 'success not 0 or 1', { success: 2 }, 'success IN'],

  ['job_runs', 'unknown status', { status: 'DONE' }, 'status IN'],
];

const observedChecks = new Set();
const normal = text => text.replace(/\s+/g, ' ').trim();

for (const [table, label, override, fragment] of CHECK_CASES) {
  test(`CHECK ${table}: ${label}`, () => {
    // chain_head is seeded by the migration, so its control and bad rows go in after the seed is removed
    const prepare = table === 'chain_head' ? () => db.exec('DELETE FROM chain_head') : () => {};
    assert.equal(attempt(() => { prepare(); insert(table, GOOD[table]); }), null, 'the unmodified row must insert');

    const err = attempt(() => { prepare(); insert(table, { ...GOOD[table], ...override }); });
    assert.ok(err, 'the bad row must be refused');
    const match = /CHECK constraint failed: (.*)$/s.exec(err.message);
    assert.ok(match, `expected a CHECK failure, got: ${err.message}`);
    assert.ok(match[1].includes(fragment), `"${match[1]}" should contain "${fragment}"`);
    observedChecks.add(`${table}: ${normal(match[1])}`);        // keyed by table: the same text repeats across tables
  });
}

test('24 hours exactly is allowed (the limit is inclusive)', () => {
  const row = { ...GOOD.time_entries, start_at: 1000, end_at: 1000 + 86400000, duration_s: 86400 };
  assert.equal(attempt(() => insert('time_entries', row)), null);
});

// ---------------------------------------------------------------- UNIQUE and PRIMARY KEY

// [table, what collides, columns to override in the FIRST row (null = the migration already seeded it),
//  columns to override in the SECOND row, the columns SQLite names in its message]
const UNIQUE_CASES = [
  ['accounts', 'same id', {}, { email: 'other@flink.test' }, 'accounts.id'],
  ['accounts', 'same email', {}, { id: 'a2' }, 'accounts.email'],
  ['accounts', 'a second root account', { is_root: 1 }, { id: 'a2', email: 'other@flink.test', is_root: 1 }, 'accounts.is_root'],

  ['workspaces', 'same id', {}, { code: 'W2' }, 'workspaces.id'],
  ['workspaces', 'same code', {}, { id: 'w2' }, 'workspaces.code'],

  ['workspace_members', 'same workspace and user', {}, {}, 'workspace_members.workspace_id, workspace_members.user_id'],

  ['clients', 'same id', {}, { name: 'Other' }, 'clients.id'],
  ['clients', 'same name in one workspace', {}, { id: 'c2' }, 'clients.workspace_id, clients.name'],

  ['projects', 'same id', {}, { name: 'Other' }, 'projects.id'],
  ['projects', 'same name in one workspace', {}, { id: 'p2' }, 'projects.workspace_id, projects.name'],

  ['tasks', 'same id', {}, { name: 'Other' }, 'tasks.id'],
  ['tasks', 'same name in one project', {}, { id: 't2' }, 'tasks.project_id, tasks.name'],

  ['project_access', 'same project and user', {}, {}, 'project_access.project_id, project_access.user_id'],

  ['tags', 'same id', {}, { name: 'Other' }, 'tags.id'],
  ['tags', 'same name in one workspace', {}, { id: 'g2' }, 'tags.workspace_id, tags.name'],

  ['active_timers', 'a second timer for one user', {}, { timer_id: 'tm2' }, 'active_timers.user_id'],
  ['active_timers', 'the same timer_id for two users', {}, { user_id: 'a2' }, 'active_timers.timer_id'],

  ['time_entries', 'same id', { timer_id: 'tm1' }, { timer_id: 'tm2' }, 'time_entries.id'],
  ['time_entries', 'the same timer stopped twice', { timer_id: 'tm1' }, { id: 'e2', timer_id: 'tm1' }, 'time_entries.timer_id'],

  ['entry_tags', 'same entry and tag', {}, {}, 'entry_tags.entry_id, entry_tags.tag_id'],

  ['settings', 'same scope and key', {}, {}, 'settings.scope, settings.key'],

  ['admin_mfa', 'same user', {}, {}, 'admin_mfa.user_id'],

  ['admin_grants', 'same token hash', {}, {}, 'admin_grants.token_hash'],

  ['request_log', 'same user and request id', {}, {}, 'request_log.user_id, request_log.request_id'],

  ['audit_log', 'same seq', {}, {}, 'audit_log.seq'],

  ['chain_head', 'a second chain head with the same id', null, {}, 'chain_head.id'],

  ['security_events', 'same id', {}, {}, 'security_events.id'],

  ['export_state', 'same name', {}, {}, 'export_state.name'],

  ['job_runs', 'same id', {}, {}, 'job_runs.id'],

  ['schema_migrations', 'the same version twice', {}, {}, 'schema_migrations.version'],
];

const observedUniques = new Set();

for (const [table, label, first, second, signature] of UNIQUE_CASES) {
  test(`UNIQUE ${table}: ${label}`, () => {
    const err = attempt(() => {
      if (first !== null) insert(table, { ...GOOD[table], ...first });
      insert(table, { ...GOOD[table], ...second });
    });
    assert.ok(err, 'the colliding row must be refused');
    const match = /UNIQUE constraint failed: (.*)$/s.exec(err.message);
    assert.ok(match, `expected a UNIQUE failure, got: ${err.message}`);
    assert.equal(match[1], signature);
    observedUniques.add(match[1]);
  });
}

test('a NULL timer_id may repeat (only a real timer_id is unique), and non-root accounts may repeat is_root = 0', () => {
  assert.equal(attempt(() => {
    insert('time_entries', GOOD.time_entries);
    insert('time_entries', { ...GOOD.time_entries, id: 'e2' });
  }), null);
  assert.equal(attempt(() => {
    insert('accounts', GOOD.accounts);
    insert('accounts', { ...GOOD.accounts, id: 'a2', email: 'two@flink.test' });
    insert('accounts', { ...GOOD.accounts, id: 'a3', email: 'three@flink.test', is_root: 1 });
  }), null, 'one root plus any number of non-root accounts');
});

test('_assert refuses NULL, which is what makes the assert-step pattern work', () => {
  const err = attempt(() => db.exec('INSERT INTO _assert (must_exist) VALUES (NULL)'));
  assert.match(err.message, /NOT NULL constraint failed: _assert\.must_exist/);
});

// ---------------------------------------------------------------- coverage

// Every CHECK( ... ) expression written in the schema, found by matching parentheses.
function checkExpressions(ddl) {
  const found = [];
  const pattern = /\bCHECK\s*\(/g;
  let start;
  while ((start = pattern.exec(ddl)) !== null) {
    let depth = 1;
    let i = pattern.lastIndex;
    while (i < ddl.length && depth > 0) {
      if (ddl[i] === '(') depth += 1;
      if (ddl[i] === ')') depth -= 1;
      i += 1;
    }
    found.push(normal(ddl.slice(pattern.lastIndex, i - 1)));
  }
  return found;
}

// Every uniqueness rule the database enforces: unique indexes (which include PRIMARY KEY and UNIQUE clauses on
// ordinary tables) and INTEGER PRIMARY KEY row ids, written the way SQLite words its failure message.
function uniqueSignatures() {
  const signatures = new Set();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    for (const index of db.prepare(`PRAGMA index_list(${name})`).all()) {
      if (!index.unique) continue;
      const columns = db.prepare(`PRAGMA index_info(${index.name})`).all().map(column => `${name}.${column.name}`);
      signatures.add(columns.join(', '));
    }
    const key = db.prepare(`PRAGMA table_info(${name})`).all().filter(column => column.pk > 0);
    if (key.length === 1 && /^INTEGER$/i.test(key[0].type)) signatures.add(`${name}.${key[0].name}`);
  }
  return signatures;
}

test('coverage: every CHECK in the schema is exercised by a case above', () => {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all();
  const expected = tables.flatMap(({ name, sql }) => checkExpressions(sql).map(expression => `${name}: ${expression}`)).sort();
  assert.equal(expected.length, 41, 'migration 001 has 41 CHECK clauses; update this count only with a new migration');
  assert.equal(new Set(expected).size, 41, 'no table repeats a CHECK');
  assert.deepEqual([...observedChecks].sort(), expected);
});

test('coverage: every UNIQUE / PRIMARY KEY rule in the schema is exercised by a case above', () => {
  const expected = [...uniqueSignatures()].sort();
  assert.ok(expected.length >= 30, `expected dozens of uniqueness rules, found ${expected.length}`);
  assert.deepEqual([...observedUniques].sort(), expected);
});

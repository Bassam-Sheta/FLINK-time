'use strict';

// T1.3 — Migrations.gs: migration 001 and the runner (BUILD_SPEC section 5.1 and its notes).
// The per-constraint tests live in migration-constraints.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv } = require('./helpers/env');
const { thrown } = require('./helpers/asserts');

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'docs', 'v2', 'BUILD_SPEC.md');

// The SQL block of section 5.1, split into statements the way Migrations.gs stores them: no semicolons,
// text otherwise exactly as written in the spec.
function specStatements() {
  const text = fs.readFileSync(SPEC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### 5.1 Migration 001');
  assert.ok(start >= 0, 'section 5.1 not found in BUILD_SPEC.md');
  const open = text.indexOf('```sql', start);
  const close = text.indexOf('```', open + 6);
  return text.slice(open + 6, close).split(';').map(s => s.trim()).filter(Boolean);
}

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const TABLES = [
  '_assert', 'accounts', 'active_timers', 'admin_grants', 'admin_mfa', 'audit_log', 'chain_head', 'clients',
  'entry_tags', 'export_state', 'job_runs', 'project_access', 'projects', 'request_log', 'schema_migrations',
  'security_events', 'settings', 'tags', 'tasks', 'time_entries', 'workspace_members', 'workspaces',
];

const migrate = env => env.ctx.__plain(env.run('Migrations.run_()'));
const schemaOf = env => env.turso.db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()
  .map(row => ({ ...row }));
const rows = (env, sql) => env.turso.db.prepare(sql).all().map(row => ({ ...row }));
const addMigration = (env, migration) => env.run(`MIGRATIONS_ = MIGRATIONS_.concat([${JSON.stringify(migration)}])`);

// ---------------------------------------------------------------- the migration itself

test('MIGRATIONS_ holds migration 001 exactly as BUILD_SPEC section 5.1 writes it', () => {
  const env = createEnv();
  const [first, ...rest] = env.ctx.__plain(env.ctx.MIGRATIONS_);
  assert.equal(rest.length, 0);
  assert.equal(first.version, 1);
  assert.equal(first.name, 'schema v1');
  const expected = specStatements();
  assert.ok(expected.length > 40, 'the spec block should hold dozens of statements, found ' + expected.length);
  assert.deepEqual(first.sql, expected);
});

test('the checksum is sha256 over the statements joined with "\\n;\\n", as hex', () => {
  const env = createEnv();
  const checksum = statements => env.run(`Migrations.checksum_(${JSON.stringify(statements)})`);
  assert.equal(checksum(['A', 'B']), sha256('A\n;\nB'));
  assert.equal(checksum(['only one']), sha256('only one'));
  assert.equal(checksum(['café', 'ñ']), sha256('café\n;\nñ'), 'text is hashed as UTF-8');
  const real = env.ctx.__plain(env.ctx.MIGRATIONS_)[0].sql;
  assert.match(checksum(real), /^[0-9a-f]{64}$/);
  assert.equal(checksum(real), sha256(real.join('\n;\n')));
});

test('validate_ accepts the real list and refuses malformed ones', () => {
  const env = createEnv();
  const check = list => env.run(`Migrations.validate_(${JSON.stringify(list)})`);
  const good = { version: 1, name: 'a', sql: ['CREATE TABLE a (x)'] };
  assert.doesNotThrow(() => env.run('Migrations.validate_(MIGRATIONS_)'));
  assert.doesNotThrow(() => check([good, { version: 2, name: 'b', sql: ['CREATE TABLE b (x)'] }]));
  assert.throws(() => check([]), /at least one/);
  assert.throws(() => check([{ ...good, version: 2 }]), /consecutive from 1/);
  assert.throws(() => check([good, { ...good, version: 3 }]), /consecutive from 1/);
  assert.throws(() => check([good, good]), /consecutive from 1/);
  assert.throws(() => check([{ ...good, name: '' }]), /name/);
  assert.throws(() => check([{ ...good, sql: [] }]), /statements/);
  assert.throws(() => check([{ ...good, sql: ['CREATE TABLE a (x);'] }]), /semicolon/);
  assert.throws(() => check([{ ...good, sql: [''] }]), /empty statement/);
});

// ---------------------------------------------------------------- the runner

test('applies migration 001 from an empty database and records it', () => {
  const env = createEnv();
  const result = migrate(env);
  assert.deepEqual(result, { applied: [1], current: 1 });

  const tables = rows(env, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .map(row => row.name);
  assert.deepEqual(tables, TABLES);

  const [recorded] = rows(env, 'SELECT version, name, checksum, applied_at FROM schema_migrations');
  const statements = env.ctx.__plain(env.ctx.MIGRATIONS_)[0].sql;
  assert.deepEqual({ ...recorded, version: Number(recorded.version), applied_at: Number(recorded.applied_at) }, {
    version: 1, name: 'schema v1', checksum: sha256(statements.join('\n;\n')), applied_at: env.fakes.clock.now(),
  });

  const [head] = rows(env, 'SELECT id, seq, hash, updated_at FROM chain_head');
  assert.deepEqual({ ...head, id: Number(head.id), seq: Number(head.seq), updated_at: Number(head.updated_at) },
    { id: 1, seq: 0, hash: '0'.repeat(64), updated_at: 0 }, 'the chain head is seeded by the migration');
  assert.equal(env.turso.db.isTransaction, false);
});

test('the run is logged to job_runs', () => {
  const env = createEnv();
  env.fakes.clock.set(1762160000000);
  migrate(env);
  const [job] = rows(env, 'SELECT job, started_at, ended_at, status, items, error FROM job_runs');
  assert.deepEqual({ ...job, started_at: Number(job.started_at), ended_at: Number(job.ended_at), items: Number(job.items) },
    { job: 'runMigrations', started_at: 1762160000000, ended_at: 1762160000000, status: 'OK', items: 1, error: null });
});

test('running again is a no-op: one read, no schema change, no new log row', () => {
  const env = createEnv();
  migrate(env);
  const before = { schema: schemaOf(env), migrations: rows(env, 'SELECT * FROM schema_migrations'), jobs: rows(env, 'SELECT * FROM job_runs') };
  const callsBefore = env.fakes.fetch.calls.length;
  env.fakes.clock.advance(60 * 60 * 1000);

  assert.deepEqual(migrate(env), { applied: [], current: 1 });
  assert.equal(env.fakes.fetch.calls.length - callsBefore, 1, 'a rerun only reads schema_migrations');
  assert.deepEqual(schemaOf(env), before.schema);
  assert.deepEqual(rows(env, 'SELECT * FROM schema_migrations'), before.migrations, 'applied_at is not rewritten');
  assert.deepEqual(rows(env, 'SELECT * FROM job_runs'), before.jobs);
});

test('a changed checksum is refused, nothing newer is applied, and the refusal is logged', () => {
  const env = createEnv();
  migrate(env);
  addMigration(env, { version: 2, name: 'later', sql: ['CREATE TABLE later (x INTEGER)'] });
  env.turso.db.exec("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1");

  assert.throws(() => migrate(env), /Migration 1 \(schema v1\).*checksum.*differs/s);
  assert.equal(rows(env, "SELECT name FROM sqlite_master WHERE name = 'later'").length, 0, 'migration 2 must not run');
  const failed = rows(env, "SELECT status, error FROM job_runs WHERE status = 'FAILED'");
  assert.equal(failed.length, 1);
  assert.match(failed[0].error, /checksum/);
});

test('an edited migration in the code is caught the same way', () => {
  const env = createEnv();
  migrate(env);
  env.run("MIGRATIONS_[0].sql[0] = MIGRATIONS_[0].sql[0] + ' '; MIGRATIONS_[0].sql[1] = MIGRATIONS_[0].sql[1].replace('id TEXT', 'id  TEXT')");
  assert.throws(() => migrate(env), /checksum/);
});

test('a database that is ahead of the code, or has a gap, is refused', () => {
  const ahead = createEnv();
  migrate(ahead);
  ahead.turso.db.exec("INSERT INTO schema_migrations VALUES (2, 'from the future', 'x', 0)");
  assert.throws(() => migrate(ahead), /Migration 2 \(from the future\).*does not know/s);

  const gap = createEnv();
  migrate(gap);
  gap.turso.db.exec("DELETE FROM schema_migrations WHERE version = 1; INSERT INTO schema_migrations VALUES (2, 'orphan', 'x', 0)");
  addMigration(gap, { version: 2, name: 'orphan', sql: ['CREATE TABLE orphan (x)'] });
  assert.throws(() => migrate(gap), /applied versions must be 1\.\.n/);
});

test('applies only the pending migrations, in order, each in its own transaction', () => {
  const env = createEnv();
  migrate(env);
  addMigration(env, { version: 2, name: 'second', sql: ['CREATE TABLE second (x INTEGER)', 'CREATE INDEX second_x ON second(x)'] });
  addMigration(env, { version: 3, name: 'third', sql: ['ALTER TABLE second ADD COLUMN y TEXT'] });

  assert.deepEqual(migrate(env), { applied: [2, 3], current: 3 });
  assert.deepEqual(rows(env, 'SELECT version, name FROM schema_migrations ORDER BY version').map(r => [Number(r.version), r.name]),
    [[1, 'schema v1'], [2, 'second'], [3, 'third']]);
  assert.deepEqual(rows(env, "PRAGMA table_info('second')").map(r => r.name), ['x', 'y']);
  const [job] = rows(env, "SELECT items, status FROM job_runs ORDER BY id DESC LIMIT 1");
  assert.deepEqual({ items: Number(job.items), status: job.status }, { items: 2, status: 'OK' });
});

test('a failing statement rolls the whole migration back, names the statement, and is logged', () => {
  const env = createEnv();
  migrate(env);
  addMigration(env, { version: 2, name: 'broken', sql: ['CREATE TABLE half_done (x INTEGER)', 'INSERT INTO nowhere VALUES (1)', 'CREATE TABLE never (x)'] });

  assert.throws(() => migrate(env), /Migration 2 \(broken\) failed at statement 2 of 3.*no such table: nowhere.*rolled back/s);
  const names = rows(env, "SELECT name FROM sqlite_master WHERE name IN ('half_done', 'never')");
  assert.deepEqual(names, [], 'the first statement of the failed migration did not survive');
  assert.deepEqual(rows(env, 'SELECT version FROM schema_migrations').map(r => Number(r.version)), [1]);
  assert.equal(env.turso.db.isTransaction, false);
  const failed = rows(env, "SELECT status, items, error FROM job_runs WHERE status = 'FAILED'");
  assert.equal(failed.length, 1);
  assert.equal(Number(failed[0].items), 0);
  assert.match(failed[0].error, /Migration 2 \(broken\)/);

  // fixing the migration and running again applies it
  env.run("MIGRATIONS_[1].sql = ['CREATE TABLE fixed (x INTEGER)']");
  assert.deepEqual(migrate(env), { applied: [2], current: 2 });
});

test('a failing FIRST migration leaves an empty database (there is no job_runs to log to yet)', () => {
  const env = createEnv();
  env.run("MIGRATIONS_ = [{ version: 1, name: 'bad start', sql: ['CREATE TABLE ok_so_far (x)', 'CREATE TABLE ok_so_far (y)'] }]");
  assert.throws(() => migrate(env), /Migration 1 \(bad start\) failed at statement 2 of 2.*already exists/s);
  assert.deepEqual(rows(env, "SELECT name FROM sqlite_master WHERE type = 'table'"), []);
});

test('"no such table" on the first read means an empty database; other read failures are not swallowed', () => {
  const empty = createEnv();
  assert.deepEqual(migrate(empty), { applied: [1], current: 1 });

  const wrongToken = createEnv();
  wrongToken.fakes.properties.set('TURSO_RW_TOKEN', 'not-a-token');
  assert.throws(() => migrate(wrongToken), /refused.*HTTP 401/s);
  assert.deepEqual(rows(wrongToken, "SELECT name FROM sqlite_master WHERE type = 'table'"), []);

  const noUrl = createEnv();
  noUrl.fakes.properties.set('TURSO_URL', '');
  assert.throws(() => migrate(noUrl), /TURSO_URL/);
});

test('a schema_migrations table that exists but cannot be read is an error, never "empty"', () => {
  // Treating any read failure as an empty database would make the runner try migration 001 again on a live database.
  const env = createEnv();
  migrate(env);
  env.turso.db.exec('ALTER TABLE schema_migrations RENAME COLUMN checksum TO chk');
  const tablesBefore = rows(env, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");

  assert.throws(() => migrate(env), /Could not read schema_migrations: no such column: checksum/);
  assert.deepEqual(rows(env, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"), tablesBefore);
});

// ---------------------------------------------------------------- unknown outcomes

test('a 503 before the migration ran: the error says the outcome is unknown, and a rerun applies it', () => {
  const env = createEnv();
  env.breakNthCall(2, { executeFirst: false });
  assert.throws(() => migrate(env), /HTTP 503.*unknown.*run .*again/s);
  assert.deepEqual(rows(env, "SELECT name FROM sqlite_master WHERE type = 'table'"), []);
  assert.deepEqual(migrate(env), { applied: [1], current: 1 });
});

test('a 503 AFTER the migration ran (response lost): the rerun sees it applied and does nothing', () => {
  const env = createEnv();
  env.breakNthCall(2, { executeFirst: true });
  assert.throws(() => migrate(env), /HTTP 503/);
  assert.equal(rows(env, 'SELECT version FROM schema_migrations').length, 1, 'it did commit');
  assert.deepEqual(migrate(env), { applied: [], current: 1 });
});

test('an unreadable or failed transport is reported, not guessed at', () => {
  const garbage = createEnv();
  garbage.fakes.fetch.garbageNext();
  assert.throws(() => migrate(garbage), /unreadable/);

  const down = createEnv();
  down.fakes.fetch.failNext();
  assert.throws(() => migrate(down), /Could not reach Turso/);
});

// ---------------------------------------------------------------- what is not here

test('runMigrations is public only behind the owner check (ticket T1.11)', () => {
  // Every top-level function without a trailing underscore can be called from the browser through google.script.run,
  // so the owner-only wrapper refuses anybody but the owner. tests/v2/setup.test.js tests the check itself.
  const env = createEnv();
  assert.equal(env.run('typeof runMigrations'), 'function');
  assert.equal(env.run('typeof Migrations.run_'), 'function');
  env.fakes.session.setActiveEmail('visitor@flink.test');
  env.fakes.session.setEffectiveEmail('owner@flink.test');
  const err = thrown(() => env.ctx.runMigrations());
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(env.fakes.fetch.calls.length, 0);
});

/**
 * Migrations.gs - numbered SQL migrations and the runner (BUILD_SPEC section 5.1).
 *
 * Migration 001's statements are copied from BUILD_SPEC.md section 5.1 and tests/v2/migrations.test.js compares them
 * with the spec, so they are not edited here by hand. An applied migration is never edited either: its checksum is
 * stored and the runner refuses to continue if it changes. Change the schema with a new migration.
 *
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * The runner cannot use Db.tx_, which writes to request_log, a table migration 001 creates, and it talks to the owner in
 * the editor rather than returning app error codes. So it keeps its own small sender (send_, arg_). Hashing uses
 * Util.sha256Hex_.
 *
 * There is deliberately no public runMigrations() yet. Every top-level function without a trailing underscore can be
 * called from the browser through google.script.run, so the owner-only wrapper arrives together with its owner check
 * in ticket T1.11.
 */
var MIGRATIONS_ = [
  {
    version: 1,
    name: 'schema v1',
    sql: [
      `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
)`,
      `CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) BETWEEN 3 AND 254),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  role TEXT NOT NULL CHECK (role IN ('USER','ADMIN','SUPER_ADMIN')),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  employee_code TEXT,
  is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
  auth_epoch INTEGER NOT NULL DEFAULT 1,
  admin_ws_limit INTEGER CHECK (admin_ws_limit IS NULL OR admin_ws_limit BETWEEN 0 AND 50),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)`,
      `CREATE UNIQUE INDEX accounts_one_root ON accounts(is_root) WHERE is_root = 1`,
      `CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  timezone TEXT NOT NULL,
  week_start TEXT NOT NULL CHECK (week_start IN ('SUN','MON','SAT')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)`,
      `CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  ws_role TEXT NOT NULL CHECK (ws_role IN ('MEMBER','ADMIN')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  department TEXT, team TEXT, job_title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, user_id)
)`,
      `CREATE INDEX workspace_members_user ON workspace_members(user_id)`,
      `CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, name)
)`,
      `CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  client_id TEXT REFERENCES clients(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  code TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  restricted INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0,1)),
  billable_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_default IN (0,1)),
  hourly_rate_minor INTEGER CHECK (hourly_rate_minor IS NULL OR hourly_rate_minor >= 0),
  cost_rate_minor INTEGER CHECK (cost_rate_minor IS NULL OR cost_rate_minor >= 0),
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  budget_minor INTEGER CHECK (budget_minor IS NULL OR budget_minor >= 0),
  start_date TEXT, end_date TEXT, color TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, name)
)`,
      `CREATE INDEX projects_ws_status ON projects(workspace_id, status)`,
      `CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  estimate_minutes INTEGER CHECK (estimate_minutes IS NULL OR estimate_minutes >= 0),
  billable_default INTEGER CHECK (billable_default IS NULL OR billable_default IN (0,1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (project_id, name)
)`,
      `CREATE INDEX tasks_project ON tasks(project_id)`,
      `CREATE TABLE project_access (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  can_track INTEGER NOT NULL DEFAULT 1 CHECK (can_track IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
)`,
      `CREATE INDEX project_access_user ON project_access(user_id)`,
      `CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, name)
)`,
      `CREATE TABLE active_timers (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id),
  timer_id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  description TEXT NOT NULL DEFAULT '',
  billable INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0,1)),
  tag_ids_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)`,
      `CREATE INDEX active_timers_ws ON active_timers(workspace_id)`,
      `CREATE INDEX active_timers_started ON active_timers(started_at)`,
      `CREATE TABLE time_entries (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  project_id TEXT REFERENCES projects(id),
  task_id TEXT REFERENCES tasks(id),
  description TEXT NOT NULL DEFAULT '',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  duration_s INTEGER NOT NULL,
  local_date TEXT NOT NULL,
  billable INTEGER NOT NULL CHECK (billable IN (0,1)),
  hourly_rate_minor INTEGER,
  cost_rate_minor INTEGER,
  source TEXT NOT NULL CHECK (source IN ('TIMER','MANUAL','IMPORT')),
  stop_reason TEXT CHECK (stop_reason IS NULL OR stop_reason IN ('USER','AUTO_STOP','DEACTIVATION')),
  timer_id TEXT UNIQUE,
  deleted_at INTEGER,
  deleted_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  CHECK (end_at >= start_at),
  CHECK (end_at - start_at <= 86400000),
  CHECK (duration_s = (end_at - start_at) / 1000)
)`,
      `CREATE INDEX time_entries_ws_user_start ON time_entries(workspace_id, user_id, start_at)`,
      `CREATE INDEX time_entries_ws_project_start ON time_entries(workspace_id, project_id, start_at)`,
      `CREATE INDEX time_entries_ws_date ON time_entries(workspace_id, local_date)`,
      `CREATE INDEX time_entries_ws_user_date ON time_entries(workspace_id, user_id, local_date)`,
      `CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES time_entries(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag_id)
)`,
      `CREATE INDEX entry_tags_tag ON entry_tags(tag_id)`,
      `CREATE TABLE settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key)
)`,
      `CREATE TABLE admin_mfa (
  user_id TEXT PRIMARY KEY REFERENCES accounts(id),
  secret_enc TEXT,
  key_version INTEGER,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  last_step INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lockouts_json TEXT NOT NULL DEFAULT '[]',
  hard_locked INTEGER NOT NULL DEFAULT 0 CHECK (hard_locked IN (0,1)),
  backup_hashes_json TEXT NOT NULL DEFAULT '[]',
  enroll_code_hash TEXT,
  enroll_code_expires_at INTEGER,
  pending_secret_enc TEXT,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
)`,
      `CREATE TABLE admin_grants (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('ADMIN','ENROLL','RECOVERY')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stepup_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  auth_epoch INTEGER NOT NULL
)`,
      `CREATE INDEX admin_grants_user ON admin_grants(user_id)`,
      `CREATE TABLE request_log (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
)`,
      `CREATE INDEX request_log_user_time ON request_log(user_id, created_at)`,
      `CREATE TABLE _assert (must_exist INTEGER NOT NULL)`,
      `CREATE TABLE audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_user_id TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  workspace_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  request_id TEXT NOT NULL,
  prev_hash TEXT,
  record_hash TEXT,
  key_version INTEGER,
  sealed_at INTEGER
)`,
      `CREATE INDEX audit_log_ws_seq ON audit_log(workspace_id, seq)`,
      `CREATE INDEX audit_log_unsealed ON audit_log(seq) WHERE sealed_at IS NULL`,
      `CREATE TABLE chain_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`,
      `INSERT INTO chain_head (id, seq, hash, updated_at)
  VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000', 0)`,
      `CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0,1)),
  detail_json TEXT NOT NULL DEFAULT '{}'
)`,
      `CREATE INDEX security_events_ts ON security_events(ts)`,
      `CREATE INDEX security_events_email_ts ON security_events(email, ts)`,
      `CREATE TABLE export_state (
  name TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'IDLE',
  cursor_json TEXT NOT NULL DEFAULT '{}'
)`,
      `CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','OK','PARTIAL','FAILED')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT
)`,
      `CREATE INDEX job_runs_job_started ON job_runs(job, started_at)`
    ]
  }
];

var Migrations = {

  /** The checksum stored with an applied migration: sha256hex(statements.join('\n;\n')). */
  checksum_: function (statements) {
    return Util.sha256Hex_(statements.join('\n;\n'));
  },

  /** Throws unless the list is a usable migration list (versions 1..n, names, statements without semicolons). */
  validate_: function (list) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('MIGRATIONS_ needs at least one migration');
    }
    list.forEach(function (migration, index) {
      var version = migration.version;
      if (version !== index + 1) {
        throw new Error('Migration versions must be consecutive from 1; found ' + version + ' at position ' + (index + 1));
      }
      if (typeof migration.name !== 'string' || migration.name === '') {
        throw new Error('Migration ' + version + ' needs a name');
      }
      if (!Array.isArray(migration.sql) || migration.sql.length === 0) {
        throw new Error('Migration ' + version + ' needs statements');
      }
      migration.sql.forEach(function (statement, n) {
        if (typeof statement !== 'string' || statement.trim() === '') {
          throw new Error('Migration ' + version + ' has an empty statement at position ' + (n + 1));
        }
        if (/;\s*$/.test(statement)) {
          throw new Error('Migration ' + version + ' statement ' + (n + 1) + ' ends with a semicolon; statements are stored without one');
        }
      });
    });
    return list;
  },

  /** Hrana argument for a null, an integer or a string. Temporary; Db.arg_ (T1.4) replaces it. */
  arg_: function (value) {
    if (value === null) return { type: 'null' };
    if (typeof value === 'number' && Number.isSafeInteger(value)) return { type: 'integer', value: String(value) };
    if (typeof value === 'string') return { type: 'text', value: value };
    throw new Error('Migrations.arg_ cannot encode ' + typeof value);
  },

  /** Turso address and read-write token from Script Properties. */
  connection_: function () {
    var properties = PropertiesService.getScriptProperties();
    var url = properties.getProperty('TURSO_URL');
    var token = properties.getProperty('TURSO_RW_TOKEN');
    if (!url) throw new Error('TURSO_URL is not set in Script Properties');
    if (!token) throw new Error('TURSO_RW_TOKEN is not set in Script Properties');
    return { url: String(url).replace(/\/+$/, ''), token: token };
  },

  /**
   * One pipeline call (BUILD_SPEC section 5.2): the requests plus a closing "close", so Turso rolls back anything
   * left uncommitted. Returns the "results" array. Never puts the token in an error message.
   */
  send_: function (conn, requests) {
    var response;
    try {
      response = UrlFetchApp.fetch(conn.url + '/v2/pipeline', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + conn.token },
        payload: JSON.stringify({ requests: requests.concat([{ type: 'close' }]) }),
        muteHttpExceptions: true
      });
    } catch (err) {
      throw new Error('Could not reach Turso (' + err.message + '). The outcome is unknown; run again to resume.');
    }
    var status = response.getResponseCode();
    if (status === 400 || status === 401 || status === 403 || status === 404) {
      throw new Error('Turso refused the request (HTTP ' + status + '). Nothing was applied; check TURSO_URL and TURSO_RW_TOKEN.');
    }
    if (status !== 200) {
      throw new Error('Turso answered HTTP ' + status + '. The outcome is unknown; run again to resume.');
    }
    var parsed;
    try {
      parsed = JSON.parse(response.getContentText());
    } catch (err) {
      throw new Error('Turso sent an unreadable response. The outcome is unknown; run again to resume.');
    }
    if (!parsed || !Array.isArray(parsed.results)) {
      throw new Error('Turso sent an unexpected response. The outcome is unknown; run again to resume.');
    }
    return parsed.results;
  },

  /** Plain value of one typed Hrana cell. */
  value_: function (cell) {
    if (cell.type === 'null') return null;
    if (cell.type === 'integer') {
      var number = Number(cell.value);
      if (!Number.isSafeInteger(number)) throw new Error('Integer outside the safe range: ' + cell.value);
      return number;
    }
    return cell.value;
  },

  /** The applied migrations, oldest first. A missing schema_migrations table means an empty database. */
  readApplied_: function (conn) {
    var results = Migrations.send_(conn, [
      { type: 'execute', stmt: { sql: 'SELECT version, name, checksum FROM schema_migrations ORDER BY version' } }
    ]);
    var first = results[0];
    if (first.type === 'error') {
      if (/no such table/i.test(first.error.message)) return [];
      throw new Error('Could not read schema_migrations: ' + first.error.message);
    }
    return first.response.result.rows.map(function (row) {
      return { version: Migrations.value_(row[0]), name: Migrations.value_(row[1]), checksum: Migrations.value_(row[2]) };
    });
  },

  /** Refuses a database this code cannot safely continue: gaps, unknown versions, changed checksums. */
  checkApplied_: function (migrations, applied) {
    applied.forEach(function (row, index) {
      if (row.version !== index + 1) {
        throw new Error('The applied versions must be 1..n with no gaps; found ' + row.version + ' at position ' + (index + 1));
      }
    });
    applied.forEach(function (row) {
      var migration = migrations[row.version - 1];
      if (!migration) {
        throw new Error('Migration ' + row.version + ' (' + row.name + ') is applied in the database but this code does not know it; deploy the newer code first');
      }
      if (row.checksum !== Migrations.checksum_(migration.sql)) {
        throw new Error('Migration ' + row.version + ' (' + row.name + '): the stored checksum differs from this code. Never edit an applied migration; add a new one');
      }
    });
  },

  /**
   * Applies one migration as one transaction batch: BEGIN IMMEDIATE, the statements, the schema_migrations row,
   * COMMIT, and a ROLLBACK that runs only if COMMIT did not succeed. Every step after BEGIN runs only if the step
   * before it succeeded (BUILD_SPEC sections 5.1 and 5.2).
   */
  apply_: function (conn, migration) {
    var count = migration.sql.length;
    var steps = [{ stmt: { sql: 'BEGIN IMMEDIATE' } }];
    var after = function (stmt) {
      steps.push({ condition: { type: 'ok', step: steps.length - 1 }, stmt: stmt });
    };
    migration.sql.forEach(function (sql) { after({ sql: sql }); });
    after({
      sql: 'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
      args: [
        Migrations.arg_(migration.version), Migrations.arg_(migration.name),
        Migrations.arg_(Migrations.checksum_(migration.sql)), Migrations.arg_(Date.now())
      ]
    });
    after({ sql: 'COMMIT' });
    var commitIndex = steps.length - 1;
    steps.push({ condition: { type: 'not', cond: { type: 'ok', step: commitIndex } }, stmt: { sql: 'ROLLBACK' } });

    var first = Migrations.send_(conn, [{ type: 'batch', batch: { steps: steps } }])[0];
    var label = 'Migration ' + migration.version + ' (' + migration.name + ')';
    if (first.type === 'error') {
      throw new Error(label + ' was rejected by Turso: ' + first.error.message);
    }
    var outcome = first.response.result;
    for (var i = 0; i < outcome.step_errors.length; i++) {
      var failure = outcome.step_errors[i];
      if (failure === null) continue;
      var where = i === 0 ? 'BEGIN IMMEDIATE'
        : i <= count ? 'statement ' + i + ' of ' + count
        : i === count + 1 ? 'the schema_migrations insert'
        : 'COMMIT';
      throw new Error(label + ' failed at ' + where + ': ' + failure.message + '. ' +
        (i === 0 ? 'Nothing was applied.' : 'The transaction was rolled back.'));
    }
    if (outcome.step_results[commitIndex] === null) {
      throw new Error(label + ' did not commit');
    }
  },

  /** Best-effort row in job_runs. Before migration 001 has run there is no such table, so a failure here is ignored. */
  log_: function (conn, startedAt, status, items, error) {
    try {
      Migrations.send_(conn, [{
        type: 'execute',
        stmt: {
          sql: "INSERT INTO job_runs (job, started_at, ended_at, status, items, error) VALUES ('runMigrations', ?, ?, ?, ?, ?)",
          args: [
            Migrations.arg_(startedAt), Migrations.arg_(Date.now()), Migrations.arg_(status), Migrations.arg_(items),
            Migrations.arg_(error === null ? null : String(error).slice(0, 1000))
          ]
        }
      }]);
    } catch (err) {
      console.error('Could not write the job_runs row: ' + err.message);
    }
  },

  /**
   * Applies every pending migration in order and returns { applied: [versions], current }. Safe to run again: it
   * reads schema_migrations first, so after a lost response it simply finds the work done. Logs to job_runs when it
   * applied something or failed.
   */
  run_: function () {
    var startedAt = Date.now();
    var conn = Migrations.connection_();
    var applied = [];
    var total = 0;
    try {
      var migrations = Migrations.validate_(MIGRATIONS_);
      var present = Migrations.readApplied_(conn);
      Migrations.checkApplied_(migrations, present);
      migrations.slice(present.length).forEach(function (migration) {
        Migrations.apply_(conn, migration);
        applied.push(migration.version);
      });
      total = migrations.length;
    } catch (err) {
      Migrations.log_(conn, startedAt, 'FAILED', applied.length, err.message);
      throw err;
    }
    if (applied.length > 0) {
      Migrations.log_(conn, startedAt, 'OK', applied.length, null);
    }
    return { applied: applied, current: total };
  }
};

# FLINK Time v1 — Build Spec

Nov 3, 2026 · companion to *FLINK Time — Turso Migration Plan* (the plan says **why**; this spec says **exactly what to build**). Where they disagree, this spec wins and the plan must be corrected.

Read sections 0–3 before writing any code. Then work through section 12 one ticket at a time, in order.

## 0. Rules for the implementer

1. **Work one ticket at a time** (section 12). A ticket is done only when its tests pass in `npm run test:v2` and its "Done when" list holds. Commit after each ticket. Don't start the next ticket with the current one red.
2. **Never edit the old app.** `apps-script/`, `tests/*.test.js` (top level), `installer/` and `storage-v2/` stay as they are until Phase 7. All new code goes into `apps-script-v2/` and `tests/v2/`. The old CI jobs must keep passing.
3. **Tests first** for every server rule, permission and SQL statement. Tests run on Node 24 against a local SQLite that speaks Turso's wire protocol (section 10), so nothing needs Google or Turso to pass.
4. **No guessing at platform behaviour.** If something depends on how Turso or Apps Script behaves and Phase 0 hasn't recorded it in `docs/v2/phase0-results.md`, stop and ask.
5. **Copy from the old code only where the plan or this spec says so** (section 11). Don't port anything else; v1 deliberately drops timesheets, approvals, passwords, Cloud KMS, rollups, yearly files, admin requests, saved dashboards, WFH and manual entries.
6. **Secrets never go in code, tests, fixtures or commits.** Tests use made-up values such as `test-rw-token`.
7. **No new runtime dependencies.** Apps Script code uses only built-in services. Dev dependencies may be added only if a ticket says so.
8. **Ask, don't improvise**, when a ticket is ambiguous, a test can't be written as specified, or a limit in this spec turns out wrong. Write the question at the top of `docs/v2/questions.md` and stop.

## 1. Decisions in force

| ID | Decision | Effect on the build |
| --- | --- | --- |
| D1 | No existing data to migrate (2026-11-03) | No Phase 6. The database starts empty; the owner becomes the root Super Admin at setup |
| D2 | v1 ships **tags** and **live view**. No manual entries, WFH, admin requests, saved reports or dashboards, scheduled reports, alerts or comments (2026-11-03) | Entries are created only by the timer. No `work_mode` columns. `time_entries.source` is always `TIMER` in v1 |
| D3 | One database with a `workspace_id` column (plan recommendation, adopted) | Every workspace query takes `workspace_id` |
| D4 | Turso tokens: 120-day expiry, rotated every 90 days, `invalidate` only in an emergency (plan section 8, adopted) | Health job decodes token expiry |
| D5 | Entries count on their start date in the workspace timezone (plan proposal, adopted) | `local_date` is fixed when the timer starts and copied to the entry |
| D6 | A Super Admin sets each Admin's limit on active workspaces they administer (2026-11-03) | `accounts.admin_ws_limit`; NULL means the global default setting `ADMIN_MAX_ACTIVE_WORKSPACES` (3) |
| D7 | Turso free plan permanently (2026-11-03) | No support contract: backups, restore drills and the health job's usage warnings are mandatory, not optional |
| — | Project access becomes **per project** (change from today's code) | Today, adding one access row anywhere restricts every project in the workspace for all users. In v1 each project has `restricted` (0/1): 0 = every active member may track; 1 = only users with a `project_access` row with `can_track = 1`. Admins and Super Admins are never restricted |
| — | The v1 portal is written fresh, not edited from the 6,579-line `Portal.html` | It reuses the old CSS look and `vendor/nayuki-qr.js`. One template still serves all three views |
| — | Description rule key is `REQUIRE_DESCRIPTION`; edit window key is `PAST_ENTRY_EDIT_DAYS` | Today's code mixes `RULE_DESC_REQUIRED`/`REQUIRE_DESCRIPTION` and `PAST_ENTRY_EDIT_DAYS`/`ENTRY_EDIT_WINDOW_DAYS`. v1 uses only the two keys named here |

## 2. Repository layout

```
apps-script-v2/
  files.json              ordered upload list (section 2.1)
  appsscript.template.json manifest with {{TURSO_ORIGIN}} placeholder
  Config.gs               constants, error codes, settings catalog
  Util.gs                 ids, time, canonical JSON, hashing, HMAC, hex
  Db.gs                   Turso HTTP client, transaction builder
  Cache.gs                CacheService wrapper with generation keys
  Validate.gs             payload schema checker, formula neutraliser
  Auth.gs                 identity, account loading, permission map, server rules
  Totp.gs                 TOTP, enrollment codes, backup codes, secret cipher
  Grants.gs               admin grants, step-up
  Audit.gs                audit row builder, sealer, verifier, checkpoint
  ActWorkspaces.gs        workspaces.*, members.*
  ActCatalog.gs           clients.*, projects.*, tasks.*, projectAccess.*, tags.*
  ActTimer.gs             timer.*
  ActEntries.gs           entries.*
  ActReports.gs           reports.*
  ActUsers.gs             users.*
  ActSystem.gs            app.bootstrap, auth.*, live.list, settings.*, audit.*, security.*, system.*
  Jobs.gs                 all time-trigger entry points
  Migrations.gs           numbered SQL migrations and the runner
  Setup.gs                owner-only first-run page and owner functions
  Main.gs                 doGet, handleClientRequest, dispatcher
  Portal.html             the page template (section 9)
tests/v2/
  helpers/load-app.js     loads apps-script-v2/*.gs into one vm context, with fakes
  helpers/fakes.js        Session, CacheService, LockService, PropertiesService, Utilities, MailApp, HtmlService, ScriptApp, DriveApp, SpreadsheetApp
  helpers/fake-turso.js   Turso HTTP v2 pipeline on node:sqlite (section 10)
  helpers/seed.js         builds a seeded database for tests
  *.test.js
docs/v2/
  phase0-results.md       filled in during Phase 0
  questions.md            open questions from the implementer
phase0/                   throwaway Apps Script project for the proof tests (section 13)
```

### 2.1 Code shape rules

- Apps Script loads every `.gs` file into one global scope, in the order of the project's file list. **Top-level code may only define things**: each file declares one or more `var Name = { ... }` objects or `function name_() {}` declarations. No top-level calls, no reads of properties or caches, no work. This keeps load time low (plan section 7) and makes file order irrelevant.
- `files.json` lists the files in the order above. The staging tool (ticket T1.12) and `load-app.js` both read it.
- Private helpers end in `_` (Apps Script hides them from `google.script.run`). The only public server functions are `doGet`, `handleClientRequest` and the owner functions in `Setup.gs` and `Jobs.gs` listed in section 8.
- Size budget, enforced by a test: all `.gs` files together under 300 KB; `Portal.html` under 150 KB.

### 2.2 `package.json` and CI changes (ticket T1.1)

- Add script `"test:v2": "node --test tests/v2/"`. Leave `"test"` unchanged.
- Add a CI job `v2-tests` to `.github/workflows/stabilization-tests.yml` using **Node 24** (needs `node:sqlite`), running `npm ci --ignore-scripts` then `npm run test:v2`. Pin actions by commit SHA like the existing jobs.
- No new dependencies. `node:sqlite` (`DatabaseSync`) is built into Node 24.

## 3. Conventions

| Thing | Rule |
| --- | --- |
| IDs | `Util.id_()` returns `Utilities.getUuid()` lowercased, no braces. Stored as TEXT |
| Times | Integer Unix milliseconds UTC, from `Date.now()` on the server. Column names end in `_at` |
| Local dates | `YYYY-MM-DD` text in the workspace timezone, from `Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd')` |
| Durations | `duration_s = Math.floor((end_at - start_at) / 1000)`, which equals SQLite's integer division in the CHECK |
| Money | Integer minor units (piastres). Totals: `SUM(duration_s * rate_minor) / 3600`, integer division at the end |
| Booleans | INTEGER 0/1 in SQL; `true`/`false` in JSON |
| Text limits | Names 1–120 chars, codes 1–20 chars `[A-Z0-9_-]`, descriptions 0–500 chars, notes 0–2,000 chars. Trim; reject control characters except tab and newline in notes and descriptions |
| JSON in columns | Canonical JSON (`Util.canonicalJson_`: sorted keys, no spaces, integers as plain numbers) |
| Versions | Every mutable row has `version INTEGER NOT NULL DEFAULT 1`; every update sets `version = version + 1` and asserts the expected version |
| Errors | Throw `new AppError_(code, message, details)`; `Main` turns it into the response contract. Codes are only those in section 4.3 |
| Logging | `console.log` of action, duration and outcome per request; never payloads, emails of others or tokens |

## 4. Request and response contract

### 4.1 Envelope

The page calls `google.script.run.handleClientRequest(action, envelope)`:

```json
{
  "v": 1,
  "requestId": "uuid — required for write actions, absent for reads",
  "workspaceId": "id or null",
  "grant": "admin grant token or absent",
  "payload": { }
}
```

### 4.2 Response

Always returned, never thrown:

```json
{ "ok": true, "data": { }, "serverNow": 1762160000000 }
{ "ok": false, "code": "CONFLICT", "message": "Someone changed this; reload.", "retryable": false, "details": { } }
```

### 4.3 Error codes

| Code | Retryable | When |
| --- | --- | --- |
| `AUTH_UNAVAILABLE` | no | `Session.getActiveUser().getEmail()` is blank |
| `NOT_PROVISIONED` | no | Domain matches but no account row |
| `ACCOUNT_INACTIVE` | no | Account status is `INACTIVE` |
| `FORBIDDEN` | no | Role, membership, ownership or rule check failed; also wrong domain |
| `CODE_REQUIRED` | no | Admin action without a valid grant |
| `STEP_UP_REQUIRED` | no | Step-up action and the grant's `stepup_at` is older than 5 minutes |
| `LOCKED_OUT` | no | Code entry is locked; `details.until` (ms) or `details.hard: true` |
| `VALIDATION` | no | Payload fails its schema; `details.field` names the first bad field |
| `POLICY` | no | An entry rule blocked it; `details.rule` is the setting key |
| `NOT_FOUND` | no | The row doesn't exist or is outside the caller's scope (never reveal which) |
| `CONFLICT` | no | Version mismatch, or a uniqueness rule (timer already running, duplicate name) |
| `RATE_LIMITED` | yes, after 60 s | More than `RATE_LIMIT_WRITES_PER_MIN` writes in the last minute |
| `BUSY` | yes | Turso reported the database busy or locked |
| `DB_UNAVAILABLE` | yes | Fetch failed, non-200 response, or unknown outcome |
| `INTERNAL` | no | Anything else; message is generic, details logged with a correlation id |

### 4.4 Request pipeline (`Main.handleClientRequest`)

Exactly this order; each step is a function in `Auth.gs` or `Main.gs` with its own tests:

1. Look up `action` in `ACTIONS` (section 6). Unknown → `FORBIDDEN`.
2. `email = Session.getActiveUser().getEmail()`. Blank → `AUTH_UNAVAILABLE`.
3. Normalise: trim, lowercase. Domain = text after the **last** `@`; must equal Script Property `COMPANY_DOMAIN` exactly → else `FORBIDDEN`.
4. Load the account by email (cache 60 s, key `acct:{gen}:{email}`). Missing → `NOT_PROVISIONED`. Inactive → `ACCOUNT_INACTIVE`.
5. Role check against `ACTIONS[action].roles` → `FORBIDDEN`.
6. If the action has `ws: true`: `envelope.workspaceId` required; the caller must be an active member of an active workspace (archived allowed only for `readOnlyOk` actions), from the cached memberships (60 s). Workspace-admin actions additionally need `ws_role = 'ADMIN'` and account role ADMIN or SUPER_ADMIN, except SUPER_ADMIN, who passes every workspace check.
7. If `grant: true`: validate the admin grant (section 7.3) → `CODE_REQUIRED`. If `stepUp: true` (or the handler asks for it, e.g. editing someone else's entry): `STEP_UP_REQUIRED` unless `stepup_at` is within 5 minutes.
8. Validate `payload` against `ACTIONS[action].schema` (section 6.1) → `VALIDATION`.
9. For writes: `requestId` must be a UUID → `VALIDATION`. `payloadHash = sha256hex(canonicalJson(payload))`.
10. Call the handler with `ctx = { user, memberships, workspace, grant, payload, requestId, payloadHash, now }`.
11. Wrap the result in the response contract; log one line.

Ownership and every fact that lives in the database (project active, task belongs to project, tag valid, version matches) are checked **inside the write transaction as assert steps** (section 5.3), not by a separate read first.

## 5. Database

### 5.1 Migration 001 — schema v1

`Migrations.gs` holds an array `MIGRATIONS_ = [{ version: 1, name: 'schema v1', sql: [ ...statements ] }]`. The checksum is `sha256hex(statements.join('\n;\n'))`. Copy these statements exactly:

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

CREATE TABLE accounts (
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
);
CREATE UNIQUE INDEX accounts_one_root ON accounts(is_root) WHERE is_root = 1;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  timezone TEXT NOT NULL,
  week_start TEXT NOT NULL CHECK (week_start IN ('SUN','MON','SAT')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  ws_role TEXT NOT NULL CHECK (ws_role IN ('MEMBER','ADMIN')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  department TEXT, team TEXT, job_title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user ON workspace_members(user_id);

CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  notes TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, name)
);

CREATE TABLE projects (
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
);
CREATE INDEX projects_ws_status ON projects(workspace_id, status);

CREATE TABLE tasks (
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
);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE project_access (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES accounts(id),
  can_track INTEGER NOT NULL DEFAULT 1 CHECK (can_track IN (0,1)),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_access_user ON project_access(user_id);

CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  color TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  UNIQUE (workspace_id, name)
);

CREATE TABLE active_timers (
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
);
CREATE INDEX active_timers_ws ON active_timers(workspace_id);
CREATE INDEX active_timers_started ON active_timers(started_at);

CREATE TABLE time_entries (
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
);
CREATE INDEX time_entries_ws_user_start ON time_entries(workspace_id, user_id, start_at);
CREATE INDEX time_entries_ws_project_start ON time_entries(workspace_id, project_id, start_at);
CREATE INDEX time_entries_ws_date ON time_entries(workspace_id, local_date);
CREATE INDEX time_entries_ws_user_date ON time_entries(workspace_id, user_id, local_date);

CREATE TABLE entry_tags (
  entry_id TEXT NOT NULL REFERENCES time_entries(id),
  tag_id TEXT NOT NULL REFERENCES tags(id),
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag_id)
);
CREATE INDEX entry_tags_tag ON entry_tags(tag_id);

CREATE TABLE settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (scope, key)
);

CREATE TABLE admin_mfa (
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
);

CREATE TABLE admin_grants (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL CHECK (kind IN ('ADMIN','ENROLL','RECOVERY')),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  stepup_at INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER,
  auth_epoch INTEGER NOT NULL
);
CREATE INDEX admin_grants_user ON admin_grants(user_id);

CREATE TABLE request_log (
  user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
);
CREATE INDEX request_log_user_time ON request_log(user_id, created_at);

CREATE TABLE _assert (must_exist INTEGER NOT NULL);

CREATE TABLE audit_log (
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
);
CREATE INDEX audit_log_ws_seq ON audit_log(workspace_id, seq);
CREATE INDEX audit_log_unsealed ON audit_log(seq) WHERE sealed_at IS NULL;

CREATE TABLE chain_head (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
INSERT INTO chain_head (id, seq, hash, updated_at)
  VALUES (1, 0, '0000000000000000000000000000000000000000000000000000000000000000', 0);

CREATE TABLE security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT,
  user_id TEXT,
  event_type TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0,1)),
  detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX security_events_ts ON security_events(ts);
CREATE INDEX security_events_email_ts ON security_events(email, ts);

CREATE TABLE export_state (
  name TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'IDLE',
  cursor_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('RUNNING','OK','PARTIAL','FAILED')),
  cursor_json TEXT NOT NULL DEFAULT '{}',
  items INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX job_runs_job_started ON job_runs(job, started_at);
```

Notes:

- `REFERENCES` clauses document intent. **Code must not depend on foreign keys being enforced.** Phase 0 test 5 records whether Turso enforces them; either way, existence is checked by assert steps.
- `time_entries.timer_id UNIQUE` makes a stop applied twice impossible even if request ids differ.
- No `work_mode` columns (D2). `source` keeps `MANUAL` and `IMPORT` so v2 can add them without rebuilding the table; v1 writes only `TIMER`.
- The migration runner (owner-only `runMigrations()`): reads `schema_migrations` (treat "no such table" as empty), refuses if any applied checksum differs, applies each pending migration as one transaction batch (`BEGIN IMMEDIATE`, statements, the `schema_migrations` insert, `COMMIT`, conditional `ROLLBACK`), and logs to `job_runs`.

### 5.2 Turso HTTP protocol (what `Db.gs` sends)

Base URL: Script Property `TURSO_URL` in `https://` form (convert `libsql://` at setup). Every call is:

```
POST {TURSO_URL}/v2/pipeline
Authorization: Bearer {TURSO_RW_TOKEN or TURSO_RO_TOKEN}
Content-Type: application/json
muteHttpExceptions: true
```

Request body (no baton, so each call is its own stream; the trailing `close` ends it and Turso rolls back anything uncommitted):

```json
{
  "requests": [
    { "type": "batch", "batch": { "steps": [
      { "stmt": { "sql": "BEGIN IMMEDIATE" } },
      { "condition": { "type": "ok", "step": 0 },
        "stmt": { "sql": "INSERT INTO request_log (...) VALUES (?, ?, ?, ?, ?, ?)",
                  "args": [ { "type": "text", "value": "u1" }, { "type": "integer", "value": "1762160000000" } ] } },
      { "condition": { "type": "ok", "step": 1 }, "stmt": { "sql": "COMMIT" } },
      { "condition": { "type": "not", "cond": { "type": "ok", "step": 2 } }, "stmt": { "sql": "ROLLBACK" } }
    ] } },
    { "type": "close" }
  ]
}
```

Argument encoding (`Db.arg_(v)`): `null`/`undefined` → `{"type":"null"}`; integer (`Number.isSafeInteger`) → `{"type":"integer","value":"<decimal string>"}`; other number → `{"type":"float","value":<number>}`; boolean → integer 0/1; string → `{"type":"text","value":...}`. Anything else throws.

Response: `results[0]` is `{ "type": "ok", "response": { "type": "batch", "result": { "step_results": [...], "step_errors": [...] } } }` or `{ "type": "error", "error": { "message", "code" } }`. Each step result has `cols` (`[{name}]`), `rows` (arrays of typed values), `affected_row_count`, `rows_read`, `rows_written`. Decode values: `integer` → `Number(value)` (throw if not a safe integer), `float` → number, `text` → string, `null` → null, `blob` → refuse.

Phase 0 test 4 confirms this shape; if anything differs, fix `Db.gs` and this section together.

### 5.3 `Db.gs` API

```js
Db.read_(statements, opts)       // statements: [{sql, args}] → array of row arrays (objects keyed by column)
                                 // one pipeline, one "batch" with no BEGIN, each step unconditional
                                 // opts.token: 'ro' (default) | 'rw'
Db.tx_(ctx)                      // returns a builder; ctx = {userId, requestId, action, payloadHash, now}
  .assert(label, conditionSql, args, code, message)
       // emits: INSERT INTO _assert (must_exist) SELECT NULL WHERE NOT (<conditionSql>)
       // the step fails (NOT NULL constraint) exactly when the condition is false
  .exec(label, sql, args, onError)    // onError: {code, message} used if this step errors
  .select(label, sql, args)           // a read inside the transaction; rows returned in the result
  .audit(row)                         // appends INSERT INTO audit_log (...) for an audit row (section 5.5)
  .result(obj)                        // the response data stored in request_log.result_json
  .commit()                           // one HTTP call; returns {ok:true, selects:{label: rows}} or throws AppError_
```

`commit()` builds steps in this order: `BEGIN IMMEDIATE` → `request_log` insert → rate-limit assert (skipped for `userId = 'SYSTEM'`) → the caller's steps in the order added → audit inserts → `COMMIT` → `ROLLBACK` if `COMMIT` did not succeed. Every step after `BEGIN` has condition "previous step ok".

Mapping a failure: find the first step with a non-null `step_errors[i]`.

- Step 1 (`request_log`): duplicate. Read `SELECT action, payload_sha256, result_json FROM request_log WHERE user_id = ? AND request_id = ?` with the rw token. Same action and hash → return `{duplicate: true, result: JSON.parse(result_json)}` (the handler re-runs its read if it needs fresh rows). Otherwise `VALIDATION` "request id reused".
- Rate-limit step → `RATE_LIMITED`.
- An `assert` step → its `code` and `message`.
- An `exec` step → its `onError`, or `CONFLICT` if the error message contains `UNIQUE constraint failed`, else `INTERNAL`.
- `BEGIN` error or a message containing `SQLITE_BUSY` / `database is locked` → `BUSY`.
- HTTP failure, non-200 status, or a response that can't be parsed → `DB_UNAVAILABLE` (the outcome is unknown; the page retries with the same request id).

Rate-limit assert condition: `(SELECT COUNT(*) FROM request_log WHERE user_id = ? AND created_at > ?) <= ?` with `now - 60000` and the setting `RATE_LIMIT_WRITES_PER_MIN`.

Internal writes (failed-code counters, `last_seen_at`, security events, jobs) also go through `tx_`, with a derived request id so they stay idempotent: `{requestId}:fail`, `seen:{tokenHash}:{minute}`, `sec:{uuid}`, `autostop:{timerId}`, `seal:{from}-{to}`. Jobs use `userId = 'SYSTEM'`.

`request_log.result_json` must be known before the call, so handlers create every id and timestamp in Apps Script. A handler that needs values computed by SQL (for example the stopped entry) adds a `.select()` after its writes, returns those rows, and stores only ids in `result()`.

Usage counters: after every call, add the summed `rows_read` and `rows_written` to a per-day counter in `CacheService` (`usage:{yyyy-mm-dd}`); the health job copies it into `job_runs`.

### 5.4 Cache keys

| Key | Value | TTL | Invalidated by |
| --- | --- | --- | --- |
| `gen:acct` | integer | 6 h | any change to accounts or memberships (increment) |
| `acct:{gen}:{email}` | account row plus memberships | 60 s | `gen:acct` |
| `gen:ws:{wsId}` | integer | 6 h | any catalog, tag, member or settings change in that workspace |
| `cat:{wsId}:{gen}` | projects, tasks, clients, tags, project access (≤ 90 KB, else not cached) | 5 min | `gen:ws:{wsId}` |
| `grant:{hash}` | grant row | 60 s | deleted on revoke or logout |
| `live:{wsId}` | live view rows | 60 s | time only |
| `rep:{wsId}:{gen}:{sha256(params+user scope)}` | report result (≤ 90 KB) | 5 min | `gen:ws:{wsId}` and `gen:rep:{wsId}`, which every entry or timer write in that workspace increments |
| `settings:{gen}` | merged settings | 5 min | `gen:settings` |

`Cache.gen_(name)` reads a generation (0 if missing); `Cache.bump_(name)` increments it with `put(name, n+1, 21600)`. A lost increment only makes a stale entry live up to its TTL, which is acceptable for every key above.

### 5.5 Audit rows and the sealer

An audit row is built by `Audit.row_(ctx, {entityType, entityId, action, before, after, reason, workspaceId})`; `before`/`after` are passed through `Audit.redact_()` (drops any key in `['secret_enc','pending_secret_enc','backup_hashes_json','enroll_code_hash','token_hash']`) and stored as canonical JSON. `actor_user_id` is the caller's id or `SYSTEM`; `ts` is `ctx.now`.

Sealer (`Jobs.sealAudit`, every minute, under `LockService.getScriptLock().tryLock(0)`; skip if not acquired):

1. One read pipeline: `SELECT seq, hash FROM chain_head WHERE id = 1` and `SELECT * FROM audit_log WHERE sealed_at IS NULL ORDER BY seq LIMIT 200`.
2. Nothing unsealed → done.
3. If the first unsealed `seq` is not `head.seq + 1`, or the list has a gap: write a `security_events` row `AUDIT_SEQ_GAP` with the missing range, email `ALERT_EMAIL`, and keep sealing (the chain links across the gap; the gap stays on record).
4. For each row in order: `canonical = Util.canonicalJson_([String(seq), String(ts), actor_user_id, actor_role, workspace_id, entity_type, entity_id, action, before_json, after_json, reason, request_id])` (integers as decimal strings, nulls as `null`), `record_hash = hex(HMAC_SHA256(AUDIT_HMAC_KEY_v{n}, prev_hash + '\n' + canonical))`, then `prev_hash = record_hash`.
5. One transaction: assert `chain_head.seq = expected`, one `UPDATE audit_log SET prev_hash = ?, record_hash = ?, key_version = ?, sealed_at = ? WHERE seq = ? AND sealed_at IS NULL` per row, `UPDATE chain_head`, commit. Use `userId = 'SYSTEM'`, `requestId = 'seal:' + firstSeq + '-' + lastSeq`.
6. On success, write Script Property `CHAIN_CHECKPOINT = {"seq":..,"hash":..,"at":..}` only if the new seq is greater than the stored one.

Verifier (`Audit.verify_(fromSeq)`): re-reads sealed rows in pages of 1,000, recomputes each hash, checks `prev_hash` links and that `CHAIN_CHECKPOINT.seq` ≤ head seq and its hash matches the row at that seq. Any mismatch → security event, alert email, Super Admin banner flag in Script Properties (`ALARM_AUDIT = 1`).

## 6. Actions

### 6.1 Permission map format

`Auth.gs` defines one object; tests are generated from it (ticket T1.9):

```js
var ACTIONS = {
  'timer.start': {
    roles: ['USER', 'ADMIN', 'SUPER_ADMIN'],
    ws: true,            // needs envelope.workspaceId and active membership
    wsAdmin: false,      // needs workspace admin rights
    grant: false,        // needs a valid admin grant
    stepUp: false,       // needs a fresh code (or the handler decides, see "Step-up")
    write: true,         // needs requestId; goes through Db.tx_
    readOnlyOk: false,   // allowed on archived workspaces
    schema: { projectId: 'id?', taskId: 'id?', description: 'text:0:500?', billable: 'bool?', tagIds: 'ids:10?', clientAt: 'ms' },
    handler: 'ActTimer.start_'
  }
};
```

Schema types: `id` (UUID), `ids:N` (array of up to N unique UUIDs), `text:MIN:MAX`, `code` (`[A-Z0-9_-]{1,20}`), `email`, `bool`, `int:MIN:MAX`, `ms` (integer ms within ±10 years of now), `date` (`YYYY-MM-DD`, a real date), `enum:A|B|C`, `tz` (accepted by `Utilities.formatDate`), `cursor` (opaque string ≤ 200 chars). A trailing `?` makes the field optional. Unknown fields → `VALIDATION`.

### 6.2 Catalogue

"WA" means workspace admin of `workspaceId`; "SA" means Super Admin. "Own" means the row's `user_id` is the caller. Every write action produces the audit actions listed.

**Session and admin codes** (every `auth.*` action except `auth.status` is a write: it needs a `requestId` and goes through `Db.tx_`)

| Action | Roles | ws | grant / step-up | Payload | Does | Turso calls |
| --- | --- | --- | --- | --- | --- | --- |
| `app.bootstrap` | all | optional | — | `view: enum:user\|admin\|superadmin` | Returns `me`, `workspaces` (id, name, timezone, weekStart, wsRole, status), `currentWorkspaceId` (the timer's workspace, else the first active), `timer` or null, `catalog` for the current workspace (active projects the caller may track, their active tasks, active tags, clients for admins), `policy` (the rule flags), `admin` ({enrolled, needsCode} for admin views), `serverNow` | 0–1 (one read pipeline; cache hits skip it) |
| `auth.status` | ADMIN, SA | no | — | — | `{enrolled, locked, hardLocked}` | 0–1 |
| `auth.verifyCode` | ADMIN, SA | no | — | `code: text:6:6` | Section 7.3; returns `{grant, expiresAt}` | 1–2 |
| `auth.stepUp` | ADMIN, SA | no | grant | `code: text:6:6` | Sets `stepup_at = now` on the grant | 1–2 |
| `auth.logout` | ADMIN, SA | no | grant | — | Revokes the grant | 1 |
| `auth.enrollStart` | ADMIN, SA | no | — | `enrollCode?: text:10:10` (or an ENROLL grant in the envelope) | Section 7.2 step 1; returns `{otpauthUri, manualKey}` | 1–2 |
| `auth.enrollConfirm` | ADMIN, SA | no | — | `enrollCode?` (or the ENROLL grant), `code: text:6:6` | Section 7.2 step 2; returns `{backupCodes, grant, expiresAt}` | 1–2 |
| `auth.useBackupCode` | ADMIN, SA | no | — | `backupCode: text:10:10` | Consumes it (removes its hash); returns an ENROLL grant valid 10 minutes, which lets the admin re-enroll without an enrollment code. Failures count toward the same lockout as codes | 1–2 |

**Timer** (own only; all roles; `ws: true`; writes)

| Action | Payload | Checks (assert steps unless noted) | Writes | Audit |
| --- | --- | --- | --- | --- |
| `timer.start` | `projectId?`, `taskId?`, `description?`, `billable?`, `tagIds?`, `clientAt` | Rules first in Apps Script: `RULE_PROJECT_REQUIRED`, `RULE_TASK_REQUIRED`, `REQUIRE_DESCRIPTION` → `POLICY`. Then asserts: member active and workspace ACTIVE; project ACTIVE in workspace and trackable by caller (section 6.3); task ACTIVE and belongs to project; every tag ACTIVE in workspace | `INSERT INTO active_timers` with `started_at = Util.clampClientTime_(clientAt, now)` and `local_date` from the workspace timezone; PK clash → `CONFLICT` "A timer is already running" | `TIMER_STARTED` |
| `timer.stop` | `timerId`, `clientAt` | Assert the caller's timer has this `timer_id` → else `NOT_FOUND` | One `INSERT INTO time_entries ... SELECT ... FROM active_timers` computing `end_at = MIN(MAX(?, started_at), started_at + capMs)` where `capMs = min(AUTO_STOP_HOURS, 24) h`; `duration_s` and the rate snapshot from `projects` in the same SELECT; `entry_tags` from `json_each(tag_ids_json)`; `DELETE FROM active_timers`; `.select()` of the new entry | `TIMER_STOPPED` with the entry as `after` |
| `timer.switch` | `timerId`, `version`, `projectId?`, `taskId?`, `description?`, `billable?`, `tagIds?` | `ALLOW_USER_PROJECT_SWITCH` must be true if `projectId` changes (`POLICY`); same project, task and tag asserts as start; version assert | `UPDATE active_timers` (start time unchanged) | `TIMER_UPDATED` |

`Util.clampClientTime_(clientAt, now)`: if `|clientAt − now| ≤ TIMER_CLIENT_SKEW_SECONDS × 1000` use `min(clientAt, now)`, else `now`.

When `FEATURE_TAGS` is off for the workspace, a non-empty `tagIds` is refused with `POLICY`; when `FEATURE_LIVE_VIEW` is off, `live.list` is refused with `POLICY`.

**Entries**

| Action | Roles / scope | Payload | Rules | Audit |
| --- | --- | --- | --- | --- |
| `entries.list` | own; WA for any member of the workspace (`userId`) | `from: date`, `to: date` (≤ 93 days), `userId?`, `projectId?`, `tagId?`, `cursor?` | Ordered `start_at DESC, id DESC`, 200 per page, keyset cursor; excludes deleted. User role never gets rate or money fields | — |
| `entries.update` | own within the edit window; WA for others with **step-up** | `id`, `version`, `projectId?`, `taskId?`, `description?`, `billable?`, `tagIds?`, `startAt?`, `endAt?` | Edit window: entry `local_date ≥ today(ws tz) − PAST_ENTRY_EDIT_DAYS` (users only); the same rule flags as start; the end can't be before the start, the length can't exceed 24 h, the end can't be in the future; recompute `duration_s` and `local_date`; re-snapshot rates if the project changes; replace `entry_tags` | `ENTRY_UPDATED` |
| `entries.delete` | own within the window if `ALLOW_USER_DELETE_ENTRY`; WA for others with **step-up** | `id`, `version`, `reason?` | Soft delete: `deleted_at`, `deleted_by` | `ENTRY_DELETED` |
| `entries.bulk` | own only | `ids: ids:50`, `op: enum:setProject\|setBillable\|addTags\|removeTags\|delete`, `value?` | Every id must be own, not deleted and inside the window; one transaction; one audit row per entry | per entry |

Overlapping entries are not prevented in v1 (same as today).

**Catalogue** (`ws: true`; list actions for all members, writes for WA; writes bump `gen:ws:{wsId}`)

| Action | Payload | Notes | Audit |
| --- | --- | --- | --- |
| `clients.list` / `.create` / `.update` / `.archive` | `name`, `notes?`; update/archive add `id`, `version` | Name unique per workspace → `CONFLICT` | `CLIENT_*` |
| `projects.list` / `.create` / `.update` / `.archive` | `name`, `code?`, `clientId?`, `restricted?`, `billableDefault?`, `hourlyRateMinor?`, `costRateMinor?`, `estimateMinutes?`, `budgetMinor?`, `startDate?`, `endDate?`, `color?` | User-role list: only trackable active projects, without rate, cost or budget fields | `PROJECT_*` |
| `tasks.list` / `.create` / `.update` / `.archive` | `projectId`, `name`, `estimateMinutes?`, `billableDefault?`, `sortOrder?` | Project must be in the workspace | `TASK_*` |
| `projectAccess.set` | `projectId`, `userId`, `canTrack: bool` | User must be an active member | `PROJECT_ACCESS_SET` |
| `tags.list` / `.create` / `.update` / `.archive` | `name: text:1:60`, `color?` | Archived tags stay on old entries but can't be added | `TAG_*` |

**Workspaces and members**

| Action | Roles | Step-up | Notes | Audit |
| --- | --- | --- | --- | --- |
| `workspaces.list` | all | — | Users: own memberships. SA: all | — |
| `workspaces.create` / `.update` / `.archive` | SA | yes | `code`, `name`, `timezone: tz`, `weekStart: enum:SUN\|MON\|SAT`. A timezone change schedules the `local_date` rewrite job (T2.9). Archiving stops running timers in that workspace with `stop_reason = 'USER'`, actor `SYSTEM` | `WORKSPACE_*` |
| `members.list` | WA, SA | — | | — |
| `members.add` / `.update` / `.remove` | WA (not `wsRole`), SA | no (WA), yes for SA | `userId`, `department?`, `team?`, `jobTitle?`; remove = `active = 0` and stops that user's timer if it's in this workspace | `MEMBER_*` |
| `members.setAdmin` | SA | yes | `userId`, `isAdmin: bool`. Target's account role must be ADMIN or SUPER_ADMIN. When granting, assert the count of ACTIVE workspaces where they are an active `ws_role = 'ADMIN'` is below `COALESCE(admin_ws_limit, ADMIN_MAX_ACTIVE_WORKSPACES)` (D6) → `POLICY` | `MEMBER_ADMIN_SET` |

**Users** (SA only; all writes need step-up; all writes bump `gen:acct`)

| Action | Payload | Rules | Audit |
| --- | --- | --- | --- |
| `users.list` | `status?`, `cursor?` | 200 per page | — |
| `users.create` | `email`, `displayName`, `role: enum:USER\|ADMIN`, `employeeCode?`, `workspaceIds?: ids:20` | Email domain must equal `COMPANY_DOMAIN`. SUPER_ADMIN can only be granted by the owner function `ownerGrantSuperAdmin(email)` | `USER_CREATED` |
| `users.update` | `id`, `version`, `displayName?`, `role?: enum:USER\|ADMIN`, `employeeCode?`, `email?` | Server rules (section 7.1) | `USER_UPDATED` |
| `users.setAdminLimit` | `id`, `version`, `limit: int:0:50` or `null` for the default | Target must be ADMIN; lowering the limit below the current count is allowed but blocks new grants | `USER_ADMIN_LIMIT_SET` |
| `users.deactivate` | `id`, `version`, `reason: text:1:500` | One transaction: stop the running timer into an entry (`stop_reason = 'DEACTIVATION'`), set memberships inactive, status INACTIVE, `auth_epoch + 1`, revoke grants | `USER_DEACTIVATED` (+ `TIMER_STOPPED`) |
| `users.activate` | `id`, `version` | | `USER_ACTIVATED` |
| `users.unlock` | `id` | Clears `failed_count`, `locked_until`, `hard_locked` | `MFA_UNLOCKED` |
| `users.revokeGrants` | `id` | Sets `revoked_at` on all live grants | `GRANTS_REVOKED` |
| `users.issueEnrollCode` | `id` | Target must be ADMIN or SA; resets MFA (`enabled = 0`, new code hash, 24 h expiry); returns the code once | `ENROLL_CODE_ISSUED` |

**Reports and live view**

| Action | Roles | grant / step-up | Payload | Notes |
| --- | --- | --- | --- | --- |
| `reports.summary` | all (own) ; WA, SA (workspace) | grant when `scope = workspace` | `scope: enum:own\|workspace`, `from`, `to` (≤ 366 days), `groupBy: enum:user\|project\|client\|tag\|task\|day\|week\|month`, `userIds?`, `projectIds?`, `clientIds?`, `tagIds?`, `billable?` | Returns `{rows:[{key,label,seconds,billableSeconds,amountMinor?,costMinor?}], totals, asOf}`; money only for WA/SA; tag grouping counts an entry once per tag (stated in the UI); cached 5 min |
| `reports.detailed` | same | same | same `scope` and filters plus `cursor?` | Paged 200; own scope and user role get the allowlist fields only |
| `reports.exportCsv` | WA, SA | grant + step-up for the first page | `type: enum:summary\|detailed`, filters, `exportId?`, `page?` | First call returns `exportId` (cached 10 min) and the header; later pages of 2,000 rows need only the grant and `exportId`; the browser joins them into a download. One `REPORT_EXPORTED` audit row per export. Formula neutralising on every cell |
| `live.list` | WA, SA | grant | — | Running timers in the workspace: user, project, task, description, `startedAt`. Cached 60 s per workspace, shared by all viewers. Refused when `FEATURE_LIVE_VIEW` is off |

**Settings, audit and health** (SA)

| Action | grant / step-up | Notes |
| --- | --- | --- |
| `settings.get` | grant | The catalog (section 6.5) with current values |
| `settings.patch` | step-up | `{scope, key, value}`; validated against the catalog; bumps `gen:settings` (and `gen:ws:{id}` for workspace scope); audit `SETTING_CHANGED` |
| `audit.list` | grant | Filters `workspaceId?`, `entityType?`, `actorUserId?`, `fromSeq?`; paged 200 |
| `audit.verify` | step-up | Runs the verifier from the last checkpoint, up to 4 minutes; returns `{verifiedTo, ok, problems}` |
| `security.events` | grant | Paged 200, newest first |
| `system.health` | grant | Last job runs, usage counters versus limits, token expiry dates, Drive use, alarms |

### 6.3 Trackable project rule

A project is trackable by user U in workspace W when: the project is in W and ACTIVE, U is an active member of W, and either the project's `restricted = 0`, or U's account role is ADMIN or SUPER_ADMIN, or a `project_access` row exists for (project, U) with `can_track = 1`. As an assert condition:

```sql
EXISTS (SELECT 1 FROM projects p
        WHERE p.id = ? AND p.workspace_id = ? AND p.status = 'ACTIVE'
          AND (p.restricted = 0 OR ? IN ('ADMIN','SUPER_ADMIN')
               OR EXISTS (SELECT 1 FROM project_access a
                          WHERE a.project_id = p.id AND a.user_id = ? AND a.can_track = 1)))
```

### 6.4 Verified statements

These ran green against migration 001 on SQLite on 2026-11-03 (23 checks: asserts, trackable project, tag validation, one-timer PK, capped stop, odd-millisecond stop, entry tags, double-stop refusal, 24 h and duration CHECKs, single root, lowercase email, rate limit, duplicate request id, week start, size query, unsealed-index use). Use them as written.

Timer stop (one statement; `?` order: entryId, endAt, capMs, endAt, capMs, stopReason, now, now, userId, timerId):

```sql
INSERT INTO time_entries (id, workspace_id, user_id, project_id, task_id, description, start_at, end_at,
  duration_s, local_date, billable, hourly_rate_minor, cost_rate_minor, source, stop_reason, timer_id,
  created_at, updated_at)
SELECT ?, t.workspace_id, t.user_id, t.project_id, t.task_id, t.description, t.started_at,
       MIN(MAX(?, t.started_at), t.started_at + ?),
       (MIN(MAX(?, t.started_at), t.started_at + ?) - t.started_at) / 1000,
       t.local_date, t.billable,
       (SELECT hourly_rate_minor FROM projects WHERE id = t.project_id),
       (SELECT cost_rate_minor FROM projects WHERE id = t.project_id),
       'TIMER', ?, t.timer_id, ?, ?
FROM active_timers t WHERE t.user_id = ? AND t.timer_id = ?;

INSERT INTO entry_tags (entry_id, tag_id, workspace_id)
SELECT ?, j.value, t.workspace_id FROM active_timers t, json_each(t.tag_ids_json) j WHERE t.user_id = ?;

DELETE FROM active_timers WHERE user_id = ? AND timer_id = ?;
```

Tag validation assert condition (`?` = tag ids as a JSON array, workspace id):

```sql
NOT EXISTS (SELECT 1 FROM json_each(?) j
            LEFT JOIN tags t ON t.id = j.value AND t.workspace_id = ? AND t.status = 'ACTIVE'
            WHERE t.id IS NULL)
```

Week start for grouping (`local_date` is already local, so no timezone maths): SUN `date(d, '-' || strftime('%w', d) || ' days')`; MON `date(d, '-' || ((strftime('%w', d) + 6) % 7) || ' days')`; SAT `date(d, '-' || ((strftime('%w', d) + 1) % 7) || ' days')`.

### 6.5 Settings catalog

`Config.gs` defines `SETTINGS_CATALOG_` entries `{key, type, default, min, max, options, scope, stepUp}`. Scope `GLOBAL` lives at `scope = 'GLOBAL'`; `WORKSPACE` settings may be overridden per workspace (`scope = workspace id`) and fall back to the global value.

| Key | Type | Default | Range | Scope |
| --- | --- | --- | --- | --- |
| `COMPANY_NAME` | text | `FLINK Business Solutions` | 1–120 | GLOBAL |
| `DEFAULT_TIMEZONE` | tz | `Africa/Cairo` | — | GLOBAL |
| `AUTO_STOP_HOURS` | int | 14 | 1–24 | GLOBAL |
| `PAST_ENTRY_EDIT_DAYS` | int | 7 | 0–90 (0 = today only) | WORKSPACE |
| `REQUIRE_DESCRIPTION` | bool | false | — | WORKSPACE |
| `RULE_PROJECT_REQUIRED` | bool | false | — | WORKSPACE |
| `RULE_TASK_REQUIRED` | bool | false | — | WORKSPACE |
| `ALLOW_USER_DELETE_ENTRY` | bool | true | — | WORKSPACE |
| `ALLOW_USER_PROJECT_SWITCH` | bool | true | — | WORKSPACE |
| `FEATURE_TAGS` | bool | true | — | WORKSPACE |
| `FEATURE_LIVE_VIEW` | bool | true | — | WORKSPACE |
| `ADMIN_MAX_ACTIVE_WORKSPACES` | int | 3 | 0–50 | GLOBAL |
| `ADMIN_IDLE_MINUTES` | int | 30 | 5–240 | GLOBAL |
| `ADMIN_ABSOLUTE_HOURS` | int | 8 | 1–24 | GLOBAL |
| `TIMER_CLIENT_SKEW_SECONDS` | int | 120 | 0–600 | GLOBAL |
| `RATE_LIMIT_WRITES_PER_MIN` | int | 60 | 10–600 | GLOBAL |

Every `settings.patch` needs step-up (plan section 3). `COMPANY_DOMAIN` is **not** a setting; it is a Script Property written only by the setup page.

## 7. Security details

### 7.1 Server rules (each has its own test)

1. Nobody changes their own role, status, email or admin limit, or deactivates themselves (`FORBIDDEN`).
2. The root account (`is_root = 1`) can't be demoted, deactivated, re-emailed or have MFA reset (`users.issueEnrollCode`) through the app. Another Super Admin may `users.unlock` it; a lost root authenticator is recovered with a backup code or the owner function `ownerIssueRootEnrollCode`.
3. At least one ACTIVE SUPER_ADMIN must remain: demoting or deactivating a SUPER_ADMIN asserts `(SELECT COUNT(*) FROM accounts WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE' AND id <> ?) >= 1`.
4. Only SA with step-up sets `ws_role = 'ADMIN'` (`members.setAdmin`).
5. Archived workspaces are read-only: every write in a workspace asserts `status = 'ACTIVE'`.
6. A user-role caller never receives `hourly_rate_minor`, `cost_rate_minor`, `budget_minor` or any money total. Responses for that role are built from field allowlists, never by deleting fields.
7. Another user's records are reachable only through WA/SA actions; IDs outside scope give `NOT_FOUND`.

### 7.2 Enrollment

1. `auth.enrollStart`: either a valid ENROLL grant for this user, or the given code hashed as `HMAC_SHA256(CODE_PEPPER, normalised code)` matching `admin_mfa.enroll_code_hash` before its expiry. Generate a 20-byte secret from `Utilities.getUuid()` output hashed with SHA-256 (take 20 bytes), base32-encode it, store it encrypted in `pending_secret_enc`. Return the `otpauth://totp/FLINK%20Time:{email}?secret=..&issuer=FLINK%20Time&period=30&digits=6&algorithm=SHA1` URI; the page draws the QR locally with `nayuki-qr.js`.
2. `auth.enrollConfirm`: verify the code against the pending secret (with drift ±1 step). Then in one transaction: move `pending_secret_enc` to `secret_enc`, `enabled = 1`, `last_step` = the step used, clear the enrollment code, store 8 new backup-code hashes, and create an ADMIN grant. Return the backup codes once.
3. The root's first enrollment: owner function `ownerIssueRootEnrollCode()` logs the code to the editor's execution log only.

Code alphabet for enrollment and backup codes: Crockford base32 (`0123456789ABCDEFGHJKMNPQRSTVWXYZ`), 10 characters, from `Utilities.getUuid()`-derived bytes. Comparisons ignore case and treat `O` as `0` and `I`/`L` as `1`.

### 7.3 Codes, grants and lockout

- TOTP: RFC 6238, SHA-1, 6 digits, 30 s, accept steps `t−1, t, t+1`, reject any step ≤ `last_step`. Copy the base32 and TOTP routines from `apps-script/Code.gs` around lines 2778–2850 (section 11).
- `auth.verifyCode` in one transaction: assert not hard-locked and `locked_until ≤ now`; on success set `last_step`, `failed_count = 0`, insert the grant. On failure, a separate small transaction increments `failed_count`; at 5, set `locked_until = now + 15 min`, append `now` to `lockouts_json` (keep the last 24 h), and if that makes 3 within 24 h set `hard_locked = 1`; write a `security_events` row and email `ALERT_EMAIL`.
- Grant token: `Util.hex_(sha256(uuid1 + uuid2 + uuid3))` + `Util.hex_(sha256(uuid4 + uuid5 + uuid6))` (128 hex chars). The database stores `sha256hex(token)`. Expiry: absolute `created_at + ADMIN_ABSOLUTE_HOURS`, idle `last_seen_at + ADMIN_IDLE_MINUTES`. `last_seen_at` is updated (a tiny transaction, no audit) only when 5 minutes old.
- Grant check: hash → cached row (60 s) → not revoked, not expired, same `user_id` as the caller's Google identity, `auth_epoch` equals the account's, kind `ADMIN` (ENROLL and RECOVERY grants work only for `auth.enroll*`).

### 7.4 Secret cipher

Keep the existing `enc$v1$` HMAC-SHA256 keystream cipher (`apps-script/Code.gs` around lines 2851–2900), keyed from `TOTP_ENC_KEY_v{n}` instead of the old pepper. Its tests move to `tests/v2/totp-cipher.test.js`. It's on the Phase 7 review list.

## 8. Jobs, triggers and owner functions

`Setup.installTriggers()` (owner function) deletes this project's triggers and creates:

| Function | Schedule | Does |
| --- | --- | --- |
| `jobSealAudit` | every 1 minute | Section 5.5 |
| `jobAutoStop` | every hour | Closes timers older than `AUTO_STOP_HOURS` with `stop_reason = 'AUTO_STOP'`, one transaction each, actor `SYSTEM`, request id `autostop:{timerId}` |
| `jobDailyExport` | daily 01:30 (script timezone `Africa/Cairo`) | Plan section 9: previous day's audit rows, changed entries and security events into the month's private Sheet; resumable via `export_state` |
| `jobVerifyChain` | daily 02:30; full re-check on Sundays | Section 5.5 verifier |
| `jobBackup` | weekly Sunday 03:00, resumable every 10 min while `RUNNING` | Plan section 9 paged backup |
| `jobPurge` | daily 04:00 | `request_log` > 7 days, expired grants > 30 days, `security_events` > 365 days, `job_runs` > 180 days |
| `jobHealth` | hourly | Usage, token expiry (decode JWT `exp`), Drive quota, last job results; warns at 70% |

Every job: takes the script lock with `tryLock(0)` (skip if busy), writes a `job_runs` row, stops itself at 4.5 minutes of runtime and leaves a cursor.

Owner functions (run from the editor by the owner; each checks `Session.getEffectiveUser().getEmail() === OWNER_EMAIL`): `runMigrations`, `installTriggers`, `ownerGrantSuperAdmin(email)`, `ownerIssueRootEnrollCode`, `ownerMaintenance(on)`, `ownerRotateAuditKey`, `ownerRotateTotpKey`.

Script Properties: `OWNER_EMAIL`, `COMPANY_DOMAIN`, `TURSO_URL`, `TURSO_RW_TOKEN`, `TURSO_RO_TOKEN`, `AUDIT_HMAC_KEY_v1`, `AUDIT_KEY_VERSION`, `TOTP_ENC_KEY_v1`, `TOTP_KEY_VERSION`, `CODE_PEPPER`, `CHAIN_CHECKPOINT`, `EXPORT_FOLDER_ID`, `BACKUP_FOLDER_ID`, `ALERT_EMAIL`, `MAINTENANCE`, `ALARM_AUDIT`, `SETUP_DONE`. Keys are generated by the setup page from `Utilities.getUuid()` hashed with SHA-256 (64 hex chars).

Manifest template (`appsscript.template.json`):

```json
{
  "timeZone": "Africa/Cairo",
  "runtimeVersion": "V8",
  "exceptionLogging": "STACKDRIVER",
  "webapp": { "access": "DOMAIN", "executeAs": "USER_DEPLOYING" },
  "oauthScopes": [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/script.external_request",
    "https://www.googleapis.com/auth/script.send_mail",
    "https://www.googleapis.com/auth/script.scriptapp",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file"
  ],
  "urlFetchWhitelist": ["{{TURSO_ORIGIN}}/"]
}
```

## 9. Portal

One `Portal.html` template; `doGet` passes `view` (`user` | `admin` | `superadmin`) and the template includes only that view's markup and code (as today). `?view=user` is served with `XFrameOptionsMode.ALLOWALL`; the others with `DEFAULT`.

Rules:

- **No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`** with any dynamic value. Build DOM with `createElement` and `textContent`, or clone `<template>` elements. A test fails the build on any of those four names in `Portal.html` outside an allowlisted static line.
- `doGet` makes **no database call**. The page draws its layout at once, then calls `app.bootstrap`.
- `api(action, payload, {write})`: adds `v`, `workspaceId`, the grant and, for writes, a `crypto.randomUUID()` request id reused on retries. Retries `BUSY`, `DB_UNAVAILABLE` and transport failures up to 3 times with 0.5 s, 1.5 s, 4 s backoff.
- **Optimistic updates** for `timer.start`, `timer.stop`, `timer.switch`, own `entries.update` and own `entries.delete`: update the screen first, show a small "saving" mark, and roll back with a message on any error. Never for admin or step-up actions.
- The running timer ticks from `started_at` and `serverNow − Date.now()` offset; the page never polls for it. Live view refreshes every 60 s only while visible.
- The admin grant lives only in a JS variable; cleared on logout and expiry. Page reload means a new code.
- Employee view renders only when `location.ancestorOrigins` (if present) contains `https://sites.google.com`; otherwise it shows a link to the Site.
- Destructive actions (stop, delete, bulk delete) use a two-step confirm whose second button appears in a different place.
- User role never shows rate, cost or money columns.

Screens: **user** — timer bar (project, task, tags, description, billable), today and this week's entries with edit and delete, own summary report. **admin** — the user screens plus workspace switcher, catalog (clients, projects, tasks, tags, project access), members, reports with CSV export, live view. **superadmin** — admin screens plus users, workspaces, settings, audit, security events and health.

## 10. Test harness

- `load-app.js` reads `apps-script-v2/files.json`, concatenates nothing, and runs each `.gs` in order inside one `vm` context that holds the fakes. It returns the context, so tests call `ctx.handleClientRequest(...)` exactly as the page would.
- `fakes.js` gives controllable versions: `Session` (set the email per test), `CacheService` (in-memory with TTL and a clock), `LockService` (a flag), `PropertiesService` (a Map), `Utilities` (`getUuid` via `crypto.randomUUID`, `computeDigest`, `computeHmacSha256Signature` and `computeHmacSignature` returning **signed** byte arrays like Apps Script, `base64Encode`, `formatDate` via `Intl.DateTimeFormat` with the tz supporting only the patterns the code uses (`yyyy-MM-dd`, `HH:mm`, `Z`), `sleep` no-op), `UrlFetchApp.fetch` (routes `/v2/pipeline` to `fake-turso.js`, and can be told to fail, stall or return garbage), `MailApp` (records mails), `HtmlService` (records the template and frame mode), `ScriptApp` (records triggers).
- **Binding trap (verified 2026-11-03):** `node:sqlite` binds every plain JS number as REAL, so `(? - started_at) / 1000` becomes float division and the `duration_s` CHECK fails. Turso receives `{"type":"integer"}` and does integer maths. `fake-turso.js` must therefore bind `integer` args as `BigInt(value)`, `float` args as numbers, and call `setReadBigInts(true)` on statements, converting results back to typed values. A test must prove an odd-millisecond stop passes the CHECK.
- `fake-turso.js` implements the section 5.2 protocol on `node:sqlite` `DatabaseSync`: `execute`, `batch` with conditions (`ok`, `error`, `not`, `and`, `or`, `is_autocommit`), `close`; integers returned as strings; per-step errors reported as `{message}` with SQLite's text; after each pipeline, if a transaction is still open, it rolls it back. It enforces that `ro` tokens can't write (reject any statement that isn't `SELECT` or `WITH ... SELECT`). Tokens are `test-rw` / `test-ro`.
- `seed.js` applies migration 001 and inserts a standard world: root SA `root@flink.test`, one SA, two Admins, four Users, workspaces W1 (Africa/Cairo, SUN) and W2 (archived), projects (one restricted), tasks, tags.
- The clock is injectable (`ctx.__setNow(ms)`), so DST, edit windows and expiry are testable.

## 11. What to copy from the old code

| From | What | To |
| --- | --- | --- |
| `apps-script/Code.gs` ~2778–2850 | base32 encode/decode, TOTP generation | `Totp.gs` |
| `apps-script/Code.gs` ~2851–2900 | `enc$v1$` cipher | `Totp.gs` (key source changed) |
| `apps-script/Code.gs` ~516–530 (`Validation`) and ~18486–18500 (`ExportService`) | formula-injection neutralising | `Validate.gs` |
| `apps-script/Code.gs` ~8916+ (`TimezoneService`) | IANA timezone validation and local-date formatting | `Util.gs` |
| `storage-v2/LogChain.gs` ~42–60 | `canonicalJson` | `Util.gs` |
| `vendor/nayuki-qr.js` | QR drawing | inlined in `Portal.html` admin views |
| `apps-script/Portal.html` | CSS only (colours, spacing, components) | `Portal.html` |
| `tests/browser/mock-google.js`, `server.js` | the mocked `google.script.run` approach | `tests/v2/browser/` |

Copy, then re-test under `tests/v2/`. Don't import anything else.

## 12. Tickets

Each ticket lists what to build and when it's done. Phase gates are in the plan (section 15); the last ticket of each phase checks them.

### Phase 0 — proof tests (section 13)

- **T0.1** Create the `phase0/` Apps Script project and test Turso database; run tests 1–6 and 8–14 of plan section 14; record raw numbers and answers in `docs/v2/phase0-results.md` using the template in section 13. **Done when** every row has a result and the gate decision (pass, or fallback accepted by the owner).
- **T0.2** Tests 7 and 7b with a real employee account inside the Site. **Done when** recorded.

### Phase 1 — foundations

- **T1.1** Scaffolding: folders, `files.json`, empty modules, `package.json` script, CI job on Node 24, `load-app.js`, `fakes.js`, size-budget test, "no top-level work" test (load the files with every fake throwing on use; loading must not touch any). **Done when** `npm run test:v2` runs green with these tests.
- **T1.2** `fake-turso.js` with its own tests: conditional batch rollback, plain BEGIN/COMMIT pipeline does **not** roll back a failed middle step, assert-insert failure, integer encoding, read-only token refusal, open-transaction rollback at pipeline end.
- **T1.3** `Migrations.gs` + migration 001 + runner. Tests: applies from empty, idempotent rerun, changed checksum refuses, every CHECK and UNIQUE in 5.1 rejects bad rows (one test each).
- **T1.4** `Db.gs`: `read_`, `tx_` builder, argument encoding, response decoding, error mapping (every branch in 5.3), usage counters. Tests against `fake-turso.js`, including fetch failure, garbage response and duplicate request id with same and different payload.
- **T1.5** `Util.gs`, `Cache.gs`: ids, canonical JSON (with key-order and number tests), sha256/HMAC hex, local date in Africa/Cairo across the 2026 DST changes, client-time clamp, generation keys.
- **T1.6** `Validate.gs`: every schema type, unknown-field rejection, formula neutralising.
- **T1.7** `Config.gs`: error codes, settings catalog, settings read with workspace fallback.
- **T1.8** `Auth.gs` + `Main.gs`: section 4.4 pipeline, response contract, logging, `doGet` with frame modes and no DB call.
- **T1.9** Permission-matrix test generated from `ACTIONS`: every action × {USER, ADMIN non-member, ADMIN member, WA, SA} × {own, other, other workspace} has an expected allow/deny table in the test; a new action without an entry fails the test.
- **T1.10** `Audit.gs`: row builder with redaction, sealer, verifier, checkpoint. Tests: chain over 500 rows, tamper one field → detected, delete newest sealed row → detected via checkpoint, `seq` gap → security event and mail, sealer crash mid-way → rerun completes, two sealers can't overlap.
- **T1.11** `Setup.gs`: single-use owner setup page (writes Script Properties, generates keys, converts `libsql://` URL), owner functions with the owner check. Tests with fakes.
- **T1.12** Extend `scripts/staging.js` with `--app v2` (reads `files.json`, renders the manifest template with the environment's Turso origin); keep the old path working and its tests green.
- **T1.13 Gate:** permission-matrix, server-rules (section 7.1, stubs for actions not built yet marked `todo`), transaction, tamper-detection and migration suites pass; schema v1 applied on staging Turso via `runMigrations`.

### Phase 2 — core time tracking

- **T2.1** Workspaces and members, including `members.setAdmin` with the D6 limit.
- **T2.2** Clients, projects (with `restricted`), tasks, project access; user-role allowlists.
- **T2.3** Tags (`tags.*`) and tag validation shared by timer and entries.
- **T2.4** `timer.start` / `stop` / `switch` with every check in 6.2; tests: second start refused by the database, stop writes exactly one entry, stop twice → second `NOT_FOUND`, retry of a stop with the same request id returns the same entry, 24 h and auto-stop caps, client-time clamp, restricted project refused, archived workspace refused.
- **T2.5** `entries.list` / `update` / `delete` / `bulk` with edit window, rule flags, step-up for others, version conflicts, IDOR tests.
- **T2.6** `app.bootstrap` (one read pipeline; cache hits skip it).
- **T2.7** `jobAutoStop`.
- **T2.8** `live.list` with the shared 60 s cache.
- **T2.9** Workspace timezone-change job rewriting `local_date` (resumable).
- **T2.10 Gate:** plan Phase 2 gate, plus measured ≤ 2 Turso calls per action and save p95 under 2 s on staging.

### Phase 3 — admin security

- **T3.1** `Totp.gs` (copied routines, cipher, codes) with RFC 6238 test vectors.
- **T3.2** Enrollment (`users.issueEnrollCode`, `auth.enrollStart`, `auth.enrollConfirm`, owner root code).
- **T3.3** `Grants.gs`: `auth.verifyCode`, `stepUp`, `logout`, grant checks, idle/absolute expiry, `last_seen_at` throttling, lockout and hard lock, backup codes.
- **T3.4** Users: `users.*` with all server rules and `users.deactivate` as one transaction.
- **T3.5 Gate:** plan Phase 3 gate.

### Phase 4 — reports and records

- **T4.1** `reports.summary` and `reports.detailed` (scope in SQL, week grouping by `week_start`, money only for WA/SA, cache).
- **T4.2** `reports.exportCsv` (paged, step-up on first page, formula neutralising).
- **T4.3** `jobDailyExport` (monthly Sheets, text-formatted cells, long JSON split at 45,000 chars, idempotent rerun).
- **T4.4** `jobVerifyChain`, `jobBackup` (paged SQL files + manifest, resumable), `jobPurge`, `jobHealth`.
- **T4.5 Gate:** plan Phase 4 gate, including one restore drill with `turso db create --from-dump`.

### Phase 5 — portal and Sites

- **T5.1** `Portal.html` shell, `api()` wrapper, bootstrap, error messages per code.
- **T5.2** User view with optimistic timer and entry edits.
- **T5.3** Admin view (catalog, members, reports, CSV, live view, code prompt and step-up dialog, enrollment with local QR).
- **T5.4** Super Admin view.
- **T5.5** Browser tests (Playwright, mocked `google.script.run`) for every screen; `innerHTML` ban test.
- **T5.6 Gate:** plan Phase 5 gate on staging inside the real Site.

### Phase 7 — hardening and launch (no Phase 6: D1)

- **T7.1** Load test on staging (plan section 13).
- **T7.2** Runbooks in `docs/v2/runbooks.md`: token rotation, emergency invalidation, key rotation, restore, offboarding, lost authenticator.
- **T7.3** Independent security review fixes.
- **T7.4** Switch-over: installer and README point at `apps-script-v2`; old app made read-only for 30 days, then removed with its tests.

## 13. Phase 0 procedure

`phase0/` is a separate, throwaway Apps Script project (not deployed to staff) with `P0.gs`, `P0Page.html` and a manifest allowlisting the test Turso host. Tokens go into its Script Properties by hand. Results go into `docs/v2/phase0-results.md`:

```markdown
| # | Test | Date | Result (numbers / yes-no) | Pass? | Notes / decision |
| --- | --- | --- | --- | --- | --- |
```

| # | How exactly |
| --- | --- |
| 1 | `p0Latency()`: 50 runs of a 6-step write batch (BEGIN, insert, assert, update, insert, COMMIT) against a US-East database and an EU database; record p50, p95, max per region |
| 2 | `p0ConditionalTx()`: batch where step 3 of 5 fails; check no row from steps 1–2 exists. Then a plain pipeline of separate `execute` requests BEGIN/insert/failing insert/COMMIT; record that the first insert **is** saved |
| 3 | `p0Assert()`: the `_assert` pattern with a missing row → step error and rollback; with the row present → no error, no row in `_assert` |
| 4 | Log one full raw response JSON for a batch with an error; record field names, integer format and `rows_read`/`rows_written` presence |
| 5 | Run migration 001 via the batch runner; then try one bad row per CHECK/UNIQUE; check `json_each` works; record whether `REFERENCES` are enforced (insert an orphan) |
| 6 | With the read-only token: an INSERT (must fail); record whether fine-grained per-table permissions exist on the free plan |
| 7, 7b | `P0Page.html` deployed as a domain web app showing `Session.getActiveUser().getEmail()`; open directly, inside the Site, and in a browser signed into two accounts |
| 8 | Versioned deployment with only the Turso origin in `urlFetchWhitelist`; call Turso (works) and `https://example.com` (blocked) |
| 9 | Generate 200 MB of synthetic entries in a scratch database; run a paged export across several trigger runs; restore with `turso db create --from-dump`; compare row counts |
| 10 | Decode `exp` of a token created with `--expiration 7d`; compare |
| 12 | Point one call at a slow endpoint (e.g. a URL that waits 30 s) while another execution writes; record that the writer is unaffected |
| 13 | `SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()` through the HTTP API |
| 11 | `P0Page.html` button firing 20 `google.script.run` write batches at once (each its own execution, no script lock, all touching `chain_head`-free rows plus one shared counter row via `UPDATE ... SET n = n + 1`), with page-side retry on `BUSY`; record successes per try, p95, and the final counter (must be exactly 20) |
| 14 | `P0Page.html` buttons timing `google.script.run` from a browser in Cairo: 50 empty calls, 50 full write batches, 20 cold loads (script idle ≥ 30 min), 20 warm loads; inside the Site and direct; record p50/p95 |

Test 11 decides whether the no-lock write design stands (fallback: the script-lock design, plan section 6), so it runs here and again in Phase 7 on the real build.

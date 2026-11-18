'use strict';

// T1.11 — Setup.gs: the single-use owner setup page and the owner functions (BUILD_SPEC sections 7.2, 8 and 12).
//
// The owner check goes beyond section 8. Section 8 says `Session.getEffectiveUser().getEmail() === OWNER_EMAIL`, but
// the web app runs as its deployer (executeAs USER_DEPLOYING), so for a visitor the effective user is the owner too
// and every employee would pass (docs/v2/questions.md, 2026-11-05). The check here needs the ACTIVE user (who is
// actually running or visiting) to be the effective user, and both to be OWNER_EMAIL once that is set.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');
const { insert } = require('./helpers/seed');
const { expectCode } = require('./helpers/asserts');
const fs = require('node:fs');
const path = require('node:path');
const { APP_DIR } = require('./helpers/load-app');

const OWNER = 'owner@flink.test';
const VISITOR = 'visitor@flink.test';
const HEX64 = /^[0-9a-f]{64}$/;

// An app whose Script Properties are empty, as before setup, with the owner at the keyboard.
function fresh() {
  const env = createEnv();
  env.fakes.globals.PropertiesService.getScriptProperties().deleteAllProperties();
  env.fakes.session.setActiveEmail(OWNER);
  env.fakes.session.setEffectiveEmail(OWNER);
  return env;
}
const form = (env, overrides = {}) => ({
  tursoUrl: env.origin.replace('https://', 'libsql://'), rwToken: 'test-rw', roToken: 'test-ro', companyDomain: 'flink.test',
  alertEmail: 'alerts@flink.test', ...overrides,
});
// An app after a successful setup.
function configured() {
  const env = fresh();
  env.ctx.setupSubmit(form(env));
  env.fakes.fetch.calls.length = 0;
  env.fakes.mail.reset();
  env.fakes.log.reset();
  return env;
}
const props = env => env.fakes.properties.all();
const db = env => env.turso.db;
const all = (env, sql) => db(env).prepare(sql).all().map(row => ({ ...row }));
const plain = (env, value) => env.ctx.__plain(value);
const asVisitor = env => { env.fakes.session.setActiveEmail(VISITOR); env.fakes.session.setEffectiveEmail(OWNER); };
const logText = env => env.fakes.log.lines.map(line => line.text).join('\n');

const OWNER_FUNCTIONS = {
  runMigrations: env => env.ctx.runMigrations(),
  installTriggers: env => env.ctx.installTriggers(),
  ownerGrantSuperAdmin: env => env.ctx.ownerGrantSuperAdmin('someone@flink.test'),
  ownerMaintenance: env => env.ctx.ownerMaintenance(true),
  ownerRotateAuditKey: env => env.ctx.ownerRotateAuditKey(),
  ownerRotateTotpKey: env => env.ctx.ownerRotateTotpKey(),
};

// ---------------------------------------------------------------- the owner check

test('requireOwner_: the person running must be the effective user, and the owner once an owner is recorded', () => {
  const cases = [
    // [active, effective, OWNER_EMAIL (undefined = not set yet), allowed]
    [OWNER, OWNER, undefined, true],
    [OWNER, OWNER, OWNER, true],
    ['  OWNER@Flink.TEST \n', OWNER, OWNER, true],
    [OWNER, ` ${OWNER.toUpperCase()}`, OWNER, true],
    [VISITOR, OWNER, OWNER, false],            // a visitor of the web app runs as the deployer: the case that section 8 missed
    [VISITOR, OWNER, undefined, false],
    ['', OWNER, OWNER, false],                 // Google did not reveal who is running
    [OWNER, '', OWNER, false],
    ['', '', undefined, false],
    [OWNER, OWNER, 'someone.else@flink.test', false],
    [VISITOR, VISITOR, OWNER, false],
    [VISITOR, VISITOR, undefined, true],       // before setup the deployer is the owner, whoever that is
  ];
  for (const [active, effective, ownerEmail, allowed] of cases) {
    const env = fresh();
    env.fakes.session.setActiveEmail(active);
    env.fakes.session.setEffectiveEmail(effective);
    if (ownerEmail !== undefined) env.fakes.properties.set('OWNER_EMAIL', ownerEmail);
    const label = JSON.stringify([active, effective, ownerEmail]);
    if (allowed) {
      assert.doesNotThrow(() => env.ctx.Setup.requireOwner_(), label);
    } else {
      const err = expectCode(() => env.ctx.Setup.requireOwner_(), 'FORBIDDEN');
      assert.equal(err.retryable, false, label);
    }
  }
});

test('every owner function refuses a visitor of the web app, and changes nothing', () => {
  const env = configured();
  asVisitor(env);
  const before = props(env);
  env.fakes.triggers.triggers.push({ id: 'x', handler: 'keepMe', schedule: {} });
  for (const [name, run] of Object.entries(OWNER_FUNCTIONS)) {
    expectCode(() => run(env), 'FORBIDDEN');
    assert.equal(name.length > 0, true);
  }
  expectCode(() => env.ctx.setupSubmit(form(env)), 'FORBIDDEN');
  assert.deepEqual(props(env), before);

  // before setup, when the page is still open: a visitor cannot run it either
  const open = fresh();
  asVisitor(open);
  expectCode(() => open.ctx.setupSubmit(form(open)), 'FORBIDDEN');
  assert.deepEqual(props(open), {}, 'nothing was written');
  assert.equal(open.fakes.fetch.calls.length, 0);
  assert.equal(env.fakes.fetch.calls.length, 0, 'not one database call');
  assert.deepEqual(env.fakes.triggers.triggers.map(t => t.handler), ['keepMe']);
  assert.equal(env.fakes.mail.sent.length, 0);
});

test('every owner function refuses when Google does not say who is running', () => {
  const env = configured();
  env.fakes.session.setActiveEmail('');
  for (const run of Object.values(OWNER_FUNCTIONS)) expectCode(() => run(env), 'FORBIDDEN');
  expectCode(() => env.ctx.setupSubmit(form(env)), 'FORBIDDEN');
});

test('the Super Admin who runs the web app, without being the owner, is not the owner either', () => {
  const env = configured();
  env.fakes.session.setActiveEmail('sa@flink.test');
  for (const run of Object.values(OWNER_FUNCTIONS)) expectCode(() => run(env), 'FORBIDDEN');
});

test('the only public functions are those the spec lists: no helper is reachable from the browser by accident', () => {
  const allowed = new Set([
    'doGet', 'handleClientRequest',                                                   // the page
    'setupSubmit',                                                                    // the setup page's one server call
    'runMigrations', 'installTriggers', 'ownerGrantSuperAdmin', 'ownerMaintenance',
    'ownerRotateAuditKey', 'ownerRotateTotpKey',                                      // the owner functions of section 8
  ]);
  const found = [];
  for (const name of fs.readdirSync(APP_DIR).filter(n => n.endsWith('.gs'))) {
    const source = fs.readFileSync(path.join(APP_DIR, name), 'utf8');
    for (const match of source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)) found.push(match[1]);
  }
  const unexpected = found.filter(fn => !fn.endsWith('_') && !allowed.has(fn) && !/^job[A-Z]/.test(fn));
  assert.deepEqual(unexpected, [], 'a top-level function without a trailing underscore can be called from any employee\'s browser');
  for (const fn of allowed) assert.ok(found.includes(fn), `${fn} should exist`);
});

// ---------------------------------------------------------------- the setup page

const view = (env, parameter) => { env.fakes.html.reset(); const out = env.ctx.doGet({ parameter }); return { out, record: env.fakes.html.last(), html: out.getContent() }; };

test('the setup page, for the owner before setup, is a form that posts to setupSubmit and may not be framed', () => {
  const env = fresh();
  const { record, html } = view(env, { view: 'setup' });
  assert.equal(record.frameMode, 'DEFAULT');
  assert.match(html, /<form/);
  assert.match(html, /setupSubmit/);
  for (const field of ['tursoUrl', 'rwToken', 'roToken', 'companyDomain', 'alertEmail']) assert.ok(html.includes(`id="${field}"`), field);
  for (const secretField of ['rwToken', 'roToken']) assert.match(html, new RegExp(`id="${secretField}"[^>]*type="password"|type="password"[^>]*id="${secretField}"`));
});

test('the setup page shows a visitor nothing to fill in', () => {
  const env = fresh();
  asVisitor(env);
  const { html, record } = view(env, { view: 'setup' });
  assert.equal(record.frameMode, 'DEFAULT');
  assert.ok(!/<form|setupSubmit|<input/i.test(html));
  assert.match(html, /owner/i);
});

test('once setup is done the page says so, to everyone, and has no form', () => {
  const env = configured();
  for (const active of [OWNER, VISITOR]) {
    env.fakes.session.setActiveEmail(active);
    const { html } = view(env, { view: 'setup' });
    assert.ok(!/<form|setupSubmit|<input/i.test(html), active);
    assert.match(html, /complete/i);
  }
});

test('the setup page has no dynamic HTML sink and shows no stored value', () => {
  const env = configured();
  const pages = [view(env, { view: 'setup' }).html];
  const fresh2 = fresh();
  pages.push(view(fresh2, { view: 'setup' }).html);
  for (const html of pages) {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) assert.ok(!html.includes(sink), sink);
    for (const value of ['test-rw', 'test-ro', OWNER, ...Object.values(props(env)).filter(v => v.length >= 10)]) assert.ok(!html.includes(value), value);
  }
});

test('the setup route makes no database call, and the other views are unchanged', () => {
  const env = fresh();
  view(env, { view: 'setup' });
  assert.equal(env.fakes.fetch.calls.length, 0);
  assert.equal(view(env, { view: 'admin' }).record.props.view, 'admin');
  assert.equal(view(env, { view: 'Setup' }).record.props.view, 'user', 'only the exact lower-case name routes to setup');
});

// ---------------------------------------------------------------- the URL and domain rules

test('tursoUrl_ turns libsql:// into https://, lower-cases the host and drops a trailing slash', () => {
  const env = fresh();
  const ok = [
    ['libsql://db-org.turso.io', 'https://db-org.turso.io'],
    ['https://DB-Org.Turso.io/', 'https://db-org.turso.io'],
    ['  https://db-org.turso.io  ', 'https://db-org.turso.io'],
    ['LIBSQL://db.turso.io:8443///', 'https://db.turso.io:8443'],
  ];
  for (const [input, expected] of ok) assert.equal(env.ctx.Setup.tursoUrl_(input), expected, input);
  const bad = ['http://db.turso.io', 'ftp://db.turso.io', 'https://db.turso.io/path', 'https://db.turso.io?x=1', 'https://db.turso.io#x',
    'https://user:pw@db.turso.io', 'db.turso.io', 'https://', 'libsql://', 'https://localhost', 'https://-bad.turso.io',
    'https://bad..turso.io', 'https://x y.turso.io', 'https://db.turso.io:99999', 'javascript:alert(1)', ''];
  for (const input of bad) {
    const err = expectCode(() => env.ctx.Setup.tursoUrl_(input), 'VALIDATION');
    assert.equal(err.details.field, 'tursoUrl', input);
  }
});

test('companyDomain_ accepts a plain dotted domain, lower-cased, and nothing else', () => {
  const env = fresh();
  assert.equal(env.ctx.Setup.companyDomain_(' FLINK.test '), 'flink.test');
  assert.equal(env.ctx.Setup.companyDomain_('mail.company-name.co.uk'), 'mail.company-name.co.uk');
  for (const bad of ['flink', '@flink.test', 'flink.test/x', 'a b.com', '.com', 'flink..test', 'user@flink.test', 'flink.t', '-a.com', 'a-.com', '']) {
    const err = expectCode(() => env.ctx.Setup.companyDomain_(bad), 'VALIDATION');
    assert.equal(err.details.field, 'companyDomain', bad);
  }
});

// ---------------------------------------------------------------- setupSubmit

test('setupSubmit writes the Script Properties, generates the keys, migrates, creates the root account and closes the page', () => {
  const env = fresh();
  const result = plain(env, env.ctx.setupSubmit(form(env)));
  assert.equal(result.ok, true);
  assert.ok(Array.isArray(result.steps) && result.steps.length >= 4);

  const p = props(env);
  assert.equal(p.TURSO_URL, env.origin, 'libsql:// became https://');
  assert.equal(p.TURSO_RW_TOKEN, 'test-rw');
  assert.equal(p.TURSO_RO_TOKEN, 'test-ro');
  assert.equal(p.COMPANY_DOMAIN, 'flink.test');
  assert.equal(p.ALERT_EMAIL, 'alerts@flink.test');
  assert.equal(p.OWNER_EMAIL, OWNER);
  assert.equal(p.AUDIT_KEY_VERSION, '1');
  assert.equal(p.TOTP_KEY_VERSION, '1');
  for (const key of ['AUDIT_HMAC_KEY_v1', 'TOTP_ENC_KEY_v1', 'CODE_PEPPER']) assert.match(p[key], HEX64, key);
  assert.equal(new Set([p.AUDIT_HMAC_KEY_v1, p.TOTP_ENC_KEY_v1, p.CODE_PEPPER]).size, 3, 'three different keys');
  assert.equal(p.SETUP_DONE, '1');

  assert.deepEqual(all(env, 'SELECT version, name FROM schema_migrations'), [{ version: 1, name: 'schema v1' }]);
  assert.deepEqual(all(env, 'SELECT email, display_name, role, status, is_root, auth_epoch, version FROM accounts'), [{
    email: OWNER, display_name: 'owner', role: 'SUPER_ADMIN', status: 'ACTIVE', is_root: 1, auth_epoch: 1, version: 1,
  }]);
  const audit = all(env, 'SELECT actor_user_id, actor_role, entity_type, action, workspace_id FROM audit_log');
  assert.deepEqual(audit, [{ actor_user_id: 'SYSTEM', actor_role: 'SYSTEM', entity_type: 'ACCOUNT', action: 'ROOT_CREATED', workspace_id: null }]);
});

test('setupSubmit never repeats a secret in its answer, the log, a mail or the audit log', () => {
  const env = fresh();
  const result = JSON.stringify(plain(env, env.ctx.setupSubmit(form(env))));
  const secrets = ['test-rw', 'test-ro', ...['AUDIT_HMAC_KEY_v1', 'TOTP_ENC_KEY_v1', 'CODE_PEPPER'].map(k => props(env)[k])];
  const everything = [result, logText(env), JSON.stringify(env.fakes.mail.sent), JSON.stringify(all(env, 'SELECT * FROM audit_log')),
    JSON.stringify(all(env, 'SELECT * FROM request_log'))].join('\n');
  for (const secret of secrets) assert.ok(!everything.includes(secret), `${secret.slice(0, 8)}... leaked`);
});

test('setup is single use: after it, setupSubmit refuses, even for the owner, and nothing moves', () => {
  const env = configured();
  const before = props(env);
  const err = expectCode(() => env.ctx.setupSubmit(form(env, { companyDomain: 'other.test' })), 'FORBIDDEN');
  assert.match(err.message, /already/i);
  assert.deepEqual(props(env), before);
  assert.equal(env.fakes.fetch.calls.length, 0);
});

test('a refused form writes nothing at all', () => {
  const env = fresh();
  const bad = [
    form(env, { tursoUrl: 'http://x.turso.io' }),
    form(env, { companyDomain: 'nodot' }),
    form(env, { companyDomain: 'other.test' }),                 // the owner would lock themselves out
    form(env, { alertEmail: 'not-an-email' }),
    form(env, { roToken: 'test-rw' }),                          // the read-only token must differ from the read-write one
    form(env, { rwToken: 'has space' }),
    form(env, { rwToken: '' }),
    { ...form(env), extra: 'field' },
    null, 'text', [], undefined,
  ];
  for (const candidate of bad) {
    assert.throws(() => env.ctx.setupSubmit(candidate), undefined, JSON.stringify(candidate));
    assert.deepEqual(props(env), {}, `a refused form wrote properties: ${JSON.stringify(candidate)}`);
  }
  assert.equal(env.fakes.fetch.calls.length, 0);
});

test('the field a refused form names is the field that is wrong', () => {
  const env = fresh();
  const field = overrides => expectCode(() => env.ctx.setupSubmit(form(env, overrides)), 'VALIDATION').details.field;
  assert.equal(field({ tursoUrl: 'nope' }), 'tursoUrl');
  assert.equal(field({ companyDomain: 'nodot' }), 'companyDomain');
  assert.equal(field({ companyDomain: 'other.test' }), 'companyDomain');
  assert.equal(field({ alertEmail: 'x' }), 'alertEmail');
  assert.equal(field({ roToken: 'test-rw' }), 'roToken');
  assert.equal(field({ rwToken: 'a b' }), 'rwToken');
  assert.equal(field({ extra: 1 }), 'extra');
});

test('a setup that fails half way can be run again, and keeps the keys it already made', () => {
  const env = fresh();
  env.fakes.fetch.failNext();                                              // the migration cannot reach the database
  assert.throws(() => env.ctx.setupSubmit(form(env)), /Turso/);
  const keys = ['AUDIT_HMAC_KEY_v1', 'TOTP_ENC_KEY_v1', 'CODE_PEPPER'].map(k => props(env)[k]);
  assert.equal(props(env).SETUP_DONE, undefined, 'the page stays open');
  assert.equal(props(env).OWNER_EMAIL, OWNER);

  env.ctx.setupSubmit(form(env));
  assert.deepEqual(['AUDIT_HMAC_KEY_v1', 'TOTP_ENC_KEY_v1', 'CODE_PEPPER'].map(k => props(env)[k]), keys,
    'regenerating the audit key after rows exist would break the chain');
  assert.equal(props(env).SETUP_DONE, '1');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM accounts')[0].n, 1);
});

test('running the setup again over a finished database does not make a second root or a second audit row', () => {
  const env = configured();
  env.fakes.properties.delete('SETUP_DONE');                              // as if the last step had not been written
  env.ctx.setupSubmit(form(env));
  const writes = env.fakes.fetch.calls.filter(call => call.payload.includes('BEGIN IMMEDIATE'));
  assert.equal(writes.length, 0, 'nothing is written: the root is already there, found by a read');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM accounts WHERE is_root = 1')[0].n, 1);
  assert.equal(all(env, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'ROOT_CREATED'")[0].n, 1);
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM schema_migrations')[0].n, 1);
});

test('the connection settings of a retry replace the old ones', () => {
  const env = fresh();
  env.fakes.fetch.failNext();
  assert.throws(() => env.ctx.setupSubmit(form(env, { alertEmail: 'old@flink.test' })));
  env.ctx.setupSubmit(form(env, { alertEmail: 'new@flink.test' }));
  assert.equal(props(env).ALERT_EMAIL, 'new@flink.test');
});

test('setup stores OWNER_EMAIL from the effective user, lower-cased', () => {
  const env = fresh();
  env.fakes.session.setActiveEmail(' Owner@FLINK.test ');
  env.fakes.session.setEffectiveEmail('OWNER@flink.test');
  env.ctx.setupSubmit(form(env));
  assert.equal(props(env).OWNER_EMAIL, OWNER);
  assert.equal(all(env, 'SELECT email FROM accounts')[0].email, OWNER);
});

// ---------------------------------------------------------------- runMigrations

test('runMigrations runs the migrations for the owner, and again changes nothing', () => {
  const env = configured();
  assert.deepEqual(plain(env, env.ctx.runMigrations()), { applied: [], current: 1 });
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM schema_migrations')[0].n, 1);
});

// ---------------------------------------------------------------- installTriggers

const HANDLERS = ['jobSealAudit', 'jobAutoStop', 'jobDailyExport', 'jobVerifyChain', 'jobBackup', 'jobPurge', 'jobHealth'];
const defineJobs = (env, except = []) => env.run(HANDLERS.filter(name => !except.includes(name)).map(name => `function ${name}() {}`).join('\n'));

test('installTriggers creates the schedule of section 8, and nothing else', () => {
  const env = configured();
  defineJobs(env);
  env.ctx.installTriggers();
  const made = env.fakes.triggers.triggers.map(t => ({ handler: t.handler, ...t.schedule }));
  const tz = 'Africa/Cairo';
  assert.deepEqual(made, [
    { handler: 'jobSealAudit', every: { unit: 'minutes', n: 1 } },
    { handler: 'jobAutoStop', every: { unit: 'hours', n: 1 } },
    { handler: 'jobDailyExport', every: { unit: 'days', n: 1 }, atHour: 1, nearMinute: 30, timeZone: tz },
    { handler: 'jobVerifyChain', every: { unit: 'days', n: 1 }, atHour: 2, nearMinute: 30, timeZone: tz },
    { handler: 'jobBackup', every: { unit: 'weeks', n: 1 }, weekDay: 'SUNDAY', atHour: 3, nearMinute: 0, timeZone: tz },
    { handler: 'jobBackup', every: { unit: 'minutes', n: 10 } },
    { handler: 'jobPurge', every: { unit: 'days', n: 1 }, atHour: 4, nearMinute: 0, timeZone: tz },
    { handler: 'jobHealth', every: { unit: 'hours', n: 1 } },
  ]);
});

test('installTriggers removes this project\'s other triggers first, and running it twice leaves one set', () => {
  const env = configured();
  defineJobs(env);
  env.run("ScriptApp.newTrigger('oldHandler').timeBased().everyHours(1).create();");
  env.ctx.installTriggers();
  env.ctx.installTriggers();
  const handlers = env.fakes.triggers.triggers.map(t => t.handler);
  assert.equal(handlers.length, 8);
  assert.ok(!handlers.includes('oldHandler'));
  assert.deepEqual([...new Set(handlers)].sort(), [...HANDLERS].sort());
});

test('installTriggers refuses to schedule a function that does not exist, and changes nothing', () => {
  const env = configured();
  defineJobs(env, ['jobPurge']);
  env.run("ScriptApp.newTrigger('keepMe').timeBased().everyHours(1).create();");
  const err = expectCode(() => env.ctx.installTriggers(), 'INTERNAL');
  assert.match(err.details.error, /jobPurge/);
  assert.deepEqual(env.fakes.triggers.triggers.map(t => t.handler), ['keepMe']);
});

test('installTriggers returns what it created', () => {
  const env = configured();
  defineJobs(env);
  const result = plain(env, env.ctx.installTriggers());
  assert.equal(result.created.length, 8);
  assert.deepEqual(result.created[0], { handler: 'jobSealAudit', schedule: 'every minute' });
});

// ---------------------------------------------------------------- ownerGrantSuperAdmin

const accountBy = (env, email) => all(env, `SELECT * FROM accounts WHERE email = '${email}'`)[0];
const auditActions = env => all(env, 'SELECT actor_user_id, actor_role, entity_type, entity_id, action, before_json, after_json, reason FROM audit_log ORDER BY seq');

test('ownerGrantSuperAdmin creates a Super Admin account for a new address', () => {
  const env = configured();
  const result = plain(env, env.ctx.ownerGrantSuperAdmin('  New.Person@FLINK.test '));
  assert.deepEqual(result, { email: 'new.person@flink.test', changed: true, created: true });
  const row = accountBy(env, 'new.person@flink.test');
  assert.deepEqual([row.display_name, row.role, row.status, row.is_root, row.auth_epoch, row.version], ['new.person', 'SUPER_ADMIN', 'ACTIVE', 0, 1, 1]);
  const [created] = auditActions(env).slice(-1);
  assert.deepEqual([created.actor_user_id, created.actor_role, created.entity_type, created.entity_id, created.action, created.before_json],
    ['SYSTEM', 'SYSTEM', 'ACCOUNT', row.id, 'SUPER_ADMIN_GRANTED', null]);
  assert.deepEqual(JSON.parse(created.after_json), { role: 'SUPER_ADMIN', status: 'ACTIVE', created: true });
  assert.equal(created.reason, 'ownerGrantSuperAdmin');
});

test('ownerGrantSuperAdmin promotes an Admin, and records what it was before', () => {
  const env = configured();
  insert(db(env), 'accounts', { id: '00000000-0000-4000-8000-0000000000c1', email: 'admin@flink.test', display_name: 'An Admin', role: 'ADMIN',
    status: 'ACTIVE', employee_code: null, is_root: 0, auth_epoch: 4, admin_ws_limit: 2, created_at: 1, updated_at: 1, version: 1 });
  const result = plain(env, env.ctx.ownerGrantSuperAdmin('admin@flink.test'));
  assert.deepEqual(result, { email: 'admin@flink.test', changed: true, created: false });
  const row = accountBy(env, 'admin@flink.test');
  assert.deepEqual([row.role, row.status, row.version, row.auth_epoch, row.admin_ws_limit, row.display_name], ['SUPER_ADMIN', 'ACTIVE', 2, 4, 2, 'An Admin']);
  assert.equal(row.updated_at, env.fakes.clock.now());
  const [granted] = auditActions(env).slice(-1);
  assert.deepEqual(JSON.parse(granted.before_json), { role: 'ADMIN', status: 'ACTIVE' });
  assert.deepEqual(JSON.parse(granted.after_json), { role: 'SUPER_ADMIN', status: 'ACTIVE' });
});

test('ownerGrantSuperAdmin switches an inactive account back on', () => {
  const env = configured();
  insert(db(env), 'accounts', { id: '00000000-0000-4000-8000-0000000000c2', email: 'gone@flink.test', display_name: 'Gone', role: 'USER',
    status: 'INACTIVE', employee_code: null, is_root: 0, auth_epoch: 1, admin_ws_limit: null, created_at: 1, updated_at: 1, version: 3 });
  env.ctx.ownerGrantSuperAdmin('gone@flink.test');
  const row = accountBy(env, 'gone@flink.test');
  assert.deepEqual([row.role, row.status, row.version], ['SUPER_ADMIN', 'ACTIVE', 4]);
  assert.deepEqual(JSON.parse(auditActions(env).slice(-1)[0].before_json), { role: 'USER', status: 'INACTIVE' });
});

test('ownerGrantSuperAdmin for someone who already is an active Super Admin does nothing', () => {
  const env = configured();
  const before = all(env, 'SELECT * FROM accounts');
  const audits = auditActions(env).length;
  for (const email of [OWNER, OWNER.toUpperCase()]) {                       // the root
    assert.deepEqual(plain(env, env.ctx.ownerGrantSuperAdmin(email)), { email: OWNER, changed: false, created: false });
  }
  assert.deepEqual(all(env, 'SELECT * FROM accounts'), before);
  assert.equal(auditActions(env).length, audits);
  assert.equal(env.fakes.mail.sent.length, 0);
});

test('ownerGrantSuperAdmin mails ALERT_EMAIL for every change (plan section 11: alert on Super Admin changes)', () => {
  const env = configured();
  env.ctx.ownerGrantSuperAdmin('new.person@flink.test');
  assert.equal(env.fakes.mail.sent.length, 1);
  assert.equal(env.fakes.mail.sent[0].to, 'alerts@flink.test');
  assert.match(env.fakes.mail.sent[0].subject, /Super Admin/i);
  assert.match(env.fakes.mail.sent[0].body, /new\.person@flink\.test/);
  env.fakes.properties.delete('ALERT_EMAIL');
  env.ctx.ownerGrantSuperAdmin('another@flink.test');                          // no address: logged, not fatal
  assert.ok(accountBy(env, 'another@flink.test'));
});

test('ownerGrantSuperAdmin only accepts an address in the company domain', () => {
  const env = configured();
  for (const bad of ['someone@evil.test', 'someone@flink.test@evil.test', 'not an email', '', 'a@b', 5, null, undefined, {}, ['a@flink.test']]) {
    const err = expectCode(() => env.ctx.ownerGrantSuperAdmin(bad), 'VALIDATION');
    assert.equal(err.details.field, 'email', String(bad));
  }
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM accounts')[0].n, 1);
});

test('ownerGrantSuperAdmin leaves the root alone and drops the account cache so the change shows at once', () => {
  const env = configured();
  insert(db(env), 'accounts', { id: '00000000-0000-4000-8000-0000000000c3', email: 'later@flink.test', display_name: 'Later', role: 'ADMIN',
    status: 'ACTIVE', employee_code: null, is_root: 0, auth_epoch: 1, admin_ws_limit: null, created_at: 1, updated_at: 1, version: 1 });
  assert.equal(env.ctx.Auth.loadAccount_('later@flink.test').user.role, 'ADMIN');          // now cached
  env.ctx.ownerGrantSuperAdmin('later@flink.test');
  assert.equal(env.ctx.Auth.loadAccount_('later@flink.test').user.role, 'SUPER_ADMIN');
  assert.equal(all(env, 'SELECT COUNT(*) AS n FROM accounts WHERE is_root = 1')[0].n, 1);
  assert.equal(accountBy(env, 'later@flink.test').is_root, 0);
});

test('ownerGrantSuperAdmin with the database down changes nothing and says so', () => {
  const env = configured();
  env.fakes.fetch.failNext();
  expectCode(() => env.ctx.ownerGrantSuperAdmin('new.person@flink.test'), 'DB_UNAVAILABLE');
  assert.equal(accountBy(env, 'new.person@flink.test'), undefined);
});

// ---------------------------------------------------------------- ownerMaintenance

test('ownerMaintenance(true) sets MAINTENANCE, ownerMaintenance(false) removes it, anything else is refused', () => {
  const env = configured();
  assert.deepEqual(plain(env, env.ctx.ownerMaintenance(true)), { maintenance: true });
  assert.equal(props(env).MAINTENANCE, '1');
  assert.deepEqual(plain(env, env.ctx.ownerMaintenance(false)), { maintenance: false });
  assert.equal('MAINTENANCE' in props(env), false);
  for (const bad of ['true', 1, 0, null, undefined, {}]) {
    expectCode(() => env.ctx.ownerMaintenance(bad), 'VALIDATION');
  }
  assert.equal('MAINTENANCE' in props(env), false);
});

// ---------------------------------------------------------------- key rotation

test('ownerRotateAuditKey adds the next key version, keeps the old key, records it, and new rows are sealed with it', () => {
  const env = configured();
  const oldKey = props(env).AUDIT_HMAC_KEY_v1;
  const result = plain(env, env.ctx.ownerRotateAuditKey());
  assert.deepEqual(result, { version: 2 });
  assert.equal(props(env).AUDIT_KEY_VERSION, '2');
  assert.equal(props(env).AUDIT_HMAC_KEY_v1, oldKey, 'old rows still need it');
  assert.match(props(env).AUDIT_HMAC_KEY_v2, HEX64);
  assert.notEqual(props(env).AUDIT_HMAC_KEY_v2, oldKey);

  const [rotated] = auditActions(env).slice(-1);
  assert.deepEqual([rotated.actor_user_id, rotated.entity_type, rotated.entity_id, rotated.action], ['SYSTEM', 'KEY', 'AUDIT_HMAC', 'AUDIT_KEY_ROTATED']);
  assert.deepEqual(JSON.parse(rotated.before_json), { version: 1 });
  assert.deepEqual(JSON.parse(rotated.after_json), { version: 2 });
  assert.equal(env.fakes.mail.sent.length, 1);

  env.ctx.Audit.seal_();                                                    // seals the root row (v2 now) and the rotation row
  assert.deepEqual(all(env, 'SELECT DISTINCT key_version FROM audit_log').map(r => r.key_version), [2]);
  assert.deepEqual(plain(env, env.ctx.Audit.verify_(0)).problems, []);
  assert.equal(JSON.parse(JSON.stringify(plain(env, env.ctx.ownerRotateAuditKey()))).version, 3);
});

test('ownerRotateTotpKey adds the next TOTP key version and keeps the old key', () => {
  const env = configured();
  const oldKey = props(env).TOTP_ENC_KEY_v1;
  assert.deepEqual(plain(env, env.ctx.ownerRotateTotpKey()), { version: 2 });
  assert.equal(props(env).TOTP_KEY_VERSION, '2');
  assert.equal(props(env).TOTP_ENC_KEY_v1, oldKey);
  assert.match(props(env).TOTP_ENC_KEY_v2, HEX64);
  assert.notEqual(props(env).TOTP_ENC_KEY_v2, oldKey);
  const [rotated] = auditActions(env).slice(-1);
  assert.deepEqual([rotated.entity_type, rotated.entity_id, rotated.action], ['KEY', 'TOTP_ENC', 'TOTP_KEY_ROTATED']);
  assert.equal(env.fakes.mail.sent.length, 1);
  assert.equal(props(env).AUDIT_KEY_VERSION, '1', 'the other key is not touched');
});

test('rotating a key never puts key material in the audit log, a mail or the log', () => {
  const env = configured();
  env.ctx.ownerRotateAuditKey();
  env.ctx.ownerRotateTotpKey();
  const everything = [logText(env), JSON.stringify(env.fakes.mail.sent), JSON.stringify(all(env, 'SELECT * FROM audit_log')),
    JSON.stringify(all(env, 'SELECT * FROM request_log'))].join('\n');
  for (const [name, value] of Object.entries(props(env))) {
    if (/KEY_v|PEPPER|TOKEN/.test(name)) assert.ok(!everything.includes(value), name);
  }
});

test('rotation refuses when the current version is not recorded, and with the database down changes nothing', () => {
  const env = configured();
  env.fakes.properties.delete('AUDIT_KEY_VERSION');
  expectCode(() => env.ctx.ownerRotateAuditKey(), 'INTERNAL');
  assert.equal('AUDIT_HMAC_KEY_v2' in props(env), false);

  env.fakes.properties.delete('TOTP_ENC_KEY_v1');
  expectCode(() => env.ctx.ownerRotateTotpKey(), 'INTERNAL');
  assert.equal('TOTP_ENC_KEY_v2' in props(env), false);

  const env2 = configured();
  env2.fakes.fetch.failNext();
  expectCode(() => env2.ctx.ownerRotateAuditKey(), 'DB_UNAVAILABLE');
  assert.equal(props(env2).AUDIT_KEY_VERSION, '1', 'the audit row comes first: a failed record means no rotation');
  assert.equal('AUDIT_HMAC_KEY_v2' in props(env2), false);
});

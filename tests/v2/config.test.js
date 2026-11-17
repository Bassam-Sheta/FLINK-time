'use strict';

// T1.7 — Config.gs: the settings catalog (BUILD_SPEC section 6.5) and settings reads with workspace fallback.
// The error codes and AppError_ (also in Config.gs) are tested in errors.test.js.
//
// Resolution order for a setting: the workspace's own row (only for WORKSPACE-scope settings), then the GLOBAL row,
// then the catalog default. Rows that are invalid (unknown key, wrong type, out of range, bad JSON, wrong scope) are
// ignored, so a bad row can never turn a rule off by accident, but a database that cannot be read is an error.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv } = require('./helpers/env');
const { expectCode } = require('./helpers/asserts');

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'docs', 'v2', 'BUILD_SPEC.md');
const W1 = '123e4567-e89b-42d3-a456-426614174001';
const W2 = '123e4567-e89b-42d3-a456-426614174002';

// The rows of the table in section 6.5, as the catalog should hold them.
function specCatalog() {
  const text = fs.readFileSync(SPEC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### 6.5 Settings catalog');
  const end = text.indexOf('## 7.', start);
  assert.ok(start >= 0 && end > start, 'section 6.5 not found');
  const rows = [...text.slice(start, end).matchAll(/^\| `([A-Z_]+)` \| (text|tz|int|bool) \| (.+?) \| (.+?) \| (GLOBAL|WORKSPACE) \|$/gm)];
  return rows.map(([, key, type, rawDefault, range, scope]) => {
    const literal = rawDefault.replace(/`/g, '');
    const bounds = /^(\d+)–(\d+)/.exec(range);
    return {
      key, type, scope,
      default: type === 'int' ? Number(literal) : type === 'bool' ? literal === 'true' : literal,
      min: bounds ? Number(bounds[1]) : null,
      max: bounds ? Number(bounds[2]) : null,
    };
  });
}

function setup() {
  const env = createEnv();
  env.run('Migrations.run_()');
  const put = (scope, key, valueJson) => env.turso.db.prepare(
    'INSERT INTO settings (scope, key, value_json, updated_at, updated_by) VALUES (?, ?, ?, 0, ?)').run(scope, key, valueJson, 'u1');
  env.fakes.fetch.calls.length = 0;
  return { env, put, Config: env.ctx.Config, get: (key, ws) => env.ctx.Config.get_(key, ws) };
}

// ---------------------------------------------------------------- the catalog

test('the catalog is exactly the table of BUILD_SPEC section 6.5, row for row', () => {
  const env = createEnv();
  const expected = specCatalog();
  assert.equal(expected.length, 16, 'the spec lists 16 settings');
  const actual = env.ctx.__plain(env.ctx.SETTINGS_CATALOG_);
  assert.deepEqual(actual.map(e => e.key), expected.map(e => e.key), 'same keys, same order');
  for (const want of expected) {
    const got = actual.find(e => e.key === want.key);
    assert.deepEqual({ type: got.type, default: got.default, min: got.min, max: got.max, scope: got.scope },
      { type: want.type, default: want.default, min: want.min, max: want.max, scope: want.scope }, want.key);
  }
});

test('every setting is step-up, has no options, and COMPANY_DOMAIN is not a setting', () => {
  const env = createEnv();
  const catalog = env.ctx.__plain(env.ctx.SETTINGS_CATALOG_);
  for (const entry of catalog) {
    assert.equal(entry.stepUp, true, `${entry.key}: every settings.patch needs step-up (spec 6.5)`);
    assert.deepEqual(entry.options, [], entry.key);
    assert.deepEqual(Object.keys(entry).sort(), ['default', 'key', 'max', 'min', 'options', 'scope', 'stepUp', 'type']);
  }
  assert.equal(catalog.some(e => e.key === 'COMPANY_DOMAIN'), false);
  assert.equal(new Set(catalog.map(e => e.key)).size, catalog.length, 'keys are unique');
});

test('every default is a valid value for its own setting, at the scope it lives at', () => {
  const env = createEnv();
  for (const entry of env.ctx.__plain(env.ctx.SETTINGS_CATALOG_)) {
    const checked = env.ctx.Config.checkSetting_(entry.key, entry.default, 'GLOBAL');
    assert.equal(checked.value, entry.default, entry.key);
    if (entry.scope === 'WORKSPACE') assert.equal(env.ctx.Config.checkSetting_(entry.key, entry.default, W1).value, entry.default);
  }
});

test('the rule flags default the way the spec says: nothing required, everything allowed, tags and live view on', () => {
  const { get } = setup();
  assert.equal(get('REQUIRE_DESCRIPTION'), false);
  assert.equal(get('RULE_PROJECT_REQUIRED'), false);
  assert.equal(get('RULE_TASK_REQUIRED'), false);
  assert.equal(get('ALLOW_USER_DELETE_ENTRY'), true);
  assert.equal(get('ALLOW_USER_PROJECT_SWITCH'), true);
  assert.equal(get('FEATURE_TAGS'), true);
  assert.equal(get('FEATURE_LIVE_VIEW'), true);
  assert.equal(get('PAST_ENTRY_EDIT_DAYS'), 7);
  assert.equal(get('AUTO_STOP_HOURS'), 14);
  assert.equal(get('ADMIN_MAX_ACTIVE_WORKSPACES'), 3);
  assert.equal(get('RATE_LIMIT_WRITES_PER_MIN'), 60);
  assert.equal(get('TIMER_CLIENT_SKEW_SECONDS'), 120);
  assert.equal(get('COMPANY_NAME'), 'FLINK Business Solutions');
  assert.equal(get('DEFAULT_TIMEZONE'), 'Africa/Cairo');
});

test('entry_ finds a setting by key and knows nothing else', () => {
  const env = createEnv();
  assert.equal(env.ctx.Config.entry_('AUTO_STOP_HOURS').key, 'AUTO_STOP_HOURS');
  for (const key of ['NOPE', '', 'auto_stop_hours', 'COMPANY_DOMAIN', 'toString', '__proto__', 'constructor', null, undefined, 5]) {
    assert.equal(env.ctx.Config.entry_(key), null, String(key));
  }
});

// ---------------------------------------------------------------- resolution (pure)

test('value_ resolves workspace row, then global row, then default; false and 0 count as values', () => {
  const env = createEnv();
  const snapshot = {
    GLOBAL: { REQUIRE_DESCRIPTION: true, PAST_ENTRY_EDIT_DAYS: 0, AUTO_STOP_HOURS: 10 },
    [W1]: { REQUIRE_DESCRIPTION: false, PAST_ENTRY_EDIT_DAYS: 30 },
  };
  const value = (key, ws) => env.ctx.Config.value_(snapshot, key, ws);
  assert.equal(value('REQUIRE_DESCRIPTION'), true, 'no workspace: the global row');
  assert.equal(value('REQUIRE_DESCRIPTION', W1), false, 'the workspace row wins, even though it is false');
  assert.equal(value('REQUIRE_DESCRIPTION', W2), true, 'a workspace with no row falls back to the global row');
  assert.equal(value('PAST_ENTRY_EDIT_DAYS'), 0, '0 is a value, not a missing one');
  assert.equal(value('PAST_ENTRY_EDIT_DAYS', W1), 30);
  assert.equal(value('FEATURE_TAGS', W1), true, 'no row anywhere: the catalog default');
});

test('a GLOBAL-scope setting ignores workspace rows, and workspaces never see each other\'s overrides', () => {
  const env = createEnv();
  const snapshot = { GLOBAL: { AUTO_STOP_HOURS: 10 }, [W1]: { AUTO_STOP_HOURS: 3, FEATURE_TAGS: false } };
  assert.equal(env.ctx.Config.value_(snapshot, 'AUTO_STOP_HOURS', W1), 10);
  assert.equal(env.ctx.Config.value_(snapshot, 'FEATURE_TAGS', W1), false);
  assert.equal(env.ctx.Config.value_(snapshot, 'FEATURE_TAGS', W2), true);
  assert.equal(env.ctx.Config.value_({}, 'FEATURE_TAGS', W1), true, 'an empty snapshot is all defaults');
});

test('value_ is not fooled by workspace ids that are object members, and refuses an unknown key', () => {
  const env = createEnv();
  for (const ws of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', undefined, null, '', 5]) {
    assert.equal(env.ctx.Config.value_({ GLOBAL: {} }, 'FEATURE_TAGS', ws), true, String(ws));
  }
  expectCode(() => env.ctx.Config.value_({}, 'NOPE', W1), 'INTERNAL');
  expectCode(() => env.ctx.Config.value_({}, 'toString', W1), 'INTERNAL');
});

test('effective_ gives every setting its resolved value', () => {
  const env = createEnv();
  const snapshot = { GLOBAL: { COMPANY_NAME: 'Acme' }, [W1]: { FEATURE_TAGS: false } };
  const all = env.ctx.__plain(env.ctx.Config.effective_(snapshot, W1));
  assert.equal(Object.keys(all).length, 16);
  assert.equal(all.COMPANY_NAME, 'Acme');
  assert.equal(all.FEATURE_TAGS, false);
  assert.equal(all.AUTO_STOP_HOURS, 14);
});

// ---------------------------------------------------------------- reading from the database, through the cache

test('get_ reads the settings table once, resolves every kind of value, and then serves from the cache', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'COMPANY_NAME', '"Acme Ltd"');
  put('GLOBAL', 'AUTO_STOP_HOURS', '10');
  put('GLOBAL', 'DEFAULT_TIMEZONE', '"Europe/London"');
  put(W1, 'REQUIRE_DESCRIPTION', 'true');
  put(W1, 'PAST_ENTRY_EDIT_DAYS', '0');

  assert.equal(get('COMPANY_NAME'), 'Acme Ltd');
  assert.equal(env.fakes.fetch.calls.length, 1);
  assert.equal(get('AUTO_STOP_HOURS', W1), 10);
  assert.equal(get('DEFAULT_TIMEZONE'), 'Europe/London');
  assert.equal(get('REQUIRE_DESCRIPTION', W1), true);
  assert.equal(get('REQUIRE_DESCRIPTION', W2), false);
  assert.equal(get('PAST_ENTRY_EDIT_DAYS', W1), 0);
  assert.equal(get('PAST_ENTRY_EDIT_DAYS', W2), 7);
  assert.equal(env.fakes.fetch.calls.length, 1, 'everything after the first read came from the cache');
  assert.equal(env.fakes.fetch.calls[0].headers.Authorization, 'Bearer test-ro', 'settings are read with the read-only token');
});

test('the cache entry is settings:{gen}, lasts 5 minutes, and a bump of gen:settings forces a re-read', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'AUTO_STOP_HOURS', '10');
  assert.equal(get('AUTO_STOP_HOURS'), 10);
  assert.notEqual(env.run("CacheService.getScriptCache().get('settings:0')"), null);

  env.turso.db.exec("UPDATE settings SET value_json = '12' WHERE key = 'AUTO_STOP_HOURS'");
  assert.equal(get('AUTO_STOP_HOURS'), 10, 'still the cached snapshot');
  env.fakes.clock.advance(299 * 1000);
  assert.equal(get('AUTO_STOP_HOURS'), 10);
  env.fakes.clock.advance(1000);
  assert.equal(get('AUTO_STOP_HOURS'), 12, 'after 5 minutes it is read again');

  env.turso.db.exec("UPDATE settings SET value_json = '13' WHERE key = 'AUTO_STOP_HOURS'");
  env.ctx.Cache.bump_('gen:settings');
  assert.equal(get('AUTO_STOP_HOURS'), 13, 'a bumped generation is an immediate miss');
  assert.notEqual(env.run("CacheService.getScriptCache().get('settings:1')"), null);
});

test('an empty settings table means all defaults, and is cached too', () => {
  const { env, get } = setup();
  assert.equal(get('AUTO_STOP_HOURS'), 14);
  assert.equal(get('FEATURE_TAGS', W1), true);
  assert.equal(env.fakes.fetch.calls.length, 1);
});

test('invalid rows are ignored, the rest still count, and the warning names no value', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'AUTO_STOP_HOURS', '99');                 // out of range
  put('GLOBAL', 'ADMIN_IDLE_MINUTES', '"thirty"');        // wrong type
  put('GLOBAL', 'RATE_LIMIT_WRITES_PER_MIN', 'not json'); // not JSON
  put('GLOBAL', 'NOT_A_SETTING', '1');                    // unknown key
  put('GLOBAL', 'COMPANY_NAME', '""');                    // below the minimum length
  put('GLOBAL', 'DEFAULT_TIMEZONE', '"Mars/Base"');       // not a time zone
  put('GLOBAL', 'FEATURE_TAGS', '"false"');               // a string, not a bool
  put(W1, 'AUTO_STOP_HOURS', '5');                        // a GLOBAL-scope setting under a workspace
  put('../etc', 'FEATURE_TAGS', 'false');                 // not a scope
  put('__proto__', 'FEATURE_TAGS', 'false');
  put('GLOBAL', 'ADMIN_ABSOLUTE_HOURS', '12');            // the one good row

  assert.equal(get('AUTO_STOP_HOURS'), 14);
  assert.equal(get('ADMIN_IDLE_MINUTES'), 30);
  assert.equal(get('RATE_LIMIT_WRITES_PER_MIN'), 60);
  assert.equal(get('COMPANY_NAME'), 'FLINK Business Solutions');
  assert.equal(get('DEFAULT_TIMEZONE'), 'Africa/Cairo');
  assert.equal(get('FEATURE_TAGS', W1), true);
  assert.equal(get('ADMIN_ABSOLUTE_HOURS'), 12);

  const warnings = env.fakes.log.lines.filter(line => line.level === 'warn').map(line => line.text);
  assert.equal(warnings.length, 10, 'one warning per ignored row');
  assert.ok(warnings.every(text => text.startsWith('settings row ignored')));
  assert.ok(!warnings.some(text => /thirty|not json|Mars/.test(text)), 'values are not logged');
  const cached = JSON.parse(env.run("CacheService.getScriptCache().get('settings:0')"));
  assert.deepEqual(cached, { GLOBAL: { ADMIN_ABSOLUTE_HOURS: 12 } }, 'only valid rows reach the cache');
});

test('text is trimmed when read; a stored value outside the rules never wins over the default', () => {
  const { put, get } = setup();
  put('GLOBAL', 'COMPANY_NAME', '"  Acme  "');
  assert.equal(get('COMPANY_NAME'), 'Acme');
});

test('a database that cannot be read is an error, never "all defaults"; nothing is cached from the failure', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'ALLOW_USER_DELETE_ENTRY', 'false');
  env.fakes.fetch.failNext();
  expectCode(() => get('ALLOW_USER_DELETE_ENTRY'), 'DB_UNAVAILABLE');
  assert.equal(get('ALLOW_USER_DELETE_ENTRY'), false, 'the next read works and sees the real value');

  const second = setup();
  second.put('GLOBAL', 'ALLOW_USER_DELETE_ENTRY', 'false');
  second.env.fakes.fetch.respondNext(503, 'busy');
  expectCode(() => second.get('ALLOW_USER_DELETE_ENTRY'), 'DB_UNAVAILABLE');
});

test('a broken cache costs a database read, not correctness', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'AUTO_STOP_HOURS', '10');
  env.run("CacheService = { getScriptCache: function () { throw new Error('cache down'); } }");
  assert.equal(get('AUTO_STOP_HOURS'), 10);
  assert.equal(get('AUTO_STOP_HOURS'), 10);
  assert.equal(env.fakes.fetch.calls.length, 2, 'no cache, so every read goes to the database');
});

test('a cached entry that is not a settings snapshot is ignored', () => {
  const { env, put, get } = setup();
  put('GLOBAL', 'AUTO_STOP_HOURS', '10');
  for (const junk of ['"text"', '5', '[1,2]', 'null', '{not json']) {
    env.run(`CacheService.getScriptCache().put('settings:0', ${JSON.stringify(junk)}, 300)`);
    assert.equal(get('AUTO_STOP_HOURS'), 10, junk);
  }
});

test('get_ refuses an unknown key', () => {
  const { Config } = setup();
  expectCode(() => Config.get_('NOPE', W1), 'INTERNAL');
});

// ---------------------------------------------------------------- checking a value to be saved (for settings.patch)

test('checkSetting_ accepts a valid value, returns it normalised with its JSON, and names the scope it applies to', () => {
  const env = createEnv();
  const check = (key, value, scope) => env.ctx.__plain(env.ctx.Config.checkSetting_(key, value, scope));
  assert.deepEqual(check('COMPANY_NAME', '  Acme  ', 'GLOBAL'), { key: 'COMPANY_NAME', scope: 'GLOBAL', value: 'Acme', json: '"Acme"' });
  assert.deepEqual(check('AUTO_STOP_HOURS', 10, 'GLOBAL'), { key: 'AUTO_STOP_HOURS', scope: 'GLOBAL', value: 10, json: '10' });
  assert.deepEqual(check('REQUIRE_DESCRIPTION', true, W1), { key: 'REQUIRE_DESCRIPTION', scope: W1, value: true, json: 'true' });
  assert.deepEqual(check('PAST_ENTRY_EDIT_DAYS', 0, W1), { key: 'PAST_ENTRY_EDIT_DAYS', scope: W1, value: 0, json: '0' });
  assert.deepEqual(check('DEFAULT_TIMEZONE', 'Europe/London', 'GLOBAL'), { key: 'DEFAULT_TIMEZONE', scope: 'GLOBAL', value: 'Europe/London', json: '"Europe/London"' });
});

test('checkSetting_ refuses a value outside the rules of its setting, naming "value"', () => {
  const env = createEnv();
  const refused = [
    ['AUTO_STOP_HOURS', 0], ['AUTO_STOP_HOURS', 25], ['AUTO_STOP_HOURS', 1.5], ['AUTO_STOP_HOURS', '10'], ['AUTO_STOP_HOURS', null],
    ['PAST_ENTRY_EDIT_DAYS', -1], ['PAST_ENTRY_EDIT_DAYS', 91],
    ['RATE_LIMIT_WRITES_PER_MIN', 9], ['RATE_LIMIT_WRITES_PER_MIN', 601],
    ['TIMER_CLIENT_SKEW_SECONDS', -1], ['TIMER_CLIENT_SKEW_SECONDS', 601],
    ['ADMIN_IDLE_MINUTES', 4], ['ADMIN_IDLE_MINUTES', 241], ['ADMIN_ABSOLUTE_HOURS', 0], ['ADMIN_MAX_ACTIVE_WORKSPACES', 51],
    ['REQUIRE_DESCRIPTION', 'true'], ['REQUIRE_DESCRIPTION', 1], ['FEATURE_TAGS', null],
    ['COMPANY_NAME', ''], ['COMPANY_NAME', '   '], ['COMPANY_NAME', 'x'.repeat(121)], ['COMPANY_NAME', 5], ['COMPANY_NAME', 'two\nlines'],
    ['DEFAULT_TIMEZONE', 'Mars/Base'], ['DEFAULT_TIMEZONE', ''], ['DEFAULT_TIMEZONE', 5],
  ];
  for (const [key, value] of refused) {
    const err = expectCode(() => env.ctx.Config.checkSetting_(key, value, 'GLOBAL'), 'VALIDATION');
    assert.equal(err.details.field, 'value', `${key} = ${JSON.stringify(value)}`);
  }
});

test('checkSetting_ refuses an unknown key (naming "key") and a bad or impossible scope (naming "scope")', () => {
  const env = createEnv();
  for (const key of ['NOPE', 'COMPANY_DOMAIN', '', 'toString', null, 5]) {
    assert.equal(expectCode(() => env.ctx.Config.checkSetting_(key, 1, 'GLOBAL'), 'VALIDATION').details.field, 'key', String(key));
  }
  for (const scope of ['global', 'Global', 'W1', '', '../x', null, undefined, 5, W1.toUpperCase()]) {
    assert.equal(expectCode(() => env.ctx.Config.checkSetting_('FEATURE_TAGS', true, scope), 'VALIDATION').details.field, 'scope', String(scope));
  }
  // a GLOBAL-scope setting cannot be overridden per workspace
  for (const key of ['COMPANY_NAME', 'DEFAULT_TIMEZONE', 'AUTO_STOP_HOURS', 'ADMIN_MAX_ACTIVE_WORKSPACES', 'ADMIN_IDLE_MINUTES',
    'ADMIN_ABSOLUTE_HOURS', 'TIMER_CLIENT_SKEW_SECONDS', 'RATE_LIMIT_WRITES_PER_MIN']) {
    const entry = env.ctx.Config.entry_(key);
    assert.equal(expectCode(() => env.ctx.Config.checkSetting_(key, entry.default, W1), 'VALIDATION').details.field, 'scope', key);
  }
});

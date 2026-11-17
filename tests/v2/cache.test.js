'use strict';

// T1.5 — Cache.gs: a CacheService wrapper with generation keys (BUILD_SPEC section 5.4).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');
const { expectCode } = require('./helpers/asserts');

const fresh = () => {
  const env = createEnv();
  return { env, Cache: env.ctx.Cache, raw: key => env.run(`CacheService.getScriptCache().get(${JSON.stringify(key)})`) };
};
const brokenCache = env => env.run("CacheService = { getScriptCache: function () { throw new Error('cache down'); } }");

// ---------------------------------------------------------------- generations

test('gen_ is 0 when missing; bump_ counts up and gen_ follows', () => {
  const { Cache } = fresh();
  assert.equal(Cache.gen_('gen:acct'), 0);
  assert.equal(Cache.bump_('gen:acct'), 1);
  assert.equal(Cache.gen_('gen:acct'), 1);
  assert.equal(Cache.bump_('gen:acct'), 2);
  assert.equal(Cache.bump_('gen:acct'), 3);
  assert.equal(Cache.gen_('gen:acct'), 3);
});

test('generations are independent per name', () => {
  const { Cache } = fresh();
  Cache.bump_('gen:ws:w1');
  Cache.bump_('gen:ws:w1');
  Cache.bump_('gen:ws:w2');
  assert.deepEqual([Cache.gen_('gen:ws:w1'), Cache.gen_('gen:ws:w2'), Cache.gen_('gen:acct')], [2, 1, 0]);
});

test('a generation lives 6 hours from its last bump, then reads as 0 again', () => {
  const { env, Cache } = fresh();
  Cache.bump_('gen:acct');
  env.fakes.clock.advance(21599 * 1000);
  assert.equal(Cache.gen_('gen:acct'), 1);
  env.fakes.clock.advance(1000);
  assert.equal(Cache.gen_('gen:acct'), 0);
  Cache.bump_('gen:acct');
  env.fakes.clock.advance(21599 * 1000);
  Cache.bump_('gen:acct');                       // a bump renews the six hours
  env.fakes.clock.advance(21599 * 1000);
  assert.equal(Cache.gen_('gen:acct'), 2);
});

test('a stored generation that is not a non-negative integer reads as 0, and the next bump repairs it', () => {
  const { env, Cache } = fresh();
  for (const junk of ['abc', '-3', '1.5', '', '2e3', ' 4']) {
    env.run(`CacheService.getScriptCache().put('gen:acct', ${JSON.stringify(junk)}, 600)`);
    assert.equal(Cache.gen_('gen:acct'), 0, JSON.stringify(junk));
  }
  assert.equal(Cache.bump_('gen:acct'), 1);
  assert.equal(Cache.gen_('gen:acct'), 1);
});

test('bump_ and gen_ never throw when the cache service is down; gen_ reads 0', () => {
  const { env, Cache } = fresh();
  brokenCache(env);
  assert.equal(Cache.gen_('gen:acct'), 0);
  assert.equal(Cache.bump_('gen:acct'), 1);
});

// ---------------------------------------------------------------- values

test('put_ and get_ round-trip JSON values', () => {
  const { env, Cache } = fresh();
  const values = { object: { a: 1, b: [1, 2, { c: null }] }, array: [1, 'two', false], string: 'héllo 😀', number: 42, float: 1.5, bool: true };
  for (const [key, value] of Object.entries(values)) {
    assert.equal(Cache.put_(`k:${key}`, value, 60), true);
    assert.deepEqual(env.ctx.__plain(Cache.get_(`k:${key}`)), value, key);
  }
  assert.equal(Cache.get_('k:missing'), null);
});

test('entries expire on their ttl, which is capped at 6 hours', () => {
  const { env, Cache } = fresh();
  Cache.put_('short', 'a', 60);
  Cache.put_('long', 'b', 999999);
  env.fakes.clock.advance(60 * 1000);
  assert.equal(Cache.get_('short'), null);
  env.fakes.clock.advance(21600 * 1000 - 60 * 1000 - 1);
  assert.equal(Cache.get_('long'), 'b');
  env.fakes.clock.advance(1);
  assert.equal(Cache.get_('long'), null, 'capped at 21600 s');
});

test('put_ needs a ttl that is a positive integer number of seconds', () => {
  const { Cache } = fresh();
  for (const bad of [undefined, 0, -1, 1.5, '60', NaN, null]) expectCode(() => Cache.put_('k', 1, bad), 'INTERNAL');
  expectCode(() => Cache.put_('', 1, 60), 'INTERNAL');
  expectCode(() => Cache.put_(7, 1, 60), 'INTERNAL');
});

test('a value of 90,000 bytes or less is cached; larger is not, and bytes (not characters) are counted', () => {
  const { Cache } = fresh();
  assert.equal(Cache.put_('edge', 'x'.repeat(89998), 60), true, 'the JSON text is exactly 90,000 bytes with its quotes');
  assert.equal(Cache.get_('edge').length, 89998);
  assert.equal(Cache.put_('over', 'x'.repeat(89999), 60), false);
  assert.equal(Cache.get_('over'), null);
  // 45,001 two-byte characters: under 90,000 characters, over 90,000 bytes
  assert.equal(Cache.put_('wide', 'é'.repeat(45001), 60), false);
  assert.equal(Cache.put_('wide-ok', 'é'.repeat(44999), 60), true);
});

test('a value that is not JSON is not cached, and nothing is thrown', () => {
  const { env, Cache } = fresh();
  assert.equal(Cache.put_('u', undefined, 60), false);
  assert.equal(Cache.put_('f', () => 1, 60), false);
  assert.equal(Cache.put_('b', 10n, 60), false);
  assert.equal(Cache.put_('c', env.run('var loop = {}; loop.self = loop; loop'), 60), false);
  assert.equal(Cache.get_('u'), null);
});

test('a corrupt entry reads as a miss and is removed', () => {
  const { env, Cache, raw } = fresh();
  env.run("CacheService.getScriptCache().put('bad', '{not json', 60)");
  assert.equal(Cache.get_('bad'), null);
  assert.equal(raw('bad'), null);
});

test('a key longer than 250 characters is never cached (CacheService would throw); exactly 250 is fine', () => {
  const { Cache } = fresh();
  const long = 'k'.repeat(251);
  assert.equal(Cache.put_(long, 1, 60), false);
  assert.equal(Cache.get_(long), null);
  assert.doesNotThrow(() => Cache.remove_(long));
  const edge = 'k'.repeat(250);
  assert.equal(Cache.put_(edge, 1, 60), true);
  assert.equal(Cache.get_(edge), 1);
});

test('remove_ deletes an entry', () => {
  const { Cache } = fresh();
  Cache.put_('gone', 1, 60);
  Cache.remove_('gone');
  assert.equal(Cache.get_('gone'), null);
});

test('with the cache service down, get_ misses, put_ reports false, remove_ is quiet', () => {
  const { env, Cache } = fresh();
  brokenCache(env);
  assert.equal(Cache.get_('k'), null);
  assert.equal(Cache.put_('k', 1, 60), false);
  assert.doesNotThrow(() => Cache.remove_('k'));
});

// ---------------------------------------------------------------- the keys of section 5.4

test('TTLs are those of the section 5.4 table', () => {
  const { env, Cache } = fresh();
  assert.deepEqual(env.ctx.__plain(Cache.TTL_), { GEN: 21600, ACCT: 60, CATALOG: 300, GRANT: 60, LIVE: 60, REPORT: 300, SETTINGS: 300 });
});

test('acctKey_ is acct:{gen}:{email} and changes when gen:acct is bumped', () => {
  const { Cache } = fresh();
  assert.equal(Cache.GEN_ACCT_, 'gen:acct');
  assert.equal(Cache.acctKey_('ann@flink.test'), 'acct:0:ann@flink.test');
  Cache.bump_(Cache.GEN_ACCT_);
  assert.equal(Cache.acctKey_('ann@flink.test'), 'acct:1:ann@flink.test');
});

test('catalogKey_ is cat:{wsId}:{gen} and only that workspace\'s bump changes it', () => {
  const { Cache } = fresh();
  assert.equal(Cache.genWs_('w1'), 'gen:ws:w1');
  assert.equal(Cache.catalogKey_('w1'), 'cat:w1:0');
  Cache.bump_(Cache.genWs_('w2'));
  assert.equal(Cache.catalogKey_('w1'), 'cat:w1:0');
  Cache.bump_(Cache.genWs_('w1'));
  assert.equal(Cache.catalogKey_('w1'), 'cat:w1:1');
  assert.equal(Cache.catalogKey_('w2'), 'cat:w2:1');
});

test('reportKey_ is rep:{wsId}:{gen}:{digest} and changes when EITHER gen:ws or gen:rep of that workspace is bumped', () => {
  const { Cache } = fresh();
  const digest = 'f'.repeat(64);
  assert.equal(Cache.genRep_('w1'), 'gen:rep:w1');
  assert.equal(Cache.reportKey_('w1', digest), `rep:w1:0.0:${digest}`);
  Cache.bump_(Cache.genWs_('w1'));
  assert.equal(Cache.reportKey_('w1', digest), `rep:w1:1.0:${digest}`);
  Cache.bump_(Cache.genRep_('w1'));
  assert.equal(Cache.reportKey_('w1', digest), `rep:w1:1.1:${digest}`);
  assert.equal(Cache.reportKey_('w2', digest), `rep:w2:0.0:${digest}`, 'another workspace is untouched');
});

test('settingsKey_, grantKey_ and liveKey_', () => {
  const { Cache } = fresh();
  assert.equal(Cache.GEN_SETTINGS_, 'gen:settings');
  assert.equal(Cache.settingsKey_(), 'settings:0');
  Cache.bump_(Cache.GEN_SETTINGS_);
  assert.equal(Cache.settingsKey_(), 'settings:1');
  assert.equal(Cache.grantKey_('abc123'), 'grant:abc123');
  assert.equal(Cache.liveKey_('w1'), 'live:w1');
});

test('every key the app builds fits the 250-character limit for realistic ids', () => {
  const { Cache } = fresh();
  const wsId = '123e4567-e89b-42d3-a456-426614174000';
  const keys = [Cache.catalogKey_(wsId), Cache.reportKey_(wsId, 'f'.repeat(64)), Cache.liveKey_(wsId), Cache.grantKey_('a'.repeat(64)),
    Cache.acctKey_('a'.repeat(64) + '@flink.test')];
  for (const key of keys) assert.ok(key.length <= 250, `${key.length}: ${key}`);
});

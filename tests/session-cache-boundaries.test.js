'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionSheetFixture } = require('./helpers/session-sheet-fixture');

test('cached revoked records fail closed before identity or activity writes', () => {
  const fx = sessionSheetFixture();
  fx.context.SessionService._putCachedSession('HASH-1', { ...fx.session, Revoked: 'TRUE' });
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('a cached validation cannot refresh a session revoked before its durable touch read', () => {
  const fx = sessionSheetFixture();
  fx.session.LastSeenAt = new Date(fx.clock.now - 6 * 60000).toISOString();
  fx.context.SessionService._putCachedSession('HASH-1', fx.session);
  fx.controls.onSessionRead = () => { fx.session.Revoked = true; };
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.cache.has(fx.context.SessionService._sessionCacheKey('HASH-1')), false);
  assert.equal(fx.session.Revoked, true);
});

test('session revocation cannot survive failed eviction for more than sixty seconds', () => {
  const fx = sessionSheetFixture();
  fx.validate();
  fx.controls.failRemove = true;
  fx.context.MasterRepository.updateSession('S1', { Revoked: true });
  fx.clock.now += 60001;
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('session touch resolves its current row after a purge shifts indexes', () => {
  const fx = sessionSheetFixture();
  fx.session.LastSeenAt = new Date(fx.clock.now - 6 * 60000).toISOString();
  fx.context.SessionService._putCachedSession('HASH-1', { ...fx.session, _rowIndex: 7 });
  fx.tables.Sessions.delete(7);
  fx.tables.Sessions.set(3, fx.session);
  fx.validate();
  assert.equal(fx.session.LastSeenAt, new Date(fx.clock.now).toISOString());
});

test('malformed explicit absolute expiry is rejected rather than treated as legacy', () => {
  const fx = sessionSheetFixture();
  fx.session.AbsoluteExpiresAt = 'invalid';
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('duplicate authentication keys fail closed instead of choosing the first row', () => {
  const fx = sessionSheetFixture();
  fx.tables.Sessions.set(8, { ...fx.session, SessionID: 'OTHER-SESSION' });
  assert.throws(() => fx.validate(), error => error.code === 'CONFLICT');
});

test('all-method session request counts remain bounded at 10 and 50,000 rows', () => {
  const measurements = [10, 50000].map(size => {
    const fx = sessionSheetFixture(size);
    fx.validate();
    const cold = fx.counter.snapshot();
    fx.counter.reset();
    fx.validate();
    const warm = fx.counter.snapshot();
    fx.clock.now += 6 * 60000;
    fx.counter.reset();
    fx.validate();
    return { cold, warm, touch: fx.counter.snapshot() };
  });
  assert.deepEqual(measurements[0], measurements[1]);
  // Includes metadata and finder methods, not only getValues/setValues.
  assert.equal(measurements[0].cold.total, 41);
  assert.equal(measurements[0].cold.byMethod.setValues || 0, 0);
  assert.equal(measurements[0].warm.total, 0);
  assert.equal(measurements[0].touch.total, 63);
  assert.equal(measurements[0].touch.byMethod.setValues, 1);
});

test('session epoch revocation still takes effect if user cache eviction fails', () => {
  const fx = sessionSheetFixture();
  fx.validate();
  fx.controls.failRemove = true;
  fx.account.SessionEpoch = 2;
  fx.context.MasterRepository.invalidateUserCache('U1');
  fx.clock.now += 60001;
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('cache eviction falls back to bounded durable reads', () => {
  const fx = sessionSheetFixture();
  fx.validate();
  const cold = fx.counter.snapshot();
  fx.cache.clear();
  fx.counter.reset();
  fx.validate();
  assert.deepEqual(fx.counter.snapshot(), cold);
});

test('busy session mutation fails without any writes or lock ownership leak', () => {
  const fx = sessionSheetFixture();
  fx.controls.lockAvailable = false;
  assert.throws(() => fx.context.MasterRepository.updateSession('S1', { Revoked: true }),
    error => error.code === 'SERVER_BUSY');
  assert.equal(fx.counter.snapshot().total, 0);
  assert.equal(fx.controls.locked, false);
});

test('session expiry rejects the exact expiry instant', () => {
  const fx = sessionSheetFixture();
  fx.session.ExpiresAt = new Date(fx.clock.now).toISOString();
  assert.throws(() => fx.validate(), error => error.code === 'SESSION_EXPIRED');
});

test('explicit malformed account or session epochs cannot become legacy epoch one', () => {
  for (const [record, key, value] of [['account', 'SessionEpoch', 'bad'], ['session', 'AccountEpoch', 0]]) {
    const fx = sessionSheetFixture();
    fx[record][key] = value;
    assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
  }
});

test('housekeeping snapshots and row deletions share the session mutation lock', () => {
  const fx = sessionSheetFixture();
  const expired = new Date(fx.clock.now - 8 * 86400000).toISOString();
  for (const row of [2, 3, 4]) fx.tables.Sessions.set(row, {
    ...fx.session, SessionID: 'OLD-' + row, Revoked: true, RevokedAt: expired, ExpiresAt: expired
  });
  fx.context.MasterRepository.getTableData = name => {
    assert.equal(fx.controls.locked, true, 'Housekeeping snapshot requires session lock');
    return { rows: [...fx.tables[name]].map(([row, record]) => ({ ...record, _rowIndex: row })) };
  };
  const deletes = [];
  fx.context.MasterRepository.deleteRows = (name, start, count) => {
    assert.equal(fx.controls.locked, true);
    deletes.push({ name, start, count });
  };
  fx.context.JobService.logJobRun = () => assert.equal(fx.controls.locked, false);
  const result = fx.context.JobService.dispatchHousekeeping();
  assert.equal(result.purgedSessionsCount, 3);
  assert.deepEqual(deletes, [{ name: 'Sessions', start: 2, count: 3 }]);
});

test('pre-upgrade five-minute cache entries cannot bypass the new revocation bound', () => {
  const fx = sessionSheetFixture();
  fx.cache.set('S:HASH-1', { value: JSON.stringify(fx.session), expires: fx.clock.now + 300000 });
  fx.session.Revoked = true;
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('cache backend failures fall back to current durable account security state', () => {
  const fx = sessionSheetFixture();
  fx.context.CacheService.getScriptCache = () => ({
    get() { throw new Error('cache unavailable'); },
    put() { throw new Error('cache unavailable'); },
    remove() { throw new Error('cache unavailable'); }
  });
  assert.equal(fx.validate().userId, 'U1');
  fx.account.Status = 'LOCKED';
  assert.throws(() => fx.validate(), error => error.code === 'ACCOUNT_LOCKED');
});

test('flush failures release the session lock and never report mutation success', () => {
  const fx = sessionSheetFixture();
  fx.context.SpreadsheetApp.flush = () => { throw new Error('synthetic flush failure'); };
  assert.throws(() => fx.context.MasterRepository.updateSession('S1', { Revoked: true }), /synthetic flush failure/);
  assert.equal(fx.controls.locked, false);
});

test('delayed snapshots cannot start a fresh one-minute security cache window', () => {
  for (const withoutCacheService of [false, true]) {
    const fx = sessionSheetFixture();
    if (withoutCacheService) delete fx.context.CacheService;
    const observedAt = fx.clock.now;
    fx.clock.now += 60001;
    fx.context.SessionService._putCachedSession('HASH-1', fx.session, observedAt);
    fx.context.MasterRepository._putCachedUserBundle('U1', { account: fx.account, accesses: [] }, observedAt);
    assert.equal(fx.context.SessionService._getCachedSession('HASH-1'), null);
    assert.equal(fx.context.MasterRepository._getCachedUserBundle('U1'), null);
  }
});

test('security cache envelopes enforce their deadline even if the backend retains them', () => {
  const fx = sessionSheetFixture();
  fx.validate();
  for (const entry of fx.cache.values()) entry.expires += 300000;
  fx.clock.now += 60001;
  fx.session.Revoked = true;
  assert.throws(() => fx.validate(), error => error.code === 'AUTH_REQUIRED');
});

test('row shifts between key finding and reading cannot return a different session', () => {
  const fx = sessionSheetFixture();
  fx.controls.onSessionRead = () => {
    fx.tables.Sessions.set(7, { ...fx.session, TokenHash: 'ANOTHER-HASH', SessionID: 'S2' });
  };
  assert.throws(() => fx.validate(), error => error.code === 'SERVER_BUSY');
});

test('delayed session touches preserve newer activity and shortened absolute expiry', () => {
  const fx = sessionSheetFixture();
  const updatedAt = new Date(fx.clock.now - 1000).toISOString();
  fx.session.LastSeenAt = updatedAt;
  const absolute = new Date(fx.clock.now + 60000).toISOString();
  fx.session.AbsoluteExpiresAt = absolute;
  const result = fx.context.MasterRepository.updateSession('S1', {
    LastSeenAt: new Date(fx.clock.now - 5000).toISOString(),
    ExpiresAt: new Date(fx.clock.now + 3600000).toISOString(),
    AbsoluteExpiresAt: new Date(fx.clock.now + 7200000).toISOString()
  }, { requireActive: true, expectedTokenHash: 'HASH-1', expectedUserId: 'U1', expectedEpoch: 1 });
  assert.equal(result.LastSeenAt, updatedAt);
  assert.equal(result.AbsoluteExpiresAt, absolute);
  assert.equal(fx.counter.snapshot().byMethod.setValues || 0, 0);
});

test('false and zero absolute deadlines cannot fall back to legacy expiry', () => {
  for (const value of [false, 0]) {
    const fx = sessionSheetFixture();
    fx.session.AbsoluteExpiresAt = value;
    assert.throws(() => fx.validate(), error => ['AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(error.code));
  }
});

test('a nested session mutation preserves the callers lock ownership', () => {
  const fx = sessionSheetFixture();
  fx.controls.locked = true;
  fx.context.MasterRepository.updateSession('S1', { Revoked: true });
  assert.equal(fx.controls.locked, true);
  assert.equal(fx.session.Revoked, true);
});

test('a session touch clamps its idle deadline to a concurrently shortened absolute deadline', () => {
  const fx = sessionSheetFixture();
  const original = { ...fx.session };
  original.LastSeenAt = new Date(fx.clock.now - 6 * 60000).toISOString();
  fx.context.SessionService._putCachedSession('HASH-1', original);
  fx.session.AbsoluteExpiresAt = new Date(fx.clock.now + 60000).toISOString();
  fx.validate();
  assert.equal(fx.session.ExpiresAt, fx.session.AbsoluteExpiresAt);
});

test('revoke-all flushes the durable account epoch before releasing its lock', () => {
  const fx = sessionSheetFixture();
  let flushed = false;
  fx.context.SpreadsheetApp.flush = () => {
    assert.equal(fx.controls.locked, true);
    flushed = true;
  };
  assert.equal(fx.context.MasterRepository.bumpSessionEpoch('U1'), 2);
  assert.equal(flushed, true);
  assert.equal(fx.controls.locked, false);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/SessionService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture(lastSeenAgeMinutes, options = {}) {
  const now = Date.now();
  const writes = [];
  const session = {
    SessionID: 'S1',
    UserID: 'U1',
    CreatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    LastSeenAt: new Date(now - lastSeenAgeMinutes * 60 * 1000).toISOString(),
    ExpiresAt: options.expiresAt || new Date(now + 7 * 60 * 60 * 1000).toISOString(),
    AbsoluteExpiresAt: options.absoluteExpiresAt || new Date(now + 23 * 60 * 60 * 1000).toISOString(),
    Revoked: false,
    ClientType: 'PORTABLE_WINDOWS',
    ClientLabel: ''
  };

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    SESSION_EXPIRED: 'SESSION_EXPIRED',
    ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    LIMITS: {
      SESSION_IDLE_TIMEOUT_HOURS: 8,
      SESSION_ABSOLUTE_TIMEOUT_HOURS: 24,
      SESSION_TOUCH_INTERVAL_MINUTES: 5
    },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', LOCKED: 'LOCKED' }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    assertAccountIdentity() { return 'user@example.com'; }
  };
  global.SecurityService = {
    hashToken() { return 'HASH'; },
    generateSessionToken() { return 'TOKEN'; }
  };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findSessionByTokenHash() { return session; },
    findAccountById() {
      if (options.accountMissing) return null;
      return {
        UserID: 'U1',
        Username: 'user',
        Email: 'user@example.com',
        Role: 'USER',
        Status: options.accountStatus || 'ACTIVE'
      };
    },
    updateSession(_id, updates) { writes.push({ ...updates }); },
    createSession() {}
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    SessionService: require(servicePath).SessionService,
    writes,
    session
  };
}

test('session validation does not write for every request inside touch interval', () => {
  const fx = fixture(1);
  fx.SessionService.validateSession('TOKEN');
  assert.equal(fx.writes.length, 0);
});

test('session activity is persisted after configured touch interval', () => {
  const fx = fixture(6);
  fx.SessionService.validateSession('TOKEN');
  assert.equal(fx.writes.length, 1);
  assert.ok(fx.writes[0].LastSeenAt);
  assert.ok(fx.writes[0].ExpiresAt);
  assert.ok(fx.writes[0].AbsoluteExpiresAt);
});


test('malformed session timestamps fail closed and revoke the session', () => {
  const fx = fixture(1);
  fx.session.ExpiresAt = 'not-a-date';

  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.writes[0].Revoked, true);
});

test('absolute timeout cannot be extended by recent activity', () => {
  const fx = fixture(1, {
    absoluteExpiresAt: new Date(Date.now() - 1000).toISOString()
  });

  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'SESSION_EXPIRED'
  );
  assert.equal(fx.writes.at(-1).Revoked, true);
});

test('locked account revokes existing session instead of allowing automatic reuse later', () => {
  const fx = fixture(1, { accountStatus: 'LOCKED' });

  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'ACCOUNT_LOCKED'
  );
  assert.equal(fx.writes.at(-1).Revoked, true);
});

test('deleted/missing account revokes orphaned session', () => {
  const fx = fixture(1, { accountMissing: true });

  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.writes.at(-1).Revoked, true);
});

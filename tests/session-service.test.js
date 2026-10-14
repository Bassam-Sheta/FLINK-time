'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
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
    AuthLevel: 'MFA',
    UserID: 'U1',
    CreatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    LastSeenAt: new Date(now - lastSeenAgeMinutes * 60 * 1000).toISOString(),
    ExpiresAt: options.expiresAt || new Date(now + 7 * 60 * 60 * 1000).toISOString(),
    AbsoluteExpiresAt: options.absoluteExpiresAt || new Date(now + 23 * 60 * 60 * 1000).toISOString(),
    Revoked: false,
    AccountEpoch: options.sessionEpoch || 1,
    ClientType: 'WEB',
    ClientLabel: 'user@example.com'
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
  let findSessionCalls = 0;
  global.MasterRepository = {
    findSessionByTokenHash() {
      findSessionCalls += 1;
      return options.sessionMissing ? null : session;
    },
    findSessionByTokenHashFast() {
      findSessionCalls += 1;
      return options.sessionMissing ? null : session;
    },
    findAccountById() {
      if (options.accountMissing) return null;
      return {
        UserID: 'U1',
        Username: 'user',
        Email: 'user@example.com',
        Role: 'USER',
        Status: options.accountStatus || 'ACTIVE',
        SessionEpoch: options.accountEpoch || 1
      };
    },
    updateSession(_id, updates) {
      writes.push({ ...updates });
      return { ...session, ...updates };
    },
    createSession() {}
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    SessionService: require(servicePath).SessionService,
    writes,
    session,
    getFindSessionCalls: () => findSessionCalls
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


test('account epoch bump invalidates a warm legacy session immediately', () => {
  const fx = fixture(1, { accountEpoch: 2, sessionEpoch: 1 });

  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
});

test('negative session lookup caching prevents repeated sheet queries for invalid tokens', () => {
  const fx = fixture(1, { sessionMissing: true });

  // First check queries repository and fails
  assert.throws(
    () => fx.SessionService.validateSession('INVALID_TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.getFindSessionCalls(), 1);

  // Second check with same invalid token hits negative cache without repository query
  assert.throws(
    () => fx.SessionService.validateSession('INVALID_TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.getFindSessionCalls(), 1);
});

test('revokeSession puts token in negative cache and prevents subsequent sheet queries', () => {
  const fx = fixture(1);

  // Revoke session
  fx.SessionService.revokeSession('TOKEN');
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.writes[0].Revoked, true);
  const callsAfterRevoke = fx.getFindSessionCalls();
  assert.equal(callsAfterRevoke, 1); // 1 call from revokeSession to mark row in storage

  // Validating revoked token hits negative cache directly without additional query
  assert.throws(
    () => fx.SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.getFindSessionCalls(), callsAfterRevoke);
});

test('beginRequest clears in-memory negative session cache', () => {
  const fx = fixture(1, { sessionMissing: true });

  assert.throws(
    () => fx.SessionService.validateSession('INVALID_TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.getFindSessionCalls(), 1);

  // beginRequest resets cache
  fx.SessionService.beginRequest();

  // Following request queries repository again
  assert.throws(
    () => fx.SessionService.validateSession('INVALID_TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.getFindSessionCalls(), 2);
});

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

function fixture(lastSeenAgeMinutes) {
  const now = Date.now();
  const writes = [];
  const session = {
    SessionID: 'S1',
    UserID: 'U1',
    CreatedAt: new Date(now - 60 * 60 * 1000).toISOString(),
    LastSeenAt: new Date(now - lastSeenAgeMinutes * 60 * 1000).toISOString(),
    ExpiresAt: new Date(now + 7 * 60 * 60 * 1000).toISOString(),
    AbsoluteExpiresAt: new Date(now + 23 * 60 * 60 * 1000).toISOString(),
    Revoked: false
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
  global.SecurityService = {
    hashToken() { return 'HASH'; },
    generateSessionToken() { return 'TOKEN'; }
  };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findSessionByTokenHash() { return session; },
    findAccountById() {
      return { UserID: 'U1', Username: 'user', Role: 'USER', Status: 'ACTIVE' };
    },
    updateSession(_id, updates) { writes.push({ ...updates }); },
    createSession() {}
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    SessionService: require(servicePath).SessionService,
    writes
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

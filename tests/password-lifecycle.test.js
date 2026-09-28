'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/AuthService.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture() {
  const account = {
    UserID: 'U1',
    Username: 'user1',
    Role: 'USER',
    Status: 'ACTIVE',
    MustChangePassword: true
  };
  const cred = {
    UserID: 'U1',
    PasswordHash: 'OLDHASH',
    PasswordVersion: 2
  };
  const accountUpdates = [];
  const credentialUpdates = [];
  let revoked = 0;
  let sessionsCreated = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: {
      ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', PASSIVE: 'PASSIVE',
      ARCHIVED: 'ARCHIVED', DELETED: 'DELETED'
    },
    AUDIT_EVENTS: { PASSWORD_CHANGED: 'PASSWORD_CHANGED', PASSWORD_RESET: 'PASSWORD_RESET' }
  };
  global.Validation = { validatePassword(v) { return v; } };
  global.SecurityService = {
    verifyPassword(password, hash) {
      if (hash === 'OLDHASH') return password === 'OldPass123!';
      return false;
    },
    hashPassword(password) { return 'HASH:' + password; }
  };
  global.AuthorizationService = {
    assertRole(ctx, roles) { assert.ok(roles.includes(ctx.role)); }
  };
  global.SessionService = {
    validateSession() {
      return {
        userId: 'U1',
        role: 'USER',
        user: account,
        session: { ClientType: 'WEB' }
      };
    },
    revokeAllUserSessions() { revoked += 1; },
    createSession() {
      sessionsCreated += 1;
      return { sessionToken: 'NEWSESSION', expiresAt: 'later' };
    }
  };
  global.MasterRepository = {
    getCredentials() { return cred; },
    findAccountById() { return account; },
    updateCredentials(_id, updates) {
      credentialUpdates.push({ ...updates });
      Object.assign(cred, updates);
    },
    updateAccount(_id, updates) {
      accountUpdates.push({ ...updates });
      Object.assign(account, updates);
    },
    logSecurityEvent() {},
    logGlobalAudit() {}
  };
  global.LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
  };
  delete global.SpreadsheetApp;

  delete require.cache[require.resolve(servicePath)];
  const AuthService = require(servicePath).AuthService;
  AuthService._mfaChallengeMemory = {};

  return {
    AuthService, account, cred, accountUpdates, credentialUpdates,
    getRevoked: () => revoked,
    getSessionsCreated: () => sessionsCreated
  };
}

test('forced password change cannot reuse current password', () => {
  const fx = fixture();
  assert.throws(
    () => fx.AuthService.changePassword('SESSION', 'OldPass123!', 'OldPass123!'),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      /different/.test(err.message)
  );
  assert.equal(fx.credentialUpdates.length, 0);
  assert.equal(fx.getRevoked(), 0);
});

test('successful password change clears MustChangePassword and rotates sessions', () => {
  const fx = fixture();
  const result = fx.AuthService.changePassword('SESSION', 'OldPass123!', 'NewPass456!');

  assert.equal(result.sessionToken, 'NEWSESSION');
  assert.equal(fx.account.MustChangePassword, false);
  assert.equal(fx.cred.PasswordVersion, 3);
  assert.equal(fx.getRevoked(), 1);
  assert.equal(fx.getSessionsCreated(), 1);
});

test('admin reset cannot set temporary password equal to current password', () => {
  const fx = fixture();
  const superAdmin = { userId: 'SA1', role: 'SUPER_ADMIN' };

  assert.throws(
    () => fx.AuthService.resetPasswordByAdmin(superAdmin, 'U1', 'OldPass123!'),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      /different/.test(err.message)
  );

  assert.equal(fx.credentialUpdates.length, 0);
  assert.equal(fx.getRevoked(), 0);
});

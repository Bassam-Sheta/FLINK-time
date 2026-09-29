'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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

function loadFixture() {
  const account = {
    UserID: 'USR-1',
    Username: 'worker',
    DisplayName: 'Worker',
    Role: 'USER',
    Status: 'ACTIVE',
    PrimaryWorkspaceID: 'W1',
    Email: 'worker@example.com',
    MustChangePassword: false
  };
  const cred = {
    UserID: 'USR-1',
    PasswordHash: 'hash',
    FailedLoginCount: 0,
    LockUntil: '',
    MfaEnabled: true,
    TotpSecret: 'SECRET',
    LastSuccessfulTotpStep: ''
  };
  const events = [];
  const accountUpdates = [];
  let sessionCount = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', PASSIVE: 'PASSIVE' },
    LIMITS: {
      MAX_FAILED_LOGIN_ATTEMPTS: 5,
      LOCKOUT_DURATION_MINUTES: 15,
      LOGIN_RETRY_DELAYS_SECONDS: [0, 0, 0, 0, 0]
    },
    AUDIT_EVENTS: {
      LOGIN_FAIL: 'LOGIN_FAIL',
      LOGIN_SUCCESS: 'LOGIN_SUCCESS',
      ACCOUNT_LOCK: 'ACCOUNT_LOCK',
      LOGIN_THROTTLED: 'LOGIN_THROTTLED',
      IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
      MFA_VERIFIED: 'MFA_VERIFIED'
    }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    getCurrentGoogleEmail() { return 'worker@example.com'; },
    assertAccountIdentity() { return 'worker@example.com'; }
  };
  global.SecurityService = {
    verifyPassword() { return true; },
    getPepper() { return 'pepper'; },
    hashToken(value) {
      return crypto.createHash('sha256').update(String(value)).digest('hex');
    },
    constantTimeEquals(a, b) { return a === b; },
    verifyTotpWithStep() { return { valid: true, timeStep: 123456 }; }
  };
  global.MasterRepository = {
    findAccountByUsername() { return account; },
    findAccountById() { return account; },
    getCredentials() { return cred; },
    updateCredentials(_id, updates) { Object.assign(cred, updates); },
    updateAccount(_id, updates) {
      accountUpdates.push({ ...updates });
      Object.assign(account, updates);
    },
    logSecurityEvent(event) { events.push({ ...event }); },
    logGlobalAudit() {},
    getWorkspaceAccessForUser() { return [{ WorkspaceID: 'W1' }]; }
  };
  global.SessionService = {
    createSession() {
      sessionCount++;
      return { sessionToken: 'SESSION-' + sessionCount, expiresAt: 'later' };
    }
  };
  global.LockService = {
    getScriptLock() {
      return { waitLock() {}, releaseLock() {} };
    }
  };

  delete global.PropertiesService;
  delete require.cache[require.resolve(servicePath)];
  const AuthService = require(servicePath).AuthService;
  AuthService._mfaChallengeMemory = {};
  AuthService._mfaEnrollmentMemory = {};

  return {
    AuthService,
    account,
    cred,
    events,
    accountUpdates,
    getSessionCount: () => sessionCount
  };
}

test('correct password does not record completed login before MFA succeeds', () => {
  const fx = loadFixture();
  const result = fx.AuthService.login('worker', 'Password123!', 'WEB');

  assert.equal(result.mfaRequired, true);
  assert.equal(fx.getSessionCount(), 0);
  assert.equal(
    fx.accountUpdates.some(update => Object.hasOwn(update, 'LastLoginAt')),
    false
  );
  assert.equal(
    fx.events.some(event => event.EventType === 'LOGIN_SUCCESS'),
    false
  );
});

test('successful MFA consumes challenge, records login success, and rejects challenge reuse', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');

  const authenticated = fx.AuthService.verifyMfa(
    first.mfaChallengeToken,
    '123456',
    'WEB'
  );

  assert.equal(authenticated.sessionToken, 'SESSION-1');
  assert.equal(fx.getSessionCount(), 1);
  assert.equal(
    fx.events.some(event => event.EventType === 'MFA_VERIFIED' && event.Success === true),
    true
  );
  assert.equal(
    fx.events.some(event => event.EventType === 'LOGIN_SUCCESS' && event.Success === true),
    true
  );

  assert.throws(
    () => fx.AuthService.verifyMfa(first.mfaChallengeToken, '654321', 'WEB'),
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED' &&
      /already used|invalid|expired|replaced/i.test(err.message)
  );
  assert.equal(fx.getSessionCount(), 1);
});

test('MFA completion rechecks account ACTIVE state', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');
  fx.account.Status = 'PASSIVE';

  assert.throws(
    () => fx.AuthService.verifyMfa(first.mfaChallengeToken, '123456', 'WEB'),
    err => err instanceof AppError &&
      err.code === 'ACCOUNT_PASSIVE' &&
      err.statusCode === 403
  );
  assert.equal(fx.getSessionCount(), 0);
});


test('MFA challenge is rechecked after lock acquisition to close concurrent-consumption race', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');

  global.LockService = {
    getScriptLock() {
      return {
        waitLock() {
          // Simulate another request consuming the challenge after our pre-lock
          // validation but before this request enters the critical section.
          fx.AuthService._deleteMfaChallenge('USR-1');
        },
        releaseLock() {}
      };
    }
  };

  assert.throws(
    () => fx.AuthService.verifyMfa(first.mfaChallengeToken, '123456', 'WEB'),
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED' &&
      /already used|invalid|expired|replaced/i.test(err.message)
  );
  assert.equal(fx.getSessionCount(), 0);
});

test('MFA enrollment consumes the confirmation TOTP timestep', () => {
  const fx = loadFixture();
  fx.cred.PendingTotpSecret = 'PENDING-SECRET';
  fx.cred.MfaEnabled = false;
  fx.cred.LastSuccessfulTotpStep = '';
  fx.AuthService._storeMfaEnrollment('USR-1', {
    sessionId: 'S1',
    expiresAtMs: Date.now() + 60000,
    replacing: false
  });

  const result = fx.AuthService.confirmMfa(
    {
      userId: 'USR-1',
      role: 'USER',
      user: fx.account,
      session: { SessionID: 'S1', ClientType: 'WEB', ClientLabel: 'worker@example.com' }
    },
    '123456'
  );

  assert.equal(result.ok, true);
  assert.equal(fx.cred.MfaEnabled, true);
  assert.equal(fx.cred.PendingTotpSecret, '');
  assert.equal(fx.cred.LastSuccessfulTotpStep, 123456);
});

test('MFA enrollment confirmation is rejected from another session', () => {
  const fx = loadFixture();
  fx.cred.PendingTotpSecret = 'PENDING-SECRET';
  fx.cred.MfaEnabled = false;
  fx.AuthService._storeMfaEnrollment('USR-1', {
    sessionId: 'S1',
    expiresAtMs: Date.now() + 60000,
    replacing: false
  });

  assert.throws(
    () => fx.AuthService.confirmMfa(
      {
        userId: 'USR-1',
        role: 'USER',
        user: fx.account,
        session: { SessionID: 'S2', ClientType: 'WEB', ClientLabel: 'worker@example.com' }
      },
      '123456'
    ),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.cred.PendingTotpSecret, '');
});

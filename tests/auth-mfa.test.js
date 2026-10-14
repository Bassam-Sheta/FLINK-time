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
    LastSuccessfulTotpStep: '',
    RecoveryJSON: ''
  };
  const events = [];
  const session = { SessionID: 'S1', UserID: 'USR-1', TokenHash: 'SYNTHETIC-HASH', AuthLevel: 'MFA_ENROLLMENT',
    AccountEpoch: 1, ClientType: 'WEB', ClientLabel: 'worker@example.com',
    ExpiresAt: new Date(Date.now() + 600000).toISOString(), AbsoluteExpiresAt: new Date(Date.now() + 600000).toISOString() };
  const accountUpdates = [];
  let sessionCount = 0;
  let randomCounter = 0;

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
    generateRandomHex(bytes = 16) { return String(++randomCounter).padStart(bytes * 2, '0'); },
    verifyPassword() { return true; },
    getPepper() { return 'pepper'; },
    hashToken(value) {
      return crypto.createHash('sha256').update(String(value)).digest('hex');
    },
    constantTimeEquals(a, b) { return a === b; },
    verifyTotpWithStep() { return { valid: true, timeStep: 123456 }; }
  };
  global.MasterRepository = {
    assertRecoverySchema() {},
    findAccountByUsername() { return account; },
    findAccountById() { return account; },
    getCredentials() { return cred; },
    findSessionByTokenHashFast(hash) { return hash === session.TokenHash ? { ...session } : null; },
    updateCredentials(_id, updates) { Object.assign(cred, updates); },
    updateAccount(_id, updates) {
      accountUpdates.push({ ...updates });
      Object.assign(account, updates);
    },
    logSecurityEvent(event) { events.push({ ...event }); },
    logGlobalAudit() { return true; },
    revokeAllUserSessions() {},
    getWorkspaceAccessForUser() { return [{ WorkspaceID: 'W1' }]; }
  };
  global.SessionService = {
    revokeAllUserSessions() {},
    createSession() {
      sessionCount++;
      return { sessionToken: 'SESSION-' + sessionCount, expiresAt: 'later' };
    }
  };
  global.SpreadsheetApp = { flush() {} };
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
    session,
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

test('bad MFA failures are not cleared by restarting the password stage', () => {
  const fx = loadFixture();
  global.SecurityService.verifyTotpWithStep = () => ({ valid: false, timeStep: 123456 });

  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');
  assert.throws(
    () => fx.AuthService.verifyMfa(first.mfaChallengeToken, '000000', 'WEB'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.cred.FailedLoginCount, 1);

  const second = fx.AuthService.login('worker', 'Password123!', 'WEB');
  assert.equal(second.mfaRequired, true);
  assert.equal(
    fx.cred.FailedLoginCount,
    1,
    'correct password must not erase prior MFA failures before MFA succeeds'
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
    passwordVersion: 1,
    accountEpoch: 1,
    replacing: false
  });

  const result = fx.AuthService.confirmMfa(
    {
      userId: 'USR-1',
      role: 'USER',
      user: fx.account,
      session: { ...fx.session }
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
    passwordVersion: 1,
    accountEpoch: 1,
    replacing: false
  });

  assert.throws(
    () => fx.AuthService.confirmMfa(
      {
        userId: 'USR-1',
        role: 'USER',
        user: fx.account,
        session: { ...fx.session, SessionID: 'S2' }
      },
      '123456'
    ),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(fx.cred.PendingTotpSecret, 'PENDING-SECRET', 'another session must not erase the active enrollment');
});

test('verifyMfa strictly validates 6-digit numeric pattern before acquiring lock', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');

  // Non-6-digit or non-numeric tokens must be rejected immediately
  const invalidCodes = ['', '12345', '1234567', 'abcdef', '12345a', '12 456', 'null', null, undefined];
  for (const badCode of invalidCodes) {
    assert.throws(
      () => fx.AuthService.verifyMfa(first.mfaChallengeToken, badCode, 'WEB'),
      err => err instanceof AppError && err.code === 'AUTH_REQUIRED' && /6-digit code are required/i.test(err.message),
      `Expected code "${badCode}" to be rejected by verifyMfa`
    );
  }
});

test('verifyMfa trims leading/trailing whitespace around valid 6-digit code', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');

  const authenticated = fx.AuthService.verifyMfa(
    first.mfaChallengeToken,
    '  123456  ',
    'WEB'
  );
  assert.equal(authenticated.sessionToken, 'SESSION-1');
  assert.equal(fx.getSessionCount(), 1);
});

test('verifyMfa enforces caller rate limiting and cleans up challenge on rate limit', () => {
  const fx = loadFixture();
  const first = fx.AuthService.login('worker', 'Password123!', 'WEB');

  const cacheValues = new Map();
  global.CacheService = {
    getScriptCache() {
      return {
        get(key) { return cacheValues.get(key) || null; },
        put(key, value) { cacheValues.set(key, String(value)); }
      };
    }
  };

  // Pre-fill cache to simulate caller hitting attempt limit (30 per minute)
  const minuteBucket = Math.floor(Date.now() / 60000);
  const identityKey = crypto.createHash('sha256').update('worker@example.com').digest('hex').substring(0, 20);
  const callerKey = `FLINK_LOGIN_CALLER_${identityKey}_${minuteBucket}`;
  cacheValues.set(callerKey, '30');

  assert.throws(
    () => fx.AuthService.verifyMfa(first.mfaChallengeToken, '123456', 'WEB'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED' && err.statusCode === 401
  );

  // Challenge must be deleted so it cannot be abused after rate limiting
  assert.equal(fx.AuthService._getMfaChallenge('USR-1'), null);
});

test('stepUp strictly validates 6-digit numeric pattern on TOTP code', () => {
  const fx = loadFixture();
  const superAdminContext = {
    userId: 'SA1',
    role: 'SUPER_ADMIN',
    user: { UserID: 'SA1', Username: 'admin', Email: 'admin@example.com' },
    session: { SessionID: 'SES-ADMIN', ClientType: 'WEB', ClientLabel: 'admin@example.com' }
  };

  const invalidCodes = ['', '12345', '1234567', 'abcdef', '12345a', null, undefined];
  for (const badCode of invalidCodes) {
    assert.throws(
      () => fx.AuthService.stepUp(superAdminContext, 'SES-ADMIN-TOKEN', 'Pass123!', badCode),
      err => err instanceof AppError && err.code === 'AUTH_REQUIRED' && err.statusCode === 401
    );
  }
});

test('stepUp enforces caller rate limiting', () => {
  const fx = loadFixture();
  const superAdminContext = {
    userId: 'SA1',
    role: 'SUPER_ADMIN',
    user: { UserID: 'SA1', Username: 'admin', Email: 'admin@example.com' },
    session: { SessionID: 'SES-ADMIN', ClientType: 'WEB', ClientLabel: 'admin@example.com' }
  };

  const cacheValues = new Map();
  global.CacheService = {
    getScriptCache() {
      return {
        get(key) { return cacheValues.get(key) || null; },
        put(key, value) { cacheValues.set(key, String(value)); }
      };
    }
  };

  const minuteBucket = Math.floor(Date.now() / 60000);
  const identityKey = crypto.createHash('sha256').update('admin@example.com').digest('hex').substring(0, 20);
  const callerKey = `FLINK_LOGIN_CALLER_${identityKey}_${minuteBucket}`;
  cacheValues.set(callerKey, '30');

  assert.throws(
    () => fx.AuthService.stepUp(superAdminContext, 'SES-ADMIN-TOKEN', 'Pass123!', '123456'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED' && err.statusCode === 401
  );
});

test('confirmMfa strictly rejects non-6-digit verification code', () => {
  const fx = loadFixture();
  fx.cred.PendingTotpSecret = 'PENDING-SECRET';
  fx.cred.MfaEnabled = false;
  fx.AuthService._storeMfaEnrollment('USR-1', {
    sessionId: 'S1',
    expiresAtMs: Date.now() + 60000,
    passwordVersion: 1,
    accountEpoch: 1,
    replacing: false
  });

  const authContext = {
    userId: 'USR-1',
    role: 'USER',
    user: fx.account,
    session: { ...fx.session }
  };

  const invalidCodes = ['', '12345', '1234567', 'abcdef', '12345a', null, undefined];
  for (const badCode of invalidCodes) {
    assert.throws(
      () => fx.AuthService.confirmMfa(authContext, badCode),
      err => err instanceof AppError && err.code === 'AUTH_REQUIRED' && err.statusCode === 401
    );
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const authPath = path.resolve(
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

function fixture(options = {}) {
  const account = {
    UserID:'U1',
    Username:'worker',
    DisplayName:'Worker',
    Email:'worker@example.com',
    Role:'USER',
    Status:options.status || 'ACTIVE',
    PrimaryWorkspaceID:'W1',
    MustChangePassword:false
  };
  const cred = {
    UserID:'U1',
    PasswordHash:'HASH',
    FailedLoginCount:options.failedCount || 0,
    LastFailedAt:options.lastFailedAt || '',
    LockUntil:options.lockUntil || '',
    MfaEnabled:false
  };
  const events = [];
  let verifyCalls = 0;
  let sessions = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    ACCOUNT_LOCKED:'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE:'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', LOCKED:'LOCKED', PASSIVE:'PASSIVE' },
    LIMITS:{
      MAX_FAILED_LOGIN_ATTEMPTS:5,
      LOCKOUT_DURATION_MINUTES:15,
      LOGIN_RETRY_DELAYS_SECONDS:
        options.retryDelays || [0,2,5,15,30]
    },
    AUDIT_EVENTS:{
      LOGIN_FAIL:'LOGIN_FAIL',
      LOGIN_SUCCESS:'LOGIN_SUCCESS',
      ACCOUNT_LOCK:'ACCOUNT_LOCK',
      LOGIN_THROTTLED:'LOGIN_THROTTLED',
      IDENTITY_MISMATCH:'IDENTITY_MISMATCH'
    }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    getCurrentGoogleEmail() {
      return options.googleEmail || 'worker@example.com';
    },
    assertAccountIdentity(acc) {
      const actual = options.googleEmail || 'worker@example.com';
      if (actual !== String(acc.Email || '').toLowerCase()) {
        throw new AppError('AUTH_REQUIRED', 'identity mismatch', 401);
      }
      return actual;
    }
  };
  global.SecurityService = {
    verifyPassword(password) {
      verifyCalls += 1;
      return options.correctPassword !== false && password === 'CorrectPass123!';
    },
    hashToken(v) { return 'HASH:' + String(v); },
    getPepper() { return 'pepper'; }
  };
  global.MasterRepository = {
    findAccountByUsername(name) {
      return options.unknownUser || name !== 'worker' ? null : account;
    },
    findAccountById(id) {
      return id === account.UserID ? account : null;
    },
    getCredentials() { return cred; },
    updateCredentials(_id, patch) { Object.assign(cred, patch); },
    updateAccount(_id, patch) { Object.assign(account, patch); },
    logSecurityEvent(event) { events.push({ ...event }); },
    getWorkspaceAccessForUser() { return [{ WorkspaceID:'W1' }]; }
  };
  global.SessionService = {
    createSession() {
      sessions += 1;
      return { sessionToken:'SESSION', expiresAt:'later' };
    }
  };

  delete require.cache[require.resolve(authPath)];
  const AuthService = require(authPath).AuthService;
  AuthService._mfaChallengeMemory = {};

  return {
    AuthService, account, cred, events,
    getVerifyCalls:() => verifyCalls,
    getSessions:() => sessions
  };
}

function assertGeneric(fn) {
  assert.throws(
    fn,
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED' &&
      err.statusCode === 401 &&
      err.message === 'Invalid username or password.'
  );
}

test('five failed passwords lock the account for about fifteen minutes', () => {
  const fx = fixture({
    correctPassword:false,
    retryDelays:[0,0,0,0,0]
  });

  for (let i = 0; i < 5; i++) {
    assertGeneric(() =>
      fx.AuthService.login('worker', 'WrongPass123!', 'WEB')
    );
  }

  assert.equal(fx.cred.FailedLoginCount, 5);
  assert.equal(fx.account.Status, 'LOCKED');
  const remaining = new Date(fx.cred.LockUntil).getTime() - Date.now();
  assert.ok(remaining > 14 * 60 * 1000);
  assert.ok(remaining <= 15 * 60 * 1000 + 5000);
  assert.equal(
    fx.events.some(e => e.EventType === 'ACCOUNT_LOCK'),
    true
  );
});

test('graduated retry throttle rejects too-fast retry without another password hash check', () => {
  const fx = fixture({
    correctPassword:false,
    retryDelays:[0,30,60,90,120]
  });

  assertGeneric(() =>
    fx.AuthService.login('worker', 'WrongPass123!', 'WEB')
  );
  assert.equal(fx.getVerifyCalls(), 1);
  assert.equal(fx.cred.FailedLoginCount, 1);
  assert.ok(fx.cred.LastFailedAt);

  assertGeneric(() =>
    fx.AuthService.login('worker', 'WrongPass123!', 'WEB')
  );
  assert.equal(fx.getVerifyCalls(), 1);
  assert.equal(fx.cred.FailedLoginCount, 1);
  assert.equal(
    fx.events.some(e => e.EventType === 'LOGIN_THROTTLED'),
    true
  );
});

test('unknown, locked, inactive, identity mismatch and wrong password share generic client error', () => {
  assertGeneric(() =>
    fixture({ unknownUser:true }).AuthService.login(
      'worker', 'CorrectPass123!', 'WEB'
    )
  );

  assertGeneric(() =>
    fixture({
      status:'LOCKED',
      lockUntil:new Date(Date.now()+60000).toISOString()
    }).AuthService.login('worker', 'CorrectPass123!', 'WEB')
  );

  assertGeneric(() =>
    fixture({ status:'PASSIVE' }).AuthService.login(
      'worker', 'CorrectPass123!', 'WEB'
    )
  );

  assertGeneric(() =>
    fixture({ googleEmail:'other@example.com' }).AuthService.login(
      'worker', 'CorrectPass123!', 'WEB'
    )
  );

  assertGeneric(() =>
    fixture({ correctPassword:false, retryDelays:[0,0,0,0,0] })
      .AuthService.login('worker', 'WrongPass123!', 'WEB')
  );
});

test('expired timed lock auto-unlocks and valid login succeeds', () => {
  const fx = fixture({
    status:'LOCKED',
    failedCount:5,
    lockUntil:new Date(Date.now()-1000).toISOString()
  });

  const result = fx.AuthService.login(
    'worker', 'CorrectPass123!', 'WEB'
  );

  assert.equal(result.sessionToken, 'SESSION');
  assert.equal(fx.account.Status, 'ACTIVE');
  assert.equal(fx.cred.FailedLoginCount, 0);
  assert.equal(fx.cred.LastFailedAt, '');
  assert.equal(fx.getSessions(), 1);
});

'use strict';

/**
 * Administrative authenticator replacement (`users.resetMfa`).
 *
 * The guarantee under test is not "MFA is turned off for this user". It is:
 * the enrolled authenticator and recovery codes are cleared so the user's next
 * sign-in lands in the restricted MFA_ENROLLMENT session and they must bind a
 * new authenticator before any application data is reachable. Mandatory MFA is
 * preserved, sessions are revoked, and the change is attributable and
 * recoverable through before/after audit records that never contain the secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../apps-script/Code.gs');

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const PENDING_SECRET = 'KRSXG5CTMVRXEZLU';
const RECOVERY_JSON = JSON.stringify({ codes: ['aaaa-bbbb-cccc'] });

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture(overrides = {}) {
  const account = Object.assign({
    UserID: 'U1',
    Username: 'user1',
    Role: 'USER',
    Status: 'ACTIVE',
    SessionEpoch: 3
  }, overrides.account || {});

  const cred = Object.assign({
    UserID: 'U1',
    PasswordHash: 'HASH',
    PasswordVersion: 4,
    MfaEnabled: true,
    TotpSecret: TOTP_SECRET,
    PendingTotpSecret: PENDING_SECRET,
    LastSuccessfulTotpStep: '12345',
    RecoveryJSON: RECOVERY_JSON
  }, overrides.cred || {});

  const audits = [];
  const credentialUpdates = [];
  const accountUpdates = [];
  let revoked = 0;
  let auditAvailable = true;

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    CRYPTO_FAILURE: 'CRYPTO_FAILURE',
    PERMISSION_DENIED: 'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: {
      ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', PASSIVE: 'PASSIVE',
      ARCHIVED: 'ARCHIVED', DELETED: 'DELETED'
    },
    AUDIT_EVENTS: {
      MFA_RESET_INTENT: 'MFA_RESET_INTENT',
      MFA_RESET_COMPLETED: 'MFA_RESET_COMPLETED'
    }
  };
  global.AuthorizationService = {
    assertRole(context, roles) {
      if (!roles.includes(context.role)) {
        throw new AppError('PERMISSION_DENIED', 'Forbidden', 403);
      }
    }
  };
  global.SessionService = {
    revokeAllUserSessions() { revoked += 1; }
  };
  global.MasterRepository = {
    findAccountById(id) { return id === account.UserID ? account : null; },
    getCredentials(id) { return id === cred.UserID ? cred : null; },
    updateCredentials(_id, updates) {
      credentialUpdates.push({ ...updates });
      Object.assign(cred, updates);
    },
    updateAccount(_id, updates) {
      accountUpdates.push({ ...updates });
      Object.assign(account, updates);
    },
    logGlobalAudit(payload) {
      if (!auditAvailable) return false;
      audits.push(payload);
      return true;
    }
  };
  global.LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
  };
  delete global.PropertiesService;
  delete global.SpreadsheetApp;

  delete require.cache[require.resolve(servicePath)];
  const AuthService = require(servicePath).AuthService;
  AuthService._mfaChallengeMemory = { U1: 'stale-challenge' };

  return {
    AuthService,
    account,
    cred,
    audits,
    credentialUpdates,
    accountUpdates,
    getRevoked: () => revoked,
    breakAuditTrail: () => { auditAvailable = false; }
  };
}

const SUPER_ADMIN = { userId: 'SA1', role: 'SUPER_ADMIN' };

test('a Super Admin can replace another user authenticator without disabling MFA', () => {
  const fx = fixture();
  const result = fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', 'User changed phone');

  assert.equal(result.ok, true);
  assert.match(result.message, /MFA remains mandatory/i);

  // The authenticator and recovery codes are gone.
  assert.equal(fx.cred.TotpSecret, '');
  assert.equal(fx.cred.PendingTotpSecret, '');
  assert.equal(fx.cred.LastSuccessfulTotpStep, '');
  assert.equal(fx.cred.RecoveryJSON, '');

  // MfaEnabled is false so the next login is an enrollment-required session,
  // which is the restricted MFA_ENROLLMENT level. MFA is still mandatory.
  assert.equal(fx.cred.MfaEnabled, false);
});

test('replacement revokes existing sessions and clears any stale MFA challenge', () => {
  const fx = fixture();
  fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', '');

  assert.equal(fx.getRevoked(), 1);
  assert.equal(fx.AuthService._mfaChallengeMemory.U1, undefined);
});

test('the change is attributable with recoverable before/after state and no secrets', () => {
  const fx = fixture();
  fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', 'Lost device');

  assert.equal(fx.audits.length, 2, 'intent and completion must both be recorded');
  assert.equal(fx.audits[0].Action, 'MFA_RESET_INTENT');
  assert.equal(fx.audits[1].Action, 'MFA_RESET_COMPLETED');
  assert.equal(fx.audits[0].ActorUserID, 'SA1');
  assert.equal(fx.audits[0].EntityID, 'U1');

  const before = JSON.parse(JSON.stringify(fx.audits[0].BeforeJSON));
  const after = JSON.parse(JSON.stringify(fx.audits[0].AfterJSON));
  assert.equal(before.authenticatorBound, true);
  assert.equal(before.mfaEnabled, true);
  assert.equal(after.authenticatorBound, false);
  assert.equal(after.mfaEnabled, false);
  assert.equal(after.reason, 'Lost device');

  const serialized = JSON.stringify(fx.audits);
  assert.ok(!serialized.includes(TOTP_SECRET), 'the TOTP secret must never be audited');
  assert.ok(!serialized.includes(PENDING_SECRET), 'a pending secret must never be audited');
  assert.ok(!serialized.includes('aaaa-bbbb-cccc'), 'recovery codes must never be audited');
});

test('replacement fails closed when the audit trail is unavailable', () => {
  const fx = fixture();
  fx.breakAuditTrail();

  assert.throws(
    () => fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', ''),
    err => err instanceof AppError && err.code === 'CRYPTO_FAILURE'
  );

  assert.equal(fx.credentialUpdates.length, 0, 'no mutation may happen without an audit record');
  assert.equal(fx.getRevoked(), 0);
  assert.equal(fx.cred.TotpSecret, TOTP_SECRET);
});

test('only a Super Admin may replace another user authenticator', () => {
  const fx = fixture();
  assert.throws(
    () => fx.AuthService.resetMfaByAdmin({ userId: 'A1', role: 'ADMIN' }, 'U1', ''),
    err => err instanceof AppError && err.statusCode === 403
  );
  assert.equal(fx.credentialUpdates.length, 0);
});

test('a Super Admin cannot replace their own authenticator through the admin path', () => {
  const fx = fixture({ account: { UserID: 'SA1', Username: 'root', Role: 'SUPER_ADMIN' } });
  assert.throws(
    () => fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'SA1', ''),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
  assert.equal(fx.credentialUpdates.length, 0);
});

test('archived and deleted accounts are refused', () => {
  for (const status of ['ARCHIVED', 'DELETED']) {
    const fx = fixture({ account: { Status: status } });
    assert.throws(
      () => fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', ''),
      err => err instanceof AppError && err.code === 'CONFLICT',
      status
    );
    assert.equal(fx.credentialUpdates.length, 0, status);
  }
});

test('an unknown target is refused', () => {
  const fx = fixture();
  assert.throws(
    () => fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U404', ''),
    err => err instanceof AppError && err.code === 'NOT_FOUND'
  );
  assert.equal(fx.getRevoked(), 0);
});

test('a blank target id is refused before any lock or mutation', () => {
  const fx = fixture();
  assert.throws(
    () => fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, '   ', ''),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
});

test('a locked account is unlocked as part of the replacement', () => {
  const fx = fixture({ account: { Status: 'LOCKED' } });
  fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', 'Locked out and lost device');
  assert.equal(fx.account.Status, 'ACTIVE');
});

test('the replacement is recorded against the acting administrator', () => {
  const fx = fixture();
  fx.AuthService.resetMfaByAdmin(SUPER_ADMIN, 'U1', '');
  assert.ok(fx.accountUpdates.length >= 1);
  assert.equal(fx.accountUpdates[0].UpdatedBy, 'SA1');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { sessionSheetFixture } = require('./helpers/session-sheet-fixture');

function fixture() {
  const fx = sessionSheetFixture();
  const { context } = fx;
  let nonce = 0;
  Object.assign(context.SecurityService, {
    hashToken: value => crypto.createHash('sha256').update(String(value)).digest('hex'),
    generateSessionToken: () => 'SYNTHETIC-SESSION-' + (++nonce),
    generateRandomHex: (bytes = 16) => String(++nonce).padStart(bytes * 2, '0'),
    generateTotpSecret: () => 'SYNTHETIC-SECRET',
    hashPassword: () => 'SYNTHETIC-NEW-HASH',
    verifyPassword: password => password === 'SYNTHETIC-PASSWORD',
    verifyTotpWithStep: (_secret, code) => ({ valid: code === '123456', timeStep: Math.floor(fx.clock.now / 30000) })
  });
  context.KmsSecretService.encryptTotpSecret = () => 'kms$v1$SYNTHETIC';
  context.Validation.generateId = prefix => prefix + '-' + (++nonce);
  fx.session.TokenHash = context.SecurityService.hashToken('SYNTHETIC-TOKEN');
  fx.session.AuthLevel = 'MFA_ENROLLMENT';
  fx.session.ExpiresAt = fx.session.AbsoluteExpiresAt = new Date(fx.clock.now + 600000).toISOString();
  fx.account.Role = 'SUPER_ADMIN';
  const cred = { UserID: fx.account.UserID, PasswordHash: 'SYNTHETIC-HASH', PasswordVersion: 1,
    MfaEnabled: false, PendingTotpSecret: '', TotpSecret: '', LastSuccessfulTotpStep: '', FailedLoginCount: 0 };
  fx.tables.Credentials = new Map([[7, cred]]);
  const audits = [];
  context.MasterRepository.logGlobalAudit = record => { audits.push(record); return true; };
  context.MasterRepository.logSecurityEvent = () => {};
  return { ...fx, cred, audits };
}

test('mandatory enrollment rotates to the durable account epoch despite failed user-cache eviction', () => {
  const fx = fixture();
  const auth = fx.validate();
  fx.controls.failRemove = true;
  fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD');
  const result = fx.context.AuthService.confirmMfa(auth, '123456');
  const replacement = [...fx.tables.Sessions.values()].find(row => row.TokenHash === fx.context.SecurityService.hashToken(result.sessionToken));
  assert.equal(replacement.AccountEpoch, fx.account.SessionEpoch);
  assert.equal(replacement.AuthLevel, 'MFA');
  // A fresh session must use the current account, even if an old account bundle
  // survives cache removal. Stale bundles may not reject newly completed MFA.
  const verified = fx.context.SessionService.validateSession(result.sessionToken);
  assert.equal(verified.session.AuthLevel, 'MFA');
});

test('enrollment, step-up and revocation compose using real repository and session services', () => {
  const fx = fixture();
  const enrollmentAuth = fx.validate();
  fx.context.AuthService.enrollMfa(enrollmentAuth, 'SYNTHETIC-PASSWORD');
  const enrolled = fx.context.AuthService.confirmMfa(enrollmentAuth, '123456');
  assert.throws(() => fx.context.SessionService.validateSession('SYNTHETIC-TOKEN'), error => error.code === 'AUTH_REQUIRED');
  fx.clock.now += 30000;
  const auth = fx.context.SessionService.validateSession(enrolled.sessionToken);
  const stepped = fx.context.AuthService.stepUp(auth, enrolled.sessionToken, 'SYNTHETIC-PASSWORD', '123456');
  const finalAuth = fx.context.SessionService.validateSession(stepped.sessionToken);
  assert.equal(finalAuth.session.AuthLevel, 'MFA');
  assert.equal(fx.context.AuthService.assertStepUp(finalAuth, stepped.stepUpToken), true);
  assert.throws(() => fx.context.SessionService.validateSession(enrolled.sessionToken), error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.controls.locked, false);
  assert.ok(fx.audits.some(record => record.Action === 'MFA_ENROLLED'));
  assert.ok(fx.audits.some(record => record.Action === 'STEP_UP_AUTHENTICATED'));
});

test('an enrollment session revoked after request authentication cannot install a pending key', () => {
  const fx = fixture();
  const auth = fx.validate();
  fx.session.Revoked = true;
  assert.throws(() => fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD'), error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.cred.PendingTotpSecret, '');
});

test('an enrollment session expiring while queued cannot install a pending key', () => {
  const fx = fixture();
  const auth = fx.validate();
  fx.controls.onLock = () => { fx.clock.now += 600000; };
  assert.throws(() => fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD'), error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.cred.PendingTotpSecret, '');
});

test('session creation cannot use a cached ACTIVE account after durable deactivation', () => {
  const fx = fixture();
  fx.validate();
  fx.account.Status = 'PASSIVE';
  assert.throws(() => fx.context.MasterRepository._withSessionMutationLock(() =>
    fx.context.SessionService.createSession(fx.account.UserID, 'WEB', fx.account.Email, 'MFA')),
  error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.tables.Sessions.size, 1);
});

test('session creation rechecks account state after acquiring its writer lock', () => {
  const fx = fixture();
  fx.controls.onLock = () => { fx.account.Status = 'PASSIVE'; };
  assert.throws(() => fx.context.SessionService.createSession(fx.account.UserID, 'WEB', fx.account.Email, 'MFA'),
    error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.tables.Sessions.size, 1);
  assert.equal(fx.controls.locked, false);
});

test('enrollment confirmation rejects malformed durable deadlines', () => {
  for (const expiresAtMs of ['invalid', 'Infinity', {}, false, 0]) {
    const fx = fixture();
    const auth = fx.validate();
    fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD');
    const pending = fx.context.AuthService._getMfaEnrollment(auth.userId);
    fx.context.AuthService._storeMfaEnrollment(auth.userId, { ...pending, expiresAtMs });
    assert.throws(() => fx.context.AuthService.confirmMfa(auth, '123456'), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.cred.MfaEnabled, false);
  }
});

test('enrollment rejects corrupted account generations instead of treating them as legacy epoch one', () => {
  for (const epoch of [0, false, -1, 1.5, 'garbage']) {
    const fx = fixture();
    const auth = fx.validate();
    fx.account.SessionEpoch = epoch;
    assert.throws(() => fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD'), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.cred.PendingTotpSecret, '');
  }
});

test('password rotation preserves assurance and uses the durable epoch after cache eviction fails', () => {
  for (const authLevel of ['MFA', 'MFA_ENROLLMENT']) {
    const fx = fixture();
    fx.session.AuthLevel = authLevel;
    fx.validate();
    fx.controls.failRemove = true;
    const rotated = fx.context.AuthService.changePassword('SYNTHETIC-TOKEN', 'SYNTHETIC-PASSWORD', 'SyntheticNewPassword1!');
    const auth = fx.context.SessionService.validateSession(rotated.sessionToken);
    assert.equal(auth.session.AuthLevel, authLevel);
    assert.equal(auth.session.AccountEpoch, fx.account.SessionEpoch);
    if (authLevel === 'MFA_ENROLLMENT') {
      const response = fx.context.executeApiRequest_('workspaces.list', { sessionToken: rotated.sessionToken });
      assert.equal(response.error.code, 'MFA_REQUIRED');
    }
  }
});

test('confirmation rechecks session revocation and expiry after acquiring the lock', () => {
  for (const mutate of [fx => { fx.session.Revoked = true; }, fx => { fx.clock.now += 600000; }]) {
    const fx = fixture();
    const auth = fx.validate();
    fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD');
    fx.controls.onLock = () => mutate(fx);
    assert.throws(() => fx.context.AuthService.confirmMfa(auth, '123456'), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.cred.MfaEnabled, false);
    assert.equal(fx.tables.Sessions.size, 1);
    assert.equal(fx.controls.locked, false);
  }
});

test('recovery composes with real durable lookups and cache-eviction failure', () => {
  const fx = fixture();
  const auth = fx.validate();
  fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD');
  const enrolled = fx.context.AuthService.confirmMfa(auth, '123456');
  fx.context.SessionService.validateSession(enrolled.sessionToken);
  fx.controls.failRemove = true;
  const recovered = fx.context.RecoveryService.recoverMfa('user', 'SYNTHETIC-PASSWORD', enrolled.recoveryCodes[0]);
  assert.equal(recovered.enrollmentRequired, true);
  const restricted = fx.context.SessionService.validateSession(recovered.sessionToken);
  assert.equal(restricted.session.AuthLevel, 'MFA_RECOVERY');
  assert.equal(restricted.session.AccountEpoch, fx.account.SessionEpoch);
  fx.clock.now += 60001; // existing bounded read-cache revocation window
  assert.throws(() => fx.context.SessionService.validateSession(enrolled.sessionToken));
  assert.throws(() => fx.context.RecoveryService.recoverMfa('user', 'SYNTHETIC-PASSWORD', enrolled.recoveryCodes[0]));
  fx.context.AuthService.enrollMfa(restricted, 'SYNTHETIC-PASSWORD');
  const replaced = fx.context.AuthService.confirmMfa(restricted, '123456');
  assert.equal(fx.context.SessionService.validateSession(replaced.sessionToken).session.AuthLevel, 'MFA');
});

test('recovery bypass of the old authenticator requires the same durable session assurance', () => {
  const fx = fixture();
  fx.session.AuthLevel = 'MFA';
  fx.cred.MfaEnabled = true;
  fx.cred.TotpSecret = 'kms$v1$SYNTHETIC';
  const auth = fx.validate();
  const claimed = { ...auth, session: { ...auth.session, AuthLevel: 'MFA_RECOVERY' } };
  assert.throws(() => fx.context.AuthService.enrollMfa(claimed, 'SYNTHETIC-PASSWORD'));
  assert.equal(fx.cred.PendingTotpSecret, '');
});

test('missing RecoveryJSON header fails before returning codes even when the unused cell is blank', () => {
  const fx = fixture();
  const auth = fx.validate();
  fx.context.AuthService.enrollMfa(auth, 'SYNTHETIC-PASSWORD');
  const getBook = fx.context.MasterRepository.getMasterSpreadsheet.bind(fx.context.MasterRepository);
  fx.context.MasterRepository.getMasterSpreadsheet = () => {
    const book = getBook();
    return { getSheetByName(name) {
      const sheet = book.getSheetByName(name);
      if (name !== 'Credentials') return sheet;
      return { ...sheet, getLastColumn: () => fx.context.MASTER_SCHEMA.Credentials.length - 1,
        getRange(row, ...args) {
          const range = sheet.getRange(row, ...args);
          if (row !== 1) return range;
          return { ...range, getValues: () => [Array.from(fx.context.MASTER_SCHEMA.Credentials).slice(0, -1)] };
        } };
    } };
  };
  assert.throws(() => fx.context.AuthService.confirmMfa(auth, '123456'), error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.cred.MfaEnabled, false);
  assert.equal(fx.tables.Sessions.size, 1);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mfaFixture } = require('./helpers/mfa-fixture');

test('password-only login issues only a short-lived enrollment session without login-success events', () => {
  const fx = mfaFixture();
  const result = fx.login();
  assert.equal(result.enrollmentRequired, true);
  assert.equal(fx.sessions[0].AuthLevel, 'MFA_ENROLLMENT');
  assert.ok(new Date(fx.sessions[0].AbsoluteExpiresAt).getTime() <= fx.clock.now + 600000);
  assert.equal(fx.events.some(event => event.EventType === 'LOGIN_SUCCESS'), false);
});

test('enrollment sessions cannot call any application action, even as Super Admin', () => {
  const fx = mfaFixture();
  fx.account.Role = 'SUPER_ADMIN';
  const result = fx.login();
  for (const action of ['workspaces.list', 'timer.start', 'settings.patch', 'setup.completeStep', 'auth.stepUp']) {
    const response = fx.context.executeApiRequest_(action, { sessionToken: result.sessionToken, payload: { step: 2 } });
    assert.equal(response.ok, false, action);
    assert.equal(response.error.code, 'MFA_REQUIRED', action);
  }
});

test('legacy sessions without MFA assurance must sign in again', () => {
  const fx = mfaFixture();
  const result = fx.login();
  delete fx.sessions[0].AuthLevel;
  fx.context.SessionService._sessionCacheMemory = {};
  assert.throws(() => fx.context.SessionService.validateSession(result.sessionToken), error => error.code === 'AUTH_REQUIRED');
});

test('mandatory MFA cannot be disabled by settings or the former disable endpoint', () => {
  const fx = mfaFixture();
  for (const value of [false, 'false', 0]) {
    assert.throws(() => fx.context.Validation.validateGlobalSettingsPatch({ MFA_REQUIRED: value }), error => error.code === 'VALIDATION_ERROR');
  }
  assert.throws(() => fx.context.AuthService.disableMfa({ userId: 'ROOT', role: 'SUPER_ADMIN' }, 'U1', 'SyntheticPassword1!'),
    error => error.code === 'PERMISSION_DENIED');
});

test('mandatory MFA stays enabled and read-only in the catalog despite legacy stored settings', () => {
  const fx = mfaFixture();
  fx.context.MasterRepository.getAllGlobalSettingsStrict = () => ({ MFA_REQUIRED: 'false' });
  fx.context.SheetRepository.getWorkspaceSettings = () => ({});
  assert.equal(fx.context.Flags.isOn('MFA_REQUIRED'), true);
  const result = fx.context.SettingsService.getCatalog({ userId: 'ROOT', role: 'SUPER_ADMIN' });
  const policy = result.catalog.find(entry => entry.key === 'MFA_REQUIRED');
  assert.equal(policy.value, true);
  assert.equal(policy.readOnly, true);
});

function enroll(fx) {
  const login = fx.login();
  const auth = fx.context.SessionService.validateSession(login.sessionToken);
  const result = fx.context.AuthService.enrollMfa(auth, 'SyntheticPassword1!');
  return { login, auth, result };
}

test('enrollment completion audits redacted before/after and rotates into an MFA-verified session', () => {
  const fx = mfaFixture();
  const { login, auth } = enroll(fx);
  const result = fx.context.AuthService.confirmMfa(auth, '123456');
  assert.ok(result.sessionToken);
  assert.notEqual(result.sessionToken, login.sessionToken);
  assert.equal(fx.sessions.at(-1).AuthLevel, 'MFA');
  assert.equal(fx.cred.MfaEnabled, true);
  assert.equal(fx.cred.PendingTotpSecret, '');
  assert.equal(fx.cred.LastSuccessfulTotpStep, Math.floor(fx.clock.now / 30000));
  assert.throws(() => fx.context.SessionService.validateSession(login.sessionToken), error => error.code === 'AUTH_REQUIRED');
  const audit = fx.audits.find(record => record.Action === 'MFA_ENROLLED');
  assert.equal(audit.BeforeJSON.mfaEnabled, false);
  assert.equal(audit.AfterJSON.mfaEnabled, true);
  assert.doesNotMatch(JSON.stringify(fx.audits), /kms\$|SYNTHETIC-SECRET|123456/);
});

test('failed enrollment audits prevent credential activation and full session creation', () => {
  const fx = mfaFixture();
  const { auth } = enroll(fx);
  fx.controls.auditOk = false;
  assert.throws(() => fx.context.AuthService.confirmMfa(auth, '123456'), error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.cred.MfaEnabled, false);
  assert.equal(fx.sessions.length, 1);
});

test('invalid enrollment attempts persist across password login and restart, then lock the account', () => {
  const fx = mfaFixture();
  fx.controls.validCode = false;
  for (let i = 1; i <= 5; i++) {
    if (i > 1) fx.clock.now += 31000;
    const { auth } = enroll(fx);
    assert.throws(() => fx.context.AuthService.confirmMfa(auth, '000000'));
    assert.equal(fx.cred.FailedLoginCount, i);
  }
  assert.equal(fx.account.Status, 'LOCKED');
  assert.equal(fx.sessions.some(row => row.AuthLevel === 'MFA'), false);
});

test('enrollment rechecks durable identity, account state and credential generation', () => {
  for (const mutate of [fx => { fx.account.Status = 'PASSIVE'; }, fx => { fx.cred.PasswordVersion++; },
    fx => { fx.account.SessionEpoch++; }, fx => { fx.controls.email = 'other@example.test'; }]) {
    const fx = mfaFixture();
    const { auth } = enroll(fx);
    mutate(fx);
    assert.throws(() => fx.context.AuthService.confirmMfa(auth, '123456'));
    assert.equal(fx.cred.MfaEnabled, false);
  }
});

test('MFA login challenge is invalidated by password reset and session revocation', () => {
  for (const mutate of [fx => { fx.cred.PasswordVersion++; }, fx => { fx.account.SessionEpoch++; }]) {
    const fx = mfaFixture();
    fx.cred.MfaEnabled = true;
    fx.cred.TotpSecret = 'kms$v1$SYNTHETIC';
    const login = fx.login();
    mutate(fx);
    assert.throws(() => fx.context.AuthService.verifyMfa(login.mfaChallengeToken, '123456'), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.sessions.length, 0);
  }
});

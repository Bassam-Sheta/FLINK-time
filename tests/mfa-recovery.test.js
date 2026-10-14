'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mfaFixture } = require('./helpers/mfa-fixture');

function fixture() {
  const fx = mfaFixture();
  const messages = [];
  fx.controls.emailRecovery = true;
  fx.controls.mailQuota = 10;
  fx.context.MasterRepository.getGlobalSettingFast = () => fx.controls.emailRecovery;
  fx.context.SecurityService.hashPassword = password => 'SYNTHETIC-HASH:' + password;
  fx.context.SecurityService.verifyPassword = (password, hash) => hash === 'synthetic-hash'
    ? password === 'SyntheticPassword1!' : hash === 'SYNTHETIC-HASH:' + password;
  fx.context.MailApp = {
    getRemainingDailyQuota: () => fx.controls.mailQuota,
    sendEmail(message) { messages.push(message); if (fx.controls.mailFail) throw new Error('Synthetic mail uncertainty'); }
  };
  const api = (action, payload = {}, token = '') => fx.context.executeApiRequest_(action, { payload, sessionToken: token });
  function enroll() {
    const login = fx.login();
    const auth = fx.context.SessionService.validateSession(login.sessionToken);
    fx.context.AuthService.enrollMfa(auth, 'SyntheticPassword1!');
    return fx.context.AuthService.confirmMfa(auth, '123456');
  }
  function emailCode() {
    const response = api('auth.requestPasswordRecovery', { username: 'worker' });
    assert.equal(response.ok, true);
    assert.equal(messages.length > 0, true);
    const code = messages.at(-1).body.match(/[A-F0-9]{4}(?:-[A-F0-9]{4}){7}/);
    assert.ok(code, 'mail contains one manually entered, high-entropy code');
    return code[0];
  }
  return { ...fx, messages, api, enroll, emailCode };
}

test('confirmed enrollment returns eight unique recovery codes once and stores only their hashes', () => {
  const fx = fixture();
  const result = fx.enroll();
  assert.equal(Array.isArray(result.recoveryCodes), true);
  assert.equal(result.recoveryCodes.length, 8);
  assert.equal(new Set(result.recoveryCodes).size, 8);
  for (const code of result.recoveryCodes) {
    assert.match(code, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/);
    assert.equal(fx.cred.RecoveryJSON.includes(code.replace(/-/g, '').toLowerCase()), false);
    assert.equal(JSON.stringify(fx.audits).includes(code), false);
  }
  const validate = fx.api('auth.validateSession', {}, result.sessionToken);
  assert.equal(validate.ok, true);
  assert.equal(validate.data.recoveryCodes, undefined);
});

test('Google identity, password and a single-use code permit only authenticator replacement', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  const code = enrolled.recoveryCodes?.[0] || '0000-0000-0000-0000-0000-0000-0000-0001';
  const payload = { username: 'worker', password: 'SyntheticPassword1!', code };
  const recovered = fx.api('auth.recoverMfa', payload);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.enrollmentRequired, true);
  const session = fx.sessions.at(-1);
  assert.equal(session.AuthLevel, 'MFA_RECOVERY');
  assert.ok(new Date(session.AbsoluteExpiresAt).getTime() <= fx.clock.now + 600000);
  assert.equal(fx.cred.MfaEnabled, true);
  for (const action of ['workspaces.list', 'timer.start', 'auth.stepUp', 'auth.regenerateRecoveryCodes', 'auth.changePassword']) {
    assert.equal(fx.api(action, {}, recovered.data.sessionToken).error.code, 'MFA_REQUIRED');
  }
  assert.equal(fx.api('auth.recoverMfa', payload).ok, false, 'used code cannot be replayed');
  assert.throws(() => fx.context.SessionService.validateSession(enrolled.sessionToken));
  const auth = fx.context.SessionService.validateSession(recovered.data.sessionToken);
  fx.context.AuthService.enrollMfa(auth, 'SyntheticPassword1!');
  fx.clock.now += 30000;
  const confirmed = fx.context.AuthService.confirmMfa(auth, '123456');
  assert.equal(fx.sessions.at(-1).AuthLevel, 'MFA');
  assert.equal(confirmed.recoveryCodes.length, 8);
  assert.equal(fx.api('auth.recoverMfa', { ...payload, code: enrolled.recoveryCodes[1] }).ok, false);
});

test('recovery code attempts are durable across password-login restarts and enforce timed lockout', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  for (let i = 0; i < 5; i++) {
    const response = fx.api('auth.recoverMfa', { username: 'worker', password: 'wrong', code: 'invalid' });
    assert.equal(response.ok, false);
    fx.clock.now += 31000;
    fx.login();
  }
  const payload = { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes?.[0] };
  assert.equal(fx.api('auth.recoverMfa', payload).ok, false);
  assert.equal(fx.cred.RecoveryJSON.length > 0, true);
  fx.clock.now += 15 * 60000;
  assert.equal(fx.api('auth.recoverMfa', payload).ok, true);
});

test('recovery code regeneration needs full MFA and fresh password/TOTP; old generation is invalid', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  fx.clock.now += 30000;
  const result = fx.api('auth.regenerateRecoveryCodes', { currentPassword: 'SyntheticPassword1!', totpCode: '123456' }, enrolled.sessionToken);
  assert.equal(result.ok, true);
  assert.equal(result.data.recoveryCodes.length, 8);
  assert.equal(fx.api('auth.regenerateRecoveryCodes', { currentPassword: 'SyntheticPassword1!', totpCode: '123456' }, enrolled.sessionToken).ok, false);
  assert.equal(fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] }).ok, false);
  assert.equal(fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: result.data.recoveryCodes[0] }).ok, true);
});

test('email password recovery is feature-guarded and never sends to another Google identity', () => {
  for (const mode of ['disabled', 'wrong-identity', 'inactive', 'quota']) {
    const fx = fixture();
    if (mode === 'disabled') fx.controls.emailRecovery = false;
    if (mode === 'wrong-identity') fx.controls.email = 'other@example.test';
    if (mode === 'inactive') fx.account.Status = 'PASSIVE';
    if (mode === 'quota') fx.controls.mailQuota = 0;
    const result = fx.api('auth.requestPasswordRecovery', { username: 'worker', email: 'attacker@example.test' });
    assert.equal(result.ok, true);
    assert.equal(result.data.message, 'If recovery is available for your Google account, a code will be emailed to you.');
    assert.equal(fx.messages.length, 0);
  }
});

test('email reset consumes a generation-bound code, revokes sessions and still requires MFA', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  const totp = fx.cred.TotpSecret;
  const code = fx.emailCode();
  assert.equal(fx.messages[0].to, fx.account.Email);
  assert.equal(fx.cred.RecoveryJSON.includes(code.replace(/-/g, '').toLowerCase()), false);
  const payload = { username: 'worker', code, newPassword: 'SyntheticNewPassword2!' };
  const result = fx.api('auth.completePasswordRecovery', payload);
  assert.equal(result.ok, true);
  assert.equal(result.data.sessionToken, undefined);
  assert.equal(result.data.signInRequired, true);
  assert.equal(fx.cred.TotpSecret, totp);
  assert.equal(fx.cred.MfaEnabled, true);
  assert.throws(() => fx.context.SessionService.validateSession(enrolled.sessionToken));
  const login = fx.context.AuthService.login('worker', payload.newPassword, 'WEB');
  assert.equal(login.mfaRequired, true);
  assert.equal(login.sessionToken, undefined);
  assert.equal(fx.api('auth.completePasswordRecovery', payload).ok, false);
});

test('email send limits survive repeated requests and failed mail delivery', () => {
  const fx = fixture();
  fx.controls.mailFail = true;
  for (let i = 0; i < 6; i++) {
    assert.equal(fx.api('auth.requestPasswordRecovery', { username: 'worker' }).ok, true);
    fx.clock.now += 61000;
  }
  assert.equal(fx.messages.length, 3);
  assert.equal(JSON.stringify(fx.audits).includes('Synthetic mail uncertainty'), false);
});

test('email reset rejects expiry, generation changes and disabling the feature before consumption', () => {
  for (const mutate of [fx => { fx.clock.now += 15 * 60000; }, fx => { fx.cred.PasswordVersion++; },
    fx => { fx.account.SessionEpoch++; }, fx => { fx.controls.emailRecovery = false; }]) {
    const fx = fixture();
    const code = fx.emailCode();
    mutate(fx);
    const result = fx.api('auth.completePasswordRecovery', { username: 'worker', code, newPassword: 'SyntheticNewPassword2!' });
    assert.equal(result.ok, false);
    assert.equal(fx.cred.PasswordHash, 'synthetic-hash');
  }
});

test('recovery rechecks identity, account and credential state after waiting for the writer lock', () => {
  for (const mutate of [fx => { fx.account.Status = 'PASSIVE'; }, fx => { fx.account.SessionEpoch++; },
    fx => { fx.cred.PasswordVersion++; }, fx => { fx.controls.email = 'other@example.test'; },
    fx => { fx.cred.TotpSecret = 'kms$v1$DIFFERENT'; }]) {
    const fx = fixture();
    const enrolled = fx.enroll();
    const before = fx.cred.RecoveryJSON;
    fx.controls.onLock = () => mutate(fx);
    const response = fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] });
    assert.equal(response.ok, false);
    assert.equal(fx.cred.RecoveryJSON, before);
    assert.equal(fx.sessions.length, 2, 'only initial enrollment and its verified replacement exist');
    assert.equal(fx.controls.locked, false);
  }
});

test('a competing recovery consumes a code once even when both requests verified the password', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  const payload = { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] };
  let competing;
  fx.controls.onLock = () => {
    fx.controls.onLock = null;
    competing = fx.api('auth.recoverMfa', payload);
  };
  const result = fx.api('auth.recoverMfa', payload);
  assert.equal(competing.ok, true);
  assert.equal(result.ok, false);
  assert.equal(fx.sessions.filter(session => session.AuthLevel === 'MFA_RECOVERY').length, 1);
});

test('failed recovery intent audits prevent code consumption and session creation', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  const before = fx.cred.RecoveryJSON;
  fx.controls.auditOk = false;
  const result = fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] });
  assert.equal(result.ok, false);
  assert.equal(fx.cred.RecoveryJSON, before);
  assert.equal(fx.sessions.filter(session => session.AuthLevel === 'MFA_RECOVERY').length, 0);
});

test('uncertain flushes never return a token or resurrect a consumed recovery code', () => {
  for (const failAt of [1, 2, 3]) {
    const fx = fixture();
    const enrolled = fx.enroll();
    let flushes = 0;
    fx.context.SpreadsheetApp.flush = () => { if (++flushes === failAt) throw new Error('Synthetic flush uncertainty'); };
    const payload = { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] };
    assert.equal(fx.api('auth.recoverMfa', payload).ok, false);
    assert.equal(fx.controls.locked, false);
    fx.context.SpreadsheetApp.flush = () => {};
    assert.equal(fx.api('auth.recoverMfa', payload).ok, failAt === 1);
  }
});

test('partial email reset revokes old sessions first and a new email code repairs the interrupted operation', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  fx.account.MustChangePassword = true;
  const code = fx.emailCode();
  const original = fx.context.MasterRepository.updateCredentials;
  fx.context.MasterRepository.updateCredentials = (id, updates) => {
    if (updates.PasswordHash) throw new Error('Synthetic credential write failure');
    return original(id, updates);
  };
  const payload = { username: 'worker', code, newPassword: 'SyntheticNewPassword2!' };
  assert.equal(fx.api('auth.completePasswordRecovery', payload).ok, false);
  assert.throws(() => fx.context.SessionService.validateSession(enrolled.sessionToken));
  assert.equal(fx.cred.PasswordHash, 'synthetic-hash');
  assert.equal(fx.account.MustChangePassword, true, 'a failed password write must not release a temporary password');
  fx.context.MasterRepository.updateCredentials = original;
  assert.equal(fx.api('auth.completePasswordRecovery', payload).ok, false, 'old epoch token stays invalid');
  fx.clock.now += 61000;
  const replacement = fx.emailCode();
  assert.equal(fx.api('auth.completePasswordRecovery', { ...payload, code: replacement }).ok, true);
  assert.equal(fx.account.MustChangePassword, false);
  assert.equal(fx.context.AuthService.login('worker', payload.newPassword).mfaRequired, true);
});

test('email reset feature and expiry are rechecked inside the mutation lock', () => {
  for (const mutate of [fx => { fx.controls.emailRecovery = false; }, fx => { fx.clock.now += 15 * 60000; }]) {
    const fx = fixture();
    const code = fx.emailCode();
    fx.controls.onLock = () => mutate(fx);
    assert.equal(fx.api('auth.completePasswordRecovery', { username: 'worker', code, newPassword: 'SyntheticNewPassword2!' }).ok, false);
    assert.equal(fx.cred.PasswordHash, 'synthetic-hash');
  }
});

test('malformed or missing recovery state fails closed without issuing credentials', () => {
  for (const value of [undefined, '{}', '{bad', JSON.stringify({ v: 1, codes: null, reset: null, failures: false, lockUntil: 0, mailAt: [] })]) {
    const fx = fixture();
    if (value === undefined) delete fx.cred.RecoveryJSON;
    else fx.cred.RecoveryJSON = value;
    const response = fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: 'invalid' });
    assert.equal(response.ok, false);
    assert.equal(fx.sessions.length, 0);
  }
});

test('durable recovery lockout rejects further requests before expensive password work', () => {
  const fx = fixture();
  fx.cred.RecoveryJSON = JSON.stringify({ v: 1, codes: null, reset: null, failures: 5, lockUntil: fx.clock.now + 60000, mailAt: [] });
  let expensiveCalls = 0;
  fx.context.SecurityService.verifyPassword = () => { expensiveCalls++; return false; };
  fx.context.SecurityService.hashPassword = () => { expensiveCalls++; return 'hash'; };
  fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: 'invalid' });
  fx.api('auth.completePasswordRecovery', { username: 'worker', code: 'invalid', newPassword: 'SyntheticNewPassword2!' });
  assert.equal(expensiveCalls, 0);
});

test('email reissuance preserves failures and shares the durable recovery lockout', () => {
  const fx = fixture();
  const payload = { username: 'worker', code: 'wrong', newPassword: 'SyntheticNewPassword2!' };
  fx.emailCode();
  for (let i = 0; i < 5; i++) {
    fx.api('auth.completePasswordRecovery', payload);
    fx.clock.now += 61000;
    fx.api('auth.requestPasswordRecovery', { username: 'worker' });
    assert.equal(JSON.parse(fx.cred.RecoveryJSON).failures, i + 1);
  }
  assert.equal(fx.messages.length, 3);
  assert.ok(JSON.parse(fx.cred.RecoveryJSON).lockUntil > fx.clock.now);
});

test('failed completion auditing never returns recovery codes or a session and keeps mutations consumed', () => {
  for (const action of ['RECOVERY_CODE_CONSUMED_COMPLETED', 'MFA_RECOVERY_SESSION_COMPLETED', 'RECOVERY_CODES_ROTATED_COMPLETED', 'PASSWORD_RECOVERY_RESET_COMPLETED']) {
    const fx = fixture();
    const enrolled = fx.enroll();
    const emailCode = fx.emailCode();
    const audit = fx.context.MasterRepository.logGlobalAudit;
    fx.context.MasterRepository.logGlobalAudit = record => record.Action === action ? false : audit(record);
    const original = fx.cred.RecoveryJSON;
    fx.clock.now += 30000;
    let response;
    if (action === 'RECOVERY_CODES_ROTATED_COMPLETED') {
      response = fx.api('auth.regenerateRecoveryCodes', { currentPassword: 'SyntheticPassword1!', totpCode: '123456' }, enrolled.sessionToken);
    } else if (action === 'PASSWORD_RECOVERY_RESET_COMPLETED') {
      response = fx.api('auth.completePasswordRecovery', { username: 'worker', code: emailCode, newPassword: 'SyntheticNewPassword2!' });
    } else {
      response = fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticPassword1!', code: enrolled.recoveryCodes[0] });
    }
    assert.equal(response.ok, false);
    assert.equal(response.data, undefined);
    assert.notEqual(fx.cred.RecoveryJSON, original);
    assert.equal(fx.controls.locked, false);
  }
});

test('password reset preserves saved backup codes for an account that lost both factors', () => {
  const fx = fixture();
  const enrolled = fx.enroll();
  const code = fx.emailCode();
  assert.equal(fx.api('auth.completePasswordRecovery', { username: 'worker', code, newPassword: 'SyntheticNewPassword2!' }).ok, true);
  const recovered = fx.api('auth.recoverMfa', { username: 'worker', password: 'SyntheticNewPassword2!', code: enrolled.recoveryCodes[0] });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.enrollmentRequired, true);
});

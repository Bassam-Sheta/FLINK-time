'use strict';

/**
 * Sign-in authenticator exemptions (`users.setMfaExempt`).
 *
 * Mandatory MFA is the default and stays that way: nothing here can switch
 * authenticator verification off for the fleet, and the global `MFA_REQUIRED`
 * setting remains read-only. What a Super Admin gains is one narrow, explicit
 * escape hatch — "do not force MFA for this sign-in" — for an account that
 * cannot complete enrolment.
 *
 * The boundaries under test:
 *   - the default does not change (password-only still means enrolment);
 *   - an exemption only helps an account with no enrolled authenticator;
 *   - an enrolled authenticator is never downgraded;
 *   - granting and revoking are Super-Admin-only, step-up protected, audited
 *     with before/after state, and fail closed;
 *   - the root Super Admin can never be exempted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { mfaFixture } = require('./helpers/mfa-fixture');

const SUPER_ADMIN = { userId: 'SA1', role: 'SUPER_ADMIN' };
const EXEMPT_KEY = 'FLINK_MFA_EXEMPT_USERS';

function exempt(fx, ids) {
  fx.properties.set(EXEMPT_KEY, JSON.stringify(ids));
}

function auditActions(fx) {
  return fx.audits.map(entry => entry.Action);
}

test('by default a password-only sign-in still has to enrol an authenticator', () => {
  const fx = mfaFixture();

  const result = fx.login();

  assert.equal(result.enrollmentRequired, true);
  assert.equal(fx.sessions[0].AuthLevel, 'MFA_ENROLLMENT');
});

test('an exempt account with no authenticator signs in with a full session', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);

  const result = fx.login();

  assert.ok(!result.enrollmentRequired, 'enrolment must no longer be forced');
  assert.ok(result.sessionToken, 'a usable session token must be returned');
  assert.equal(result.mfaExempt, true);
  assert.equal(
    fx.sessions[0].AuthLevel,
    'MFA',
    'the session must clear the app-request gate that blocks enrolment sessions'
  );
  assert.equal(
    fx.events.some(event => event.EventType === 'LOGIN_SUCCESS'),
    true,
    'an exempt sign-in is a real sign-in and must be recorded as one'
  );
});

test('an exempt account that already has an authenticator is still challenged', () => {
  const fx = mfaFixture();
  fx.cred.MfaEnabled = true;
  fx.cred.TotpSecret = 'SYNTHETIC-SECRET';
  exempt(fx, ['U1']);

  const result = fx.login();

  assert.equal(result.mfaRequired, true, 'an enrolled second factor is never downgraded');
  assert.equal(fx.sessions.length, 0, 'no session may be minted before the code is verified');
});

test('the exemption is read at sign-in and is not baked into an old session', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  assert.ok(!fx.login().enrollmentRequired);

  const fx2 = mfaFixture();
  exempt(fx2, []);
  assert.equal(fx2.login().enrollmentRequired, true, 'removing the exemption restores the requirement');
});

test('granting the exemption is audited with before/after state and no secrets', () => {
  const fx = mfaFixture();
  fx.cred.TotpSecret = 'SUPERSECRET-ABCDEF';

  const result = fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Lost phone');

  assert.equal(result.ok, true);
  assert.equal(result.mfaExempt, true);
  assert.deepEqual(JSON.parse(fx.properties.get(EXEMPT_KEY)), ['U1']);

  assert.deepEqual(auditActions(fx), [
    'MFA_EXEMPTION_GRANTED_INTENT',
    'MFA_EXEMPTION_GRANTED_COMPLETED'
  ]);
  assert.equal(fx.audits[0].ActorUserID, 'SA1');
  assert.equal(fx.audits[0].EntityID, 'U1');
  assert.equal(fx.audits[0].BeforeJSON.mfaExempt, false);
  assert.equal(fx.audits[0].AfterJSON.mfaExempt, true);
  assert.equal(fx.audits[0].AfterJSON.exemptCount, 1);
  assert.equal(fx.audits[0].AfterJSON.reason, 'Lost phone');

  assert.ok(
    !JSON.stringify(fx.audits).includes('SUPERSECRET-ABCDEF'),
    'the authenticator secret must never be audited'
  );
});

test('granting the exemption fails closed when the audit trail is unavailable', () => {
  const fx = mfaFixture();
  fx.controls.auditOk = false;

  assert.throws(
    () => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, ''),
    err => err.code === 'CRYPTO_FAILURE'
  );

  assert.equal(fx.properties.get(EXEMPT_KEY), undefined, 'no exemption may be stored without an audit record');
});

test('re-granting an existing exemption changes nothing and adds no audit noise', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);

  const result = fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, '');

  assert.equal(result.unchanged, true);
  assert.equal(result.mfaExempt, true);
  assert.equal(fx.audits.length, 0);
});

test('revoking the exemption restores the enrolment requirement and is audited', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);

  const result = fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', false, 'Device replaced');

  assert.equal(result.mfaExempt, false);
  assert.deepEqual(JSON.parse(fx.properties.get(EXEMPT_KEY)), []);
  assert.deepEqual(auditActions(fx), [
    'MFA_EXEMPTION_REVOKED_INTENT',
    'MFA_EXEMPTION_REVOKED_COMPLETED'
  ]);
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
});

test('only a Super Admin may change the exemption', () => {
  const fx = mfaFixture();

  for (const role of ['ADMIN', 'USER']) {
    assert.throws(
      () => fx.context.MfaPolicyService.setExempt({ userId: 'A1', role }, 'U1', true, ''),
      err => err.statusCode === 403,
      role
    );
  }

  assert.equal(fx.properties.get(EXEMPT_KEY), undefined);
});

test('the root Super Admin account can never be exempted', () => {
  const fx = mfaFixture();
  fx.context.MasterRepository.findAccountById = () => ({
    UserID: 'ROOT1', Username: 'root', Role: 'SUPER_ADMIN', Status: 'ACTIVE'
  });

  assert.throws(
    () => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'ROOT1', true, ''),
    err => err.statusCode === 403
  );

  assert.equal(fx.properties.get(EXEMPT_KEY), undefined);
});

test('archived and deleted accounts cannot be exempted', () => {
  for (const status of ['ARCHIVED', 'DELETED']) {
    const fx = mfaFixture();
    fx.context.MasterRepository.findAccountById = () => ({
      UserID: 'U1', Username: 'worker', Role: 'USER', Status: status
    });

    assert.throws(
      () => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, ''),
      err => err.code === 'CONFLICT',
      status
    );
    assert.equal(fx.properties.get(EXEMPT_KEY), undefined, status);
  }
});

test('an unknown target is refused', () => {
  const fx = mfaFixture();
  fx.context.MasterRepository.findAccountById = () => null;

  assert.throws(
    () => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U404', true, ''),
    err => err.code === 'NOT_FOUND'
  );
});

test('the exemption list is capped so it cannot quietly become a fleet-wide switch', () => {
  const fx = mfaFixture();
  fx.context.MfaPolicyService.MAX_EXEMPT = 1;
  exempt(fx, ['U2']);

  assert.throws(
    () => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, ''),
    err => err.code === 'CONFLICT'
  );
  assert.deepEqual(JSON.parse(fx.properties.get(EXEMPT_KEY)), ['U2']);
});

test('the global MFA policy stays mandatory and read-only', () => {
  const fx = mfaFixture();
  const entry = fx.context.SETTINGS_CATALOG.find(item => item.key === 'MFA_REQUIRED');

  assert.equal(entry.readOnly, true);
  assert.equal(entry.default, true);
  assert.equal(fx.context.Flags.isOn('MFA_REQUIRED'), true);
  assert.throws(() => fx.context.Validation.validateGlobalSettingsPatch({ MFA_REQUIRED: false }));
});

test('a password reset queued behind login cannot produce a usable new-generation session from the old password', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  const lock = fx.context.LockService.getScriptLock();
  const release = lock.releaseLock;
  let reset = false;
  lock.releaseLock = () => {
    release();
    if (!reset) {
      reset = true;
      fx.cred.PasswordHash = 'SYNTHETIC-REPLACEMENT';
      fx.cred.PasswordVersion++;
      fx.account.SessionEpoch++;
    }
  };
  const result = fx.login();
  assert.equal(reset, true);
  fx.context.SessionService.beginRequest();
  assert.throws(() => fx.context.SessionService.validateSession(result.sessionToken), error => error.code === 'AUTH_REQUIRED');
});

test('login rejects changed credential generation or timed lockout at lock acquisition', () => {
  for (const change of [fx => { fx.cred.PasswordVersion++; }, fx => { fx.account.SessionEpoch++; },
    fx => { fx.cred.LockUntil = new Date(fx.clock.now + 60000).toISOString(); }]) {
    const fx = mfaFixture();
    exempt(fx, ['U1']);
    fx.controls.onLock = () => change(fx);
    assert.throws(() => fx.login(), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.sessions.length, 0);
  }
});

test('session creation and success-side writes remain inside the validated login lock', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  const create = fx.context.SessionService.createSession;
  fx.context.SessionService.createSession = function(...args) {
    assert.equal(fx.controls.locked, true);
    return create.apply(this, args);
  };
  fx.login();
  assert.equal(fx.controls.locked, false);
});

test('failed exemption completion stays fail-closed and retry preserves the original audit state', () => {
  const fx = mfaFixture();
  const audit = fx.context.MasterRepository.logGlobalAudit;
  fx.context.MasterRepository.logGlobalAudit = data => data.Action.endsWith('_COMPLETED') ? false : audit(data);
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Lost phone'), error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
  assert.deepEqual(Array.from(fx.context.MfaPolicyService.listExempt()), []);
  assert.equal(fx.login().enrollmentRequired, true);
  fx.context.MasterRepository.logGlobalAudit = audit;
  const result = fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Retry');
  assert.equal(result.mfaExempt, true);
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), true);
  assert.equal(fx.audits.filter(item => item.Action.endsWith('_INTENT')).length, 1);
  assert.equal(fx.audits.at(-1).BeforeJSON.mfaExempt, false);
  assert.equal(fx.audits.at(-1).AfterJSON.reason, 'Lost phone');
});

test('a failed exemption write is recoverable without claiming completion', () => {
  const fx = mfaFixture();
  const write = fx.context.MfaPolicyService._write;
  fx.context.MfaPolicyService._write = () => { throw new Error('Synthetic property interruption'); };
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Lost phone'), /Synthetic property interruption/);
  fx.context.MfaPolicyService._write = write;
  fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Retry');
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), true);
  assert.deepEqual(auditActions(fx), ['MFA_EXEMPTION_GRANTED_INTENT', 'MFA_EXEMPTION_GRANTED_COMPLETED']);
});

test('exemption intent must flush before policy changes', () => {
  const fx = mfaFixture();
  fx.context.SpreadsheetApp.flush = () => { throw new Error('Synthetic flush uncertainty'); };
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true), /Synthetic flush uncertainty/);
  assert.equal(fx.properties.get(EXEMPT_KEY), undefined);
});

test('exemption target is re-read after lock wait before granting', () => {
  const fx = mfaFixture();
  fx.controls.onLock = () => { fx.account.Status = 'DELETED'; };
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true), error => error.code === 'CONFLICT');
  assert.equal(fx.properties.get(EXEMPT_KEY), undefined);
});

test('login flushes session writes while locked and releases the lock on flush failure', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  let flushes = 0;
  fx.context.SpreadsheetApp.flush = () => {
    flushes++;
    assert.equal(fx.controls.locked, true);
    throw new Error('Synthetic session flush uncertainty');
  };
  assert.throws(() => fx.login(), /Synthetic session flush uncertainty/);
  assert.equal(flushes, 1);
  assert.equal(fx.controls.locked, false);
});

test('numeric enrolled-MFA state never becomes a password-only exemption', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  fx.cred.MfaEnabled = 1;
  fx.cred.TotpSecret = 'SYNTHETIC-SECRET';
  assert.equal(fx.login().mfaRequired, true);
  assert.equal(fx.sessions.length, 0);
});

test('failed completion flush keeps a grant blocked until durable recovery', () => {
  const fx = mfaFixture();
  let flushes = 0;
  fx.context.SpreadsheetApp.flush = () => {
    if (++flushes === 2) throw new Error('Synthetic completion flush uncertainty');
  };
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true, 'Original reason'), /Synthetic completion flush uncertainty/);
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
  fx.context.MfaPolicyService.setExempt({ userId: 'SA2', role: 'SUPER_ADMIN' }, 'U1', true, 'Retry');
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), true);
  assert.equal(fx.audits.at(-1).ActorUserID, 'SA1', 'recovery retains the initiating actor');
  assert.equal(fx.audits.at(-1).AfterJSON.reason, 'Original reason');
});

test('revocation recovery finishes the pending operation rather than returning unchanged', () => {
  const fx = mfaFixture();
  exempt(fx, ['U1']);
  const audit = fx.context.MasterRepository.logGlobalAudit;
  fx.context.MasterRepository.logGlobalAudit = data => data.Action.endsWith('_COMPLETED') ? false : audit(data);
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', false, 'Device replaced'));
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
  fx.context.MasterRepository.logGlobalAudit = audit;
  fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', false, 'Retry');
  assert.deepEqual(auditActions(fx), ['MFA_EXEMPTION_REVOKED_INTENT', 'MFA_EXEMPTION_REVOKED_COMPLETED']);
  assert.equal(fx.audits.at(-1).BeforeJSON.mfaExempt, true);
});

test('deletion cancels a pending exemption grant permanently', () => {
  const fx = mfaFixture();
  const audit = fx.context.MasterRepository.logGlobalAudit;
  fx.context.MasterRepository.logGlobalAudit = data => data.Action.endsWith('_COMPLETED') ? false : audit(data);
  assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true));
  fx.context.MasterRepository.logGlobalAudit = audit;
  fx.context.UserService.deleteUser(SUPER_ADMIN, 'U1');
  assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
  assert.deepEqual(JSON.parse(fx.properties.get(EXEMPT_KEY)), []);
  assert.equal(fx.properties.has('FLINK_MFA_EXEMPT_USERS_PENDING_U1'), false);
});

test('corrupt policy/checkpoint data fails closed without overwriting other exemptions', () => {
  for (const key of [EXEMPT_KEY, 'FLINK_MFA_EXEMPT_USERS_PENDING_U1']) {
    const fx = mfaFixture();
    exempt(fx, ['U1', 'U2']);
    fx.properties.set(key, '{corrupt');
    const original = fx.properties.get(EXEMPT_KEY);
    assert.equal(fx.context.MfaPolicyService.isExempt('U1'), false);
    assert.throws(() => fx.context.MfaPolicyService.setExempt(SUPER_ADMIN, 'U1', true), error => error.code === 'CRYPTO_FAILURE');
    assert.equal(fx.properties.get(EXEMPT_KEY), original);
  }
});

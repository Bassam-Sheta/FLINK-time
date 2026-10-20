'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mfaFixture } = require('./helpers/mfa-fixture');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const source = fs.readFileSync(codePath, 'utf8');
const mod = require(codePath);

test('KDF calibration is Super Admin only and does not mutate settings', () => {
  assert.deepEqual(
    mod.ACTION_PERMISSIONS['security.calibrateKdf'].roles,
    [mod.CONSTANTS.ROLES.SUPER_ADMIN]
  );
  assert.equal(mod.ACTION_PERMISSIONS['security.calibrateKdf'].isWrite, false);
  assert.match(source, /case 'security\.calibrateKdf'/);
  assert.match(source, /calibratePasswordKdf\(payload\.targetMs \|\| 700\)/);
});

test('configured password iterations use bounded fast setting lookup', () => {
  const original = mod.MasterRepository.getGlobalSettingFast;
  try {
    mod.MasterRepository.getGlobalSettingFast = () => '25000';
    assert.equal(mod.SecurityService.getConfiguredPasswordIterations(), 25000);

    mod.MasterRepository.getGlobalSettingFast = () => '1';
    assert.equal(mod.SecurityService.getConfiguredPasswordIterations(), 10000);

    mod.MasterRepository.getGlobalSettingFast = () => '9999999';
    assert.equal(mod.SecurityService.getConfiguredPasswordIterations(), 1000000);
  } finally {
    mod.MasterRepository.getGlobalSettingFast = original;
  }
});

test('stored PBKDF2 iteration count drives upgrade-on-login', () => {
  const original = mod.MasterRepository.getGlobalSettingFast;
  try {
    mod.MasterRepository.getGlobalSettingFast = () => '25000';
    const legacy = '$pbkdf2$v1$i=10000$001122$deadbeef';
    const current = '$pbkdf2$v2$i=25000$001122$deadbeef';
    const legacySameCost = '$pbkdf2$v1$i=25000$001122$deadbeef';
    assert.equal(mod.SecurityService.getStoredPasswordIterations(legacy), 10000);
    assert.equal(mod.SecurityService.needsPasswordHashUpgrade(legacy), true);
    assert.equal(mod.SecurityService.needsPasswordHashUpgrade(legacySameCost), true);
    assert.equal(mod.SecurityService.needsPasswordHashUpgrade(current), false);
  } finally {
    mod.MasterRepository.getGlobalSettingFast = original;
  }
});

test('login upgrades only after a valid password and atomic credential re-read', () => {
  for (const scenario of ['valid', 'invalid-password', 'credentials-changed']) {
    const fx = mfaFixture();
    let upgrades = 0;
    fx.context.SecurityService.verifyPassword = () => scenario !== 'invalid-password';
    fx.context.SecurityService.needsPasswordHashUpgrade = () => true;
    fx.context.SecurityService.getStoredPasswordIterations = () => 10000;
    fx.context.SecurityService.getConfiguredPasswordIterations = () => 25000;
    fx.context.SecurityService.hashPassword = (_password, iterations) => {
      assert.equal(fx.controls.locked, true, 'mutable credentials must have been re-read under lock');
      assert.equal(iterations, 25000);
      upgrades++;
      return 'SYNTHETIC-UPGRADED-HASH';
    };
    if (scenario === 'credentials-changed') fx.controls.onLock = () => { fx.cred.PasswordHash = 'SYNTHETIC-REPLACEMENT'; };
    if (scenario === 'valid') {
      assert.equal(fx.login().enrollmentRequired, true);
      assert.equal(upgrades, 1);
      assert.equal(fx.cred.PasswordHash, 'SYNTHETIC-UPGRADED-HASH');
      assert.equal(fx.events.some(event => event.EventType === 'PASSWORD_HASH_UPGRADED'), true);
    } else {
      assert.throws(() => fx.login(), error => error.code === 'AUTH_REQUIRED');
      assert.equal(upgrades, 0);
      assert.equal(fx.sessions.length, 0);
    }
  }
});

test('Super Admin health UI exposes the calibration action', () => {
  const html = require('./helpers/portal-fixture').view('superadmin');
  assert.match(html, /Calibrate Password Hashing/);
  assert.match(html, /security\.calibrateKdf/);
  assert.match(html, /recommendedIterations/);
});


test('new password hashes use v2 framing and transparent rehash does not rotate PasswordVersion', () => {
  const originalPepper = mod.SecurityService.getPepper;
  const originalSetting = mod.MasterRepository.getGlobalSettingFast;
  try {
    mod.SecurityService.getPepper = () => 'test-pepper';
    mod.MasterRepository.getGlobalSettingFast = () => '10000';
    const hash = mod.SecurityService.hashPassword('A-valid-test-password-123!');
    assert.match(hash, /^\$pbkdf2\$v2\$i=10000\$[0-9a-f]+\$[0-9a-f]+$/);
    assert.equal(mod.SecurityService.verifyPassword('A-valid-test-password-123!', hash), true);
  } finally {
    mod.SecurityService.getPepper = originalPepper;
    mod.MasterRepository.getGlobalSettingFast = originalSetting;
  }

  const fx = mfaFixture();
  fx.cred.PasswordVersion = 4;
  fx.account.SessionEpoch = 3;
  fx.context.SecurityService.needsPasswordHashUpgrade = () => true;
  fx.context.SecurityService.getStoredPasswordIterations = () => 10000;
  fx.context.SecurityService.getConfiguredPasswordIterations = () => 25000;
  fx.context.SecurityService.hashPassword = () => 'SYNTHETIC-UPGRADED-HASH';
  fx.login();
  assert.equal(fx.cred.PasswordHash, 'SYNTHETIC-UPGRADED-HASH');
  assert.equal(fx.cred.PasswordVersion, 4, 'transparent rehash must not rotate the credential generation');
  assert.equal(fx.account.SessionEpoch, 3);
  assert.equal(fx.sessions[0].AccountEpoch, 3);
});

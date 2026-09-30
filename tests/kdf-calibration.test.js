'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    const current = '$pbkdf2$v1$i=25000$001122$deadbeef';
    assert.equal(mod.SecurityService.getStoredPasswordIterations(legacy), 10000);
    assert.equal(mod.SecurityService.needsPasswordHashUpgrade(legacy), true);
    assert.equal(mod.SecurityService.needsPasswordHashUpgrade(current), false);
  } finally {
    mod.MasterRepository.getGlobalSettingFast = original;
  }
});

test('login upgrades only after a valid password and atomic credential re-read', () => {
  const verifyIndex = source.indexOf('const isValid = SecurityService.verifyPassword');
  const rereadIndex = source.indexOf('const latestCred = MasterRepository.getCredentials(account.UserID)', verifyIndex);
  const upgradeIndex = source.indexOf('SecurityService.needsPasswordHashUpgrade(cred.PasswordHash)', rereadIndex);
  const mfaIndex = source.indexOf("if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE')", upgradeIndex);

  assert.ok(verifyIndex >= 0);
  assert.ok(rereadIndex > verifyIndex);
  assert.ok(upgradeIndex > rereadIndex);
  assert.ok(mfaIndex > upgradeIndex);
  assert.match(source.slice(upgradeIndex, mfaIndex), /PASSWORD_HASH_UPGRADED/);
});

test('Super Admin health UI exposes the calibration action', () => {
  const html = fs.readFileSync(
    path.resolve(__dirname, '../apps-script/SuperAdmin.html'),
    'utf8'
  );
  assert.match(html, /Calibrate Password Hashing/);
  assert.match(html, /security\.calibrateKdf/);
  assert.match(html, /recommendedIterations/);
});

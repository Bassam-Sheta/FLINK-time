'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function loadValidation() {
  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  delete global.Validation;
  delete global.CONSTANTS;
  delete require.cache[require.resolve(codePath)];
  return require(codePath).Validation;
}

test('global settings patch accepts only supported normalized settings', () => {
  const Validation = loadValidation();
  const result = Validation.validateGlobalSettingsPatch({
    COMPANY_NAME: '  FLINK Business Solutions  ',
    DEFAULT_TIMEZONE: 'Africa/Cairo',
    IDLE_TIMEOUT_HOURS: '8',
    AUTO_STOP_HOURS: '14'
  });

  assert.deepEqual(result, {
    COMPANY_NAME: 'FLINK Business Solutions',
    DEFAULT_TIMEZONE: 'Africa/Cairo',
    IDLE_TIMEOUT_HOURS: '8',
    AUTO_STOP_HOURS: '14'
  });
});

test('global settings patch rejects arbitrary keys', () => {
  const Validation = loadValidation();
  assert.throws(
    () => Validation.validateGlobalSettingsPatch({
      COMPANY_NAME: 'FLINK',
      FLINK_SECURITY_PEPPER: 'attacker-controlled'
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      /Unsupported global setting/.test(err.message)
  );
});

test('global settings patch enforces numeric limits and timezone syntax', () => {
  const Validation = loadValidation();

  assert.throws(
    () => Validation.validateGlobalSettingsPatch({ IDLE_TIMEOUT_HOURS: 25 }),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => Validation.validateGlobalSettingsPatch({ AUTO_STOP_HOURS: 0 }),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => Validation.validateGlobalSettingsPatch({ DEFAULT_TIMEZONE: '<script>' }),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
});

test('settings.save uses validated values and emits SETTINGS_CHANGED audit event', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  const start = source.indexOf("case 'settings.save':");
  const end = source.indexOf('/* ---------------- SECURITY & SESSIONS', start);
  const block = source.slice(start, end);

  assert.match(block, /Validation\.validateGlobalSettingsPatch/);
  assert.match(block, /CONSTANTS\.AUDIT_EVENTS\.SETTINGS_CHANGED/);
  assert.doesNotMatch(
    block,
    /for \(const \[k, v\] of Object\.entries\(payload\.settings/
  );
});

test('public setup status does not expose account, workspace, or company metadata while incomplete', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  const start = source.indexOf('getSetupStatus() {');
  const end = source.indexOf('processStep(stepNumber', start);
  const block = source.slice(start, end);

  assert.match(block, /setupRequired:\s*true/);
  const publicReturnStart = block.lastIndexOf('return {');
  const publicReturn = block.slice(publicReturnStart);
  assert.doesNotMatch(publicReturn, /companySettings|counts|superAdminExists|currentStep/);
});

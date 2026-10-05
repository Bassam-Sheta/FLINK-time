'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const superAdminPath = path.resolve(__dirname, '../apps-script/SuperAdmin.html');
const source = fs.readFileSync(codePath, 'utf8');
const mod = require(codePath);

const requiredKeys = [
  'FEATURE_TIMESHEET_APPROVAL',
  'FEATURE_TIME_OFF',
  'FEATURE_SCHEDULING',
  'FEATURE_EXPENSES',
  'FEATURE_INVOICING',
  'WEEK_STARTS',
  'FEATURE_WFH_TRACKING',
  'WFH_DAYS_PER_WEEK',
  'ALLOW_USER_PROJECT_SWITCH',
  'ENTRY_EDIT_WINDOW_DAYS',
  'ALLOW_MANUAL_ENTRIES',
  'ALLOW_USER_DELETE_ENTRY',
  'REQUIRE_DESCRIPTION',
  'FEATURE_TAGS',
  'FEATURE_TASKS',
  'FEATURE_LIVE_VIEW',
  'FEATURE_REPORT_EXPORT',
  'FEATURE_SAVED_DASHBOARDS',
  'PASSWORD_RECOVERY_EMAIL',
  'MFA_REQUIRED',
  'SESSION_IDLE_MINUTES',
  'SESSION_MAX_HOURS',
  'PBKDF2_ITERATIONS'
];

test('WP5 catalog contains every planned first setting with metadata', () => {
  const byKey = new Map(mod.SETTINGS_CATALOG.map(entry => [entry.key, entry]));
  for (const key of requiredKeys) {
    assert.ok(byKey.has(key), 'missing catalog key ' + key);
    const entry = byKey.get(key);
    for (const field of ['group','label','type','default','scope','stepUp','help']) {
      assert.ok(Object.prototype.hasOwnProperty.call(entry, field), key + ' missing ' + field);
    }
    assert.ok(['bool','number','select','text'].includes(entry.type));
    assert.ok(['GLOBAL','WORKSPACE'].includes(entry.scope));
  }
  // All 5 optional modules default to off (false)
  assert.equal(byKey.get('FEATURE_TIMESHEET_APPROVAL').default, false);
  assert.equal(byKey.get('FEATURE_TIME_OFF').default, false);
  assert.equal(byKey.get('FEATURE_SCHEDULING').default, false);
  assert.equal(byKey.get('FEATURE_EXPENSES').default, false);
  assert.equal(byKey.get('FEATURE_INVOICING').default, false);
});

test('catalog validation rejects unknown and out-of-range values', () => {
  assert.throws(
    () => mod.Validation.validateSettingsPatch({ ATTACKER_KEY: 'x' }, 'GLOBAL'),
    err => err.code === mod.ERROR_CODES.VALIDATION_ERROR
  );
  assert.throws(
    () => mod.Validation.validateSettingsPatch({ ENTRY_EDIT_WINDOW_DAYS: -1 }, 'WORKSPACE'),
    err => err.code === mod.ERROR_CODES.VALIDATION_ERROR
  );
  assert.throws(
    () => mod.Validation.validateSettingsPatch({ PBKDF2_ITERATIONS: 9999 }, 'GLOBAL'),
    err => err.code === mod.ERROR_CODES.VALIDATION_ERROR
  );
});

test('Flags performs one global settings read per request and invalidates FLAGS cache', () => {
  const original = mod.MasterRepository.getAllGlobalSettingsStrict;
  let reads = 0;
  try {
    mod.MasterRepository.getAllGlobalSettingsStrict = () => {
      reads += 1;
      return {
        SESSION_IDLE_MINUTES: '300',
        FEATURE_REPORT_EXPORT: 'false'
      };
    };
    mod.Flags.beginRequest();
    assert.equal(mod.Flags.getNumber('SESSION_IDLE_MINUTES'), 300);
    assert.equal(mod.Flags.getValue('COMPANY_NAME'), 'FLINK Business Solutions');
    assert.equal(reads, 1);
  } finally {
    mod.MasterRepository.getAllGlobalSettingsStrict = original;
    mod.Flags.beginRequest();
  }

  assert.match(source, /getScriptCache\(\)\.get\('FLAGS'\)/);
  assert.match(source, /getScriptCache\(\)\.remove\('FLAGS'\)/);
});

test('disabled server flag throws FEATURE_DISABLED and export path is guarded', () => {
  const originalGetValue = mod.Flags.getValue;
  try {
    mod.Flags.getValue = () => false;
    assert.throws(
      () => mod.Flags.assertOn('FEATURE_REPORT_EXPORT', 'W1'),
      err => err.code === mod.ERROR_CODES.FEATURE_DISABLED
    );
  } finally {
    mod.Flags.getValue = originalGetValue;
  }

  const start = source.indexOf("case 'reports.exportCsv':");
  const end = source.indexOf("case 'dashboard.radar':", start);
  const block = source.slice(start, end);
  assert.match(block, /Flags\.assertOn\('FEATURE_REPORT_EXPORT'/);
  assert.ok(
    block.indexOf('Flags.assertOn') < block.indexOf('ExportService.exportDetailedCsv'),
    'server guard must execute before export'
  );
});

test('settings catalog API is Super Admin controlled and patch requires step-up', () => {
  assert.deepEqual(
    mod.ACTION_PERMISSIONS['settings.getCatalog'].roles,
    [mod.CONSTANTS.ROLES.SUPER_ADMIN]
  );
  assert.equal(mod.ACTION_PERMISSIONS['settings.patch'].isWrite, true);
  const stepStart = source.indexOf('const PRIVILEGED_STEP_UP_ACTIONS = new Set([');
  const stepEnd = source.indexOf(']);', stepStart);
  assert.match(source.slice(stepStart, stepEnd), /'settings\.patch'/);
});

test('Super Admin settings UI is generated from the catalog', () => {
  const html = fs.readFileSync(superAdminPath, 'utf8');
  assert.match(html, /settings\.getCatalog/);
  assert.match(html, /settings\.patch/);
  assert.match(html, /dataset\.settingKey/);
  assert.match(html, /catalog-setting-input/);
  assert.doesNotMatch(html, /id="stCompanyName"/);
});

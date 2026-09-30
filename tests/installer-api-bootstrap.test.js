'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/Code.gs'),
  'utf8'
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../apps-script/appsscript.json'),
    'utf8'
  )
);

test('API installer bootstrap uses inert source sentinels by default', () => {
  assert.match(
    code,
    /masterSpreadsheetId:\s*'__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__'/
  );
  assert.match(
    code,
    /ownerEmail:\s*'__FLINK_INSTALLER_OWNER_EMAIL__'/
  );
  assert.match(
    code,
    /function installerBootstrapValue_\(value\)[\s\S]*__FLINK_INSTALLER_/
  );
  assert.match(
    code,
    /if \(!raw \|\| \/\^__FLINK_INSTALLER_/
  );
});

test('master repository prefers durable property then installer bootstrap then bound-sheet context', () => {
  const start = code.indexOf('  getMasterSpreadsheet() {');
  const end = code.indexOf('\n  /**\n   * Helper to retrieve a tab', start);
  const block = code.slice(start, end);

  const durable = block.indexOf("getProperty('MASTER_SPREADSHEET_ID')");
  const injected = block.indexOf('INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.masterSpreadsheetId');
  const active = block.indexOf('SpreadsheetApp.getActiveSpreadsheet');

  assert.ok(durable >= 0);
  assert.ok(injected > durable);
  assert.ok(active > injected);
});

test('installer owner is verified against both active and effective Google identity before persistence', () => {
  const start = code.indexOf('  assertInstallationOwner() {');
  const end = code.indexOf('\n  assertAccountIdentity(', start);
  const block = code.slice(start, end);

  assert.match(
    block,
    /INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.ownerEmail/
  );
  assert.match(
    block,
    /if \(!preparedOwner && installerOwner\) preparedOwner = installerOwner/
  );

  const active = block.indexOf('const activeEmail = this.getCurrentGoogleEmail(true)');
  const effective = block.indexOf('const effectiveEmail = this.getEffectiveGoogleEmail(true)');
  const compare = block.indexOf('activeEmail !== preparedOwner || effectiveEmail !== preparedOwner');
  const persistOwner = block.indexOf("props.setProperty('FLINK_INSTALL_OWNER_EMAIL', preparedOwner)");
  const persistSheet = block.indexOf("props.setProperty('MASTER_SPREADSHEET_ID', installerSpreadsheetId)");

  assert.ok(active >= 0 && effective > active);
  assert.ok(compare > effective);
  assert.ok(persistOwner > compare);
  assert.ok(persistSheet > compare);
});

test('setup step 1 still verifies installation owner before schema mutation', () => {
  const start = code.indexOf('_step1_SystemOwnerLocked(payload)');
  const end = code.indexOf('_step2_CompanySettings', start);
  const block = code.slice(start, end);

  const ownerCheck = block.indexOf('IdentityService.assertInstallationOwner()');
  const bootstrap = block.indexOf('MigrationService.bootstrapMasterSheet()');
  const createAccount = block.indexOf('MasterRepository.createAccount(accountRecord');

  assert.ok(ownerCheck >= 0);
  assert.ok(bootstrap > ownerCheck);
  assert.ok(createAccount > bootstrap);
});

test('bootstrap support does not broaden production OAuth scopes', () => {
  assert.deepEqual(
    (manifest.oauthScopes || []).slice().sort(),
    [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ].sort()
  );
});

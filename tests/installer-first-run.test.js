'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/Code.gs'),
  'utf8'
);
const superAdmin = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/SuperAdmin.html'),
  'utf8'
);
const readme = fs.readFileSync(
  path.resolve(__dirname, '../README.md'),
  'utf8'
);
const installGuide = fs.readFileSync(
  path.resolve(__dirname, '../docs/INSTALLATION.md'),
  'utf8'
);

test('bound Sheet exposes only a harmless public installer trigger', () => {
  const onOpenStart = code.indexOf('function onOpen()');
  const onOpenEnd = code.indexOf('\nfunction getBoundMasterSheetOwnerEmail_', onOpenStart);
  const onOpenBlock = code.slice(onOpenStart, onOpenEnd);

  assert.ok(onOpenStart >= 0 && onOpenEnd > onOpenStart);
  assert.match(onOpenBlock, /createMenu\('FLINK Time'\)/);
  assert.match(onOpenBlock, /'prepareInstallation_'/);
  assert.match(onOpenBlock, /'showDeploymentInstructions_'/);
  assert.match(onOpenBlock, /'showWebAppLink_'/);
  assert.doesNotMatch(onOpenBlock, /bootstrapMasterSheet|createAccount|setProperty/);

  assert.match(code, /function prepareInstallation_\(\)/);
  assert.match(code, /function showDeploymentInstructions_\(\)/);
  assert.match(code, /function showWebAppLink_\(\)/);
  assert.equal(code.includes('function prepareInstallation()'), false);
});

test('installation is bound to Sheet owner and Web App deployment owner', () => {
  assert.match(code, /getBoundMasterSheetOwnerEmail_\(spreadsheet\)/);
  assert.match(code, /FLINK_INSTALL_OWNER_EMAIL/);
  assert.match(code, /MASTER_SPREADSHEET_ID/);
  assert.match(code, /const activeEmail = this\.getCurrentGoogleEmail\(true\)/);
  assert.match(code, /const effectiveEmail = this\.getEffectiveGoogleEmail\(true\)/);
  assert.match(code, /activeEmail !== preparedOwner \|\| effectiveEmail !== preparedOwner/);

  const stepStart = code.indexOf('_step1_SystemOwnerLocked(payload)');
  const stepEnd = code.indexOf('_step2_CompanySettings', stepStart);
  const step = code.slice(stepStart, stepEnd);
  assert.ok(step.indexOf('IdentityService.assertInstallationOwner()') >= 0);
  assert.ok(
    step.indexOf('IdentityService.assertInstallationOwner()') <
      step.indexOf('MigrationService.bootstrapMasterSheet()')
  );
});

test('normal first-run flow no longer creates or asks for a setup key', () => {
  assert.doesNotMatch(code, /setProperty\('FLINK_SETUP_KEY_HASH'/);
  assert.doesNotMatch(code, /const setupKey = SecurityService\.generateRandomHex/);
  assert.doesNotMatch(superAdmin, /wzSetupKey|One-Time Installation Key|initializeInstallation_\(\)/);

  // Legacy properties are only removed if an older installation left them behind.
  assert.match(code, /deleteProperty\('FLINK_SETUP_KEY_HASH'\)/);
  assert.match(code, /deleteProperty\('FLINK_SETUP_KEY_CREATED_AT'\)/);
});

test('installer UI teaches direct privileged access and simple Sheet-menu setup', () => {
  assert.match(superAdmin, /FLINK Time → Prepare Installation/);
  assert.match(superAdmin, /No setup key is required/);
  assert.match(superAdmin, /Admin and Super Admin must be opened directly/);
  assert.doesNotMatch(superAdmin, /ALLOWALL Enabled/);
  assert.doesNotMatch(superAdmin, /Super Admin Google Sites page/);

  assert.match(readme, /Normal installers do \*\*not\*\* need GitHub, npm, Node\.js, Git, PowerShell, source-file copying, a setup key, or the Apps Script deployment screens/);
  assert.match(readme, /Recommended: Automated Installer/);
  assert.match(readme, /AUTHORIZE FLINK TIME/);
  assert.match(installGuide, /FLINK Time → 1\. Prepare Installation/);
  assert.match(installGuide, /\*\*Execute as: Me\*\*/);
});

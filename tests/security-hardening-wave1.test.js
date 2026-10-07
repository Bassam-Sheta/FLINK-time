'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const manifestPath = path.resolve(__dirname, '../apps-script/appsscript.json');

test('privileged portals are not configured with ALLOWALL framing', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  const doGetStart = source.indexOf('function doGet');
  const doPostStart = source.indexOf('function doPost', doGetStart);
  const doGetBlock = source.slice(doGetStart, doPostStart);

  assert.match(
    doGetBlock,
    /view === 'user'[\s\S]*XFrameOptionsMode\.ALLOWALL[\s\S]*XFrameOptionsMode\.DEFAULT/
  );
  assert.equal(
    /view === 'admin'[\s\S]*XFrameOptionsMode\.ALLOWALL/.test(doGetBlock),
    false
  );
  assert.equal(
    /view === 'superadmin'[\s\S]*XFrameOptionsMode\.ALLOWALL/.test(doGetBlock),
    false
  );
});

test('unexpected API errors are sanitized and correlated', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  assert.match(source, /unexpected API error/);
  assert.match(source, /An unexpected internal error occurred\. Reference:/);
  assert.doesNotMatch(
    source,
    /message:\s*err\s*&&\s*err\.message\s*\?\s*err\.message/
  );
});

test('first-run bootstrap is owner-bound before schema or account mutation', () => {
  const source = fs.readFileSync(codePath, 'utf8');

  assert.match(source, /function prepareInstallationCore_\(\)/);
  assert.match(source, /MASTER_SPREADSHEET_ID/);
  assert.match(source, /FLINK_INSTALL_OWNER_EMAIL/);
  assert.match(source, /getBoundMasterSheetOwnerEmail_\(spreadsheet\)/);
  assert.doesNotMatch(source, /const setupKey = SecurityService\.generateRandomHex\(24\)/);

  const stepStart = source.indexOf('_step1_SystemOwnerLocked(payload)');
  const nextStep = source.indexOf('_step2_CompanySettings', stepStart);
  const block = source.slice(stepStart, nextStep);
  const ownerCheck = block.indexOf('IdentityService.assertInstallationOwner()');
  const bootstrap = block.indexOf('MigrationService.bootstrapMasterSheet()');
  const createAccount = block.indexOf('MasterRepository.createAccount(accountRecord');

  assert.ok(ownerCheck >= 0, 'installation-owner verification must exist');
  assert.ok(bootstrap > ownerCheck, 'schema initialization must happen only after owner verification');
  assert.ok(createAccount > bootstrap, 'root account creation must happen after verified bootstrap');
  assert.doesNotMatch(block, /setupKey/);
});

test('temporary passwords use strong server generation and enforced expiry metadata', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  assert.match(source, /generateTemporaryPassword\(\)[\s\S]*generateRandomHex\(16\)/);
  assert.match(source, /RESET_PASSWORD_TTL_MINUTES:\s*60/);
  assert.match(source, /INITIAL_PASSWORD_TTL_HOURS:\s*24/);
  assert.match(source, /ResetIssuedAt:\s*resetIssuedAt\.toISOString\(\)/);
  assert.match(source, /ResetExpiresAt:\s*resetExpiresAt\.toISOString\(\)/);
  assert.match(source, /reason:\s*'Temporary password expired'/);
});

test('MFA changes require fresh credentials and pending enrollment is session-bound', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  assert.match(source, /enrollMfa\(authContext, currentPassword, currentMfaCode = ''\)/);
  assert.match(source, /verifyPassword\(currentPassword, initial\.cred\.PasswordHash\)/);
  assert.match(source, /if \(!passwordValid\) return this\._recordEnrollmentFailure/);
  assert.match(source, /sessionId:\s*authContext\.session\.SessionID/);
  assert.match(source, /MFA enrollment is invalid, expired, or belongs to another session/);
  assert.match(source, /disableMfa\(superAdminContext, targetUserId, adminPassword, adminTotpCode = ''\)/);
  assert.match(source, /MFA is mandatory and cannot be disabled/);
  assert.match(source, /SessionService\.revokeAllUserSessions\(authContext\.userId\)/);
});

test('Admin capacity metrics require explicit authorized workspace access', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  const start = source.indexOf("case 'jobs.capacity':");
  const end = source.indexOf('/* ---------------- INTEGRITY & AUDIT', start);
  const block = source.slice(start, end);
  assert.match(block, /authContext\.role === CONSTANTS\.ROLES\.ADMIN/);
  assert.match(block, /workspaceId is required for Admin capacity requests/);
  assert.match(block, /AuthorizationService\.assertWorkspaceAccess\(authContext, requestedCapacityWorkspace\)/);
  assert.match(block, /JobService\.getCapacityMetrics\(requestedCapacityWorkspace\)/);
});

test('Apps Script manifest keeps only runtime scopes required by storage, identity, and Cloud KMS', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(
    manifest.oauthScopes.slice().sort(),
    [
      'https://www.googleapis.com/auth/cloudkms',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ].sort()
  );
  assert.equal(
    manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'),
    true
  );
  assert.deepEqual(
    manifest.urlFetchWhitelist,
    ['https://cloudkms.googleapis.com/']
  );
  assert.equal(
    manifest.oauthScopes.includes('https://www.googleapis.com/auth/userinfo.profile'),
    false
  );
});

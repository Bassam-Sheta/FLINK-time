'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const manifestPath = path.resolve(__dirname, '../apps-script/appsscript.json');

test('privileged portals are not configured with ALLOWALL framing', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  assert.match(source, /view === 'user'[\s\S]*XFrameOptionsMode\.ALLOWALL[\s\S]*XFrameOptionsMode\.DEFAULT/);
  assert.equal(
    (source.match(/XFrameOptionsMode\.ALLOWALL/g) || []).length,
    1,
    'ALLOWALL must exist only in the employee-view conditional'
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

test('bootstrap key is not logged, expires, and is checked before schema mutation', () => {
  const source = fs.readFileSync(codePath, 'utf8');
  assert.equal(source.includes("console.log('FLINK one-time setup key:"), false);
  assert.match(source, /SETUP_KEY_TTL_MINUTES:\s*15/);
  const stepStart = source.indexOf('_step1_SystemOwnerLocked(payload)');
  const nextStep = source.indexOf('_step2_CompanySettings', stepStart);
  const block = source.slice(stepStart, nextStep);
  const keyCheck = block.indexOf('SecurityService.constantTimeEquals(suppliedSetupKeyHash, expectedSetupKeyHash)');
  const bootstrap = block.indexOf('MigrationService.bootstrapMasterSheet()');
  assert.ok(keyCheck >= 0, 'setup key validation must exist');
  assert.ok(bootstrap > keyCheck, 'schema initialization must happen only after setup key validation');
  assert.match(block, /Installation key expired/);
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
  assert.match(source, /Fresh password verification is required before changing MFA/);
  assert.match(source, /sessionId:\s*authContext\.session\.SessionID/);
  assert.match(source, /MFA enrollment is invalid, expired, or belongs to another session/);
  assert.match(source, /disableMfa\(superAdminContext, targetUserId, adminPassword, adminTotpCode = ''\)/);
  assert.match(source, /Fresh Super Admin password verification is required/);
  assert.match(source, /SessionService\.revokeAllUserSessions\(targetUserId\)/);
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

test('Apps Script manifest excludes unused advanced services and broad unused scopes', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(
    manifest.oauthScopes.slice().sort(),
    [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ].sort()
  );
  assert.equal(
    manifest.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'),
    false
  );
  assert.equal(
    manifest.oauthScopes.includes('https://www.googleapis.com/auth/userinfo.profile'),
    false
  );
});

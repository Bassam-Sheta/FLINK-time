'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(
  path.resolve(__dirname, '../installer/Code.gs'),
  'utf8'
);
const html = fs.readFileSync(
  path.resolve(__dirname, '../installer/Index.html'),
  'utf8'
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../installer/appsscript.json'),
    'utf8'
  )
);

test('automated installer is isolated from the five-file production app', () => {
  assert.equal(manifest.webapp.executeAs, 'USER_ACCESSING');
  assert.equal(manifest.webapp.access, 'DOMAIN');

  const scopes = new Set(manifest.oauthScopes || []);
  for (const scope of [
    'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments',
    'https://www.googleapis.com/auth/script.external_request'
  ]) {
    assert.equal(scopes.has(scope), true, scope);
  }

  const productionManifest = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../apps-script/appsscript.json'),
      'utf8'
    )
  );
  const productionScopes = new Set(productionManifest.oauthScopes || []);
  assert.equal(productionScopes.has('https://www.googleapis.com/auth/script.projects'), false);
  assert.equal(productionScopes.has('https://www.googleapis.com/auth/script.deployments'), false);
  assert.equal(productionScopes.has('https://www.googleapis.com/auth/script.external_request'), false);
});

test('installer release source is pinned to an immutable commit and five allowlisted files', () => {
  const commitMatch = code.match(/commit:\s*'([0-9a-f]{40})'/);
  assert.ok(commitMatch, 'installer must pin a full 40-character commit SHA');
  assert.doesNotMatch(code, /raw\.githubusercontent\.com\/[^'"]+\/main\//);

  for (const pathName of [
    'apps-script/Code.gs',
    'apps-script/User.html',
    'apps-script/Admin.html',
    'apps-script/SuperAdmin.html',
    'apps-script/appsscript.json'
  ]) {
    assert.equal(code.includes(pathName), true, pathName);
  }

  const fileEntries = [...code.matchAll(/\{ path: 'apps-script\//g)];
  assert.equal(fileEntries.length, 5);
});

test('installer performs official API lifecycle in safe order', () => {
  const start = code.indexOf('function installFlinkTime()');
  const end = code.indexOf('\nfunction getInstallerEmail_', start);
  const block = code.slice(start, end);

  const createSheet = block.indexOf("SpreadsheetApp.create('FLINK Time Master')");
  const createProject = block.indexOf("'/v1/projects'");
  const updateContent = block.indexOf("'/content'");
  const createVersion = block.indexOf("'/versions'");
  const createDeployment = block.indexOf("'/deployments'");
  const extractUrl = block.indexOf('extractWebAppUrl_(deployment)');

  assert.ok(createSheet >= 0);
  assert.ok(createProject > createSheet);
  assert.ok(updateContent > createProject);
  assert.ok(createVersion > updateContent);
  assert.ok(createDeployment > createVersion);
  assert.ok(extractUrl > createDeployment);
});

test('installer patches only the dedicated bootstrap sentinels', () => {
  assert.match(code, /__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__/);
  assert.match(code, /__FLINK_INSTALLER_OWNER_EMAIL__/);
  assert.match(code, /file\.name === 'Code'/);
  assert.match(code, /source\.split\(masterSentinel\)/);
  assert.match(code, /source\.split\(ownerSentinel\)/);
  assert.match(code, /escapeSingleQuotedJs_\(ownerEmail\)/);
});

test('installer rolls back the new Master Sheet when installation fails', () => {
  const start = code.indexOf('function installFlinkTime()');
  const end = code.indexOf('\nfunction getInstallerEmail_', start);
  const block = code.slice(start, end);

  assert.match(block, /if \(spreadsheetId && !installed\)/);
  assert.match(block, /cleanupFailedInstallation_\(spreadsheetId\)/);
  assert.match(code, /DriveApp\.getFileById\(spreadsheetId\)\.setTrashed\(true\)/);
});

test('Apps Script API access failure is handled without leaking OAuth tokens', () => {
  assert.match(code, /SCRIPT_API_ACCESS_REQUIRED/);
  assert.match(code, /https:\/\/script\.google\.com\/home\/usersettings/);
  assert.match(code, /Authorization:\s*'Bearer ' \+ ScriptApp\.getOAuthToken\(\)/);

  const returnStart = code.indexOf('return {\n      ok: true');
  const returnBlock = code.slice(returnStart, returnStart + 1400);
  assert.doesNotMatch(returnBlock, /oauth|token/i);
  assert.doesNotMatch(html, /getOAuthToken|Authorization:\s*Bearer/i);
});

test('browser installer uses one install action and opens final Super Admin result', () => {
  assert.match(html, /onclick="startInstall\(\)"/);
  assert.match(html, /\.installFlinkTime\(\)/);
  assert.match(html, /window\.open\('about:blank', 'flink_time_setup'\)/);
  assert.match(html, /pendingSetupWindow\.location\.replace\(result\.superAdminUrl\)/);
  assert.match(html, /Open Google API setting/);
  assert.match(html, /AUTHORIZE FLINK TIME/);
});

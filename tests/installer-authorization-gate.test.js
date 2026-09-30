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

test('authorization gate is limited to API-installed first-run portal requests', () => {
  const doGetStart = code.indexOf('function doGet(e)');
  const doGetEnd = code.indexOf('\nfunction maybeRenderInstallerAuthorizationGate_', doGetStart);
  const block = code.slice(doGetStart, doGetEnd);

  assert.match(block, /if \(!action\)/);
  assert.match(block, /maybeRenderInstallerAuthorizationGate_\(view\)/);

  const gateStart = code.indexOf('function maybeRenderInstallerAuthorizationGate_');
  const gateEnd = code.indexOf('\nfunction buildInstallerAuthorizationPage_', gateStart);
  const gate = code.slice(gateStart, gateEnd);

  assert.match(gate, /getProperty\('FLINK_INSTALL_OWNER_EMAIL'\)/);
  assert.match(gate, /if \(props\.getProperty\('FLINK_INSTALL_OWNER_EMAIL'\)\) return null/);
  assert.match(gate, /INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP\.ownerEmail/);
  assert.match(gate, /if \(!installerOwner\) return null/);
});

test('authorization gate checks the signed-in installation owner before showing Google authorization', () => {
  const start = code.indexOf('function maybeRenderInstallerAuthorizationGate_');
  const end = code.indexOf('\nfunction buildInstallerAuthorizationPage_', start);
  const block = code.slice(start, end);

  const active = block.indexOf('IdentityService.getCurrentGoogleEmail(false)');
  const ownerCompare = block.indexOf('activeEmail !== installerOwner');
  const authInfo = block.indexOf('ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL)');

  assert.ok(active >= 0);
  assert.ok(ownerCompare > active);
  assert.ok(authInfo > ownerCompare);
});

test('missing script scopes are handled with Google AuthorizationInfo rather than editor instructions', () => {
  assert.match(
    code,
    /ScriptApp\.getAuthorizationInfo\(ScriptApp\.AuthMode\.FULL\)/
  );
  assert.match(
    code,
    /ScriptApp\.AuthorizationStatus\.REQUIRED/
  );
  assert.match(code, /authInfo\.getAuthorizationUrl\(\)/);
  assert.match(code, /AUTHORIZE FLINK TIME/);
  assert.match(code, /I HAVE AUTHORIZED — CONTINUE/);
  assert.match(code, /FLINK Time never receives your Google password/);
});

test('authorization gate helpers remain private browser-inaccessible functions', () => {
  const topLevelFunctions = [
    ...code.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)
  ].map(match => match[1]);

  for (const name of [
    'maybeRenderInstallerAuthorizationGate_',
    'buildInstallerAuthorizationPage_'
  ]) {
    assert.equal(topLevelFunctions.includes(name), true);
    assert.equal(name.endsWith('_'), true);
  }
});

test('self-authorization gate does not broaden production OAuth scopes', () => {
  assert.deepEqual(
    (manifest.oauthScopes || []).slice().sort(),
    [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/userinfo.email'
    ].sort()
  );
});

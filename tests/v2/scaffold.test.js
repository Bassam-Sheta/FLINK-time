'use strict';

// T1.1 — repository layout, files.json, manifest template and the loaded module objects.
// The expected layout below is BUILD_SPEC section 2; a file added or renamed without updating
// the spec should fail here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, runInApp, APP_DIR, readFilesJson } = require('./helpers/load-app');

const EXPECTED_FILES = [
  'Config.gs',
  'Util.gs',
  'Db.gs',
  'Cache.gs',
  'Validate.gs',
  'Auth.gs',
  'Totp.gs',
  'Grants.gs',
  'Audit.gs',
  'ActWorkspaces.gs',
  'ActCatalog.gs',
  'ActTimer.gs',
  'ActEntries.gs',
  'ActReports.gs',
  'ActUsers.gs',
  'ActSystem.gs',
  'Jobs.gs',
  'Migrations.gs',
  'Setup.gs',
  'Main.gs',
  'Portal.html',
];

test('files.json lists exactly the layout of BUILD_SPEC section 2, in order', () => {
  assert.deepEqual(readFilesJson(APP_DIR), EXPECTED_FILES);
});

test('every file listed in files.json exists and is not empty', () => {
  for (const name of readFilesJson(APP_DIR)) {
    const full = path.join(APP_DIR, name);
    assert.ok(fs.existsSync(full), `${name} is listed in files.json but missing`);
    assert.ok(fs.statSync(full).size > 0, `${name} is empty`);
  }
});

test('no .gs or .html file in apps-script-v2 is missing from files.json', () => {
  const listed = new Set(readFilesJson(APP_DIR));
  const onDisk = fs.readdirSync(APP_DIR).filter(name => /\.(gs|html)$/.test(name));
  for (const name of onDisk) {
    assert.ok(listed.has(name), `${name} exists but is not in files.json`);
  }
});

test('every .gs module defines a global object named after its file', () => {
  const ctx = loadApp();
  for (const name of readFilesJson(APP_DIR).filter(n => n.endsWith('.gs'))) {
    const moduleName = name.replace(/\.gs$/, '');
    assert.equal(
      runInApp(ctx, `typeof ${moduleName}`),
      'object',
      `${name} should declare "var ${moduleName} = {...}"`
    );
  }
});

test('the app context has none of the Node-only globals Apps Script lacks', () => {
  const ctx = loadApp();
  for (const name of ['require', 'module', 'process', 'Buffer', 'setTimeout', 'setInterval',
    'TextEncoder', 'TextDecoder', 'URL', 'crypto', 'fetch', 'atob', 'btoa']) {
    assert.equal(runInApp(ctx, `typeof ${name}`), 'undefined', `${name} must not exist in the app context`);
  }
});

test('manifest template matches BUILD_SPEC section 8', () => {
  const raw = fs.readFileSync(path.join(APP_DIR, 'appsscript.template.json'), 'utf8');
  assert.equal(raw.split('{{TURSO_ORIGIN}}').length - 1, 1, 'placeholder must appear exactly once');

  const manifest = JSON.parse(raw.replace('{{TURSO_ORIGIN}}', 'https://example-db.turso.io'));
  assert.equal(manifest.timeZone, 'Africa/Cairo');
  assert.equal(manifest.runtimeVersion, 'V8');
  assert.equal(manifest.exceptionLogging, 'STACKDRIVER');
  assert.deepEqual(manifest.webapp, { access: 'DOMAIN', executeAs: 'USER_DEPLOYING' });
  assert.deepEqual(manifest.oauthScopes, [
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/script.external_request',
    'https://www.googleapis.com/auth/script.send_mail',
    'https://www.googleapis.com/auth/script.scriptapp',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
  ]);
  assert.deepEqual(manifest.urlFetchWhitelist, ['https://example-db.turso.io/']);
});

test('Portal.html placeholder is a complete document without dynamic HTML sinks', () => {
  const html = fs.readFileSync(path.join(APP_DIR, 'Portal.html'), 'utf8');
  assert.match(html, /<!DOCTYPE html>/i);
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write']) {
    assert.ok(!html.includes(sink), `Portal.html must not contain ${sink}`);
  }
});

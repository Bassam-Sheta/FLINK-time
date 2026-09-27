'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backendDir = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS'
);

test('every deployable Apps Script .gs file parses as JavaScript', () => {
  const files = fs.readdirSync(backendDir)
    .filter(name => name.endsWith('.gs'))
    .sort();

  assert.ok(files.length > 20, 'expected the modern backend service set');

  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(backendDir, file), 'utf8');
    try {
      new vm.Script(source, { filename: file });
    } catch (err) {
      failures.push(file + ': ' + err.message);
    }
  }

  assert.deepEqual(failures, []);
});

test('legacy backend/controller are not present in deployable Apps Script folder', () => {
  assert.equal(fs.existsSync(path.join(backendDir, 'Code.gs')), false);
  assert.equal(fs.existsSync(path.join(backendDir, 'admin_ui.html')), false);
});

test('modern API has no public system.bootstrap route', () => {
  const source = fs.readFileSync(path.join(backendDir, 'App.gs'), 'utf8');
  assert.equal(source.includes("'system.bootstrap'"), false);
  assert.equal(source.includes('handleDesktopAndControllerAction'), false);
});

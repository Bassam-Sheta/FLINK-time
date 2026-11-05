'use strict';

// T1.1 — "no top-level work" (BUILD_SPEC section 2.1). Apps Script runs every .gs file's top level on every
// cold start, so top-level code may only define things. We load all files with every Apps Script service
// replaced by something that throws when it is read; loading must not touch any of them.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, SERVICE_GLOBALS } = require('./helpers/load-app');

test('loading every .gs file touches no Apps Script service', () => {
  assert.doesNotThrow(() => loadApp({ throwOnServiceUse: true }));
});

test('control: a file that calls a service at top level is caught, and the message names file and service', () => {
  assert.throws(
    () => loadApp({
      throwOnServiceUse: true,
      sources: [{ name: 'Bad.gs', source: 'var Bad = {}; Session.getActiveUser().getEmail();' }],
    }),
    err => /Bad\.gs/.test(err.message) && /Session/.test(err.message)
  );
});

test('control: merely reading a service name at top level is also caught', () => {
  assert.throws(
    () => loadApp({
      throwOnServiceUse: true,
      sources: [{ name: 'Alias.gs', source: 'var cache = CacheService;' }],
    }),
    /Alias\.gs.*CacheService/s
  );
});

test('control: logging at top level is caught too', () => {
  assert.throws(
    () => loadApp({
      throwOnServiceUse: true,
      sources: [{ name: 'Noisy.gs', source: 'console.log("loaded");' }],
    }),
    /console/
  );
});

test('control: the same file loads fine when it only defines things', () => {
  const ctx = loadApp({
    throwOnServiceUse: true,
    sources: [{
      name: 'Good.gs',
      source: 'var Good = { run_: function () { return Session.getActiveUser().getEmail(); } };\nfunction helper_() { return CacheService; }',
    }],
  });
  assert.equal(typeof ctx.Good.run_, 'function');
  assert.equal(typeof ctx.helper_, 'function');
});

test('every service the app can use is covered by the throwing mode', () => {
  assert.deepEqual([...SERVICE_GLOBALS].sort(), [
    'CacheService', 'DriveApp', 'HtmlService', 'LockService', 'MailApp', 'PropertiesService',
    'ScriptApp', 'Session', 'SpreadsheetApp', 'UrlFetchApp', 'Utilities', 'console',
  ]);
});

'use strict';

// T1.1 — size budget (BUILD_SPEC section 2.1): all .gs files together under 300 KB, Portal.html under 150 KB.
// "KB" is read as 1,000 bytes here, which is the stricter of the two readings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { APP_DIR, readFilesJson } = require('./helpers/load-app');

const GS_BUDGET_BYTES = 300 * 1000;
const PORTAL_BUDGET_BYTES = 150 * 1000;

const bytesOf = name => fs.statSync(path.join(APP_DIR, name)).size;

test('all .gs files together stay under 300 KB', () => {
  const total = readFilesJson(APP_DIR)
    .filter(name => name.endsWith('.gs'))
    .reduce((sum, name) => sum + bytesOf(name), 0);
  assert.ok(total < GS_BUDGET_BYTES, `.gs total is ${total} bytes; budget is ${GS_BUDGET_BYTES}`);
});

test('Portal.html stays under 150 KB', () => {
  const size = bytesOf('Portal.html');
  assert.ok(size < PORTAL_BUDGET_BYTES, `Portal.html is ${size} bytes; budget is ${PORTAL_BUDGET_BYTES}`);
});

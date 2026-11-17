'use strict';

// AppError_ and the error code table (BUILD_SPEC sections 3 and 4.3). Db.gs throws these, so they arrive with T1.4;
// the settings catalog and the rest of Config.gs stay with T1.7.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createEnv } = require('./helpers/env');

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'docs', 'v2', 'BUILD_SPEC.md');

// Rows of the table in section 4.3: [code, retryable]. "yes, after 60 s" counts as retryable.
function specCodes() {
  const text = fs.readFileSync(SPEC_PATH, 'utf8').replace(/\r\n/g, '\n');
  const start = text.indexOf('### 4.3 Error codes');
  const end = text.indexOf('### 4.4', start);
  assert.ok(start >= 0 && end > start, 'section 4.3 not found');
  return [...text.slice(start, end).matchAll(/^\| `([A-Z_]+)` \| (yes[^|]*|no) \|/gm)]
    .map(match => [match[1], match[2].trim().startsWith('yes')]);
}

test('the error code table is exactly the one in BUILD_SPEC section 4.3', () => {
  const env = createEnv();
  const expected = specCodes();
  assert.equal(expected.length, 15, 'the spec lists 15 codes');
  const actual = env.ctx.__plain(env.ctx.ERROR_CODES_);
  assert.deepEqual(Object.keys(actual), expected.map(([code]) => code), 'same codes, same order');
  for (const [code, retryable] of expected) {
    assert.equal(actual[code].retryable, retryable, `${code} retryable`);
  }
  assert.equal(actual.RATE_LIMITED.retryAfterSeconds, 60, 'RATE_LIMITED is retryable "after 60 s"');
});

test('AppError_ carries code, message, details and the retryable flag', () => {
  const env = createEnv();
  const error = env.run("new AppError_('CONFLICT', 'A timer is already running', { field: 'timerId' })");
  assert.equal(error.name, 'AppError_');
  assert.equal(error.code, 'CONFLICT');
  assert.equal(error.message, 'A timer is already running');
  assert.deepEqual(env.ctx.__plain(error.details), { field: 'timerId' });
  assert.equal(error.retryable, false);
  assert.equal(env.run("new AppError_('BUSY', 'x').retryable"), true);
  assert.equal(env.run("new AppError_('RATE_LIMITED', 'x').retryable"), true);
});

test('AppError_ is a real Error with a stack, details default to {}, and instanceof works inside the app', () => {
  const env = createEnv();
  assert.equal(env.run("var e = new AppError_('NOT_FOUND', 'gone'); e instanceof Error && e instanceof AppError_"), true);
  assert.equal(env.run('typeof e.stack'), 'string');
  assert.deepEqual(env.ctx.__plain(env.run('e.details')), {});
});

test('AppError_ refuses a code that is not in the table', () => {
  const env = createEnv();
  assert.throws(() => env.run("new AppError_('TEAPOT', 'no')"), /Unknown error code: TEAPOT/);
  assert.throws(() => env.run("new AppError_(undefined, 'no')"), /Unknown error code/);
});

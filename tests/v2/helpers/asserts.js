'use strict';

// Small assertion helpers shared by the v2 tests.

const assert = require('node:assert/strict');

// The error fn throws, or null. Errors made inside the app belong to the vm's realm, so tests read their fields
// (code, message, details) instead of using instanceof.
function thrown(fn) {
  try { fn(); } catch (err) { return err; }
  return null;
}

// Expects fn to throw an AppError_ with this code; returns the error for further checks.
function expectCode(fn, code) {
  const err = thrown(fn);
  assert.ok(err, `expected ${code} but nothing was thrown`);
  assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.message} ${JSON.stringify(err.details)}`);
  return err;
}

module.exports = { thrown, expectCode };

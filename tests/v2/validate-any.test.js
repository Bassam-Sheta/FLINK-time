'use strict';

// T1.9 — the `any` schema type, proposed in docs/v2/questions.md (T1.6) for the two fields of BUILD_SPEC 6.2 whose type
// depends on another field: settings.patch.value and entries.bulk.value. It accepts one JSON scalar or a list of at
// most 50 ids, and nothing nested; the handler then validates the value against the catalog entry or the operation.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');
const { expectCode } = require('./helpers/asserts');

const env = createEnv();
const V = env.ctx.Validate;
const plain = value => env.ctx.__plain(value);
const one = (type, value) => plain(V.payload_({ f: type }, { f: value })).f;
const bad = (type, value) => {
  const err = expectCode(() => V.payload_({ f: type }, { f: value }), 'VALIDATION');
  assert.equal(err.details.field, 'f');
  return err;
};
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('any takes text, trimmed, up to 500 characters, with the rules of a description', () => {
  assert.equal(one('any', '  hello  '), 'hello');
  assert.equal(one('any', ''), '');
  assert.equal(one('any', 'a'.repeat(500)), 'a'.repeat(500));
  assert.equal(one('any', 'line one\n\tline two'), 'line one\n\tline two', 'tab and newline are allowed, as in a description');
  bad('any', 'a'.repeat(501));
  bad('any', 'bell\u0007');
  bad('any', 'lone \ud800 surrogate');
});

test('any takes finite numbers and booleans, and turns -0 into 0', () => {
  for (const value of [0, 1, -5, 3.25, 1e9, Number.MAX_SAFE_INTEGER]) assert.equal(one('any', value), value);
  assert.equal(Object.is(one('any', -0), 0), true);
  assert.equal(one('any', true), true);
  assert.equal(one('any', false), false, 'false is a value, not "missing"');
  for (const value of [NaN, Infinity, -Infinity]) bad('any', value);
});

test('any takes a list of at most 50 different ids, empty included, and returns a copy', () => {
  assert.deepEqual(one('any', []), []);
  const ids = Array.from({ length: 50 }, (_, i) => uuid(i + 1));
  assert.deepEqual(one('any', ids), ids);
  const input = [uuid(1)];
  const output = V.payload_({ f: 'any' }, { f: input }).f;
  assert.notStrictEqual(output, input);
  bad('any', Array.from({ length: 51 }, (_, i) => uuid(i + 1)));
  bad('any', [uuid(1), uuid(1)]);
  bad('any', ['not an id']);
  bad('any', [uuid(1), 5]);
  bad('any', [[uuid(1)]]);
});

test('any refuses everything nested or unknown: objects, functions, symbols, bigints, dates', () => {
  for (const value of [{}, { a: 1 }, [{}], new Date(0), () => 1, Symbol('x'), 10n]) bad('any', value);
});

test('any follows the same optional rules as every type: "?" allows absent and null, no "?" allows neither', () => {
  assert.deepEqual(plain(V.payload_({ f: 'any?' }, {})), {});
  assert.deepEqual(plain(V.payload_({ f: 'any?' }, { f: null })), { f: null });
  assert.equal(one('any?', false), false);
  for (const payload of [{}, { f: null }, { f: undefined }]) {
    const err = expectCode(() => V.payload_({ f: 'any' }, payload), 'VALIDATION');
    assert.equal(err.details.field, 'f');
  }
});

test('any takes no arguments: any:5 is a bug in the schema, not in the payload', () => {
  expectCode(() => V.payload_({ f: 'any:5' }, { f: 1 }), 'INTERNAL');
  expectCode(() => V.checkSchema_({ f: 'any:5' }), 'INTERNAL');
  V.checkSchema_({ f: 'any' });
  V.checkSchema_({ f: 'any?' });
});

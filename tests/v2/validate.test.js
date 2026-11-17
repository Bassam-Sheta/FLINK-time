'use strict';

// T1.6 — Validate.gs: the payload schema checker (BUILD_SPEC section 6.1) and the formula neutraliser (section 11).
//
// Choices the spec leaves open, each pinned by a test below and recorded in docs/v2/questions.md:
//   - an optional field (trailing "?") may be absent or null; null stays null in the result (it means "clear"),
//     absent is left out (it means "unchanged"); a required field may be neither
//   - tab and newline are allowed in text whose maximum is 500 or more (descriptions, notes), never in shorter text
//   - unknown fields are reported first, then the schema's fields in the order the schema declares them

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');
const { expectCode } = require('./helpers/asserts');

const env = createEnv();
const V = env.ctx.Validate;
const plain = value => env.ctx.__plain(value);

const run = (schema, payload) => plain(V.payload_(schema, payload));
const one = (type, value) => plain(V.payload_({ f: type }, { f: value })).f;
// The field named by the VALIDATION error a payload produces.
function rejected(schema, payload, field) {
  const err = expectCode(() => V.payload_(schema, payload), 'VALIDATION');
  assert.equal(err.details.field, field, `${JSON.stringify(payload)}: ${err.message}`);
  assert.equal(err.retryable, false);
  return err;
}
const bad = (type, value) => rejected({ f: type }, { f: value }, 'f');

// ---------------------------------------------------------------- the payload as a whole

test('an empty schema accepts a missing, null or empty payload and returns {}', () => {
  for (const payload of [undefined, null, {}]) assert.deepEqual(run({}, payload), {}, String(payload));
});

test('a payload that is not an object is refused, naming "payload"', () => {
  for (const payload of [[], [1], 'text', 5, true]) rejected({ a: 'int:0:5?' }, payload, 'payload');
});

test('unknown fields are refused, and reported before anything else', () => {
  rejected({ a: 'int:0:5?' }, { zzz: 1 }, 'zzz');
  rejected({ a: 'int:0:5' }, { a: 99, zzz: 1 }, 'zzz');
  rejected({ a: 'int:0:5' }, { zzz: 1 }, 'zzz');
});

test('keys that would pollute or shadow an object are unknown fields, even as own properties of parsed JSON', () => {
  rejected({ a: 'int:0:5?' }, JSON.parse('{"__proto__": {"admin": true}}'), '__proto__');
  rejected({ a: 'int:0:5?' }, { constructor: 1 }, 'constructor');
  rejected({ a: 'int:0:5?' }, { toString: 1 }, 'toString');
  rejected({ a: 'int:0:5?' }, { hasOwnProperty: 1 }, 'hasOwnProperty');
  // and a schema field that shares a name with an Object.prototype member is not satisfied by inheritance
  rejected({ toString: 'int:0:5' }, {}, 'toString');
  assert.deepEqual(run({ a: 'int:0:5?' }, Object.create({ a: 3 })), {}, 'inherited properties do not count');
});

test('required fields must be present and not null; optional ones may be absent or null', () => {
  rejected({ a: 'int:0:5' }, {}, 'a');
  rejected({ a: 'int:0:5' }, { a: null }, 'a');
  rejected({ a: 'int:0:5' }, { a: undefined }, 'a');
  assert.deepEqual(run({ a: 'int:0:5?' }, {}), {}, 'absent is left out: "unchanged"');
  assert.deepEqual(run({ a: 'int:0:5?' }, { a: undefined }), {});
  const cleared = run({ a: 'int:0:5?' }, { a: null });
  assert.deepEqual(cleared, { a: null });
  assert.equal(Object.prototype.hasOwnProperty.call(cleared, 'a'), true, 'null stays: "clear"');
});

test('the first bad field is the first in the schema, not in the payload', () => {
  const schema = { a: 'int:0:5', b: 'int:0:5', c: 'int:0:5' };
  rejected(schema, { c: 9, b: 9, a: 9 }, 'a');
  rejected(schema, { c: 9, b: 1, a: 1 }, 'c');
  rejected(schema, { a: 1, c: 1 }, 'b');
});

test('the result holds only schema fields, normalised, and the input is not changed', () => {
  const input = Object.freeze({ name: '  Ann  ', email: ' Ann@Flink.Test ', count: 3 });
  const result = run({ name: 'text:1:120', email: 'email', count: 'int:0:9', missing: 'bool?' }, input);
  assert.deepEqual(result, { name: 'Ann', email: 'ann@flink.test', count: 3 });
  assert.deepEqual({ ...input }, { name: '  Ann  ', email: ' Ann@Flink.Test ', count: 3 });
});

test('the schema of BUILD_SPEC 6.1 (timer.start) accepts a real payload and refuses a bad one', () => {
  const schema = { projectId: 'id?', taskId: 'id?', description: 'text:0:500?', billable: 'bool?', tagIds: 'ids:10?', clientAt: 'ms' };
  const now = env.fakes.clock.now();
  const good = { projectId: '123e4567-e89b-42d3-a456-426614174000', description: ' writing the spec\nsecond line ', billable: true, tagIds: [], clientAt: now - 1000 };
  assert.deepEqual(run(schema, good), { ...good, description: 'writing the spec\nsecond line' });
  assert.deepEqual(run(schema, { clientAt: now }), { clientAt: now });
  rejected(schema, { projectId: 'nope', clientAt: now }, 'projectId');
  rejected(schema, { description: 'x' }, 'clientAt');
  rejected(schema, { clientAt: now, extra: 1 }, 'extra');
});

// ---------------------------------------------------------------- id and ids

const UUID = '123e4567-e89b-42d3-a456-426614174000';

test('id: a lower-case UUID only', () => {
  assert.equal(one('id', UUID), UUID);
  for (const value of [UUID.toUpperCase(), UUID.replace(/-/g, ''), `{${UUID}}`, ` ${UUID}`, `${UUID} `, '', 'abc', 5, [UUID], { id: UUID }, true, UUID.slice(1)]) {
    bad('id', value);
  }
});

test('ids:N: up to N unique UUIDs, an empty list is fine, and a copy is returned', () => {
  const a = UUID;
  const b = '223e4567-e89b-42d3-a456-426614174001';
  assert.deepEqual(one('ids:3', []), []);
  assert.deepEqual(one('ids:3', [a, b]), [a, b]);
  assert.deepEqual(one('ids:2', [a, b]), [a, b]);
  bad('ids:2', [a, b, '323e4567-e89b-42d3-a456-426614174002']);
  bad('ids:3', [a, a]);
  bad('ids:3', [a, 'nope']);
  bad('ids:3', [a, a.toUpperCase()]);
  bad('ids:3', [a, null]);
  bad('ids:3', a);
  bad('ids:3', { 0: a, length: 1 });
  bad('ids:3', 'a,b');
});

// ---------------------------------------------------------------- text

test('text:MIN:MAX trims first, then checks the length', () => {
  assert.equal(one('text:1:120', '  Ann  '), 'Ann');
  assert.equal(one('text:0:500', ''), '');
  assert.equal(one('text:0:500', '   '), '');
  bad('text:1:120', '');
  bad('text:1:120', '   ');
  assert.equal(one('text:1:120', 'x'.repeat(120)), 'x'.repeat(120));
  bad('text:1:120', 'x'.repeat(121));
  assert.equal(one('text:1:120', ` ${'x'.repeat(120)} `), 'x'.repeat(120), 'the trim happens before the length check');
  assert.equal(one('text:2:2', 'ab'), 'ab');
  bad('text:2:2', 'a');
  bad('text:2:2', 'abc');
});

test('text length counts characters (code points) the way SQLite length() does, not UTF-16 units', () => {
  assert.equal(one('text:1:120', '😀'.repeat(120)), '😀'.repeat(120));
  bad('text:1:120', '😀'.repeat(121));
  assert.equal(one('text:1:3', '日本語'), '日本語');
  bad('text:1:3', 'éabc', 'a base letter and a combining accent are two characters, as in SQLite');
});

test('text must be a string: nothing is converted', () => {
  for (const value of [5, true, [], ['a'], { a: 1 }, 0]) bad('text:0:500', value);
});

test('text: single-line when the maximum is under 500 (names): tab, newline and every other control character refused', () => {
  for (const control of ['\t', '\n', '\r', '\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029']) {
    bad('text:1:120', `a${control}b`);
    bad('text:1:499', `a${control}b`);
  }
  assert.equal(one('text:1:120', 'a b'), 'a b');
  assert.equal(one('text:1:120', 'a b'), 'a b', 'a no-break space is not a control character');
});

test('text: multi-line when the maximum is 500 or more (descriptions, notes): only tab and newline allowed', () => {
  assert.equal(one('text:0:500', 'line one\n\tindented line two'), 'line one\n\tindented line two');
  assert.equal(one('text:0:2000', 'a\nb\n\nc'), 'a\nb\n\nc');
  assert.equal(one('text:0:500', '\n\n note \n\n'), 'note', 'leading and trailing newlines are trimmed');
  for (const control of ['\r', '\u0000', '\u0007', '\u001f', '\u007f', '\u0085', '\u009f', '\u2028', '\u2029']) {
    bad('text:0:500', `a${control}b`);
    bad('text:0:2000', `a${control}b`);
  }
});

test('text: lone surrogates are refused, valid pairs are fine', () => {
  for (const broken of ['a\ud800b', 'a\udc00b', 'a\ud83d', '\ude00a', 'a\ude00\ud83db']) {
    bad('text:1:120', broken);
    bad('text:0:500', broken);
  }
  assert.equal(one('text:1:120', 'ok 😀 ok'), 'ok 😀 ok');
});

// ---------------------------------------------------------------- code

test('code: 1 to 20 of A-Z 0-9 _ -, after trimming', () => {
  for (const good of ['W1', 'ACME-01', 'A_B', 'A', 'A'.repeat(20), '9', '-', '_']) assert.equal(one('code', good), good);
  assert.equal(one('code', ' ABC '), 'ABC');
  for (const value of ['abc', 'Abc', '', '  ', 'A'.repeat(21), 'A B', 'A.B', 'É', 'A\nB', 5, ['A']]) bad('code', value);
});

// ---------------------------------------------------------------- email

test('email: trimmed and lower-cased, ASCII, a real-looking address of 3 to 254 characters', () => {
  assert.equal(one('email', ' Ann.Smith@Flink.Test '), 'ann.smith@flink.test');
  for (const good of ["o'brien+tag@sub.flink.test", 'a@b.co', 'x_y-z@flink-business.com', 'a.b.c@d.e.fg']) assert.equal(one('email', good), good);
  const longLocal = 'a'.repeat(64);
  assert.equal(one('email', `${longLocal}@x.test`), `${longLocal}@x.test`);
  assert.equal(one('email', `a@${'b'.repeat(63)}.test`), `a@${'b'.repeat(63)}.test`);
});

test('email: refuses everything else', () => {
  const longDomain = `${'b'.repeat(63)}.`.repeat(4) + 'test';       // over 254 in total
  const refused = ['', 'plain', 'a@b', '@x.test', 'a@', 'a@@x.test', 'a@x@y.test', 'a@.test', 'a@x..test', 'a@x.test.', 'a b@x.test',
    '.a@x.test', 'a.@x.test', 'a..b@x.test', 'a@-x.test', 'a@x-.test', 'a@x.t', 'a@x.123', `${'a'.repeat(65)}@x.test`,
    `a@${'b'.repeat(64)}.test`, `a@${longDomain}`, 'é@x.test', 'a@é.test', 'a\u0000@x.test', 'a,b@x.test', 'a(b)@x.test',
    'a"b"@x.test', 'a@x_y.test', 5, {}, ['a@x.test']];
  for (const value of refused) bad('email', value);
  assert.ok(`a@${longDomain}`.length > 254);
});

// ---------------------------------------------------------------- bool, int

test('bool: true or false only', () => {
  assert.equal(one('bool', true), true);
  assert.equal(one('bool', false), false);
  for (const value of ['true', 'false', 1, 0, 'yes', [], {}, '']) bad('bool', value);
});

test('int:MIN:MAX: a safe integer inside the range, ends included', () => {
  assert.equal(one('int:0:50', 0), 0);
  assert.equal(one('int:0:50', 50), 50);
  assert.equal(one('int:0:50', 17), 17);
  bad('int:0:50', -1);
  bad('int:0:50', 51);
  assert.equal(one('int:-5:5', -5), -5);
  assert.equal(one('int:-5:-1', -3), -3);
  assert.equal(Object.is(V.payload_({ f: 'int:-5:5' }, { f: -0 }).f, 0), true, 'negative zero becomes 0');
  for (const value of [1.5, 0.1, '5', '', NaN, Infinity, -Infinity, 2 ** 53, [5], true]) bad('int:0:50', value);
  assert.equal(one('int:0:9007199254740991', 9007199254740991), 9007199254740991);
});

// ---------------------------------------------------------------- ms

test('ms: an integer within 10 years (of 365.25 days) of the server clock, ends included', () => {
  const now = env.fakes.clock.now();
  const tenYears = 10 * 365.25 * 86400000;
  assert.equal(one('ms', now), now);
  assert.equal(one('ms', now - 1000), now - 1000);
  assert.equal(one('ms', now + 1000), now + 1000);
  assert.equal(one('ms', now - tenYears), now - tenYears);
  assert.equal(one('ms', now + tenYears), now + tenYears);
  bad('ms', now - tenYears - 1);
  bad('ms', now + tenYears + 1);
  for (const value of [now + 0.5, String(now), NaN, Infinity, true, [now], 0, -1]) bad('ms', value);
});

test('ms follows the server clock, so moving the clock moves the window', () => {
  const own = createEnv();
  own.fakes.clock.set(Date.UTC(2030, 0, 1));
  const check = value => own.ctx.__plain(own.ctx.Validate.payload_({ f: 'ms' }, { f: value }));
  assert.equal(check(Date.UTC(2030, 0, 1)).f, Date.UTC(2030, 0, 1));
  expectCode(() => check(Date.UTC(2015, 0, 1)), 'VALIDATION');
});

// ---------------------------------------------------------------- date, enum, tz, cursor

test('date: a real YYYY-MM-DD date, untrimmed', () => {
  for (const good of ['2026-11-05', '2028-02-29', '0099-01-01']) assert.equal(one('date', good), good);
  for (const value of ['2026-02-29', '2026-13-01', '2026-00-10', '26-01-01', '2026-1-1', ' 2026-01-01', '2026-01-01 ', '2026-01-01T00:00:00Z',
    '', 20260101, [], 'today']) bad('date', value);
});

test('enum:A|B|C: exactly one of the listed strings, case-sensitive', () => {
  assert.equal(one('enum:SUN|MON|SAT', 'MON'), 'MON');
  assert.equal(one('enum:user|admin|superadmin', 'superadmin'), 'superadmin');
  for (const value of ['mon', 'MON ', ' MON', 'FRI', '', 'SUN|MON', 5, ['MON'], true]) bad('enum:SUN|MON|SAT', value);
  assert.equal(one('enum:A', 'A'), 'A');
  assert.equal(one('enum:summary|detailed', 'detailed'), 'detailed');
});

test('tz: a zone Utilities.formatDate accepts', () => {
  assert.equal(one('tz', 'Africa/Cairo'), 'Africa/Cairo');
  assert.equal(one('tz', 'UTC'), 'UTC');
  for (const value of ['Mars/Base', ' Africa/Cairo', 'Africa/Cairo ', '', 'Cairo', 5]) bad('tz', value);
});

test('cursor: an opaque string of 1 to 200 characters, passed through unchanged', () => {
  assert.equal(one('cursor', 'eyJzIjoxNzYyfQ=='), 'eyJzIjoxNzYyfQ==');
  assert.equal(one('cursor', 'c'.repeat(200)), 'c'.repeat(200));
  assert.equal(one('cursor', ' padded '), ' padded ', 'opaque: not trimmed');
  for (const value of ['', 'c'.repeat(201), 'a\nb', 'a\u0000b', 'a\u007fb', 5, []]) bad('cursor', value);
});

// ---------------------------------------------------------------- the optional marker on every type

test('every type accepts absent and null with "?", and refuses both without it', () => {
  const types = ['id', 'ids:3', 'text:0:500', 'code', 'email', 'bool', 'int:0:9', 'ms', 'date', 'enum:A|B', 'tz', 'cursor'];
  for (const type of types) {
    assert.deepEqual(run({ f: `${type}?` }, {}), {}, type);
    assert.deepEqual(run({ f: `${type}?` }, { f: null }), { f: null }, type);
    rejected({ f: type }, {}, 'f');
    rejected({ f: type }, { f: null }, 'f');
  }
});

test('an optional field that is present is still fully validated', () => {
  rejected({ f: 'int:0:9?' }, { f: 10 }, 'f');
  rejected({ f: 'text:0:5?' }, { f: 'too long' }, 'f');
  rejected({ f: 'id?' }, { f: 'nope' }, 'f');
});

// ---------------------------------------------------------------- a schema that is itself wrong is an internal error

test('a malformed schema is INTERNAL, not VALIDATION: it is a bug in the code, not in the payload', () => {
  const badTypes = ['', 'uuid', 'text', 'text:5', 'text:5:2', 'text:a:b', 'text:0:0', 'text:-1:5', 'text:1:2:3', 'int', 'int:1', 'int:5:1', 'int:x:y',
    'ids', 'ids:0', 'ids:x', 'ids:1001', 'ids:2:3', 'enum', 'enum:', 'enum:A||B', 'enum:A|A', 'enum:|A', 'id:5', 'bool:x', 'bool??', 'ms:1', '?', ':'];
  for (const type of badTypes) {
    expectCode(() => V.payload_({ f: type }, { f: 1 }), 'INTERNAL');
    expectCode(() => V.checkSchema_({ f: type }), 'INTERNAL');
  }
  for (const notAType of [5, null, undefined, {}, ['id']]) expectCode(() => V.payload_({ f: notAType }, { f: 1 }), 'INTERNAL');
  for (const notASchema of [null, undefined, 'id', ['id'], 5]) expectCode(() => V.payload_(notASchema, {}), 'INTERNAL');
});

test('checkSchema_ accepts every valid form and reports the field that is wrong', () => {
  assert.doesNotThrow(() => V.checkSchema_({
    a: 'id', b: 'id?', c: 'ids:10?', d: 'text:0:500?', e: 'code', f: 'email', g: 'bool', h: 'int:-5:50', i: 'ms', j: 'date', k: 'enum:A|B|C', l: 'tz?', m: 'cursor?',
  }));
  const err = expectCode(() => V.checkSchema_({ ok: 'id', broken: 'text:5' }), 'INTERNAL');
  assert.match(err.details.error, /broken/);
});

// ---------------------------------------------------------------- formula neutralising

test('neutralizeCell_ prefixes an apostrophe when a string starts with = + - @ tab CR or LF, even after spaces', () => {
  const cells = ['=1+1', '+1+1', '-1+1', '@SUM(A1:A9)', '\t=1', '\r=1', '\n=1', ' =1+1', '  \t=cmd', '=HYPERLINK("http://evil.test","x")',
    "=cmd|' /C calc'!A0", '-', '--', '-abc', '+', '=', '@', '\tplain', '\nplain', ' -x'];
  for (const cell of cells) assert.equal(V.neutralizeCell_(cell), "'" + cell, JSON.stringify(cell));
});

test('neutralizeCell_ leaves ordinary text, plain numbers (even negative) and already-escaped text alone', () => {
  for (const cell of ['hello', '', 'a=1', 'name@x.test', 'x-y', "'=already escaped", '5', '-5', '+5', '-5.5', ' 5 ', '12345.678', '0', '1e5', 'é=1', '1+1']) {
    assert.equal(V.neutralizeCell_(cell), cell, JSON.stringify(cell));
  }
});

test('neutralizeCell_ does not treat a number followed by a formula as a number', () => {
  for (const cell of ['-1+1', '+1=1', '-5\n=cmd', '-', '+-5', '--5', '-5e3']) assert.equal(V.neutralizeCell_(cell), "'" + cell, JSON.stringify(cell));
});

test('neutralizeCell_ passes numbers and booleans through, turns null and undefined into "", and refuses anything else', () => {
  assert.equal(V.neutralizeCell_(5), 5);
  assert.equal(V.neutralizeCell_(-5), -5);
  assert.equal(V.neutralizeCell_(1.5), 1.5);
  assert.equal(V.neutralizeCell_(0), 0);
  assert.equal(V.neutralizeCell_(true), true);
  assert.equal(V.neutralizeCell_(false), false);
  assert.equal(V.neutralizeCell_(null), '');
  assert.equal(V.neutralizeCell_(undefined), '');
  for (const value of [NaN, Infinity, {}, [], () => 1, new Date(0), Symbol('s'), 10n]) expectCode(() => V.neutralizeCell_(value), 'INTERNAL');
});

test('neutralizeCell_ keeps a cell within 50,000 characters, prefix included, and never cuts a surrogate pair in half', () => {
  assert.equal(V.neutralizeCell_('a'.repeat(50000)).length, 50000);
  assert.equal(V.neutralizeCell_('a'.repeat(60000)).length, 50000);
  const formula = V.neutralizeCell_('=' + 'a'.repeat(60000));
  assert.equal(formula.length, 50000);
  assert.ok(formula.startsWith("'=a"), 'still neutralised after the cut');
  const emoji = V.neutralizeCell_('a'.repeat(49999) + '😀😀');
  assert.equal(emoji.length, 49999, 'the half pair at the cut is dropped');
  assert.doesNotMatch(emoji, /[\ud800-\udbff]$/);
});

test('csvCell_ quotes every cell, doubles quotes, and neutralises formulas', () => {
  assert.equal(V.csvCell_('hello'), '"hello"');
  assert.equal(V.csvCell_(''), '""');
  assert.equal(V.csvCell_(null), '""');
  assert.equal(V.csvCell_(undefined), '""');
  assert.equal(V.csvCell_('say "hi", then\nleave'), '"say ""hi"", then\nleave"');
  assert.equal(V.csvCell_('=1+1'), '"\'=1+1"');
  assert.equal(V.csvCell_('@x'), '"\'@x"');
  assert.equal(V.csvCell_('-1+1'), '"\'-1+1"');
  assert.equal(V.csvCell_('\t=1'), '"\'\t=1"');
  assert.equal(V.csvCell_('-5'), '"-5"');
  assert.equal(V.csvCell_(-5), '"-5"');
  assert.equal(V.csvCell_(1.5), '"1.5"');
  assert.equal(V.csvCell_(true), '"true"');
  assert.equal(V.csvCell_('="quoted"'), '"\'=""quoted"""');
  for (const value of [NaN, Infinity, {}, [], () => 1, new Date(0)]) expectCode(() => V.csvCell_(value), 'INTERNAL');
});

test('csvCell_ does not truncate, and its output reads back as the original text in any CSV parser', () => {
  const long = 'x'.repeat(60000);
  assert.equal(V.csvCell_(long).length, 60002);
  const parse = cell => cell.slice(1, -1).replace(/""/g, '"');          // enough of a parser for one quoted cell
  for (const original of ['plain', 'a,b', 'q"uote', 'new\nline', 'tab\tinside', 'ünïcode 😀', '']) {
    assert.equal(parse(V.csvCell_(original)), original);
  }
  assert.equal(parse(V.csvCell_('=SUM(1)')), "'=SUM(1)");
});

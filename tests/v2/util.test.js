'use strict';

// T1.5 — Util.gs: ids, canonical JSON, hashing, local dates (Africa/Cairo across the 2026 DST changes), calendar-date
// arithmetic, durations and the client-time clamp (BUILD_SPEC sections 3, 6.2, 7.3 and 11).

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createEnv } = require('./helpers/env');
const { expectCode } = require('./helpers/asserts');

const env = createEnv();
const Util = env.ctx.Util;
const iso = text => Date.parse(text);

// ---------------------------------------------------------------- ids

test('id_ is a lowercase uuid, different every time', () => {
  const ids = Array.from({ length: 200 }, () => Util.id_());
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set(ids).size, 200);
});

test('id_ lowercases and strips braces whatever Utilities.getUuid returns', () => {
  const own = createEnv();
  own.run("Utilities.getUuid = function () { return '{ABCDEF12-0000-4000-8000-00000000000A}'; }");
  assert.equal(own.ctx.Util.id_(), 'abcdef12-0000-4000-8000-00000000000a');
});

// ---------------------------------------------------------------- canonical JSON

const canon = value => Util.canonicalJson_(value);

test('canonicalJson_ sorts keys at every depth, whatever order they were added in', () => {
  assert.equal(canon({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  assert.equal(canon({ z: 1, a: 2 }), canon({ a: 2, z: 1 }));
  const first = env.run('({ one: 1, two: { b: 2, a: 1 }, three: [{ y: 1, x: 2 }] })');
  const second = env.run('({ three: [{ x: 2, y: 1 }], two: { a: 1, b: 2 }, one: 1 })');
  assert.equal(canon(first), canon(second));
});

test('canonicalJson_ has no spaces, keeps array order, and handles empties', () => {
  assert.equal(canon([3, 1, 2]), '[3,1,2]');
  assert.equal(canon({}), '{}');
  assert.equal(canon([]), '[]');
  assert.equal(canon(null), 'null');
  assert.equal(canon({ a: [], b: {} }), '{"a":[],"b":{}}');
});

test('canonicalJson_ sorts keys by UTF-16 code unit, not by locale', () => {
  assert.equal(canon({ b: 1, B: 2, a: 3, 'é': 4, z: 5 }), '{"B":2,"a":3,"b":1,"z":5,"é":4}');
});

test('canonicalJson_ writes numbers as JSON does: integers plain, no trailing zeros, negative zero as 0', () => {
  assert.equal(canon([0, -0, 1, -1, 1.5, 123456789012345, 1762160000000, 0.1 + 0.2, 1e21]),
    '[0,0,1,-1,1.5,123456789012345,1762160000000,0.30000000000000004,1e+21]');
  assert.equal(canon({ n: 2.0 }), '{"n":2}');
});

test('canonicalJson_ escapes strings and keys exactly as JSON.stringify does', () => {
  const tricky = 'quote " back \\ newline \n tab \t nul \u0000 line-sep   é 😀';
  assert.equal(canon(tricky), JSON.stringify(tricky));
  assert.equal(canon({ [tricky]: 1 }), `{${JSON.stringify(tricky)}:1}`);
});

test('canonicalJson_ output parses back to the same data', () => {
  const data = { id: 'x', list: [1, 2.5, 'a', null, true, false, { k: 'v' }], nested: { a: { b: { c: [] } } }, empty: '' };
  assert.deepEqual(JSON.parse(canon(data)), data);
});

test('canonicalJson_ drops undefined object properties but refuses anything that is not JSON', () => {
  assert.equal(canon({ a: undefined, b: 1 }), '{"b":1}');
  const refused = [
    [undefined], NaN, Infinity, -Infinity, () => 1, Symbol('s'), 10n,
    new Date(0), env.run('new Date(0)'), { when: new Date(0) },
  ];
  for (const value of refused) expectCode(() => canon(value), 'INTERNAL');
  expectCode(() => canon(undefined), 'INTERNAL');
});

// ---------------------------------------------------------------- hashing

const hex = bytes => Util.hex_(bytes);

test('hex_ writes signed bytes as two lower-case hex digits each', () => {
  assert.equal(hex([-1, 0, 127, -128, 1, 16]), 'ff007f800110');
  assert.equal(hex([]), '');
});

test('sha256Hex_ matches the known vectors and Node for any UTF-8 text', () => {
  assert.equal(Util.sha256Hex_(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(Util.sha256Hex_('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const text of ['héllo wörld 😀', 'x'.repeat(10000), '{"a":1}\n;\n']) {
    assert.equal(Util.sha256Hex_(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  }
});

test('hmacSha256Hex_(key, message) matches RFC 4231 cases 1 and 2 and Node', () => {
  assert.equal(Util.hmacSha256Hex_('\x0b'.repeat(20), 'Hi There'),
    'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  assert.equal(Util.hmacSha256Hex_('Jefe', 'what do ya want for nothing?'),
    '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  // the order is (key, message), as written in the spec; swapping gives a different answer
  assert.notEqual(Util.hmacSha256Hex_('what do ya want for nothing?', 'Jefe'),
    Util.hmacSha256Hex_('Jefe', 'what do ya want for nothing?'));
  // a 64-hex-digit key (the AUDIT_HMAC_KEY form) is used as the text it is, not decoded
  const key = 'ab'.repeat(32);
  const message = '0000\n{"seq":"1"}';
  assert.equal(Util.hmacSha256Hex_(key, message), crypto.createHmac('sha256', key).update(message, 'utf8').digest('hex'));
  assert.equal(Util.hmacSha256Hex_('clé 🔑', 'héllo'), crypto.createHmac('sha256', 'clé 🔑').update('héllo', 'utf8').digest('hex'));
});

test('utf8Bytes_ and utf8Length_ agree with Node, including emoji and lone surrogates', () => {
  const samples = ['', 'abc', 'é', 'ñandú', '€', '日本語', '😀', 'a😀b', '\ud800', 'x\udc00y', '\ud83d', 'end\ud83d', '😀\ud83d', '\u0000\u007f\u0080߿ࠀ￿'];
  for (const text of samples) {
    const expected = [...Buffer.from(text, 'utf8')];
    const signed = Array.from(Util.utf8Bytes_(text));                 // into this realm, so deepEqual compares plainly
    assert.deepEqual(signed.map(b => b & 0xff), expected, JSON.stringify(text));
    assert.ok(signed.every(b => b >= -128 && b <= 127), 'bytes are signed like Apps Script\'s Byte[]');
    assert.equal(Util.utf8Length_(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));
  }
});

test('hashing text with a lone surrogate does not throw and matches Node (which writes U+FFFD)', () => {
  const text = 'bad \ud800 surrogate \udc00 pair';
  assert.equal(Util.sha256Hex_(text), crypto.createHash('sha256').update(text, 'utf8').digest('hex'));
  assert.equal(Util.hmacSha256Hex_('key', text), crypto.createHmac('sha256', 'key').update(text, 'utf8').digest('hex'));
});

test('hash helpers refuse anything that is not text', () => {
  for (const bad of [5, null, undefined, {}, ['a']]) {
    expectCode(() => Util.sha256Hex_(bad), 'INTERNAL');
    expectCode(() => Util.hmacSha256Hex_(bad, 'm'), 'INTERNAL');
    expectCode(() => Util.hmacSha256Hex_('k', bad), 'INTERNAL');
  }
  expectCode(() => Util.hex_('ff'), 'INTERNAL');
  expectCode(() => Util.hmacSha256Hex_('', 'message'), 'INTERNAL');
  expectCode(() => Util.utf8Bytes_(5), 'INTERNAL');
  expectCode(() => Util.utf8Length_(null), 'INTERNAL');
});

// ---------------------------------------------------------------- local dates

const CAIRO_2026 = [
  // [instant, local date, why]
  ['2026-04-23T21:59:59Z', '2026-04-23', '23:59:59 EET, the last second before DST starts'],
  ['2026-04-23T22:00:00Z', '2026-04-24', 'clocks jump from 00:00 to 01:00 EEST; the midnight hour never happens'],
  ['2026-04-24T20:59:59Z', '2026-04-24', '23:59:59 EEST'],
  ['2026-04-24T21:00:00Z', '2026-04-25', '00:00 EEST'],
  ['2026-10-29T20:59:59Z', '2026-10-29', '23:59:59 EEST, the last second before the clocks go back'],
  ['2026-10-29T21:00:00Z', '2026-10-29', '23:00 EET: the hour 23:00-23:59 happens twice, still the 29th'],
  ['2026-10-29T21:59:59Z', '2026-10-29', '23:59:59 EET, second time round'],
  ['2026-10-29T22:00:00Z', '2026-10-30', '00:00 EET'],
];

test('localDate_ follows Africa/Cairo across both 2026 DST changes (BUILD_SPEC D5: the start date counts)', () => {
  for (const [instant, expected, why] of CAIRO_2026) {
    assert.equal(Util.localDate_(iso(instant), 'Africa/Cairo'), expected, `${instant}: ${why}`);
  }
});

test('localDate_ over a whole year, hour by hour: every 2026 date appears once, in order, with no day lost or repeated', () => {
  const seen = [];
  for (let t = Date.UTC(2025, 11, 31, 0); t < Date.UTC(2027, 0, 1, 0); t += 3600 * 1000) {
    const date = Util.localDate_(t, 'Africa/Cairo');
    if (seen[seen.length - 1] !== date) seen.push(date);
  }
  const expected = [];
  for (let day = Date.UTC(2025, 11, 31); day <= Date.UTC(2027, 0, 1); day += 86400000) {
    expected.push(new Date(day).toISOString().slice(0, 10));
  }
  assert.deepEqual(seen, expected);
});

test('localDate_ in other zones, and today_ follows the clock', () => {
  assert.equal(Util.localDate_(iso('2026-11-05T03:00:00Z'), 'America/New_York'), '2026-11-04');
  assert.equal(Util.localDate_(iso('2026-11-05T03:00:00Z'), 'UTC'), '2026-11-05');
  assert.equal(Util.localDate_(iso('2026-11-05T03:00:00Z'), 'Pacific/Kiritimati'), '2026-11-05');
  assert.equal(Util.localDate_(0, 'UTC'), '1970-01-01');

  const own = createEnv();
  own.fakes.clock.set(iso('2026-11-05T22:30:00Z'));
  assert.equal(own.ctx.Util.today_('Africa/Cairo'), '2026-11-06');
  assert.equal(own.ctx.Util.today_('UTC'), '2026-11-05');
});

test('localDate_ refuses a time that is not an integer and a zone it cannot use', () => {
  for (const bad of [1.5, NaN, Infinity, '1762160000000', null, undefined]) {
    expectCode(() => Util.localDate_(bad, 'UTC'), 'INTERNAL');
  }
  expectCode(() => Util.localDate_(0, 'Mars/Base'), 'INTERNAL');
  expectCode(() => Util.localDate_(0, ''), 'INTERNAL');
  expectCode(() => Util.localDate_(0, undefined), 'INTERNAL');
});

// ---------------------------------------------------------------- time zone validation

test('isValidTimeZone_ accepts real IANA zones', () => {
  for (const tz of ['Africa/Cairo', 'UTC', 'America/New_York', 'America/Argentina/Buenos_Aires', 'Europe/London', 'Etc/GMT+3', 'Asia/Kolkata', 'Asia/Kathmandu']) {
    assert.equal(Util.isValidTimeZone_(tz), true, tz);
  }
});

test('isValidTimeZone_ refuses anything else', () => {
  const bad = ['', ' ', ' Africa/Cairo', 'Africa/Cairo ', 'Mars/Base', 'Cairo', 'Africa/', '/Africa/Cairo', '../etc/passwd',
    'Africa//Cairo', 'UTC+3', '+03:00', 'x'.repeat(80), null, undefined, 5, {}, ['UTC']];
  for (const tz of bad) assert.equal(Util.isValidTimeZone_(tz), false, JSON.stringify(tz));
});

test('isValidTimeZone_ cross-checks Utilities.formatDate against Intl, so a quiet fallback to GMT is caught', () => {
  // Java-style behaviour: a zone id the platform does not know formats as UTC instead of failing.
  const own = createEnv();
  own.run(`
    var realFormatDate = Utilities.formatDate;
    Utilities.formatDate = function (date, tz, pattern) {
      var known = tz === 'Africa/Cairo' || tz === 'UTC';
      return realFormatDate.call(Utilities, date, known ? tz : 'UTC', pattern);
    };`);
  assert.equal(own.ctx.Util.isValidTimeZone_('Africa/Cairo'), true);
  assert.equal(own.ctx.Util.isValidTimeZone_('africa/cairo'), false, 'Intl accepts the lower-case id; the platform would not');
  assert.equal(own.ctx.Util.isValidTimeZone_('Asia/Kolkata'), false, 'a zone the platform formats as UTC is not usable');
});

test('isValidTimeZone_ relies on formatDate alone where Intl is missing', () => {
  const own = createEnv();
  own.run('Intl = undefined');
  assert.equal(own.ctx.Util.isValidTimeZone_('Africa/Cairo'), true);
  assert.equal(own.ctx.Util.isValidTimeZone_('Mars/Base'), false);
});

// ---------------------------------------------------------------- calendar dates

test('isDate_ accepts real YYYY-MM-DD dates only', () => {
  for (const good of ['2026-11-05', '2028-02-29', '2026-12-31', '2026-01-01', '0001-01-01', '0099-06-30', '9999-12-31']) {
    assert.equal(Util.isDate_(good), true, good);
  }
  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-04-31', '26-01-01', '2026-1-1', '2026-01-01 ',
    ' 2026-01-01', '2026-01-01T00:00:00Z', '2026/01/01', '0000-01-01', '', null, undefined, 20260101, {}]) {
    assert.equal(Util.isDate_(bad), false, JSON.stringify(bad));
  }
});

test('addDays_ and diffDays_ are calendar arithmetic, unaffected by DST or two-digit years', () => {
  const add = (date, days) => Util.addDays_(date, days);
  assert.equal(add('2026-02-28', 1), '2026-03-01');
  assert.equal(add('2028-02-28', 1), '2028-02-29');
  assert.equal(add('2026-12-31', 1), '2027-01-01');
  assert.equal(add('2026-01-01', -1), '2025-12-31');
  assert.equal(add('2026-03-31', 0), '2026-03-31');
  assert.equal(add('2026-01-01', 365), '2027-01-01');
  assert.equal(add('2026-01-01', -365), '2025-01-01');
  assert.equal(add('2026-04-23', 1), '2026-04-24', 'the day DST starts');
  assert.equal(add('2026-10-29', 1), '2026-10-30', 'the day DST ends');
  assert.equal(add('0099-12-31', 1), '0100-01-01', 'years below 100 are not read as 19xx');

  const diff = (a, b) => Util.diffDays_(a, b);
  assert.equal(diff('2026-01-01', '2026-01-31'), 30);
  assert.equal(diff('2026-01-31', '2026-01-01'), -30);
  assert.equal(diff('2026-04-23', '2026-04-25'), 2);
  assert.equal(diff('2026-10-28', '2026-10-31'), 3);
  assert.equal(diff('2026-05-05', '2026-05-05'), 0);
  assert.equal(diff('2026-01-01', '2027-01-01'), 365);

  expectCode(() => add('2026-02-30', 1), 'INTERNAL');
  expectCode(() => add('2026-01-01', 1.5), 'INTERNAL');
  expectCode(() => add('2026-01-01', '1'), 'INTERNAL');
  expectCode(() => diff('nope', '2026-01-01'), 'INTERNAL');
});

// ---------------------------------------------------------------- durations

test('durationSeconds_ is floor((end - start) / 1000) and equals SQLite integer division', () => {
  const start = 1762160000000;
  const cases = [[0, 0], [0, 999], [0, 1000], [0, 1500], [1000, 2999], [start, start + 1234567], [start, start + 86400000], [start, start + 1]];
  for (const [from, to] of cases) {
    const seconds = Util.durationSeconds_(from, to);
    assert.equal(seconds, Math.floor((to - from) / 1000));
    const [{ response }] = env.turso.run([{
      type: 'execute',
      stmt: { sql: 'SELECT (? - ?) / 1000', args: [{ type: 'integer', value: String(to) }, { type: 'integer', value: String(from) }] },
    }]).results;
    assert.equal(Number(response.result.rows[0][0].value), seconds, `${from}..${to}`);
  }
  assert.equal(Util.durationSeconds_(start, start + 1234567), 1234);
});

test('durationSeconds_ refuses an end before the start and non-integers', () => {
  expectCode(() => Util.durationSeconds_(2000, 1000), 'INTERNAL');
  expectCode(() => Util.durationSeconds_(1.5, 2000), 'INTERNAL');
  expectCode(() => Util.durationSeconds_(1000, NaN), 'INTERNAL');
  expectCode(() => Util.durationSeconds_('1000', 2000), 'INTERNAL');
});

// ---------------------------------------------------------------- client time clamp

test('clampClientTime_: inside the skew use min(clientAt, now); outside it use now (BUILD_SPEC 6.2)', () => {
  const now = 1762160000000;
  const clamp = (clientAt, skew) => Util.clampClientTime_(clientAt, now, skew);
  assert.equal(clamp(now - 5000), now - 5000, 'a little in the past: the client is trusted');
  assert.equal(clamp(now + 5000), now, 'a little in the future: never later than the server');
  assert.equal(clamp(now), now);
  assert.equal(clamp(now - 120000), now - 120000, 'exactly the default 120 s: still inside');
  assert.equal(clamp(now - 120001), now, 'one ms beyond: the server time is used');
  assert.equal(clamp(now + 120000), now);
  assert.equal(clamp(now + 120001), now);
  assert.equal(clamp(now - 30000, 10), now, 'a tighter skew setting');
  assert.equal(clamp(now - 30000, 60), now - 30000, 'a looser one');
  assert.equal(clamp(now - 1, 0), now, 'skew 0 trusts nothing but "now"');
  assert.equal(clamp(now, 0), now);
});

test('clampClientTime_ falls back to the server time for a client value that is not a time', () => {
  const now = 1762160000000;
  for (const bad of [NaN, Infinity, undefined, null, '1762160000000', {}, 1762160000000.5]) {
    assert.equal(Util.clampClientTime_(bad, now), now, String(bad));
  }
  expectCode(() => Util.clampClientTime_(now, 1.5), 'INTERNAL');
  expectCode(() => Util.clampClientTime_(now, now, -1), 'INTERNAL');
  expectCode(() => Util.clampClientTime_(now, now, NaN), 'INTERNAL');
});

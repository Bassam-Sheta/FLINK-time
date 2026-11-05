'use strict';

// T1.1 — the fakes behave like Apps Script where the spec relies on it (BUILD_SPEC section 10).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp, runInApp } = require('./helpers/load-app');
const { createFakes, createClock, DEFAULT_START_MS } = require('./helpers/fakes');

const toHex = bytes => bytes.map(b => (b & 0xff).toString(16).padStart(2, '0')).join('');

// ---- clock

test('Date.now() and new Date() inside the app follow the injectable clock', () => {
  const ctx = loadApp();
  assert.equal(runInApp(ctx, 'Date.now()'), DEFAULT_START_MS);
  ctx.__setNow(Date.UTC(2026, 3, 30, 12, 0, 0));
  assert.equal(runInApp(ctx, 'new Date().getTime()'), Date.UTC(2026, 3, 30, 12, 0, 0));
  ctx.__advance(1500);
  assert.equal(runInApp(ctx, 'Date.now()'), Date.UTC(2026, 3, 30, 12, 0, 1, 500));
});

test('explicit dates, parsing and instanceof are untouched by the clock fake', () => {
  const ctx = loadApp();
  assert.equal(runInApp(ctx, 'new Date(0).getTime()'), 0);
  assert.equal(runInApp(ctx, 'new Date(2026, 0, 1).getFullYear()'), 2026);
  assert.equal(runInApp(ctx, 'Date.UTC(2026, 10, 5)'), Date.UTC(2026, 10, 5));
  assert.equal(runInApp(ctx, 'Date.parse("2026-11-05T00:00:00Z")'), Date.UTC(2026, 10, 5));
  assert.equal(runInApp(ctx, 'new Date() instanceof Date'), true);
  assert.equal(runInApp(ctx, 'typeof Date()'), 'string');
});

test('clock rejects non-integer values', () => {
  const clock = createClock();
  assert.throws(() => clock.set(1.5), TypeError);
  assert.throws(() => clock.advance(NaN), TypeError);
});

// ---- realm helper

test('__plain copies app objects into the test realm so deepStrictEqual works', () => {
  const ctx = loadApp();
  const fromApp = runInApp(ctx, '({ ok: true, rows: [1, 2], nested: { a: null } })');
  assert.notDeepStrictEqual(fromApp, { ok: true, rows: [1, 2], nested: { a: null } }, 'documents the realm gotcha');
  assert.deepStrictEqual(ctx.__plain(fromApp), { ok: true, rows: [1, 2], nested: { a: null } });
  assert.equal(ctx.__plain(undefined), undefined);
});

// ---- Utilities

test('computeDigest returns SIGNED bytes (SHA-256 of "abc")', () => {
  const ctx = loadApp();
  const bytes = runInApp(ctx, 'Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, "abc")');
  assert.equal(toHex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(bytes[0], -70, '0xba must come back as -70, as in Apps Script');
  assert.ok(bytes.every(b => b >= -128 && b <= 127));
});

test('computeHmacSha256Signature and computeHmacSignature agree with RFC 4231 case 2 and return signed bytes', () => {
  const ctx = loadApp();
  const expected = '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843';
  const viaShortcut = runInApp(ctx, 'Utilities.computeHmacSha256Signature("what do ya want for nothing?", "Jefe")');
  const viaGeneral = runInApp(ctx,
    'Utilities.computeHmacSignature(Utilities.MacAlgorithm.HMAC_SHA_256, "what do ya want for nothing?", "Jefe")');
  assert.equal(toHex(viaShortcut), expected);
  assert.equal(toHex(viaGeneral), expected);
  assert.equal(viaShortcut[1], -36, '0xdc must come back as -36');
});

test('byte-array inputs are accepted and read as signed bytes', () => {
  const ctx = loadApp();
  const bytes = runInApp(ctx, 'Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, [97, 98, 99])');
  assert.equal(toHex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const negative = runInApp(ctx, 'Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, [-1, -128, 127])');
  const unsigned = runInApp(ctx, 'Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, [255, 128, 127])');
  assert.deepEqual(negative, unsigned);
});

test('algorithm arguments must be the enum values, not strings', () => {
  const ctx = loadApp();
  assert.throws(() => runInApp(ctx, 'Utilities.computeDigest("SHA_256", "abc")'), /DigestAlgorithm/);
  assert.throws(() => runInApp(ctx, 'Utilities.computeHmacSignature("HMAC_SHA_256", "a", "b")'), /MacAlgorithm/);
  assert.throws(() => runInApp(ctx, 'Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 42)'), /string or a byte array/);
});

test('base64Encode and base64Decode round-trip, decode returns signed bytes', () => {
  const ctx = loadApp();
  assert.equal(runInApp(ctx, 'Utilities.base64Encode("hello")'), 'aGVsbG8=');
  assert.equal(runInApp(ctx, 'Utilities.base64Encode([-1, 0, 1])'), '/wAB');
  assert.deepEqual(ctx.__plain(runInApp(ctx, 'Utilities.base64Decode("/wAB")')), [-1, 0, 1]);
});

test('getUuid returns a lowercase RFC 4122 uuid, different each time', () => {
  const ctx = loadApp();
  const a = runInApp(ctx, 'Utilities.getUuid()');
  const b = runInApp(ctx, 'Utilities.getUuid()');
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});

test('sleep is a no-op that only records the time it was asked to wait', () => {
  const ctx = loadApp();
  runInApp(ctx, 'Utilities.sleep(500); Utilities.sleep(1500);');
  assert.equal(ctx.__fakes.utilities.sleptMs, 2000);
  assert.equal(runInApp(ctx, 'Date.now()'), DEFAULT_START_MS, 'sleep does not move the clock');
});

test('formatDate gives local date, time and offset in Africa/Cairo, with DST', () => {
  const ctx = loadApp();
  const fmt = (iso, pattern) =>
    runInApp(ctx, `Utilities.formatDate(new Date("${iso}"), "Africa/Cairo", "${pattern}")`);
  // Winter (UTC+2): 22:30Z on 5 Nov is already 6 Nov in Cairo.
  assert.equal(fmt('2026-11-05T22:30:00Z', 'yyyy-MM-dd'), '2026-11-06');
  assert.equal(fmt('2026-11-05T22:30:00Z', 'HH:mm'), '00:30');
  assert.equal(fmt('2026-11-05T22:30:00Z', 'Z'), '+0200');
  // Midnight must be "00", never "24".
  assert.equal(fmt('2026-11-05T22:00:00Z', 'HH:mm'), '00:00');
  // Summer (UTC+3, Egypt's DST).
  assert.equal(fmt('2026-07-01T12:00:00Z', 'HH:mm'), '15:00');
  assert.equal(fmt('2026-07-01T12:00:00Z', 'Z'), '+0300');
  assert.equal(runInApp(ctx, 'Utilities.formatDate(new Date("2026-07-01T12:00:00Z"), "UTC", "Z")'), '+0000');
});

test('formatDate refuses unsupported patterns and unknown zones instead of guessing', () => {
  const ctx = loadApp();
  assert.throws(() => runInApp(ctx, 'Utilities.formatDate(new Date(0), "UTC", "EEE")'), /not supported/);
  assert.throws(() => runInApp(ctx, 'Utilities.formatDate(new Date(0), "Mars/Base", "yyyy-MM-dd")'), /Invalid argument/);
  assert.throws(() => runInApp(ctx, 'Utilities.formatDate(1, "UTC", "yyyy-MM-dd")'), /must be a Date/);
});

// ---- Session

test('Session returns the emails the test sets; blank by default', () => {
  const ctx = loadApp();
  assert.equal(runInApp(ctx, 'Session.getActiveUser().getEmail()'), '');
  ctx.__fakes.session.setActiveEmail('user@flink.test');
  ctx.__fakes.session.setEffectiveEmail('owner@flink.test');
  assert.equal(runInApp(ctx, 'Session.getActiveUser().getEmail()'), 'user@flink.test');
  assert.equal(runInApp(ctx, 'Session.getEffectiveUser().getEmail()'), 'owner@flink.test');
  assert.equal(runInApp(ctx, 'Session.getScriptTimeZone()'), 'Africa/Cairo');
});

// ---- CacheService

test('cache entries expire on the fake clock and are capped at 6 hours', () => {
  const ctx = loadApp();
  runInApp(ctx, 'var c = CacheService.getScriptCache(); c.put("short", "a", 60); c.put("capped", "b", 999999);');
  assert.equal(runInApp(ctx, 'c.get("short")'), 'a');
  ctx.__advance(59 * 1000);
  assert.equal(runInApp(ctx, 'c.get("short")'), 'a');
  ctx.__advance(1000);
  assert.equal(runInApp(ctx, 'c.get("short")'), null);
  ctx.__advance(21600 * 1000 - 60 * 1000 - 1);
  assert.equal(runInApp(ctx, 'c.get("capped")'), 'b');
  ctx.__advance(1);
  assert.equal(runInApp(ctx, 'c.get("capped")'), null, 'ttl above 21600 s is capped');
});

test('cache stores numbers as strings, defaults to 10 minutes, and supports getAll/remove', () => {
  const ctx = loadApp();
  runInApp(ctx, 'var c = CacheService.getScriptCache(); c.put("n", 7); c.put("k", "v");');
  assert.equal(runInApp(ctx, 'c.get("n")'), '7');
  assert.deepEqual(ctx.__plain(runInApp(ctx, 'c.getAll(["n", "k", "missing"])')), { n: '7', k: 'v' });
  runInApp(ctx, 'c.remove("n")');
  assert.equal(runInApp(ctx, 'c.get("n")'), null);
  ctx.__advance(599 * 1000);
  assert.equal(runInApp(ctx, 'c.get("k")'), 'v');
  ctx.__advance(1000);
  assert.equal(runInApp(ctx, 'c.get("k")'), null);
});

test('cache refuses values over 100 KB, objects, and bad keys', () => {
  const ctx = loadApp();
  runInApp(ctx, 'var c = CacheService.getScriptCache();');
  assert.doesNotThrow(() => runInApp(ctx, 'c.put("ok", new Array(100 * 1024 + 1).join("x"))'));
  assert.throws(() => runInApp(ctx, 'c.put("big", new Array(100 * 1024 + 2).join("x"))'), /too large/);
  assert.throws(() => runInApp(ctx, 'c.put("obj", {a: 1})'), /must be a string/);
  assert.throws(() => runInApp(ctx, 'c.get("")'), /key/);
  assert.throws(() => runInApp(ctx, 'c.get(new Array(252).join("k"))'), /key/);
});

// ---- LockService

test('script lock: second tryLock fails while held, works after release, and can be held elsewhere', () => {
  const ctx = loadApp();
  runInApp(ctx, 'var lock = LockService.getScriptLock();');
  assert.equal(runInApp(ctx, 'lock.tryLock(0)'), true);
  assert.equal(runInApp(ctx, 'lock.hasLock()'), true);
  assert.equal(runInApp(ctx, 'lock.tryLock(0)'), false);
  runInApp(ctx, 'lock.releaseLock()');
  assert.equal(runInApp(ctx, 'lock.hasLock()'), false);
  ctx.__fakes.lock.setHeldElsewhere(true);
  assert.equal(runInApp(ctx, 'lock.tryLock(0)'), false);
  assert.throws(() => runInApp(ctx, 'lock.waitLock(100)'), /lock/i);
  ctx.__fakes.lock.setHeldElsewhere(false);
  assert.equal(runInApp(ctx, 'lock.tryLock(0)'), true);
});

// ---- PropertiesService

test('script properties are string-valued and missing keys read as null', () => {
  const ctx = loadApp();
  runInApp(ctx, 'var p = PropertiesService.getScriptProperties(); p.setProperty("A", 1); p.setProperties({ B: "two", C: 3 });');
  assert.equal(runInApp(ctx, 'p.getProperty("A")'), '1');
  assert.equal(runInApp(ctx, 'p.getProperty("nope")'), null);
  assert.deepEqual(ctx.__plain(runInApp(ctx, 'p.getProperties()')), { A: '1', B: 'two', C: '3' });
  runInApp(ctx, 'p.deleteProperty("A")');
  assert.equal(runInApp(ctx, 'p.getProperty("A")'), null);
  runInApp(ctx, 'p.setProperties({ Z: "z" }, true)');
  assert.deepEqual(ctx.__plain(runInApp(ctx, 'p.getProperties()')), { Z: 'z' });
});

// ---- UrlFetchApp

test('fetch routes to a handler, records the call, and returns an HTTPResponse-like object', () => {
  const ctx = loadApp();
  ctx.__fakes.fetch.route('https://db.test/', request => ({ status: 200, body: JSON.stringify({ echo: request.method }) }));
  const text = runInApp(ctx, `UrlFetchApp.fetch("https://db.test/v2/pipeline", {
    method: "post", headers: { Authorization: "Bearer test-rw" }, contentType: "application/json",
    payload: "{}", muteHttpExceptions: true }).getContentText()`);
  assert.equal(text, '{"echo":"POST"}');
  const [call] = ctx.__fakes.fetch.calls;
  assert.equal(call.url, 'https://db.test/v2/pipeline');
  assert.equal(call.headers.Authorization, 'Bearer test-rw');
  assert.equal(call.payload, '{}');
});

test('fetch can be told to fail, stall (on the fake clock), return garbage, or answer with a status', () => {
  const ctx = loadApp();
  const fetch = ctx.__fakes.fetch;
  fetch.route('https://db.test/', () => ({ status: 200, body: '{"ok":true}' }));
  const call = 'UrlFetchApp.fetch("https://db.test/x", { muteHttpExceptions: true })';

  fetch.failNext();
  assert.throws(() => runInApp(ctx, call), /Address unavailable/);
  assert.equal(runInApp(ctx, call + '.getContentText()'), '{"ok":true}', 'the failure applies to one call only');

  const before = runInApp(ctx, 'Date.now()');
  fetch.stallNext(30000);
  runInApp(ctx, call);
  assert.equal(runInApp(ctx, 'Date.now()') - before, 30000);

  fetch.garbageNext();
  assert.throws(() => JSON.parse(runInApp(ctx, call + '.getContentText()')));

  fetch.respondNext(503, 'busy');
  assert.equal(runInApp(ctx, call + '.getResponseCode()'), 503);
});

test('fetch throws on HTTP errors unless muteHttpExceptions is set, and on unrouted urls', () => {
  const ctx = loadApp();
  ctx.__fakes.fetch.respondNext(500, 'boom');
  assert.throws(() => runInApp(ctx, 'UrlFetchApp.fetch("https://db.test/x")'), /returned code 500/);
  assert.throws(() => runInApp(ctx, 'UrlFetchApp.fetch("https://other.test/x", { muteHttpExceptions: true })'), /no route/);
});

// ---- MailApp

test('MailApp records mails in both call styles and can be made to fail', () => {
  const ctx = loadApp();
  runInApp(ctx, 'MailApp.sendEmail("a@flink.test", "Subject A", "Body A");');
  runInApp(ctx, 'MailApp.sendEmail({ to: "b@flink.test", subject: "Subject B", body: "Body B" });');
  const sent = ctx.__plain(ctx.__fakes.mail.sent);
  assert.deepEqual(sent.map(m => [m.to, m.subject, m.body]), [
    ['a@flink.test', 'Subject A', 'Body A'],
    ['b@flink.test', 'Subject B', 'Body B'],
  ]);
  assert.equal(runInApp(ctx, 'MailApp.getRemainingDailyQuota()'), 98);
  ctx.__fakes.mail.failNext();
  assert.throws(() => runInApp(ctx, 'MailApp.sendEmail("c@flink.test", "s", "b")'), /too many times/);
  assert.equal(ctx.__fakes.mail.sent.length, 2);
});

// ---- HtmlService

test('HtmlService records the template, its properties, title and frame mode', () => {
  const ctx = loadApp();
  runInApp(ctx, `
    var t = HtmlService.createTemplateFromFile("Portal");
    t.view = "user";
    t.nonce = 5;
    t.evaluate().setTitle("FLINK Time").setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  `);
  const last = ctx.__plain(ctx.__fakes.html.last());
  assert.deepEqual(last, { template: 'Portal', props: { view: 'user', nonce: 5 }, title: 'FLINK Time', frameMode: 'ALLOWALL', meta: [] });
});

// ---- ScriptApp

test('ScriptApp records triggers and deletes them', () => {
  const ctx = loadApp();
  runInApp(ctx, `
    ScriptApp.newTrigger("jobSealAudit").timeBased().everyMinutes(1).create();
    ScriptApp.newTrigger("jobDailyExport").timeBased().everyDays(1).atHour(1).nearMinute(30).inTimezone("Africa/Cairo").create();
    ScriptApp.newTrigger("jobBackup").timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();
  `);
  assert.deepEqual(ctx.__plain(ctx.__fakes.triggers.triggers), [
    { id: '1', handler: 'jobSealAudit', schedule: { every: { unit: 'minutes', n: 1 } } },
    { id: '2', handler: 'jobDailyExport', schedule: { every: { unit: 'days', n: 1 }, atHour: 1, nearMinute: 30, timeZone: 'Africa/Cairo' } },
    { id: '3', handler: 'jobBackup', schedule: { weekDay: 'SUNDAY', atHour: 3 } },
  ]);
  assert.equal(runInApp(ctx, 'ScriptApp.getProjectTriggers().length'), 3);
  runInApp(ctx, 'ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });');
  assert.equal(runInApp(ctx, 'ScriptApp.getProjectTriggers().length'), 0);
});

// ---- console and services not built yet

test('console output is recorded, not printed', () => {
  const ctx = loadApp();
  runInApp(ctx, 'console.log("action", "timer.start", { ms: 12 }); console.error("boom");');
  assert.deepEqual(ctx.__plain(ctx.__fakes.log.lines), [
    { level: 'log', text: 'action timer.start {"ms":12}' },
    { level: 'error', text: 'boom' },
  ]);
});

test('DriveApp and SpreadsheetApp fail loudly until their ticket builds them', () => {
  const ctx = loadApp();
  assert.throws(() => runInApp(ctx, 'DriveApp.getFolderById("x")'), /not implemented yet.*T4\.3/);
  assert.throws(() => runInApp(ctx, 'SpreadsheetApp.create("x")'), /not implemented yet.*T4\.3/);
});

test('fakes can be shared with a test and each loadApp gets isolated state by default', () => {
  const fakes = createFakes();
  const shared = loadApp({ fakes });
  assert.equal(shared.__fakes, fakes);
  const one = loadApp();
  const two = loadApp();
  runInApp(one, 'PropertiesService.getScriptProperties().setProperty("X", "1")');
  assert.equal(runInApp(two, 'PropertiesService.getScriptProperties().getProperty("X")'), null);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { sessionSheetFixture } = require('./helpers/session-sheet-fixture');

function fixture(tab = 'Sessions') {
  const fx = sessionSheetFixture();
  const expected = Array.from(fx.context.MASTER_SCHEMA[tab]);
  const headers = expected.slice(0, -1);
  const originalRows = [['existing-session', 'no-assurance-added']];
  const rowsBefore = JSON.stringify(originalRows);
  const events = [];
  const controls = { owner: true, audit: true, columns: headers.length, failCompletion: false, failFlush: 0 };
  fx.context.IdentityService.assertInstallationOwner = () => {
    if (!controls.owner) throw new fx.context.AppError('UNAUTHORIZED', 'Not owner', 403);
    return 'owner@example.test';
  };
  const sheet = {
    getLastColumn: () => headers.length,
    getMaxColumns: () => controls.columns,
    insertColumnsAfter(after, count) {
      assert.equal(after, controls.columns); assert.equal(fx.controls.locked, true);
      controls.columns += count; events.push('allocate');
    },
    getRange(row, col, count, width) {
      assert.equal(row, 1, 'migration may only read/write the header');
      assert.equal(count, 1);
      assert.ok(col + width - 1 <= controls.columns);
      return {
        getValues: () => [headers.slice(col - 1, col - 1 + width)],
        setValue(value) {
          assert.equal(fx.controls.locked, true); assert.equal(width, 1);
          headers[col - 1] = value; events.push('header');
        }
      };
    }
  };
  fx.context.MasterRepository.getMasterSpreadsheet = () => ({ getSheetByName: name => name === tab ? sheet : null });
  fx.context.MasterRepository.logGlobalAudit = record => {
    events.push(record.Action);
    return controls.audit && !(controls.failCompletion && record.Action.endsWith('_COMPLETED'));
  };
  fx.context.SpreadsheetApp.flush = () => {
    assert.equal(fx.controls.locked, true); events.push('flush');
    if (events.filter(event => event === 'flush').length === controls.failFlush) throw new Error('Synthetic flush failure');
  };
  return { ...fx, headers, expected, controls, events, originalRows, rowsBefore,
    run: () => tab === 'Sessions' ? fx.context.migrateSessionAssuranceSchema_() : fx.context.migrateRecoverySchema_() };
}

test('owner session schema migration appends only AuthLevel and keeps old sessions unassured', () => {
  const fx = fixture();
  assert.equal(fx.run().changed, true);
  assert.deepEqual(fx.headers, fx.expected);
  assert.equal(JSON.stringify(fx.originalRows), fx.rowsBefore);
  assert.ok(fx.events.indexOf('SESSION_ASSURANCE_SCHEMA_INTENT') < fx.events.indexOf('header'));
  assert.ok(fx.events.indexOf('flush') < fx.events.indexOf('header'));
  assert.ok(fx.events.includes('SESSION_ASSURANCE_SCHEMA_COMPLETED'));
  assert.equal(fx.controls.columns, fx.expected.length);
  assert.equal(fx.run().changed, false);
  assert.equal(fx.events.filter(event => event === 'header').length, 1);
});

test('session schema migration denies non-owners before touching storage', () => {
  const fx = fixture();
  fx.controls.owner = false;
  assert.throws(fx.run, error => error.code === 'UNAUTHORIZED');
  assert.deepEqual(fx.events, []);
});

test('session schema migration refuses unfamiliar columns and failed audit intents', () => {
  for (const kind of ['unexpected-column', 'reordered-header', 'audit-unavailable']) {
    const fx = fixture();
    if (kind === 'unexpected-column') { fx.headers.push('UserOwnedData'); fx.controls.columns++; }
    if (kind === 'reordered-header') fx.headers[0] = 'UnknownId';
    if (kind === 'audit-unavailable') fx.controls.audit = false;
    const before = [...fx.headers];
    assert.throws(fx.run, error => ['CONFLICT', 'CRYPTO_FAILURE'].includes(error.code));
    assert.deepEqual(fx.headers, before);
    assert.equal(fx.context.LockService.getScriptLock().hasLock(), false);
  }
});

test('failed migration flushes release the lock and allow a verified retry without duplicating columns', () => {
  for (const failFlush of [1, 2, 3]) {
    const fx = fixture();
    fx.controls.failFlush = failFlush;
    assert.throws(fx.run, /Synthetic flush failure/);
    assert.equal(fx.context.LockService.getScriptLock().hasLock(), false);
    if (failFlush === 1) assert.equal(fx.events.includes('header'), false, 'intent must flush before mutation');
    fx.controls.failFlush = 0;
    assert.equal(fx.run().ok, true);
    assert.deepEqual(fx.headers, fx.expected);
    assert.equal(fx.events.filter(event => event === 'header').length, 1);
  }
});

test('completion audit failure is reported and retry records completion of the already-migrated header', () => {
  const fx = fixture();
  fx.controls.failCompletion = true;
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.deepEqual(fx.headers, fx.expected);
  fx.controls.failCompletion = false;
  assert.equal(fx.run().changed, false);
  assert.equal(fx.events.filter(event => event === 'header').length, 1);
  assert.equal(fx.events.filter(event => event === 'SESSION_ASSURANCE_SCHEMA_COMPLETED').length, 2);
});

test('recovery migration appends only its credential header and recovers after failed completion audit', () => {
  const fx = fixture('Credentials');
  fx.controls.failCompletion = true;
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.deepEqual(fx.headers, fx.expected);
  assert.equal(fx.headers.at(-1), 'RecoveryJSON');
  assert.equal(JSON.stringify(fx.originalRows), fx.rowsBefore);
  fx.controls.failCompletion = false;
  assert.equal(fx.run().changed, false);
  assert.equal(fx.events.filter(event => event === 'header').length, 1);
  assert.ok(fx.events.includes('CREDENTIAL_RECOVERY_SCHEMA_COMPLETED'));
});

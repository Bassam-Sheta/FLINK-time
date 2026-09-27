'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/BackupAndAuditServices.gs'
);

function hash(previousHash, payload) {
  return crypto
    .createHash('sha256')
    .update(previousHash + '|' + JSON.stringify(payload))
    .digest('hex');
}

function loadAudit(rows) {
  global.CONSTANTS = {
    MASTER_TABS: { GLOBAL_AUDIT: 'GlobalAudit' },
    WORKSPACE_TABS: { AUDIT_LOG: 'AuditLog' },
    SECURITY: { CHECKPOINT_PROPERTY_PREFIX: 'CP_' }
  };
  global.MasterRepository = {
    getTableData() { return { rows }; }
  };
  global.SheetRepository = {
    getTableData() { return { rows }; }
  };
  global.SecurityService = {
    constantTimeEquals(a, b) { return a === b; },
    computeAuditHash(previousHash, payload) {
      return hash(previousHash, payload);
    }
  };
  global.PropertiesService = undefined;

  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).AuditService;
}

function validRow(previousHash, id = 'A1') {
  const row = {
    AuditID: id,
    TimestampUTC: '2026-09-27T12:00:00.000Z',
    ActorUserID: 'U1',
    Action: 'TEST',
    EntityType: 'ENTITY',
    EntityID: 'E1',
    AfterJSON: '{"ok":true}',
    PreviousHash: previousHash
  };
  row.RecordHash = hash(previousHash, {
    auditId: row.AuditID,
    timestamp: row.TimestampUTC,
    actor: row.ActorUserID,
    action: row.Action,
    entityType: row.EntityType,
    entityId: row.EntityID,
    after: row.AfterJSON
  });
  return row;
}

test('audit verification accepts a complete valid chain', () => {
  const genesis = '0'.repeat(64);
  const first = validRow(genesis, 'A1');
  const second = validRow(first.RecordHash, 'A2');
  const AuditService = loadAudit([first, second]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.count, 2);
});

test('audit verification rejects a record with missing RecordHash', () => {
  const genesis = '0'.repeat(64);
  const row = validRow(genesis, 'A1');
  row.RecordHash = '';
  const AuditService = loadAudit([row]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /missing/i);
});

test('audit verification rejects a record with missing PreviousHash', () => {
  const genesis = '0'.repeat(64);
  const row = validRow(genesis, 'A1');
  row.PreviousHash = '';
  const AuditService = loadAudit([row]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /missing/i);
});

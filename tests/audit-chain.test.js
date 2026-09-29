'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../apps-script/Code.gs');
const GENESIS = '0'.repeat(64);

function hash(previousHash, payload) {
  return crypto
    .createHash('sha256')
    .update(previousHash + '|' + JSON.stringify(payload))
    .digest('hex');
}

function checkpointHash(scope, date, lastHash, count) {
  return crypto
    .createHash('sha256')
    .update(['CHECKPOINT', scope, date, lastHash, count].join('|'))
    .digest('hex');
}

function storedString(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function v2Payload(record, workspaceScope = '') {
  return {
    version: 2,
    auditId: storedString(record.AuditID),
    timestamp: storedString(record.TimestampUTC),
    actor: storedString(record.ActorUserID),
    actorRole: storedString(record.ActorRole),
    workspaceId: storedString(workspaceScope || record.WorkspaceID || ''),
    entityType: storedString(record.EntityType),
    entityId: storedString(record.EntityID),
    action: storedString(record.Action),
    before: storedString(record.BeforeJSON),
    after: storedString(record.AfterJSON),
    reason: storedString(record.Reason),
    correlationId: storedString(record.CorrelationID),
    clientType: storedString(record.ClientType || 'WEB')
  };
}

function loadAudit(rows, checkpoints = {}) {
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
    constantTimeEquals(a, b) { return String(a) === String(b); },
    computeAuditHash(previousHash, payload) {
      return hash(previousHash, payload);
    },
    buildAuditPayloadV2(record, workspaceScope = '') {
      return v2Payload(record, workspaceScope);
    },
    computeAuditRecordHashV2(previousHash, record, workspaceScope = '') {
      return 'v2:' + hash(previousHash, v2Payload(record, workspaceScope));
    },
    computeAuditCheckpoint(scope, date, lastHash, count) {
      return checkpointHash(scope, date, lastHash, count);
    }
  };
  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperties() { return { ...checkpoints }; },
        getProperty(key) { return checkpoints[key] || ''; }
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).AuditService;
}

function legacyRow(previousHash, id = 'A1') {
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

function v2Row(previousHash, id = 'A1', overrides = {}) {
  const row = {
    AuditID: id,
    TimestampUTC: '2026-09-27T12:00:00.000Z',
    ActorUserID: 'U1',
    ActorRole: 'ADMIN',
    WorkspaceID: 'W1',
    EntityType: 'ENTITY',
    EntityID: 'E1',
    Action: 'TEST',
    BeforeJSON: '{"before":true}',
    AfterJSON: '{"after":true}',
    Reason: 'security reason',
    CorrelationID: 'COR-1',
    ClientType: 'WEB',
    PreviousHash: previousHash,
    ...overrides
  };
  row.RecordHash = 'v2:' + hash(previousHash, v2Payload(row, row.WorkspaceID));
  return row;
}

function checkpoint(scope, date, lastHash, count) {
  return JSON.stringify({
    scope,
    date,
    lastHash,
    count,
    rootHash: checkpointHash(scope, date, lastHash, count),
    checkpointAt: date + 'T23:59:00.000Z'
  });
}

test('audit verification preserves backward compatibility with a valid legacy chain', () => {
  const first = legacyRow(GENESIS, 'A1');
  const second = legacyRow(first.RecordHash, 'A2');
  const AuditService = loadAudit([first, second]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.count, 2);
});

test('audit v2 accepts a complete valid chain and authenticates the full record', () => {
  const first = v2Row(GENESIS, 'A1');
  const second = v2Row(first.RecordHash, 'A2');
  const AuditService = loadAudit([first, second]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.count, 2);
  assert.equal(result.lastRecordHash, second.RecordHash);
});

for (const field of [
  'ActorRole',
  'WorkspaceID',
  'BeforeJSON',
  'AfterJSON',
  'Reason',
  'CorrelationID',
  'ClientType',
  'Action',
  'EntityType',
  'EntityID'
]) {
  test(`audit v2 detects tampering with ${field}`, () => {
    const row = v2Row(GENESIS, 'A1');
    row[field] = String(row[field] || '') + '-TAMPERED';
    const AuditService = loadAudit([row]);

    const result = AuditService.verifyAuditChain();
    assert.equal(result.ok, false);
    assert.equal(result.verified, false);
    assert.match(result.message, /tamper|HMAC/i);
  });
}

test('audit verification rejects a record with missing RecordHash', () => {
  const row = legacyRow(GENESIS, 'A1');
  row.RecordHash = '';
  const AuditService = loadAudit([row]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /missing/i);
});

test('audit verification rejects a record with missing PreviousHash', () => {
  const row = legacyRow(GENESIS, 'A1');
  row.PreviousHash = '';
  const AuditService = loadAudit([row]);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /missing/i);
});

test('durable checkpoint detects complete audit-log deletion', () => {
  const historical = v2Row(GENESIS, 'A1');
  const checkpoints = {
    'CP_MASTER_2026-09-27': checkpoint(
      'MASTER',
      '2026-09-27',
      historical.RecordHash,
      1
    )
  };
  const AuditService = loadAudit([], checkpoints);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /truncation/i);
});

test('durable checkpoint detects tail truncation', () => {
  const first = v2Row(GENESIS, 'A1');
  const second = v2Row(first.RecordHash, 'A2');
  const checkpoints = {
    'CP_MASTER_2026-09-27': checkpoint(
      'MASTER',
      '2026-09-27',
      second.RecordHash,
      2
    )
  };
  const AuditService = loadAudit([first], checkpoints);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /truncation/i);
});

test('durable checkpoint must match the exact chain prefix', () => {
  const first = v2Row(GENESIS, 'A1');
  const checkpoints = {
    'CP_MASTER_2026-09-27': checkpoint(
      'MASTER',
      '2026-09-27',
      'v2:not-the-record-hash',
      1
    )
  };
  const AuditService = loadAudit([first], checkpoints);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /chain prefix/i);
});

test('legitimate records appended after a valid checkpoint remain verifiable', () => {
  const first = v2Row(GENESIS, 'A1');
  const second = v2Row(first.RecordHash, 'A2');
  const checkpoints = {
    'CP_MASTER_2026-09-27': checkpoint(
      'MASTER',
      '2026-09-27',
      first.RecordHash,
      1
    )
  };
  const AuditService = loadAudit([first, second], checkpoints);

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, true);
  assert.equal(result.verified, true);
  assert.equal(result.checkpointVerified, true);
  assert.equal(result.count, 2);
});

test('corrupted durable checkpoint fails verification', () => {
  const first = v2Row(GENESIS, 'A1');
  const cp = JSON.parse(checkpoint('MASTER', '2026-09-27', first.RecordHash, 1));
  cp.rootHash = 'BAD';
  const AuditService = loadAudit(
    [first],
    { 'CP_MASTER_2026-09-27': JSON.stringify(cp) }
  );

  const result = AuditService.verifyAuditChain();
  assert.equal(result.ok, false);
  assert.equal(result.verified, false);
  assert.match(result.message, /checkpoint/i);
});

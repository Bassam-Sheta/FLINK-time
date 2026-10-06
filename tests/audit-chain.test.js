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
        getProperty(key) { return checkpoints[key] || ''; },
        setProperty(key, val) { checkpoints[key] = String(val); },
        deleteProperty(key) { delete checkpoints[key]; }
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

test('JobService housekeeping prunes audit checkpoints older than retention days', () => {
  const now = Date.now();
  const ninetyOneDaysAgo = new Date(now - 91 * 24 * 3600 * 1000).toISOString().split('T')[0];
  const fiveDaysAgo = new Date(now - 5 * 24 * 3600 * 1000).toISOString().split('T')[0];
  const prefix = 'FLINK_AUDIT_CHECKPOINT_';

  const propsStore = {
    [prefix + 'MASTER_' + ninetyOneDaysAgo]: JSON.stringify({
      scope: 'MASTER',
      date: ninetyOneDaysAgo,
      checkpointAt: ninetyOneDaysAgo + 'T00:00:00.000Z'
    }),
    [prefix + 'MASTER_' + fiveDaysAgo]: JSON.stringify({
      scope: 'MASTER',
      date: fiveDaysAgo,
      checkpointAt: fiveDaysAgo + 'T00:00:00.000Z'
    })
  };

  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperties() { return { ...propsStore }; },
        getProperty(key) { return propsStore[key]; },
        deleteProperty(key) { delete propsStore[key]; }
      };
    }
  };

  global.MasterRepository = {
    beginRequest() {},
    getTableData(tabName) {
      if (tabName === 'Sessions') return { rows: [] };
      if (tabName === 'Accounts') return { rows: [] };
      return { rows: [] };
    }
  };

  delete global.CONSTANTS;
  delete require.cache[require.resolve(servicePath)];
  const code = require(servicePath);

  const jobRunLogs = [];
  const prevJobServiceLog = code.JobService.logJobRun;
  code.JobService.logJobRun = (entry) => jobRunLogs.push(entry);

  try {
    const result = code.JobService.dispatchHousekeeping();
    assert.equal(result.ok, true);
    assert.equal(result.purgedCheckpointsCount, 1);
    assert.equal(propsStore[prefix + 'MASTER_' + ninetyOneDaysAgo], undefined);
    assert.ok(propsStore[prefix + 'MASTER_' + fiveDaysAgo]);
  } finally {
    code.JobService.logJobRun = prevJobServiceLog;
  }
});

test('getLastAuditHash reads single-cell RecordHash without full table scans', () => {
  delete global.CONSTANTS;
  delete global.MasterRepository;
  delete global.SheetRepository;
  delete require.cache[require.resolve(servicePath)];
  const code = require(servicePath);

  let getRangeCallCount = 0;
  let getDataRangeCallCount = 0;

  const mockSheet = {
    getLastRow() { return 500; },
    getLastColumn() { return 15; },
    getRange(row, col, numRows, numCols) {
      getRangeCallCount++;
      if (row === 1 && col === 1) {
        return {
          getValues() {
            return [['AuditID', 'TimestampUTC', 'ActorUserID', 'ActorRole', 'WorkspaceID', 'EntityType', 'EntityID', 'Action', 'BeforeJSON', 'AfterJSON', 'Reason', 'CorrelationID', 'ClientType', 'PreviousHash', 'RecordHash']];
          }
        };
      }
      if (row === 500 && col === 15) {
        return {
          getValue() { return '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'; }
        };
      }
      throw new Error(`Unexpected range read: ${row}, ${col}`);
    },
    getDataRange() {
      getDataRangeCallCount++;
      throw new Error('getDataRange must not be called by getLastAuditHash');
    }
  };

  code.MasterRepository.getMasterSpreadsheet = () => ({
    getSheetByName(name) {
      if (name === code.CONSTANTS.MASTER_TABS.GLOBAL_AUDIT) return mockSheet;
      return null;
    }
  });

  const hash = code.MasterRepository.getLastAuditHash(code.CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);
  assert.equal(hash, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.equal(getDataRangeCallCount, 0);
  assert.equal(getRangeCallCount, 2);
});

test('autoStopRunawayTimers cleanly finalizes timers exceeding AUTO_STOP_HOURS', () => {
  delete global.CONSTANTS;
  delete global.MasterRepository;
  delete global.SheetRepository;
  delete global.SecurityService;
  delete global.Utilities;
  delete require.cache[require.resolve(servicePath)];
  const code = require(servicePath);

  const wsId = 'WS-AUTOSTOP-TEST';
  code.MasterRepository.listWorkspaces = () => [
    { WorkspaceID: wsId, WorkspaceName: 'Test WS', Status: 'ACTIVE' }
  ];
  code.MasterRepository.getAllWorkspaces = code.MasterRepository.listWorkspaces;
  code.MasterRepository.getAllGlobalSettingsStrict = () => ({});
  code.Flags = { getValue: (k) => k === 'AUTO_STOP_HOURS' ? 14 : null };
  code.MasterRepository.getAccount = (uid) => ({
    UserID: uid,
    Email: 'dev@flink.local',
    Role: code.CONSTANTS.ROLES.USER
  });

  const twentySixHoursAgo = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  let deletedUserId = null;
  let createdEntry = null;
  let auditLogs = [];

  code.SheetRepository.listActiveTimers = (w) => {
    if (w === wsId) {
      return [{
        TimerID: 'TMR-RUNAWAY-1',
        UserID: 'USR-DEV-1',
        WorkspaceID: wsId,
        StartedAtUTC: twentySixHoursAgo,
        ProjectID: 'PRJ-1',
        TaskID: 'TSK-1',
        Description: 'Forgot to stop timer before weekend',
        TagIDs: '[]',
        Billable: true,
        WorkMode: 'OFFICE',
        Source: 'WEB'
      }];
    }
    return [];
  };

  code.SheetRepository.getEntryAnyStatus = () => null;
  code.SheetRepository.createTimeEntry = (w, entry) => {
    createdEntry = entry;
    return entry;
  };
  code.SheetRepository.deleteActiveTimer = (w, uid) => {
    deletedUserId = uid;
    return true;
  };
  code.SheetRepository.logWorkspaceAudit = (w, log) => {
    auditLogs.push(log);
  };

  // Mock tracking policy
  code.TrackingPolicyService.validateTrackingContext = () => ({
    project: { HourlyRate: 100, CostRate: 50 },
    task: null
  });

  const res = code.TimerService.autoStopRunawayTimers();
  assert.equal(res.stoppedCount, 1);
  assert.equal(deletedUserId, 'USR-DEV-1');
  assert.ok(createdEntry);
  assert.equal(createdEntry.UserID, 'USR-DEV-1');
  // Maximum single entry duration is clamped to 14h (50400s)
  assert.equal(createdEntry.DurationSeconds, 14 * 3600);
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].Action, 'TIMER_STOPPED');
  assert.equal(auditLogs[0].Reason, 'AUTO_STOP_RUNAWAY');
  assert.equal(auditLogs[0].ActorUserID, 'SYSTEM');
});

test('createAuditCheckpoint prunes old checkpoints beyond MAX_AUDIT_CHECKPOINTS_RETAINED', () => {
  const row = legacyRow(GENESIS, 'A1');
  const stored = {};
  for (let i = 1; i <= 65; i++) {
    const pad = String(i).padStart(2, '0');
    stored[`CP_MASTER_2026-01-${pad}`] = JSON.stringify({
      scope: 'MASTER',
      date: `2026-01-${pad}`,
      lastHash: 'HASH',
      count: i,
      rootHash: 'ROOT',
      snapshotHash: 'SNAP'
    });
  }

  const auditService = loadAudit([row], stored);
  const deletedKeys = [];
  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperties() { return { ...stored }; },
        getProperty(k) { return stored[k] || ''; },
        setProperty(k, v) { stored[k] = String(v); },
        deleteProperty(k) {
          deletedKeys.push(k);
          delete stored[k];
        }
      };
    }
  };

  auditService.verifyAuditChain = () => ({
    ok: true,
    verified: true,
    count: 1,
    lastRecordHash: row.RecordHash
  });
  const result = auditService.createAuditCheckpoint();
  assert.equal(result.ok, true);
  // 65 existing + 1 new = 66 checkpoints. With maxRetained = 60, 6 old ones must be deleted.
  assert.equal(deletedKeys.length, 6);
  assert.equal(deletedKeys[0], 'CP_MASTER_2026-01-01');
  assert.equal(deletedKeys[5], 'CP_MASTER_2026-01-06');
});




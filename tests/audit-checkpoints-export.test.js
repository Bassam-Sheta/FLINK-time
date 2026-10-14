'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');

function loadAuditEnvironment(opts = {}) {
  const auditLogs = [];
  const scriptProps = opts.properties || {};

  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    MASTER_TABS: {
      GLOBAL_AUDIT: 'GlobalAudit',
      SESSIONS: 'Sessions',
      ACCOUNTS: 'Accounts',
      JOB_RUNS: 'JobRuns'
    },
    JOB_STATUS: { COMPLETED: 'COMPLETED', FAILED: 'FAILED' },
    AUDIT_EVENTS: { AUDIT_CHECKPOINT_ARCHIVED: 'AUDIT_CHECKPOINT_ARCHIVED' },
    SECURITY: {
      CHECKPOINT_PROPERTY_PREFIX: 'FLINK_AUDIT_CHECKPOINT_',
      MAX_AUDIT_CHECKPOINTS_RETAINED: opts.maxCheckpoints || 60
    },
    LIMITS: {
      SESSION_RETENTION_DAYS: 30,
      AUDIT_CHECKPOINT_RETENTION_DAYS: 90
    }
  };

  global.AuthorizationService = {
    assertRole(ctx, roles) {
      if (!ctx || !roles.includes(ctx.role)) {
        const err = new Error('PERMISSION_DENIED');
        err.code = 'PERMISSION_DENIED';
        throw err;
      }
    }
  };

  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperties() { return { ...scriptProps }; },
        getProperty(k) { return scriptProps[k] || null; },
        setProperty(k, v) { scriptProps[k] = String(v); },
        deleteProperty(k) { delete scriptProps[k]; }
      };
    }
  };

  global.MasterRepository = {
    getTableData(tab) {
      if (tab === 'Sessions') return { rows: [] };
      if (tab === 'Accounts') return { rows: [] };
      if (tab === 'GlobalAudit') return { rows: opts.auditRows || [] };
      return { rows: [] };
    },
    logGlobalAudit(audit) {
      auditLogs.push(audit);
    },
    appendRow() {},
    updateRow() {},
    deleteRows() {}
  };

  global.Validation = {
    generateId(p) { return `${p}-${Math.random().toString(36).substring(2, 8)}`; }
  };

  delete require.cache[require.resolve(codePath)];
  const mod = require(codePath);
  return {
    AuditService: mod.AuditService,
    JobService: mod.JobService,
    auditLogs,
    scriptProps
  };
}

test('AuditService.getAuditCheckpoints lists and filters checkpoints from Script Properties', () => {
  const properties = {
    'FLINK_AUDIT_CHECKPOINT_MASTER_2026-10-01': JSON.stringify({
      scope: 'MASTER',
      date: '2026-10-01',
      count: 10,
      lastHash: 'H1',
      rootHash: 'R1'
    }),
    'FLINK_AUDIT_CHECKPOINT_MASTER_2026-10-02': JSON.stringify({
      scope: 'MASTER',
      date: '2026-10-02',
      count: 15,
      lastHash: 'H2',
      rootHash: 'R2'
    }),
    'FLINK_AUDIT_CHECKPOINT_WS-1_2026-10-02': JSON.stringify({
      scope: 'WS-1',
      date: '2026-10-02',
      count: 5,
      lastHash: 'HW1',
      rootHash: 'RW1'
    })
  };

  const { AuditService } = loadAuditEnvironment({ properties });

  const masterList = AuditService.getAuditCheckpoints();
  assert.equal(masterList.length, 2);
  assert.equal(masterList[0].date, '2026-10-01');
  assert.equal(masterList[1].date, '2026-10-02');

  const wsList = AuditService.getAuditCheckpoints('WS-1');
  assert.equal(wsList.length, 1);
  assert.equal(wsList[0].scope, 'WS-1');
  assert.equal(wsList[0].count, 5);
});

test('AuditService.exportAuditCheckpointsCsv produces formula-sanitized CSV', () => {
  const properties = {
    'FLINK_AUDIT_CHECKPOINT_MASTER_2026-10-01': JSON.stringify({
      scope: 'MASTER',
      date: '2026-10-01',
      count: 10,
      lastHash: '=cmd|/c calc', // Attempted formula injection
      rootHash: 'ROOTHASH123',
      snapshotHash: 'SNAP456',
      checkpointAt: '2026-10-01T03:00:00.000Z'
    })
  };

  const { AuditService } = loadAuditEnvironment({ properties });
  const exportRes = AuditService.exportAuditCheckpointsCsv(
    { userId: 'SA-1', role: 'SUPER_ADMIN' },
    'MASTER'
  );

  assert.equal(exportRes.mimeType, 'text/csv');
  assert.equal(exportRes.count, 1);
  assert.match(exportRes.filename, /^FLINK_AUDIT_CHECKPOINTS_MASTER_\d{4}-\d{2}-\d{2}\.csv$/);

  // Formula injection check: cell starting with '=' must be prefixed with single quote
  assert.ok(exportRes.csv.includes('"\'=cmd|/c calc"'), 'Formula injection must be neutralized with leading quote');
});

test('housekeeping archives expired checkpoints to GlobalAudit before purging from Script Properties', () => {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;

  // 1 checkpoint older than 90 days (100 days old)
  const expiredDate = new Date(now - 100 * dayMs).toISOString().split('T')[0];
  const activeDate = new Date(now - 10 * dayMs).toISOString().split('T')[0];

  const expiredKey = `FLINK_AUDIT_CHECKPOINT_MASTER_${expiredDate}`;
  const activeKey = `FLINK_AUDIT_CHECKPOINT_MASTER_${activeDate}`;

  const properties = {
    [expiredKey]: JSON.stringify({
      scope: 'MASTER',
      date: expiredDate,
      count: 100,
      lastHash: 'HASH_EXP',
      rootHash: 'ROOT_EXP',
      checkpointAt: new Date(now - 100 * dayMs).toISOString()
    }),
    [activeKey]: JSON.stringify({
      scope: 'MASTER',
      date: activeDate,
      count: 200,
      lastHash: 'HASH_ACT',
      rootHash: 'ROOT_ACT',
      checkpointAt: new Date(now - 10 * dayMs).toISOString()
    })
  };

  const { JobService, auditLogs, scriptProps } = loadAuditEnvironment({ properties });
  global.MasterRepository._withSessionMutationLock = fn => fn();
  const res = JobService.dispatchHousekeeping();

  assert.equal(res.ok, true);
  assert.equal(res.purgedCheckpointsCount, 1);
  assert.equal(scriptProps[expiredKey], undefined);
  assert.notEqual(scriptProps[activeKey], undefined);

  // Verify archived event logged in GlobalAudit
  const archiveEvent = auditLogs.find(a => a.Action === 'AUDIT_CHECKPOINT_ARCHIVED');
  assert.ok(archiveEvent, 'AUDIT_CHECKPOINT_ARCHIVED event must be present in GlobalAudit');
  assert.equal(archiveEvent.EntityID, expiredKey);
  assert.equal(archiveEvent.BeforeJSON.count, 100);
});

test('audit.listCheckpoints and audit.exportCheckpointsCsv are declared in ACTION_PERMISSIONS', () => {
  const src = fs.readFileSync(codePath, 'utf8');
  assert.match(src, /'audit\.listCheckpoints':\s*\{\s*authRequired:\s*true,\s*roles:\s*\[CONSTANTS\.ROLES\.SUPER_ADMIN\],\s*isWrite:\s*false\s*\}/);
  assert.match(src, /'audit\.exportCheckpointsCsv':\s*\{\s*authRequired:\s*true,\s*roles:\s*\[CONSTANTS\.ROLES\.SUPER_ADMIN\],\s*isWrite:\s*false\s*\}/);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');

function loadService(opts = {}) {
  const trashedFiles = [];
  const auditLogs = [];
  const registryRows = opts.registryRows || [];

  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    MASTER_TABS: {
      BACKUP_REGISTRY: 'BackupRegistry',
      JOB_RUNS: 'JobRuns',
      WORKSPACES: 'Workspaces'
    },
    JOB_STATUS: { COMPLETED: 'COMPLETED', FAILED: 'FAILED' },
    WORKSPACE_STATUS: { ACTIVE: 'ACTIVE', SUSPENDED: 'SUSPENDED' },
    AUDIT_EVENTS: { BACKUP_PURGED: 'BACKUP_PURGED', BACKUP_CREATED: 'BACKUP_CREATED' },
    LIMITS: {
      BACKUP_RETENTION_DAYS: 30,
      MAX_BACKUPS_PER_SCOPE: 30,
      MIN_BACKUPS_RETAINED: 3
    }
  };

  global.LockService = {
    getScriptLock() {
      return {
        tryLock() { return opts.lockFail ? false : true; },
        releaseLock() {}
      };
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

  global.DriveApp = {
    getFileById(id) {
      return {
        isTrashed() { return false; },
        setTrashed(val) {
          trashedFiles.push({ id, val });
        }
      };
    }
  };

  global.MasterRepository = {
    getTableData(tab) {
      if (tab === 'BackupRegistry') {
        return { rows: registryRows };
      }
      return { rows: [] };
    },
    updateRow(tab, index, updates) {
      const row = registryRows.find(r => r._rowIndex === index);
      if (row) Object.assign(row, updates);
    },
    logGlobalAudit(audit) {
      auditLogs.push(audit);
    },
    appendRow() {},
    listWorkspaces() {
      return opts.workspaces || [];
    }
  };

  global.Validation = {
    generateId(p) { return `${p}-${Math.random().toString(36).substring(2, 8)}`; }
  };

  delete require.cache[require.resolve(codePath)];
  const mod = require(codePath);
  return {
    BackupService: mod.BackupService,
    JobService: mod.JobService,
    trashedFiles,
    auditLogs,
    registryRows
  };
}

test('BackupService.pruneOldBackups preserves minimum 3 backups unconditionally', () => {
  // 3 old backups (> 60 days old)
  const rows = [
    { _rowIndex: 2, BackupID: 'BKP-1', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: '2026-01-01T00:00:00.000Z', Status: 'AVAILABLE', BackupFileID: 'F1' },
    { _rowIndex: 3, BackupID: 'BKP-2', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: '2026-01-02T00:00:00.000Z', Status: 'AVAILABLE', BackupFileID: 'F2' },
    { _rowIndex: 4, BackupID: 'BKP-3', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: '2026-01-03T00:00:00.000Z', Status: 'AVAILABLE', BackupFileID: 'F3' }
  ];

  const { BackupService, trashedFiles, auditLogs } = loadService({ registryRows: rows });
  const result = BackupService.pruneOldBackups({ userId: 'SA-1', role: 'SUPER_ADMIN' }, { retentionDays: 30 });

  assert.equal(result.ok, true);
  assert.equal(result.purgedCount, 0);
  assert.equal(trashedFiles.length, 0);
  assert.equal(auditLogs.length, 0);
  assert.equal(rows.every(r => r.Status === 'AVAILABLE'), true);
});

test('BackupService.pruneOldBackups prunes expired backups beyond minRetained floor', () => {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;

  // 5 backups: 3 recent, 2 older than 30 days
  const rows = [
    { _rowIndex: 2, BackupID: 'BKP-1', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: new Date(now - 1 * dayMs).toISOString(), Status: 'AVAILABLE', BackupFileID: 'F1' },
    { _rowIndex: 3, BackupID: 'BKP-2', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: new Date(now - 2 * dayMs).toISOString(), Status: 'AVAILABLE', BackupFileID: 'F2' },
    { _rowIndex: 4, BackupID: 'BKP-3', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: new Date(now - 3 * dayMs).toISOString(), Status: 'AVAILABLE', BackupFileID: 'F3' },
    { _rowIndex: 5, BackupID: 'BKP-4', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: new Date(now - 35 * dayMs).toISOString(), Status: 'AVAILABLE', BackupFileID: 'F4' },
    { _rowIndex: 6, BackupID: 'BKP-5', Scope: 'MASTER', WorkspaceID: 'MASTER', CreatedAt: new Date(now - 45 * dayMs).toISOString(), Status: 'AVAILABLE', BackupFileID: 'F5' }
  ];

  const { BackupService, trashedFiles, auditLogs } = loadService({ registryRows: rows });
  const result = BackupService.pruneOldBackups({ userId: 'SA-1', role: 'SUPER_ADMIN' }, { retentionDays: 30, minRetained: 3 });

  assert.equal(result.ok, true);
  assert.equal(result.purgedCount, 2);
  assert.deepEqual(result.prunedBackupIds, ['BKP-4', 'BKP-5']);
  assert.equal(trashedFiles.length, 2);
  assert.equal(trashedFiles[0].id, 'F4');
  assert.equal(trashedFiles[1].id, 'F5');

  // Verify registry status updated
  assert.equal(rows[3].Status, 'PURGED');
  assert.equal(rows[4].Status, 'PURGED');
  assert.equal(rows[0].Status, 'AVAILABLE');

  // Verify audit logs generated
  assert.equal(auditLogs.length, 2);
  assert.equal(auditLogs[0].Action, 'BACKUP_PURGED');
  assert.equal(auditLogs[0].EntityID, 'BKP-4');
});

test('BackupService.pruneOldBackups prunes backups exceeding maxRetained count threshold', () => {
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;

  // 6 recent backups (all within 5 days), maxRetained set to 4
  const rows = [];
  for (let i = 1; i <= 6; i++) {
    rows.push({
      _rowIndex: i + 1,
      BackupID: `BKP-${i}`,
      Scope: 'MASTER',
      WorkspaceID: 'MASTER',
      CreatedAt: new Date(now - i * dayMs).toISOString(),
      Status: 'AVAILABLE',
      BackupFileID: `F-${i}`
    });
  }

  const { BackupService, trashedFiles } = loadService({ registryRows: rows });
  const result = BackupService.pruneOldBackups(
    { userId: 'SA-1', role: 'SUPER_ADMIN' },
    { retentionDays: 30, maxRetained: 4, minRetained: 3 }
  );

  assert.equal(result.ok, true);
  assert.equal(result.purgedCount, 2); // 5th and 6th pruned
  assert.deepEqual(result.prunedBackupIds, ['BKP-5', 'BKP-6']);
  assert.equal(trashedFiles.length, 2);
});

test('JobService.dispatchBackups executes master + workspace backups and triggers retention pruning', () => {
  const backupsCreated = [];
  const { JobService, BackupService } = loadService({
    workspaces: [{ WorkspaceID: 'WS-1', Status: 'ACTIVE' }]
  });

  BackupService.createBackup = (ctx, wsId) => {
    backupsCreated.push(wsId || 'MASTER');
    return { ok: true, backupId: `BKP-${wsId || 'MASTER'}` };
  };

  let pruned = false;
  BackupService.pruneOldBackups = () => {
    pruned = true;
    return { ok: true, purgedCount: 1 };
  };

  const res = JobService.dispatchBackups();
  assert.equal(res.ok, true);
  assert.deepEqual(backupsCreated, ['MASTER', 'WS-1']);
  assert.equal(pruned, true);
  assert.equal(res.purgedCount, 1);
});

test('backups.prune and jobs.dispatchBackups are step-up protected Super Admin write actions', () => {
  const src = require('fs').readFileSync(codePath, 'utf8');
  assert.match(src, /'backups\.prune':\s*\{\s*authRequired:\s*true,\s*roles:\s*\[CONSTANTS\.ROLES\.SUPER_ADMIN\],\s*isWrite:\s*true\s*\}/);
  assert.match(src, /'jobs\.dispatchBackups':\s*\{\s*authRequired:\s*true,\s*roles:\s*\[CONSTANTS\.ROLES\.SUPER_ADMIN\],\s*isWrite:\s*true\s*\}/);
  assert.match(src, /PRIVILEGED_STEP_UP_ACTIONS[\s\S]*'backups\.prune'/);
  assert.match(src, /PRIVILEGED_STEP_UP_ACTIONS[\s\S]*'jobs\.dispatchBackups'/);
});

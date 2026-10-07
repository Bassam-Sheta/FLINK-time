'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../apps-script/Code.gs'), 'utf8');

function fixture(options = {}) {
  const events = [];
  const audits = [];
  const trashed = [];
  const workspace = { WorkspaceID: 'W1', SpreadsheetID: 'LIVE', Status: 'ACTIVE' };
  let held = false;
  let primaryFailure = false;
  let flushes = 0;
  let workspaceReads = 0;
  let context;
  const lock = {
    hasLock: () => held,
    tryLock() { held = !options.lockFails; return held; },
    releaseLock() { events.push('release'); held = false; }
  };
  const candidate = { getId: () => 'CANDIDATE', setTrashed(value) {
    assert.equal(held, true);
    assert.equal(value, true);
    trashed.push('CANDIDATE'); events.push('trash');
  } };
  context = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush() {
      assert.equal(held, true, 'restore flush must hold the writer lock');
      events.push('flush'); flushes++;
      if (flushes === options.failAtFlush) { primaryFailure = true; throw new Error('synthetic flush failure'); }
    } },
    DriveApp: { getFileById(id) {
      if (id === 'BACKUP') return { makeCopy() { events.push('copy'); return candidate; } };
      assert.equal(id, 'CANDIDATE', 'cleanup must never target the original or backup');
      return candidate;
    } }
  });
  vm.runInContext(source, context);
  Object.assign(context.SecurityService, { verifyPassword: () => true, constantTimeEquals: (a, b) => a === b });
  Object.assign(context.MasterRepository, {
    getCredentials: () => ({ UserID: 'ROOT', PasswordHash: 'SYNTHETIC-HASH' }),
    getWorkspace() {
      workspaceReads++;
      if (options.failRecoveryRead && primaryFailure && workspaceReads > 1) throw new Error('synthetic recovery read failure');
      const cached = this._requestCache['WS:W1'];
      return cached || { ...workspace };
    },
    updateWorkspace(_id, updates) {
      assert.equal(held, true);
      const isRollback = primaryFailure && updates.SpreadsheetID === 'LIVE';
      events.push(isRollback ? 'rollback' : 'update:' + (updates.SpreadsheetID || updates.Status));
      if (isRollback && options.rollbackFails) throw new Error('synthetic rollback failure');
      if (!(isRollback && options.rollbackNoop)) Object.assign(workspace, updates);
      if (!isRollback && options.failAfterQuiesce && updates.Status === 'MAINTENANCE' && !updates.SpreadsheetID) {
        primaryFailure = true; throw new Error('synthetic post-quiesce failure');
      }
      if (!isRollback && options.failAfterPointer && updates.SpreadsheetID === 'CANDIDATE') {
        primaryFailure = true; throw new Error('synthetic post-pointer failure');
      }
      return { ...workspace };
    },
    getWorkspaceAccessForWorkspace: () => [{ UserID: 'WORKER' }],
    logGlobalAudit(record) {
      audits.push(record); events.push('audit:' + record.Action);
      if (options.failAudit === record.Action) { primaryFailure = true; return false; }
      return true;
    },
    logSecurityEvent() {}
  });
  context.WorkspaceRouter.clearCache = () => { events.push('clear-router'); };
  context.SessionService.revokeAllUserSessions = () => {
    events.push('revoke');
    if (options.revokeFails) { primaryFailure = true; throw new Error('synthetic revocation failure'); }
  };
  Object.assign(context.BackupService, {
    validateBackup: () => ({ manifestHash: 'MANIFEST' }),
    _getRegistryRecord: () => ({ BackupID: 'B1', BackupFileID: 'BACKUP' }),
    _createBackupUnlocked: () => ({ backupId: 'SAFETY' }),
    _openBackupSpreadsheet: () => ({ getSheetByName: () => null }),
    _buildManifest: () => ({ manifestHash: 'MANIFEST' }),
    _validateWorkspaceRollupTotals: () => ({ ok: true, rawSeconds: 3600 })
  });
  return { context, events, audits, trashed, workspace, isHeld: () => held,
    run: () => context.BackupService.restoreBackup({ userId: 'ROOT', role: 'SUPER_ADMIN' }, 'W1', 'B1', 'SYNTHETIC-PASSWORD') };
}

test('failed restore preserves a candidate still referenced after rollback failure', () => {
  const fx = fixture({ revokeFails: true, rollbackFails: true });
  let failure;
  try { fx.run(); } catch (err) { failure = err; }
  assert.ok(failure);
  assert.equal(fx.workspace.SpreadsheetID, 'CANDIDATE');
  assert.deepEqual(fx.trashed, [], 'never trash a potentially live candidate');
  assert.equal(failure.details.recoveryRequired, true);
  assert.doesNotMatch(failure.message, /was rolled back|synthetic/);
  assert.equal(fx.isHeld(), false);
});

test('restore checks the durable pointer instead of trusting a successful rollback call', () => {
  const fx = fixture({ revokeFails: true, rollbackNoop: true });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true);
  assert.deepEqual(fx.trashed, []);
  assert.equal(fx.workspace.SpreadsheetID, 'CANDIDATE');
});

test('restore handles a quiesce write that applies before throwing', () => {
  const fx = fixture({ failAfterQuiesce: true });
  assert.throws(fx.run);
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
  assert.ok(fx.events.includes('rollback'));
});

test('restore handles a pointer write that applies before throwing and failed rollback', () => {
  const fx = fixture({ failAfterPointer: true, rollbackFails: true });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true);
  assert.deepEqual(fx.trashed, []);
});

test('successful rollback is flushed and verified before candidate cleanup', () => {
  const fx = fixture({ revokeFails: true });
  assert.throws(fx.run);
  const rollback = fx.events.indexOf('rollback');
  const flush = fx.events.indexOf('flush', rollback);
  assert.ok(rollback >= 0 && flush > rollback && flush < fx.events.indexOf('trash'));
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
  assert.deepEqual(fx.trashed, ['CANDIDATE']);
});

test('restore intent audit failure prevents all workspace pointer/status mutations', () => {
  const fx = fixture({ failAudit: 'RESTORE_INTENT' });
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
  assert.equal(fx.events.some(event => event.startsWith('update:')), false);
});

test('restore completion audit failure rolls back instead of returning success', () => {
  const fx = fixture({ failAudit: 'RESTORE_COMPLETED' });
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
});

test('restore flushes completion audit and ACTIVE pointer before releasing the lock', () => {
  const fx = fixture();
  const result = fx.run();
  assert.equal(result.restoredSpreadsheetId, 'CANDIDATE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
  const intent = fx.events.indexOf('audit:RESTORE_INTENT');
  assert.ok(intent >= 0 && fx.events.indexOf('flush', intent) < fx.events.indexOf('update:MAINTENANCE'));
  const audit = fx.events.indexOf('audit:RESTORE_COMPLETED');
  assert.ok(fx.events.indexOf('flush', audit) > audit);
  assert.equal(fx.events.at(-1), 'release');
  assert.deepEqual(fx.trashed, []);
  assert.doesNotMatch(JSON.stringify(fx.audits), /SYNTHETIC-PASSWORD|SYNTHETIC-HASH/);
});

test('restore does not claim success if final completion flush fails', () => {
  const fx = fixture({ failAtFlush: 3 });
  assert.throws(fx.run);
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
  assert.equal(fx.workspace.Status, 'ACTIVE');
});

test('restore preserves the candidate if rollback flush cannot be confirmed', () => {
  const fx = fixture({ revokeFails: true, failAtFlush: 2 });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true);
  assert.deepEqual(fx.trashed, []);
});

test('restore discards pre-lock workspace snapshots before selecting the rollback target', () => {
  const fx = fixture();
  fx.context.MasterRepository._requestCache['WS:W1'] = { ...fx.workspace, SpreadsheetID: 'STALE' };
  const result = fx.run();
  assert.equal(result.previousSpreadsheetId, 'LIVE');
});

test('restore lock timeout performs no file or workspace mutations', () => {
  const fx = fixture({ lockFails: true });
  assert.throws(fx.run, error => error.code === 'SERVER_BUSY');
  assert.deepEqual(fx.events, []);
});

test('unconfirmed rollback after activation attempts to keep the workspace in maintenance', () => {
  const fx = fixture({ failAudit: 'RESTORE_COMPLETED', rollbackFails: true });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true);
  assert.equal(fx.workspace.SpreadsheetID, 'CANDIDATE');
  assert.equal(fx.workspace.Status, 'MAINTENANCE');
  assert.deepEqual(fx.trashed, []);
});

test('restore preserves candidate when durable recovery reads fail', () => {
  const fx = fixture({ revokeFails: true, failRecoveryRead: true });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true);
  assert.deepEqual(fx.trashed, []);
  assert.equal(fx.isHeld(), false);
});

test('unconfirmed quiesce rollback preserves candidate and reports recovery accurately', () => {
  const fx = fixture({ failAfterQuiesce: true, rollbackFails: true });
  assert.throws(fx.run, error => error.details && error.details.recoveryRequired === true && error.details.candidateDisposition === 'PRESERVED');
  assert.deepEqual(fx.trashed, []);
});

test('candidate cleanup is refused when its audit intent cannot be recorded', () => {
  const fx = fixture({ revokeFails: true, failAudit: 'RESTORE_CANDIDATE_CLEANUP_INTENT' });
  assert.throws(fx.run);
  assert.deepEqual(fx.trashed, []);
  assert.equal(fx.workspace.SpreadsheetID, 'LIVE');
});

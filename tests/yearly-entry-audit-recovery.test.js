'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./helpers/yearly-entry-fixture');
const worker = { userId: 'U1', role: 'USER' };
const manager = { userId: 'MANAGER', role: 'ADMIN' };
// The application runs in a VM realm; audits persist JSON, not object prototypes.
const auditJSON = value => JSON.parse(JSON.stringify(value));

function prepared(options = {}) {
  const fx = fixture(options);
  fx.activate();
  fx.repo.createTimeEntry('W1', fx.entry('SEED'), worker);
  return fx;
}

test('retry repairs an applied append with the original attributable audit pair', () => {
  const fx = prepared();
  fx.controls.failWrite = 'TimeEntries';
  assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('RETRY'), worker));
  const intent = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT');
  fx.controls.failWrite = null;
  fx.repo.createTimeEntry('W1', fx.entry('RETRY'), worker);
  const completed = fx.audits.find(row => row.Action === 'ENTRY_STORAGE_APPEND_COMPLETED' && row.CorrelationID === intent.CorrelationID);
  assert.ok(completed, 'replay must close the original append audit pair, not merely record REPLAY_OBSERVED');
  assert.equal(completed.ActorUserID, 'U1');
  assert.deepEqual(completed.BeforeJSON, intent.BeforeJSON);
  assert.deepEqual(completed.AfterJSON, intent.AfterJSON);
  assert.equal(fx.repo.listTimeEntries('W1').filter(row => row.EntryID === 'RETRY').length, 1);
  assert.equal(fx.controls.locked, false);
});

test('a later writer repairs an applied update without replacing its original actor or Before state', () => {
  const fx = prepared();
  fx.controls.failWrite = 'TimeEntries';
  assert.throws(() => fx.repo.updateTimeEntry('W1', 'SEED', { Description: 'applied update', Version: 2 }, manager));
  const intent = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_UPDATE_INTENT');
  fx.controls.failWrite = null;
  fx.repo.createTimeEntry('W1', fx.entry('NEXT'), worker);
  const completed = fx.audits.find(row => row.Action === 'ENTRY_STORAGE_UPDATE_COMPLETED' && row.CorrelationID === intent.CorrelationID);
  assert.ok(completed, 'next mutation must repair the prior update before overwriting recovery evidence');
  assert.equal(completed.ActorUserID, 'MANAGER');
  assert.equal(completed.ActorRole, 'ADMIN');
  assert.equal(completed.BeforeJSON.Description, '');
  assert.equal(completed.AfterJSON.Description, 'applied update');
  assert.equal(fx.repo.getEntry('W1', 'SEED').Version, 2);
  assert.ok(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_RECOVERY_COMPLETED' && row.ActorUserID === 'U1' && row.CorrelationID === intent.CorrelationID));
});

test('uncertain pending data cannot become a published backup before audit recovery', () => {
  const fx = prepared();
  fx.controls.failWrite = 'TimeEntries';
  assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('UNCERTAIN'), worker));
  fx.controls.failWrite = null;
  assert.throws(() => fx.context.BackupService.createBackup({ userId: 'ROOT', role: 'SUPER_ADMIN' }, 'W1'), error => error.code === 'CONFLICT');
  assert.equal(fx.controls.copies, 0, 'reject before creating any snapshot files');
  assert.equal(fx.backups.length, 0);
  assert.equal(fx.controls.locked, false);
});

function checkpoint(fx) {
  return fx.core.getSheetByName('EntryMutationCheckpoint');
}

function pending(fx) {
  return JSON.parse(checkpoint(fx).values[1][2]).pending;
}

function interceptWrite(sheet, intercept) {
  const getRange = sheet.getRange;
  sheet.getRange = (...args) => {
    const range = getRange(...args);
    const set = range.setValues;
    range.setValues = data => intercept(data, () => set(data));
    return range;
  };
  return () => { sheet.getRange = getRange; };
}

function interrupt(fx, action = 'APPEND') {
  fx.controls.failWrite = 'TimeEntries';
  assert.throws(() => action === 'APPEND'
    ? fx.repo.createTimeEntry('W1', fx.entry('PENDING'), manager)
    : fx.repo.updateTimeEntry('W1', 'SEED', { Description: 'pending', Version: 2 }, manager));
  fx.controls.failWrite = null;
  return fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_' + action + '_INTENT');
}

test('unapplied append and update close with NOT_APPLIED, never replaying the planned data', () => {
  for (const action of ['APPEND', 'UPDATE']) {
    const fx = prepared();
    const tab = fx.books.get(fx.repo.getEntry('W1', 'SEED')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
    const restore = interceptWrite(tab, () => { throw new Error('Write refused before applying'); });
    assert.throws(() => action === 'APPEND'
      ? fx.repo.createTimeEntry('W1', fx.entry('REFUSED'), manager)
      : fx.repo.updateTimeEntry('W1', 'SEED', { Description: 'not applied', Version: 2 }, manager));
    restore();
    const original = pending(fx);
    const result = fx.context.recoverYearlyEntryMutation_('W1');
    assert.equal(result.outcome, 'NOT_APPLIED');
    const terminal = fx.audits.find(row => row.Action === 'ENTRY_STORAGE_' + action + '_NOT_APPLIED' && row.CorrelationID === original.operationId);
    assert.ok(terminal);
    assert.equal(terminal.ActorUserID, 'MANAGER');
    assert.deepEqual(auditJSON(terminal.AfterJSON), original.before);
    assert.equal(fx.repo.getEntry('W1', 'REFUSED'), null);
    assert.equal(fx.repo.getEntry('W1', 'SEED').Description, '');
    assert.equal(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_' + action + '_COMPLETED' && row.CorrelationID === original.operationId), false);
    assert.equal(pending(fx), null);
  }
});

test('a failed original intent audit can be absent or uncertain without allowing an unaudited write', () => {
  for (const appliedAudit of [false, true]) {
    const fx = prepared();
    const log = fx.context.MasterRepository.logGlobalAudit;
    fx.context.MasterRepository.logGlobalAudit = row => {
      if (row.Action === 'ENTRY_STORAGE_APPEND_INTENT') {
        if (appliedAudit) log(row);
        return false;
      }
      return log(row);
    };
    assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('NO-WRITE'), worker), error => error.code === 'CRYPTO_FAILURE');
    const original = pending(fx);
    assert.equal(fx.repo.getEntry('W1', 'NO-WRITE'), null);
    fx.context.MasterRepository.logGlobalAudit = log;
    assert.equal(fx.context.recoverYearlyEntryMutation_('W1').outcome, 'NOT_APPLIED');
    assert.ok(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT' && row.CorrelationID === original.operationId));
    assert.ok(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_APPEND_NOT_APPLIED' && row.CorrelationID === original.operationId));
    fx.repo.createTimeEntry('W1', fx.entry('NO-WRITE'), worker);
    const newIntent = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT');
    assert.notEqual(newIntent.CorrelationID, original.operationId, 'separate attempts with the same EntryID need distinct operations');
  }
});

test('failed completion audits and data flushes recover the signed Before/After pair', () => {
  for (const action of ['APPEND', 'UPDATE']) for (const failure of ['audit-absent', 'audit-uncertain', 'data-flush']) {
    const fx = prepared();
    const log = fx.context.MasterRepository.logGlobalAudit;
    let restore = () => {};
    if (failure === 'data-flush') {
      const tab = fx.books.get(fx.repo.getEntry('W1', 'SEED')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
      restore = interceptWrite(tab, (_data, apply) => { apply(); fx.controls.failFlush = true; });
    } else {
      fx.context.MasterRepository.logGlobalAudit = row => {
        if (row.Action === 'ENTRY_STORAGE_' + action + '_COMPLETED') {
          if (failure === 'audit-uncertain') log(row);
          return false;
        }
        return log(row);
      };
    }
    assert.throws(() => action === 'APPEND'
      ? fx.repo.createTimeEntry('W1', fx.entry('APPLIED'), manager)
      : fx.repo.updateTimeEntry('W1', 'SEED', { DurationSeconds: 7200, Version: 2 }, manager));
    assert.equal(fx.controls.locked, false);
    const original = pending(fx);
    restore();
    fx.controls.failFlush = false;
    fx.context.MasterRepository.logGlobalAudit = log;
    // No request-local table or row cache is a recovery source of truth.
    fx.repo.beginRequest();
    fx.context.MasterRepository._requestCache = {};
    assert.equal(fx.context.recoverYearlyEntryMutation_('W1').outcome, 'COMPLETED');
    const completed = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_' + action + '_COMPLETED' && row.CorrelationID === original.operationId);
    assert.deepEqual(auditJSON(completed.BeforeJSON), original.before);
    assert.deepEqual(auditJSON(completed.AfterJSON), original.after);
    assert.equal(completed.ActorUserID, 'MANAGER');
    assert.equal(pending(fx), null);
    const auditCount = fx.audits.length;
    assert.equal(fx.context.recoverYearlyEntryMutation_('W1').recovered, false);
    assert.equal(fx.audits.length, auditCount, 'idle recovery does not emit another pair');
  }
});

test('checkpoint write uncertainty retains recoverable evidence without writing data early', () => {
  for (const applied of [false, true]) {
    const fx = prepared();
    const restore = interceptWrite(checkpoint(fx), (data, apply) => {
      if (JSON.parse(data[0][2]).pending) {
        if (applied) apply();
        throw new Error('Checkpoint persistence uncertain');
      }
      apply();
    });
    const count = fx.audits.length;
    assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('EARLY'), worker));
    restore();
    assert.equal(fx.repo.getEntry('W1', 'EARLY'), null);
    assert.equal(fx.audits.slice(count).some(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT'), false);
    assert.equal(!!pending(fx), applied);
    assert.equal(fx.context.recoverYearlyEntryMutation_('W1').recovered, applied);
    assert.equal(pending(fx), null);
  }
});

test('failed terminal checkpoint writes preserve completed audit evidence and safe idempotent recovery', () => {
  for (const applied of [false, true]) {
    const fx = prepared();
    const restore = interceptWrite(checkpoint(fx), (data, apply) => {
      if (JSON.parse(data[0][2]).pending === null) {
        if (applied) apply();
        throw new Error('Clearing checkpoint uncertain');
      }
      apply();
    });
    assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('DONE'), worker));
    restore();
    const intent = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT');
    assert.ok(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_APPEND_COMPLETED' && row.CorrelationID === intent.CorrelationID));
    assert.equal(fx.repo.getEntry('W1', 'DONE').EntryID, 'DONE');
    fx.context.recoverYearlyEntryMutation_('W1');
    fx.repo.createTimeEntry('W1', fx.entry('DONE'), worker);
    assert.equal(fx.repo.listTimeEntries('W1').filter(row => row.EntryID === 'DONE').length, 1);
    assert.equal(pending(fx), null);
  }
});

test('every failed recovery audit retains the original operation and blocks a later entry write', () => {
  for (const failure of ['ENTRY_STORAGE_RECOVERY_INTENT', 'ENTRY_STORAGE_APPEND_INTENT', 'ENTRY_STORAGE_APPEND_COMPLETED', 'ENTRY_STORAGE_RECOVERY_COMPLETED']) {
    const fx = prepared();
    interrupt(fx);
    const original = pending(fx);
    const log = fx.context.MasterRepository.logGlobalAudit;
    fx.context.MasterRepository.logGlobalAudit = row => row.Action === failure ? false : log(row);
    assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('BLOCKED'), worker), error => error.code === 'CRYPTO_FAILURE');
    assert.deepEqual(pending(fx), original);
    assert.equal(fx.repo.getEntry('W1', 'BLOCKED'), null);
    assert.equal(fx.controls.locked, false);
    fx.context.MasterRepository.logGlobalAudit = log;
    fx.repo.createTimeEntry('W1', fx.entry('UNBLOCKED'), worker);
    assert.equal(pending(fx), null);
  }
});

test('a row matching neither signed snapshot blocks writes, backups and owner recovery without rollback', () => {
  const fx = prepared();
  interrupt(fx, 'UPDATE');
  const original = pending(fx);
  const current = fx.repo.getEntry('W1', 'SEED');
  const tab = fx.books.get(current._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  tab.values[current._rowIndex.rowIndex - 1][fx.context.WORKSPACE_SCHEMA.TimeEntries.indexOf('Version')] = 7;
  const auditCount = fx.audits.length;
  assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'CONFLICT');
  assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('BLOCKED'), worker), error => error.code === 'CONFLICT');
  assert.throws(() => fx.context.BackupService.createBackup({ userId: 'ROOT', role: 'SUPER_ADMIN' }, 'W1'), error => error.code === 'CONFLICT');
  assert.deepEqual(pending(fx), original);
  assert.equal(fx.repo.getEntry('W1', 'SEED').Version, 7, 'never roll back a mismatching row');
  assert.equal(fx.audits.length, auditCount);
  assert.equal(fx.controls.copies, 0);
  assert.equal(fx.controls.locked, false);
});

test('signed checkpoint tampering, missing evidence and ambiguous rows never trigger silent initialization', () => {
  for (const tamper of ['missing', 'header-only', 'extra-row', 'header', 'workspace', 'core', 'payload', 'hash']) {
    const fx = prepared();
    interrupt(fx);
    const tab = checkpoint(fx);
    if (tamper === 'missing') fx.core.tabs.delete('EntryMutationCheckpoint');
    else if (tamper === 'header-only') tab.values.splice(1);
    else if (tamper === 'extra-row') tab.values.push([...tab.values[1]]);
    else if (tamper === 'header') tab.values[0][0] = 'Unrecognized';
    else tab.values[1][{ workspace: 0, core: 1, payload: 2, hash: 3 }[tamper]] = 'TAMPERED';
    const values = JSON.stringify(tab.values);
    const count = fx.audits.length;
    assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('FORBIDDEN'), worker), error => error.code === 'CONFLICT');
    assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'CONFLICT');
    assert.throws(() => fx.activate(), error => error.code === 'CONFLICT');
    assert.equal(JSON.stringify(tab.values), values, 'do not overwrite uncertain or unfamiliar evidence');
    assert.equal(fx.audits.length, count);
    assert.equal(fx.repo.getEntry('W1', 'FORBIDDEN'), null);
  }
});

test('recovery locates the immutable entry after physical row movement', () => {
  const fx = prepared();
  interrupt(fx);
  const original = pending(fx);
  const row = fx.repo.getEntry('W1', 'PENDING');
  const tab = fx.books.get(row._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  tab.values.splice(1, 1);
  assert.equal(fx.context.recoverYearlyEntryMutation_('W1').outcome, 'COMPLETED');
  assert.equal(fx.repo.getEntry('W1', 'PENDING')._rowIndex.rowIndex, 2);
  const completed = fx.audits.find(row => row.Action === 'ENTRY_STORAGE_APPEND_COMPLETED' && row.CorrelationID === original.operationId);
  assert.deepEqual(auditJSON(completed.AfterJSON), original.after, 'audit retains the original snapshot and cohort');
});

test('owner-only recovery rechecks authority after waiting; actorless writers cannot trigger repair', () => {
  const fx = prepared();
  interrupt(fx);
  const original = pending(fx);
  const count = fx.audits.length;
  fx.controls.owner = false;
  assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'UNAUTHORIZED');
  assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('NO-ACTOR')), error => error.code === 'CONFLICT');
  fx.controls.owner = true;
  fx.controls.onLock = () => { fx.controls.owner = false; };
  assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'UNAUTHORIZED');
  fx.controls.onLock = null;
  fx.controls.owner = true;
  assert.deepEqual(pending(fx), original);
  assert.equal(fx.audits.length, count);
  fx.context.recoverYearlyEntryMutation_('W1');
  const recovery = fx.audits.findLast(row => row.Action === 'ENTRY_STORAGE_RECOVERY_COMPLETED');
  assert.equal(recovery.ActorUserID, 'owner@example.test');
  assert.equal(recovery.ActorRole, 'INSTALLATION_OWNER');
  assert.equal(recovery.AfterJSON.mutationActor.userId, 'MANAGER');
});

test('recovery respects unavailable and caller-owned writer locks', () => {
  const fx = prepared();
  interrupt(fx);
  const original = pending(fx);
  fx.controls.lockUnavailable = true;
  assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'SERVER_BUSY');
  assert.deepEqual(pending(fx), original);
  fx.controls.lockUnavailable = false;
  fx.lock.tryLock();
  fx.context.recoverYearlyEntryMutation_('W1');
  assert.equal(fx.controls.locked, true, 'nested recovery must retain the caller lock');
  fx.lock.releaseLock();
});

test('the checkpoint has constant rows and bounded reads, never a growing repair-log scan', () => {
  const fx = prepared();
  const tab = checkpoint(fx);
  const getRange = tab.getRange;
  const reads = [];
  tab.getRange = (...args) => {
    const range = getRange(...args), get = range.getValues;
    range.getValues = () => { reads.push(args); return get(); };
    return range;
  };
  tab.getDataRange = () => { throw new Error('Unbounded checkpoint read'); };
  for (let i = 0; i < 10; i++) fx.repo.updateTimeEntry('W1', 'SEED', { Description: 'revision ' + i }, worker);
  assert.equal(tab.getLastRow(), 2);
  assert.equal(tab.getMaxRows(), 2);
  assert.equal(tab.getMaxColumns(), 4);
  assert.ok(reads.length);
  assert.ok(reads.every(([r, c, n, w]) => r <= 2 && c === 1 && n === 1 && w === 4));
});

test('oversized recovery payloads fail before the entry intent/data write without replacing idle evidence', () => {
  const fx = prepared();
  const previous = JSON.stringify(checkpoint(fx).values);
  const count = fx.audits.length;
  assert.throws(() => fx.repo.createTimeEntry('W1', { ...fx.entry('OVERSIZED'), Description: 'X'.repeat(45001) }, worker), error => error.code === 'CONFLICT');
  assert.equal(JSON.stringify(checkpoint(fx).values), previous);
  assert.equal(fx.repo.getEntry('W1', 'OVERSIZED'), null);
  assert.equal(fx.audits.slice(count).some(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT'), false);
});

test('backup/restore authenticate and rebind idle mutation checkpoints and permit new routed writes', () => {
  const fx = prepared();
  interrupt(fx);
  fx.context.recoverYearlyEntryMutation_('W1');
  const root = { userId: 'ROOT', role: 'SUPER_ADMIN' };
  // Direct repository fixtures bypass application rollup updates. Supply the
  // independently known two one-hour totals required by restore validation.
  fx.lock.tryLock();
  for (const name of ['DailyRollups', 'WeeklyRollups', 'MonthlyRollups']) {
    fx.core.getSheetByName(name).appendRow(Array.from(fx.context.WORKSPACE_SCHEMA[name], key => key === 'TotalSeconds' ? 7200 : ''));
  }
  fx.lock.releaseLock();
  const backup = fx.context.BackupService.createBackup(root, 'W1');
  const snapshot = fx.books.get(backup.backupFileId).getSheetByName('EntryMutationCheckpoint');
  assert.equal(snapshot.values[1][1], backup.backupFileId);
  assert.equal(JSON.parse(snapshot.values[1][2]).pending, null);
  assert.ok(JSON.parse(fx.backups[0].ChecksumMetadata).sheets.some(sheet => sheet.name === 'EntryMutationCheckpoint'));
  const restored = fx.context.BackupService.restoreBackup(root, 'W1', backup.backupId, 'SYNTHETIC-PASSWORD');
  const restoredTab = fx.books.get(restored.restoredSpreadsheetId).getSheetByName('EntryMutationCheckpoint');
  assert.equal(restoredTab.values[1][1], restored.restoredSpreadsheetId);
  fx.repo.createTimeEntry('W1', fx.entry('AFTER-RESTORE'), worker);
  assert.equal(fx.repo.getEntry('W1', 'AFTER-RESTORE')._rowIndex.coreSpreadsheetId, restored.restoredSpreadsheetId);
});

test('Stop retry repairs an interrupted entry audit before acknowledging timer finalization', () => {
  for (const timerStillPresent of [true, false]) {
    const fx = prepared({ now: '2026-01-01T10:00:00Z' });
    fx.context.AuthorizationService.assertWorkspaceAccess = () => {};
    fx.context.TrackingPolicyService.validateTrackingContext = () => ({ projectId: '', taskId: '', description: 'Synthetic', tagIdsCsv: '', billable: false });
    fx.context.TimezoneService.formatDateKey = (_ws, date) => new Date(date).toISOString().slice(0, 10);
    fx.context.RollupService.recordTimeEntry = () => {};
    fx.repo.logWorkspaceAudit = () => true;
    fx.lock.tryLock();
    fx.repo.createActiveTimer('W1', { TimerID: 'TMR-REPAIR', UserID: 'U1', StartedAtUTC: '2026-01-01T09:00:00Z', Source: 'WEB' });
    fx.lock.releaseLock();
    fx.controls.failWrite = 'TimeEntries';
    assert.throws(() => fx.context.TimerService.stopTimer(worker, 'W1', { timerId: 'TMR-REPAIR' }));
    fx.controls.failWrite = null;
    const original = pending(fx);
    if (!timerStillPresent) {
      fx.lock.tryLock();
      fx.repo.deleteActiveTimer('W1', 'U1');
      fx.lock.releaseLock();
    }
    fx.context.TimerService.stopTimer(worker, 'W1', { timerId: 'TMR-REPAIR' });
    assert.ok(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_APPEND_COMPLETED' && row.CorrelationID === original.operationId), 'timer repair/replay must not skip pending entry audit repair');
    assert.equal(pending(fx), null);
    assert.equal(fx.repo.getActiveTimer('W1', 'U1'), null);
    const entry = fx.repo.getEntry('W1', original.after.EntryID);
    assert.equal(entry.DurationSeconds, 3600);
    assert.equal(entry.ApprovalStatus, 'OPEN');
    assert.equal(entry.Locked, false);
    assert.equal(fx.repo.listTimeEntries('W1').filter(row => row.EntryID === entry.EntryID).length, 1);
  }
});

test('unconfirmed data readback never returns success or a completion audit', () => {
  const fx = prepared();
  const tab = fx.books.get(fx.repo.getEntry('W1', 'SEED')._rowIndex.spreadsheetId).getSheetByName('TimeEntries');
  const restore = interceptWrite(tab, () => {});
  assert.throws(() => fx.repo.updateTimeEntry('W1', 'SEED', { Description: 'not persisted' }, worker), error => error.code === 'CONFLICT');
  restore();
  const original = pending(fx);
  assert.equal(fx.audits.some(row => row.Action === 'ENTRY_STORAGE_UPDATE_COMPLETED' && row.CorrelationID === original.operationId), false);
  assert.equal(fx.context.recoverYearlyEntryMutation_('W1').outcome, 'NOT_APPLIED');
  assert.equal(fx.repo.getEntry('W1', 'SEED').Description, '');
});

test('corrupted checkpoint readback blocks entry data/intent and retains evidence for reconciliation', () => {
  const fx = prepared();
  const tab = checkpoint(fx);
  const restore = interceptWrite(tab, (data, apply) => {
    apply();
    if (JSON.parse(data[0][2]).pending) tab.values[1][3] = '0'.repeat(64);
  });
  const count = fx.audits.length;
  assert.throws(() => fx.repo.createTimeEntry('W1', fx.entry('UNVERIFIED'), worker), error => error.code === 'CONFLICT');
  restore();
  assert.equal(fx.repo.getEntry('W1', 'UNVERIFIED'), null);
  assert.equal(fx.audits.slice(count).some(row => row.Action === 'ENTRY_STORAGE_APPEND_INTENT'), false);
  assert.throws(() => fx.context.recoverYearlyEntryMutation_('W1'), error => error.code === 'CONFLICT');
  assert.equal(tab.values[1][3], '0'.repeat(64));
  assert.equal(fx.controls.locked, false);
});

test('interrupted initial checkpoint setup retries only before activation and never recreates Data files', () => {
  for (const stage of ['headers', 'idle']) {
    const fx = fixture();
    const insert = fx.core.insertSheet;
    fx.core.insertSheet = name => {
      const tab = insert(name);
      if (name === 'EntryMutationCheckpoint') {
        interceptWrite(tab, (data, apply) => {
          apply();
          if (!fx.controls.checkpointFailure && (stage === 'headers' ? data[0][0] === 'WorkspaceID' : data[0][0] === 'W1')) {
            fx.controls.checkpointFailure = true;
            throw new Error('Applied checkpoint initialization failed');
          }
        });
      }
      return tab;
    };
    assert.throws(() => fx.activate());
    assert.equal(fx.workspace.PartitionPolicy, '');
    fx.activate();
    assert.equal(fx.workspace.PartitionPolicy, 'YEARLY_ENTRIES_V1');
    assert.equal(pending(fx), null);
    assert.equal(fx.books.size, 2, 'owner activation creates no Data file');
    fx.repo.createTimeEntry('W1', fx.entry('READY'), worker);
    assert.equal(fx.repo.getEntry('W1', 'READY').EntryID, 'READY');
  }
});

test('copied checkpoint corruption cannot be published or restored', () => {
  const root = { userId: 'ROOT', role: 'SUPER_ADMIN' };
  for (const phase of ['copy', 'stored']) {
    const fx = prepared();
    if (phase === 'copy') {
      fx.controls.onCopy = book => {
        const tab = book.getSheetByName('EntryMutationCheckpoint');
        if (tab) tab.values[1][2] = '{"owner":"other@example.test","pending":null}';
      };
      assert.throws(() => fx.context.BackupService.createBackup(root, 'W1'), error => error.code === 'CRYPTO_FAILURE');
      assert.equal(fx.backups.some(row => row.Status === 'AVAILABLE'), false);
    } else {
      const backup = fx.context.BackupService.createBackup(root, 'W1');
      fx.books.get(backup.backupFileId).getSheetByName('EntryMutationCheckpoint').values[1][1] = 'FOREIGN-CORE';
      assert.throws(() => fx.context.BackupService.restoreBackup(root, 'W1', backup.backupId, 'SYNTHETIC-PASSWORD'), error => error.code === 'CONFLICT');
    }
    assert.equal(fx.workspace.SpreadsheetID, 'CORE-1');
    assert.equal([...fx.files.values()].some(file => file.trashed), false);
    assert.equal(fx.controls.locked, false);
  }
});

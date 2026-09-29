'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function baseGlobals(repoOverrides = {}, trackingOverrides = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    ENTRY_LOCKED: 'ENTRY_LOCKED',
    CONFLICT: 'CONFLICT'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    TIMESHEET_STATUS: { OPEN: 'OPEN', SUBMITTED: 'SUBMITTED', APPROVED: 'APPROVED' }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRecordOwnership() {}
  };
  global.Validation = {
    assertRecordVersion(record, expectedVersion) {
      const current = parseInt(record.Version, 10) || 1;
      const expected = parseInt(expectedVersion, 10);
      if (current !== expected) {
        throw new AppError('CONFLICT', 'stale version', 409);
      }
    }
  };
  global.LockService = {
    getScriptLock() {
      return { tryLock() { return true; }, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.RollupService = { rebuildRollups() {} };
  global.TrackingPolicyService = {
    assertEntryEditableByAge() {},
    validateTrackingContext() {
      return {
        projectId: 'P2',
        taskId: 'T2',
        billable: true,
        project: { HourlyRate: 200, CostRate: 80 }
      };
    },
    ...trackingOverrides
  };
  global.SheetRepository = repoOverrides;
}

function loadService(repoOverrides, trackingOverrides) {
  baseGlobals(repoOverrides, trackingOverrides);
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).TimeEntryService;
}

function entry(id, projectId = 'P1') {
  return {
    EntryID: id,
    UserID: 'U1',
    ProjectID: projectId,
    TaskID: 'T1',
    Description: 'work',
    Tags: '',
    Billable: true,
    HourlyRateSnapshot: 100,
    CostRateSnapshot: 40,
    Status: 'ACTIVE',
    ApprovalStatus: 'OPEN',
    Locked: false,
    Version: 1,
    UpdatedAt: 'old',
    UpdatedBy: 'U1',
    DeletedAt: '',
    DeletedBy: ''
  };
}

test('bulk CHANGE_PROJECT validates all entries before any write', () => {
  const writes = [];
  const entries = { E1: entry('E1'), E2: entry('E2') };

  const svc = loadService(
    {
      getEntry(_ws, id) { return entries[id]; },
      updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
    },
    {
      validateTrackingContext(_auth, _ws, payload) {
        if (payload.description === 'bad') {
          throw new AppError('VALIDATION_ERROR', 'invalid target task', 400);
        }
        return {
          projectId: 'P2',
          taskId: 'T2',
          billable: true,
          project: { HourlyRate: 200, CostRate: 80 }
        };
      }
    }
  );

  entries.E2.Description = 'bad';

  assert.throws(
    () => svc.bulkAction(
      { userId: 'U1', role: 'USER' },
      'W1',
      ['E1', 'E2'],
      'CHANGE_PROJECT',
      { projectId: 'P2', taskId: 'T2', expectedVersions: { E1: 1, E2: 1 } }
    ),
    /invalid target task/
  );
  assert.deepEqual(writes, []);
});

test('bulk CHANGE_PROJECT refreshes rate snapshots from target project', () => {
  const writes = [];
  const entries = { E1: entry('E1') };

  const svc = loadService({
    getEntry(_ws, id) { return entries[id]; },
    updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
  });

  const affected = svc.bulkAction(
    { userId: 'U1', role: 'USER' },
    'W1',
    ['E1'],
    'CHANGE_PROJECT',
    { projectId: 'P2', taskId: 'T2', expectedVersions: { E1: 1 } }
  );

  assert.equal(affected, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].updates.ProjectID, 'P2');
  assert.equal(writes[0].updates.TaskID, 'T2');
  assert.equal(writes[0].updates.HourlyRateSnapshot, 200);
  assert.equal(writes[0].updates.CostRateSnapshot, 80);
});

test('bulk CHANGE_PROJECT rolls back earlier writes when a later write fails', () => {
  const writes = [];
  const entries = { E1: entry('E1'), E2: entry('E2') };
  let failed = false;

  const svc = loadService({
    getEntry(_ws, id) { return entries[id]; },
    updateTimeEntry(_ws, id, updates) {
      writes.push({ id, updates: { ...updates } });
      if (id === 'E2' && updates.ProjectID === 'P2' && !failed) {
        failed = true;
        throw new Error('simulated sheet write failure');
      }
    }
  });

  assert.throws(
    () => svc.bulkAction(
      { userId: 'U1', role: 'USER' },
      'W1',
      ['E1', 'E2'],
      'CHANGE_PROJECT',
      { projectId: 'P2', taskId: 'T2', expectedVersions: { E1: 1, E2: 1 } }
    ),
    /simulated sheet write failure/
  );

  assert.equal(
    writes.some(w =>
      w.id === 'E1' &&
      w.updates.ProjectID === 'P1' &&
      w.updates.TaskID === 'T1' &&
      w.updates.HourlyRateSnapshot === 100 &&
      w.updates.CostRateSnapshot === 40 &&
      w.updates.Version === 1
    ),
    true
  );
});


test('bulk action rejects duplicate entry IDs before any write', () => {
  const writes = [];
  const entries = { E1: entry('E1') };
  const svc = loadService({
    getEntry(_ws, id) { return entries[id]; },
    updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
  });

  assert.throws(
    () => svc.bulkAction(
      { userId:'U1', role:'USER' },
      'W1',
      ['E1', 'E1'],
      'DELETE',
      { expectedVersions:{ E1:1 } }
    ),
    /must not contain duplicates/
  );
  assert.deepEqual(writes, []);
});

test('stale version aborts the entire bulk batch before any write', () => {
  const writes = [];
  const entries = { E1: entry('E1'), E2: entry('E2') };
  entries.E2.Version = 2;

  const svc = loadService({
    getEntry(_ws, id) { return entries[id]; },
    updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
  });

  assert.throws(
    () => svc.bulkAction(
      { userId:'U1', role:'USER' },
      'W1',
      ['E1','E2'],
      'DELETE',
      { expectedVersions:{ E1:1, E2:1 } }
    ),
    /stale version/
  );
  assert.deepEqual(writes, []);
});

test('bulk UNLOCK can unlock an ordinary locked OPEN entry', () => {
  const writes = [];
  const entries = { E1: entry('E1') };
  entries.E1.Locked = true;

  const svc = loadService({
    getEntry(_ws, id) { return entries[id]; },
    updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
  });

  const affected = svc.bulkAction(
    { userId:'A1', role:'ADMIN' },
    'W1',
    ['E1'],
    'UNLOCK',
    { expectedVersions:{ E1:1 } }
  );

  assert.equal(affected, 1);
  assert.equal(writes[0].updates.Locked, false);
  assert.equal(writes[0].updates.Version, 2);
});

test('bulk CHANGE_PROJECT to same project preserves historical rate snapshots', () => {
  const writes = [];
  const entries = { E1: entry('E1') };

  const svc = loadService(
    {
      getEntry(_ws, id) { return entries[id]; },
      updateTimeEntry(_ws, id, updates) { writes.push({ id, updates }); }
    },
    {
      validateTrackingContext() {
        return {
          projectId:'P1',
          taskId:'T2',
          billable:true,
          project:{ HourlyRate:999, CostRate:888 }
        };
      }
    }
  );

  svc.bulkAction(
    { userId:'U1', role:'USER' },
    'W1',
    ['E1'],
    'CHANGE_PROJECT',
    { projectId:'P1', taskId:'T2', expectedVersions:{ E1:1 } }
  );

  assert.equal(writes[0].updates.HourlyRateSnapshot, 100);
  assert.equal(writes[0].updates.CostRateSnapshot, 40);
});

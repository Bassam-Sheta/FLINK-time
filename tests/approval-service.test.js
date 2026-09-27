'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/ApprovalService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function installBaseGlobals(overrides = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    SERVER_BUSY: 'SERVER_BUSY'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    TIMESHEET_STATUS: {
      OPEN: 'OPEN',
      SUBMITTED: 'SUBMITTED',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED'
    },
    AUDIT_EVENTS: {
      TIMESHEET_APPROVED: 'TIMESHEET_APPROVED',
      TIMESHEET_REJECTED: 'TIMESHEET_REJECTED',
      TIMESHEET_REOPENED: 'TIMESHEET_REOPENED'
    }
  };
  global.Validation = {
    sanitizeCellValue(value) { return String(value); },
    generateId(prefix) { return prefix + '-TEST'; }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole() {}
  };
  global.SpreadsheetApp = { flush() {} };
  global.LockService = {
    getScriptLock() {
      return {
        tryLock() { return true; },
        releaseLock() {}
      };
    }
  };
  Object.assign(global, overrides);
}

function loadService(overrides = {}) {
  installBaseGlobals(overrides);
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).ApprovalService;
}

function submittedTimesheet() {
  return {
    TimesheetID: 'TMS-1',
    UserID: 'USR-1',
    Status: 'SUBMITTED',
    PeriodStart: '2026-09-20T00:00:00.000Z',
    PeriodEnd: '2026-09-26T23:59:59.999Z',
    TotalSeconds: 7200,
    EntrySnapshotJSON: JSON.stringify([
      { entryId: 'E1', version: 1, durationSeconds: 3600 },
      { entryId: 'E2', version: 1, durationSeconds: 3600 }
    ])
  };
}

function submittedEntry(id) {
  return {
    EntryID: id,
    TimesheetID: 'TMS-1',
    ApprovalStatus: 'SUBMITTED',
    Locked: true,
    Version: 1,
    DurationSeconds: 3600
  };
}

test('approve validates immutable membership before changing timesheet header', () => {
  const calls = [];
  const timesheet = submittedTimesheet();
  const entries = { E1: submittedEntry('E1') };

  const ApprovalService = loadService({
    SheetRepository: {
      getTimesheet() { return timesheet; },
      getEntry(_ws, id) { return entries[id] || null; },
      updateTimeEntry() { calls.push('entry-update'); },
      updateTimesheet() { calls.push('timesheet-update'); },
      logApproval() {},
      logWorkspaceAudit() {}
    }
  });

  assert.throws(
    () => ApprovalService.approveTimesheet(
      { userId: 'A1', role: 'ADMIN' }, 'W1', 'TMS-1', 'ok'
    ),
    /Submitted entry E2 no longer exists/
  );

  assert.deepEqual(calls, []);
});

test('approve rolls back earlier entry mutations when a later entry write fails', () => {
  const calls = [];
  const timesheet = submittedTimesheet();
  const entries = { E1: submittedEntry('E1'), E2: submittedEntry('E2') };
  let e2Attempts = 0;

  const ApprovalService = loadService({
    SheetRepository: {
      getTimesheet() { return timesheet; },
      getEntry(_ws, id) { return entries[id]; },
      updateTimeEntry(_ws, id, updates) {
        calls.push({ type: 'entry', id, updates: { ...updates } });
        if (id === 'E2' && updates.ApprovalStatus === 'APPROVED' && e2Attempts++ === 0) {
          throw new Error('simulated write failure');
        }
      },
      updateTimesheet() {
        calls.push({ type: 'timesheet' });
        return {};
      },
      logApproval() {},
      logWorkspaceAudit() {}
    }
  });

  assert.throws(
    () => ApprovalService.approveTimesheet(
      { userId: 'A1', role: 'ADMIN' }, 'W1', 'TMS-1', 'ok'
    ),
    /simulated write failure/
  );

  assert.equal(calls.some(c => c.type === 'timesheet'), false);
  assert.equal(
    calls.some(c =>
      c.type === 'entry' &&
      c.id === 'E1' &&
      c.updates.ApprovalStatus === 'SUBMITTED' &&
      c.updates.Locked === true
    ),
    true
  );
});

test('approve commits timesheet header only after all entries are approved', () => {
  const order = [];
  const timesheet = submittedTimesheet();
  const entries = { E1: submittedEntry('E1'), E2: submittedEntry('E2') };

  const ApprovalService = loadService({
    SheetRepository: {
      getTimesheet() { return timesheet; },
      getEntry(_ws, id) { return entries[id]; },
      updateTimeEntry(_ws, id, updates) {
        order.push('entry:' + id + ':' + updates.ApprovalStatus);
      },
      updateTimesheet(_ws, id, updates) {
        order.push('timesheet:' + updates.Status);
        return { ...timesheet, ...updates };
      },
      logApproval() {},
      logWorkspaceAudit() {}
    }
  });

  const result = ApprovalService.approveTimesheet(
    { userId: 'A1', role: 'ADMIN' }, 'W1', 'TMS-1', 'ok'
  );

  assert.equal(result.Status, 'APPROVED');
  assert.deepEqual(order, [
    'entry:E1:APPROVED',
    'entry:E2:APPROVED',
    'timesheet:APPROVED'
  ]);
});

test('reject refuses non-SUBMITTED timesheet without mutating records', () => {
  const calls = [];
  const timesheet = { ...submittedTimesheet(), Status: 'APPROVED' };

  const ApprovalService = loadService({
    SheetRepository: {
      getTimesheet() { return timesheet; },
      updateTimeEntry() { calls.push('entry'); },
      updateTimesheet() { calls.push('timesheet'); },
      logApproval() {},
      logWorkspaceAudit() {}
    }
  });

  assert.throws(
    () => ApprovalService.rejectTimesheet(
      { userId: 'A1', role: 'ADMIN' }, 'W1', 'TMS-1', 'reason'
    ),
    /Only SUBMITTED timesheets can be rejected/
  );
  assert.deepEqual(calls, []);
});

test('reopen refuses non-APPROVED timesheet without mutating records', () => {
  const calls = [];
  const timesheet = submittedTimesheet();

  const ApprovalService = loadService({
    SheetRepository: {
      getTimesheet() { return timesheet; },
      updateTimeEntry() { calls.push('entry'); },
      updateTimesheet() { calls.push('timesheet'); },
      logApproval() {},
      logWorkspaceAudit() {}
    }
  });

  assert.throws(
    () => ApprovalService.reopenTimesheet(
      { userId: 'SA1', role: 'SUPER_ADMIN' }, 'W1', 'TMS-1', 'reason'
    ),
    /Only APPROVED timesheets can be reopened/
  );
  assert.deepEqual(calls, []);
});

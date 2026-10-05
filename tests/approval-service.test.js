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

function makeEntry(id, overrides = {}) {
  return {
    EntryID:id,
    UserID:'USR-1',
    ProjectID:'P1',
    TaskID:'T1',
    StartUTC:'2026-09-28T08:00:00.000Z',
    EndUTC:'2026-09-28T09:00:00.000Z',
    DurationSeconds:3600,
    Billable:true,
    HourlyRateSnapshot:100,
    CostRateSnapshot:40,
    TimesheetID:'TMS-1',
    ApprovalStatus:'SUBMITTED',
    Locked:true,
    Version:2,
    UpdatedAt:'2026-09-28T09:00:00.000Z',
    UpdatedBy:'USR-1',
    ...overrides
  };
}

function makeSnapshot(entries) {
  return entries.map(e => ({
    entryId:e.EntryID,
    version:parseInt(e.Version, 10) || 1,
    startUtc:e.StartUTC,
    endUtc:e.EndUTC,
    durationSeconds:parseInt(e.DurationSeconds, 10) || 0,
    projectId:e.ProjectID || '',
    taskId:e.TaskID || '',
    billable:e.Billable === true || e.Billable === 'TRUE' || e.Billable === 1,
    hourlyRateSnapshot:parseFloat(e.HourlyRateSnapshot) || 0,
    costRateSnapshot:parseFloat(e.CostRateSnapshot) || 0
  }));
}

function makeTimesheet(entries, overrides = {}) {
  return {
    TimesheetID:'TMS-1',
    UserID:'USR-1',
    Status:'SUBMITTED',
    PeriodStart:'2026-09-27T00:00:00.000Z',
    PeriodEnd:'2026-10-03T23:59:59.999Z',
    TotalSeconds:entries.reduce((sum,e) => sum + (parseInt(e.DurationSeconds,10)||0), 0),
    SubmittedAt:'2026-10-04T00:00:00.000Z',
    ReviewedBy:'',
    ReviewedAt:'',
    ReviewComment:'',
    LockedAt:'',
    EntrySnapshotJSON:JSON.stringify(makeSnapshot(entries)),
    ...overrides
  };
}

function fixture(options = {}) {
  const entries = new Map(
    (options.entries || [makeEntry('E1'), makeEntry('E2')])
      .map(e => [e.EntryID, { ...e }])
  );
  const timesheet = {
    ...makeTimesheet([...entries.values()]),
    ...(options.timesheet || {})
  };
  const calls = [];
  let approvalLogs = 0;
  let auditLogs = 0;
  let headerFailuresRemaining = options.headerFailures || 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    VALIDATION_ERROR:'VALIDATION_ERROR',
    NOT_FOUND:'NOT_FOUND',
    CONFLICT:'CONFLICT',
    SERVER_BUSY:'SERVER_BUSY',
    PERMISSION_DENIED:'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    TIMESHEET_STATUS:{
      OPEN:'OPEN',
      SUBMITTED:'SUBMITTED',
      APPROVED:'APPROVED',
      REJECTED:'REJECTED'
    },
    TIMESHEET_TRANSITIONS:{
      OPEN:['SUBMITTED'],
      REJECTED:['SUBMITTED'],
      SUBMITTED:['APPROVED','REJECTED'],
      APPROVED:['OPEN']
    },
    AUDIT_EVENTS:{
      TIMESHEET_APPROVED:'TIMESHEET_APPROVED',
      TIMESHEET_REJECTED:'TIMESHEET_REJECTED',
      TIMESHEET_REOPENED:'TIMESHEET_REOPENED'
    }
  };
  global.Validation = {
    sanitizeCellValue(v) { return String(v); },
    generateId(prefix) { return prefix + '-TEST'; }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole(ctx, allowed) {
      if (!allowed.includes(ctx.role)) {
        throw new AppError('AUTH_REQUIRED', 'role denied', 403);
      }
    }
  };
  global.LockService = {
    getScriptLock() {
      return { tryLock() { return true; }, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.SheetRepository = {
    getTimesheet() { return { ...timesheet }; },
    getEntry(_ws,id) {
      const e = entries.get(id);
      return e ? { ...e } : null;
    },
    listTimeEntries() {
      return [...entries.values()].map(e => ({ ...e }));
    },
    updateTimeEntry(_ws,id,patch) {
      calls.push({ type:'entry', id, patch:{ ...patch } });
      const e = entries.get(id);
      if (!e) throw new Error('entry missing');
      Object.assign(e, patch);
      if (options.failEntryId === id && options.failEntryStatus === patch.ApprovalStatus) {
        options.failEntryId = null;
        throw new Error('entry write failure');
      }
      return { ...e };
    },
    updateTimesheet(_ws,_id,patch) {
      calls.push({ type:'timesheet', patch:{ ...patch } });
      Object.assign(timesheet, patch);
      if (headerFailuresRemaining > 0) {
        headerFailuresRemaining -= 1;
        throw new Error('header write failure');
      }
      return { ...timesheet };
    },
    logApproval() {
      approvalLogs += 1;
      if (options.auditFails) throw new Error('approval audit failed');
    },
    logWorkspaceAudit() {
      auditLogs += 1;
      if (options.workspaceAuditFails) throw new Error('workspace audit failed');
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).ApprovalService,
    entries,
    timesheet,
    calls,
    getApprovalLogs:() => approvalLogs,
    getAuditLogs:() => auditLogs
  };
}

const admin = { userId:'A1', role:'ADMIN' };
const superAdmin = { userId:'SA1', role:'SUPER_ADMIN' };

test('immutable snapshot rejects changed project/rate data before approval', () => {
  const fx = fixture();
  fx.entries.get('E1').ProjectID = 'P2';

  assert.throws(
    () => fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok'),
    err => err instanceof AppError &&
      err.code === 'CONFLICT' &&
      /project mismatch/.test(err.message)
  );
  assert.equal(fx.calls.length, 0);
});

test('immutable snapshot rejects an extra entry bound to the timesheet', () => {
  const fx = fixture();
  fx.entries.set('EXTRA', makeEntry('EXTRA', {
    DurationSeconds:10,
    StartUTC:'2026-09-29T08:00:00.000Z',
    EndUTC:'2026-09-29T08:00:10.000Z'
  }));

  assert.throws(
    () => fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok'),
    /entry membership changed/
  );
  assert.equal(fx.calls.length, 0);
});

test('missing immutable snapshot fails closed instead of using date-range fallback', () => {
  const fx = fixture({ timesheet:{ EntrySnapshotJSON:'' } });
  assert.throws(
    () => fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok'),
    /no immutable submission snapshot/
  );
});

test('approval allows only SUBMITTED -> APPROVED', () => {
  const fx = fixture({ timesheet:{ Status:'APPROVED' } });
  assert.throws(
    () => fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok'),
    /Invalid timesheet state transition/
  );
  assert.equal(fx.calls.length, 0);
});

test('approval commits member entries before APPROVED header', () => {
  const fx = fixture();
  const result = fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok');

  assert.equal(result.Status, 'APPROVED');
  const sequence = fx.calls.map(c =>
    c.type === 'entry' ? 'entry:' + c.id + ':' + c.patch.ApprovalStatus : 'header:' + c.patch.Status
  );
  assert.deepEqual(sequence.slice(0,3), [
    'entry:E1:APPROVED',
    'entry:E2:APPROVED',
    'header:APPROVED'
  ]);
});

test('approval header failure restores exact submitted header and entry state', () => {
  const fx = fixture({ headerFailures:1 });

  assert.throws(
    () => fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok'),
    /header write failure/
  );

  assert.equal(fx.timesheet.Status, 'SUBMITTED');
  for (const e of fx.entries.values()) {
    assert.equal(e.ApprovalStatus, 'SUBMITTED');
    assert.equal(e.Locked, true);
    assert.equal(e.TimesheetID, 'TMS-1');
    assert.equal(e.Version, 2);
  }
});

test('rejection clears editable entries from old submission and increments versions', () => {
  const fx = fixture();
  const result = fx.service.rejectTimesheet(admin, 'W1', 'TMS-1', 'needs correction');

  assert.equal(result.Status, 'REJECTED');
  assert.equal(result.EntrySnapshotJSON, '');
  for (const e of fx.entries.values()) {
    assert.equal(e.ApprovalStatus, 'REJECTED');
    assert.equal(e.Locked, false);
    assert.equal(e.TimesheetID, '');
    assert.equal(e.Version, 3);
  }
});

test('rejection is allowed only from SUBMITTED state', () => {
  const fx = fixture({ timesheet:{ Status:'APPROVED' } });
  assert.throws(
    () => fx.service.rejectTimesheet(admin, 'W1', 'TMS-1', 'reason'),
    /Invalid timesheet state transition/
  );
});

test('reopen requires Super Admin reason and performs APPROVED -> OPEN only', () => {
  const approvedEntries = [
    makeEntry('E1', { ApprovalStatus:'APPROVED' }),
    makeEntry('E2', { ApprovalStatus:'APPROVED' })
  ];
  const fx = fixture({
    entries:approvedEntries,
    timesheet:{
      Status:'APPROVED',
      LockedAt:'2026-10-04T01:00:00.000Z',
      EntrySnapshotJSON:JSON.stringify(makeSnapshot(approvedEntries))
    }
  });

  assert.throws(
    () => fx.service.reopenTimesheet(superAdmin, 'W1', 'TMS-1', ''),
    /reason is required/
  );

  const result = fx.service.reopenTimesheet(
    superAdmin, 'W1', 'TMS-1', 'Correction required'
  );
  assert.equal(result.Status, 'OPEN');
  assert.equal(result.EntrySnapshotJSON, '');
  for (const e of fx.entries.values()) {
    assert.equal(e.ApprovalStatus, 'OPEN');
    assert.equal(e.Locked, false);
    assert.equal(e.TimesheetID, '');
    assert.equal(e.Version, 3);
  }
});

test('audit failure after committed approval does not report business mutation as failed', () => {
  const fx = fixture({ auditFails:true });
  const result = fx.service.approveTimesheet(admin, 'W1', 'TMS-1', 'ok');
  assert.equal(result.Status, 'APPROVED');
  assert.equal(fx.timesheet.Status, 'APPROVED');
});

test('self-approval is forbidden and throws PERMISSION_DENIED', () => {
  const fx = fixture();
  const selfAdmin = { userId: 'USR-1', role: 'ADMIN' };
  assert.throws(
    () => fx.service.approveTimesheet(selfAdmin, 'W1', 'TMS-1', 'ok'),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED' &&
      /Self-approval is forbidden/.test(err.message)
  );
  assert.equal(fx.calls.length, 0);
});

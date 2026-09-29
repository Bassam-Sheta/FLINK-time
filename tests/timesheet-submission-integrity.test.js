'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Business.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const START = new Date('2026-09-26T21:00:00.000Z');
const END = new Date('2026-10-03T20:59:59.999Z');

function baseEntry(overrides = {}) {
  return {
    EntryID:'E1',
    UserID:'U1',
    ProjectID:'P1',
    TaskID:'T1',
    Description:'work',
    Tags:'',
    StartUTC:'2026-09-28T08:00:00.000Z',
    EndUTC:'2026-09-28T09:00:00.000Z',
    DurationSeconds:3600,
    Billable:true,
    HourlyRateSnapshot:100,
    CostRateSnapshot:40,
    Status:'ACTIVE',
    ApprovalStatus:'OPEN',
    TimesheetID:'',
    Locked:false,
    Version:4,
    UpdatedAt:'old',
    UpdatedBy:'U1',
    ...overrides
  };
}

function fixture(options = {}) {
  const entries = (options.entries || [baseEntry()]).map(e => ({ ...e }));
  const timesheets = (options.timesheets || []).map(t => ({ ...t }));
  const writes = [];
  let deletedHeaders = 0;
  let auditCalls = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR:'VALIDATION_ERROR',
    CONFLICT:'CONFLICT',
    SERVER_BUSY:'SERVER_BUSY'
  };
  global.CONSTANTS = {
    ROLES:{ USER:'USER', ADMIN:'ADMIN', SUPER_ADMIN:'SUPER_ADMIN' },
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
    AUDIT_EVENTS:{ TIMESHEET_SUBMITTED:'TIMESHEET_SUBMITTED' }
  };
  global.AuthorizationService = { assertWorkspaceAccess() {} };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const field of fields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
          throw new AppError('VALIDATION_ERROR', field + ' required', 400);
        }
      }
    },
    generateId() { return 'TMS-NEW'; }
  };
  global.TimezoneService = {
    getWeekBounds() {
      return {
        startUtc:new Date(START),
        endUtc:new Date(END),
        startLocalDate:'2026-09-27',
        endLocalDate:'2026-10-03',
        timezone:'Africa/Cairo',
        dayLabels:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
      };
    },
    formatDateKey() { return '2026-09-28'; },
    diffLocalDateDays() { return 1; }
  };
  global.LockService = {
    getScriptLock() {
      return { tryLock() { return true; }, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.SheetRepository = {
    listTimeEntries() { return entries.map(e => ({ ...e })); },
    listTimesheets() { return timesheets.map(t => ({ ...t })); },
    listProjects() { return []; },
    listTasks() { return []; },
    updateTimeEntry(_ws,id,patch) {
      writes.push({ type:'entry', id, patch:{ ...patch } });
      const e = entries.find(x => x.EntryID === id);
      Object.assign(e, patch);
      if (options.failEntryWrite) {
        options.failEntryWrite = false;
        throw new Error('entry write failure');
      }
      return { ...e };
    },
    createTimesheet(_ws,data) {
      timesheets.push({ ...data });
      if (options.failCreateHeader) {
        options.failCreateHeader = false;
        throw new Error('header create failure');
      }
      return data;
    },
    updateTimesheet(_ws,id,data) {
      const idx = timesheets.findIndex(t => t.TimesheetID === id);
      if (idx >= 0) Object.assign(timesheets[idx], data);
      if (options.failUpdateHeader) {
        options.failUpdateHeader = false;
        throw new Error('header update failure');
      }
      return idx >= 0 ? { ...timesheets[idx] } : data;
    },
    deleteTimesheet(_ws,id) {
      const idx = timesheets.findIndex(t => t.TimesheetID === id);
      if (idx < 0) return false;
      timesheets.splice(idx, 1);
      deletedHeaders += 1;
      return true;
    },
    logWorkspaceAudit() {
      auditCalls += 1;
      if (options.auditFails) throw new Error('audit failed');
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).TimesheetService,
    entries,
    timesheets,
    writes,
    getDeletedHeaders:() => deletedHeaders,
    getAuditCalls:() => auditCalls
  };
}

const user = { userId:'U1', role:'USER' };
const payload = { periodStart:START.toISOString(), periodEnd:END.toISOString() };

test('submission snapshot captures full immutable state at post-submit version', () => {
  const fx = fixture();
  const result = fx.service.submitTimesheet(user, 'W1', payload);
  const snapshot = JSON.parse(result.EntrySnapshotJSON);

  assert.equal(snapshot.length, 1);
  assert.deepEqual(snapshot[0], {
    entryId:'E1',
    version:5,
    startUtc:'2026-09-28T08:00:00.000Z',
    endUtc:'2026-09-28T09:00:00.000Z',
    durationSeconds:3600,
    projectId:'P1',
    taskId:'T1',
    billable:true,
    hourlyRateSnapshot:100,
    costRateSnapshot:40
  });
  assert.equal(fx.entries[0].Version, 5);
  assert.equal(fx.entries[0].ApprovalStatus, 'SUBMITTED');
  assert.equal(fx.entries[0].TimesheetID, 'TMS-NEW');
  assert.equal(fx.entries[0].Locked, true);
});

test('REJECTED canonical timesheet may resubmit but APPROVED may not', () => {
  let fx = fixture({
    timesheets:[{
      TimesheetID:'TMS-OLD',
      UserID:'U1',
      PeriodStart:START.toISOString(),
      PeriodEnd:END.toISOString(),
      Status:'REJECTED'
    }]
  });
  const result = fx.service.submitTimesheet(user, 'W1', payload);
  assert.equal(result.TimesheetID, 'TMS-OLD');
  assert.equal(result.Status, 'SUBMITTED');

  fx = fixture({
    timesheets:[{
      TimesheetID:'TMS-OLD',
      UserID:'U1',
      PeriodStart:START.toISOString(),
      PeriodEnd:END.toISOString(),
      Status:'APPROVED'
    }]
  });
  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', payload),
    /Invalid timesheet state transition/
  );
});

test('partially applied entry write is compensated because rollback state is registered first', () => {
  const fx = fixture({ failEntryWrite:true });

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', payload),
    /entry write failure/
  );

  assert.equal(fx.entries[0].ApprovalStatus, 'OPEN');
  assert.equal(fx.entries[0].TimesheetID, '');
  assert.equal(fx.entries[0].Locked, false);
  assert.equal(fx.entries[0].Version, 4);
  assert.equal(fx.timesheets.length, 0);
});

test('new header partial failure deletes header and restores entries', () => {
  const fx = fixture({ failCreateHeader:true });

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', payload),
    /header create failure/
  );

  assert.equal(fx.getDeletedHeaders(), 1);
  assert.equal(fx.timesheets.length, 0);
  assert.equal(fx.entries[0].ApprovalStatus, 'OPEN');
  assert.equal(fx.entries[0].Version, 4);
});

test('existing header partial failure restores previous REJECTED header and entries', () => {
  const previous = {
    TimesheetID:'TMS-OLD',
    UserID:'U1',
    PeriodStart:START.toISOString(),
    PeriodEnd:END.toISOString(),
    TotalSeconds:3600,
    Status:'REJECTED',
    SubmittedAt:'old-submit',
    ReviewedBy:'A1',
    ReviewedAt:'old-review',
    ReviewComment:'fix',
    LockedAt:'',
    EntrySnapshotJSON:''
  };
  const fx = fixture({
    timesheets:[previous],
    failUpdateHeader:true
  });

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', payload),
    /header update failure/
  );

  assert.equal(fx.timesheets[0].Status, 'REJECTED');
  assert.equal(fx.timesheets[0].ReviewedBy, 'A1');
  assert.equal(fx.entries[0].ApprovalStatus, 'OPEN');
  assert.equal(fx.entries[0].Version, 4);
});

test('audit failure after successful submission does not turn committed mutation into client failure', () => {
  const fx = fixture({ auditFails:true });
  const result = fx.service.submitTimesheet(user, 'W1', payload);
  assert.equal(result.Status, 'SUBMITTED');
  assert.equal(fx.entries[0].ApprovalStatus, 'SUBMITTED');
});

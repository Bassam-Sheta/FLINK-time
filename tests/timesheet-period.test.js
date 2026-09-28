'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/TimesheetService.gs'
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

function fixture(timesheets = []) {
  const entries = [{
    EntryID:'E1',
    UserID:'U1',
    StartUTC:'2026-09-28T08:00:00.000Z',
    EndUTC:'2026-09-28T09:00:00.000Z',
    DurationSeconds:3600,
    ApprovalStatus:'OPEN',
    TimesheetID:'',
    Locked:false,
    Version:1,
    HourlyRateSnapshot:100,
    CostRateSnapshot:40
  }];
  const writes = [];
  let creates = 0;
  let updates = 0;

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
        if (!obj[field]) throw new AppError('VALIDATION_ERROR', field + ' required');
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
      writes.push({ id, patch:{ ...patch } });
      Object.assign(entries.find(e => e.EntryID === id), patch);
    },
    createTimesheet(_ws,data) {
      creates += 1;
      timesheets.push({ ...data });
    },
    deleteTimesheet(_ws,id) {
      const idx = timesheets.findIndex(t => t.TimesheetID === id);
      if (idx < 0) return false;
      timesheets.splice(idx, 1);
      return true;
    },
    updateTimesheet(_ws,id,data) {
      updates += 1;
      const idx = timesheets.findIndex(t => t.TimesheetID === id);
      if (idx >= 0) timesheets[idx] = { ...timesheets[idx], ...data };
    },
    logWorkspaceAudit() {}
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).TimesheetService,
    entries,
    timesheets,
    writes,
    getCreates:() => creates,
    getUpdates:() => updates
  };
}

const user = { userId:'U1', role:'USER' };
const canonicalPayload = {
  periodStart:START.toISOString(),
  periodEnd:END.toISOString()
};

test('timesheet submission requires exact canonical UTC week boundaries', () => {
  const fx = fixture();

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', {
      periodStart:new Date(START.getTime() + 1).toISOString(),
      periodEnd:END.toISOString()
    }),
    /must match the configured workspace week/
  );
  assert.equal(fx.getCreates(), 0);
  assert.equal(fx.writes.length, 0);
});

test('legacy/custom timesheet overlapping canonical week blocks new submission', () => {
  const fx = fixture([{
    TimesheetID:'OLD',
    UserID:'U1',
    PeriodStart:'2026-09-27T00:00:00.000Z',
    PeriodEnd:'2026-10-02T23:59:59.999Z',
    Status:'REJECTED'
  }]);

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', canonicalPayload),
    err => err instanceof AppError &&
      err.code === 'CONFLICT' &&
      /overlaps/.test(err.message)
  );
  assert.equal(fx.getCreates(), 0);
});

test('duplicate exact canonical timesheet rows fail closed', () => {
  const exact = {
    UserID:'U1',
    PeriodStart:START.toISOString(),
    PeriodEnd:END.toISOString(),
    Status:'REJECTED'
  };
  const fx = fixture([
    { ...exact, TimesheetID:'T1' },
    { ...exact, TimesheetID:'T2' }
  ]);

  assert.throws(
    () => fx.service.submitTimesheet(user, 'W1', canonicalPayload),
    /Multiple timesheets/
  );
});

test('rejected exact canonical timesheet is reused instead of creating another row', () => {
  const fx = fixture([{
    TimesheetID:'T1',
    UserID:'U1',
    PeriodStart:START.toISOString(),
    PeriodEnd:END.toISOString(),
    Status:'REJECTED'
  }]);

  const result = fx.service.submitTimesheet(user, 'W1', canonicalPayload);
  assert.equal(result.TimesheetID, 'T1');
  assert.equal(result.Status, 'SUBMITTED');
  assert.equal(fx.getCreates(), 0);
  assert.equal(fx.getUpdates(), 1);
});

test('getWeeklyTimesheet also surfaces overlapping-period corruption', () => {
  const fx = fixture([{
    TimesheetID:'OLD',
    UserID:'U1',
    PeriodStart:'2026-09-27T00:00:00.000Z',
    PeriodEnd:'2026-10-02T23:59:59.999Z',
    Status:'REJECTED'
  }]);

  assert.throws(
    () => fx.service.getWeeklyTimesheet(user, 'W1', null, '2026-09-28'),
    /overlaps/
  );
});

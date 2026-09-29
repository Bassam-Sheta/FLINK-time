'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const reportPath = path.resolve(
  __dirname,
  '../apps-script/Business.gs'
);
const timezonePath = path.resolve(
  __dirname,
  '../apps-script/Data.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function load() {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR:'VALIDATION_ERROR',
    INTERNAL_ERROR:'INTERNAL_ERROR'
  };
  global.CONSTANTS = {
    ROLES:{ USER:'USER', ADMIN:'ADMIN', SUPER_ADMIN:'SUPER_ADMIN' }
  };
  global.MasterRepository = {
    getWorkspace() { return { WorkspaceID:'W1', Timezone:'Africa/Cairo' }; },
    getGlobalSetting(key, fallback) {
      if (key === 'DEFAULT_TIMEZONE') return 'Africa/Cairo';
      if (key === 'WEEK_STARTS') return 'Sunday';
      return fallback;
    }
  };
  delete global.Utilities;
  delete require.cache[require.resolve(timezonePath)];
  global.TimezoneService = require(timezonePath).TimezoneService;
  global.AuthorizationService = { assertWorkspaceAccess() {} };
  global.SheetRepository = {
    listTimeEntries() {
      return [{
        EntryID:'E1',
        UserID:'U1',
        ProjectID:'P1',
        TaskID:'',
        Description:'late work',
        Tags:'',
        StartUTC:'2026-09-26T22:30:00.000Z',
        EndUTC:'2026-09-26T23:30:00.000Z',
        DurationSeconds:3600,
        Billable:false,
        ApprovalStatus:'OPEN',
        EntrySource:'WEB',
        ManualEntry:false,
        CostRateSnapshot:0,
        HourlyRateSnapshot:0
      }];
    },
    listProjects() { return [{ ProjectID:'P1', ProjectName:'Project' }]; },
    listMembers() { return [{ UserID:'U1', DisplayName:'User' }]; },
    listTasks() { return []; }
  };
  delete require.cache[require.resolve(reportPath)];
  return require(reportPath).ReportService;
}

test('summary date grouping uses workspace business date instead of UTC substring', () => {
  const report = load();
  const result = report.getSummaryReport(
    { userId:'A1', role:'ADMIN' },
    'W1',
    { groupings:['date'] }
  );
  assert.equal(result.tree[0].key, '2026-09-27');
});

test('detailed report exposes explicit workspace timezone and local display timestamps', () => {
  const report = load();
  const result = report.getDetailedReport(
    { userId:'A1', role:'ADMIN' },
    'W1'
  );
  assert.equal(result.entries[0].businessDate, '2026-09-27');
  assert.equal(result.entries[0].timezone, 'Africa/Cairo');
  assert.match(result.entries[0].startLocal, /Africa\/Cairo$/);
});

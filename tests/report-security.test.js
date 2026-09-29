'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/ReportService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function allKeys(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    output.push(key);
    allKeys(child, output);
  }
  return output;
}

function fixture(options = {}) {
  const seenFilters = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    WORKSPACE_DENIED:'WORKSPACE_DENIED',
    PERMISSION_DENIED:'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ USER:'USER', ADMIN:'ADMIN', SUPER_ADMIN:'SUPER_ADMIN' }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess(_ctx,workspaceId) {
      if (workspaceId === 'W2') {
        throw new AppError(
          'WORKSPACE_DENIED',
          'workspace denied',
          403
        );
      }
    },
    assertRole(ctx,roles) {
      if (!roles.includes(ctx.role)) {
        throw new AppError(
          'PERMISSION_DENIED',
          'role denied',
          403
        );
      }
    }
  };
  global.TimezoneService = {
    formatDateKey() { return '2026-09-29'; },
    formatDateTime(_ws,value) { return String(value) + ' UTC'; },
    getWorkspaceTimezone() { return 'UTC'; }
  };
  global.MasterRepository = {
    getGlobalSetting(_key,fallback) { return fallback; }
  };
  global.SheetRepository = {
    getMember(_ws,userId) {
      if (userId === 'U2') return { UserID:'U2', DisplayName:'User Two' };
      if (userId === 'U1') return { UserID:'U1', DisplayName:'User One' };
      return null;
    },
    listTimeEntries(_ws,filters) {
      seenFilters.push({ ...filters });
      const userId = filters && filters.userId ? filters.userId : 'U1';
      return [{
        EntryID:'E1',
        UserID:userId,
        ProjectID:'P1',
        TaskID:'T1',
        Description:'work',
        Tags:'tag',
        StartUTC:'2026-09-29T08:00:00.000Z',
        EndUTC:'2026-09-29T09:00:00.000Z',
        DurationSeconds:3600,
        Billable:true,
        ApprovalStatus:'OPEN',
        EntrySource:'WEB',
        ManualEntry:false,
        HourlyRateSnapshot:500,
        CostRateSnapshot:250
      }];
    },
    listProjects() {
      return [{
        ProjectID:'P1',
        ProjectName:'Secret Project',
        HourlyRate:999,
        CostRate:777,
        BudgetAmount:100000
      }];
    },
    listMembers() {
      return [
        { UserID:'U1', DisplayName:'User One' },
        { UserID:'U2', DisplayName:'User Two' }
      ];
    },
    listTasks() {
      return [{ TaskID:'T1', TaskName:'Task One' }];
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).ReportService,
    seenFilters
  };
}

const user = { userId:'U1', role:'USER' };
const admin = { userId:'A1', role:'ADMIN' };

test('USER summary ignores malicious userId filter and exposes no financial DTO keys', () => {
  const fx = fixture();
  const result = fx.service.getSummaryReport(
    user,
    'W1',
    { filters:{ userId:'U2' }, groupings:['project','user'] }
  );

  assert.equal(fx.seenFilters[0].userId, 'U1');
  const keys = allKeys(result);
  for (const forbidden of [
    'cost','costCents','revenue','revenueCents',
    'HourlyRate','CostRate','BudgetAmount',
    'hourlyRateSnapshot','costRateSnapshot'
  ]) {
    assert.equal(keys.includes(forbidden), false, forbidden + ' leaked');
  }
});

test('USER detailed report is self-scoped and whitelisted away from rate/cost fields', () => {
  const fx = fixture();
  const result = fx.service.getDetailedReport(
    user,
    'W1',
    { filters:{ userId:'U2' } }
  );

  assert.equal(fx.seenFilters[0].userId, 'U1');
  const rowKeys = Object.keys(result.entries[0]);
  assert.equal(rowKeys.includes('HourlyRateSnapshot'), false);
  assert.equal(rowKeys.includes('CostRateSnapshot'), false);
  assert.equal(rowKeys.includes('hourlyRateSnapshot'), false);
  assert.equal(rowKeys.includes('costRateSnapshot'), false);
  assert.equal(rowKeys.includes('budgetAmount'), false);
});

test('USER cannot invoke management-only attendance or exceptions service directly', () => {
  let fx = fixture();
  assert.throws(
    () => fx.service.getAttendanceReport(user, 'W1', {}),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED'
  );

  fx = fixture();
  assert.throws(
    () => fx.service.getExceptionsReport(user, 'W1', {}),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED'
  );
});

test('Admin cannot report against an unassigned workspace', () => {
  const fx = fixture();
  assert.throws(
    () => fx.service.getSummaryReport(admin, 'W2', {}),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
  assert.equal(fx.seenFilters.length, 0);
});

test('Admin cannot target a user that is not a member of the assigned workspace', () => {
  const fx = fixture();
  assert.throws(
    () => fx.service.getDetailedReport(
      admin,
      'W1',
      { filters:{ userId:'U-OTHER-WORKSPACE' } }
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
  assert.equal(fx.seenFilters.length, 0);
});

test('Admin may filter to another user who belongs to the assigned workspace', () => {
  const fx = fixture();
  const result = fx.service.getDetailedReport(
    admin,
    'W1',
    { filters:{ userId:'U2' } }
  );

  assert.equal(fx.seenFilters[0].userId, 'U2');
  assert.equal(result.entries[0].userId, 'U2');
});

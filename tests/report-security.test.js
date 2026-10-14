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

test('summary loads only grouping-required name tables, never metadata for an empty result', () => {
  for (const [groupings, expected] of [
    [undefined, { listProjects:1, listMembers:1, listTasks:0 }],
    [['date'], { listProjects:0, listMembers:0, listTasks:0 }],
    [['billable', 'tag'], { listProjects:0, listMembers:0, listTasks:0 }],
    [['PROJECT', 'project'], { listProjects:1, listMembers:0, listTasks:0 }],
    [['user'], { listProjects:0, listMembers:1, listTasks:0 }],
    [['task'], { listProjects:0, listMembers:0, listTasks:1 }],
    [['project', 'user', 'task'], { listProjects:1, listMembers:1, listTasks:1 }]
  ]) {
    const fx = fixture();
    const calls = { listProjects:0, listMembers:0, listTasks:0 };
    for (const method of Object.keys(calls)) {
      const original = global.SheetRepository[method];
      global.SheetRepository[method] = (...args) => { calls[method]++; return original(...args); };
    }
    const report = fx.service.getSummaryReport(user, 'W1', { groupings });
    assert.equal(report.overall.totalSeconds, 3600);
    assert.equal(fx.seenFilters[0].userId, 'U1');
    assert.deepEqual(calls, expected);
    for (const method of Object.keys(calls)) calls[method] = 0;
    global.SheetRepository.listTimeEntries = () => [];
    assert.equal(fx.service.getSummaryReport(user, 'W1', { groupings }).totalEntries, 0);
    assert.deepEqual(calls, { listProjects:0, listMembers:0, listTasks:0 });
  }
});

test('summary treats prototype-shaped labels and IDs as ordinary data without leaking USER financials', () => {
  const labels = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '1', '2'];
  for (const role of [user, admin]) {
    const fx = fixture();
    global.SheetRepository.listTimeEntries = () => labels.flatMap(Tags => Array.from({ length:2 }, () => ({
      UserID:'U1', ProjectID:'__proto__', Tags, DurationSeconds:1,
      Billable:true, CostRateSnapshot:18, HourlyRateSnapshot:18
    })));
    global.SheetRepository.listProjects = () => [{ ProjectID:'__proto__', ProjectName:'Named Project' }];
    const result = fx.service.getSummaryReport(role, 'W1', { groupings:['project', 'tag'] });
    assert.equal(result.tree[0].key, 'Named Project');
    assert.equal(result.overall.totalSeconds, 12);
    const groups = new Map(result.tree[0].groups.map(row => [row.key, row]));
    assert.equal(groups.size, labels.length);
    for (const label of labels) {
      assert.equal(groups.get(label).totalSeconds, 2);
      assert.equal(groups.get(label).entryCount, 2);
    }
    if (role === user) assert.equal(allKeys(result).includes('costCents'), false);
    else assert.equal(result.overall.costCents, 12);
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

test('Admin getExceptionsReport detects overlaps across interleaved entries of multiple users', () => {
  const fx = fixture();
  global.SheetRepository.listTimeEntries = () => [
    {
      EntryID: 'E1',
      UserID: 'U1',
      ProjectID: 'P1',
      Description: 'Task 1',
      StartUTC: '2026-09-29T09:00:00.000Z',
      EndUTC: '2026-09-29T11:00:00.000Z',
      DurationSeconds: 7200
    },
    {
      EntryID: 'E2',
      UserID: 'U2',
      ProjectID: 'P1',
      Description: 'Interleaved User 2 Task',
      StartUTC: '2026-09-29T09:30:00.000Z',
      EndUTC: '2026-09-29T09:45:00.000Z',
      DurationSeconds: 900
    },
    {
      EntryID: 'E3',
      UserID: 'U1',
      ProjectID: 'P1',
      Description: 'Overlapping Task for User 1',
      StartUTC: '2026-09-29T10:00:00.000Z',
      EndUTC: '2026-09-29T10:30:00.000Z',
      DurationSeconds: 1800
    },
    {
      EntryID: 'E4',
      UserID: 'U1',
      ProjectID: 'P1',
      Description: 'Second Overlapping Task for User 1',
      StartUTC: '2026-09-29T10:45:00.000Z',
      EndUTC: '2026-09-29T11:15:00.000Z',
      DurationSeconds: 1800
    }
  ];

  const report = fx.service.getExceptionsReport(admin, 'W1', {});
  const overlaps = report.anomalies.filter(a => a.type === 'OVERLAPPING_ENTRIES');

  assert.equal(overlaps.length, 2);
  assert.equal(overlaps[0].entryId, 'E3');
  assert.equal(overlaps[0].conflictWithEntryId, 'E1');
  assert.equal(overlaps[0].userId, 'U1');

  assert.equal(overlaps[1].entryId, 'E4');
  assert.equal(overlaps[1].conflictWithEntryId, 'E1');
  assert.equal(overlaps[1].userId, 'U1');
});

test('Admin getAttendanceReport gracefully skips entries lacking StartUTC without throwing', () => {
  const fx = fixture();
  global.SheetRepository.listTimeEntries = () => [
    {
      EntryID: 'E-VALID',
      UserID: 'U1',
      StartUTC: '2026-09-29T08:00:00.000Z',
      EndUTC: '2026-09-29T16:00:00.000Z',
      DurationSeconds: 28800
    },
    {
      EntryID: 'E-NO-START',
      UserID: 'U1',
      StartUTC: '',
      EndUTC: '',
      DurationSeconds: 0
    }
  ];

  const report = fx.service.getAttendanceReport(admin, 'W1', {});
  assert.ok(report.attendance);
  assert.equal(report.attendance.length, 1);
  assert.equal(report.attendance[0].userId, 'U1');
  assert.equal(report.attendance[0].trackedHours, 8);
});

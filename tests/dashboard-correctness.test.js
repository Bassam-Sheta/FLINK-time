'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fixture(options = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    WORKSPACE_DENIED:'WORKSPACE_DENIED',
    SERVER_BUSY:'SERVER_BUSY'
  };
  global.CONSTANTS = {
    ROLES:{ USER:'USER', ADMIN:'ADMIN', SUPER_ADMIN:'SUPER_ADMIN' },
    WORKSPACE_TABS:{ ACTIVE_TIMERS:'ActiveTimers' },
    TIMESHEET_STATUS:{ SUBMITTED:'SUBMITTED' },
    REQUEST_STATUS:{ PENDING:'PENDING' },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', PASSIVE:'PASSIVE' },
    MASTER_TABS:{ ACCOUNTS:'Accounts' }
  };
  global.WorkspaceService = {
    listWorkspaces() {
      return options.workspaces || [{
        WorkspaceID:'W1',
        WorkspaceName:'Operations'
      }];
    }
  };
  global.TimezoneService = {
    formatDateKey(_ws,value) {
      if (value instanceof Date) return '2026-09-29';
      return String(value).substring(0,10);
    },
    getWeekBounds() {
      return {
        startLocalDate:'2026-09-27',
        endLocalDate:'2026-10-03'
      };
    }
  };
  const recorded = {
    listTimeEntriesFilters: [],
    listTimesheetsFilters: [],
    timerLookups: [],
    memberLookups: [],
    projectLookups: [],
    memberLists: 0,
    projectLists: 0
  };
  global.MasterRepository = {
    listRequests() { return []; },
    getTableData() { return { rows:[] }; }
  };
  global.SheetRepository = {
    getActiveTimer(ws, userId) {
      if (options.timerError) throw new Error('timer read failed');
      recorded.timerLookups.push([ws, userId]);
      return (options.timers || []).find(t => t.UserID === userId) || null;
    },
    getMember(ws, userId) {
      recorded.memberLookups.push([ws, userId]);
      return { UserID: userId, DisplayName: userId === 'U1' ? 'User One' : 'User Two' };
    },
    getProject(ws, projectId) {
      recorded.projectLookups.push([ws, projectId]);
      return { ProjectID: projectId, ProjectName: 'Project One' };
    },
    listTimeEntries(ws, filters = {}) {
      recorded.listTimeEntriesFilters.push(filters);
      if (options.entriesError) throw new Error('entry read failed');
      return (options.entries || []).map(e => ({ ...e }));
    },
    getTableData(_ws,tab) {
      if (options.timerError) throw new Error('timer read failed');
      if (tab === 'ActiveTimers') {
        return { rows:(options.timers || []).map(t => ({ ...t })) };
      }
      return { rows:[] };
    },
    listMembers() {
      recorded.memberLists++;
      return [
        { UserID:'U1', DisplayName:'User One' },
        { UserID:'U2', DisplayName:'User Two' }
      ];
    },
    listProjects() {
      recorded.projectLists++;
      return [{ ProjectID:'P1', ProjectName:'Project One' }];
    },
    listTimesheets(ws, filters = {}) {
      recorded.listTimesheetsFilters.push(filters);
      return (options.timesheets || []).map(t => ({ ...t }));
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const svc = require(servicePath).DashboardService;
  svc._testRecorded = recorded;
  return svc;
}

const entries = [
  {
    EntryID:'E1', UserID:'U1', StartUTC:'2026-09-29T08:00:00.000Z',
    DurationSeconds:3600, Status:'ACTIVE'
  },
  {
    EntryID:'E2', UserID:'U2', StartUTC:'2026-09-29T09:00:00.000Z',
    DurationSeconds:7200, Status:'ACTIVE'
  },
  {
    EntryID:'E3', UserID:'U1', StartUTC:'2026-09-28T09:00:00.000Z',
    DurationSeconds:1800, Status:'ACTIVE'
  },
  {
    EntryID:'OLD', UserID:'U2', StartUTC:'2026-09-20T09:00:00.000Z',
    DurationSeconds:9999, Status:'ACTIVE'
  }
];

test('dashboard today/week totals match raw entries and exclude historical weeks', () => {
  const dashboard = fixture({ entries });
  const result = dashboard.getDashboardOverview(
    { userId:'A1', role:'ADMIN' },
    'W1'
  );

  assert.equal(result.todayTrackedHours, 3);
  assert.equal(result.weekTrackedHours, 3.5);
});

test('self-scoped radar uses point lookups instead of transferring coworkers and every project', () => {
  const dashboard = fixture({ timers: [
    { TimerID: 'T2', UserID: 'U2', ProjectID: 'P2', StartedAtUTC: '2026-09-29T07:00:00Z' },
    { TimerID: 'T1', UserID: 'U1', ProjectID: 'P1', StartedAtUTC: '2026-09-29T07:00:00Z' }
  ] });
  const result = dashboard.getLiveWorkforceRadar({ userId: 'U1', role: 'USER' }, 'W1');
  assert.deepEqual(result.workers.map(w => [w.userId, w.userName, w.projectName]), [['U1', 'User One', 'Project One']]);
  assert.deepEqual(dashboard._testRecorded.timerLookups, [['W1', 'U1']]);
  assert.deepEqual(dashboard._testRecorded.memberLookups, [['W1', 'U1']]);
  assert.deepEqual(dashboard._testRecorded.projectLookups, [['W1', 'P1']]);
  assert.equal(dashboard._testRecorded.memberLists, 0);
  assert.equal(dashboard._testRecorded.projectLists, 0);
});

test('idle radar does not load member/project names for either ordinary users or managers', () => {
  for (const role of ['USER', 'ADMIN', 'SUPER_ADMIN']) {
    const dashboard = fixture();
    assert.equal(dashboard.getLiveWorkforceRadar({ userId: 'U1', role }, 'W1').activeCount, 0);
    assert.equal(dashboard._testRecorded.memberLists, 0, role);
    assert.equal(dashboard._testRecorded.projectLists, 0, role);
    assert.equal(dashboard._testRecorded.memberLookups.length, 0, role);
    assert.equal(dashboard._testRecorded.projectLookups.length, 0, role);
  }
});

test('manager radar still returns all visible workers and names', () => {
  const dashboard = fixture({ timers: [
    { TimerID: 'T1', UserID: 'U1', ProjectID: 'P1' },
    { TimerID: 'T2', UserID: 'U2', ProjectID: 'P1' }
  ] });
  const result = dashboard.getLiveWorkforceRadar({ userId: 'A1', role: 'ADMIN' }, 'W1');
  assert.deepEqual(result.workers.map(w => w.userName), ['User One', 'User Two']);
  assert.equal(dashboard._testRecorded.timerLookups.length, 0);
});

test('self-scoped radar still fails closed on storage errors', () => {
  const dashboard = fixture({ timerError: true });
  assert.throws(() => dashboard.getLiveWorkforceRadar({ userId: 'U1', role: 'USER' }, 'W1'),
    error => error.code === 'SERVER_BUSY' && error.statusCode === 503);
});

test('USER dashboard is self-scoped even when workspace contains coworkers', () => {
  const dashboard = fixture({
    entries,
    timesheets:[
      { UserID:'U1', Status:'SUBMITTED' },
      { UserID:'U2', Status:'SUBMITTED' }
    ],
    timers:[
      {
        TimerID:'T1', UserID:'U1', ProjectID:'P1',
        StartedAtUTC:'2026-09-29T07:00:00.000Z'
      },
      {
        TimerID:'T2', UserID:'U2', ProjectID:'P1',
        StartedAtUTC:'2026-09-29T07:00:00.000Z'
      }
    ]
  });

  const result = dashboard.getDashboardOverview(
    { userId:'U1', role:'USER' },
    'W1'
  );

  assert.equal(result.todayTrackedHours, 1);
  assert.equal(result.weekTrackedHours, 1.5);
  assert.equal(result.pendingApprovalsCount, 1);
  assert.equal(result.activeTimersCount, 1);
  assert.deepEqual(result.workingNow.map(w => w.userId), ['U1']);
});

test('requesting inaccessible dashboard workspace returns 403 instead of zero totals', () => {
  const dashboard = fixture({ entries });

  assert.throws(
    () => dashboard.getDashboardOverview(
      { userId:'A1', role:'ADMIN' },
      'W-NOT-ASSIGNED'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
});

test('dashboard workspace read failure fails closed instead of silently understating KPIs', () => {
  const dashboard = fixture({ entriesError:true });

  assert.throws(
    () => dashboard.getDashboardOverview(
      { userId:'A1', role:'ADMIN' },
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'SERVER_BUSY'
  );
});

test('USER dashboard queries SheetRepository with userId filters for isolation and performance', () => {
  const dashboard = fixture({ entries });
  dashboard.getDashboardOverview(
    { userId:'U1', role:'USER' },
    'W1'
  );

  assert.equal(dashboard._testRecorded.listTimeEntriesFilters.length, 1);
  assert.equal(dashboard._testRecorded.listTimeEntriesFilters[0].userId, 'U1');
  assert.equal(dashboard._testRecorded.listTimesheetsFilters.length, 1);
  assert.equal(dashboard._testRecorded.listTimesheetsFilters[0].userId, 'U1');

  // ADMIN should not filter repository entries by userId
  dashboard.getDashboardOverview(
    { userId:'A1', role:'ADMIN' },
    'W1'
  );

  assert.equal(dashboard._testRecorded.listTimeEntriesFilters[1].userId, undefined);
  assert.equal(dashboard._testRecorded.listTimesheetsFilters[1].userId, undefined);
});

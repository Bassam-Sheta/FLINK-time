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

function loadService(lockBehavior = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    SERVER_BUSY: 'SERVER_BUSY',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED',
    CONFLICT: 'CONFLICT',
    CRYPTO_FAILURE: 'CRYPTO_FAILURE',
    AUTH_REQUIRED: 'AUTH_REQUIRED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN' }
  };
  global.AuthorizationService = {
    assertRole() {}
  };
  global.SecurityService = {};
  global.Validation = {};
  global.MasterRepository = {};
  global.SheetRepository = {};
  global.WorkspaceRouter = {};
  global.SessionService = {};
  global.RollupService = {};
  global.DashboardService = {};
  global.LockService = {
    getScriptLock() {
      return {
        tryLock() {
          return lockBehavior.tryLock === undefined ? true : lockBehavior.tryLock;
        },
        releaseLock() {
          if (lockBehavior.onRelease) lockBehavior.onRelease();
        }
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).BackupService;
}

test('public backup acquires and releases ScriptLock around snapshot work', () => {
  const calls = [];
  const BackupService = loadService({
    onRelease() { calls.push('release'); }
  });

  BackupService._createBackupUnlocked = (_auth, workspaceId) => {
    calls.push('snapshot:' + workspaceId);
    return { ok: true, backupId: 'BKP-1' };
  };

  const result = BackupService.createBackup(
    { userId: 'SA1', role: 'SUPER_ADMIN' },
    'W1'
  );

  assert.equal(result.backupId, 'BKP-1');
  assert.deepEqual(calls, ['snapshot:W1', 'release']);
});

test('public backup refuses snapshot when ScriptLock cannot be acquired', () => {
  const BackupService = loadService({ tryLock: false });
  let called = false;
  BackupService._createBackupUnlocked = () => {
    called = true;
  };

  assert.throws(
    () => BackupService.createBackup(
      { userId: 'SA1', role: 'SUPER_ADMIN' },
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'SERVER_BUSY' &&
      err.statusCode === 409
  );
  assert.equal(called, false);
});


function fakeSheet(headers, rows) {
  return {
    getLastRow() { return rows.length + 1; },
    getRange(row, col, numRows, numCols) {
      return {
        getValues() {
          if (row === 1) return [headers.slice(0, numCols)];
          return rows.slice(0, numRows).map(r => r.slice(0, numCols));
        }
      };
    }
  };
}

test('restore candidate rollups must reconcile to active raw entries', () => {
  const BackupService = loadService();
  global.CONSTANTS.WORKSPACE_TABS = {
    TIME_ENTRIES: 'TimeEntries',
    DAILY_ROLLUPS: 'DailyRollups',
    WEEKLY_ROLLUPS: 'WeeklyRollups',
    MONTHLY_ROLLUPS: 'MonthlyRollups'
  };
  global.WORKSPACE_SCHEMA = {
    TimeEntries: ['EntryID', 'Status', 'DurationSeconds'],
    DailyRollups: ['RollupDate', 'TotalSeconds'],
    WeeklyRollups: ['WeekStart', 'TotalSeconds'],
    MonthlyRollups: ['MonthKey', 'TotalSeconds']
  };

  const sheets = {
    TimeEntries: fakeSheet(
      WORKSPACE_SCHEMA.TimeEntries,
      [
        ['E1', 'ACTIVE', 3600],
        ['E2', 'DELETED', 900],
        ['E3', 'ACTIVE', 1800]
      ]
    ),
    DailyRollups: fakeSheet(WORKSPACE_SCHEMA.DailyRollups, [['2026-09-27', 5400]]),
    WeeklyRollups: fakeSheet(WORKSPACE_SCHEMA.WeeklyRollups, [['2026-09-27', 5400]]),
    MonthlyRollups: fakeSheet(WORKSPACE_SCHEMA.MonthlyRollups, [['2026-09', 5400]])
  };
  const spreadsheet = { getSheetByName(name) { return sheets[name] || null; } };

  const result = BackupService._validateWorkspaceRollupTotals(spreadsheet);
  assert.equal(result.rawSeconds, 5400);
});

test('restore candidate with stale rollups is rejected before activation', () => {
  const BackupService = loadService();
  global.CONSTANTS.WORKSPACE_TABS = {
    TIME_ENTRIES: 'TimeEntries',
    DAILY_ROLLUPS: 'DailyRollups',
    WEEKLY_ROLLUPS: 'WeeklyRollups',
    MONTHLY_ROLLUPS: 'MonthlyRollups'
  };
  global.WORKSPACE_SCHEMA = {
    TimeEntries: ['EntryID', 'Status', 'DurationSeconds'],
    DailyRollups: ['RollupDate', 'TotalSeconds'],
    WeeklyRollups: ['WeekStart', 'TotalSeconds'],
    MonthlyRollups: ['MonthKey', 'TotalSeconds']
  };

  const sheets = {
    TimeEntries: fakeSheet(WORKSPACE_SCHEMA.TimeEntries, [['E1', 'ACTIVE', 3600]]),
    DailyRollups: fakeSheet(WORKSPACE_SCHEMA.DailyRollups, [['2026-09-27', 1800]]),
    WeeklyRollups: fakeSheet(WORKSPACE_SCHEMA.WeeklyRollups, [['2026-09-27', 3600]]),
    MonthlyRollups: fakeSheet(WORKSPACE_SCHEMA.MonthlyRollups, [['2026-09', 3600]])
  };
  const spreadsheet = { getSheetByName(name) { return sheets[name] || null; } };

  assert.throws(
    () => BackupService._validateWorkspaceRollupTotals(spreadsheet),
    err => err instanceof AppError &&
      err.code === 'CONFLICT' &&
      /rollup mismatch/.test(err.message)
  );
});

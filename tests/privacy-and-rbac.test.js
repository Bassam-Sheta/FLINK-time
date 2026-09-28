'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const timeEntryPath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/TimeEntryService.gs'
);
const authzPath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/AuthorizationService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function installCommon() {
  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    WORKSPACE_STATUS: { ACTIVE: 'ACTIVE', ARCHIVED: 'ARCHIVED', SUSPENDED: 'SUSPENDED' },
    LIMITS: { ADMIN_MAX_ACTIVE_WORKSPACES: 3 },
    TIMESHEET_STATUS: {
      OPEN: 'OPEN',
      SUBMITTED: 'SUBMITTED',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED'
    }
  };
}

test('regular-user time-entry DTO excludes hourly and cost rate snapshots', () => {
  installCommon();
  delete require.cache[require.resolve(timeEntryPath)];
  const { TimeEntryService } = require(timeEntryPath);

  const dto = TimeEntryService.toTimeEntryDTO({
    EntryID: 'E1',
    UserID: 'U1',
    ProjectID: 'P1',
    DurationSeconds: 3600,
    Billable: true,
    HourlyRateSnapshot: 125,
    CostRateSnapshot: 40,
    ApprovalStatus: 'OPEN',
    Locked: false,
    Version: 1
  }, false);

  assert.equal(Object.hasOwn(dto, 'hourlyRateSnapshot'), false);
  assert.equal(Object.hasOwn(dto, 'costRateSnapshot'), false);
  assert.equal(dto.durationHours, 1);
});

test('management time-entry DTO may include financial snapshots', () => {
  installCommon();
  delete require.cache[require.resolve(timeEntryPath)];
  const { TimeEntryService } = require(timeEntryPath);

  const dto = TimeEntryService.toTimeEntryDTO({
    EntryID: 'E1',
    UserID: 'U1',
    DurationSeconds: 1800,
    HourlyRateSnapshot: 125,
    CostRateSnapshot: 40,
    ApprovalStatus: 'OPEN',
    Locked: false,
    Version: 2
  }, true);

  assert.equal(dto.hourlyRateSnapshot, 125);
  assert.equal(dto.costRateSnapshot, 40);
});

test('PrimaryWorkspaceID alone does not grant workspace access', () => {
  installCommon();
  global.MasterRepository = {
    getWorkspace(id) {
      return { WorkspaceID: id, Status: 'ACTIVE' };
    },
    getWorkspaceAccessForUser() {
      return [];
    }
  };

  delete require.cache[require.resolve(authzPath)];
  const { AuthorizationService } = require(authzPath);

  assert.throws(
    () => AuthorizationService.assertWorkspaceAccess(
      {
        userId: 'U1',
        role: 'USER',
        user: { Username: 'user1', PrimaryWorkspaceID: 'W1' }
      },
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
});

test('active WorkspaceAccess mapping grants access', () => {
  installCommon();
  global.MasterRepository = {
    getWorkspace(id) {
      return { WorkspaceID: id, Status: 'ACTIVE' };
    },
    getWorkspaceAccessForUser() {
      return [{ WorkspaceID: 'W1', Active: true }];
    }
  };

  delete require.cache[require.resolve(authzPath)];
  const { AuthorizationService } = require(authzPath);

  assert.equal(
    AuthorizationService.assertWorkspaceAccess(
      { userId: 'U1', role: 'USER', user: { Username: 'user1' } },
      'W1'
    ),
    true
  );
});

test('inactive workspace is denied even for Super Admin', () => {
  installCommon();
  global.MasterRepository = {
    getWorkspace(id) {
      return { WorkspaceID: id, Status: 'SUSPENDED' };
    },
    getWorkspaceAccessForUser() {
      return [];
    }
  };

  delete require.cache[require.resolve(authzPath)];
  const { AuthorizationService } = require(authzPath);

  assert.throws(
    () => AuthorizationService.assertWorkspaceAccess(
      { userId: 'SA1', role: 'SUPER_ADMIN', user: { Username: 'root' } },
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
});


test('non-super-admin workspace DTO excludes physical storage identifiers', () => {
  installCommon();
  global.MasterRepository = {
    listWorkspaces() {
      return [{
        WorkspaceID: 'W1',
        WorkspaceCode: 'OPS',
        WorkspaceName: 'Operations',
        SpreadsheetID: 'secret-sheet-id',
        DriveFolderID: 'secret-folder-id',
        Status: 'ACTIVE',
        Timezone: 'Africa/Cairo',
        SchemaVersion: 1,
        CreatedAt: '2026-09-27'
      }];
    },
    getWorkspaceAccessForUser() {
      return [{ WorkspaceID: 'W1', Active: true }];
    }
  };

  const workspacePath = path.resolve(
    __dirname,
    '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/WorkspaceService.gs'
  );
  delete require.cache[require.resolve(workspacePath)];
  const { WorkspaceService } = require(workspacePath);

  const rows = WorkspaceService.listWorkspaces({ userId: 'U1', role: 'USER' });
  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], 'SpreadsheetID'), false);
  assert.equal(Object.hasOwn(rows[0], 'DriveFolderID'), false);
  assert.equal(rows[0].WorkspaceName, 'Operations');
});

test('user DTO never leaks repository row index', () => {
  installCommon();
  const userPath = path.resolve(
    __dirname,
    '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/UserService.gs'
  );
  global.MasterRepository = {
    getTableData(tab) {
      if (tab === 'Accounts') {
        return {
          rows: [{
            _rowIndex: 7,
            UserID: 'U1',
            Username: 'worker',
            DisplayName: 'Worker',
            Role: 'USER',
            Status: 'ACTIVE',
            PrimaryWorkspaceID: 'W1',
            Email: 'worker@example.com',
            CreatedBy: 'SA1'
          }]
        };
      }
      return { rows: [{ UserID: 'U1', WorkspaceID: 'W1', Active: true }] };
    },
    getWorkspaceAccessForUser() {
      return [{ WorkspaceID: 'W1', Active: true }];
    }
  };
  global.LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
  };

  // UserService reads these tab-name constants.
  global.CONSTANTS.MASTER_TABS = {
    ACCOUNTS: 'Accounts',
    WORKSPACE_ACCESS: 'WorkspaceAccess'
  };

  delete require.cache[require.resolve(userPath)];
  const { UserService } = require(userPath);
  const rows = UserService.listUsers({ userId: 'U1', role: 'USER' });

  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], '_rowIndex'), false);
  assert.equal(Object.hasOwn(rows[0], 'CreatedBy'), false);
  assert.equal(rows[0].Username, 'worker');
});


test('inactive WorkspaceAccess row never grants access even if repository returns it', () => {
  installCommon();
  global.MasterRepository = {
    getWorkspace(id) {
      return { WorkspaceID: id, Status: 'ACTIVE' };
    },
    getWorkspaceAccessForUser() {
      return [{ WorkspaceID: 'W1', Active: false }];
    }
  };

  delete require.cache[require.resolve(authzPath)];
  const { AuthorizationService } = require(authzPath);

  assert.throws(
    () => AuthorizationService.assertWorkspaceAccess(
      { userId: 'U1', role: 'USER', user: { Username: 'user1' } },
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
});

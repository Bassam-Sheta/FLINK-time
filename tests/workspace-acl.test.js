'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/WorkspaceService.gs'
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
    NOT_FOUND: 'NOT_FOUND',
    ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE' },
    WORKSPACE_STATUS: {
      ACTIVE: 'ACTIVE',
      SUSPENDED: 'SUSPENDED',
      MAINTENANCE: 'MAINTENANCE',
      ARCHIVED: 'ARCHIVED'
    },
    AUDIT_EVENTS: {
      ADMIN_ASSIGNED: 'ADMIN_ASSIGNED',
      USER_ASSIGNED: 'USER_ASSIGNED'
    }
  };
  global.Validation = {
    generateId(prefix) { return prefix + '-1'; }
  };
  global.LockService = {
    getScriptLock() {
      return { waitLock() {}, releaseLock() {} };
    }
  };
  delete global.SpreadsheetApp;
}

test('Super Admin cannot grant Admin ACL to inactive workspace', () => {
  installCommon();
  let accessWrites = 0;

  global.AuthorizationService = {
    assertRole() {},
    assertAdminWorkspaceLimit() {}
  };
  global.MasterRepository = {
    findAccountById() {
      return { UserID: 'A1', Username: 'admin1', DisplayName: 'Admin', Role: 'ADMIN' };
    },
    getWorkspace() {
      return { WorkspaceID: 'W1', WorkspaceName: 'Suspended', Status: 'SUSPENDED' };
    },
    assignWorkspaceAccess() { accessWrites += 1; },
    logGlobalAudit() {}
  };
  global.SheetRepository = {
    getMember() { return null; },
    addMember() {}
  };

  delete require.cache[require.resolve(servicePath)];
  const { WorkspaceService } = require(servicePath);

  assert.throws(
    () => WorkspaceService.assignAdminToWorkspace(
      { userId: 'SA1', role: 'SUPER_ADMIN' },
      'A1',
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );
  assert.equal(accessWrites, 0);
});

test('Admin cannot assign a user into a workspace the Admin does not manage', () => {
  installCommon();
  let accessWrites = 0;
  let workspaceAccessChecks = 0;

  global.AuthorizationService = {
    assertRole() {},
    assertWorkspaceAccess() {
      workspaceAccessChecks += 1;
      throw new AppError('WORKSPACE_DENIED', 'denied', 403);
    }
  };
  global.MasterRepository = {
    findAccountById() {
      return { UserID: 'U1', Username: 'user1', DisplayName: 'User', Role: 'USER', Status: 'ACTIVE' };
    },
    getWorkspace() {
      return { WorkspaceID: 'W1', WorkspaceName: 'Ops', Status: 'ACTIVE' };
    },
    getWorkspaceAccessForUser() { return []; },
    assignWorkspaceAccess() { accessWrites += 1; },
    logGlobalAudit() {}
  };
  global.SheetRepository = {
    getMember() { return null; },
    addMember() {}
  };

  delete require.cache[require.resolve(servicePath)];
  const { WorkspaceService } = require(servicePath);

  assert.throws(
    () => WorkspaceService.assignUserToWorkspace(
      { userId: 'A1', role: 'ADMIN', user: { Username: 'admin1' } },
      'U1',
      'W1'
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED'
  );
  assert.equal(workspaceAccessChecks, 1);
  assert.equal(accessWrites, 0);
});

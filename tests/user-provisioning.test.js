'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/UserService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

test('new user is rolled back when workspace member provisioning fails', () => {
  const calls = [];
  const account = { UserID: 'USR-NEW' };

  global.AppError = AppError;
  global.ERROR_CODES = {
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    CONFLICT: 'CONFLICT',
    WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE' },
    WORKSPACE_STATUS: { ACTIVE: 'ACTIVE' },
    WORKSPACE_TABS: { MEMBERS: 'Members' },
    AUDIT_EVENTS: { USER_CREATED: 'USER_CREATED' }
  };
  global.AuthorizationService = { assertRole() {} };
  global.Validation = {
    assertRequired() {},
    validateUsername(v) { return String(v).toLowerCase(); },
    validateRole(v) { return v; },
    validatePassword(v) { return v; },
    sanitizeCellValue(v) { return v; },
    generateId(prefix) {
      if (prefix === 'USR') return 'USR-NEW';
      return prefix + '-1';
    }
  };
  global.SecurityService = {
    generateRandomHex() { return 'abcdef1234567890'; },
    hashPassword() { return 'HASH'; }
  };
  global.LockService = {
    getScriptLock() {
      return { waitLock() {}, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.MasterRepository = {
    findAccountByUsername() { return null; },
    getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
    createAccount() { calls.push('create-account'); },
    assignWorkspaceAccess() { calls.push('assign-access'); },
    rollbackUserCreation(userId) {
      calls.push('rollback:' + userId);
    },
    logGlobalAudit() { calls.push('audit'); }
  };
  global.SheetRepository = {
    addMember() {
      calls.push('add-member');
      throw new Error('workspace write failed');
    },
    getMember() { return null; },
    deleteRow() {}
  };

  delete require.cache[require.resolve(servicePath)];
  const { UserService } = require(servicePath);

  assert.throws(
    () => UserService.createUser(
      { userId: 'SA1', role: 'SUPER_ADMIN' },
      {
        username: 'newuser',
        displayName: 'New User',
        role: 'USER',
        primaryWorkspaceId: 'W1',
        temporaryPassword: 'Password123!'
      }
    ),
    /workspace write failed/
  );

  assert.deepEqual(calls.slice(0, 4), [
    'create-account',
    'assign-access',
    'add-member',
    'rollback:USR-NEW'
  ]);
  assert.equal(calls.includes('audit'), false);
});

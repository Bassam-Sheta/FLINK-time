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
    validateEmail(v) { return String(v).toLowerCase(); },
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
        email: 'newuser@example.com',
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


test('account row is rolled back when credential creation fails', () => {
  const repoPath = path.resolve(
    __dirname,
    '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/MasterRepository.gs'
  );
  const calls = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND'
  };
  global.CONSTANTS = {
    MASTER_TABS: {
      ACCOUNTS: 'Accounts',
      CREDENTIALS: 'Credentials',
      WORKSPACE_ACCESS: 'WorkspaceAccess'
    }
  };
  global.MASTER_SCHEMA = {};
  global.WORKSPACE_SCHEMA = {};
  global.SecurityService = {};
  global.Validation = {};

  delete require.cache[require.resolve(repoPath)];
  const { MasterRepository } = require(repoPath);

  const rows = {
    Accounts: [],
    Credentials: [],
    WorkspaceAccess: []
  };

  MasterRepository.appendRow = (tab, data) => {
    calls.push('append:' + tab);
    if (tab === 'Credentials') throw new Error('credential write failed');
    rows[tab].push({ ...data, _rowIndex: rows[tab].length + 2 });
  };
  MasterRepository.getTableData = tab => ({ rows: rows[tab] });
  MasterRepository.deleteRow = (tab, rowIndex) => {
    calls.push('delete:' + tab);
    rows[tab] = rows[tab].filter(r => r._rowIndex !== rowIndex);
  };

  assert.throws(
    () => MasterRepository.createAccount(
      { UserID:'U1', Username:'worker' },
      { UserID:'U1', PasswordHash:'HASH' }
    ),
    /credential write failed/
  );

  assert.equal(rows.Accounts.length, 0);
  assert.equal(rows.Credentials.length, 0);
  assert.deepEqual(calls, ['append:Accounts', 'append:Credentials', 'delete:Accounts']);
});

test('new user is rolled back when workspace ACL assignment fails', () => {
  const calls = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    PERMISSION_DENIED:'PERMISSION_DENIED',
    CONFLICT:'CONFLICT',
    WORKSPACE_NOT_FOUND:'WORKSPACE_NOT_FOUND',
    WORKSPACE_DENIED:'WORKSPACE_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE' },
    WORKSPACE_STATUS:{ ACTIVE:'ACTIVE' },
    WORKSPACE_TABS:{ MEMBERS:'Members' },
    AUDIT_EVENTS:{ USER_CREATED:'USER_CREATED' }
  };
  global.AuthorizationService = { assertRole() {} };
  global.Validation = {
    assertRequired() {},
    validateUsername(v){ return String(v).toLowerCase(); },
    validateRole(v){ return v; },
    validatePassword(v){ return v; },
    sanitizeCellValue(v){ return v; },
    validateEmail(v){ return String(v).toLowerCase(); },
    generateId(prefix){ return prefix === 'USR' ? 'USR-NEW' : prefix + '-1'; }
  };
  global.SecurityService = {
    generateRandomHex(){ return 'abcdef1234567890'; },
    hashPassword(){ return 'HASH'; }
  };
  global.LockService = {
    getScriptLock(){ return { waitLock(){}, releaseLock(){} }; }
  };
  global.SpreadsheetApp = { flush(){} };
  global.MasterRepository = {
    findAccountByUsername(){ return null; },
    getWorkspace(){ return { WorkspaceID:'W1', Status:'ACTIVE' }; },
    createAccount(){ calls.push('create-account'); },
    assignWorkspaceAccess(){
      calls.push('assign-access');
      throw new Error('access write failed');
    },
    rollbackUserCreation(userId){ calls.push('rollback:' + userId); },
    logGlobalAudit(){ calls.push('audit'); }
  };
  global.SheetRepository = {
    getMember(){ return null; },
    addMember(){ calls.push('add-member'); },
    deleteRow(){}
  };

  delete require.cache[require.resolve(servicePath)];
  const { UserService } = require(servicePath);

  assert.throws(
    () => UserService.createUser(
      { userId:'SA1', role:'SUPER_ADMIN' },
      {
        username:'newuser',
        displayName:'New User',
        role:'USER',
        primaryWorkspaceId:'W1',
        temporaryPassword:'Password123!'
      }
    ),
    /access write failed/
  );

  assert.deepEqual(calls, [
    'create-account',
    'assign-access',
    'rollback:USR-NEW'
  ]);
});

test('successful user provisioning commits account, ACL, member, then audit', () => {
  const calls = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    PERMISSION_DENIED:'PERMISSION_DENIED',
    CONFLICT:'CONFLICT',
    WORKSPACE_NOT_FOUND:'WORKSPACE_NOT_FOUND',
    WORKSPACE_DENIED:'WORKSPACE_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE' },
    WORKSPACE_STATUS:{ ACTIVE:'ACTIVE' },
    WORKSPACE_TABS:{ MEMBERS:'Members' },
    AUDIT_EVENTS:{ USER_CREATED:'USER_CREATED' }
  };
  global.AuthorizationService = { assertRole() {} };
  global.Validation = {
    assertRequired() {},
    validateUsername(v){ return String(v).toLowerCase(); },
    validateRole(v){ return v; },
    validatePassword(v){ return v; },
    sanitizeCellValue(v){ return v; },
    validateEmail(v){ return String(v).toLowerCase(); },
    generateId(prefix){ return prefix === 'USR' ? 'USR-NEW' : prefix + '-1'; }
  };
  global.SecurityService = {
    generateRandomHex(){ return 'abcdef1234567890'; },
    hashPassword(){ return 'HASH'; }
  };
  global.LockService = {
    getScriptLock(){ return { waitLock(){}, releaseLock(){} }; }
  };
  global.SpreadsheetApp = { flush(){} };
  global.MasterRepository = {
    findAccountByUsername(){ return null; },
    getWorkspace(){ return { WorkspaceID:'W1', Status:'ACTIVE' }; },
    createAccount(){ calls.push('create-account'); },
    assignWorkspaceAccess(){ calls.push('assign-access'); },
    rollbackUserCreation(){ calls.push('rollback'); },
    logGlobalAudit(){ calls.push('audit'); }
  };
  global.SheetRepository = {
    addMember(){ calls.push('add-member'); },
    getMember(){ return null; },
    deleteRow(){}
  };

  delete require.cache[require.resolve(servicePath)];
  const { UserService } = require(servicePath);
  const result = UserService.createUser(
    { userId:'SA1', role:'SUPER_ADMIN' },
    {
      username:'newuser',
      displayName:'New User',
      email:'newuser@example.com',
      role:'USER',
      primaryWorkspaceId:'W1',
      temporaryPassword:'Password123!'
    }
  );

  assert.equal(result.userId, 'USR-NEW');
  assert.deepEqual(calls, [
    'create-account',
    'assign-access',
    'add-member',
    'audit'
  ]);
});

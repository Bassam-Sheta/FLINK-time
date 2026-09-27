'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/BackupAndAuditServices.gs'
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

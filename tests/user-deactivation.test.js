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

function loadService(overrides = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    NOT_FOUND: 'NOT_FOUND',
    PERMISSION_DENIED: 'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', PASSIVE: 'PASSIVE' },
    WORKSPACE_STATUS: { ACTIVE: 'ACTIVE' },
    AUDIT_EVENTS: { USER_PASSIVE: 'USER_PASSIVE' }
  };
  global.AuthorizationService = {
    assertRole() {}
  };
  global.Validation = {};
  global.SecurityService = {};
  global.LockService = {
    getScriptLock() {
      return { waitLock() {}, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  Object.assign(global, overrides);
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).UserService;
}

test('deactivation finalizes active timer before account becomes passive', () => {
  const order = [];
  const account = {
    UserID: 'U1',
    Username: 'worker',
    Role: 'USER',
    Status: 'ACTIVE'
  };

  const UserService = loadService({
    MasterRepository: {
      findAccountById() { return account; },
      getWorkspaceAccessForUser() { return [{ WorkspaceID: 'W1' }]; },
      getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
      updateAccount(_id, updates) {
        order.push('account:' + updates.Status);
        return { ...account, ...updates };
      },
      logGlobalAudit() { order.push('audit'); }
    },
    SessionService: {
      revokeAllUserSessions() { order.push('sessions-revoked'); }
    },
    SheetRepository: {
      getActiveTimer() {
        return { TimerID: 'TMR-1', UserID: 'U1', StartedAtUTC: '2026-09-27T10:00:00.000Z' };
      },
      updateMember(_ws, _id, updates) {
        order.push('member:' + updates.Status);
      }
    },
    TimerService: {
      _finalizeActiveTimerLocked(ownerContext, ws, timer, payload, actor) {
        assert.equal(ownerContext.userId, 'U1');
        assert.equal(ws, 'W1');
        assert.equal(timer.TimerID, 'TMR-1');
        assert.equal(actor.userId, 'SA1');
        order.push('timer-finalized');
        return { EntryID: 'ENT-1', DurationSeconds: 1800 };
      }
    }
  });

  const result = UserService.makeUserPassive(
    { userId: 'SA1', role: 'SUPER_ADMIN' },
    'U1',
    'leaver'
  );

  assert.deepEqual(order.slice(0, 4), [
    'sessions-revoked',
    'timer-finalized',
    'member:PASSIVE',
    'account:PASSIVE'
  ]);
  assert.equal(result.finalizedTimers.length, 1);
  assert.equal(result.finalizedTimers[0].entryId, 'ENT-1');
});

test('deactivation does not mark account passive when timer finalization fails', () => {
  const updates = [];
  const account = { UserID: 'U1', Username: 'worker', Role: 'USER', Status: 'ACTIVE' };

  const UserService = loadService({
    MasterRepository: {
      findAccountById() { return account; },
      getWorkspaceAccessForUser() { return [{ WorkspaceID: 'W1' }]; },
      getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
      updateAccount(_id, patch) { updates.push(patch); },
      logGlobalAudit() {}
    },
    SessionService: { revokeAllUserSessions() {} },
    SheetRepository: {
      getActiveTimer() { return { TimerID: 'TMR-1', UserID: 'U1' }; },
      updateMember() {}
    },
    TimerService: {
      _finalizeActiveTimerLocked() {
        throw new Error('timer finalize failed');
      }
    }
  });

  assert.throws(
    () => UserService.makeUserPassive(
      { userId: 'SA1', role: 'SUPER_ADMIN' },
      'U1'
    ),
    /timer finalize failed/
  );

  assert.equal(
    updates.some(patch => patch.Status === 'PASSIVE'),
    false
  );
});

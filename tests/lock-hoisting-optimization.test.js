'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../apps-script/Code.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function setupLockSpy() {
  const events = [];
  global.LockService = {
    getScriptLock() {
      return {
        tryLock(timeout) {
          events.push({ action: 'tryLock', timeout });
          return true;
        },
        waitLock(timeout) {
          events.push({ action: 'waitLock', timeout });
        },
        releaseLock() {
          events.push({ action: 'releaseLock' });
        }
      };
    }
  };
  return events;
}

test('TimeEntryService.createManualEntry fails validation before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  global.CONSTANTS = { ROLES: { USER: 'USER' }, LIMITS: {} };
  global.AuthorizationService = { assertWorkspaceAccess() {} };
  global.TrackingPolicyService = {
    validateTrackingContext() { return {}; },
    assertEntryEditableByAge() {}
  };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const f of fields) {
        if (!obj[f]) throw new AppError('VALIDATION_ERROR', f + ' is required', 400);
      }
    },
    validateDateRange() { return -10; } // Duration <= 0
  };

  delete require.cache[require.resolve(servicePath)];
  const TimeEntryService = require(servicePath).TimeEntryService;

  assert.throws(
    () => TimeEntryService.createManualEntry({ userId: 'U1', role: 'USER' }, 'W1', {
      startUtc: '2026-10-01T10:00:00.000Z',
      endUtc: '2026-10-01T09:00:00.000Z'
    }),
    /duration must be greater than zero/
  );

  // Lock must NOT have been requested or acquired
  assert.equal(lockEvents.length, 0);
});

test('TimeEntryService.updateEntry fails missing expectedVersion before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  global.CONSTANTS = { ROLES: { USER: 'USER' } };
  global.AuthorizationService = { assertWorkspaceAccess() {} };

  delete require.cache[require.resolve(servicePath)];
  const TimeEntryService = require(servicePath).TimeEntryService;

  assert.throws(
    () => TimeEntryService.updateEntry(
      { userId: 'U1', role: 'USER' },
      'W1',
      'ENT-1',
      { description: 'new description' }
      // no expectedVersion
    ),
    /expectedVersion is required/
  );

  assert.equal(lockEvents.length, 0);
});

test('TimeEntryService.updateEntry fails malformed startUtc before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  global.CONSTANTS = { ROLES: { USER: 'USER' } };
  global.AuthorizationService = { assertWorkspaceAccess() {} };

  delete require.cache[require.resolve(servicePath)];
  const TimeEntryService = require(servicePath).TimeEntryService;

  assert.throws(
    () => TimeEntryService.updateEntry(
      { userId: 'U1', role: 'USER' },
      'W1',
      'ENT-1',
      { startUtc: 'invalid-iso-date', expectedVersion: 2 }
    ),
    /startUtc must be a valid timestamp/
  );

  assert.equal(lockEvents.length, 0);
});

test('TimeEntryService.bulkAction fails missing expectedVersion before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR', PERMISSION_DENIED: 'PERMISSION_DENIED' };
  global.CONSTANTS = { ROLES: { USER: 'USER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } };
  global.AuthorizationService = { assertWorkspaceAccess() {} };

  delete require.cache[require.resolve(servicePath)];
  const TimeEntryService = require(servicePath).TimeEntryService;

  assert.throws(
    () => TimeEntryService.bulkAction(
      { userId: 'U1', role: 'USER' },
      'W1',
      ['ENT-1', 'ENT-2'],
      'DELETE',
      { expectedVersions: { 'ENT-1': 1 } } // Missing ENT-2
    ),
    /Missing expected version for time entry ENT-2/
  );

  assert.equal(lockEvents.length, 0);
});

test('TimeEntryService.bulkAction fails missing projectId for CHANGE_PROJECT before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR', PERMISSION_DENIED: 'PERMISSION_DENIED' };
  global.CONSTANTS = { ROLES: { USER: 'USER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } };
  global.AuthorizationService = { assertWorkspaceAccess() {} };

  delete require.cache[require.resolve(servicePath)];
  const TimeEntryService = require(servicePath).TimeEntryService;

  assert.throws(
    () => TimeEntryService.bulkAction(
      { userId: 'U1', role: 'USER' },
      'W1',
      ['ENT-1'],
      'CHANGE_PROJECT',
      { expectedVersions: { 'ENT-1': 1 } } // Missing projectId
    ),
    /projectId is required for CHANGE_PROJECT/
  );

  assert.equal(lockEvents.length, 0);
});

test('TimesheetService.submitTimesheet fails non-canonical week bounds before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  global.CONSTANTS = { ROLES: { USER: 'USER' } };
  global.AuthorizationService = { assertWorkspaceAccess() {} };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const f of fields) {
        if (!obj[f]) throw new AppError('VALIDATION_ERROR', f + ' is required', 400);
      }
    }
  };
  global.TimezoneService = {
    getWeekBounds() {
      return {
        startUtc: new Date('2026-09-27T00:00:00.000Z'),
        endUtc: new Date('2026-10-04T00:00:00.000Z'),
        startLocalDate: '2026-09-27',
        endLocalDate: '2026-10-04',
        timezone: 'Africa/Cairo'
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const TimesheetService = require(servicePath).TimesheetService;

  assert.throws(
    () => TimesheetService.submitTimesheet(
      { userId: 'U1', role: 'USER' },
      'W1',
      {
        periodStart: '2026-09-28T00:00:00.000Z', // Mismatched start
        periodEnd: '2026-10-04T00:00:00.000Z'
      }
    ),
    /Timesheet period must match the configured workspace week/
  );

  assert.equal(lockEvents.length, 0);
});

test('ApprovalService timesheet review methods fail missing timesheetId before LockService lock acquisition', () => {
  const lockEvents = setupLockSpy();

  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR: 'VALIDATION_ERROR' };
  global.CONSTANTS = { ROLES: { ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' } };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole() {}
  };

  delete require.cache[require.resolve(servicePath)];
  const ApprovalService = require(servicePath).ApprovalService;

  // approveTimesheet without timesheetId
  assert.throws(
    () => ApprovalService.approveTimesheet({ userId: 'A1', role: 'ADMIN' }, 'W1', ''),
    /timesheetId is required/
  );
  assert.equal(lockEvents.length, 0);

  // rejectTimesheet without timesheetId
  assert.throws(
    () => ApprovalService.rejectTimesheet({ userId: 'A1', role: 'ADMIN' }, 'W1', '', 'rejection comment'),
    /timesheetId is required/
  );
  assert.equal(lockEvents.length, 0);

  // reopenTimesheet without timesheetId
  assert.throws(
    () => ApprovalService.reopenTimesheet({ userId: 'SA1', role: 'SUPER_ADMIN' }, 'W1', '', 'reopen reason'),
    /timesheetId is required/
  );
  assert.equal(lockEvents.length, 0);
});

test('AuthService.changePassword computes PBKDF2 hash before LockService lock acquisition', () => {
  const order = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    UNAUTHORIZED: 'UNAUTHORIZED'
  };
  global.CONSTANTS = {
    ROLES: { USER: 'USER' },
    LIMITS: { RESET_PASSWORD_TTL_MINUTES: 60 }
  };
  global.Validation = {
    validatePassword() {}
  };
  global.SessionService = {
    validateSession() {
      return {
        userId: 'U1',
        role: 'USER',
        user: { Email: 'u1@example.com' },
        session: { ClientType: 'WEB' }
      };
    },
    revokeAllUserSessions() {},
    createSession() {
      return { sessionToken: 'NEW_TOKEN', expiresAt: 'later' };
    }
  };
  global.SecurityService = {
    hashPassword() {
      order.push('hashPassword');
      return 'NEW_PBKDF2_HASH';
    },
    verifyPassword(pwd, hash) {
      if (pwd === 'CurrentPass123!' && hash === 'OLD_HASH') return true;
      return false;
    }
  };
  global.MasterRepository = {
    getCredentials() {
      return {
        UserID: 'U1',
        PasswordHash: 'OLD_HASH',
        PasswordVersion: 1
      };
    },
    updateCredentials() {},
    updateAccount() {},
    logSecurityEvent() {}
  };
  global.IdentityService = {
    getCurrentGoogleEmail() { return 'u1@example.com'; }
  };
  global.LockService = {
    getScriptLock() {
      return {
        waitLock() {
          order.push('waitLock');
        },
        releaseLock() {
          order.push('releaseLock');
        }
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const AuthService = require(servicePath).AuthService;
  AuthService._mfaChallengeMemory = {};
  AuthService._mfaEnrollmentMemory = {};

  AuthService.changePassword('VALID_TOKEN', 'CurrentPass123!', 'NewPass456!');

  assert.deepEqual(order, ['hashPassword', 'waitLock', 'releaseLock']);
});

test('AuthService.resetPasswordByAdmin computes PBKDF2 hash before LockService lock acquisition', () => {
  const order = [];

  global.AppError = AppError;
  global.ERROR_CODES = {
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', LOCKED: 'LOCKED' },
    LIMITS: { RESET_PASSWORD_TTL_MINUTES: 60 }
  };
  global.AuthorizationService = { assertRole() {} };
  global.Validation = {
    assertRequired() {},
    validatePassword() {}
  };
  global.SecurityService = {
    hashPassword() {
      order.push('hashPassword');
      return 'NEW_PBKDF2_HASH';
    },
    verifyPassword(pwd, hash) {
      return pwd === hash; // false if different
    }
  };
  global.MasterRepository = {
    findAccountById() {
      return { UserID: 'U2', Status: 'ACTIVE' };
    },
    getCredentials() {
      return {
        UserID: 'U2',
        PasswordHash: 'CURRENT_HASH',
        PasswordVersion: 1
      };
    },
    updateCredentials() {},
    updateAccount() {},
    logGlobalAudit() {}
  };
  global.LockService = {
    getScriptLock() {
      return {
        waitLock() {
          order.push('waitLock');
        },
        releaseLock() {
          order.push('releaseLock');
        }
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const AuthService = require(servicePath).AuthService;

  AuthService.resetPasswordByAdmin(
    { userId: 'SA1', role: 'SUPER_ADMIN' },
    'U2',
    'TempPass789!'
  );

  assert.deepEqual(order, ['hashPassword', 'waitLock', 'releaseLock']);
});

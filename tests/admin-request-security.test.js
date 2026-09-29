'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/AdminRequestService.gs'
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
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED',
    PERMISSION_DENIED: 'PERMISSION_DENIED',
    CONFLICT: 'CONFLICT'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    REQUEST_TYPES: {
      NEW_USER: 'NEW_USER',
      MAKE_PASSIVE: 'MAKE_PASSIVE',
      PASSWORD_RESET: 'PASSWORD_RESET'
    },
    REQUEST_STATUS: {
      PENDING: 'PENDING',
      APPROVED: 'APPROVED',
      REJECTED: 'REJECTED',
      EXECUTED: 'EXECUTED'
    },
    WORKSPACE_STATUS: {
      ACTIVE: 'ACTIVE',
      SUSPENDED: 'SUSPENDED'
    },
    AUDIT_EVENTS: {
      REQUEST_SUBMITTED: 'REQUEST_SUBMITTED',
      REQUEST_EXECUTED: 'REQUEST_EXECUTED'
    }
  };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const field of fields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
          throw new AppError('VALIDATION_ERROR', 'Missing ' + field);
        }
      }
    },
    generateId() { return 'REQ-1'; },
    sanitizeCellValue(v) { return String(v); },
    sanitizeRow(v) { return v; },
    validateEmail(v) { return String(v).toLowerCase(); }
  };
  global.AuthorizationService = {
    assertRole() {},
    assertWorkspaceAccess() {}
  };
  global.SecurityService = {
    generateRandomHex() { return 'abcdef12'; }
  };
  global.LockService = {
    getScriptLock() {
      return { waitLock() {}, releaseLock() {} };
    }
  };
  Object.assign(global, overrides);
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).AdminRequestService;
}

test('Admin cannot submit lifecycle request for user outside originating workspace', () => {
  const writes = [];
  const svc = loadService({
    MasterRepository: {
      findAccountById() { return { UserID: 'U2', Role: 'USER' }; },
      getWorkspaceAccessForUser() { return [{ WorkspaceID: 'OTHER' }]; },
      createRequest(r) { writes.push(r); },
      logGlobalAudit() {}
    }
  });

  assert.throws(
    () => svc.submitRequest(
      { userId: 'A1', role: 'ADMIN' },
      {
        requestType: 'MAKE_PASSIVE',
        workspaceId: 'W1',
        targetUserId: 'U2',
        reason: 'test'
      }
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED' &&
      err.statusCode === 403
  );

  assert.deepEqual(writes, []);
});

test('Admin NEW_USER request cannot request ADMIN role', () => {
  const svc = loadService({
    MasterRepository: {
      createRequest() {},
      logGlobalAudit() {}
    }
  });

  assert.throws(
    () => svc.submitRequest(
      { userId: 'A1', role: 'ADMIN' },
      {
        requestType: 'NEW_USER',
        workspaceId: 'W1',
        reason: 'new admin',
        requestedData: { username: 'candidate', displayName: 'Candidate', email: 'candidate@example.com', role: 'ADMIN' }
      }
    ),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED'
  );
});

test('approved lifecycle request revalidates target workspace membership', () => {
  let executed = false;
  const req = {
    RequestID: 'REQ-1',
    RequestType: 'PASSWORD_RESET',
    RequestedBy: 'A1',
    WorkspaceID: 'W1',
    TargetUserID: 'U2',
    Status: 'PENDING',
    RequestedDataJSON: '{}',
    Reason: 'reset'
  };

  const svc = loadService({
    MasterRepository: {
      getRequest() { return req; },
      findAccountById() { return { UserID: 'U2', Role: 'USER' }; },
      getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
      getWorkspaceAccessForUser() { return []; },
      updateRequest(_id, patch) {
        Object.assign(req, patch);
        return { ...req };
      },
      logGlobalAudit() {}
    },
    AuthService: {
      resetPasswordByAdmin() { executed = true; }
    },
    UserService: {
      makeUserPassive() { executed = true; },
      createUser() { executed = true; }
    }
  });

  assert.throws(
    () => svc.reviewRequest(
      { userId: 'SA1', role: 'SUPER_ADMIN' },
      'REQ-1',
      { action: 'APPROVE' }
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED'
  );
  assert.equal(executed, false);
  assert.equal(req.Status, 'PENDING', 'failed execution must release the APPROVED claim for retry');
});

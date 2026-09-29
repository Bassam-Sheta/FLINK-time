'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Admin.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function installBase(overrides = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    VALIDATION_ERROR:'VALIDATION_ERROR',
    NOT_FOUND:'NOT_FOUND',
    CONFLICT:'CONFLICT',
    PERMISSION_DENIED:'PERMISSION_DENIED',
    WORKSPACE_DENIED:'WORKSPACE_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    WORKSPACE_STATUS:{ ACTIVE:'ACTIVE', SUSPENDED:'SUSPENDED' },
    REQUEST_TYPES:{
      NEW_USER:'NEW_USER',
      MAKE_PASSIVE:'MAKE_PASSIVE',
      PASSWORD_RESET:'PASSWORD_RESET',
      PROFILE_CHANGE:'PROFILE_CHANGE',
      OTHER_ADMIN_REQUEST:'OTHER_ADMIN_REQUEST'
    },
    REQUEST_STATUS:{
      PENDING:'PENDING',
      APPROVED:'APPROVED',
      REJECTED:'REJECTED',
      CANCELLED:'CANCELLED',
      EXECUTED:'EXECUTED'
    },
    AUDIT_EVENTS:{
      REQUEST_SUBMITTED:'REQUEST_SUBMITTED',
      REQUEST_EXECUTED:'REQUEST_EXECUTED'
    }
  };
  global.AuthorizationService = {
    assertRole() {},
    assertWorkspaceAccess() {}
  };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const field of fields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
          throw new AppError('VALIDATION_ERROR', field + ' required');
        }
      }
    },
    sanitizeCellValue(v) { return String(v); },
    sanitizeRow(v) { return { ...v }; },
    validateEmail(v) { return String(v).toLowerCase(); },
    generateId() { return 'REQ-1'; }
  };
  global.SecurityService = {
    generateRandomHex() { return 'abcd1234'; }
  };
  global.AuthService = {
    resetPasswordByAdmin() { return { ok:true }; }
  };
  global.UserService = {
    createUser() { return { userId:'U-NEW' }; },
    makeUserPassive() { return { ok:true }; }
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

test('Admin lifecycle request cannot target another Admin account', () => {
  let creates = 0;
  const service = installBase({
    MasterRepository:{
      findAccountById() {
        return { UserID:'A2', Role:'ADMIN' };
      },
      getWorkspaceAccessForUser() {
        return [{ WorkspaceID:'W1', Active:true }];
      },
      createRequest() { creates += 1; }
    }
  });

  assert.throws(
    () => service.submitRequest(
      { userId:'A1', role:'ADMIN' },
      {
        requestType:'MAKE_PASSIVE',
        workspaceId:'W1',
        targetUserId:'A2',
        reason:'test'
      }
    ),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED'
  );
  assert.equal(creates, 0);
});

test('NEW_USER request requires concrete username and displayName at submission time', () => {
  let creates = 0;
  const service = installBase({
    MasterRepository:{
      createRequest() { creates += 1; },
      logGlobalAudit() {}
    }
  });

  assert.throws(
    () => service.submitRequest(
      { userId:'A1', role:'ADMIN' },
      {
        requestType:'NEW_USER',
        workspaceId:'W1',
        requestedData:{ username:'worker' },
        reason:'new hire'
      }
    ),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR'
  );
  assert.equal(creates, 0);
});

test('Admin request visibility follows current workspace ACL only', () => {
  const service = installBase({
    MasterRepository:{
      getWorkspaceAccessForUser() {
        return [{ WorkspaceID:'W1', Active:true }];
      },
      listRequests() {
        return [
          { RequestID:'R1', WorkspaceID:'W1', RequestedBy:'A1' },
          { RequestID:'R2', WorkspaceID:'W2', RequestedBy:'A1' }
        ];
      }
    }
  });

  const rows = service.listRequests({ userId:'A1', role:'ADMIN' });
  assert.deepEqual(rows.map(r => r.RequestID), ['R1']);

  assert.throws(
    () => service.listRequests({ userId:'A1', role:'ADMIN' }, null, 'W2'),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED'
  );
});

test('approval claims request before nested execution and completes exactly once', () => {
  const order = [];
  const req = {
    RequestID:'R1',
    RequestType:'NEW_USER',
    RequestedBy:'A1',
    WorkspaceID:'W1',
    TargetUserID:'',
    RequestedDataJSON:JSON.stringify({
      username:'worker',
      displayName:'Worker',
      email:'worker@example.com'
    }),
    Reason:'new hire',
    Status:'PENDING'
  };

  const service = installBase({
    LockService:{
      getScriptLock() {
        return {
          waitLock() { order.push('lock'); },
          releaseLock() { order.push('unlock'); }
        };
      }
    },
    MasterRepository:{
      getRequest() { return req; },
      updateRequest(_id, patch) {
        order.push('status:' + patch.Status);
        Object.assign(req, patch);
        return { ...req };
      },
      getWorkspace() {
        return { WorkspaceID:'W1', Status:'ACTIVE' };
      },
      logGlobalAudit() { order.push('audit'); }
    },
    UserService:{
      createUser() {
        order.push('execute');
        assert.equal(req.Status, 'APPROVED');
        assert.ok(order.indexOf('unlock') < order.indexOf('execute'));
        return { userId:'U-NEW' };
      },
      makeUserPassive() { throw new Error('not expected'); }
    }
  });

  const result = service.reviewRequest(
    { userId:'SA1', role:'SUPER_ADMIN' },
    'R1',
    { action:'APPROVE' }
  );

  assert.equal(result.request.Status, 'EXECUTED');
  assert.deepEqual(
    order.filter(x => x.startsWith('status:') || x === 'execute'),
    ['status:APPROVED', 'execute', 'status:EXECUTED']
  );
});

test('already claimed request cannot execute a second time', () => {
  let executions = 0;
  const req = {
    RequestID:'R1',
    RequestType:'NEW_USER',
    WorkspaceID:'W1',
    Status:'APPROVED'
  };

  const service = installBase({
    MasterRepository:{
      getRequest() { return req; }
    },
    UserService:{
      createUser() { executions += 1; return {}; },
      makeUserPassive() { return {}; }
    }
  });

  assert.throws(
    () => service.reviewRequest(
      { userId:'SA2', role:'SUPER_ADMIN' },
      'R1',
      { action:'APPROVE' }
    ),
    err => err instanceof AppError &&
      err.code === 'CONFLICT'
  );
  assert.equal(executions, 0);
});

test('failed execution releases claim back to PENDING for controlled retry', () => {
  const statuses = [];
  const req = {
    RequestID:'R1',
    RequestType:'NEW_USER',
    WorkspaceID:'W1',
    RequestedDataJSON:JSON.stringify({
      username:'worker',
      displayName:'Worker',
      email:'worker@example.com'
    }),
    Status:'PENDING'
  };

  const service = installBase({
    MasterRepository:{
      getRequest() { return req; },
      updateRequest(_id, patch) {
        if (patch.Status) statuses.push(patch.Status);
        Object.assign(req, patch);
        return { ...req };
      },
      getWorkspace() {
        return { WorkspaceID:'W1', Status:'ACTIVE' };
      },
      logGlobalAudit() {}
    },
    UserService:{
      createUser() { throw new Error('provision failed'); },
      makeUserPassive() { return {}; }
    }
  });

  assert.throws(
    () => service.reviewRequest(
      { userId:'SA1', role:'SUPER_ADMIN' },
      'R1',
      { action:'APPROVE' }
    ),
    /provision failed/
  );

  assert.deepEqual(statuses, ['APPROVED', 'PENDING']);
  assert.equal(req.Status, 'PENDING');
});

test('request from inactive originating workspace cannot execute', () => {
  const statuses = [];
  const req = {
    RequestID:'R1',
    RequestType:'NEW_USER',
    WorkspaceID:'W1',
    RequestedDataJSON:JSON.stringify({
      username:'worker',
      displayName:'Worker',
      email:'worker@example.com'
    }),
    Status:'PENDING'
  };

  const service = installBase({
    MasterRepository:{
      getRequest() { return req; },
      updateRequest(_id, patch) {
        if (patch.Status) statuses.push(patch.Status);
        Object.assign(req, patch);
        return { ...req };
      },
      getWorkspace() {
        return { WorkspaceID:'W1', Status:'SUSPENDED' };
      },
      logGlobalAudit() {}
    }
  });

  assert.throws(
    () => service.reviewRequest(
      { userId:'SA1', role:'SUPER_ADMIN' },
      'R1',
      { action:'APPROVE' }
    ),
    err => err instanceof AppError &&
      err.code === 'WORKSPACE_DENIED'
  );

  assert.deepEqual(statuses, ['APPROVED', 'PENDING']);
});

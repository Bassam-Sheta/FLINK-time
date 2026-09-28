'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
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

function load(accesses, workspaceStates) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED'
  };
  global.CONSTANTS = {
    ROLES: { ADMIN: 'ADMIN' },
    WORKSPACE_STATUS: {
      ACTIVE: 'ACTIVE',
      SUSPENDED: 'SUSPENDED',
      MAINTENANCE: 'MAINTENANCE',
      ARCHIVED: 'ARCHIVED'
    },
    LIMITS: { ADMIN_MAX_ACTIVE_WORKSPACES: 3 }
  };
  global.MasterRepository = {
    getWorkspaceAccessForUser() { return accesses; },
    getWorkspace(id) {
      return { WorkspaceID: id, Status: workspaceStates[id] || 'ACTIVE' };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return require(servicePath).AuthorizationService;
}

test('Admin may be assigned to first, second, and third active workspace', () => {
  for (let current = 0; current < 3; current++) {
    const accesses = Array.from({ length: current }, (_, i) => ({
      WorkspaceID: 'W' + (i + 1),
      Role: 'ADMIN',
      Active: true
    }));
    const states = Object.fromEntries(accesses.map(a => [a.WorkspaceID, 'ACTIVE']));
    states.WNEW = 'ACTIVE';

    const service = load(accesses, states);
    assert.doesNotThrow(() => service.assertAdminWorkspaceLimit('A1', 'WNEW'));
  }
});

test('fourth active workspace assignment is rejected', () => {
  const accesses = ['W1','W2','W3'].map(id => ({
    WorkspaceID: id,
    Role: 'ADMIN',
    Active: true
  }));
  const service = load(accesses, {
    W1:'ACTIVE', W2:'ACTIVE', W3:'ACTIVE', W4:'ACTIVE'
  });

  assert.throws(
    () => service.assertAdminWorkspaceLimit('A1', 'W4'),
    err => err instanceof AppError &&
      err.code === 'ADMIN_LIMIT_EXCEEDED'
  );
});

test('suspended workspace ACL does not consume one of the three active Admin slots', () => {
  const accesses = [
    { WorkspaceID:'W1', Role:'ADMIN', Active:true },
    { WorkspaceID:'W2', Role:'ADMIN', Active:true },
    { WorkspaceID:'W3', Role:'ADMIN', Active:true }
  ];
  const service = load(accesses, {
    W1:'ACTIVE',
    W2:'ACTIVE',
    W3:'SUSPENDED',
    W4:'ACTIVE'
  });

  assert.doesNotThrow(() => service.assertAdminWorkspaceLimit('A1', 'W4'));
});

test('reassigning an already active workspace remains idempotently allowed at the limit', () => {
  const accesses = ['W1','W2','W3'].map(id => ({
    WorkspaceID: id,
    Role: 'ADMIN',
    Active: true
  }));
  const service = load(accesses, {
    W1:'ACTIVE', W2:'ACTIVE', W3:'ACTIVE'
  });

  assert.doesNotThrow(() => service.assertAdminWorkspaceLimit('A1', 'W2'));
});

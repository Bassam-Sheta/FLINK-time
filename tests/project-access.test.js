'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const policyPath = path.resolve(
  __dirname,
  '../apps-script/Security.gs'
);
const masterDataPath = path.resolve(
  __dirname,
  '../apps-script/Business.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function install(rows) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    PERMISSION_DENIED:'PERMISSION_DENIED',
    VALIDATION_ERROR:'VALIDATION_ERROR',
    NOT_FOUND:'NOT_FOUND'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' }
  };
  global.MasterRepository = {
    getGlobalSetting(_key, fallback) { return fallback; }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole() {}
  };
  global.Validation = {
    sanitizeCellValue(v) { return String(v); },
    assertRequired() {},
    generateId(prefix) { return prefix + '-1'; }
  };
  global.SheetRepository = {
    listAllUserProjectAccess() { return rows; },
    getProject(_ws,id) {
      return { ProjectID:id, Status:'ACTIVE', BillableDefault:true };
    },
    getTask() { return null; },
    listTags() { return []; },
    listProjects() {
      return [
        { ProjectID:'P1', ProjectName:'One', Status:'ACTIVE' },
        { ProjectID:'P2', ProjectName:'Two', Status:'ACTIVE' }
      ];
    },
    listTasks() { return []; }
  };

  delete require.cache[require.resolve(policyPath)];
  global.TrackingPolicyService = require(policyPath).TrackingPolicyService;
  return global.TrackingPolicyService;
}

test('workspace with no project ACL rows keeps legacy active-project access', () => {
  const policy = install([]);
  assert.doesNotThrow(() => policy.assertProjectAccess(
    { userId:'U1', role:'USER' }, 'W1', 'P1'
  ));
});

test('once workspace project ACL mode exists, unassigned user is denied', () => {
  const policy = install([
    { UserID:'OTHER', ProjectID:'P1', CanTrack:true }
  ]);

  assert.throws(
    () => policy.assertProjectAccess(
      { userId:'U1', role:'USER' }, 'W1', 'P1'
    ),
    err => err instanceof AppError &&
      err.code === 'PERMISSION_DENIED' &&
      err.statusCode === 403
  );
});

test('explicit CanTrack false denies and true grants', () => {
  let policy = install([
    { UserID:'U1', ProjectID:'P1', CanTrack:false }
  ]);
  assert.throws(
    () => policy.assertProjectAccess(
      { userId:'U1', role:'USER' }, 'W1', 'P1'
    ),
    /not authorized/
  );

  policy = install([
    { UserID:'U1', ProjectID:'P1', CanTrack:true }
  ]);
  assert.doesNotThrow(() => policy.assertProjectAccess(
    { userId:'U1', role:'USER' }, 'W1', 'P1'
  ));
});

test('ProjectService list uses the same workspace-wide ACL mode', () => {
  install([
    { UserID:'OTHER', ProjectID:'P2', CanTrack:true },
    { UserID:'U1', ProjectID:'P1', CanTrack:true }
  ]);

  delete require.cache[require.resolve(masterDataPath)];
  const { ProjectService } = require(masterDataPath);
  const projects = ProjectService.listProjects(
    { userId:'U1', role:'USER' },
    'W1'
  );

  assert.deepEqual(projects.map(p => p.ProjectID), ['P1']);
});

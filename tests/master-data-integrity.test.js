'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
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

function loadFixture(overrides = {}) {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR:'VALIDATION_ERROR',
    NOT_FOUND:'NOT_FOUND',
    CONFLICT:'CONFLICT',
    PERMISSION_DENIED:'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    AUDIT_EVENTS:{ PROJECT_CREATED:'PROJECT_CREATED', PROJECT_UPDATED:'PROJECT_UPDATED' }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole() {}
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
    generateId(prefix) { return prefix + '-1'; }
  };
  global.TrackingPolicyService = {
    _toBoolean(v) { return v === true || v === 'TRUE' || v === 1; },
    getProjectAccessState() { return { aclEnabled:false, allowedProjectIds:null }; },
    assertProjectAccess() {}
  };
  global.SheetRepository = {
    listClients() { return []; },
    getClient() { return null; },
    createClient() {},
    listProjects() { return []; },
    getProject() { return null; },
    createProject() {},
    updateProject(_ws,_id,updates) { return { ProjectID:'P1', ...updates }; },
    listTasks() { return []; },
    createTask() {},
    listTags() { return []; },
    createTag() {},
    listActiveTimers() { return []; },
    logWorkspaceAudit() {},
    ...overrides
  };

  delete require.cache[require.resolve(servicePath)];
  return require(servicePath);
}

test('duplicate active client names are rejected case-insensitively', () => {
  let writes = 0;
  const { ClientService } = loadFixture({
    listClients() {
      return [{ ClientID:'C1', ClientName:'Acme', Status:'ACTIVE' }];
    },
    createClient() { writes += 1; }
  });

  assert.throws(
    () => ClientService.createClient(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { clientName:' acme ' }
    ),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(writes, 0);
});

test('project creation rejects inactive client and invalid financial/date inputs', () => {
  const { ProjectService } = loadFixture({
    getClient() { return { ClientID:'C1', Status:'ARCHIVED' }; }
  });

  assert.throws(
    () => ProjectService.createProject(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { projectName:'P', clientId:'C1' }
    ),
    /not active/
  );

  const { ProjectService: ProjectService2 } = loadFixture({
    getClient() { return { ClientID:'C1', Status:'ACTIVE' }; }
  });

  assert.throws(
    () => ProjectService2.createProject(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { projectName:'P', clientId:'C1', hourlyRate:-1 }
    ),
    /non-negative/
  );

  assert.throws(
    () => ProjectService2.createProject(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { projectName:'P', startDate:'2026-10-10', endDate:'2026-10-01' }
    ),
    /before startDate/
  );
});

test('project cannot be made inactive while a running timer references it', () => {
  let writes = 0;
  const { ProjectService } = loadFixture({
    getProject() { return { ProjectID:'P1', Status:'ACTIVE' }; },
    listActiveTimers() { return [{ TimerID:'T1', ProjectID:'P1' }]; },
    updateProject() { writes += 1; return {}; }
  });

  assert.throws(
    () => ProjectService.updateProject(
      { userId:'A1', role:'ADMIN' },
      'W1',
      'P1',
      { status:'ARCHIVED' }
    ),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(writes, 0);
});

test('duplicate active task name in the same project is rejected', () => {
  let writes = 0;
  const { TaskService } = loadFixture({
    getProject() { return { ProjectID:'P1', Status:'ACTIVE' }; },
    listTasks() {
      return [{ TaskID:'T1', ProjectID:'P1', TaskName:'Research', Status:'OPEN' }];
    },
    createTask() { writes += 1; }
  });

  assert.throws(
    () => TaskService.createTask(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { projectId:'P1', taskName:' research ' }
    ),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(writes, 0);
});

test('duplicate active tag names are rejected', () => {
  let writes = 0;
  const { TagService } = loadFixture({
    listTags() {
      return [{ TagID:'TAG1', TagName:'Billable', Status:'ACTIVE' }];
    },
    createTag() { writes += 1; }
  });

  assert.throws(
    () => TagService.createTag(
      { userId:'A1', role:'ADMIN' },
      'W1',
      { tagName:'billable' }
    ),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(writes, 0);
});

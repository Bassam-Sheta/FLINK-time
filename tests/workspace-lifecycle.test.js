'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const routerPath = path.resolve(__dirname, '../apps-script/Code.gs');
const servicePath = path.resolve(__dirname, '../apps-script/Code.gs');
const repoPath = path.resolve(__dirname, '../apps-script/Code.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function installCommon() {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    NOT_FOUND: 'NOT_FOUND'
  };
  global.CONSTANTS = {
    SCHEMA_VERSION: 1,
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    WORKSPACE_STATUS: {
      ACTIVE: 'ACTIVE',
      SUSPENDED: 'SUSPENDED',
      MAINTENANCE: 'MAINTENANCE',
      ARCHIVED: 'ARCHIVED'
    },
    MASTER_TABS: { WORKSPACES: 'Workspaces' }
  };
}

test('WorkspaceRouter rejects every non-ACTIVE lifecycle state', () => {
  installCommon();

  for (const state of ['SUSPENDED', 'MAINTENANCE', 'ARCHIVED']) {
    global.MasterRepository = {
      getWorkspace() {
        return { WorkspaceID: 'W1', SpreadsheetID: 'S1', Status: state };
      }
    };
    global.SpreadsheetApp = { openById() { throw new Error('must not open'); } };

    delete require.cache[require.resolve(routerPath)];
    const { WorkspaceRouter } = require(routerPath);
    WorkspaceRouter.clearCache();

    assert.throws(
      () => WorkspaceRouter.resolveSpreadsheet('W1'),
      err => err instanceof AppError &&
        ['WORKSPACE_DENIED', 'WORKSPACE_NOT_FOUND'].includes(err.code)
    );
  }
});

test('Admin/User workspace list hides suspended and maintenance workspaces', () => {
  installCommon();
  global.MasterRepository = {
    listWorkspaces() {
      return [
        { WorkspaceID:'W1', WorkspaceName:'Active', Status:'ACTIVE' },
        { WorkspaceID:'W2', WorkspaceName:'Suspended', Status:'SUSPENDED' },
        { WorkspaceID:'W3', WorkspaceName:'Maintenance', Status:'MAINTENANCE' },
        { WorkspaceID:'W4', WorkspaceName:'Archived', Status:'ARCHIVED' }
      ];
    },
    getWorkspaceAccessForUser() {
      return [
        { WorkspaceID:'W1', Active:true },
        { WorkspaceID:'W2', Active:true },
        { WorkspaceID:'W3', Active:true },
        { WorkspaceID:'W4', Active:true }
      ];
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const { WorkspaceService } = require(servicePath);

  const rows = WorkspaceService.listWorkspaces({ userId:'A1', role:'ADMIN' });
  assert.deepEqual(rows.map(r => r.WorkspaceID), ['W1']);
});

test('workspace status update invalidates warm router cache', () => {
  installCommon();
  let cleared = 0;
  global.WorkspaceRouter = { clearCache() { cleared += 1; } };
  global.MasterRepository = undefined;
  global.MASTER_SCHEMA = {};
  global.WORKSPACE_SCHEMA = {};
  global.SecurityService = {};
  global.Validation = {};
  global.SpreadsheetApp = undefined;
  global.PropertiesService = undefined;

  delete require.cache[require.resolve(repoPath)];
  const { MasterRepository } = require(repoPath);

  MasterRepository.getTableData = () => ({
    rows: [{ WorkspaceID:'W1', _rowIndex:2, Status:'ACTIVE', SpreadsheetID:'S1' }]
  });
  MasterRepository.updateRow = () => {};

  MasterRepository.updateWorkspace('W1', { Status:'MAINTENANCE' });
  assert.equal(cleared, 1);
});

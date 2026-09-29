'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/TimesheetService.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

test('manager timesheet queue is workspace-scoped and returns a whitelisted DTO', () => {
  global.AppError = AppError;
  global.ERROR_CODES = { VALIDATION_ERROR:'VALIDATION_ERROR' };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    TIMESHEET_STATUS:{
      OPEN:'OPEN', SUBMITTED:'SUBMITTED',
      APPROVED:'APPROVED', REJECTED:'REJECTED'
    }
  };
  let workspaceChecks = 0;
  global.AuthorizationService = {
    assertWorkspaceAccess(_ctx,workspaceId) {
      workspaceChecks += 1;
      assert.equal(workspaceId,'W1');
    },
    assertRole(ctx,roles) {
      assert.ok(roles.includes(ctx.role));
    }
  };
  global.SheetRepository = {
    listTimesheets(_ws,filters) {
      assert.equal(filters.status,'SUBMITTED');
      return [{
        _rowIndex:7,
        TimesheetID:'T1',
        UserID:'U1',
        PeriodStart:'2026-09-27T00:00:00Z',
        PeriodEnd:'2026-10-03T23:59:59Z',
        TotalSeconds:3600,
        Status:'SUBMITTED',
        SubmittedAt:'2026-10-04T00:00:00Z',
        EntrySnapshotJSON:'SECRET'
      }];
    },
    listMembers() {
      return [{ UserID:'U1', DisplayName:'Worker' }];
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const { TimesheetService } = require(servicePath);
  const rows = TimesheetService.listTimesheetsForManager(
    { userId:'A1', role:'ADMIN' },
    'W1',
    'submitted'
  );

  assert.equal(workspaceChecks,1);
  assert.equal(rows.length,1);
  assert.equal(rows[0].userName,'Worker');
  assert.equal(rows[0].timesheetId,'T1');
  assert.equal(Object.hasOwn(rows[0],'EntrySnapshotJSON'),false);
  assert.equal(Object.hasOwn(rows[0],'_rowIndex'),false);
});

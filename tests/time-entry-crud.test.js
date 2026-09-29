'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture(options = {}) {
  const writes = [];
  const creates = [];
  let rebuilds = 0;
  let records = 0;

  const stored = {
    EntryID:'E1',
    UserID:'U1',
    ProjectID:'P1',
    TaskID:'T1',
    Description:'original',
    Tags:'',
    StartUTC:'2026-09-28T08:00:00.000Z',
    EndUTC:'2026-09-28T09:00:00.000Z',
    DurationSeconds:3600,
    Billable:true,
    HourlyRateSnapshot:100,
    CostRateSnapshot:40,
    EntrySource:'MANUAL',
    ManualEntry:true,
    Status:'ACTIVE',
    ApprovalStatus:'OPEN',
    TimesheetID:'',
    Locked:false,
    CreatedAt:'2026-09-28T09:00:00.000Z',
    CreatedBy:'U1',
    UpdatedAt:'2026-09-28T09:00:00.000Z',
    UpdatedBy:'U1',
    DeletedAt:'',
    DeletedBy:'',
    Version:3,
    ...(options.entry || {})
  };

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR:'VALIDATION_ERROR',
    NOT_FOUND:'NOT_FOUND',
    CONFLICT:'CONFLICT',
    SERVER_BUSY:'SERVER_BUSY',
    ENTRY_LOCKED:'ENTRY_LOCKED',
    PERMISSION_DENIED:'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    ENTRY_SOURCE:{ MANUAL:'MANUAL' },
    TIMESHEET_STATUS:{ OPEN:'OPEN', SUBMITTED:'SUBMITTED', APPROVED:'APPROVED' },
    AUDIT_EVENTS:{
      ENTRY_CREATED:'ENTRY_CREATED',
      ENTRY_UPDATED:'ENTRY_UPDATED',
      ENTRY_DELETED:'ENTRY_DELETED'
    }
  };
  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRecordOwnership(ctx, ownerId) {
      if (ctx.role === 'USER' && ctx.userId !== ownerId) {
        throw new AppError('PERMISSION_DENIED', 'ownership denied', 403);
      }
    }
  };
  global.Validation = {
    assertRequired(obj, fields) {
      for (const field of fields) {
        if (obj[field] === undefined || obj[field] === null || obj[field] === '') {
          throw new AppError('VALIDATION_ERROR', field + ' required', 400);
        }
      }
    },
    validateDateRange(start, end) {
      const s = new Date(start).getTime();
      const e = new Date(end).getTime();
      if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) {
        throw new AppError('VALIDATION_ERROR', 'invalid range', 400);
      }
      return Math.round((e - s) / 1000);
    },
    generateId() { return 'ENT-NEW'; },
    assertRecordVersion(record, expected) {
      const current = parseInt(record.Version, 10) || 1;
      const exp = parseInt(expected, 10);
      if (current !== exp) {
        throw new AppError('CONFLICT', 'stale version', 409);
      }
    }
  };
  global.TrackingPolicyService = {
    validateTrackingContext(_ctx,_ws,payload) {
      const projectId = payload.projectId !== undefined ? payload.projectId : 'P1';
      return {
        projectId,
        taskId:payload.taskId !== undefined ? payload.taskId : 'T1',
        description:payload.description !== undefined ? payload.description : '',
        tagIdsCsv:Array.isArray(payload.tags) ? payload.tags.join(',') : (payload.tags || ''),
        billable:payload.billable !== undefined ? !!payload.billable : true,
        project:projectId ? {
          ProjectID:projectId,
          HourlyRate:projectId === 'P2' ? 250 : 999,
          CostRate:projectId === 'P2' ? 90 : 888
        } : null
      };
    },
    assertEntryEditableByAge(_ws, record) {
      if (options.rejectOld && new Date(record.EndUTC || record.StartUTC).getUTCFullYear() < 2026) {
        throw new AppError('PERMISSION_DENIED', 'outside edit window', 403);
      }
    }
  };
  global.LockService = {
    getScriptLock() {
      return {
        tryLock() { return true; },
        waitLock() {},
        releaseLock() {}
      };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.RollupService = {
    recordTimeEntry() {
      records += 1;
      if (options.rollupCreateFails) throw new Error('rollup failed');
    },
    rebuildRollups() { rebuilds += 1; },
    reconcileMutation() { rebuilds += 1; }
  };
  global.SheetRepository = {
    getEntry(_ws,id) { return id === stored.EntryID ? { ...stored } : null; },
    createTimeEntry(_ws,entry) { creates.push({ ...entry }); },
    updateTimeEntry(_ws,id,patch) {
      writes.push({ id, patch:{ ...patch } });
      Object.assign(stored, patch);
      return { ...stored };
    },
    listTimeEntries() { return [{ ...stored }]; },
    logWorkspaceAudit() {}
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    service:require(servicePath).TimeEntryService,
    stored,
    writes,
    creates,
    getRebuilds:() => rebuilds,
    getRecords:() => records
  };
}

const user = { userId:'U1', role:'USER' };

test('manual create canonicalizes timestamps, rejects zero duration, and enforces past edit window', () => {
  let fx = fixture();
  const created = fx.service.createManualEntry(user, 'W1', {
    projectId:'P1',
    startUtc:'2026-09-28T10:00:00+02:00',
    endUtc:'2026-09-28T11:00:00+02:00',
    description:'manual'
  });
  assert.equal(created.startUtc, '2026-09-28T08:00:00.000Z');
  assert.equal(created.endUtc, '2026-09-28T09:00:00.000Z');
  assert.equal(created.durationSeconds, 3600);
  assert.equal(fx.creates.length, 1);

  fx = fixture();
  assert.throws(
    () => fx.service.createManualEntry(user, 'W1', {
      startUtc:'2026-09-28T08:00:00.000Z',
      endUtc:'2026-09-28T08:00:00.000Z'
    }),
    /greater than zero/
  );
  assert.equal(fx.creates.length, 0);

  fx = fixture({ rejectOld:true });
  assert.throws(
    () => fx.service.createManualEntry(user, 'W1', {
      startUtc:'2020-01-01T08:00:00.000Z',
      endUtc:'2020-01-01T09:00:00.000Z'
    }),
    /outside edit window/
  );
  assert.equal(fx.creates.length, 0);
});

test('invalid entry timestamps return controlled validation errors', () => {
  const fx = fixture();

  assert.throws(
    () => fx.service.createManualEntry(user, 'W1', {
      startUtc:'not-a-date',
      endUtc:'2026-09-28T09:00:00.000Z'
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400
  );

  assert.throws(
    () => fx.service.updateEntry(
      user,
      'W1',
      'E1',
      { startUtc:'not-a-date' },
      3
    ),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400
  );
});

test('manual create remains successful when incremental rollup maintenance fails', () => {
  const fx = fixture({ rollupCreateFails:true });
  const created = fx.service.createManualEntry(user, 'W1', {
    startUtc:'2026-09-28T08:00:00.000Z',
    endUtc:'2026-09-28T09:00:00.000Z'
  });
  assert.equal(created.entryId, 'ENT-NEW');
  assert.equal(fx.creates.length, 1);
});

test('update requires expectedVersion and rejects stale clients before write', () => {
  let fx = fixture();
  assert.throws(
    () => fx.service.updateEntry(user, 'W1', 'E1', { description:'new' }),
    /expectedVersion is required/
  );
  assert.equal(fx.writes.length, 0);

  fx = fixture();
  assert.throws(
    () => fx.service.updateEntry(
      user, 'W1', 'E1', { description:'new' }, 2
    ),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(fx.writes.length, 0);
});

test('successful update increments version and rejects moving entry outside edit window', () => {
  let fx = fixture();
  const updated = fx.service.updateEntry(
    user,
    'W1',
    'E1',
    { description:'new description' },
    3
  );
  assert.equal(updated.version, 4);
  assert.equal(fx.stored.Description, 'new description');

  fx = fixture({ rejectOld:true });
  assert.throws(
    () => fx.service.updateEntry(
      user,
      'W1',
      'E1',
      {
        startUtc:'2020-01-01T08:00:00.000Z',
        endUtc:'2020-01-01T09:00:00.000Z'
      },
      3
    ),
    /outside edit window/
  );
  assert.equal(fx.writes.length, 0);
});

test('update preserves historical rates when project ID is unchanged and refreshes on real project change', () => {
  let fx = fixture();
  fx.service.updateEntry(
    user,
    'W1',
    'E1',
    { projectId:'P1', description:'metadata edit' },
    3
  );
  assert.equal(fx.stored.HourlyRateSnapshot, 100);
  assert.equal(fx.stored.CostRateSnapshot, 40);

  fx = fixture();
  fx.service.updateEntry(
    user,
    'W1',
    'E1',
    { projectId:'P2', taskId:'T2' },
    3
  );
  assert.equal(fx.stored.HourlyRateSnapshot, 250);
  assert.equal(fx.stored.CostRateSnapshot, 90);
});

test('delete requires matching expectedVersion and increments version on success', () => {
  let fx = fixture();
  assert.throws(
    () => fx.service.deleteEntry(user, 'W1', 'E1'),
    /expectedVersion is required/
  );

  fx = fixture();
  assert.throws(
    () => fx.service.deleteEntry(user, 'W1', 'E1', 2),
    err => err instanceof AppError && err.code === 'CONFLICT'
  );
  assert.equal(fx.writes.length, 0);

  fx = fixture();
  const result = fx.service.deleteEntry(user, 'W1', 'E1', 3);
  assert.equal(result.version, 4);
  assert.equal(fx.stored.Status, 'DELETED');
  assert.equal(fx.stored.Version, 4);
  assert.equal(fx.getRebuilds(), 1);
});

test('record ownership still gates update and delete before mutation', () => {
  const fx = fixture({ entry:{ UserID:'OTHER' } });

  assert.throws(
    () => fx.service.updateEntry(
      user, 'W1', 'E1', { description:'x' }, 3
    ),
    err => err instanceof AppError && err.code === 'PERMISSION_DENIED'
  );
  assert.throws(
    () => fx.service.deleteEntry(user, 'W1', 'E1', 3),
    err => err instanceof AppError && err.code === 'PERMISSION_DENIED'
  );
  assert.equal(fx.writes.length, 0);
});

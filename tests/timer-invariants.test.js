'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

function fixture(options = {}) {
  const timers = { W1:null, W2:null };
  const entries = { W1:new Map(), W2:new Map() };
  let timerCreates = 0;
  let entryCreates = 0;
  let rollups = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR:'VALIDATION_ERROR',
    SERVER_BUSY:'SERVER_BUSY',
    ACTIVE_TIMER_EXISTS:'ACTIVE_TIMER_EXISTS',
    CONFLICT:'CONFLICT',
    TIMER_NOT_FOUND:'TIMER_NOT_FOUND'
  };
  global.CONSTANTS = {
    ROLES:{ SUPER_ADMIN:'SUPER_ADMIN', ADMIN:'ADMIN', USER:'USER' },
    WORKSPACE_STATUS:{ ACTIVE:'ACTIVE' },
    ENTRY_SOURCE:{ WEB:'WEB' },
    TIMESHEET_STATUS:{ OPEN:'OPEN' },
    AUDIT_EVENTS:{ TIMER_STARTED:'TIMER_STARTED', TIMER_STOPPED:'TIMER_STOPPED' },
    LIMITS:{ MAX_SINGLE_ENTRY_HOURS:24 }
  };
  global.AuthorizationService = { assertWorkspaceAccess() {} };
  global.MasterRepository = {
    getWorkspaceAccessForUser() {
      return [{ WorkspaceID:'W1' }, { WorkspaceID:'W2' }];
    },
    getWorkspace(id) {
      return { WorkspaceID:id, Status:'ACTIVE', Timezone:'UTC' };
    },
    listWorkspaces() {
      return [
        { WorkspaceID:'W1', Status:'ACTIVE' },
        { WorkspaceID:'W2', Status:'ACTIVE' }
      ];
    }
  };
  global.Validation = {
    generateId(prefix) { return prefix + '-LEGACY-' + Math.random().toString(36).slice(2); }
  };
  global.SecurityService = {
    hashToken(value) {
      return crypto.createHash('sha256').update(String(value)).digest('hex');
    }
  };
  global.TrackingPolicyService = {
    validateTrackingContext(_ctx,_ws,payload) {
      const projectId = payload.projectId || '';
      return {
        projectId,
        taskId:payload.taskId || '',
        description:payload.description || '',
        tagIdsCsv:Array.isArray(payload.tagIds) ? payload.tagIds.join(',') : (payload.tags || ''),
        billable:payload.billable !== undefined ? !!payload.billable : true,
        project:projectId ? {
          ProjectID:projectId,
          HourlyRate:100,
          CostRate:40
        } : null
      };
    }
  };
  global.LockService = {
    getScriptLock() {
      return { tryLock() { return true; }, releaseLock() {} };
    }
  };
  global.SpreadsheetApp = { flush() {} };
  global.RollupService = {
    recordTimeEntry() { rollups += 1; }
  };
  global.TimeEntryService = {
    toTimeEntryDTO(entry) {
      return {
        entryId:entry.EntryID,
        userId:entry.UserID,
        startUtc:entry.StartUTC,
        endUtc:entry.EndUTC,
        durationSeconds:entry.DurationSeconds,
        status:entry.Status
      };
    }
  };
  global.SheetRepository = {
    getActiveTimer(ws) {
      if (options.failScanWorkspace === ws) {
        throw new Error('scan failed');
      }
      return timers[ws];
    },
    createActiveTimer(ws, timer) {
      timerCreates += 1;
      timers[ws] = { ...timer };
    },
    deleteActiveTimer(ws) {
      if (options.failDelete) throw new Error('delete failed');
      if (!timers[ws]) return false;
      timers[ws] = null;
      return true;
    },
    getEntryAnyStatus(ws, id) {
      return entries[ws].get(id) || null;
    },
    createTimeEntry(ws, entry) {
      entryCreates += 1;
      if (entries[ws].has(entry.EntryID)) throw new Error('duplicate entry');
      entries[ws].set(entry.EntryID, { ...entry });
    },
    updateTimeEntry(ws, id, updates) {
      const current = entries[ws].get(id);
      if (!current) throw new Error('entry missing');
      const next = { ...current, ...updates };
      entries[ws].set(id, next);
      return next;
    },
    logWorkspaceAudit() {}
  };

  delete require.cache[require.resolve(servicePath)];
  const TimerService = require(servicePath).TimerService;

  return {
    TimerService,
    timers,
    entries,
    getTimerCreates:() => timerCreates,
    getEntryCreates:() => entryCreates,
    getRollups:() => rollups
  };
}

const user = { userId:'U1', role:'USER' };

test('global timer scan fails closed when an ACTIVE workspace cannot be inspected', () => {
  const fx = fixture({ failScanWorkspace:'W2' });

  assert.throws(
    () => fx.TimerService.startTimer(
      user,
      'W1',
      { operationId:'start-op-12345678' }
    ),
    err => err instanceof AppError &&
      err.code === 'SERVER_BUSY'
  );
  assert.equal(fx.getTimerCreates(), 0);
});

test('one active timer is enforced across workspaces under the global lock', () => {
  const fx = fixture();

  const first = fx.TimerService.startTimer(
    user,
    'W1',
    { operationId:'start-op-11111111', projectId:'P1' }
  );
  assert.ok(first.timerId);

  assert.throws(
    () => fx.TimerService.startTimer(
      user,
      'W2',
      { operationId:'start-op-22222222', projectId:'P1' }
    ),
    err => err instanceof AppError &&
      err.code === 'ACTIVE_TIMER_EXISTS'
  );
  assert.equal(fx.getTimerCreates(), 1);
});

test('replaying the same start operation returns the same active timer', () => {
  const fx = fixture();
  const payload = { operationId:'start-op-33333333', projectId:'P1' };

  const first = fx.TimerService.startTimer(user, 'W1', payload);
  const replay = fx.TimerService.startTimer(user, 'W1', payload);

  assert.equal(replay.timerId, first.timerId);
  assert.equal(replay.replayed, true);
  assert.equal(fx.getTimerCreates(), 1);
});

test('stop rollback soft-deletes created entry when timer deletion fails', () => {
  const fx = fixture({ failDelete:true });
  const started = fx.TimerService.startTimer(
    user,
    'W1',
    { operationId:'start-op-44444444', projectId:'P1' }
  );

  assert.throws(
    () => fx.TimerService.stopTimer(
      user,
      'W1',
      { timerId:started.timerId, operationId:'stop-op-44444444' }
    ),
    /delete failed/
  );

  assert.ok(fx.timers.W1, 'active timer must remain for retry');
  const entryId = fx.TimerService._entryIdForTimer(started.timerId);
  assert.equal(fx.entries.W1.get(entryId).Status, 'DELETED');
  assert.equal(fx.getRollups(), 0);
});

test('successful stop creates one deterministic entry and duplicate retry returns it', () => {
  const fx = fixture();
  const started = fx.TimerService.startTimer(
    user,
    'W1',
    { operationId:'start-op-55555555', projectId:'P1' }
  );

  const firstStop = fx.TimerService.stopTimer(
    user,
    'W1',
    { timerId:started.timerId, operationId:'stop-op-55555555' }
  );
  const secondStop = fx.TimerService.stopTimer(
    user,
    'W1',
    { timerId:started.timerId, operationId:'stop-op-55555555' }
  );

  assert.equal(firstStop.entryId, secondStop.entryId);
  assert.equal(secondStop.replayed, true);
  assert.equal(fx.getEntryCreates(), 1);
  assert.equal(fx.entries.W1.size, 1);
  assert.equal(fx.getRollups(), 1);
});

test('delayed replay of a completed start operation never resurrects timer', () => {
  const fx = fixture();
  const payload = { operationId:'start-op-66666666', projectId:'P1' };
  const started = fx.TimerService.startTimer(user, 'W1', payload);

  fx.TimerService.stopTimer(
    user,
    'W1',
    { timerId:started.timerId, operationId:'stop-op-66666666' }
  );

  const replay = fx.TimerService.startTimer(user, 'W1', payload);
  assert.equal(replay.completed, true);
  assert.equal(replay.replayed, true);
  assert.equal(fx.timers.W1, null);
  assert.equal(fx.getTimerCreates(), 1);
});

test('stop refuses a stale timerId instead of stopping a different active timer', () => {
  const fx = fixture();
  fx.TimerService.startTimer(
    user,
    'W1',
    { operationId:'start-op-77777777' }
  );

  assert.throws(
    () => fx.TimerService.stopTimer(
      user,
      'W1',
      { timerId:'TMR-stale-id', operationId:'stop-op-77777777' }
    ),
    err => err instanceof AppError &&
      err.code === 'CONFLICT'
  );
  assert.ok(fx.timers.W1);
});

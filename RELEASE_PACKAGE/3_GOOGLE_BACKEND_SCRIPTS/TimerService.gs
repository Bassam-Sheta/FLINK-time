/**
 * FLINK Time & Workforce Platform — Timer Service
 * Authoritative server-side start/stop engine.
 *
 * Invariants:
 * - one active timer per user across every ACTIVE accessible workspace
 * - start/stop mutations execute under ScriptLock
 * - timer start supports client operation-id idempotency without schema changes
 * - each timer maps to one deterministic TimeEntry ID, making stop retries harmless
 */

const TimerService = {
  _normalizeOperationId(rawOperationId) {
    if (rawOperationId === undefined || rawOperationId === null || rawOperationId === '') {
      return '';
    }
    const value = String(rawOperationId).trim();
    if (
      value.length < 8 ||
      value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'operationId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen.',
        400
      );
    }
    return value;
  },

  _timerIdForOperation(authContext, workspaceId, operationId) {
    if (!operationId) return '';
    const hash = SecurityService.hashToken(
      'timer:start:' + authContext.userId + ':' + workspaceId + ':' + operationId
    );
    return 'TMR-' + hash.substring(0, 24);
  },

  _entryIdForTimer(timerId) {
    const hash = SecurityService.hashToken('timer:entry:' + String(timerId || ''));
    return 'ENT-' + hash.substring(0, 24);
  },

  _toActiveTimerResponse(workspaceId, active, extras = {}) {
    return {
      timerId: active.TimerID,
      userId: active.UserID,
      workspaceId,
      projectId: active.ProjectID || '',
      taskId: active.TaskID || '',
      description: active.Description || '',
      tagIds: active.TagIDs || '',
      billable: active.Billable === true || active.Billable === 'TRUE' || active.Billable === 1,
      startedAtUTC: active.StartedAtUTC,
      source: active.Source || CONSTANTS.ENTRY_SOURCE.WEB,
      ...extras
    };
  },

  _findActiveTimerAcrossWorkspaces(authContext) {
    let workspaceIds = [];

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      workspaceIds = MasterRepository.listWorkspaces()
        .filter(ws => ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE)
        .map(ws => ws.WorkspaceID);
    } else {
      workspaceIds = MasterRepository.getWorkspaceAccessForUser(authContext.userId)
        .map(access => access.WorkspaceID)
        .filter(workspaceId => {
          const workspace = MasterRepository.getWorkspace(workspaceId);
          return workspace && workspace.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
        });
    }

    for (const wsId of [...new Set(workspaceIds)]) {
      try {
        const active = SheetRepository.getActiveTimer(wsId, authContext.userId);
        if (active) {
          return { workspaceId: wsId, timer: active };
        }
      } catch (err) {
        // Fail closed. If one ACTIVE workspace cannot be inspected, starting a
        // second timer would risk violating the global one-timer invariant.
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Unable to verify global active-timer state. Please retry.',
          409,
          { workspaceId: wsId, cause: err && err.message ? err.message : String(err) }
        );
      }
    }
    return null;
  },

  _formatWorkspaceLocalTime(workspaceId, date) {
    const ws = MasterRepository.getWorkspace(workspaceId);
    const timezone = ws && ws.Timezone ? ws.Timezone : 'UTC';
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      try {
        return Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm:ss') + ' ' + timezone;
      } catch (e) {}
    }
    return date.toISOString();
  },

  startTimer(authContext, workspaceId, timerPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const operationId = this._normalizeOperationId(timerPayload.operationId);
    const deterministicTimerId = this._timerIdForOperation(
      authContext,
      workspaceId,
      operationId
    );

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Could not acquire lock to start timer. Please retry.',
          409
        );
      }
    }

    try {
      const activeAnywhere = this._findActiveTimerAcrossWorkspaces(authContext);
      if (activeAnywhere) {
        const active = activeAnywhere.timer;

        // Same operation replay while its timer is still active: return the
        // original logical result instead of reporting a conflict.
        if (
          deterministicTimerId &&
          activeAnywhere.workspaceId === workspaceId &&
          active.TimerID === deterministicTimerId
        ) {
          return this._toActiveTimerResponse(workspaceId, active, {
            operationId,
            replayed: true
          });
        }

        throw new AppError(
          ERROR_CODES.ACTIVE_TIMER_EXISTS,
          `An active timer is already running in workspace ${activeAnywhere.workspaceId}. Stop it before starting another timer.`,
          409,
          {
            activeWorkspaceId: activeAnywhere.workspaceId,
            activeTimerId: active.TimerID,
            startedAtUTC: active.StartedAtUTC
          }
        );
      }

      // A delayed/retried start request may arrive after the timer was already
      // stopped. Detect the deterministic completion record and never restart it.
      if (deterministicTimerId) {
        const completedEntryId = this._entryIdForTimer(deterministicTimerId);
        const completedEntry = SheetRepository.getEntryAnyStatus(
          workspaceId,
          completedEntryId
        );
        if (completedEntry && completedEntry.UserID === authContext.userId) {
          if (completedEntry.Status === 'DELETED') {
            throw new AppError(
              ERROR_CODES.CONFLICT,
              'This timer operation exists in a rolled-back state and cannot be restarted with the same operationId.',
              409
            );
          }
          return {
            timerId: deterministicTimerId,
            userId: authContext.userId,
            workspaceId,
            startedAtUTC: completedEntry.StartUTC,
            operationId,
            replayed: true,
            completed: true,
            entryId: completedEntry.EntryID
          };
        }
      }

      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        timerPayload,
        { manual: false, enforceRequired: true }
      );

      const source = timerPayload.source || CONSTANTS.ENTRY_SOURCE.WEB;
      const timerId = deterministicTimerId || Validation.generateId('TMR');
      const now = new Date();
      const startedAtUTC = now.toISOString();

      const timerRecord = {
        TimerID: timerId,
        UserID: authContext.userId,
        ProjectID: tracking.projectId,
        TaskID: tracking.taskId,
        Description: tracking.description,
        TagIDs: tracking.tagIdsCsv,
        StartedAtUTC: startedAtUTC,
        StartedAtLocal: this._formatWorkspaceLocalTime(workspaceId, now),
        Billable: tracking.billable ? true : false,
        Source: source,
        LastHeartbeat: startedAtUTC
      };

      SheetRepository.createActiveTimer(workspaceId, timerRecord);

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIMER',
        EntityID: timerId,
        Action: CONSTANTS.AUDIT_EVENTS.TIMER_STARTED,
        AfterJSON: {
          ...timerRecord,
          operationId: operationId || ''
        },
        ClientType: source
      });

      return this._toActiveTimerResponse(workspaceId, timerRecord, {
        operationId: operationId || '',
        replayed: false
      });
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Finalizes an already-resolved active timer while the caller owns ScriptLock.
   * Used by normal timer stop and administrative user deactivation.
   */
  _finalizeActiveTimerLocked(ownerContext, workspaceId, activeTimer, stopPayload = {}, auditActorContext = null) {
    if (!activeTimer) {
      throw new AppError(
        ERROR_CODES.TIMER_NOT_FOUND,
        'No running timer found in this workspace.',
        404
      );
    }

    const now = new Date();
    const endUTC = now.toISOString();
    const startedAtMs = new Date(activeTimer.StartedAtUTC).getTime();
    if (isNaN(startedAtMs)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Active timer has an invalid StartedAtUTC value.',
        400
      );
    }

    let durationSeconds = Math.max(
      1,
      Math.round((now.getTime() - startedAtMs) / 1000)
    );
    const maxSeconds = CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS * 3600;
    if (durationSeconds > maxSeconds) durationSeconds = maxSeconds;

    const mergedTrackingPayload = {
      projectId: stopPayload.projectId !== undefined
        ? stopPayload.projectId
        : activeTimer.ProjectID,
      taskId: stopPayload.taskId !== undefined
        ? stopPayload.taskId
        : activeTimer.TaskID,
      description: stopPayload.description !== undefined
        ? stopPayload.description
        : activeTimer.Description,
      tags: stopPayload.tags !== undefined
        ? stopPayload.tags
        : activeTimer.TagIDs,
      billable: stopPayload.billable !== undefined
        ? stopPayload.billable
        : activeTimer.Billable
    };

    const tracking = TrackingPolicyService.validateTrackingContext(
      ownerContext,
      workspaceId,
      mergedTrackingPayload,
      { manual: false, enforceRequired: false }
    );

    const hourlyRateSnapshot = tracking.project
      ? (parseFloat(tracking.project.HourlyRate) || 0)
      : 0;
    const costRateSnapshot = tracking.project
      ? (parseFloat(tracking.project.CostRate) || 0)
      : 0;

    // One timer has exactly one logical final time entry.
    const entryId = this._entryIdForTimer(activeTimer.TimerID);
    const existingEntry = SheetRepository.getEntryAnyStatus(workspaceId, entryId);

    if (
      existingEntry &&
      existingEntry.UserID !== ownerContext.userId
    ) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Deterministic timer entry ID is already owned by another user.',
        409
      );
    }

    // Repair/idempotency path: entry already exists and is active. Finish the
    // timer deletion only; do not create or roll up a duplicate entry.
    if (existingEntry && existingEntry.Status !== 'DELETED') {
      const deleted = SheetRepository.deleteActiveTimer(
        workspaceId,
        ownerContext.userId
      );
      if (!deleted) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timer finalization could not remove the active timer.',
          409
        );
      }
      return existingEntry;
    }

    const timeEntry = {
      EntryID: entryId,
      UserID: ownerContext.userId,
      ProjectID: tracking.projectId,
      TaskID: tracking.taskId,
      Description: tracking.description,
      Tags: tracking.tagIdsCsv,
      StartUTC: activeTimer.StartedAtUTC,
      EndUTC: endUTC,
      DurationSeconds: durationSeconds,
      Billable:
        tracking.billable === true ||
        tracking.billable === 'TRUE' ||
        tracking.billable === 1,
      HourlyRateSnapshot: hourlyRateSnapshot,
      CostRateSnapshot: costRateSnapshot,
      EntrySource: activeTimer.Source || CONSTANTS.ENTRY_SOURCE.WEB,
      ManualEntry: false,
      Status: 'ACTIVE',
      ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
      TimesheetID: '',
      Locked: false,
      CreatedAt: existingEntry && existingEntry.CreatedAt
        ? existingEntry.CreatedAt
        : endUTC,
      CreatedBy: ownerContext.userId,
      UpdatedAt: endUTC,
      UpdatedBy: ownerContext.userId,
      DeletedAt: '',
      DeletedBy: '',
      Version: existingEntry
        ? (parseInt(existingEntry.Version, 10) || 1) + 1
        : 1
    };

    let entryMutated = false;
    try {
      if (existingEntry) {
        SheetRepository.updateTimeEntry(workspaceId, entryId, timeEntry);
      } else {
        SheetRepository.createTimeEntry(workspaceId, timeEntry);
      }
      entryMutated = true;

      const deleted = SheetRepository.deleteActiveTimer(
        workspaceId,
        ownerContext.userId
      );
      if (!deleted) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timer finalization could not remove the active timer.',
          409
        );
      }
    } catch (mutationErr) {
      if (entryMutated) {
        try {
          SheetRepository.updateTimeEntry(workspaceId, entryId, {
            Status: 'DELETED',
            DeletedAt: existingEntry
              ? (existingEntry.DeletedAt || new Date().toISOString())
              : new Date().toISOString(),
            DeletedBy: existingEntry
              ? (existingEntry.DeletedBy || ownerContext.userId)
              : ((auditActorContext && auditActorContext.userId) || ownerContext.userId),
            Version: existingEntry
              ? (parseInt(existingEntry.Version, 10) || 1)
              : timeEntry.Version
          });
        } catch (rollbackErr) {
          console.error(
            `Timer finalization rollback failed for entry ${entryId}: ${rollbackErr.message}`
          );
        }
      }
      throw mutationErr;
    }

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
      try { SpreadsheetApp.flush(); } catch (fErr) {}
    }

    try {
      if (
        typeof RollupService !== 'undefined' &&
        RollupService.recordTimeEntry
      ) {
        RollupService.recordTimeEntry(workspaceId, timeEntry);
      }
    } catch (e) {
      console.warn('Rollup calculation notice: ' + e.message);
    }

    const auditActor = auditActorContext || ownerContext;
    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: auditActor.userId,
      ActorRole: auditActor.role,
      EntityType: 'TIME_ENTRY',
      EntityID: entryId,
      Action: CONSTANTS.AUDIT_EVENTS.TIMER_STOPPED,
      AfterJSON: timeEntry,
      Reason: stopPayload.reason || '',
      ClientType: activeTimer.Source || 'WEB'
    });

    return timeEntry;
  },

  stopTimer(authContext, workspaceId, stopPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const operationId = this._normalizeOperationId(stopPayload.operationId);
    const requestedTimerId = stopPayload.timerId
      ? String(stopPayload.timerId).trim()
      : '';

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Could not acquire lock to stop timer. Please retry.',
          409
        );
      }
    }

    try {
      const activeTimer = SheetRepository.getActiveTimer(
        workspaceId,
        authContext.userId
      );

      if (!activeTimer) {
        // A retry after a successful stop can return the exact prior entry when
        // the caller includes the timerId it originally received.
        if (requestedTimerId) {
          const existingEntry = SheetRepository.getEntryAnyStatus(
            workspaceId,
            this._entryIdForTimer(requestedTimerId)
          );
          if (
            existingEntry &&
            existingEntry.UserID === authContext.userId
          ) {
            if (existingEntry.Status === 'DELETED') {
              throw new AppError(
                ERROR_CODES.CONFLICT,
                'The previous stop attempt rolled back and no active timer remains. Administrative reconciliation is required.',
                409
              );
            }
            const replayDto = TimeEntryService.toTimeEntryDTO(
              existingEntry,
              authContext.role !== CONSTANTS.ROLES.USER
            );
            replayDto.timerId = requestedTimerId;
            replayDto.operationId = operationId || '';
            replayDto.replayed = true;
            return replayDto;
          }
        }

        throw new AppError(
          ERROR_CODES.TIMER_NOT_FOUND,
          'No running timer found in this workspace.',
          404
        );
      }

      if (
        requestedTimerId &&
        activeTimer.TimerID !== requestedTimerId
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'The supplied timerId does not match the currently active timer.',
          409
        );
      }

      const timeEntry = this._finalizeActiveTimerLocked(
        authContext,
        workspaceId,
        activeTimer,
        stopPayload
      );

      const dto = TimeEntryService.toTimeEntryDTO(
        timeEntry,
        authContext.role !== CONSTANTS.ROLES.USER
      );
      dto.timerId = activeTimer.TimerID;
      dto.operationId = operationId || '';
      dto.replayed = false;
      return dto;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  getActiveTimer(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const active = SheetRepository.getActiveTimer(
      workspaceId,
      authContext.userId
    );
    if (!active) return null;

    const startedAtMs = new Date(active.StartedAtUTC).getTime();
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.now() - startedAtMs) / 1000)
    );

    return {
      ...this._toActiveTimerResponse(workspaceId, active),
      elapsedSeconds
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TimerService };
}

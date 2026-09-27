/**
 * FLINK Time & Workforce Platform — Timer Service
 * Authoritative server-side start and stop engine with zero per-second Sheet writes.
 * Enforces one active timer globally, authoritative server timestamps, and active timer recovery.
 */

const TimerService = {
  _findActiveTimerAcrossWorkspaces(authContext) {
    let workspaceIds = [];

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      workspaceIds = MasterRepository.listWorkspaces()
        .filter(ws => ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE)
        .map(ws => ws.WorkspaceID);
    } else {
      workspaceIds = MasterRepository.getWorkspaceAccessForUser(authContext.userId)
        .map(access => access.WorkspaceID);
    }

    for (const wsId of [...new Set(workspaceIds)]) {
      try {
        const active = SheetRepository.getActiveTimer(wsId, authContext.userId);
        if (active) {
          return {
            workspaceId: wsId,
            timer: active
          };
        }
      } catch (e) {
        // A single damaged/inaccessible workspace must not hide timers in other workspaces.
        console.warn('Active timer scan notice for ' + wsId + ': ' + e.message);
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

  /**
   * Starts a new timer for the authenticated user
   */
  /**
   * Starts a new timer for the authenticated user inside LockService critical section
   */
  startTimer(authContext, workspaceId, timerPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(10000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to start timer. Please retry.', 409);
      }
    }

    try {
      // Enforce one active timer for the user across every accessible workspace.
      const activeAnywhere = this._findActiveTimerAcrossWorkspaces(authContext);
      if (activeAnywhere) {
        const active = activeAnywhere.timer;
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

      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        timerPayload,
        { manual: false, enforceRequired: true }
      );

      const projectId = tracking.projectId;
      const taskId = tracking.taskId;
      const description = tracking.description;
      const tagIds = tracking.tagIdsCsv;
      const billable = tracking.billable;
      const source = timerPayload.source || CONSTANTS.ENTRY_SOURCE.WEB;

      const timerId = Validation.generateId('TMR');
      const now = new Date();
      const startedAtUTC = now.toISOString();

      const timerRecord = {
        TimerID: timerId,
        UserID: authContext.userId,
        ProjectID: projectId,
        TaskID: taskId,
        Description: description,
        TagIDs: tagIds,
        StartedAtUTC: startedAtUTC,
        StartedAtLocal: this._formatWorkspaceLocalTime(workspaceId, now),
        Billable: billable ? true : false,
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
        AfterJSON: timerRecord,
        ClientType: source
      });

      return {
        timerId,
        userId: authContext.userId,
        workspaceId,
        projectId,
        taskId,
        description,
        tagIds,
        billable,
        startedAtUTC
      };
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Finalizes an already-resolved active timer while the caller owns the ScriptLock.
   * Used by normal timer stop and administrative user deactivation without nested locks.
   */
  _finalizeActiveTimerLocked(ownerContext, workspaceId, activeTimer, stopPayload = {}, auditActorContext = null) {
    if (!activeTimer) {
      throw new AppError(ERROR_CODES.TIMER_NOT_FOUND, 'No running timer found in this workspace.', 404);
    }

    const now = new Date();
    const endUTC = now.toISOString();
    const startedAtMs = new Date(activeTimer.StartedAtUTC).getTime();
    if (isNaN(startedAtMs)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Active timer has an invalid StartedAtUTC value.', 400);
    }

    let durationSeconds = Math.max(1, Math.round((now.getTime() - startedAtMs) / 1000));
    const maxSeconds = CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS * 3600;
    if (durationSeconds > maxSeconds) durationSeconds = maxSeconds;

    const mergedTrackingPayload = {
      projectId: stopPayload.projectId !== undefined ? stopPayload.projectId : activeTimer.ProjectID,
      taskId: stopPayload.taskId !== undefined ? stopPayload.taskId : activeTimer.TaskID,
      description: stopPayload.description !== undefined ? stopPayload.description : activeTimer.Description,
      tags: stopPayload.tags !== undefined ? stopPayload.tags : activeTimer.TagIDs,
      billable: stopPayload.billable !== undefined ? stopPayload.billable : activeTimer.Billable
    };

    const tracking = TrackingPolicyService.validateTrackingContext(
      ownerContext,
      workspaceId,
      mergedTrackingPayload,
      { manual: false, enforceRequired: false }
    );

    const hourlyRateSnapshot = tracking.project ? (parseFloat(tracking.project.HourlyRate) || 0) : 0;
    const costRateSnapshot = tracking.project ? (parseFloat(tracking.project.CostRate) || 0) : 0;
    const entryId = Validation.generateId('ENT');

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
      Billable: tracking.billable === true || tracking.billable === 'TRUE' || tracking.billable === 1,
      HourlyRateSnapshot: hourlyRateSnapshot,
      CostRateSnapshot: costRateSnapshot,
      EntrySource: activeTimer.Source || CONSTANTS.ENTRY_SOURCE.WEB,
      ManualEntry: false,
      Status: 'ACTIVE',
      ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
      TimesheetID: '',
      Locked: false,
      CreatedAt: endUTC,
      CreatedBy: ownerContext.userId,
      UpdatedAt: endUTC,
      UpdatedBy: ownerContext.userId,
      DeletedAt: '',
      DeletedBy: '',
      Version: 1
    };

    let entryCreated = false;
    try {
      SheetRepository.createTimeEntry(workspaceId, timeEntry);
      entryCreated = true;
      SheetRepository.deleteActiveTimer(workspaceId, ownerContext.userId);
    } catch (mutationErr) {
      if (entryCreated) {
        try {
          SheetRepository.updateTimeEntry(workspaceId, entryId, {
            Status: 'DELETED',
            DeletedAt: new Date().toISOString(),
            DeletedBy: (auditActorContext && auditActorContext.userId) || ownerContext.userId
          });
        } catch (rollbackErr) {
          console.error(`Timer finalization rollback failed for entry ${entryId}: ${rollbackErr.message}`);
        }
      }
      throw mutationErr;
    }

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
      try { SpreadsheetApp.flush(); } catch (fErr) {}
    }

    try {
      if (typeof RollupService !== 'undefined' && RollupService.recordTimeEntry) {
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

  /**
   * Authoritatively stops the running timer inside LockService critical section, calculates duration,
   * appends TimeEntry, removes ActiveTimer, and updates rollups.
   */
  stopTimer(authContext, workspaceId, stopPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(10000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to stop timer. Please retry.', 409);
      }
    }

    try {
      const activeTimer = SheetRepository.getActiveTimer(workspaceId, authContext.userId);
      if (!activeTimer) {
        throw new AppError(ERROR_CODES.TIMER_NOT_FOUND, 'No running timer found in this workspace.', 404);
      }

      const timeEntry = this._finalizeActiveTimerLocked(
        authContext,
        workspaceId,
        activeTimer,
        stopPayload
      );

      return TimeEntryService.toTimeEntryDTO(
        timeEntry,
        authContext.role !== CONSTANTS.ROLES.USER
      );
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Retrieves active running timer for state recovery after browser/app reload
   */
  getActiveTimer(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const active = SheetRepository.getActiveTimer(workspaceId, authContext.userId);
    if (!active) return null;

    const startedAtMs = new Date(active.StartedAtUTC).getTime();
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

    return {
      timerId: active.TimerID,
      userId: active.UserID,
      projectId: active.ProjectID,
      taskId: active.TaskID,
      description: active.Description,
      tagIds: active.TagIDs,
      billable: active.Billable === true || active.Billable === 'TRUE',
      startedAtUTC: active.StartedAtUTC,
      elapsedSeconds,
      source: active.Source
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TimerService
  };
}

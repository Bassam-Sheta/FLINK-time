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

      const now = new Date();
      const endUTC = now.toISOString();
      const startedAtMs = new Date(activeTimer.StartedAtUTC).getTime();
      const endMs = now.getTime();

      let durationSeconds = Math.max(1, Math.round((endMs - startedAtMs) / 1000));
      const maxSeconds = CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS * 3600;
      if (durationSeconds > maxSeconds) {
        durationSeconds = maxSeconds; // Clamp to max permitted single entry duration
      }

      const mergedTrackingPayload = {
        projectId: stopPayload.projectId !== undefined ? stopPayload.projectId : activeTimer.ProjectID,
        taskId: stopPayload.taskId !== undefined ? stopPayload.taskId : activeTimer.TaskID,
        description: stopPayload.description !== undefined ? stopPayload.description : activeTimer.Description,
        tags: stopPayload.tags !== undefined ? stopPayload.tags : activeTimer.TagIDs,
        billable: stopPayload.billable !== undefined ? stopPayload.billable : activeTimer.Billable
      };
      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        mergedTrackingPayload,
        { manual: false, enforceRequired: false }
      );

      const projectId = tracking.projectId;
      const taskId = tracking.taskId;
      const description = tracking.description;
      const tags = tracking.tagIdsCsv;
      const billable = tracking.billable;

      let hourlyRateSnapshot = 0;
      let costRateSnapshot = 0;
      if (tracking.project) {
        hourlyRateSnapshot = parseFloat(tracking.project.HourlyRate) || 0;
        costRateSnapshot = parseFloat(tracking.project.CostRate) || 0;
      }

      const entryId = Validation.generateId('ENT');
      const timeEntry = {
        EntryID: entryId,
        entryId: entryId,
        UserID: authContext.userId,
        userId: authContext.userId,
        ProjectID: projectId,
        TaskID: taskId,
        Description: description,
        Tags: tags,
        StartUTC: activeTimer.StartedAtUTC,
        EndUTC: endUTC,
        DurationSeconds: durationSeconds,
        Billable: billable === true || billable === 'TRUE' || billable === 1,
        HourlyRateSnapshot: hourlyRateSnapshot,
        CostRateSnapshot: costRateSnapshot,
        EntrySource: activeTimer.Source || CONSTANTS.ENTRY_SOURCE.WEB,
        ManualEntry: false,
        Status: 'ACTIVE',
        ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
        TimesheetID: '',
        Locked: false,
        CreatedAt: endUTC,
        CreatedBy: authContext.userId,
        UpdatedAt: endUTC,
        UpdatedBy: authContext.userId,
        DeletedAt: '',
        DeletedBy: '',
        Version: 1
      };

      // Append completed entry to TimeEntries
      SheetRepository.createTimeEntry(workspaceId, timeEntry);

      // Delete ActiveTimer row
      SheetRepository.deleteActiveTimer(workspaceId, authContext.userId);

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      // Update Rollups asynchronously/synchronously
      try {
        if (typeof RollupService !== 'undefined' && RollupService.recordTimeEntry) {
          RollupService.recordTimeEntry(workspaceId, timeEntry);
        }
      } catch (e) {
        console.warn('Rollup calculation notice: ' + e.message);
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.TIMER_STOPPED,
        AfterJSON: timeEntry,
        ClientType: activeTimer.Source || 'WEB'
      });

      return timeEntry;
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

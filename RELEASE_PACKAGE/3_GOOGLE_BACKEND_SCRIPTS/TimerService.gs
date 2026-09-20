/**
 * FLINK Time & Workforce Platform — Timer Service
 * Authoritative server-side start and stop engine with zero per-second Sheet writes.
 * Enforces one active timer globally, authoritative server timestamps, and active timer recovery.
 */

const TimerService = {
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
      // Global Check: Verify no existing active timer after acquiring lock
      const existingTimer = this.getActiveTimer(authContext, workspaceId);
      if (existingTimer) {
        throw new AppError(
          ERROR_CODES.ACTIVE_TIMER_EXISTS,
          'An active timer is already running. Please stop the current timer before starting a new one.',
          409,
          { activeTimer: existingTimer }
        );
      }

      const projectId = timerPayload.projectId || '';
      const taskId = timerPayload.taskId || '';
      const description = timerPayload.description ? Validation.sanitizeCellValue(timerPayload.description.trim()) : '';
      const tagIds = timerPayload.tagIds ? (Array.isArray(timerPayload.tagIds) ? timerPayload.tagIds.join(',') : timerPayload.tagIds) : '';
      const billable = timerPayload.billable !== undefined ? timerPayload.billable : true;
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
        StartedAtLocal: now.toLocaleString(),
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

      // Resolve snapshot rates from project
      let hourlyRateSnapshot = 0;
      let costRateSnapshot = 0;
      const projectId = stopPayload.projectId || activeTimer.ProjectID;
      const taskId = stopPayload.taskId || activeTimer.TaskID;
      const description = stopPayload.description !== undefined
        ? Validation.sanitizeCellValue(stopPayload.description.trim())
        : activeTimer.Description;
      const tags = stopPayload.tags !== undefined ? stopPayload.tags : activeTimer.TagIDs;
      const billable = stopPayload.billable !== undefined ? stopPayload.billable : activeTimer.Billable;

      if (projectId) {
        try {
          const proj = SheetRepository.getProject(workspaceId, projectId);
          if (proj) {
            hourlyRateSnapshot = parseFloat(proj.HourlyRate) || 0;
            costRateSnapshot = parseFloat(proj.CostRate) || 0;
          }
        } catch (e) {}
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

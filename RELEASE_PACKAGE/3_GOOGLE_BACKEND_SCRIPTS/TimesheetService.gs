/**
 * FLINK Time & Workforce Platform — Timesheet Service
 * Manages weekly matrix generation, empty timesheet protection,
 * and user submission into the approval queue.
 */

const TimesheetService = {
  /**
   * Generates weekly timesheet grid data for a user and date
   */
  getWeeklyTimesheet(authContext, workspaceId, targetUserId, weekStartDateStr) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const userId = (authContext.role === CONSTANTS.ROLES.USER) ? authContext.userId : (targetUserId || authContext.userId);

    // Calculate 7-day range from weekStartDate
    const startDate = new Date(weekStartDateStr);
    if (isNaN(startDate.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid week start date.');
    }

    // Set to 00:00:00 UTC
    startDate.setUTCHours(0, 0, 0, 0);
    const endDate = new Date(startDate.getTime() + 7 * 24 * 3600 * 1000 - 1);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    const entries = SheetRepository.listTimeEntries(workspaceId, {
      userId,
      startDate: startIso,
      endDate: endIso
    });

    // Check existing timesheet record
    const timesheets = SheetRepository.listTimesheets(workspaceId, { userId });
    const existingTimesheet = timesheets.find(ts => {
      const pStart = new Date(ts.PeriodStart).getTime();
      return Math.abs(pStart - startDate.getTime()) < 86400000;
    }) || null;

    // Build project/task matrix
    const matrixMap = {};
    const dailyTotalsSeconds = [0, 0, 0, 0, 0, 0, 0];
    let totalSeconds = 0;

    for (const entry of entries) {
      const pId = entry.ProjectID || 'unassigned';
      const tId = entry.TaskID || 'none';
      const key = `${pId}__${tId}`;

      if (!matrixMap[key]) {
        matrixMap[key] = {
          projectId: pId,
          taskId: tId,
          days: [0, 0, 0, 0, 0, 0, 0],
          totalSeconds: 0
        };
      }

      const entryStart = new Date(entry.StartUTC);
      const dayDiff = Math.floor((entryStart.getTime() - startDate.getTime()) / (24 * 3600 * 1000));
      const dayIdx = Math.max(0, Math.min(6, dayDiff));
      const secs = parseInt(entry.DurationSeconds, 10) || 0;

      matrixMap[key].days[dayIdx] += secs;
      matrixMap[key].totalSeconds += secs;
      dailyTotalsSeconds[dayIdx] += secs;
      totalSeconds += secs;
    }

    return {
      userId,
      workspaceId,
      periodStart: startIso,
      periodEnd: endIso,
      totalSeconds,
      totalHours: +(totalSeconds / 3600).toFixed(2),
      dailyTotalsSeconds,
      rows: Object.values(matrixMap),
      timesheet: existingTimesheet,
      status: existingTimesheet ? existingTimesheet.Status : CONSTANTS.TIMESHEET_STATUS.OPEN
    };
  },

  /**
   * Submits a weekly timesheet for review with atomic state transition under LockService
   */
  submitTimesheet(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    Validation.assertRequired(payload, ['periodStart', 'periodEnd']);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to submit timesheet. Please retry.', 409);
      }
    }

    try {
      const userId = authContext.userId;
      const startDate = new Date(payload.periodStart);
      const endDate = new Date(payload.periodEnd);
      const startIso = startDate.toISOString();
      const endIso = endDate.toISOString();

      const entries = SheetRepository.listTimeEntries(workspaceId, {
        userId,
        startDate: startIso,
        endDate: endIso
      });

      let totalSeconds = 0;
      for (const e of entries) {
        totalSeconds += parseInt(e.DurationSeconds, 10) || 0;
      }

      // Rejection of empty timesheet
      if (totalSeconds <= 0 || entries.length === 0) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Cannot submit an empty timesheet with 0 hours.');
      }

      // Check if timesheet already exists
      const existingTimesheets = SheetRepository.listTimesheets(workspaceId, { userId });
      const existing = existingTimesheets.find(ts => {
        const pStart = new Date(ts.PeriodStart).getTime();
        return Math.abs(pStart - startDate.getTime()) < 86400000;
      });

      if (existing && existing.Status === CONSTANTS.TIMESHEET_STATUS.APPROVED) {
        throw new AppError(ERROR_CODES.CONFLICT, 'This timesheet has already been approved and cannot be resubmitted.', 409);
      }

      const now = new Date().toISOString();
      let timesheetId = existing ? existing.TimesheetID : Validation.generateId('TMS');

      const tsData = {
        TimesheetID: timesheetId,
        UserID: userId,
        PeriodStart: startIso,
        PeriodEnd: endIso,
        TotalSeconds: totalSeconds,
        Status: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
        SubmittedAt: now,
        ReviewedBy: '',
        ReviewedAt: '',
        ReviewComment: '',
        LockedAt: ''
      };

      if (existing) {
        SheetRepository.updateTimesheet(workspaceId, existing.TimesheetID, tsData);
      } else {
        SheetRepository.createTimesheet(workspaceId, tsData);
      }

      // Atomically transition all entries to SUBMITTED
      for (const entry of entries) {
        SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
          TimesheetID: timesheetId,
          ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED
        });
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIMESHEET',
        EntityID: timesheetId,
        Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_SUBMITTED,
        AfterJSON: tsData
      });

      return tsData;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TimesheetService
  };
}

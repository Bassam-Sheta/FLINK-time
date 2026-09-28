/**
 * FLINK Time & Workforce Platform — Timesheet Service
 * Manages weekly matrix generation, empty timesheet protection,
 * and user submission into the approval queue.
 */

const TimesheetService = {
  _assertTransition(fromStatus, toStatus) {
    const from = String(fromStatus || '').toUpperCase();
    const to = String(toStatus || '').toUpperCase();
    const allowed = (CONSTANTS.TIMESHEET_TRANSITIONS &&
      CONSTANTS.TIMESHEET_TRANSITIONS[from]) || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `Invalid timesheet state transition: ${from || 'UNKNOWN'} -> ${to || 'UNKNOWN'}.`,
        409
      );
    }
    return true;
  },

  _buildSubmissionSnapshot(entries) {
    const seen = new Set();
    return entries.map(entry => {
      const entryId = String(entry.EntryID || '');
      if (!entryId || seen.has(entryId)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet contains duplicate or missing entry IDs and cannot be submitted.',
          409
        );
      }
      seen.add(entryId);

      const nextVersion = (parseInt(entry.Version, 10) || 1) + 1;
      return {
        entryId,
        version: nextVersion,
        startUtc: entry.StartUTC || '',
        endUtc: entry.EndUTC || '',
        durationSeconds: parseInt(entry.DurationSeconds, 10) || 0,
        projectId: entry.ProjectID || '',
        taskId: entry.TaskID || '',
        billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
        hourlyRateSnapshot: parseFloat(entry.HourlyRateSnapshot) || 0,
        costRateSnapshot: parseFloat(entry.CostRateSnapshot) || 0
      };
    });
  },

  _resolveWeek(workspaceId, dateStr) {
    if (!dateStr) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid week date.');
    }
    const bounds = TimezoneService.getWeekBounds(workspaceId, dateStr);
    return {
      startDate: bounds.startUtc,
      endDate: bounds.endUtc,
      startLocalDate: bounds.startLocalDate,
      endLocalDate: bounds.endLocalDate,
      dayLabels: bounds.dayLabels,
      timezone: bounds.timezone
    };
  }, 

  _findCanonicalTimesheet(timesheets, startDate, endDate) {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();
    const exact = [];
    const overlaps = [];

    for (const ts of timesheets || []) {
      const tsStart = new Date(ts.PeriodStart).getTime();
      const tsEnd = new Date(ts.PeriodEnd).getTime();
      if (!Number.isFinite(tsStart) || !Number.isFinite(tsEnd) || tsEnd < tsStart) {
        continue;
      }

      const isExact = tsStart === startMs && tsEnd === endMs;
      if (isExact) {
        exact.push(ts);
        continue;
      }

      if (tsStart <= endMs && tsEnd >= startMs) {
        overlaps.push(ts);
      }
    }

    if (exact.length > 1) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Multiple timesheets exist for the same canonical week. Administrative repair is required.',
        409
      );
    }
    if (overlaps.length > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'An existing timesheet overlaps this canonical workspace week. Administrative repair is required before submission.',
        409
      );
    }

    return exact[0] || null;
  },

  /**
   * Generates weekly timesheet grid data for a user and date
   */
  getWeeklyTimesheet(authContext, workspaceId, targetUserId, weekStartDateStr) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const userId = (authContext.role === CONSTANTS.ROLES.USER) ? authContext.userId : (targetUserId || authContext.userId);

    // Treat the supplied date as "a date in the requested week"; the server
    // resolves the actual configured week boundary.
    const { startDate, endDate, startLocalDate, endLocalDate, dayLabels, timezone } =
      this._resolveWeek(workspaceId, weekStartDateStr);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    const entries = SheetRepository.listTimeEntries(workspaceId, {
      userId,
      startDate: startIso,
      endDate: endIso
    });

    // Check existing timesheet record
    const timesheets = SheetRepository.listTimesheets(workspaceId, { userId });
    const existingTimesheet = this._findCanonicalTimesheet(
      timesheets,
      startDate,
      endDate
    );

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

      const entryLocalDate = TimezoneService.formatDateKey(workspaceId, entry.StartUTC);
      const dayDiff = TimezoneService.diffLocalDateDays(startLocalDate, entryLocalDate);
      const dayIdx = Math.max(0, Math.min(6, dayDiff));
      const secs = parseInt(entry.DurationSeconds, 10) || 0;

      matrixMap[key].days[dayIdx] += secs;
      matrixMap[key].totalSeconds += secs;
      dailyTotalsSeconds[dayIdx] += secs;
      totalSeconds += secs;
    }

    const projects = SheetRepository.listProjects(workspaceId);
    const tasks = SheetRepository.listTasks(workspaceId);
    const projectMap = {};
    const taskMap = {};
    projects.forEach(p => { projectMap[p.ProjectID] = p.ProjectName; });
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const rows = Object.values(matrixMap).map(row => ({
      ...row,
      projectName: projectMap[row.projectId] || (row.projectId === 'unassigned' ? 'Unassigned' : row.projectId),
      taskName: taskMap[row.taskId] || (row.taskId === 'none' ? '' : row.taskId)
    }));

    return {
      userId,
      workspaceId,
      periodStart: startIso,
      periodEnd: endIso,
      periodStartLocal: startLocalDate,
      periodEndLocal: endLocalDate,
      timezone,
      dayLabels,
      totalSeconds,
      totalHours: +(totalSeconds / 3600).toFixed(2),
      dailyTotalsSeconds,
      rows,
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
      const requestedStart = new Date(payload.periodStart);
      const requestedEnd = new Date(payload.periodEnd);
      if (
        isNaN(requestedStart.getTime()) ||
        isNaN(requestedEnd.getTime()) ||
        requestedEnd.getTime() < requestedStart.getTime()
      ) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A valid timesheet periodStart and periodEnd are required.');
      }

      // Canonicalize the period on the server. Clients may submit only one exact
      // configured workspace week; arbitrary/overlapping partial ranges are rejected.
      const expectedWeek = TimezoneService.getWeekBounds(workspaceId, requestedStart);
      const startDate = expectedWeek.startUtc;
      const endDate = expectedWeek.endUtc;
      if (
        requestedStart.getTime() !== startDate.getTime() ||
        requestedEnd.getTime() !== endDate.getTime()
      ) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Timesheet period must match the configured workspace week (${expectedWeek.startLocalDate} to ${expectedWeek.endLocalDate}, ${expectedWeek.timezone}).`,
          400
        );
      }

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

      // A user may have at most one record for this exact canonical week, and
      // no other period may overlap it.
      const existingTimesheets = SheetRepository.listTimesheets(workspaceId, { userId });
      const existing = this._findCanonicalTimesheet(
        existingTimesheets,
        startDate,
        endDate
      );

      const currentStatus = existing
        ? String(existing.Status || '').toUpperCase()
        : CONSTANTS.TIMESHEET_STATUS.OPEN;
      this._assertTransition(currentStatus, CONSTANTS.TIMESHEET_STATUS.SUBMITTED);

      const now = new Date().toISOString();
      const timesheetId = existing ? existing.TimesheetID : Validation.generateId('TMS');

      for (const entry of entries) {
        const isLocked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
        const isApproved = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED;
        const belongsToOtherSubmission =
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED &&
          entry.TimesheetID &&
          entry.TimesheetID !== timesheetId;
        if (isLocked || isApproved || belongsToOtherSubmission) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Time entry ${entry.EntryID} is already locked or belongs to another submitted/approved timesheet.`,
            409
          );
        }
      }

      const entrySnapshot = this._buildSubmissionSnapshot(entries);
      const snapshotTotalSeconds = entrySnapshot.reduce(
        (sum, item) => sum + item.durationSeconds,
        0
      );
      if (snapshotTotalSeconds !== totalSeconds) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet snapshot total does not match the selected entries.',
          409
        );
      }

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
        LockedAt: '',
        EntrySnapshotJSON: JSON.stringify(entrySnapshot)
      };

      // Sheets has no multi-row transaction primitive. Mutate the member entries first,
      // remember their exact previous state, then commit the timesheet header last.
      // If any write fails, roll entries back best-effort before surfacing the error.
      const changedEntries = [];
      try {
        for (const entry of entries) {
          const previousState = {
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus || CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: parseInt(entry.Version, 10) || 1
          };
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
            Locked: true,
            Version: previousState.Version + 1,
            UpdatedAt: now,
            UpdatedBy: authContext.userId
          });
          changedEntries.push(previousState);
        }

        if (existing) {
          SheetRepository.updateTimesheet(workspaceId, existing.TimesheetID, tsData);
        } else {
          SheetRepository.createTimesheet(workspaceId, tsData);
        }
      } catch (mutationErr) {
        for (const prior of changedEntries) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version
            });
          } catch (rollbackErr) {
            console.error(`Submission rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_SUBMITTED,
          AfterJSON: tsData
        });
      } catch (auditErr) {
        console.error('Timesheet submission audit failed after commit: ' + auditErr.message);
      }

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

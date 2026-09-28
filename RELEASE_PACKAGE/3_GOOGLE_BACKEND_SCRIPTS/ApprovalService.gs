/**
 * FLINK Time & Workforce Platform — Approval Service
 * Governs timesheet reviews (approve / reject with mandatory comments),
 * entry locking, immutable approval history, and Super Admin reopen override.
 */

const ApprovalService = {
  /**
   * Resolve the exact entry membership captured at submission time.
   * Legacy submitted sheets without a snapshot fall back only to entries already
   * carrying the same TimesheetID; never to unassigned entries in the date range.
   */
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

  _restoreTimesheetHeader(workspaceId, timesheet) {
    SheetRepository.updateTimesheet(workspaceId, timesheet.TimesheetID, {
      Status: timesheet.Status,
      SubmittedAt: timesheet.SubmittedAt || '',
      ReviewedBy: timesheet.ReviewedBy || '',
      ReviewedAt: timesheet.ReviewedAt || '',
      ReviewComment: timesheet.ReviewComment || '',
      LockedAt: timesheet.LockedAt || '',
      EntrySnapshotJSON: timesheet.EntrySnapshotJSON || '',
      TotalSeconds: parseInt(timesheet.TotalSeconds, 10) || 0
    });
  },

  /**
   * Resolve and verify the exact immutable entry membership captured at submission.
   * Missing snapshots fail closed: pre-snapshot legacy submissions must be reopened
   * and resubmitted rather than approved from an unverifiable date range.
   */
  _resolveSubmissionEntries(workspaceId, timesheet) {
    if (!timesheet.EntrySnapshotJSON) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet has no immutable submission snapshot. Reopen and resubmit it before review.',
        409
      );
    }

    let snapshot;
    try {
      snapshot = JSON.parse(timesheet.EntrySnapshotJSON);
    } catch (e) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet submission snapshot is malformed.', 409);
    }
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet submission snapshot is empty or invalid.', 409);
    }

    const snapshotIds = new Set();
    const entries = [];
    let snapshotTotalSeconds = 0;

    for (const item of snapshot) {
      const entryId = String(item && item.entryId || '');
      if (!entryId || snapshotIds.has(entryId)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet submission snapshot contains duplicate or missing entry IDs.',
          409
        );
      }
      snapshotIds.add(entryId);

      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} no longer exists.`, 409);
      }
      if (entry.UserID !== timesheet.UserID) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} belongs to another user.`, 409);
      }
      if (entry.TimesheetID !== timesheet.TimesheetID) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} is no longer bound to this timesheet.`, 409);
      }

      const currentBillable =
        entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1;
      const snapshotBillable =
        item.billable === true || item.billable === 'TRUE' || item.billable === 1;

      const comparisons = [
        ['version', parseInt(entry.Version, 10) || 1, parseInt(item.version, 10) || 1],
        ['duration', parseInt(entry.DurationSeconds, 10) || 0, parseInt(item.durationSeconds, 10) || 0],
        ['start', String(entry.StartUTC || ''), String(item.startUtc || '')],
        ['end', String(entry.EndUTC || ''), String(item.endUtc || '')],
        ['project', String(entry.ProjectID || ''), String(item.projectId || '')],
        ['task', String(entry.TaskID || ''), String(item.taskId || '')],
        ['billable', currentBillable, snapshotBillable],
        ['hourly rate', Number(entry.HourlyRateSnapshot || 0), Number(item.hourlyRateSnapshot || 0)],
        ['cost rate', Number(entry.CostRateSnapshot || 0), Number(item.costRateSnapshot || 0)]
      ];
      const mismatch = comparisons.find(([, current, submitted]) => current !== submitted);
      if (mismatch) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Submitted entry ${entryId} changed after submission (${mismatch[0]} mismatch). Reopen/resubmit before review.`,
          409
        );
      }

      snapshotTotalSeconds += parseInt(item.durationSeconds, 10) || 0;
      entries.push(entry);
    }

    if (snapshotTotalSeconds !== (parseInt(timesheet.TotalSeconds, 10) || 0)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet total no longer matches its immutable submission snapshot.',
        409
      );
    }

    // Detect any extra entry bound to the same timesheet but omitted from the
    // snapshot. Membership must be exact in both directions.
    const boundEntries = SheetRepository.listTimeEntries(workspaceId, {
      userId: timesheet.UserID,
      startDate: timesheet.PeriodStart,
      endDate: timesheet.PeriodEnd
    }).filter(entry => entry.TimesheetID === timesheet.TimesheetID);

    const boundIds = new Set(boundEntries.map(entry => String(entry.EntryID || '')));
    if (
      boundIds.size !== snapshotIds.size ||
      [...boundIds].some(id => !snapshotIds.has(id))
    ) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet entry membership changed after submission. Reopen/resubmit before review.',
        409
      );
    }

    return entries;
  },

  /**
   * Admin or Super Admin approves a submitted timesheet
   */
  /**
   * Admin or Super Admin approves a submitted timesheet inside LockService critical section
   */
  approveTimesheet(authContext, workspaceId, timesheetId, comment = '') {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to approve timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);

      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.APPROVED
      );

      const now = new Date().toISOString();
      const cleanComment = comment ? Validation.sanitizeCellValue(comment) : 'Approved';

      // Resolve and validate the immutable submission membership BEFORE mutating
      // the timesheet header. This prevents an APPROVED header with invalid entries.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in SUBMITTED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: parseInt(entry.Version, 10) || 1,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.APPROVED,
            Locked: true
          });
        }

        headerAttempted = true;
        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.APPROVED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment,
          LockedAt: now
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Approval header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Approval rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'APPROVED',
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          TimestampUTC: now,
          Comment: cleanComment,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_APPROVED,
          Reason: cleanComment
        });
      } catch (auditErr) {
        console.error('Approval audit failed after committed state transition: ' + auditErr.message);
      }

      return updatedTimesheet;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Admin or Super Admin rejects a submitted timesheet with required comments inside LockService critical section
   */
  rejectTimesheet(authContext, workspaceId, timesheetId, reasonComment) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    if (!reasonComment || !reasonComment.trim()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A comment explaining the rejection is required.');
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to reject timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.REJECTED
      );

      const now = new Date().toISOString();
      const cleanComment = Validation.sanitizeCellValue(reasonComment.trim());

      // Validate exact submission membership before changing the header state.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in SUBMITTED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousVersion = parseInt(entry.Version, 10) || 1;
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: previousVersion,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: '',
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.REJECTED,
            Locked: false,
            Version: previousVersion + 1,
            UpdatedAt: now,
            UpdatedBy: authContext.userId
          });
        }

        headerAttempted = true;
        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.REJECTED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment,
          LockedAt: '',
          EntrySnapshotJSON: ''
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Rejection header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Rejection rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'REJECTED',
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          TimestampUTC: now,
          Comment: cleanComment,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_REJECTED,
          Reason: cleanComment
        });
      } catch (auditErr) {
        console.error('Rejection audit failed after committed state transition: ' + auditErr.message);
      }

      return updatedTimesheet;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Super Admin override to reopen an already approved timesheet inside LockService critical section
   */
  reopenTimesheet(superAdminContext, workspaceId, timesheetId, reason) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    AuthorizationService.assertWorkspaceAccess(superAdminContext, workspaceId);
    if (!reason || !String(reason).trim()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'A reason is required when reopening an approved timesheet.',
        400
      );
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to reopen timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.OPEN
      );

      const now = new Date().toISOString();
      const cleanReason = Validation.sanitizeCellValue(String(reason).trim());

      // Resolve the original immutable membership while the header is still APPROVED.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.APPROVED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in APPROVED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousVersion = parseInt(entry.Version, 10) || 1;
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: previousVersion,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: '',
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: false,
            Version: previousVersion + 1,
            UpdatedAt: now,
            UpdatedBy: superAdminContext.userId
          });
        }

        headerAttempted = true;
        var updated = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.OPEN,
          ReviewedBy: '',
          ReviewedAt: '',
          ReviewComment: '',
          LockedAt: '',
          EntrySnapshotJSON: ''
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Reopen header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Reopen rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'REOPENED',
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          TimestampUTC: now,
          Comment: cleanReason,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_REOPENED,
          Reason: cleanReason
        });
      } catch (auditErr) {
        console.error('Reopen audit failed after committed state transition: ' + auditErr.message);
      }

      return updated;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ApprovalService
  };
}

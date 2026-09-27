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
  _resolveSubmissionEntries(workspaceId, timesheet) {
    let snapshot = [];
    if (timesheet.EntrySnapshotJSON) {
      try {
        const parsed = JSON.parse(timesheet.EntrySnapshotJSON);
        if (Array.isArray(parsed)) snapshot = parsed;
      } catch (e) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet submission snapshot is malformed.', 409);
      }
    }

    if (snapshot.length > 0) {
      const entries = [];
      for (const item of snapshot) {
        const entry = SheetRepository.getEntry(workspaceId, item.entryId);
        if (!entry) {
          throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${item.entryId} no longer exists.`, 409);
        }
        if (entry.TimesheetID !== timesheet.TimesheetID) {
          throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${item.entryId} is no longer bound to this timesheet.`, 409);
        }
        const currentVersion = parseInt(entry.Version, 10) || 1;
        const currentDuration = parseInt(entry.DurationSeconds, 10) || 0;
        if (
          currentVersion !== (parseInt(item.version, 10) || 1) ||
          currentDuration !== (parseInt(item.durationSeconds, 10) || 0)
        ) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Submitted entry ${item.entryId} changed after submission. Reopen/resubmit before review.`,
            409
          );
        }
        entries.push(entry);
      }
      return entries;
    }

    const legacyEntries = SheetRepository.listTimeEntries(workspaceId, {
      userId: timesheet.UserID,
      startDate: timesheet.PeriodStart,
      endDate: timesheet.PeriodEnd
    }).filter(entry => entry.TimesheetID === timesheet.TimesheetID);

    if (legacyEntries.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet has no verifiable submitted entries.', 409);
    }
    return legacyEntries;
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

      if (timesheet.Status !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Only SUBMITTED timesheets can be approved. Current status: ${timesheet.Status}.`,
          409
        );
      }

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

      const changedEntryIds = [];
      try {
        for (const entry of entries) {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.APPROVED,
            Locked: true
          });
          changedEntryIds.push(entry.EntryID);
        }

        // Commit the timesheet state only after every member entry succeeds.
        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.APPROVED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment,
          LockedAt: now
        });
      } catch (mutationErr) {
        // Best-effort rollback of any entries already changed in this critical section.
        for (const entry of entries) {
          if (!changedEntryIds.includes(entry.EntryID)) continue;
          try {
            SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
              TimesheetID: timesheetId,
              ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
              Locked: true
            });
          } catch (rollbackErr) {
            console.error(`Approval rollback failed for entry ${entry.EntryID}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      // Append immutable audit to Approvals tab
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
      if (timesheet.Status !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Only SUBMITTED timesheets can be rejected. Current status: ${timesheet.Status}.`,
          409
        );
      }

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

      const changedEntryIds = [];
      try {
        for (const entry of entries) {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.REJECTED,
            Locked: false
          });
          changedEntryIds.push(entry.EntryID);
        }

        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.REJECTED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment
        });
      } catch (mutationErr) {
        for (const entry of entries) {
          if (!changedEntryIds.includes(entry.EntryID)) continue;
          try {
            SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
              ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
              Locked: true
            });
          } catch (rollbackErr) {
            console.error(`Rejection rollback failed for entry ${entry.EntryID}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      // Append immutable audit to Approvals tab
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
      if (timesheet.Status !== CONSTANTS.TIMESHEET_STATUS.APPROVED) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Only APPROVED timesheets can be reopened. Current status: ${timesheet.Status}.`,
          409
        );
      }

      const now = new Date().toISOString();
      const cleanReason = reason ? Validation.sanitizeCellValue(reason) : 'Reopened by Super Admin';

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

      const changedEntryIds = [];
      try {
        for (const entry of entries) {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: false
          });
          changedEntryIds.push(entry.EntryID);
        }

        var updated = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.OPEN,
          LockedAt: ''
        });
      } catch (mutationErr) {
        for (const entry of entries) {
          if (!changedEntryIds.includes(entry.EntryID)) continue;
          try {
            SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
              ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.APPROVED,
              Locked: true
            });
          } catch (rollbackErr) {
            console.error(`Reopen rollback failed for entry ${entry.EntryID}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

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

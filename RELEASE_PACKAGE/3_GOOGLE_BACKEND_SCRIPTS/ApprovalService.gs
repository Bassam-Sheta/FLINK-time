/**
 * FLINK Time & Workforce Platform — Approval Service
 * Governs timesheet reviews (approve / reject with mandatory comments),
 * entry locking, immutable approval history, and Super Admin reopen override.
 */

const ApprovalService = {
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

      if (timesheet.Status === CONSTANTS.TIMESHEET_STATUS.APPROVED) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet is already approved.', 409);
      }

      const now = new Date().toISOString();
      const cleanComment = comment ? Validation.sanitizeCellValue(comment) : 'Approved';

      // Update Timesheet record
      const updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
        Status: CONSTANTS.TIMESHEET_STATUS.APPROVED,
        ReviewedBy: authContext.userId,
        ReviewedAt: now,
        ReviewComment: cleanComment,
        LockedAt: now
      });

      // Lock all related time entries atomically
      const entries = SheetRepository.listTimeEntries(workspaceId, {
        userId: timesheet.UserID,
        startDate: timesheet.PeriodStart,
        endDate: timesheet.PeriodEnd
      });

      for (const entry of entries) {
        if (entry.TimesheetID === timesheetId || !entry.TimesheetID) {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.APPROVED,
            Locked: true
          });
        }
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

      const now = new Date().toISOString();
      const cleanComment = Validation.sanitizeCellValue(reasonComment.trim());

      // Update Timesheet record to REJECTED
      const updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
        Status: CONSTANTS.TIMESHEET_STATUS.REJECTED,
        ReviewedBy: authContext.userId,
        ReviewedAt: now,
        ReviewComment: cleanComment
      });

      // Unlock entries and mark REJECTED so user can edit and resubmit
      const entries = SheetRepository.listTimeEntries(workspaceId, {
        userId: timesheet.UserID,
        startDate: timesheet.PeriodStart,
        endDate: timesheet.PeriodEnd
      });

      for (const entry of entries) {
        SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
          ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.REJECTED,
          Locked: false
        });
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

      const now = new Date().toISOString();
      const cleanReason = reason ? Validation.sanitizeCellValue(reason) : 'Reopened by Super Admin';

      const updated = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
        Status: CONSTANTS.TIMESHEET_STATUS.OPEN,
        LockedAt: ''
      });

      // Unlock entries
      const entries = SheetRepository.listTimeEntries(workspaceId, {
        userId: timesheet.UserID,
        startDate: timesheet.PeriodStart,
        endDate: timesheet.PeriodEnd
      });

      for (const entry of entries) {
        SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
          ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
          Locked: false
        });
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

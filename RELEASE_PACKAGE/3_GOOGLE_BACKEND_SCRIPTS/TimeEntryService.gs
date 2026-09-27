/**
 * FLINK Time & Workforce Platform — Time Entry Service
 * Manages manual time entry creation, optimistic concurrency edits,
 * soft deletion, and status assertions (locking against approved records).
 */

const TimeEntryService = {
  /**
   * Creates a manual time entry
   */
  createManualEntry(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    Validation.assertRequired(payload, ['projectId', 'startUtc', 'endUtc']);

    const durationSeconds = Validation.validateDateRange(payload.startUtc, payload.endUtc);
    const description = payload.description ? Validation.sanitizeCellValue(payload.description.trim()) : '';
    const billable = payload.billable !== undefined ? payload.billable : true;
    const now = new Date().toISOString();

    let hourlyRateSnapshot = 0;
    let costRateSnapshot = 0;
    try {
      const proj = SheetRepository.getProject(workspaceId, payload.projectId);
      if (proj) {
        hourlyRateSnapshot = parseFloat(proj.HourlyRate) || 0;
        costRateSnapshot = parseFloat(proj.CostRate) || 0;
      }
    } catch (e) {}

    const entryId = Validation.generateId('ENT');
    const timeEntry = {
      EntryID: entryId,
      UserID: authContext.userId,
      ProjectID: payload.projectId,
      TaskID: payload.taskId || '',
      Description: description,
      Tags: payload.tags || '',
      StartUTC: payload.startUtc,
      EndUTC: payload.endUtc,
      DurationSeconds: durationSeconds,
      Billable: billable ? true : false,
      HourlyRateSnapshot: hourlyRateSnapshot,
      CostRateSnapshot: costRateSnapshot,
      EntrySource: CONSTANTS.ENTRY_SOURCE.MANUAL,
      ManualEntry: true,
      Status: 'ACTIVE',
      ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
      TimesheetID: '',
      Locked: false,
      CreatedAt: now,
      CreatedBy: authContext.userId,
      UpdatedAt: now,
      UpdatedBy: authContext.userId,
      DeletedAt: '',
      DeletedBy: '',
      Version: 1
    };

    SheetRepository.createTimeEntry(workspaceId, timeEntry);

    try {
      if (typeof RollupService !== 'undefined' && RollupService.recordTimeEntry) {
        RollupService.recordTimeEntry(workspaceId, timeEntry);
      }
    } catch (e) {}

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'TIME_ENTRY',
      EntityID: entryId,
      Action: CONSTANTS.AUDIT_EVENTS.ENTRY_CREATED,
      AfterJSON: timeEntry,
      ClientType: 'WEB'
    });

    timeEntry.entryId = timeEntry.EntryID;
    timeEntry.version = timeEntry.Version;
    return timeEntry;
  },

  /**
   * Updates an existing time entry with optimistic concurrency guard
   */
  updateEntry(authContext, workspaceId, entryId, updates, expectedVersionParam = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      try {
        scriptLock = LockService.getScriptLock();
        scriptLock.waitLock(10000);
      } catch (lockErr) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Server is busy processing concurrent writes. Please retry.', 409);
      }
    }

    try {
      // Re-read inside critical section
      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);

      AuthorizationService.assertRecordOwnership(authContext, entry.UserID);

      // Locking check
      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'This time entry is locked, pending approval, or part of an approved timesheet.', 403);
      }

      // Optimistic Concurrency check inside critical section
      const expVer = updates.expectedVersion !== undefined ? updates.expectedVersion : expectedVersionParam;
      if (expVer !== null && expVer !== undefined) {
        const currentVersion = parseInt(entry.Version, 10) || 1;
        if (currentVersion !== parseInt(expVer, 10)) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            'This entry was modified by another operation. Please refresh and try again.',
            409
          );
        }
      }

      const allowed = {};
      if (updates.projectId) allowed.ProjectID = updates.projectId;
      if (updates.taskId !== undefined) allowed.TaskID = updates.taskId;
      if (updates.description !== undefined) allowed.Description = Validation.sanitizeCellValue(updates.description.trim());
      if (updates.tags !== undefined) allowed.Tags = updates.tags;
      if (updates.billable !== undefined) allowed.Billable = updates.billable ? true : false;

      if (updates.startUtc && updates.endUtc) {
        allowed.StartUTC = updates.startUtc;
        allowed.EndUTC = updates.endUtc;
        allowed.DurationSeconds = Validation.validateDateRange(updates.startUtc, updates.endUtc);
      }

      allowed.UpdatedAt = new Date().toISOString();
      allowed.UpdatedBy = authContext.userId;
      allowed.Version = (parseInt(entry.Version, 10) || 1) + 1;

      const updated = SheetRepository.updateTimeEntry(workspaceId, entryId, allowed);

      const affectsRollups =
        allowed.ProjectID !== undefined ||
        allowed.Billable !== undefined ||
        allowed.StartUTC !== undefined ||
        allowed.EndUTC !== undefined ||
        allowed.DurationSeconds !== undefined;

      // Explicit flush in Google Apps Script to guarantee write persistence before reconciliation.
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (affectsRollups && typeof RollupService !== 'undefined' && RollupService.rebuildRollups) {
        RollupService.rebuildRollups(workspaceId);
      }

      updated.entryId = updated.EntryID || entryId;
      updated.version = updated.Version;

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_UPDATED,
        BeforeJSON: entry,
        AfterJSON: updated
      });

      return updated;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Domain-to-DTO Mapper: strictly isolates Sheet storage schema from API response contracts
   */
  toTimeEntryDTO(entry) {
    if (!entry) return null;
    const durationSeconds = parseInt(entry.DurationSeconds, 10) || 0;
    return {
      entryId: entry.EntryID,
      userId: entry.UserID,
      projectId: entry.ProjectID || '',
      taskId: entry.TaskID || '',
      description: entry.Description || '',
      tags: entry.Tags || '',
      startUtc: entry.StartUTC,
      endUtc: entry.EndUTC,
      durationSeconds: durationSeconds,
      durationHours: +(durationSeconds / 3600).toFixed(2),
      billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
      hourlyRateSnapshot: parseFloat(entry.HourlyRateSnapshot) || 0,
      costRateSnapshot: parseFloat(entry.CostRateSnapshot) || 0,
      status: entry.Status || 'ACTIVE',
      approvalStatus: entry.ApprovalStatus || 'OPEN',
      locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      timesheetId: entry.TimesheetID || '',
      version: parseInt(entry.Version, 10) || 1,
      createdAt: entry.CreatedAt,
      updatedAt: entry.UpdatedAt,
      // Retain PascalCase references for internal backwards compatibility
      EntryID: entry.EntryID,
      UserID: entry.UserID,
      DurationSeconds: durationSeconds,
      ApprovalStatus: entry.ApprovalStatus || 'OPEN',
      Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      Version: parseInt(entry.Version, 10) || 1
    };
  },

  /**
   * Soft-deletes a time entry inside atomic LockService critical section
   */
  deleteEntry(authContext, workspaceId, entryId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(10000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to delete entry. Please retry.', 409);
      }
    }

    try {
      // Re-read row after acquiring lock
      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);

      AuthorizationService.assertRecordOwnership(authContext, entry.UserID);

      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'Cannot delete an entry that is locked, pending approval, or approved.', 403);
      }

      const now = new Date().toISOString();
      SheetRepository.updateTimeEntry(workspaceId, entryId, {
        Status: 'DELETED',
        DeletedAt: now,
        DeletedBy: authContext.userId,
        UpdatedAt: now,
        UpdatedBy: authContext.userId
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (typeof RollupService !== 'undefined' && RollupService.rebuildRollups) {
        RollupService.rebuildRollups(workspaceId);
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_DELETED,
        BeforeJSON: entry,
        Reason: 'User deleted time entry'
      });

      return { ok: true, entryId, message: `Time entry ${entryId} deleted.` };
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Lists time entries with filtering and role-based data visibility
   */
  listEntries(authContext, workspaceId, filters = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const queryFilters = { ...filters };

    // Regular users can only list their own entries
    if (authContext.role === CONSTANTS.ROLES.USER) {
      queryFilters.userId = authContext.userId;
    }

    const rows = SheetRepository.listTimeEntries(workspaceId, queryFilters);
    return rows.map(entry => this.toTimeEntryDTO(entry));
  },

  /**
   * Performs bulk administration actions on time entries
   */
  bulkAction(authContext, workspaceId, entryIds = [], actionType, params = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'entryIds must contain at least one time entry.');
    }

    const normalizedAction = String(actionType || '').toUpperCase();
    const allowedActions = ['DELETE', 'LOCK', 'UNLOCK', 'CHANGE_PROJECT'];
    if (!allowedActions.includes(normalizedAction)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        normalizedAction === 'APPROVE'
          ? 'Bulk approval is not allowed. Approve the submitted timesheet instead.'
          : `Unsupported bulk action: ${normalizedAction}`
      );
    }

    if (
      (normalizedAction === 'LOCK' || normalizedAction === 'UNLOCK') &&
      ![CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN].includes(authContext.role)
    ) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Only Admin or Super Admin can lock/unlock entries.', 403);
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(15000)) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Could not acquire lock for bulk action. Please retry.', 409);
      }
    }

    try {
      // Phase 1: validate the entire batch before changing any record.
      const entries = entryIds.map(id => {
        const entry = SheetRepository.getEntry(workspaceId, id);
        if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${id} not found.`, 404);

        AuthorizationService.assertRecordOwnership(authContext, entry.UserID);

        const isLocked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
        const isSubmitted = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED;
        const isApproved = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED;

        if (
          (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT' || normalizedAction === 'UNLOCK') &&
          (isLocked || isSubmitted || isApproved)
        ) {
          throw new AppError(
            ERROR_CODES.ENTRY_LOCKED,
            `Entry ${entry.EntryID} is locked or belongs to a submitted/approved timesheet. Reopen/reject the timesheet first.`,
            403
          );
        }

        return entry;
      });

      if (normalizedAction === 'CHANGE_PROJECT' && !params.projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'projectId is required for CHANGE_PROJECT.');
      }

      // Phase 2: apply only after the whole batch passes validation.
      const now = new Date().toISOString();
      for (const entry of entries) {
        const nextVersion = (parseInt(entry.Version, 10) || 1) + 1;

        if (normalizedAction === 'DELETE') {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            Status: 'DELETED',
            DeletedAt: now,
            DeletedBy: authContext.userId,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          });
        } else if (normalizedAction === 'LOCK') {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            Locked: true,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          });
        } else if (normalizedAction === 'UNLOCK') {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            Locked: false,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          });
        } else if (normalizedAction === 'CHANGE_PROJECT') {
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            ProjectID: params.projectId,
            TaskID: params.taskId || '',
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          });
        }
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (
        (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT') &&
        typeof RollupService !== 'undefined' &&
        RollupService.rebuildRollups
      ) {
        RollupService.rebuildRollups(workspaceId);
      }

      return entries.length;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TimeEntryService
  };
}

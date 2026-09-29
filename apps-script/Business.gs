/** FLINK Time — Consolidated master data, time tracking, timer, timesheet, approval, report, rollup, and dashboard services. */


/* ===== MasterDataServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Master Data Services
 * ClientService, ProjectService, TaskService, and TagService.
 * Governs workspace master entities, billing rate configurations, and estimates.
 */

var ClientService = (typeof global !== 'undefined' && global.ClientService) || {
  listClients(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const clients = SheetRepository.listClients(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return clients;
    return clients
      .filter(client => String(client.Status || '').toUpperCase() === 'ACTIVE')
      .map(client => ({
        ClientID: client.ClientID,
        ClientName: client.ClientName,
        Status: client.Status
      }));
  },

  createClient(authContext, workspaceId, clientPayload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(clientPayload, ['clientName']);

    const clientName = String(clientPayload.clientName || '').trim();
    if (!clientName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Client name cannot be blank.', 400);
    }
    const duplicateClient = SheetRepository.listClients(workspaceId)
      .some(client =>
        String(client.Status || '').toUpperCase() === 'ACTIVE' &&
        String(client.ClientName || '').trim().toLowerCase() === clientName.toLowerCase()
      );
    if (duplicateClient) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active client with this name already exists.', 409);
    }

    const clientId = Validation.generateId('CLI');
    const clientRecord = {
      ClientID: clientId,
      ClientName: Validation.sanitizeCellValue(clientName),
      Status: 'ACTIVE',
      Notes: clientPayload.notes ? Validation.sanitizeCellValue(clientPayload.notes) : '',
      CreatedAt: new Date().toISOString()
    };

    SheetRepository.createClient(workspaceId, clientRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'CLIENT',
      EntityID: clientId,
      Action: 'CLIENT_CREATED',
      AfterJSON: clientRecord
    });

    return clientRecord;
  }
};

var ProjectService = (typeof global !== 'undefined' && global.ProjectService) || {
  listProjects(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    let projects = SheetRepository.listProjects(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return projects;

    const accessState = TrackingPolicyService.getProjectAccessState(authContext, workspaceId);
    if (accessState.aclEnabled) {
      projects = projects.filter(project => accessState.allowedProjectIds.has(project.ProjectID));
    }
    projects = projects.filter(project => String(project.Status || '').toUpperCase() === 'ACTIVE');

    // USER-facing DTO deliberately excludes rates, costs, budgets, and internal notes.
    return projects.map(p => ({
      ProjectID: p.ProjectID,
      ClientID: p.ClientID,
      ProjectName: p.ProjectName,
      Code: p.Code,
      Status: p.Status,
      BillableDefault: p.BillableDefault,
      EstimateHours: p.EstimateHours,
      StartDate: p.StartDate,
      EndDate: p.EndDate,
      ColorKey: p.ColorKey
    }));
  },

  getProject(authContext, workspaceId, projectId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const project = SheetRepository.getProject(workspaceId, projectId);
    if (!project || authContext.role !== CONSTANTS.ROLES.USER) return project;

    if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Project is not active.', 404);
    }
    TrackingPolicyService.assertProjectAccess(authContext, workspaceId, projectId);

    return {
      ProjectID: project.ProjectID,
      ClientID: project.ClientID,
      ProjectName: project.ProjectName,
      Code: project.Code,
      Status: project.Status,
      BillableDefault: project.BillableDefault,
      EstimateHours: project.EstimateHours,
      StartDate: project.StartDate,
      EndDate: project.EndDate,
      ColorKey: project.ColorKey
    };
  },

  createProject(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['projectName']);

    const projectName = String(payload.projectName || '').trim();
    if (!projectName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project name cannot be blank.', 400);
    }

    const hourlyRate = Number(payload.hourlyRate || 0);
    const costRate = Number(payload.costRate || 0);
    const estimateHours = Number(payload.estimateHours || 0);
    const budgetAmount = Number(payload.budgetAmount || 0);
    for (const [label, value] of [
      ['hourlyRate', hourlyRate],
      ['costRate', costRate],
      ['estimateHours', estimateHours],
      ['budgetAmount', budgetAmount]
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${label} must be a non-negative number.`, 400);
      }
    }

    if (payload.startDate && isNaN(new Date(payload.startDate).getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project startDate is invalid.', 400);
    }
    if (payload.endDate && isNaN(new Date(payload.endDate).getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project endDate is invalid.', 400);
    }
    if (payload.startDate && payload.endDate &&
        new Date(payload.endDate).getTime() < new Date(payload.startDate).getTime()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project endDate cannot be before startDate.', 400);
    }

    const clientId = payload.clientId ? String(payload.clientId).trim() : '';
    if (clientId) {
      const client = SheetRepository.getClient(workspaceId, clientId);
      if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, `Client ${clientId} not found.`, 404);
      if (String(client.Status || '').toUpperCase() !== 'ACTIVE') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Selected client is not active.', 400);
      }
    }

    const projectId = Validation.generateId('PRJ');
    const projectRecord = {
      ProjectID: projectId,
      ClientID: clientId,
      ProjectName: Validation.sanitizeCellValue(projectName),
      Code: payload.code ? Validation.sanitizeCellValue(payload.code.trim()) : '',
      Status: 'ACTIVE',
      BillableDefault: payload.billableDefault !== undefined ? (payload.billableDefault ? true : false) : true,
      HourlyRate: hourlyRate,
      CostRate: costRate,
      EstimateHours: estimateHours,
      BudgetAmount: budgetAmount,
      StartDate: payload.startDate || '',
      EndDate: payload.endDate || '',
      ColorKey: payload.colorKey || '#3B82F6',
      Notes: payload.notes ? Validation.sanitizeCellValue(payload.notes) : ''
    };

    SheetRepository.createProject(workspaceId, projectRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'PROJECT',
      EntityID: projectId,
      Action: CONSTANTS.AUDIT_EVENTS.PROJECT_CREATED,
      AfterJSON: projectRecord
    });

    return projectRecord;
  },

  updateProject(authContext, workspaceId, projectId, updates) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    const existing = SheetRepository.getProject(workspaceId, projectId);
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} not found.`, 404);
    }

    const sanitizedUpdates = {};
    if (updates.projectName !== undefined) {
      const projectName = String(updates.projectName || '').trim();
      if (!projectName) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project name cannot be blank.', 400);
      }
      sanitizedUpdates.ProjectName = Validation.sanitizeCellValue(projectName);
    }
    if (updates.code !== undefined) sanitizedUpdates.Code = Validation.sanitizeCellValue(String(updates.code || '').trim());

    if (updates.status !== undefined) {
      const nextStatus = String(updates.status || '').trim().toUpperCase();
      if (!nextStatus) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project status cannot be blank.', 400);
      }
      if (nextStatus !== 'ACTIVE') {
        const activeTimers = SheetRepository.listActiveTimers(workspaceId);
        const hasRunningTimer = activeTimers.some(timer => timer.ProjectID === projectId);
        if (hasRunningTimer) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            'Project cannot be made inactive while an active timer is using it.',
            409
          );
        }
      }
      sanitizedUpdates.Status = nextStatus;
    }

    for (const [inputKey, columnName] of [
      ['hourlyRate', 'HourlyRate'],
      ['costRate', 'CostRate'],
      ['estimateHours', 'EstimateHours'],
      ['budgetAmount', 'BudgetAmount']
    ]) {
      if (updates[inputKey] !== undefined) {
        const value = Number(updates[inputKey]);
        if (!Number.isFinite(value) || value < 0) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${inputKey} must be a non-negative number.`, 400);
        }
        sanitizedUpdates[columnName] = value;
      }
    }
    if (updates.colorKey) sanitizedUpdates.ColorKey = updates.colorKey;

    const updated = SheetRepository.updateProject(workspaceId, projectId, sanitizedUpdates);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'PROJECT',
      EntityID: projectId,
      Action: CONSTANTS.AUDIT_EVENTS.PROJECT_UPDATED,
      AfterJSON: updated
    });

    return updated;
  }
};

var TaskService = (typeof global !== 'undefined' && global.TaskService) || {
  listTasks(authContext, workspaceId, projectId = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    if (authContext.role !== CONSTANTS.ROLES.USER) {
      return SheetRepository.listTasks(workspaceId, projectId);
    }

    const accessState = TrackingPolicyService.getProjectAccessState(authContext, workspaceId);
    const allowedProjectIds = accessState.aclEnabled
      ? accessState.allowedProjectIds
      : null;

    if (projectId) {
      const project = SheetRepository.getProject(workspaceId, projectId);
      if (!project || String(project.Status || '').toUpperCase() !== 'ACTIVE') return [];
      TrackingPolicyService.assertProjectAccess(authContext, workspaceId, projectId);
    }

    return SheetRepository.listTasks(workspaceId, projectId).filter(task => {
      if (allowedProjectIds && !allowedProjectIds.has(task.ProjectID)) return false;
      return ['OPEN', 'ACTIVE'].includes(String(task.Status || '').toUpperCase());
    });
  },

  createTask(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['projectId', 'taskName']);

    const project = SheetRepository.getProject(workspaceId, payload.projectId);
    if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${payload.projectId} not found.`, 404);
    if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Tasks can only be added to active projects.', 400);
    }

    const taskName = String(payload.taskName || '').trim();
    if (!taskName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Task name cannot be blank.', 400);
    }
    const duplicateTask = SheetRepository.listTasks(workspaceId, payload.projectId)
      .some(task =>
        ['OPEN', 'ACTIVE'].includes(String(task.Status || '').toUpperCase()) &&
        String(task.TaskName || '').trim().toLowerCase() === taskName.toLowerCase()
      );
    if (duplicateTask) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active task with this name already exists in the project.', 409);
    }

    const taskId = Validation.generateId('TSK');
    const taskRecord = {
      TaskID: taskId,
      ProjectID: payload.projectId,
      TaskName: Validation.sanitizeCellValue(taskName),
      Status: 'OPEN',
      EstimateHours: parseFloat(payload.estimateHours) || 0,
      BillableDefault: payload.billableDefault !== undefined ? (payload.billableDefault ? true : false) : true,
      SortOrder: parseInt(payload.sortOrder, 10) || 1
    };

    SheetRepository.createTask(workspaceId, taskRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'TASK',
      EntityID: taskId,
      Action: 'TASK_CREATED',
      AfterJSON: taskRecord
    });

    return taskRecord;
  }
};

var TagService = (typeof global !== 'undefined' && global.TagService) || {
  listTags(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const tags = SheetRepository.listTags(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return tags;
    return tags.filter(tag => String(tag.Status || '').toUpperCase() === 'ACTIVE');
  },

  createTag(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['tagName']);

    const tagName = String(payload.tagName || '').trim();
    if (!tagName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Tag name cannot be blank.', 400);
    }
    const duplicateTag = SheetRepository.listTags(workspaceId)
      .some(tag =>
        String(tag.Status || '').toUpperCase() === 'ACTIVE' &&
        String(tag.TagName || '').trim().toLowerCase() === tagName.toLowerCase()
      );
    if (duplicateTag) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active tag with this name already exists.', 409);
    }

    const tagId = Validation.generateId('TAG');
    const tagRecord = {
      TagID: tagId,
      TagName: Validation.sanitizeCellValue(tagName),
      Status: 'ACTIVE',
      Category: payload.category ? Validation.sanitizeCellValue(payload.category) : 'General'
    };

    SheetRepository.createTag(workspaceId, tagRecord);
    return tagRecord;
  }
};

/* ===== TimeEntryService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Time Entry Service
 * Manages manual time entry creation, optimistic concurrency edits,
 * soft deletion, and status assertions (locking against approved records).
 */

var TimeEntryService = (typeof global !== 'undefined' && global.TimeEntryService) || {
  _canonicalUtcTimestamp(value, fieldName) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `${fieldName} must be a valid timestamp.`,
        400
      );
    }
    return date.toISOString();
  },

  /**
   * Creates a manual time entry
   */
  createManualEntry(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    Validation.assertRequired(payload, ['startUtc', 'endUtc']);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to create manual entry. Please retry.', 409);
      }
    }

    try {
      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        payload,
        { manual: true, enforceRequired: true }
      );
      const startUtc = this._canonicalUtcTimestamp(payload.startUtc, 'startUtc');
      const endUtc = this._canonicalUtcTimestamp(payload.endUtc, 'endUtc');
      const durationSeconds = Validation.validateDateRange(startUtc, endUtc);
      if (durationSeconds <= 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Manual time entry duration must be greater than zero.',
          400
        );
      }
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, {
          StartUTC: startUtc,
          EndUTC: endUtc
        });
      }
      const now = new Date().toISOString();

      const hourlyRateSnapshot = tracking.project ? (parseFloat(tracking.project.HourlyRate) || 0) : 0;
      const costRateSnapshot = tracking.project ? (parseFloat(tracking.project.CostRate) || 0) : 0;

      const entryId = Validation.generateId('ENT');
      const timeEntry = {
        EntryID: entryId,
        UserID: authContext.userId,
        ProjectID: tracking.projectId,
        TaskID: tracking.taskId,
        Description: tracking.description,
        Tags: tracking.tagIdsCsv,
        StartUTC: startUtc,
        EndUTC: endUtc,
        DurationSeconds: durationSeconds,
        Billable: tracking.billable,
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

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        SpreadsheetApp.flush();
      }

      if (typeof RollupService !== 'undefined' && RollupService.recordTimeEntry) {
        try {
          RollupService.recordTimeEntry(workspaceId, timeEntry);
        } catch (rollupErr) {
          console.warn('Manual-entry rollup update notice: ' + rollupErr.message);
        }
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_CREATED,
        AfterJSON: timeEntry,
        ClientType: 'WEB'
      });

      return this.toTimeEntryDTO(
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
   * Updates an existing time entry with optimistic concurrency guard
   */
  updateEntry(authContext, workspaceId, entryId, updates, expectedVersionParam = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'updates must be an object.', 400);
    }

    const mutableFields = [
      'projectId', 'taskId', 'description', 'tags', 'billable', 'startUtc', 'endUtc'
    ];
    if (!mutableFields.some(field => Object.prototype.hasOwnProperty.call(updates, field))) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'At least one editable time-entry field is required.',
        400
      );
    }

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
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
      }

      // Locking check
      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'This time entry is locked, pending approval, or part of an approved timesheet.', 403);
      }

      // Every client mutation must name the version it read. Optional version
      // checks allow silent lost updates, so fail closed when the version is absent.
      const expVer = updates.expectedVersion !== undefined
        ? updates.expectedVersion
        : expectedVersionParam;
      if (expVer === null || expVer === undefined || expVer === '') {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'expectedVersion is required when updating a time entry.',
          400
        );
      }
      Validation.assertRecordVersion(entry, expVer);

      const mergedTrackingPayload = {
        projectId: updates.projectId !== undefined ? updates.projectId : entry.ProjectID,
        taskId: updates.taskId !== undefined ? updates.taskId : entry.TaskID,
        description: updates.description !== undefined ? updates.description : entry.Description,
        tags: updates.tags !== undefined ? updates.tags : entry.Tags,
        billable: updates.billable !== undefined ? updates.billable : entry.Billable
      };
      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        mergedTrackingPayload,
        { manual: false, enforceRequired: true }
      );

      const allowed = {};
      if (updates.projectId !== undefined) {
        allowed.ProjectID = tracking.projectId;
        const projectChanged = String(tracking.projectId || '') !== String(entry.ProjectID || '');
        if (projectChanged) {
          allowed.HourlyRateSnapshot = tracking.project
            ? (parseFloat(tracking.project.HourlyRate) || 0)
            : 0;
          allowed.CostRateSnapshot = tracking.project
            ? (parseFloat(tracking.project.CostRate) || 0)
            : 0;
        }
      }
      if (updates.taskId !== undefined) allowed.TaskID = tracking.taskId;
      if (updates.description !== undefined) allowed.Description = tracking.description;
      if (updates.tags !== undefined) allowed.Tags = tracking.tagIdsCsv;
      if (updates.billable !== undefined) allowed.Billable = tracking.billable;

      if (updates.startUtc !== undefined || updates.endUtc !== undefined) {
        const nextStart = this._canonicalUtcTimestamp(
          updates.startUtc !== undefined ? updates.startUtc : entry.StartUTC,
          'startUtc'
        );
        const nextEnd = this._canonicalUtcTimestamp(
          updates.endUtc !== undefined ? updates.endUtc : entry.EndUTC,
          'endUtc'
        );
        const nextDuration = Validation.validateDateRange(nextStart, nextEnd);
        if (nextDuration <= 0) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Time entry duration must be greater than zero.',
            400
          );
        }
        if (authContext.role === CONSTANTS.ROLES.USER) {
          TrackingPolicyService.assertEntryEditableByAge(workspaceId, {
            ...entry,
            StartUTC: nextStart,
            EndUTC: nextEnd
          });
        }
        allowed.StartUTC = nextStart;
        allowed.EndUTC = nextEnd;
        allowed.DurationSeconds = nextDuration;
      }

      allowed.UpdatedAt = new Date().toISOString();
      allowed.UpdatedBy = authContext.userId;
      allowed.Version = (parseInt(entry.Version, 10) || 1) + 1;

      const updated = SheetRepository.updateTimeEntry(workspaceId, entryId, allowed);

      // Explicit flush in Google Apps Script to guarantee write persistence before reconciliation.
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (typeof RollupService !== 'undefined' && RollupService.reconcileMutation) {
        RollupService.reconcileMutation(
          workspaceId,
          entry,
          updated,
          'UPDATE'
        );
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_UPDATED,
        BeforeJSON: entry,
        AfterJSON: updated
      });

      return this.toTimeEntryDTO(
        updated,
        authContext.role !== CONSTANTS.ROLES.USER
      );
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Domain-to-DTO Mapper: strictly isolates Sheet storage schema from API response contracts
   */
  toTimeEntryDTO(entry, includeFinancial = false) {
    if (!entry) return null;
    const durationSeconds = parseInt(entry.DurationSeconds, 10) || 0;
    const dto = {
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
      status: entry.Status || 'ACTIVE',
      approvalStatus: entry.ApprovalStatus || 'OPEN',
      locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      timesheetId: entry.TimesheetID || '',
      version: parseInt(entry.Version, 10) || 1,
      createdAt: entry.CreatedAt,
      updatedAt: entry.UpdatedAt,
      // Non-financial compatibility aliases.
      EntryID: entry.EntryID,
      UserID: entry.UserID,
      DurationSeconds: durationSeconds,
      ApprovalStatus: entry.ApprovalStatus || 'OPEN',
      Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      Version: parseInt(entry.Version, 10) || 1
    };

    if (includeFinancial) {
      dto.hourlyRateSnapshot = parseFloat(entry.HourlyRateSnapshot) || 0;
      dto.costRateSnapshot = parseFloat(entry.CostRateSnapshot) || 0;
    }

    return dto;
  },

  /**
   * Soft-deletes a time entry inside atomic LockService critical section
   */
  deleteEntry(authContext, workspaceId, entryId, expectedVersion = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (expectedVersion === null || expectedVersion === undefined || expectedVersion === '') {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'expectedVersion is required when deleting a time entry.',
        400
      );
    }

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
      Validation.assertRecordVersion(entry, expectedVersion);
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
      }

      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'Cannot delete an entry that is locked, pending approval, or approved.', 403);
      }

      const now = new Date().toISOString();
      const deletedEntry = SheetRepository.updateTimeEntry(workspaceId, entryId, {
        Status: 'DELETED',
        DeletedAt: now,
        DeletedBy: authContext.userId,
        UpdatedAt: now,
        UpdatedBy: authContext.userId,
        Version: (parseInt(entry.Version, 10) || 1) + 1
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (typeof RollupService !== 'undefined' && RollupService.reconcileMutation) {
        RollupService.reconcileMutation(
          workspaceId,
          entry,
          deletedEntry,
          'DELETE'
        );
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

      return {
        ok: true,
        entryId,
        version: (parseInt(entry.Version, 10) || 1) + 1,
        message: `Time entry ${entryId} deleted.`
      };
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
    const includeFinancial = authContext.role !== CONSTANTS.ROLES.USER;
    return rows.map(entry => this.toTimeEntryDTO(entry, includeFinancial));
  },

  /**
   * Performs bulk administration actions on time entries
   */
  bulkAction(authContext, workspaceId, entryIds = [], actionType, params = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'entryIds must contain at least one time entry.');
    }
    if (entryIds.length > 100) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Bulk actions are limited to 100 entries per request.', 400);
    }
    if (new Set(entryIds.map(String)).size !== entryIds.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'entryIds must not contain duplicates.', 400);
    }

    const expectedVersions = params && params.expectedVersions;
    if (!expectedVersions || typeof expectedVersions !== 'object' || Array.isArray(expectedVersions)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'params.expectedVersions is required for every bulk-mutated entry.',
        400
      );
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
        if (!Object.prototype.hasOwnProperty.call(expectedVersions, id)) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            `Missing expected version for time entry ${id}.`,
            400
          );
        }
        Validation.assertRecordVersion(entry, expectedVersions[id]);

        if (
          authContext.role === CONSTANTS.ROLES.USER &&
          (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT')
        ) {
          TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
        }

        const isLocked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
        const isSubmitted = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED;
        const isApproved = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED;

        const modifiesContent =
          normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT';
        if (modifiesContent && (isLocked || isSubmitted || isApproved)) {
          throw new AppError(
            ERROR_CODES.ENTRY_LOCKED,
            `Entry ${entry.EntryID} is locked or belongs to a submitted/approved timesheet. Reopen/reject the timesheet first.`,
            403
          );
        }
        if (
          (normalizedAction === 'LOCK' || normalizedAction === 'UNLOCK') &&
          (isSubmitted || isApproved)
        ) {
          throw new AppError(
            ERROR_CODES.ENTRY_LOCKED,
            `Entry ${entry.EntryID} belongs to a submitted/approved timesheet and its lock state cannot be changed directly.`,
            403
          );
        }

        return entry;
      });

      if (normalizedAction === 'CHANGE_PROJECT' && !params.projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'projectId is required for CHANGE_PROJECT.');
      }

      // Validate target project/task/access for every affected entry before writing.
      // This also refreshes the rate snapshots so financial rollups cannot retain
      // rates from the previous project.
      const changeContexts = new Map();
      if (normalizedAction === 'CHANGE_PROJECT') {
        for (const entry of entries) {
          const tracking = TrackingPolicyService.validateTrackingContext(
            authContext,
            workspaceId,
            {
              projectId: params.projectId,
              taskId: params.taskId || '',
              description: entry.Description || '',
              tags: entry.Tags || '',
              billable: entry.Billable
            },
            { manual: false, enforceRequired: true }
          );
          changeContexts.set(entry.EntryID, tracking);
        }
      }

      // Phase 2: create the complete mutation plan after all validation succeeds.
      const now = new Date().toISOString();
      const plans = entries.map(entry => {
        const nextVersion = (parseInt(entry.Version, 10) || 1) + 1;
        let updates = null;

        if (normalizedAction === 'DELETE') {
          updates = {
            Status: 'DELETED',
            DeletedAt: now,
            DeletedBy: authContext.userId,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'LOCK') {
          updates = {
            Locked: true,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'UNLOCK') {
          updates = {
            Locked: false,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'CHANGE_PROJECT') {
          const tracking = changeContexts.get(entry.EntryID);
          const projectChanged =
            String(tracking.projectId || '') !== String(entry.ProjectID || '');
          updates = {
            ProjectID: tracking.projectId,
            TaskID: tracking.taskId,
            Billable: tracking.billable,
            HourlyRateSnapshot: projectChanged
              ? (tracking.project ? (parseFloat(tracking.project.HourlyRate) || 0) : 0)
              : (parseFloat(entry.HourlyRateSnapshot) || 0),
            CostRateSnapshot: projectChanged
              ? (tracking.project ? (parseFloat(tracking.project.CostRate) || 0) : 0)
              : (parseFloat(entry.CostRateSnapshot) || 0),
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        }

        return { entry, updates };
      });

      // Sheets has no multi-row transaction. Apply the fully validated plan and
      // roll back any already-written records if a later write fails.
      const changedPlans = [];
      try {
        for (const plan of plans) {
          SheetRepository.updateTimeEntry(workspaceId, plan.entry.EntryID, plan.updates);
          changedPlans.push(plan);
        }
      } catch (mutationErr) {
        for (const plan of changedPlans.reverse()) {
          const before = plan.entry;
          try {
            SheetRepository.updateTimeEntry(workspaceId, before.EntryID, {
              ProjectID: before.ProjectID || '',
              TaskID: before.TaskID || '',
              Billable: before.Billable,
              HourlyRateSnapshot: before.HourlyRateSnapshot || 0,
              CostRateSnapshot: before.CostRateSnapshot || 0,
              Status: before.Status || 'ACTIVE',
              Locked: before.Locked === true || before.Locked === 'TRUE' || before.Locked === 1,
              DeletedAt: before.DeletedAt || '',
              DeletedBy: before.DeletedBy || '',
              UpdatedAt: before.UpdatedAt || '',
              UpdatedBy: before.UpdatedBy || '',
              Version: parseInt(before.Version, 10) || 1
            });
          } catch (rollbackErr) {
            console.error(`Bulk action rollback failed for entry ${before.EntryID}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (
        typeof RollupService !== 'undefined' &&
        RollupService.rebuildRollups &&
        (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT')
      ) {
        const requiresRebuild = plans.some(plan =>
          !RollupService.mutationAffectsRollups ||
          RollupService.mutationAffectsRollups(
            plan.entry,
            { ...plan.entry, ...plan.updates }
          )
        );
        if (requiresRebuild) {
          RollupService.rebuildRollups(workspaceId);
        }
      }

      return entries.length;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

/* ===== TimerService.gs ===== */
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

var TimerService = (typeof global !== 'undefined' && global.TimerService) || {
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

/* ===== TimesheetService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Timesheet Service
 * Manages weekly matrix generation, empty timesheet protection,
 * and user submission into the approval queue.
 */

var TimesheetService = (typeof global !== 'undefined' && global.TimesheetService) || {
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

  _restoreTimesheetHeader(workspaceId, timesheet) {
    SheetRepository.updateTimesheet(workspaceId, timesheet.TimesheetID, {
      UserID: timesheet.UserID,
      PeriodStart: timesheet.PeriodStart,
      PeriodEnd: timesheet.PeriodEnd,
      TotalSeconds: parseInt(timesheet.TotalSeconds, 10) || 0,
      Status: timesheet.Status,
      SubmittedAt: timesheet.SubmittedAt || '',
      ReviewedBy: timesheet.ReviewedBy || '',
      ReviewedAt: timesheet.ReviewedAt || '',
      ReviewComment: timesheet.ReviewComment || '',
      LockedAt: timesheet.LockedAt || '',
      EntrySnapshotJSON: timesheet.EntrySnapshotJSON || ''
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
   * Manager/Super Admin queue view for one authorized workspace.
   */
  listTimesheetsForManager(authContext, workspaceId, statusFilter = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [
      CONSTANTS.ROLES.SUPER_ADMIN,
      CONSTANTS.ROLES.ADMIN
    ]);

    const normalizedStatus = statusFilter
      ? String(statusFilter).toUpperCase()
      : '';
    if (
      normalizedStatus &&
      !Object.values(CONSTANTS.TIMESHEET_STATUS).includes(normalizedStatus)
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid timesheet status filter: ${normalizedStatus}.`,
        400
      );
    }

    const rows = SheetRepository.listTimesheets(
      workspaceId,
      normalizedStatus ? { status: normalizedStatus } : {}
    );
    const members = SheetRepository.listMembers(workspaceId);
    const names = {};
    members.forEach(member => {
      names[member.UserID] = member.DisplayName || member.UserID;
    });

    return rows
      .map(ts => ({
        timesheetId: ts.TimesheetID,
        userId: ts.UserID,
        userName: names[ts.UserID] || ts.UserID,
        periodStart: ts.PeriodStart,
        periodEnd: ts.PeriodEnd,
        totalSeconds: parseInt(ts.TotalSeconds, 10) || 0,
        status: ts.Status,
        submittedAt: ts.SubmittedAt || '',
        reviewedBy: ts.ReviewedBy || '',
        reviewedAt: ts.ReviewedAt || '',
        reviewComment: ts.ReviewComment || ''
      }))
      .sort((a, b) =>
        String(b.submittedAt || b.periodEnd || '').localeCompare(
          String(a.submittedAt || a.periodEnd || '')
        )
      );
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
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousState = {
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus || CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: parseInt(entry.Version, 10) || 1
          };
          // Register compensation state before the write so even a partially
          // applied Sheet mutation that throws can be restored.
          changedEntries.push(previousState);
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
            Locked: true,
            Version: previousState.Version + 1,
            UpdatedAt: now,
            UpdatedBy: authContext.userId
          });
        }

        headerAttempted = true;
        if (existing) {
          SheetRepository.updateTimesheet(workspaceId, existing.TimesheetID, tsData);
        } else {
          SheetRepository.createTimesheet(workspaceId, tsData);
        }
      } catch (mutationErr) {
        if (headerAttempted) {
          try {
            if (existing) {
              this._restoreTimesheetHeader(workspaceId, existing);
            } else {
              SheetRepository.deleteTimesheet(workspaceId, timesheetId);
            }
          } catch (headerRollbackErr) {
            console.error('Submission header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
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

/* ===== ApprovalService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Approval Service
 * Governs timesheet reviews (approve / reject with mandatory comments),
 * entry locking, immutable approval history, and Super Admin reopen override.
 */

var ApprovalService = (typeof global !== 'undefined' && global.ApprovalService) || {
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

/* ===== ReportService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Clockify-Class Reporting Engine
 * Supports 3-level nested grouping Summary Reports, Detailed Reports,
 * Weekly User Matrix, Attendance/Utilization, Project Budgets, and Anomaly Detection.
 */

var ReportService = (typeof global !== 'undefined' && global.ReportService) || {
  _prepareReportFilters(authContext, workspaceId, params = {}, allowedRoles = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (allowedRoles) {
      AuthorizationService.assertRole(authContext, allowedRoles);
    }

    const filters = { ...((params && params.filters) || {}) };

    if (authContext.role === CONSTANTS.ROLES.USER) {
      // USER scope is always server-forced to self.
      filters.userId = authContext.userId;
    } else if (
      authContext.role === CONSTANTS.ROLES.ADMIN &&
      filters.userId
    ) {
      // An Admin may report on any member of an assigned workspace, but a
      // cross-workspace user ID is not accepted merely because it was supplied
      // as a client filter.
      const member = SheetRepository.getMember(workspaceId, filters.userId);
      if (!member) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'The requested report user does not belong to this workspace.',
          403
        );
      }
    }

    return filters;
  },

  _toSummaryNodeDTO(node, includeFinancial) {
    if (!node) return null;
    const dto = {
      key: node.key,
      groupField: node.groupField,
      totalSeconds: parseInt(node.totalSeconds, 10) || 0,
      billableSeconds: parseInt(node.billableSeconds, 10) || 0,
      totalHours: +(Number(node.totalHours) || 0).toFixed(2),
      billableHours: +(Number(node.billableHours) || 0).toFixed(2)
    };
    if (node.entryCount !== undefined) {
      dto.entryCount = parseInt(node.entryCount, 10) || 0;
    }
    if (Array.isArray(node.groups)) {
      dto.groups = node.groups.map(child =>
        this._toSummaryNodeDTO(child, includeFinancial)
      );
    }
    if (includeFinancial) {
      dto.costCents = parseInt(node.costCents, 10) || 0;
      dto.revenueCents = parseInt(node.revenueCents, 10) || 0;
      dto.cost = +(Number(node.cost) || 0).toFixed(2);
      dto.revenue = +(Number(node.revenue) || 0).toFixed(2);
    }
    return dto;
  },

  _toSummaryOverallDTO(tree, includeFinancial) {
    const dto = {
      totalSeconds: parseInt(tree.totalSeconds, 10) || 0,
      billableSeconds: parseInt(tree.billableSeconds, 10) || 0,
      totalHours: +(Number(tree.totalHours) || 0).toFixed(2),
      billableHours: +(Number(tree.billableHours) || 0).toFixed(2)
    };
    if (includeFinancial) {
      dto.costCents = parseInt(tree.costCents, 10) || 0;
      dto.revenueCents = parseInt(tree.revenueCents, 10) || 0;
      dto.cost = +(Number(tree.cost) || 0).toFixed(2);
      dto.revenue = +(Number(tree.revenue) || 0).toFixed(2);
    }
    return dto;
  },

  /**
   * Summary Report: Up to 3 levels of nested grouping
   * Example groupings: ['user', 'project', 'task'], ['client', 'project', 'user']
   */
  getSummaryReport(authContext, workspaceId, params = {}) {
    const groupings = Array.isArray(params.groupings) && params.groupings.length > 0
      ? params.groupings.slice(0, 3)
      : ['project', 'user'];

    const isRegularUser = authContext.role === CONSTANTS.ROLES.USER;
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params
    );

    const entries = SheetRepository.listTimeEntries(workspaceId, filters);

    // Cache project and user names
    const projects = SheetRepository.listProjects(workspaceId);
    const projMap = {};
    projects.forEach(p => { projMap[p.ProjectID] = p.ProjectName; });

    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const tasks = SheetRepository.listTasks(workspaceId);
    const taskMap = {};
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const resolveGroupKey = (entry, groupField) => {
      switch (groupField.toLowerCase()) {
        case 'user':
          return userMap[entry.UserID] || entry.UserID || 'Unknown User';
        case 'project':
          return projMap[entry.ProjectID] || entry.ProjectID || 'No Project';
        case 'task':
          return taskMap[entry.TaskID] || entry.TaskID || 'No Task';
        case 'date':
          return entry.StartUTC
            ? TimezoneService.formatDateKey(workspaceId, entry.StartUTC)
            : 'Unknown Date';
        case 'billable':
          return (entry.Billable === true || entry.Billable === 'TRUE') ? 'Billable' : 'Non-Billable';
        case 'tag':
          return entry.Tags || 'Untagged';
        default:
          return 'Other';
      }
    };

    // Recursive grouping tree builder
    // Recursive grouping tree builder using exact integer arithmetic (seconds & cents)
    const buildGroupTree = (entryList, groupIndex) => {
      if (groupIndex >= groupings.length) {
        let leafSeconds = 0;
        let leafBillableSeconds = 0;
        let leafCostCents = 0;
        let leafRevenueCents = 0;
        for (const e of entryList) {
          const s = parseInt(e.DurationSeconds, 10) || 0;
          leafSeconds += s;
          const isB = e.Billable === true || e.Billable === 'TRUE' || e.Billable === 1;
          if (isB) leafBillableSeconds += s;
          
          const costRate = parseFloat(e.CostRateSnapshot) || 0;
          const hourlyRate = parseFloat(e.HourlyRateSnapshot) || 0;
          // Exact minor-unit calculation: (seconds * rate * 100) / 3600
          leafCostCents += Math.round((s * costRate * 100) / 3600);
          if (isB) {
            leafRevenueCents += Math.round((s * hourlyRate * 100) / 3600);
          }
        }
        return {
          totalSeconds: leafSeconds,
          billableSeconds: leafBillableSeconds,
          totalHours: +(leafSeconds / 3600).toFixed(2),
          billableHours: +(leafBillableSeconds / 3600).toFixed(2),
          costCents: leafCostCents,
          revenueCents: leafRevenueCents,
          cost: +(leafCostCents / 100).toFixed(2),
          revenue: +(leafRevenueCents / 100).toFixed(2),
          entryCount: entryList.length
        };
      }

      const currentField = groupings[groupIndex];
      const buckets = {};

      for (const entry of entryList) {
        const key = resolveGroupKey(entry, currentField);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(entry);
      }

      const children = [];
      let groupTotalSeconds = 0;
      let groupBillableSeconds = 0;
      let groupCostCents = 0;
      let groupRevenueCents = 0;

      for (const [key, items] of Object.entries(buckets)) {
        const subResult = buildGroupTree(items, groupIndex + 1);
        children.push({
          key,
          groupField: currentField,
          ...subResult
        });
        groupTotalSeconds += subResult.totalSeconds;
        groupBillableSeconds += (subResult.billableSeconds !== undefined ? subResult.billableSeconds : (subResult.billableHours ? Math.round(subResult.billableHours * 3600) : 0));
        groupCostCents += (subResult.costCents !== undefined ? subResult.costCents : Math.round((subResult.cost || 0) * 100));
        groupRevenueCents += (subResult.revenueCents !== undefined ? subResult.revenueCents : Math.round((subResult.revenue || 0) * 100));
      }

      return {
        totalSeconds: groupTotalSeconds,
        billableSeconds: groupBillableSeconds,
        totalHours: +(groupTotalSeconds / 3600).toFixed(2),
        billableHours: +(groupBillableSeconds / 3600).toFixed(2),
        costCents: groupCostCents,
        revenueCents: groupRevenueCents,
        cost: +(groupCostCents / 100).toFixed(2),
        revenue: +(groupRevenueCents / 100).toFixed(2),
        groups: children
      };
    };

    const tree = buildGroupTree(entries, 0);

    // Explicit response DTO whitelist. USER responses never inherit new
    // internal financial fields accidentally when the calculation model evolves.
    const includeFinancial = !isRegularUser;
    return {
      workspaceId,
      groupings: [...groupings],
      totalEntries: entries.length,
      overall: this._toSummaryOverallDTO(tree, includeFinancial),
      tree: (tree.groups || []).map(node =>
        this._toSummaryNodeDTO(node, includeFinancial)
      )
    };
  },

  /**
   * Detailed Report: Flattened row-by-row time records with filter criteria
   */
  getDetailedReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);

    // Resolve entities for human-readable labels
    const projects = SheetRepository.listProjects(workspaceId);
    const projMap = {};
    projects.forEach(p => { projMap[p.ProjectID] = p.ProjectName; });

    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const tasks = SheetRepository.listTasks(workspaceId);
    const taskMap = {};
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const rows = entries.map(e => {
      const dur = parseInt(e.DurationSeconds, 10) || 0;
      return {
        entryId: e.EntryID,
        userId: e.UserID,
        userName: userMap[e.UserID] || e.UserID,
        projectId: e.ProjectID,
        projectName: projMap[e.ProjectID] || 'No Project',
        taskId: e.TaskID,
        taskName: taskMap[e.TaskID] || '',
        description: e.Description,
        tags: e.Tags,
        startUTC: e.StartUTC,
        endUTC: e.EndUTC,
        businessDate: e.StartUTC ? TimezoneService.formatDateKey(workspaceId, e.StartUTC) : '',
        startLocal: e.StartUTC ? TimezoneService.formatDateTime(workspaceId, e.StartUTC) : '',
        endLocal: e.EndUTC ? TimezoneService.formatDateTime(workspaceId, e.EndUTC) : '',
        timezone: TimezoneService.getWorkspaceTimezone(workspaceId),
        durationSeconds: dur,
        durationFormatted: this._formatSeconds(dur),
        billable: e.Billable === true || e.Billable === 'TRUE' || e.Billable === 1,
        approvalStatus: e.ApprovalStatus,
        source: e.EntrySource,
        manual: e.ManualEntry === true || e.ManualEntry === 'TRUE'
      };
    });

    return {
      workspaceId,
      totalCount: rows.length,
      entries: rows
    };
  },

  /**
   * Attendance & Utilization Report
   * Summarizes daily first/last punch, target vs tracked hours, missing, and overtime.
   */
  getAttendanceReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params,
      [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);
    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    // Group by User + Date
    const userDays = {};

    for (const e of entries) {
      const dateKey = TimezoneService.formatDateKey(workspaceId, e.StartUTC);
      const userKey = e.UserID;
      const compositeKey = `${userKey}__${dateKey}`;

      if (!userDays[compositeKey]) {
        userDays[compositeKey] = {
          userId: userKey,
          userName: userMap[userKey] || userKey,
          date: dateKey,
          firstPunchUTC: e.StartUTC,
          lastPunchUTC: e.EndUTC || e.StartUTC,
          totalSeconds: 0,
          entryCount: 0
        };
      }

      const item = userDays[compositeKey];
      item.totalSeconds += parseInt(e.DurationSeconds, 10) || 0;
      item.entryCount += 1;

      if (new Date(e.StartUTC).getTime() < new Date(item.firstPunchUTC).getTime()) {
        item.firstPunchUTC = e.StartUTC;
      }
      if (new Date(e.EndUTC || e.StartUTC).getTime() > new Date(item.lastPunchUTC).getTime()) {
        item.lastPunchUTC = e.EndUTC || e.StartUTC;
      }
    }

    const configuredTargetHours = parseFloat(
      MasterRepository.getGlobalSetting(
        `WS_${workspaceId}_DAILY_TARGET`,
        MasterRepository.getGlobalSetting('DEFAULT_WORKDAY_HOURS', '8')
      )
    ) || 8;
    const targetSecondsPerDay = configuredTargetHours * 3600;
    const results = Object.values(userDays).map(row => {
      const trackedHours = +(row.totalSeconds / 3600).toFixed(2);
      const targetHours = +(targetSecondsPerDay / 3600).toFixed(2);
      const diffHours = +(trackedHours - targetHours).toFixed(2);
      const overtimeHours = diffHours > 0 ? diffHours : 0;
      const missingHours = diffHours < 0 ? Math.abs(diffHours) : 0;

      return {
        ...row,
        trackedHours,
        targetHours,
        overtimeHours,
        missingHours
      };
    });

    return {
      workspaceId,
      attendance: results
    };
  },

  /**
   * Exceptions & Anomaly Report
   * Flags suspicious patterns: timers > 12h, large manual entries, overlaps.
   */
  getExceptionsReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params,
      [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);
    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const anomalies = [];

    // Sort entries by User and StartUTC for overlap detection
    const sorted = [...entries].sort((a, b) => new Date(a.StartUTC).getTime() - new Date(b.StartUTC).getTime());

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const durationSeconds = parseInt(current.DurationSeconds, 10) || 0;

      // Anomaly 1: Timer > 12 hours
      if (durationSeconds > 12 * 3600) {
        anomalies.push({
          type: 'EXCESSIVE_DURATION',
          severity: 'HIGH',
          entryId: current.EntryID,
          userId: current.UserID,
          userName: userMap[current.UserID] || current.UserID,
          durationHours: +(durationSeconds / 3600).toFixed(2),
          message: `Time entry duration exceeds 12 hours (${+(durationSeconds / 3600).toFixed(2)}h)`
        });
      }

      // Anomaly 2: Missing project or description
      if (!current.ProjectID || !current.Description) {
        anomalies.push({
          type: 'MISSING_METADATA',
          severity: 'LOW',
          entryId: current.EntryID,
          userId: current.UserID,
          userName: userMap[current.UserID] || current.UserID,
          message: 'Entry lacks a project assignment or description'
        });
      }

      // Anomaly 3: Overlapping entries for same user
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.UserID === current.UserID && prev.EndUTC && current.StartUTC) {
          const prevEnd = new Date(prev.EndUTC).getTime();
          const curStart = new Date(current.StartUTC).getTime();
          if (curStart < prevEnd - 60000) { // Overlap of more than 1 minute
            anomalies.push({
              type: 'OVERLAPPING_ENTRIES',
              severity: 'MEDIUM',
              entryId: current.EntryID,
              conflictWithEntryId: prev.EntryID,
              userId: current.UserID,
              userName: userMap[current.UserID] || current.UserID,
              message: `Entry overlaps with previous entry ${prev.EntryID}`
            });
          }
        }
      }
    }

    return {
      workspaceId,
      totalAnomalies: anomalies.length,
      anomalies
    };
  },

  _formatSeconds(sec) {
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
};

/* ===== RollupService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Rollup Service
 * Canonical source-of-truth reconciliation plus safe incremental CREATE updates.
 *
 * Rules:
 * - Raw active TimeEntries are authoritative.
 * - New entries may update rollups incrementally while the caller owns the write lock.
 * - Edits/deletes/project/rate/date/billable changes rebuild from raw source.
 * - Currency is accumulated as integer cents per entry to avoid floating drift.
 */

var RollupService = (typeof global !== 'undefined' && global.RollupService) || {
  _getWeekBounds(workspaceId, startDate) {
    const bounds = TimezoneService.getWeekBounds(workspaceId, startDate);
    return {
      weekStart: bounds.startLocalDate,
      weekEnd: bounds.endLocalDate
    };
  },

  _amountCents(seconds, rate) {
    return Math.round(((parseInt(seconds, 10) || 0) * (parseFloat(rate) || 0) * 100) / 3600);
  },

  _entryContribution(workspaceId, entry) {
    if (!entry || entry.Status === 'DELETED') return null;

    const startDate = new Date(entry.StartUTC);
    if (!Number.isFinite(startDate.getTime())) return null;

    const seconds = Math.max(0, parseInt(entry.DurationSeconds, 10) || 0);
    const isBillable =
      entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1;
    const projectId = entry.ProjectID || 'unassigned';
    const rollupDate = TimezoneService.formatDateKey(workspaceId, startDate);
    const monthKey = TimezoneService.formatMonthKey(workspaceId, startDate);
    const { weekStart, weekEnd } = this._getWeekBounds(workspaceId, startDate);

    return {
      userId: entry.UserID,
      projectId,
      rollupDate,
      monthKey,
      weekStart,
      weekEnd,
      seconds,
      billableSeconds: isBillable ? seconds : 0,
      costCents: this._amountCents(seconds, entry.CostRateSnapshot),
      revenueCents: isBillable
        ? this._amountCents(seconds, entry.HourlyRateSnapshot)
        : 0
    };
  },

  _addAggregate(map, key, seed, contribution) {
    let item = map.get(key);
    if (!item) {
      item = { ...seed, _costCents: 0, _revenueCents: 0 };
      map.set(key, item);
    }
    item.TotalSeconds += contribution.seconds;
    item.BillableSeconds += contribution.billableSeconds;
    item._costCents += contribution.costCents;
    item._revenueCents += contribution.revenueCents;
    item.EntryCount += 1;
    return item;
  },

  _finalizeAggregateRows(map, calculatedAt) {
    return [...map.values()]
      .map(item => {
        const row = { ...item };
        row.CostAmount = +(row._costCents / 100).toFixed(2);
        row.BillableAmount = +(row._revenueCents / 100).toFixed(2);
        row.LastCalculatedAt = calculatedAt;
        delete row._costCents;
        delete row._revenueCents;
        return row;
      });
  },

  /**
   * Deterministically derives every rollup row from raw source entries.
   */
  _buildCanonicalRollups(workspaceId, rawEntries, calculatedAt = new Date().toISOString()) {
    const daily = new Map();
    const weekly = new Map();
    const monthly = new Map();
    const projects = new Map();

    for (const entry of rawEntries || []) {
      const c = this._entryContribution(workspaceId, entry);
      if (!c) continue;

      this._addAggregate(
        daily,
        [c.rollupDate, c.userId, c.projectId].join('|'),
        {
          RollupDate: c.rollupDate,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      this._addAggregate(
        weekly,
        [c.weekStart, c.userId, c.projectId].join('|'),
        {
          WeekStart: c.weekStart,
          WeekEnd: c.weekEnd,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      this._addAggregate(
        monthly,
        [c.monthKey, c.userId, c.projectId].join('|'),
        {
          MonthKey: c.monthKey,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      if (c.projectId !== 'unassigned') {
        let project = projects.get(c.projectId);
        if (!project) {
          project = {
            ProjectID: c.projectId,
            TotalSeconds: 0,
            BillableSeconds: 0,
            _costCents: 0,
            _revenueCents: 0,
            contributors: new Set()
          };
          projects.set(c.projectId, project);
        }
        project.TotalSeconds += c.seconds;
        project.BillableSeconds += c.billableSeconds;
        project._costCents += c.costCents;
        project._revenueCents += c.revenueCents;
        project.contributors.add(c.userId);
      }
    }

    const sortBy = fields => (a, b) => {
      for (const field of fields) {
        const cmp = String(a[field] || '').localeCompare(String(b[field] || ''));
        if (cmp !== 0) return cmp;
      }
      return 0;
    };

    const dailyRows = this._finalizeAggregateRows(daily, calculatedAt)
      .sort(sortBy(['RollupDate', 'UserID', 'ProjectID']));
    const weeklyRows = this._finalizeAggregateRows(weekly, calculatedAt)
      .sort(sortBy(['WeekStart', 'UserID', 'ProjectID']));
    const monthlyRows = this._finalizeAggregateRows(monthly, calculatedAt)
      .sort(sortBy(['MonthKey', 'UserID', 'ProjectID']));

    const projectRows = [...projects.values()].map(item => {
      const project = SheetRepository.getProject(workspaceId, item.ProjectID);
      const estimateHours = project ? (parseFloat(project.EstimateHours) || 0) : 0;
      const remainingHours = Math.max(
        0,
        estimateHours - item.TotalSeconds / 3600
      );
      return {
        ProjectID: item.ProjectID,
        TotalSeconds: item.TotalSeconds,
        BillableSeconds: item.BillableSeconds,
        RemainingHours: +remainingHours.toFixed(2),
        TotalCost: +(item._costCents / 100).toFixed(2),
        TotalRevenue: +(item._revenueCents / 100).toFixed(2),
        ContributorCount: item.contributors.size,
        LastCalculatedAt: calculatedAt
      };
    }).sort(sortBy(['ProjectID']));

    return {
      DailyRollups: dailyRows,
      WeeklyRollups: weeklyRows,
      MonthlyRollups: monthlyRows,
      ProjectRollups: projectRows
    };
  },

  /**
   * Safe incremental path for a newly-created entry only.
   */
  recordTimeEntry(workspaceId, entry) {
    const c = this._entryContribution(workspaceId, entry);
    if (!c) return { ok: true, skipped: true };

    const now = new Date().toISOString();

    this._updateDailyRollup(workspaceId, {
      RollupDate: c.rollupDate,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateWeeklyRollup(workspaceId, {
      WeekStart: c.weekStart,
      WeekEnd: c.weekEnd,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateMonthlyRollup(workspaceId, {
      MonthKey: c.monthKey,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateProjectRollup(workspaceId, c, now);
    return { ok: true, mode: 'incremental-create' };
  },

  _updateDailyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.RollupDate === record.RollupDate &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
        {
          RollupDate: record.RollupDate,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateWeeklyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.WeekStart === record.WeekStart &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
        existing._rowIndex,
        {
          WeekEnd: record.WeekEnd,
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
        {
          WeekStart: record.WeekStart,
          WeekEnd: record.WeekEnd,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateMonthlyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.MonthKey === record.MonthKey &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS,
        {
          MonthKey: record.MonthKey,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateProjectRollup(workspaceId, contribution, calculatedAt) {
    if (!contribution.projectId || contribution.projectId === 'unassigned') return;

    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS
    );
    const existing = rows.find(r => r.ProjectID === contribution.projectId);
    const project = SheetRepository.getProject(workspaceId, contribution.projectId);
    const estimateHours = project ? (parseFloat(project.EstimateHours) || 0) : 0;

    const allProjectEntries = SheetRepository.listTimeEntries(workspaceId, {
      projectId: contribution.projectId
    });
    const contributorCount = new Set(allProjectEntries.map(e => e.UserID)).size;

    if (existing) {
      const totalSeconds =
        (parseInt(existing.TotalSeconds, 10) || 0) + contribution.seconds;
      const costCents =
        Math.round((parseFloat(existing.TotalCost) || 0) * 100) +
        contribution.costCents;
      const revenueCents =
        Math.round((parseFloat(existing.TotalRevenue) || 0) * 100) +
        contribution.revenueCents;

      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: totalSeconds,
          BillableSeconds:
            (parseInt(existing.BillableSeconds, 10) || 0) +
            contribution.billableSeconds,
          RemainingHours: +Math.max(
            0,
            estimateHours - totalSeconds / 3600
          ).toFixed(2),
          TotalCost: +(costCents / 100).toFixed(2),
          TotalRevenue: +(revenueCents / 100).toFixed(2),
          ContributorCount: contributorCount,
          LastCalculatedAt: calculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS,
        {
          ProjectID: contribution.projectId,
          TotalSeconds: contribution.seconds,
          BillableSeconds: contribution.billableSeconds,
          RemainingHours: +Math.max(
            0,
            estimateHours - contribution.seconds / 3600
          ).toFixed(2),
          TotalCost: +(contribution.costCents / 100).toFixed(2),
          TotalRevenue: +(contribution.revenueCents / 100).toFixed(2),
          ContributorCount: contributorCount,
          LastCalculatedAt: calculatedAt
        }
      );
    }
  },

  _rollupRelevantState(entry) {
    if (!entry) return null;
    return {
      UserID: entry.UserID || '',
      ProjectID: entry.ProjectID || '',
      StartUTC: entry.StartUTC || '',
      EndUTC: entry.EndUTC || '',
      DurationSeconds: parseInt(entry.DurationSeconds, 10) || 0,
      Billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
      HourlyRateSnapshot: parseFloat(entry.HourlyRateSnapshot) || 0,
      CostRateSnapshot: parseFloat(entry.CostRateSnapshot) || 0,
      Status: entry.Status || 'ACTIVE'
    };
  },

  mutationAffectsRollups(beforeEntry, afterEntry) {
    return JSON.stringify(this._rollupRelevantState(beforeEntry)) !==
      JSON.stringify(this._rollupRelevantState(afterEntry));
  },

  reconcileMutation(workspaceId, beforeEntry, afterEntry, mutationType = 'UPDATE') {
    const type = String(mutationType || 'UPDATE').toUpperCase();
    if (type === 'CREATE' && !beforeEntry && afterEntry) {
      return this.recordTimeEntry(workspaceId, afterEntry);
    }
    if (!this.mutationAffectsRollups(beforeEntry, afterEntry)) {
      return { ok: true, skipped: true, mode: 'metadata-only' };
    }
    return this.rebuildRollups(workspaceId);
  },

  /**
   * Full source-of-truth reconciliation from raw active TimeEntries.
   */
  rebuildRollups(workspaceId) {
    const rawEntries = SheetRepository.listTimeEntries(workspaceId, {});
    const calculatedAt = new Date().toISOString();
    const canonical = this._buildCanonicalRollups(
      workspaceId,
      rawEntries,
      calculatedAt
    );

    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const tabMappings = [
      [CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS, canonical.DailyRollups],
      [CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS, canonical.WeeklyRollups],
      [CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS, canonical.MonthlyRollups],
      [CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS, canonical.ProjectRollups]
    ];

    for (const [tab, rows] of tabMappings) {
      const sheet = ss.getSheetByName(tab);
      if (!sheet) {
        throw new AppError(
          ERROR_CODES.NOT_FOUND,
          `Workspace rollup tab '${tab}' does not exist.`,
          404
        );
      }
      if (sheet.getLastRow() > 1) {
        sheet.deleteRows(2, sheet.getLastRow() - 1);
      }
      if (SheetRepository.clearTableCache) {
        SheetRepository.clearTableCache(workspaceId, tab);
      }
      for (const row of rows) {
        SheetRepository.appendRow(workspaceId, tab, row);
      }
    }

    return {
      ok: true,
      mode: 'full-rebuild',
      entriesProcessed: rawEntries.length,
      rowCounts: {
        daily: canonical.DailyRollups.length,
        weekly: canonical.WeeklyRollups.length,
        monthly: canonical.MonthlyRollups.length,
        project: canonical.ProjectRollups.length
      }
    };
  }
};

/* ===== DashboardService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Dashboard Service
 * Dashboard values are correctness-first: current-day/week totals are derived
 * from raw active TimeEntries in the workspace timezone, while live workforce
 * status comes from ActiveTimers.
 */

var DashboardService = (typeof global !== 'undefined' && global.DashboardService) || {
  _resolveTargetWorkspaces(authContext, requestedWorkspaceId = null) {
    const accessible = WorkspaceService.listWorkspaces(authContext);
    if (!requestedWorkspaceId) return { accessible, targets: accessible };

    const target = accessible.find(
      ws => ws.WorkspaceID === requestedWorkspaceId
    );
    if (!target) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        'The requested dashboard workspace is not accessible.',
        403
      );
    }
    return { accessible, targets: [target] };
  },

  _workspaceCurrentTotals(authContext, workspaceId, now = new Date()) {
    const today = TimezoneService.formatDateKey(workspaceId, now);
    const week = TimezoneService.getWeekBounds(workspaceId, now);
    const entries = SheetRepository.listTimeEntries(workspaceId, {});

    let todaySeconds = 0;
    let weekSeconds = 0;

    for (const entry of entries) {
      if (
        authContext.role === CONSTANTS.ROLES.USER &&
        entry.UserID !== authContext.userId
      ) {
        continue;
      }

      const businessDate = TimezoneService.formatDateKey(
        workspaceId,
        entry.StartUTC
      );
      const seconds = parseInt(entry.DurationSeconds, 10) || 0;

      if (businessDate === today) {
        todaySeconds += seconds;
      }
      if (
        businessDate >= week.startLocalDate &&
        businessDate <= week.endLocalDate
      ) {
        weekSeconds += seconds;
      }
    }

    return {
      today,
      weekStart: week.startLocalDate,
      weekEnd: week.endLocalDate,
      todaySeconds,
      weekSeconds
    };
  },

  /**
   * Live "Who is working now?" radar.
   */
  getLiveWorkforceRadar(authContext, requestedWorkspaceId = null) {
    const { targets } = this._resolveTargetWorkspaces(
      authContext,
      requestedWorkspaceId
    );
    const workingNowList = [];

    for (const ws of targets) {
      try {
        const { rows: timers } = SheetRepository.getTableData(
          ws.WorkspaceID,
          CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS
        );
        const members = SheetRepository.listMembers(ws.WorkspaceID);
        const memberMap = {};
        members.forEach(m => { memberMap[m.UserID] = m.DisplayName; });

        const projects = SheetRepository.listProjects(ws.WorkspaceID);
        const projectMap = {};
        projects.forEach(p => { projectMap[p.ProjectID] = p.ProjectName; });

        for (const timer of timers) {
          if (
            authContext.role === CONSTANTS.ROLES.USER &&
            timer.UserID !== authContext.userId
          ) {
            continue;
          }

          const startedAtMs = new Date(timer.StartedAtUTC).getTime();
          const elapsedSeconds = Number.isFinite(startedAtMs)
            ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))
            : 0;

          workingNowList.push({
            timerId: timer.TimerID,
            userId: timer.UserID,
            userName: memberMap[timer.UserID] || timer.UserID,
            workspaceId: ws.WorkspaceID,
            workspaceName: ws.WorkspaceName,
            projectId: timer.ProjectID,
            projectName: projectMap[timer.ProjectID] || 'No Project',
            taskId: timer.TaskID,
            description: timer.Description,
            startedAtUTC: timer.StartedAtUTC,
            elapsedSeconds,
            source: timer.Source || 'WEB'
          });
        }
      } catch (err) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          `Dashboard could not read workspace ${ws.WorkspaceID}. Please retry.`,
          503,
          { workspaceId: ws.WorkspaceID, cause: err && err.message ? err.message : String(err) }
        );
      }
    }

    return {
      timestampUTC: new Date().toISOString(),
      activeCount: workingNowList.length,
      workers: workingNowList
    };
  },

  /**
   * Dashboard overview KPI cards.
   */
  getDashboardOverview(authContext, requestedWorkspaceId = null) {
    const { accessible, targets } = this._resolveTargetWorkspaces(
      authContext,
      requestedWorkspaceId
    );

    const liveRadar = this.getLiveWorkforceRadar(
      authContext,
      requestedWorkspaceId
    );

    let totalTrackedSecondsToday = 0;
    let totalTrackedSecondsThisWeek = 0;
    let pendingApprovalsCount = 0;
    const periodSummaries = [];

    for (const ws of targets) {
      try {
        const totals = this._workspaceCurrentTotals(
          authContext,
          ws.WorkspaceID,
          new Date()
        );
        totalTrackedSecondsToday += totals.todaySeconds;
        totalTrackedSecondsThisWeek += totals.weekSeconds;
        periodSummaries.push({
          workspaceId: ws.WorkspaceID,
          businessDate: totals.today,
          weekStart: totals.weekStart,
          weekEnd: totals.weekEnd
        });

        const timesheets = SheetRepository.listTimesheets(
          ws.WorkspaceID,
          { status: CONSTANTS.TIMESHEET_STATUS.SUBMITTED }
        );
        pendingApprovalsCount += authContext.role === CONSTANTS.ROLES.USER
          ? timesheets.filter(ts => ts.UserID === authContext.userId).length
          : timesheets.length;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          `Dashboard could not calculate workspace ${ws.WorkspaceID}. Please retry.`,
          503,
          { workspaceId: ws.WorkspaceID, cause: err && err.message ? err.message : String(err) }
        );
      }
    }

    let pendingRequestsCount = 0;
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      pendingRequestsCount = MasterRepository
        .listRequests(CONSTANTS.REQUEST_STATUS.PENDING)
        .length;
    }

    let activeUsersCount = 0;
    let passiveUsersCount = 0;
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      const { rows: accounts } = MasterRepository.getTableData(
        CONSTANTS.MASTER_TABS.ACCOUNTS
      );
      activeUsersCount = accounts.filter(
        account => account.Status === CONSTANTS.ACCOUNT_STATUS.ACTIVE
      ).length;
      passiveUsersCount = accounts.filter(
        account => account.Status === CONSTANTS.ACCOUNT_STATUS.PASSIVE
      ).length;
    }

    return {
      accessibleWorkspacesCount: accessible.length,
      workspacesCount: accessible.length,
      activeUsersCount,
      passiveUsersCount,
      activeTimersCount: liveRadar.activeCount,
      workingNow: liveRadar.workers,
      todayTrackedHours: +(totalTrackedSecondsToday / 3600).toFixed(2),
      weekTrackedHours: +(totalTrackedSecondsThisWeek / 3600).toFixed(2),
      currentBusinessDate:
        periodSummaries.length === 1 ? periodSummaries[0].businessDate : '',
      currentWeekStart:
        periodSummaries.length === 1 ? periodSummaries[0].weekStart : '',
      currentWeekEnd:
        periodSummaries.length === 1 ? periodSummaries[0].weekEnd : '',
      workspacePeriods: periodSummaries,
      pendingApprovalsCount,
      pendingRequestsCount
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ClientService, ProjectService, TaskService, TagService, TimeEntryService, TimerService, TimesheetService, ApprovalService, ReportService, RollupService, DashboardService };
}

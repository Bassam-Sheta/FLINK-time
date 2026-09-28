/**
 * FLINK Time & Workforce Platform — Master Data Services
 * ClientService, ProjectService, TaskService, and TagService.
 * Governs workspace master entities, billing rate configurations, and estimates.
 */

const ClientService = {
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

const ProjectService = {
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

const TaskService = {
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

const TagService = {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ClientService,
    ProjectService,
    TaskService,
    TagService
  };
}

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

    const clientId = Validation.generateId('CLI');
    const clientRecord = {
      ClientID: clientId,
      ClientName: Validation.sanitizeCellValue(clientPayload.clientName.trim()),
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

    const assignments = SheetRepository.listUserProjectAccess(workspaceId, authContext.userId);
    if (assignments.length > 0) {
      const allowedIds = new Set(
        assignments
          .filter(row => TrackingPolicyService._toBoolean(row.CanTrack, false))
          .map(row => row.ProjectID)
      );
      projects = projects.filter(project => allowedIds.has(project.ProjectID));
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
      ProjectName: Validation.sanitizeCellValue(payload.projectName.trim()),
      Code: payload.code ? Validation.sanitizeCellValue(payload.code.trim()) : '',
      Status: 'ACTIVE',
      BillableDefault: payload.billableDefault !== undefined ? (payload.billableDefault ? true : false) : true,
      HourlyRate: parseFloat(payload.hourlyRate) || 0,
      CostRate: parseFloat(payload.costRate) || 0,
      EstimateHours: parseFloat(payload.estimateHours) || 0,
      BudgetAmount: parseFloat(payload.budgetAmount) || 0,
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

    const sanitizedUpdates = {};
    if (updates.projectName) sanitizedUpdates.ProjectName = Validation.sanitizeCellValue(updates.projectName.trim());
    if (updates.code !== undefined) sanitizedUpdates.Code = Validation.sanitizeCellValue(updates.code.trim());
    if (updates.status) sanitizedUpdates.Status = updates.status;
    if (updates.hourlyRate !== undefined) sanitizedUpdates.HourlyRate = parseFloat(updates.hourlyRate) || 0;
    if (updates.costRate !== undefined) sanitizedUpdates.CostRate = parseFloat(updates.costRate) || 0;
    if (updates.estimateHours !== undefined) sanitizedUpdates.EstimateHours = parseFloat(updates.estimateHours) || 0;
    if (updates.budgetAmount !== undefined) sanitizedUpdates.BudgetAmount = parseFloat(updates.budgetAmount) || 0;
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

    let allowedProjectIds = null;
    const assignments = SheetRepository.listUserProjectAccess(workspaceId, authContext.userId);
    if (assignments.length > 0) {
      allowedProjectIds = new Set(
        assignments
          .filter(row => TrackingPolicyService._toBoolean(row.CanTrack, false))
          .map(row => row.ProjectID)
      );
    }

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

    const taskId = Validation.generateId('TSK');
    const taskRecord = {
      TaskID: taskId,
      ProjectID: payload.projectId,
      TaskName: Validation.sanitizeCellValue(payload.taskName.trim()),
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

    const tagId = Validation.generateId('TAG');
    const tagRecord = {
      TagID: tagId,
      TagName: Validation.sanitizeCellValue(payload.tagName.trim()),
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

/**
 * FLINK Time & Workforce Platform — Main Application Dispatcher & API Controller
 * Serves Google Apps Script Web App (doGet / doPost), embeds into Google Sites,
 * and routes API actions with LockService concurrency guards and unified error handling.
 */

function doGet(e) {
  const params = e ? e.parameter : {};
  const action = params ? params.action : '';
  const view = params ? params.view : '';

  // Serve Super Admin UI if requested explicitly via action or view parameter
  if (action === 'admin_ui' || view === 'admin') {
    try {
      const template = HtmlService.createTemplateFromFile('admin_ui');
      const output = template.evaluate();
      output.setTitle('Ultra-Account Super Admin Controller');
      output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
      output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
      return output;
    } catch (adminErr) {
      try {
        return HtmlService.createHtmlOutputFromFile('admin_ui')
          .setTitle('Ultra-Account Super Admin Controller')
          .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
          .addMetaTag('viewport', 'width=device-width, initial-scale=1');
      } catch (e2) {
        return ContentService.createTextOutput('Admin UI Template not found: ' + adminErr.message)
          .setMimeType(ContentService.MimeType.TEXT);
      }
    }
  }

  // If action query parameter is passed, treat as GET API request
  if (action) {
    return handleApiRequest(action, params);
  }

  // Otherwise serve the Google Workspace-Native Web Application UI
  try {
    const template = HtmlService.createTemplateFromFile('index');
    const output = template.evaluate();
    output.setTitle('FLINK Time & Workforce Platform');
    output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // Allows embedding inside Google Sites
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return output;
  } catch (err) {
    return ContentService.createTextOutput('FLINK Platform Portal: ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function doPost(e) {
  let action = '';
  let payload = {};

  try {
    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);
      action = parsed.action || '';
      payload = parsed;
    } else if (e && e.parameter) {
      action = e.parameter.action || '';
      payload = e.parameter;
    }
  } catch (err) {
    return buildJsonResponse({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON payload: ' + err.message }
    });
  }

  return handleApiRequest(action, payload);
}

/**
 * Centralized Action Permissions Matrix (Default-Deny)
 * Every API endpoint MUST be explicitly declared with its authentication,
 * role authorizations, workspace binding, and mutation requirements.
 */
const ACTION_PERMISSIONS = {
  // Public / Unauthenticated
  'auth.login': { authRequired: false, isWrite: true },
  'auth.verifyMfa': { authRequired: false, isWrite: true },
  'system.bootstrap': { authRequired: false, isWrite: true },
  'setup.status': { authRequired: false, isWrite: false },

  // User Authentication, MFA & Profile
  'auth.validateSession': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'auth.logout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.changePassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.enrollMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.confirmMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.disableMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Setup Wizard
  'setup.completeStep': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true, allowUnauthStep1: true },
  'setup.finalize': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Workspaces
  'workspaces.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'workspaces.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.assignAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.removeAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.deletePermanent': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Users
  'users.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'users.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.makePassive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.activate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.resetPassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.unlock': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.forceLogout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.assignWorkspace': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: true },

  // Requests
  'requests.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'requests.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'requests.review': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Timer & Time Entries
  'timer.start': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.stop': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.getActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.createManual': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.delete': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.bulkAction': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },

  // Timesheet & Approvals
  'timesheet.getWeekly': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'timesheet.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timesheet.approve': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reject': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reopen': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], requiresWorkspace: true, isWrite: true },

  // Master Data
  'clients.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'clients.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'projects.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tasks.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tasks.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tags.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tags.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Reports & Dashboards
  'reports.summary': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.detailed': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.attendance': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exceptions': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exportCsv': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'dashboard.radar': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },
  'dashboard.overview': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },

  // System Diagnostics & Repairs
  'system.health': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'system.repair': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'system.diagnostics': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },

  // Settings & Configuration
  'settings.get': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'settings.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Sessions & Security
  'sessions.listActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'sessions.revoke': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Backups & Restores
  'backups.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'backups.restoreValidate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'backups.restoreApply': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'rollups.rebuild': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Jobs & Capacity
  'jobs.dispatchHousekeeping': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.dispatchRollups': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.capacity': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },

  // Integrity & Audit
  'integrity.audit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'audit.verifyChain': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false }
};

/**
 * Universal API Request Handler
 */
function handleApiRequest(action, requestData) {
  // 1. Check if action is handled by modern modular App RBAC matrix
  const perm = ACTION_PERMISSIONS[action];
  if (perm) {
    let lock = null;
    if (perm.isWrite && typeof LockService !== 'undefined' && LockService.getScriptLock) {
      try {
        lock = LockService.getScriptLock();
        lock.waitLock(15000); // Wait up to 15 seconds for concurrent operations
      } catch (lockErr) {
        return buildJsonResponse({
          ok: false,
          error: { code: ERROR_CODES.CONFLICT, message: 'Server is busy processing concurrent writes. Please retry.' }
        });
      }
    }

    try {
      const result = dispatchAction(action, requestData);
      return buildJsonResponse({ ok: true, data: result });
    } catch (err) {
      if (err instanceof AppError) {
        return buildJsonResponse(err.toJSON());
      }
      return buildJsonResponse({
        ok: false,
        error: {
          code: ERROR_CODES.INTERNAL_ERROR,
          message: err.message || 'An unexpected internal error occurred.'
        }
      });
    } finally {
      if (lock) {
        try { lock.releaseLock(); } catch (e) {}
      }
    }
  }

  // 2. Fallback: Ultra-Account Portable Desktop Tracker & Super Admin Controller actions
  return handleDesktopAndControllerAction(action, requestData);
}

/**
 * Handles actions from UltraAccount.exe desktop tracker, UltraPackager.exe,
 * and admin_ui.html Super Admin Controller.
 */
function handleDesktopAndControllerAction(action, payload) {
  try {
    // Read-only GET actions
    if (action === 'ping') {
      return jsonResponse({
        status: 'OK',
        version: typeof SCRIPT_VERSION !== 'undefined' ? SCRIPT_VERSION : '2.3.1',
        role: 'SUPER_ADMIN_GATEWAY',
        active_year: new Date().getFullYear(),
        timestamp: new Date().toISOString()
      });
    }

    if (action === 'workspace_manifest') {
      const email = payload.user_email || payload.email || (payload.user && payload.user.email) || null;
      return jsonResponse(getWorkspaceManifest(email));
    }

    if (action === 'get_active_radar') {
      return jsonResponse(getActiveWorkforceRadar());
    }

    if (action === 'get_reports') {
      return jsonResponse(queryReports(payload));
    }

    if (action === 'export_analyst_data') {
      return handleDataAnalystExport(payload);
    }

    // Mutating POST actions requiring concurrency lock
    const mutatingActions = [
      'setup_db', 'auth_handshake', 'sync_batch', 'batch_sync', 'submit_timesheet',
      'approval_action', 'entity_crud', 'incident_report', 'query_reports',
      'restore_database', 'create_backup', 'set_policy'
    ];

    if (!mutatingActions.includes(action)) {
      return buildJsonResponse({
        ok: false,
        error: { code: ERROR_CODES.NOT_FOUND, message: `Unknown or forbidden API action: ${action}` }
      });
    }

    let lock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      try {
        lock = LockService.getScriptLock();
        const hasLock = lock.tryLock(15000);
        if (!hasLock) {
          return jsonError('System busy: concurrent write lock timeout. Client will retry with jitter.', 429);
        }
      } catch (lockErr) {
        return jsonError('Lock error: ' + lockErr.message, 500);
      }
    }

    try {
      let result;
      switch (action) {
        case 'setup_db':
          result = setupDatabase(payload.year);
          break;
        case 'auth_handshake':
          result = handleAuthHandshake(payload);
          break;
        case 'sync_batch':
        case 'batch_sync':
          result = handleBatchSyncToMasterVault(payload);
          break;
        case 'submit_timesheet':
          result = handleSubmitTimesheet(payload);
          break;
        case 'approval_action':
          result = handleApprovalAction(payload);
          break;
        case 'entity_crud':
          result = handleEntityCrud(payload);
          break;
        case 'incident_report':
          result = handleIncidentReport(payload);
          break;
        case 'query_reports':
          result = queryReports(payload.filters || payload);
          break;
        case 'restore_database':
          result = handleFullDatabaseRestore(payload);
          break;
        case 'create_backup':
          result = createNightlyBackupSnapshot();
          break;
        case 'set_policy':
          result = handleSetPolicy(payload);
          break;
        default:
          result = { error: 'Unknown POST action: ' + action };
          break;
      }

      if (result && result.status === 'ERROR') {
        return jsonError(result.error || result.message || 'Error processing request', result.code || 400);
      }

      return jsonResponse(result);
    } finally {
      if (lock) {
        try { lock.releaseLock(); } catch (e) {}
      }
    }
  } catch (err) {
    return jsonError(err.toString(), 500);
  }
}

/**
 * Action Router with Centralized Default-Deny Authorization
 */
function dispatchAction(action, data, authContextOverride = null) {
  const perm = ACTION_PERMISSIONS[action];
  if (!perm) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }

  const token = data.sessionToken || data.token || '';
  const wsId = data.workspaceId || (data.payload && data.payload.workspaceId) || '';
  const payload = data.payload || data;

  // Unauthenticated actions
  if (!perm.authRequired) {
    if (action === 'auth.login') {
      return AuthService.login(payload.username, payload.password, payload.clientType);
    }
    if (action === 'auth.verifyMfa') {
      return AuthService.verifyMfa(payload.mfaChallengeToken, payload.code, payload.clientType);
    }
    if (action === 'system.bootstrap') {
      return MigrationService.bootstrapMasterSheet();
    }
    if (action === 'setup.status') {
      return SetupService.getSetupStatus();
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Unhandled unauthenticated action: ${action}`);
  }

  // Allow unauthenticated bootstrap for Setup step 1 if system is fresh
  if (action === 'setup.completeStep' && (payload.step === 1 || payload.step === '1') && !token) {
    return SetupService.processStep(1, payload, null);
  }

  // All other actions require authenticated session
  const authContext = authContextOverride || SessionService.validateSession(token);

  // Centralized RBAC Enforcement (Default-Deny)
  if (perm.roles && !perm.roles.includes(authContext.role)) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      `Permission denied: Required role not held for action ${action}. Current role: ${authContext.role}`,
      403
    );
  }

  // Centralized Workspace Access Enforcement
  if (perm.requiresWorkspace) {
    if (!wsId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `workspaceId is required for action ${action}.`, 400);
    }
    AuthorizationService.assertWorkspaceAccess(authContext, wsId);
  }

  switch (action) {
    case 'auth.validateSession':
      return { user: authContext.user, role: authContext.role };

    case 'auth.logout':
      return AuthService.logout(token);

    case 'auth.changePassword':
      return AuthService.changePassword(token, payload.oldPassword, payload.newPassword);

    case 'auth.enrollMfa':
      return AuthService.enrollMfa(authContext);

    case 'auth.confirmMfa':
      return AuthService.confirmMfa(authContext, payload.code);

    case 'auth.disableMfa':
      return AuthService.disableMfa(authContext, payload.targetUserId);

    case 'users.assignWorkspace':
      return WorkspaceService.assignUserToWorkspace(authContext, payload.targetUserId, payload.workspaceId || wsId);

    case 'audit.verifyChain':
      return AuditService.verifyAuditChain(payload.workspaceId || wsId || null);

    /* ---------------- WORKSPACES ---------------- */
    case 'workspaces.list':
      return WorkspaceService.listWorkspaces(authContext);

    case 'workspaces.create':
      return WorkspaceService.createWorkspace(authContext, payload);

    case 'workspaces.assignAdmin':
      return WorkspaceService.assignAdminToWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    case 'workspaces.removeAdmin':
      return WorkspaceService.removeAdminFromWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    /* ---------------- USERS ---------------- */
    case 'users.list':
      return UserService.listUsers(authContext, wsId);

    case 'users.create':
      return UserService.createUser(authContext, payload);

    case 'users.update':
      return UserService.updateUser(authContext, payload.targetUserId, payload.updates);

    case 'users.makePassive':
      return UserService.makeUserPassive(authContext, payload.targetUserId, payload.reason);

    case 'users.activate':
      return UserService.activateUser(authContext, payload.targetUserId);

    case 'users.resetPassword':
      return AuthService.resetPasswordByAdmin(authContext, payload.targetUserId, payload.temporaryPassword);

    /* ---------------- REQUESTS ---------------- */
    case 'requests.submit':
      return AdminRequestService.submitRequest(authContext, payload);

    case 'requests.list':
      return AdminRequestService.listRequests(authContext, payload.statusFilter, wsId);

    case 'requests.review':
      return AdminRequestService.reviewRequest(authContext, payload.requestId, payload);

    /* ---------------- TIMER & ENTRIES ---------------- */
    case 'timer.start':
      return TimerService.startTimer(authContext, wsId, payload);

    case 'timer.stop':
      return TimerService.stopTimer(authContext, wsId, payload);

    case 'timer.getActive':
      return TimerService.getActiveTimer(authContext, wsId);

    case 'entries.createManual':
      return TimeEntryService.createManualEntry(authContext, wsId, payload);

    case 'entries.update':
      return TimeEntryService.updateEntry(authContext, wsId, payload.entryId, payload.updates);

    case 'entries.delete':
      return TimeEntryService.deleteEntry(authContext, wsId, payload.entryId);

    case 'entries.list':
      return TimeEntryService.listEntries(authContext, wsId, payload.filters);

    /* ---------------- TIMESHEET & APPROVALS ---------------- */
    case 'timesheet.getWeekly':
      return TimesheetService.getWeeklyTimesheet(authContext, wsId, payload.targetUserId, payload.weekStartDate);

    case 'timesheet.submit':
      return TimesheetService.submitTimesheet(authContext, wsId, payload);

    case 'timesheet.approve':
      return ApprovalService.approveTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reject':
      return ApprovalService.rejectTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reopen':
      return ApprovalService.reopenTimesheet(authContext, wsId, payload.timesheetId, payload.reason);

    /* ---------------- MASTER DATA ---------------- */
    case 'clients.list':
      return ClientService.listClients(authContext, wsId);

    case 'clients.create':
      return ClientService.createClient(authContext, wsId, payload);

    case 'projects.list':
      return ProjectService.listProjects(authContext, wsId);

    case 'projects.create':
      return ProjectService.createProject(authContext, wsId, payload);

    case 'projects.update':
      return ProjectService.updateProject(authContext, wsId, payload.projectId, payload.updates);

    case 'tasks.list':
      return TaskService.listTasks(authContext, wsId, payload.projectId);

    case 'tasks.create':
      return TaskService.createTask(authContext, wsId, payload);

    case 'tags.list':
      return TagService.listTags(authContext, wsId);

    case 'tags.create':
      return TagService.createTag(authContext, wsId, payload);

    /* ---------------- REPORTS & DASHBOARDS ---------------- */
    case 'reports.summary':
      return ReportService.getSummaryReport(authContext, wsId, payload);

    case 'reports.detailed':
      return ReportService.getDetailedReport(authContext, wsId, payload);

    case 'reports.attendance':
      return ReportService.getAttendanceReport(authContext, wsId, payload);

    case 'reports.exceptions':
      return ReportService.getExceptionsReport(authContext, wsId, payload);

    case 'reports.exportCsv':
      return ExportService.exportDetailedCsv(authContext, wsId, payload);

    case 'dashboard.radar':
      return DashboardService.getLiveWorkforceRadar(authContext, wsId);

    case 'dashboard.overview':
      return DashboardService.getDashboardOverview(authContext, wsId);

    case 'system.health':
      return SetupService.processStep(9, {}, authContext);

    case 'system.repair':
      return SetupService.repairSystem(authContext);

    case 'system.diagnostics':
      return SetupService.getAdvancedDiagnostics(authContext);

    case 'setup.completeStep':
      return SetupService.processStep(payload.step, payload, authContext);

    case 'setup.finalize':
      return SetupService.processStep(9, payload, authContext);

    /* ---------------- SETTINGS & CONFIGURATION ---------------- */
    case 'settings.get':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      return MasterRepository.getAllGlobalSettings();

    case 'settings.save':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      for (const [k, v] of Object.entries(payload.settings || {})) {
        MasterRepository.setGlobalSetting(k, v, authContext.userId);
      }
      return { ok: true, message: 'Settings saved successfully.' };

    /* ---------------- SECURITY & SESSIONS ---------------- */
    case 'users.unlock':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.unlockAccount(payload.targetUserId);

    case 'users.forceLogout':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      SessionService.revokeAllUserSessions(payload.targetUserId);
      return { ok: true, message: `All active sessions revoked for user ${payload.targetUserId}.` };

    case 'sessions.listActive':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.listActiveSessions();

    case 'sessions.revoke':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      MasterRepository.updateSession(payload.sessionId, { Revoked: true, RevokedAt: new Date().toISOString() });
      return { ok: true, message: 'Session revoked successfully.' };

    /* ---------------- TIME ENTRY BULK & ADVANCED ---------------- */
    case 'entries.bulkAction':
      return {
        ok: true,
        affected: TimeEntryService.bulkAction(authContext, wsId, payload.entryIds, payload.actionType, payload.params)
      };

    case 'workspaces.deletePermanent':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      Validation.assertRequired(payload, ['workspaceId', 'workspaceName', 'adminPassword']);
      const credRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS).rows;
      const userCred = credRows.find(c => c.UserID === authContext.userId);
      if (!userCred || !SecurityService.verifyPassword(payload.adminPassword, userCred.PasswordHash)) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid Super Admin password confirmation.', 401);
      }
      return MasterRepository.deleteWorkspacePermanent(payload.workspaceId);

    /* ---------------- BACKUP & RESTORE ---------------- */
    case 'backups.create':
      return BackupService.createBackup(authContext, wsId);

    case 'backups.restoreValidate':
      return BackupService.validateBackup(authContext, payload.workspaceId || wsId, payload.backupId);

    case 'backups.restoreApply':
      return BackupService.restoreBackup(authContext, payload.workspaceId || wsId, payload.backupId || payload.backupFileId);

    case 'rollups.rebuild':
      return RollupService.rebuildRollups(wsId);

    /* ---------------- JOBS & CAPACITY ---------------- */
    case 'jobs.dispatchHousekeeping':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchHousekeeping();

    case 'jobs.dispatchRollups':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchRollups();

    case 'jobs.capacity':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      return JobService.getCapacityMetrics(payload.workspaceId || wsId);

    /* ---------------- INTEGRITY & AUDIT ---------------- */
    case 'integrity.audit':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return IntegrityService.runNightlyAudit();

    default:
      throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }
}

/**
 * Builds ContentService JSON HTTP response
 */
function buildJsonResponse(obj) {
  const jsonString = JSON.stringify(obj);
  if (typeof ContentService !== 'undefined' && ContentService.createTextOutput) {
    return ContentService.createTextOutput(jsonString).setMimeType(ContentService.MimeType.JSON);
  }
  return obj;
}

const App = {
  ACTION_PERMISSIONS,
  doGet,
  doPost,
  handleApiRequest,
  dispatchAction,
  buildJsonResponse
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ACTION_PERMISSIONS,
    App,
    doGet,
    doPost,
    handleApiRequest,
    dispatchAction,
    buildJsonResponse
  };
}

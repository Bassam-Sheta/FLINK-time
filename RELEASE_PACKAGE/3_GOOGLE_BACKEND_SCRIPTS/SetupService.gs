/**
 * FLINK Time & Workforce Platform — Setup & Self-Healing Service
 * Manages the 9-Step Guided Setup Wizard, first-run initialization,
 * 10-point system integrity verification, and zero-code automated self-healing.
 */

const SetupService = {
  /**
   * Evaluates current installation setup status
   */
  getSetupStatus() {
    let superAdminExists = false;
    let workspaceCount = 0;
    let adminCount = 0;
    let userCount = 0;
    let isSetupComplete = false;

    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      superAdminExists = accounts.some(a => a.Role === CONSTANTS.ROLES.SUPER_ADMIN && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
      adminCount = accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED).length;
      userCount = accounts.filter(a => a.Role === CONSTANTS.ROLES.USER && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED).length;
    } catch (e) {
      superAdminExists = false;
    }

    try {
      const workspaces = MasterRepository.listWorkspaces();
      workspaceCount = workspaces.filter(w => w.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED).length;
    } catch (e) {
      workspaceCount = 0;
    }

    const setupFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
    isSetupComplete = (setupFlag === 'true' || setupFlag === true) && superAdminExists && workspaceCount > 0;

    // Once initialization is complete, the public setup-status endpoint only needs
    // to tell the login page that setup is finished. Do not expose company settings,
    // workspace counts, or account counts to unauthenticated callers.
    if (isSetupComplete) {
      return {
        initialized: true,
        setupComplete: true
      };
    }

    const companyName = MasterRepository.getGlobalSetting('COMPANY_NAME', 'FLINK Business Solutions');
    const defaultTimezone = MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'Africa/Cairo');

    // Calculate current step for wizard resume
    let currentStep = 1;
    if (!superAdminExists) currentStep = 1;
    else if (!MasterRepository.getGlobalSetting('COMPANY_NAME')) currentStep = 2;
    else if (workspaceCount === 0) currentStep = 3;
    else if (adminCount === 0) currentStep = 4;
    else if (userCount === 0) currentStep = 5;
    else if (!isSetupComplete) currentStep = 9;

    return {
      initialized: isSetupComplete,
      setupComplete: isSetupComplete,
      superAdminExists,
      currentStep,
      companySettings: {
        companyName,
        defaultTimezone,
        weekStarts: MasterRepository.getGlobalSetting('WEEK_STARTS', 'Sunday'),
        workdayHours: MasterRepository.getGlobalSetting('DEFAULT_WORKDAY_HOURS', '8'),
        workweekHours: MasterRepository.getGlobalSetting('DEFAULT_WORKWEEK_HOURS', '40')
      },
      counts: {
        workspaces: workspaceCount,
        admins: adminCount,
        users: userCount
      }
    };
  },

  /**
   * Executes a step in the 9-step guided setup wizard
   */
  processStep(stepNumber, payload, authContext = null) {
    const step = parseInt(stepNumber, 10);

    switch (step) {
      case 1:
        return this._step1_SystemOwner(payload);

      case 2:
        return this._step2_CompanySettings(payload, authContext);

      case 3:
        return this._step3_Workspace(payload, authContext);

      case 4:
        return this._step4_Admin(payload, authContext);

      case 5:
        return this._step5_Employees(payload, authContext);

      case 6:
        return this._step6_Projects(payload, authContext);

      case 7:
        return this._step7_TimeRules(payload, authContext);

      case 8:
        return this._step8_ReportingAlerts(payload, authContext);

      case 9:
        return this._step9_SystemCheck(authContext);

      default:
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid setup wizard step: ${step}`);
    }
  },

  /* ---------------- WIZARD STEP IMPLEMENTATIONS ---------------- */

  _step1_SystemOwner(payload) {
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      return this._step1_SystemOwnerLocked(payload);
    } finally {
      lock.releaseLock();
    }
  },

  _step1_SystemOwnerLocked(payload) {
    Validation.assertRequired(payload, ['setupKey', 'fullName', 'username', 'password', 'confirmPassword']);

    // Caller already holds the script-wide installation lock. Do not reacquire
    // the same lock here; Apps Script locks are not a re-entrant transaction.
    // Ensure schema/pepper exist before reading master tables.
    MigrationService.bootstrapMasterSheet();

    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Script Properties are unavailable.');
    }
    const props = PropertiesService.getScriptProperties();
    const expectedSetupKeyHash = props.getProperty('FLINK_SETUP_KEY_HASH');
    if (!expectedSetupKeyHash) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Installation is not initialized. Run initializeInstallation() from the Apps Script editor first.',
        401
      );
    }
    const suppliedSetupKeyHash = SecurityService.hashToken(String(payload.setupKey).trim());
    if (!SecurityService.constantTimeEquals(suppliedSetupKeyHash, expectedSetupKeyHash)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid one-time installation key.', 401);
    }
    if (payload.password !== payload.confirmPassword) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Passwords do not match.');
    }
    Validation.validatePassword(payload.password);

    // Verify no Super Admin already registered
    const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    const existing = accounts.find(a => a.Role === CONSTANTS.ROLES.SUPER_ADMIN && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Super Admin account already exists. Please log in.');
    }

    const cleanUsername = String(payload.username).trim().toLowerCase();
    const googleEmail = IdentityService.getCurrentGoogleEmail(true);
    const adminUserId = Validation.generateId('USR');
    const hash = SecurityService.hashPassword(payload.password);
    const now = new Date().toISOString();

    const accountRecord = {
      UserID: adminUserId,
      Username: cleanUsername,
      DisplayName: String(payload.fullName).trim(),
      Role: CONSTANTS.ROLES.SUPER_ADMIN,
      Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
      PrimaryWorkspaceID: '',
      Email: googleEmail,
      CreatedAt: now,
      CreatedBy: 'SETUP_WIZARD',
      UpdatedAt: now,
      UpdatedBy: 'SETUP_WIZARD',
      LastLoginAt: '',
      MustChangePassword: false
    };

    MasterRepository.createAccount(accountRecord, {
      UserID: adminUserId,
      PasswordHash: hash,
      PasswordVersion: 1,
      PasswordChangedAt: now,
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    MasterRepository.logGlobalAudit({
      ActorUserID: adminUserId,
      ActorRole: CONSTANTS.ROLES.SUPER_ADMIN,
      WorkspaceID: 'MASTER',
      EntityType: 'USER',
      EntityID: adminUserId,
      Action: CONSTANTS.AUDIT_EVENTS.USER_CREATED,
      AfterJSON: { username: cleanUsername, role: CONSTANTS.ROLES.SUPER_ADMIN },
      Reason: 'Root Super Admin created via Setup Wizard Step 1'
    });

    // One-time installation key is invalid after successful root-account creation.
    props.deleteProperty('FLINK_SETUP_KEY_HASH');
    props.deleteProperty('FLINK_SETUP_KEY_CREATED_AT');

    // Automatically issue session for immediate progression
    const session = SessionService.createSession(
      adminUserId,
      'SETUP_WIZARD',
      googleEmail
    );

    return {
      ok: true,
      message: 'Super Admin initialized successfully.',
      user: {
        userId: adminUserId,
        username: cleanUsername,
        displayName: accountRecord.DisplayName,
        role: CONSTANTS.ROLES.SUPER_ADMIN,
        email: googleEmail
      },
      sessionToken: session.sessionToken
    };
  },

  _step2_CompanySettings(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.companyName) MasterRepository.setGlobalSetting('COMPANY_NAME', payload.companyName, actorId, 'Company Legal Name');
    if (payload.timezone) MasterRepository.setGlobalSetting('DEFAULT_TIMEZONE', payload.timezone, actorId, 'Default Company Timezone');
    if (payload.weekStarts) MasterRepository.setGlobalSetting('WEEK_STARTS', payload.weekStarts, actorId, 'First day of timesheet week');
    if (payload.workdayHours) MasterRepository.setGlobalSetting('DEFAULT_WORKDAY_HOURS', String(payload.workdayHours), actorId, 'Daily target workday hours');
    if (payload.workweekHours) MasterRepository.setGlobalSetting('DEFAULT_WORKWEEK_HOURS', String(payload.workweekHours), actorId, 'Weekly target workweek hours');

    return { ok: true, message: 'Company settings saved successfully.' };
  },

  _step3_Workspace(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 3.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(payload, ['name']);

    const ws = WorkspaceService.createWorkspace(authContext, {
      name: payload.name,
      timezone: payload.timezone || MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'Africa/Cairo')
    });

    if (payload.dailyTargetHours) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_DAILY_TARGET`, String(payload.dailyTargetHours), authContext.userId);
    }
    if (payload.requireWeeklyApproval !== undefined) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_REQUIRE_APPROVAL`, String(payload.requireWeeklyApproval), authContext.userId);
    }
    if (payload.allowManualTime !== undefined) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_ALLOW_MANUAL`, String(payload.allowManualTime), authContext.userId);
    }

    return { ok: true, workspace: ws, message: 'Initial workspace provisioned with all 18 tabs.' };
  },

  _step4_Admin(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 4.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Admin creation skipped.' };
    }

    Validation.assertRequired(
      payload,
      ['fullName', 'username', 'email', 'temporaryPassword', 'workspaceIds']
    );

    const workspaceIds = Array.isArray(payload.workspaceIds) ? payload.workspaceIds : [payload.workspaceIds];
    if (workspaceIds.length > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
      throw new AppError(
        ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
        `Admins can only be assigned to a maximum of ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES} active workspaces.`,
        400
      );
    }

    const adminUser = UserService.createUser(authContext, {
      username: payload.username,
      displayName: payload.fullName,
      email: Validation.validateEmail(payload.email),
      role: CONSTANTS.ROLES.ADMIN,
      primaryWorkspaceId: workspaceIds[0] || '',
      temporaryPassword: payload.temporaryPassword,
      mustChangePassword: true
    });

    // Assign to selected workspaces
    for (const wsId of workspaceIds) {
      WorkspaceService.assignAdminToWorkspace(authContext, adminUser.userId, wsId);
    }

    return { ok: true, admin: adminUser, message: 'Admin created and assigned successfully.' };
  },

  _step5_Employees(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 5.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Employee intake skipped.' };
    }

    const usersToCreate = Array.isArray(payload.users) ? payload.users : [payload];
    const createdUsers = [];

    for (const u of usersToCreate) {
      if (!u.username || !u.fullName) continue;
      if (!u.email) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `email is required for user ${u.username}.`,
          400
        );
      }
      const created = UserService.createUser(authContext, {
        username: u.username,
        displayName: u.fullName,
        email: Validation.validateEmail(u.email),
        role: CONSTANTS.ROLES.USER,
        primaryWorkspaceId: u.workspaceId || '',
        department: u.department || '',
        jobTitle: u.jobTitle || '',
        employeeCode: u.employeeCode || '',
        temporaryPassword: (() => {
          if (!u.temporaryPassword) {
            throw new AppError(ERROR_CODES.VALIDATION_ERROR, `temporaryPassword is required for user ${u.username}.`);
          }
          Validation.validatePassword(u.temporaryPassword);
          return u.temporaryPassword;
        })(),
        mustChangePassword: true
      });
      createdUsers.push(created);
    }

    return { ok: true, count: createdUsers.length, users: createdUsers, message: `Created ${createdUsers.length} employees.` };
  },

  _step6_Projects(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 6.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Project scaffolding skipped.' };
    }

    Validation.assertRequired(payload, ['workspaceId', 'projectName']);
    const wsId = payload.workspaceId;

    let clientId = '';
    if (payload.clientName) {
      const client = ClientService.createClient(authContext, wsId, {
        clientName: payload.clientName,
        notes: 'Created via setup wizard'
      });
      clientId = client.ClientID;
    }

    const project = ProjectService.createProject(authContext, wsId, {
      clientId,
      projectName: payload.projectName,
      code: payload.projectCode || payload.projectName.substring(0, 6).toUpperCase(),
      billableDefault: payload.billable !== false,
      hourlyRate: payload.hourlyRate || 0,
      estimateHours: payload.estimateHours || 0
    });

    // Create tasks if provided
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : ['General Tasks', 'Review'];
    const createdTasks = [];
    for (const tName of tasks) {
      const task = TaskService.createTask(authContext, wsId, {
        projectId: project.ProjectID,
        taskName: tName,
        billableDefault: project.BillableDefault
      });
      createdTasks.push(task);
    }

    return { ok: true, project, tasks: createdTasks, message: 'Project and tasks scaffolded successfully.' };
  },

  _step7_TimeRules(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.projectRequired !== undefined) MasterRepository.setGlobalSetting('RULE_PROJECT_REQUIRED', String(payload.projectRequired), actorId);
    if (payload.taskRequired !== undefined) MasterRepository.setGlobalSetting('RULE_TASK_REQUIRED', String(payload.taskRequired), actorId);
    if (payload.descRequired !== undefined) MasterRepository.setGlobalSetting('RULE_DESC_REQUIRED', String(payload.descRequired), actorId);
    if (payload.tagsRequired !== undefined) MasterRepository.setGlobalSetting('RULE_TAGS_REQUIRED', String(payload.tagsRequired), actorId);
    if (payload.allowManual !== undefined) MasterRepository.setGlobalSetting('RULE_ALLOW_MANUAL', String(payload.allowManual), actorId);
    if (payload.timerWarningHours) MasterRepository.setGlobalSetting('TIMER_WARNING_HOURS', String(payload.timerWarningHours), actorId);
    if (payload.autoStopHours) MasterRepository.setGlobalSetting('AUTO_STOP_HOURS', String(payload.autoStopHours), actorId);
    if (payload.pastEntryEditDays) MasterRepository.setGlobalSetting('PAST_ENTRY_EDIT_DAYS', String(payload.pastEntryEditDays), actorId);

    return { ok: true, message: 'Time rules saved successfully.' };
  },

  _step8_ReportingAlerts(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.liveActivity !== undefined) MasterRepository.setGlobalSetting('ALERT_LIVE_ACTIVITY', String(payload.liveActivity), actorId);
    if (payload.missingTime !== undefined) MasterRepository.setGlobalSetting('ALERT_MISSING_TIME', String(payload.missingTime), actorId);
    if (payload.overtime !== undefined) MasterRepository.setGlobalSetting('ALERT_OVERTIME', String(payload.overtime), actorId);
    if (payload.longRunningTimer !== undefined) MasterRepository.setGlobalSetting('ALERT_LONG_TIMERS', String(payload.longRunningTimer), actorId);
    if (payload.weeklyReminder !== undefined) MasterRepository.setGlobalSetting('ALERT_WEEKLY_REMINDER', String(payload.weeklyReminder), actorId);
    if (payload.pendingApprovalReminder !== undefined) MasterRepository.setGlobalSetting('ALERT_PENDING_APPROVAL', String(payload.pendingApprovalReminder), actorId);
    if (payload.dashboardRefreshSeconds) MasterRepository.setGlobalSetting('DASHBOARD_REFRESH_SECONDS', String(payload.dashboardRefreshSeconds), actorId);

    const triggerStatus = JobService.ensureScheduledTriggers();
    return {
      ok: true,
      triggers: triggerStatus,
      message: 'Reporting, alerts, and required scheduled jobs configured successfully.'
    };
  },

  _step9_SystemCheck(authContext) {
    if (!authContext) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for final system verification.', 401);
    }
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const checks = [];
    const workspaces = MasterRepository.listWorkspaces();
    const activeWorkspaces = workspaces.filter(w => w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE);

    // 1. Master schema
    try {
      const ss = MasterRepository.getMasterSpreadsheet();
      const expectedTabs = Object.values(CONSTANTS.MASTER_TABS);
      const missingTabs = expectedTabs.filter(tab => !ss.getSheetByName(tab));
      checks.push({
        id: 'master_db',
        name: 'Master Control Database',
        passed: missingTabs.length === 0,
        detail: missingTabs.length === 0
          ? `All ${expectedTabs.length} required master tabs verified`
          : `Missing tabs: ${missingTabs.join(', ')}`
      });
    } catch (e) {
      checks.push({ id: 'master_db', name: 'Master Control Database', passed: false, detail: e.message });
    }

    // 2. Active workspace schema/isolation
    try {
      const issues = [];
      if (activeWorkspaces.length === 0) issues.push('No active workspace exists');
      for (const ws of activeWorkspaces) {
        try {
          const wss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          const missing = Object.values(CONSTANTS.WORKSPACE_TABS)
            .filter(tab => !wss.getSheetByName(tab));
          if (missing.length > 0) issues.push(`${ws.WorkspaceName}: missing ${missing.join(', ')}`);
        } catch (e) {
          issues.push(`${ws.WorkspaceName}: ${e.message}`);
        }
      }
      checks.push({
        id: 'workspace_db',
        name: 'Workspace Database Isolation',
        passed: issues.length === 0,
        detail: issues.length === 0
          ? `${activeWorkspaces.length} active workspace(s) verified`
          : issues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'workspace_db', name: 'Workspace Database Isolation', passed: false, detail: e.message });
    }

    // 3. Root account + credentials + production cryptographic secret
    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const rootAdmins = accounts.filter(a =>
        a.Role === CONSTANTS.ROLES.SUPER_ADMIN &&
        a.Status === CONSTANTS.ACCOUNT_STATUS.ACTIVE
      );
      let detail = '';
      let passed = rootAdmins.length === 1;
      if (passed) {
        const credentials = MasterRepository.getCredentials(rootAdmins[0].UserID);
        passed = !!(credentials && credentials.PasswordHash);
        SecurityService.getPepper(); // fails closed if Script Property is missing
        detail = passed
          ? `Root Super Admin '${rootAdmins[0].Username}' and cryptographic secret verified`
          : 'Root Super Admin credentials record is missing';
      } else {
        detail = `Expected exactly one active Super Admin; found ${rootAdmins.length}`;
      }
      checks.push({ id: 'auth_security', name: 'Authentication & Cryptographic Configuration', passed, detail });
    } catch (e) {
      checks.push({ id: 'auth_security', name: 'Authentication & Cryptographic Configuration', passed: false, detail: e.message });
    }

    // 4. RBAC/workspace-access invariants
    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const { rows: accessRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
      const accountMap = new Map(accounts.map(a => [a.UserID, a]));
      const workspaceMap = new Map(workspaces.map(w => [w.WorkspaceID, w]));
      const violations = [];

      for (const admin of accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN)) {
        const count = accessRows.filter(r =>
          r.UserID === admin.UserID &&
          (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
        ).length;
        if (count > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
          violations.push(`${admin.Username}: ${count} active workspaces`);
        }
      }

      for (const access of accessRows.filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1)) {
        if (!accountMap.has(access.UserID)) violations.push(`orphan user access ${access.UserID}`);
        const ws = workspaceMap.get(access.WorkspaceID);
        if (!ws) violations.push(`orphan workspace access ${access.WorkspaceID}`);
        else if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          violations.push(`active ACL points to non-active workspace ${access.WorkspaceID}`);
        }
      }

      checks.push({
        id: 'rbac',
        name: 'RBAC & Workspace Access Invariants',
        passed: violations.length === 0,
        detail: violations.length === 0
          ? 'Admin limits and active workspace ACL references verified'
          : violations.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'rbac', name: 'RBAC & Workspace Access Invariants', passed: false, detail: e.message });
    }

    // 5. Timer invariants: valid owner/workspace and globally one active timer per user
    try {
      const seenUsers = new Set();
      const timerIssues = [];
      for (const ws of activeWorkspaces) {
        const timers = SheetRepository.listActiveTimers(ws.WorkspaceID);
        const allowedUsers = new Set(
          MasterRepository.getWorkspaceAccessForWorkspace(ws.WorkspaceID).map(a => a.UserID)
        );
        for (const timer of timers) {
          if (!allowedUsers.has(timer.UserID)) {
            timerIssues.push(`${timer.TimerID}: user lacks workspace access`);
          }
          if (seenUsers.has(timer.UserID)) {
            timerIssues.push(`${timer.UserID}: more than one active timer globally`);
          }
          seenUsers.add(timer.UserID);
          if (isNaN(new Date(timer.StartedAtUTC).getTime())) {
            timerIssues.push(`${timer.TimerID}: invalid StartedAtUTC`);
          }
        }
      }
      checks.push({
        id: 'timer_engine',
        name: 'Timer Engine Invariants',
        passed: timerIssues.length === 0,
        detail: timerIssues.length === 0
          ? `${seenUsers.size} active timer owner(s) verified`
          : timerIssues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'timer_engine', name: 'Timer Engine Invariants', passed: false, detail: e.message });
    }

    // 6. Raw-entry totals must reconcile to all aggregate time rollups.
    try {
      const rollupIssues = [];
      for (const ws of activeWorkspaces) {
        const rawEntries = SheetRepository.listTimeEntries(ws.WorkspaceID, {});
        const rawSeconds = rawEntries.reduce((sum, e) => sum + (parseInt(e.DurationSeconds, 10) || 0), 0);

        for (const tab of [
          CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
        ]) {
          const { rows } = SheetRepository.getTableData(ws.WorkspaceID, tab);
          const rollupSeconds = rows.reduce((sum, r) => sum + (parseInt(r.TotalSeconds, 10) || 0), 0);
          if (rollupSeconds !== rawSeconds) {
            rollupIssues.push(
              `${ws.WorkspaceName}/${tab}: raw=${rawSeconds}s rollup=${rollupSeconds}s`
            );
          }
        }
      }
      checks.push({
        id: 'reporting',
        name: 'Reporting Rollup Reconciliation',
        passed: rollupIssues.length === 0,
        detail: rollupIssues.length === 0
          ? 'Daily, weekly, and monthly totals reconcile to raw entries'
          : rollupIssues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'reporting', name: 'Reporting Rollup Reconciliation', passed: false, detail: e.message });
    }

    // 7. Cryptographic audit chain
    try {
      const masterAudit = AuditService.verifyAuditChain();
      checks.push({
        id: 'audit_log',
        name: 'Master Audit Chain Integrity',
        passed: !!(masterAudit && masterAudit.ok && masterAudit.verified),
        detail: masterAudit && masterAudit.message ? masterAudit.message : 'Audit verification returned no result'
      });
    } catch (e) {
      checks.push({ id: 'audit_log', name: 'Master Audit Chain Integrity', passed: false, detail: e.message });
    }

    // 8. Perform/confirm a real verified initial Master backup.
    try {
      const { rows: backupRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
      let masterBackup = backupRows.find(row =>
        row.Scope === 'MASTER' &&
        row.Status === 'AVAILABLE' &&
        (row.Verified === true || row.Verified === 'TRUE' || row.Verified === 1)
      );
      let createdBackupId = '';
      if (!masterBackup) {
        const backup = BackupService.createBackup(authContext);
        createdBackupId = backup.backupId;
        masterBackup = { BackupID: backup.backupId };
      }
      checks.push({
        id: 'backup_folder',
        name: 'Verified Backup Subsystem',
        passed: !!masterBackup,
        detail: createdBackupId
          ? `Initial verified Master backup created: ${createdBackupId}`
          : `Verified Master backup registered: ${masterBackup.BackupID}`
      });
    } catch (e) {
      checks.push({ id: 'backup_folder', name: 'Verified Backup Subsystem', passed: false, detail: e.message });
    }

    // 9. Required Apps Script scheduled triggers
    try {
      const triggerStatus = JobService.getScheduledTriggerStatus();
      checks.push({
        id: 'scheduled_jobs',
        name: 'Scheduled Background Jobs',
        passed: triggerStatus.healthy === true,
        detail: triggerStatus.detail
      });
    } catch (e) {
      checks.push({ id: 'scheduled_jobs', name: 'Scheduled Background Jobs', passed: false, detail: e.message });
    }

    // 10. Verify the runtime capability used by doGet for Google Sites embedding.
    try {
      const embedRuntimeAvailable =
        typeof HtmlService !== 'undefined' &&
        HtmlService.XFrameOptionsMode &&
        HtmlService.XFrameOptionsMode.ALLOWALL !== undefined;
      checks.push({
        id: 'sites_embed',
        name: 'HTML Embed Runtime',
        passed: embedRuntimeAvailable,
        detail: embedRuntimeAvailable
          ? 'HtmlService ALLOWALL embed runtime is available'
          : 'HtmlService ALLOWALL embed runtime is unavailable'
      });
    } catch (e) {
      checks.push({ id: 'sites_embed', name: 'HTML Embed Runtime', passed: false, detail: e.message });
    }

    const allPassed = checks.every(check => check.passed);
    if (allPassed) {
      MasterRepository.setGlobalSetting(
        'SETUP_COMPLETE',
        'true',
        authContext.userId,
        'Setup wizard completion flag'
      );
    }

    return {
      allPassed,
      checks,
      timestampUTC: new Date().toISOString(),
      statusText: allPassed ? 'SYSTEM READY' : 'SYSTEM CHECK WARNINGS'
    };
  },

  /**
   * Automated Self-Healing Engine:
   * Recreates missing tabs, fixes header rows, and resyncs out-of-date rollups
   */
  repairSystem(authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const repairedTabs = [];
    const rollupsRebuilt = [];

    // 1. Check and repair Master Control Sheet tabs
    const masterSs = MasterRepository.getMasterSpreadsheet();
    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = masterSs.getSheetByName(tabName);
      if (!sheet) {
        sheet = masterSs.insertSheet(tabName);
        sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
        sheet.setFrozenRows(1);
        repairedTabs.push(`Master Tab: ${tabName}`);
      } else {
        // Verify header row
        const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
        if (currentHeaders.length < columns.length || !columns.every((c, i) => currentHeaders[i] === c)) {
          sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
          sheet.setFrozenRows(1);
          repairedTabs.push(`Master Header: ${tabName}`);
        }
      }
    }

    // 2. Check and repair all active Workspaces
    const workspaces = MasterRepository.listWorkspaces();
    for (const ws of workspaces) {
      if (ws.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED) continue;
      try {
        const wss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
        for (const [tabName, columns] of Object.entries(WORKSPACE_SCHEMA)) {
          let sheet = wss.getSheetByName(tabName);
          if (!sheet) {
            sheet = wss.insertSheet(tabName);
            sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
            sheet.setFrozenRows(1);
            repairedTabs.push(`Workspace ${ws.WorkspaceName} Tab: ${tabName}`);
          }
        }

        // Rebuild rollups to ensure 100% cache sync
        RollupService.rebuildRollups(ws.WorkspaceID);
        rollupsRebuilt.push(ws.WorkspaceName);
      } catch (wsErr) {
        console.error(`Error repairing workspace ${ws.WorkspaceID}: ` + wsErr.message);
      }
    }

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext ? authContext.userId : 'SYSTEM',
      ActorRole: authContext ? authContext.role : 'SUPER_ADMIN',
      WorkspaceID: 'MASTER',
      EntityType: 'SYSTEM',
      EntityID: 'SELF_HEAL',
      Action: 'SYSTEM_REPAIRED',
      Reason: `Self-healing repaired ${repairedTabs.length} tabs and rebuilt rollups for ${rollupsRebuilt.length} workspaces.`
    });

    return {
      ok: true,
      repairedTabs,
      rollupsRebuilt,
      message: `Self-healing completed: ${repairedTabs.length} schema corrections applied, rollups synchronized across ${rollupsRebuilt.length} workspaces.`
    };
  },

  /**
   * Advanced Diagnostics for Super Admin
   */
  getAdvancedDiagnostics(authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const masterSs = MasterRepository.getMasterSpreadsheet();
    const workspaces = MasterRepository.listWorkspaces();

    const wsDetails = workspaces.map(w => {
      let sheetOk = false;
      let totalMembers = 0;
      let totalEntries = 0;
      try {
        const wss = WorkspaceRouter.resolveSpreadsheet(w.WorkspaceID);
        sheetOk = !!wss;
        const memSheet = wss.getSheetByName(CONSTANTS.WORKSPACE_TABS.MEMBERS);
        if (memSheet) totalMembers = Math.max(0, memSheet.getLastRow() - 1);
        const entriesSheet = wss.getSheetByName(CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
        if (entriesSheet) totalEntries = Math.max(0, entriesSheet.getLastRow() - 1);
      } catch (e) {}

      return {
        workspaceId: w.WorkspaceID,
        name: w.WorkspaceName,
        spreadsheetId: w.SpreadsheetID,
        status: w.Status,
        timezone: w.Timezone,
        sheetConnected: sheetOk,
        memberCount: totalMembers,
        timeEntryCount: totalEntries
      };
    });

    const activeSessions = MasterRepository.listActiveSessions();
    const triggerStatus = JobService.getScheduledTriggerStatus();

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSpreadsheetId: masterSs.getId ? masterSs.getId() : 'mock_master',
      masterSpreadsheetUrl: masterSs.getUrl ? masterSs.getUrl() : '',
      workspaces: wsDetails,
      activeSessionsCount: activeSessions.length,
      triggersHealthy: triggerStatus.healthy === true,
      triggerStatus,
      timestampUTC: new Date().toISOString()
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SetupService
  };
}

/**
 * FLINK Time & Workforce Platform — Workspace Service
 * Manages workspace provisioning, automatic 18-tab schema generation,
 * and Admin assignments under the strict <= 3 workspace limit.
 */

const WorkspaceService = {
  /**
   * Super Admin creates and provisions a new isolated workspace
   */
  createWorkspace(superAdminContext, workspacePayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(workspacePayload, ['name']);

    const workspaceName = workspacePayload.name.trim();
    const timezone = workspacePayload.timezone || 'UTC';
    const workspaceId = Validation.generateId('WSP');

    let spreadsheetId = '';
    let driveFolderId = '';

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.create) {
      const newSpreadsheet = SpreadsheetApp.create(`FLINK Workspace — ${workspaceName}`);
      spreadsheetId = newSpreadsheet.getId();

      // Provision all 18 tabs
      const existingSheets = newSpreadsheet.getSheets();
      const defaultSheet = existingSheets[0];

      for (const [tabName, columns] of Object.entries(WORKSPACE_SCHEMA)) {
        let sheet = newSpreadsheet.getSheetByName(tabName);
        if (!sheet) {
          sheet = newSpreadsheet.insertSheet(tabName);
        }
        // Set header row
        sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
        sheet.setFrozenRows(1);
      }

      // Remove original default 'Sheet1' if it is not in schema
      if (defaultSheet && !WORKSPACE_SCHEMA[defaultSheet.getName()]) {
        try {
          newSpreadsheet.deleteSheet(defaultSheet);
        } catch (e) {
          // Ignore if cannot delete
        }
      }

      // Populate WorkspaceInfo row
      const infoSheet = newSpreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO);
      if (infoSheet) {
        infoSheet.appendRow([
          workspaceId,
          Validation.sanitizeCellValue(workspaceName),
          CONSTANTS.WORKSPACE_STATUS.ACTIVE,
          timezone,
          CONSTANTS.SCHEMA_VERSION,
          new Date().toISOString()
        ]);
      }
    } else {
      // Mock environment fallback ID
      spreadsheetId = `mock_sheet_${workspaceId.toLowerCase()}`;
    }

    const record = {
      WorkspaceID: workspaceId,
      WorkspaceName: workspaceName,
      SpreadsheetID: spreadsheetId,
      DriveFolderID: driveFolderId,
      Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
      Timezone: timezone,
      CreatedAt: new Date().toISOString(),
      CreatedBy: superAdminContext.userId,
      ArchivedAt: ''
    };

    MasterRepository.createWorkspace(record);

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'WORKSPACE',
      EntityID: workspaceId,
      Action: CONSTANTS.AUDIT_EVENTS.WORKSPACE_CREATED,
      AfterJSON: record,
      Reason: 'Provisioned new workspace'
    });

    return record;
  },

  /**
   * Super Admin assigns an Admin to a workspace (enforcing max 3 workspaces limit)
   */
  assignAdminToWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const adminAccount = MasterRepository.findAccountById(adminUserId);
      if (!adminAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `Admin user ${adminUserId} not found.`);
      if (adminAccount.Role !== CONSTANTS.ROLES.ADMIN) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `User ${adminAccount.Username} is not an Admin.`);
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);

      // Hard Limit Check: Max 3 active workspaces
      AuthorizationService.assertAdminWorkspaceLimit(adminUserId, workspaceId);

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: adminUserId,
        WorkspaceID: workspaceId,
        Role: CONSTANTS.ROLES.ADMIN,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      // Register in workspace Members table if not present
      const member = SheetRepository.getMember(workspaceId, adminUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: adminUserId,
          DisplayName: adminAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Management',
          Team: 'Admins',
          JobTitle: 'Workspace Administrator',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'Admin workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Assigns a regular User to a workspace
   */
  assignUserToWorkspace(superAdminContext, targetUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const userAccount = MasterRepository.findAccountById(targetUserId);
      if (!userAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
      if (userAccount.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, `User ${userAccount.Username} is not active (${userAccount.Status}).`, 400);
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Workspace ${ws.WorkspaceName} is not active (${ws.Status}).`, 400);
      }

      // Check duplicate assignment
      const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      const alreadyAssigned = existingAccesses.find(a => a.WorkspaceID === workspaceId && (a.Active === true || a.Active === 'TRUE'));
      if (alreadyAssigned) {
        return { ok: true, access: alreadyAssigned, message: 'User is already assigned to this workspace.' };
      }

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: targetUserId,
        WorkspaceID: workspaceId,
        Role: userAccount.Role,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      const member = SheetRepository.getMember(workspaceId, targetUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: targetUserId,
          DisplayName: userAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Operations',
          Team: 'General',
          JobTitle: 'Team Member',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'USER_ACCESS',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'User workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin removes an Admin's access to a workspace
   */
  removeAdminFromWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      MasterRepository.removeWorkspaceAccess(adminUserId, workspaceId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_REMOVED,
        Reason: 'Admin workspace access revoked'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Admin access removed for workspace ${workspaceId}.` };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Lists workspaces accessible to authenticated user
   */
  listWorkspaces(authContext) {
    const allWorkspaces = MasterRepository.listWorkspaces().filter(w => w.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return allWorkspaces;
    }

    const accesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
    const allowedIds = new Set(accesses.map(a => a.WorkspaceID));
    if (authContext.user && authContext.user.PrimaryWorkspaceID) {
      allowedIds.add(authContext.user.PrimaryWorkspaceID);
    }

    return allWorkspaces.filter(w => allowedIds.has(w.WorkspaceID));
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    WorkspaceService
  };
}

/**
 * FLINK Time & Workforce Platform — User Service
 * Dedicated to Super Admin global user management, status transitions,
 * password generation, and cross-workspace membership registration.
 */

const UserService = {
  /**
   * Super Admin creates a new user account with initial salted credentials
   */
  createUser(superAdminContext, userPayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(userPayload, ['username', 'displayName', 'role']);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const username = Validation.validateUsername(userPayload.username);
      const role = Validation.validateRole(userPayload.role);
      const displayName = Validation.sanitizeCellValue(userPayload.displayName.trim());
      const email = userPayload.email ? Validation.sanitizeCellValue(userPayload.email.trim()) : '';
      const primaryWorkspaceId = userPayload.primaryWorkspaceId || '';

      // Verify username uniqueness inside lock
      const existing = MasterRepository.findAccountByUsername(username);
      if (existing) {
        throw new AppError(ERROR_CODES.CONFLICT, `Username '${username}' is already taken.`);
      }

      const userId = Validation.generateId('USR');
      const temporaryPassword = userPayload.password || ('Flk-' + SecurityService.generateRandomHex(4) + '!9');
      Validation.validatePassword(temporaryPassword);

      const passwordHash = SecurityService.hashPassword(temporaryPassword);
      const now = new Date().toISOString();

      const accountRecord = {
        UserID: userId,
        Username: username,
        DisplayName: displayName,
        Role: role,
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        PrimaryWorkspaceID: primaryWorkspaceId,
        Email: email,
        CreatedAt: now,
        CreatedBy: superAdminContext.userId,
        UpdatedAt: now,
        UpdatedBy: superAdminContext.userId,
        LastLoginAt: '',
        MustChangePassword: true
      };

      const credentialRecord = {
        UserID: userId,
        PasswordHash: passwordHash,
        PasswordVersion: 1,
        PasswordChangedAt: now,
        FailedLoginCount: 0,
        LockUntil: ''
      };

      MasterRepository.createAccount(accountRecord, credentialRecord);

      // If primary workspace is provided, assign access and register as member
      if (primaryWorkspaceId) {
        MasterRepository.assignWorkspaceAccess({
          AccessID: Validation.generateId('ACC'),
          UserID: userId,
          WorkspaceID: primaryWorkspaceId,
          Role: role,
          Active: true,
          AssignedAt: now,
          AssignedBy: superAdminContext.userId
        });

        try {
          SheetRepository.addMember(primaryWorkspaceId, {
            UserID: userId,
            DisplayName: displayName,
            Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            JoinedAt: now,
            LeftAt: '',
            Department: userPayload.department || 'Operations',
            Team: userPayload.team || 'General',
            JobTitle: userPayload.jobTitle || 'Team Member',
            EmployeeCode: userPayload.employeeCode || ''
          });
        } catch (e) {
          console.warn(`Could not add member to workspace ${primaryWorkspaceId}: ` + e.message);
        }
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: primaryWorkspaceId,
        EntityType: 'USER',
        EntityID: userId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_CREATED,
        AfterJSON: accountRecord,
        Reason: 'User created by Super Admin'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        userId,
        username,
        displayName,
        role,
        status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        primaryWorkspaceId,
        temporaryPassword
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin updates account details
   */
  updateUser(superAdminContext, targetUserId, updates) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const existing = MasterRepository.findAccountById(targetUserId);
      if (!existing) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

      const allowedUpdates = {};
      if (updates.displayName) allowedUpdates.DisplayName = Validation.sanitizeCellValue(updates.displayName.trim());
      if (updates.email !== undefined) allowedUpdates.Email = Validation.sanitizeCellValue(updates.email.trim());
      if (updates.role) allowedUpdates.Role = Validation.validateRole(updates.role);
      if (updates.primaryWorkspaceId) allowedUpdates.PrimaryWorkspaceID = updates.primaryWorkspaceId;

      allowedUpdates.UpdatedAt = new Date().toISOString();
      allowedUpdates.UpdatedBy = superAdminContext.userId;

      const updated = MasterRepository.updateAccount(targetUserId, allowedUpdates);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: 'USER_UPDATED',
        BeforeJSON: existing,
        AfterJSON: updated,
        Reason: 'User details updated'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return updated;
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin deactivates an account to PASSIVE status.
   * Immediately revokes all sessions and cleanly terminates running timers.
   */
  makeUserPassive(superAdminContext, targetUserId, reason = 'Deactivated by Super Admin') {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const account = MasterRepository.findAccountById(targetUserId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

      MasterRepository.updateAccount(targetUserId, {
        Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Invalidate all sessions immediately
      SessionService.revokeAllUserSessions(targetUserId);

      // Update status in assigned workspaces & cleanly close active timer
      const accesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      for (const acc of accesses) {
        try {
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
            LeftAt: new Date().toISOString()
          });

          // Clean up any active timer
          const timer = SheetRepository.getActiveTimer(acc.WorkspaceID, targetUserId);
          if (timer) {
            SheetRepository.deleteActiveTimer(acc.WorkspaceID, targetUserId);
          }
        } catch (e) {
          // Workspace sheet might be archived
        }
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_PASSIVE,
        Reason: reason
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, userId: targetUserId, status: CONSTANTS.ACCOUNT_STATUS.PASSIVE };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin reactivates a PASSIVE or LOCKED account
   */
  activateUser(superAdminContext, targetUserId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const account = MasterRepository.findAccountById(targetUserId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

      MasterRepository.updateAccount(targetUserId, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      MasterRepository.updateCredentials(targetUserId, {
        FailedLoginCount: 0,
        LockUntil: ''
      });

      const accesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      for (const acc of accesses) {
        try {
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE
          });
        } catch (e) {}
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_ACTIVATED,
        Reason: 'Account reactivated'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, userId: targetUserId, status: CONSTANTS.ACCOUNT_STATUS.ACTIVE };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Lists users based on requester's role
   */
  listUsers(authContext, workspaceId = null) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      if (workspaceId) {
        const accesses = MasterRepository.getWorkspaceAccessForWorkspace(workspaceId);
        const userIds = new Set(accesses.map(a => a.UserID));
        return rows.filter(u => userIds.has(u.UserID) || u.PrimaryWorkspaceID === workspaceId);
      }
      return rows;
    }

    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      const adminAccesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
      const adminWorkspaceIds = adminAccesses.map(a => a.WorkspaceID);
      const targetWorkspace = workspaceId || adminWorkspaceIds[0];

      if (!adminWorkspaceIds.includes(targetWorkspace)) {
        throw new AppError(ERROR_CODES.WORKSPACE_DENIED, 'Access denied to requested workspace users.', 403);
      }

      const teamAccesses = MasterRepository.getWorkspaceAccessForWorkspace(targetWorkspace);
      const teamUserIds = new Set(teamAccesses.map(a => a.UserID));
      return rows.filter(u => teamUserIds.has(u.UserID) || u.PrimaryWorkspaceID === targetWorkspace);
    }

    // Regular users can only see their own profile
    return rows.filter(u => u.UserID === authContext.userId);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UserService
  };
}

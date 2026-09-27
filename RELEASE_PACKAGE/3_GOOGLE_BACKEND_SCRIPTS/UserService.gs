/**
 * FLINK Time & Workforce Platform — User Service
 * Dedicated to Super Admin global user management, status transitions,
 * password generation, and cross-workspace membership registration.
 */

const UserService = {
  _toUserDTO(user, assignedWorkspaceIds = [], detailLevel = 'SELF') {
    if (!user) return null;

    const dto = {
      UserID: user.UserID,
      Username: user.Username,
      DisplayName: user.DisplayName,
      Role: user.Role,
      Status: user.Status,
      PrimaryWorkspaceID: user.PrimaryWorkspaceID || '',
      Email: user.Email || '',
      EmployeeCode: user.EmployeeCode || '',
      AssignedWorkspaceIDs: Array.isArray(assignedWorkspaceIds)
        ? assignedWorkspaceIds
        : []
    };

    if (detailLevel === 'SUPER_ADMIN') {
      dto.CreatedAt = user.CreatedAt || '';
      dto.CreatedBy = user.CreatedBy || '';
      dto.UpdatedAt = user.UpdatedAt || '';
      dto.UpdatedBy = user.UpdatedBy || '';
      dto.LastLoginAt = user.LastLoginAt || '';
      dto.MustChangePassword =
        user.MustChangePassword === true || user.MustChangePassword === 'TRUE';
      dto.Version = parseInt(user.Version, 10) || 1;
    }

    return dto;
  },

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
      if (role === CONSTANTS.ROLES.SUPER_ADMIN) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'SUPER_ADMIN accounts cannot be created through generic user CRUD.',
          403
        );
      }
      const displayName = Validation.sanitizeCellValue(userPayload.displayName.trim());
      const email = userPayload.email ? Validation.sanitizeCellValue(userPayload.email.trim()) : '';
      const primaryWorkspaceId = userPayload.primaryWorkspaceId || '';

      // Verify username uniqueness inside lock
      const existing = MasterRepository.findAccountByUsername(username);
      if (existing) {
        throw new AppError(ERROR_CODES.CONFLICT, `Username '${username}' is already taken.`);
      }

      const userId = Validation.generateId('USR');
      const temporaryPassword = userPayload.temporaryPassword || userPayload.password || ('Flk-' + SecurityService.generateRandomHex(8) + '!9');
      Validation.validatePassword(temporaryPassword);

      if (primaryWorkspaceId) {
        const primaryWorkspace = MasterRepository.getWorkspace(primaryWorkspaceId);
        if (!primaryWorkspace) {
          throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${primaryWorkspaceId}' does not exist.`, 404);
        }
        if (primaryWorkspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          throw new AppError(
            ERROR_CODES.WORKSPACE_DENIED,
            `Workspace '${primaryWorkspaceId}' is not active (${primaryWorkspace.Status}).`,
            403
          );
        }
      }

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

      if (updates.role) {
        const requestedRole = Validation.validateRole(updates.role);
        if (requestedRole !== existing.Role) {
          if (requestedRole === CONSTANTS.ROLES.SUPER_ADMIN) {
            throw new AppError(
              ERROR_CODES.PERMISSION_DENIED,
              'Promotion to SUPER_ADMIN is not allowed through the generic user-update endpoint.',
              403
            );
          }

          const activeAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
          if (
            requestedRole === CONSTANTS.ROLES.ADMIN &&
            activeAccesses.length > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES
          ) {
            throw new AppError(
              ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
              `Cannot promote this user to Admin while assigned to ${activeAccesses.length} workspaces. Maximum is ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES}.`,
              400
            );
          }

          allowedUpdates.Role = requestedRole;
          MasterRepository.syncWorkspaceAccessRole(targetUserId, requestedRole);
        }
      }

      if (updates.primaryWorkspaceId !== undefined) {
        const requestedPrimary = updates.primaryWorkspaceId || '';
        if (requestedPrimary) {
          const activeAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
          const hasAccess = activeAccesses.some(a => a.WorkspaceID === requestedPrimary);
          if (!hasAccess) {
            throw new AppError(
              ERROR_CODES.WORKSPACE_DENIED,
              'Primary workspace can only be set to a workspace the user is actively assigned to.',
              403
            );
          }
        }
        allowedUpdates.PrimaryWorkspaceID = requestedPrimary;
      }

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

      // Revoke sessions first. Any concurrent timer start is blocked by this same ScriptLock.
      SessionService.revokeAllUserSessions(targetUserId);

      const ownerContext = {
        userId: targetUserId,
        role: account.Role,
        user: account
      };

      const accesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      const finalizedTimers = [];

      for (const acc of accesses) {
        const ws = MasterRepository.getWorkspace(acc.WorkspaceID);
        if (!ws || ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          continue;
        }

        // Preserve already-worked time instead of deleting an active timer.
        const timer = SheetRepository.getActiveTimer(acc.WorkspaceID, targetUserId);
        if (timer) {
          const entry = TimerService._finalizeActiveTimerLocked(
            ownerContext,
            acc.WorkspaceID,
            timer,
            { reason: 'Timer finalized automatically during account deactivation' },
            superAdminContext
          );
          finalizedTimers.push({
            workspaceId: acc.WorkspaceID,
            timerId: timer.TimerID,
            entryId: entry.EntryID,
            durationSeconds: entry.DurationSeconds
          });
        }

        try {
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
            LeftAt: new Date().toISOString()
          });
        } catch (memberErr) {
          console.warn(
            `Could not update workspace member status for ${targetUserId} in ${acc.WorkspaceID}: ${memberErr.message}`
          );
        }
      }

      // Only mark the account passive after active time has been safely finalized.
      MasterRepository.updateAccount(targetUserId, {
        Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_PASSIVE,
        AfterJSON: { finalizedTimers },
        Reason: reason
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        userId: targetUserId,
        status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
        finalizedTimers
      };
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
            Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            LeftAt: ''
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
    const { rows: allAccessRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    const activeAccessRows = allAccessRows.filter(a =>
      a.Active === true || a.Active === 'TRUE' || a.Active === 1
    );

    const assignedIdsFor = userId => activeAccessRows
      .filter(a => a.UserID === userId)
      .map(a => a.WorkspaceID);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      let visibleRows = rows;
      if (workspaceId) {
        const userIds = new Set(
          activeAccessRows
            .filter(a => a.WorkspaceID === workspaceId)
            .map(a => a.UserID)
        );
        visibleRows = rows.filter(u => userIds.has(u.UserID));
      }

      return visibleRows.map(user =>
        this._toUserDTO(user, assignedIdsFor(user.UserID), 'SUPER_ADMIN')
      );
    }

    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      const adminWorkspaceIds = MasterRepository
        .getWorkspaceAccessForUser(authContext.userId)
        .map(a => a.WorkspaceID);
      const targetWorkspace = workspaceId || adminWorkspaceIds[0];

      if (!targetWorkspace || !adminWorkspaceIds.includes(targetWorkspace)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Access denied to requested workspace users.',
          403
        );
      }

      const teamUserIds = new Set(
        activeAccessRows
          .filter(a => a.WorkspaceID === targetWorkspace)
          .map(a => a.UserID)
      );

      return rows
        .filter(u => teamUserIds.has(u.UserID))
        .map(user => this._toUserDTO(user, assignedIdsFor(user.UserID), 'ADMIN'));
    }

    const self = rows.find(u => u.UserID === authContext.userId);
    return self
      ? [this._toUserDTO(self, assignedIdsFor(self.UserID), 'SELF')]
      : [];
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    UserService
  };
}

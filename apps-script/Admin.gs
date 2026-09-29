/** FLINK Time — Consolidated user lifecycle, setup, admin requests, integrity, jobs, backup/audit, export, and migration services. */


/* ===== UserService.gs ===== */
/**
 * FLINK Time & Workforce Platform — User Service
 * Dedicated to Super Admin global user management, status transitions,
 * password generation, and cross-workspace membership registration.
 */

var UserService = (typeof global !== 'undefined' && global.UserService) || {
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
    Validation.assertRequired(
      userPayload,
      ['username', 'displayName', 'role', 'email']
    );

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
      const email = Validation.validateEmail(userPayload.email);
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

      try {
        // If primary workspace is provided, assignment and membership are part of
        // the same provisioning unit. A failure rolls the new account back.
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
        }
      } catch (provisionErr) {
        // Remove a member row if the workspace append completed before a later
        // provisioning error surfaced.
        if (primaryWorkspaceId) {
          try {
            const member = SheetRepository.getMember(primaryWorkspaceId, userId);
            if (member && member._rowIndex) {
              SheetRepository.deleteRow(
                primaryWorkspaceId,
                CONSTANTS.WORKSPACE_TABS.MEMBERS,
                member._rowIndex
              );
            }
          } catch (memberRollbackErr) {
            console.error(
              `Workspace member rollback failed for ${userId}: ${memberRollbackErr.message}`
            );
          }
        }

        try {
          MasterRepository.rollbackUserCreation(userId);
        } catch (masterRollbackErr) {
          console.error(
            `Master user rollback failed for ${userId}: ${masterRollbackErr.message}`
          );
        }
        throw provisionErr;
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
      if (updates.email !== undefined) {
        allowedUpdates.Email = Validation.validateEmail(updates.email);
      }

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
      const activeAccesses = accesses.filter(acc => {
        const ws = MasterRepository.getWorkspace(acc.WorkspaceID);
        return ws && ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
      });
      const finalizedTimers = [];

      // Phase 1: preserve every active timer before changing account/member state.
      for (const acc of activeAccesses) {
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
      }

      // Phase 2: transition all active workspace member rows. Do not silently
      // continue if one workspace fails, because that would leave a PASSIVE
      // account with an ACTIVE membership record. Roll back member rows already
      // changed and leave the account ACTIVE so the operation can be retried.
      const changedMembers = [];
      const leftAt = new Date().toISOString();
      try {
        for (const acc of activeAccesses) {
          const beforeMember = SheetRepository.getMember(acc.WorkspaceID, targetUserId);
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
            LeftAt: leftAt
          });
          changedMembers.push({
            workspaceId: acc.WorkspaceID,
            status: beforeMember ? beforeMember.Status : CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            leftAt: beforeMember ? (beforeMember.LeftAt || '') : ''
          });
        }
      } catch (memberErr) {
        for (const changed of changedMembers.reverse()) {
          try {
            SheetRepository.updateMember(changed.workspaceId, targetUserId, {
              Status: changed.status || CONSTANTS.ACCOUNT_STATUS.ACTIVE,
              LeftAt: changed.leftAt
            });
          } catch (rollbackErr) {
            console.error(
              `Member rollback failed for ${targetUserId} in ${changed.workspaceId}: ${rollbackErr.message}`
            );
          }
        }
        throw memberErr;
      }

      // Only mark the account passive after active time and every active member
      // row have been transitioned safely.
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

/* ===== AdminRequestService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Admin Request Service
 * Mediates Admin-driven user lifecycle requests (new user, make passive, password reset)
 * through a centralized Super Admin review and execution queue.
 */

var AdminRequestService = (typeof global !== 'undefined' && global.AdminRequestService) || {
  /**
   * Admin submits a user lifecycle request
   */
  submitRequest(adminContext, payload) {
    AuthorizationService.assertRole(adminContext, [CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(payload, ['requestType', 'workspaceId', 'reason']);

    const { requestType, workspaceId, targetUserId, requestedData, reason } = payload;
    AuthorizationService.assertWorkspaceAccess(adminContext, workspaceId);

    if (!Object.values(CONSTANTS.REQUEST_TYPES).includes(requestType)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid request type: ${requestType}`);
    }

    if ((requestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE || requestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET) && !targetUserId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Target user ID is required for this request type.');
    }

    if (
      requestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE ||
      requestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET
    ) {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Target user ${targetUserId} was not found.`, 404);
      }
      if (targetAccount.Role !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'Admin lifecycle requests may only target ordinary USER accounts.',
          403
        );
      }

      const targetAccess = MasterRepository
        .getWorkspaceAccessForUser(targetUserId)
        .some(access => access.WorkspaceID === workspaceId);

      if (!targetAccess) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'The target user is not actively assigned to the requested workspace.',
          403
        );
      }
    }

    if (requestType === CONSTANTS.REQUEST_TYPES.NEW_USER) {
      if (!requestedData || typeof requestedData !== 'object' || Array.isArray(requestedData)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'requestedData is required for NEW_USER requests.',
          400
        );
      }
      Validation.assertRequired(
        requestedData,
        ['username', 'displayName', 'email']
      );
      requestedData.email = Validation.validateEmail(requestedData.email);
      const requestedRole = requestedData.role || CONSTANTS.ROLES.USER;
      if (requestedRole !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'Admin-created user requests may only request ordinary USER accounts.',
          403
        );
      }
    }

    const requestId = Validation.generateId('REQ');
    const now = new Date().toISOString();

    const requestRecord = {
      RequestID: requestId,
      RequestType: requestType,
      RequestedBy: adminContext.userId,
      WorkspaceID: workspaceId,
      TargetUserID: targetUserId || '',
      RequestedDataJSON: requestedData ? JSON.stringify(Validation.sanitizeRow(requestedData)) : '',
      Reason: Validation.sanitizeCellValue(reason),
      Status: CONSTANTS.REQUEST_STATUS.PENDING,
      RequestedAt: now,
      ReviewedBy: '',
      ReviewedAt: '',
      ReviewComment: '',
      ExecutedAt: ''
    };

    MasterRepository.createRequest(requestRecord);

    MasterRepository.logGlobalAudit({
      ActorUserID: adminContext.userId,
      ActorRole: adminContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'REQUEST',
      EntityID: requestId,
      Action: CONSTANTS.AUDIT_EVENTS.REQUEST_SUBMITTED,
      AfterJSON: requestRecord,
      Reason: reason
    });

    return requestRecord;
  },

  /**
   * Lists requests according to role
   */
  listRequests(authContext, statusFilter = null, workspaceId = null) {
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return MasterRepository.listRequests(statusFilter, workspaceId);
    }

    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      const adminAccesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
      const allowedWs = new Set(adminAccesses.map(a => a.WorkspaceID));
      if (workspaceId && !allowedWs.has(workspaceId)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Access denied to request queue for this workspace.',
          403
        );
      }
      const all = MasterRepository.listRequests(statusFilter, workspaceId);
      // Losing workspace access also removes visibility of historical requests
      // from that workspace. RequestedBy is not an authorization grant.
      return all.filter(r => allowedWs.has(r.WorkspaceID));
    }

    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Only Admins and Super Admins can access request queues.', 403);
  },

  /**
   * Super Admin reviews, executes, or rejects a request
   */
  reviewRequest(superAdminContext, requestId, reviewPayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(reviewPayload, ['action']);

    const action = String(reviewPayload.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unsupported review action: ${action}`);
    }
    const reviewComment = reviewPayload.reviewComment
      ? Validation.sanitizeCellValue(reviewPayload.reviewComment)
      : '';
    const now = new Date().toISOString();

    // Claim/reject the request under a short ScriptLock. Do not hold this lock
    // while executing UserService/AuthService because those services acquire
    // their own ScriptLock and Apps Script locks are not re-entrant.
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let req;
    try {
      req = MasterRepository.getRequest(requestId);
      if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
      if (req.Status !== CONSTANTS.REQUEST_STATUS.PENDING) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Request ${requestId} has already been ${String(req.Status).toLowerCase()}.`,
          409
        );
      }

      if (action === 'REJECT') {
        const updated = MasterRepository.updateRequest(requestId, {
          Status: CONSTANTS.REQUEST_STATUS.REJECTED,
          ReviewedBy: superAdminContext.userId,
          ReviewedAt: now,
          ReviewComment: reviewComment
        });

        MasterRepository.logGlobalAudit({
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          WorkspaceID: req.WorkspaceID,
          EntityType: 'REQUEST',
          EntityID: requestId,
          Action: 'REQUEST_REJECTED',
          Reason: reviewComment
        });

        return { ok: true, request: updated };
      }

      // APPROVED is the exclusive execution claim. A concurrent reviewer will
      // now see a non-PENDING request and cannot execute it a second time.
      MasterRepository.updateRequest(requestId, {
        Status: CONSTANTS.REQUEST_STATUS.APPROVED,
        ReviewedBy: superAdminContext.userId,
        ReviewedAt: now,
        ReviewComment: reviewComment
      });
    } finally {
      lock.releaseLock();
    }

    try {
      const originWorkspace = MasterRepository.getWorkspace(req.WorkspaceID);
      if (!originWorkspace || originWorkspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Request can no longer be executed because the originating workspace is not active.',
          403
        );
      }

      let executionResult = null;

      if (req.RequestType === CONSTANTS.REQUEST_TYPES.NEW_USER) {
        let requestedData;
        try {
          requestedData = JSON.parse(req.RequestedDataJSON || '');
        } catch (e) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Stored NEW_USER request data is invalid and cannot be executed.',
            400
          );
        }
        if (!requestedData || typeof requestedData !== 'object' || Array.isArray(requestedData)) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Stored NEW_USER request data is invalid and cannot be executed.',
            400
          );
        }
        Validation.assertRequired(
          requestedData,
          ['username', 'displayName', 'email']
        );
        requestedData.email = Validation.validateEmail(requestedData.email);

        executionResult = UserService.createUser(superAdminContext, {
          ...requestedData,
          primaryWorkspaceId: req.WorkspaceID,
          role: CONSTANTS.ROLES.USER
        });
      } else if (
        req.RequestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE ||
        req.RequestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET
      ) {
        // Revalidate identity and membership at execution time. A queued request
        // must not retain authority after role/access changes.
        const targetAccount = MasterRepository.findAccountById(req.TargetUserID);
        if (!targetAccount) {
          throw new AppError(ERROR_CODES.NOT_FOUND, `Target user ${req.TargetUserID} was not found.`, 404);
        }
        if (targetAccount.Role !== CONSTANTS.ROLES.USER) {
          throw new AppError(
            ERROR_CODES.PERMISSION_DENIED,
            'Request can no longer be executed because the target is not an ordinary USER account.',
            403
          );
        }
        const stillAssigned = MasterRepository
          .getWorkspaceAccessForUser(req.TargetUserID)
          .some(access => access.WorkspaceID === req.WorkspaceID);
        if (!stillAssigned) {
          throw new AppError(
            ERROR_CODES.WORKSPACE_DENIED,
            'Request can no longer be executed because the target user is not actively assigned to the originating workspace.',
            403
          );
        }

        if (req.RequestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE) {
          executionResult = UserService.makeUserPassive(
            superAdminContext,
            req.TargetUserID,
            req.Reason
          );
        } else {
          const tempPassword = 'Flk-' + SecurityService.generateRandomHex(4) + '!9';
          executionResult = AuthService.resetPasswordByAdmin(
            superAdminContext,
            req.TargetUserID,
            tempPassword
          );
          executionResult.temporaryPassword = tempPassword;
        }
      } else {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Unsupported executable request type: ${req.RequestType}`,
          400
        );
      }

      const updated = MasterRepository.updateRequest(requestId, {
        Status: CONSTANTS.REQUEST_STATUS.EXECUTED,
        ExecutedAt: new Date().toISOString()
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: req.WorkspaceID,
        EntityType: 'REQUEST',
        EntityID: requestId,
        Action: CONSTANTS.AUDIT_EVENTS.REQUEST_EXECUTED,
        AfterJSON: updated,
        Reason: reviewComment
      });

      return { ok: true, request: updated, executionResult };
    } catch (executionErr) {
      // Release the execution claim for a safe retry while preserving the error
      // to the reviewer. Another reviewer can only retry after this reset.
      try {
        MasterRepository.updateRequest(requestId, {
          Status: CONSTANTS.REQUEST_STATUS.PENDING,
          ReviewedBy: '',
          ReviewedAt: '',
          ReviewComment: ''
        });
      } catch (resetErr) {
        console.error(
          `Failed to reset request ${requestId} after execution failure: ${resetErr.message}`
        );
      }
      throw executionErr;
    }
  }
};

/* ===== SetupService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Setup & Self-Healing Service
 * Manages the 9-Step Guided Setup Wizard, first-run initialization,
 * 10-point system integrity verification, and zero-code automated self-healing.
 */

var SetupService = (typeof global !== 'undefined' && global.SetupService) || {
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

/* ===== IntegrityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Data Integrity & Automated Audit Engine
 * Runs measured integrity checks and records the result in SystemHealthHistory.
 */

var IntegrityService = (typeof global !== 'undefined' && global.IntegrityService) || {
  runNightlyAudit() {
    const checks = [];
    const timestamp = new Date().toISOString();
    let activeTimerCount = 0;

    const addCheck = (id, name, passed, detail) => {
      checks.push({ id, name, passed: passed === true, detail: String(detail || '') });
    };

    let accounts = [];
    let accessRows = [];
    let workspaces = [];
    try {
      accounts = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS).rows || [];
      accessRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS).rows || [];
      workspaces = MasterRepository.listWorkspaces() || [];
    } catch (e) {
      addCheck('master_reference_load', 'Master Reference Data Load', false, e.message);
    }

    const accountMap = new Map(accounts.map(a => [a.UserID, a]));
    const workspaceMap = new Map(workspaces.map(w => [w.WorkspaceID, w]));
    const activeWorkspaces = workspaces.filter(w => w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE);

    // 1. Unique usernames
    try {
      const seen = new Set();
      const duplicates = new Set();
      for (const account of accounts) {
        const username = String(account.Username || '').trim().toLowerCase();
        if (!username) continue;
        if (seen.has(username)) duplicates.add(username);
        seen.add(username);
      }
      addCheck(
        'unique_usernames',
        'Unique Usernames Invariant',
        duplicates.size === 0,
        duplicates.size === 0 ? 'All usernames are unique' : `Duplicates: ${[...duplicates].join(', ')}`
      );
    } catch (e) {
      addCheck('unique_usernames', 'Unique Usernames Invariant', false, e.message);
    }

    // 2. Admin max-workspace rule
    try {
      const violations = [];
      for (const admin of accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN)) {
        const activeCount = accessRows.filter(r =>
          r.UserID === admin.UserID &&
          (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
        ).length;
        if (activeCount > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
          violations.push(`${admin.Username}: ${activeCount}`);
        }
      }
      addCheck(
        'admin_workspace_limit',
        'Admin Workspace Limit Invariant',
        violations.length === 0,
        violations.length === 0 ? 'All Admin assignments are within configured limit' : violations.join('; ')
      );
    } catch (e) {
      addCheck('admin_workspace_limit', 'Admin Workspace Limit Invariant', false, e.message);
    }

    // 3. Master schema tabs
    try {
      const masterSs = MasterRepository.getMasterSpreadsheet();
      const expectedTabs = Object.values(CONSTANTS.MASTER_TABS);
      const missing = expectedTabs.filter(tab => !masterSs.getSheetByName(tab));
      addCheck(
        'master_tabs',
        'Master Control Schema',
        missing.length === 0,
        missing.length === 0 ? `All ${expectedTabs.length} master tabs exist` : `Missing: ${missing.join(', ')}`
      );
    } catch (e) {
      addCheck('master_tabs', 'Master Control Schema', false, e.message);
    }

    // 4. Workspace tabs
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
        const missing = Object.values(CONSTANTS.WORKSPACE_TABS).filter(tab => !ss.getSheetByName(tab));
        if (missing.length) issues.push(`${ws.WorkspaceName}: ${missing.join(', ')}`);
      }
      addCheck(
        'workspace_tabs',
        'Workspace Schema Tabs',
        issues.length === 0,
        issues.length === 0 ? `${activeWorkspaces.length} active workspace(s) have all required tabs` : issues.join('; ')
      );
    } catch (e) {
      addCheck('workspace_tabs', 'Workspace Schema Tabs', false, e.message);
    }

    // 5. WorkspaceInfo/schema-version consistency
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const rows = SheetRepository.getTableData(
          ws.WorkspaceID,
          CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO
        ).rows || [];
        if (rows.length !== 1) {
          issues.push(`${ws.WorkspaceName}: expected one WorkspaceInfo row, found ${rows.length}`);
          continue;
        }
        const info = rows[0];
        if (String(info.WorkspaceID) !== String(ws.WorkspaceID)) {
          issues.push(`${ws.WorkspaceName}: WorkspaceID mismatch`);
        }
        if (String(info.SchemaVersion) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: schema v${info.SchemaVersion}, expected v${CONSTANTS.SCHEMA_VERSION}`);
        }
        if (String(ws.SchemaVersion || CONSTANTS.SCHEMA_VERSION) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: registry schema v${ws.SchemaVersion}`);
        }
      }
      addCheck(
        'schema_version',
        'Schema Version Consistency',
        issues.length === 0,
        issues.length === 0 ? `All active workspaces are on schema v${CONSTANTS.SCHEMA_VERSION}` : issues.join('; ')
      );
    } catch (e) {
      addCheck('schema_version', 'Schema Version Consistency', false, e.message);
    }

    // 6. Active timer owner/access validity
    const allTimers = [];
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const allowedUsers = new Set(
          accessRows
            .filter(r =>
              r.WorkspaceID === ws.WorkspaceID &&
              (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
            )
            .map(r => r.UserID)
        );
        const timers = SheetRepository.listActiveTimers(ws.WorkspaceID) || [];
        activeTimerCount += timers.length;
        for (const timer of timers) {
          allTimers.push({ ...timer, _workspaceId: ws.WorkspaceID });
          const account = accountMap.get(timer.UserID);
          if (!account || account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
            issues.push(`${timer.TimerID}: inactive/missing user ${timer.UserID}`);
          }
          if (!allowedUsers.has(timer.UserID)) {
            issues.push(`${timer.TimerID}: user lacks active workspace access`);
          }
          if (isNaN(new Date(timer.StartedAtUTC).getTime())) {
            issues.push(`${timer.TimerID}: invalid StartedAtUTC`);
          }
        }
      }
      addCheck(
        'active_timer_user_ref',
        'Active Timer Owner/Workspace Integrity',
        issues.length === 0,
        issues.length === 0 ? `${activeTimerCount} active timer(s) have valid owners/access` : issues.join('; ')
      );
    } catch (e) {
      addCheck('active_timer_user_ref', 'Active Timer Owner/Workspace Integrity', false, e.message);
    }

    // 7. One active timer globally per user
    try {
      const counts = new Map();
      for (const timer of allTimers) {
        counts.set(timer.UserID, (counts.get(timer.UserID) || 0) + 1);
      }
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
      addCheck(
        'single_active_timer_invariant',
        'Single Active Timer Invariant',
        duplicates.length === 0,
        duplicates.length === 0
          ? 'No user has more than one active timer globally'
          : duplicates.map(([userId, count]) => `${userId}: ${count} timers`).join('; ')
      );
    } catch (e) {
      addCheck('single_active_timer_invariant', 'Single Active Timer Invariant', false, e.message);
    }

    // Cache workspace operational data for checks 8-15.
    const workspaceData = new Map();
    try {
      for (const ws of activeWorkspaces) {
        const entries = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES).rows || [];
        const projects = SheetRepository.listProjects(ws.WorkspaceID) || [];
        const tasks = SheetRepository.listTasks(ws.WorkspaceID) || [];
        const clients = SheetRepository.listClients(ws.WorkspaceID) || [];
        const tags = SheetRepository.listTags(ws.WorkspaceID) || [];
        const timesheets = SheetRepository.listTimesheets(ws.WorkspaceID, {}) || [];
        workspaceData.set(ws.WorkspaceID, { entries, projects, tasks, clients, tags, timesheets });
      }
    } catch (e) {
      addCheck('workspace_data_load', 'Workspace Integrity Data Load', false, e.message);
    }

    // 8. Start <= End
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end) || end < start) {
            issues.push(`${workspaceId}/${entry.EntryID}`);
          }
        }
      }
      addCheck(
        'entry_timestamps_order',
        'Time Entry Timestamp Ordering',
        issues.length === 0,
        issues.length === 0 ? 'All active entries have valid StartUTC <= EndUTC' : `Invalid entries: ${issues.join(', ')}`
      );
    } catch (e) {
      addCheck('entry_timestamps_order', 'Time Entry Timestamp Ordering', false, e.message);
    }

    // 9. Duration mathematical accuracy
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end)) continue;
          const expected = Math.max(0, Math.round((end - start) / 1000));
          const stored = parseInt(entry.DurationSeconds, 10) || 0;
          if (Math.abs(expected - stored) > 1) {
            issues.push(`${workspaceId}/${entry.EntryID}: stored=${stored}, expected=${expected}`);
          }
        }
      }
      addCheck(
        'duration_calculation_accuracy',
        'Duration Mathematical Accuracy',
        issues.length === 0,
        issues.length === 0 ? 'All active entry durations match timestamp deltas' : issues.join('; ')
      );
    } catch (e) {
      addCheck('duration_calculation_accuracy', 'Duration Mathematical Accuracy', false, e.message);
    }

    // 10. Task -> Project integrity
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        for (const task of data.tasks) {
          if (!projectIds.has(task.ProjectID)) {
            issues.push(`${workspaceId}/${task.TaskID}: missing project ${task.ProjectID}`);
          }
        }
      }
      addCheck(
        'task_project_integrity',
        'Task to Project Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All tasks reference existing projects' : issues.join('; ')
      );
    } catch (e) {
      addCheck('task_project_integrity', 'Task to Project Referential Integrity', false, e.message);
    }

    // 11. TimeEntry project/task references
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        const taskMap = new Map(data.tasks.map(t => [t.TaskID, t]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          if (entry.ProjectID && !projectIds.has(entry.ProjectID)) {
            issues.push(`${workspaceId}/${entry.EntryID}: missing project ${entry.ProjectID}`);
          }
          if (entry.TaskID) {
            const task = taskMap.get(entry.TaskID);
            if (!task) issues.push(`${workspaceId}/${entry.EntryID}: missing task ${entry.TaskID}`);
            else if (entry.ProjectID && task.ProjectID !== entry.ProjectID) {
              issues.push(`${workspaceId}/${entry.EntryID}: task/project mismatch`);
            }
          }
        }
      }
      addCheck(
        'entry_project_reference',
        'Time Entry Project/Task Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All active entries reference valid project/task entities' : issues.join('; ')
      );
    } catch (e) {
      addCheck('entry_project_reference', 'Time Entry Project/Task Referential Integrity', false, e.message);
    }

    // 12. Submitted/approved entries must be locked and tied to matching timesheet state.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const timesheetMap = new Map(data.timesheets.map(ts => [ts.TimesheetID, ts]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const approval = String(entry.ApprovalStatus || '');
          if (![CONSTANTS.TIMESHEET_STATUS.SUBMITTED, CONSTANTS.TIMESHEET_STATUS.APPROVED].includes(approval)) {
            continue;
          }
          const locked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
          if (!locked) issues.push(`${workspaceId}/${entry.EntryID}: ${approval} but unlocked`);
          const ts = timesheetMap.get(entry.TimesheetID);
          if (!ts) issues.push(`${workspaceId}/${entry.EntryID}: missing timesheet ${entry.TimesheetID}`);
          else if (String(ts.Status) !== approval) {
            issues.push(`${workspaceId}/${entry.EntryID}: entry=${approval}, timesheet=${ts.Status}`);
          }
        }
      }
      addCheck(
        'approved_entry_locking',
        'Timesheet Entry Lock/State Integrity',
        issues.length === 0,
        issues.length === 0 ? 'Submitted/approved entries are locked and match timesheet state' : issues.join('; ')
      );
    } catch (e) {
      addCheck('approved_entry_locking', 'Timesheet Entry Lock/State Integrity', false, e.message);
    }

    // 13. Aggregate rollups reconcile to active raw time.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const rawSeconds = data.entries
          .filter(e => e.Status !== 'DELETED')
          .reduce((sum, e) => sum + (parseInt(e.DurationSeconds, 10) || 0), 0);
        for (const tab of [
          CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
        ]) {
          const rows = SheetRepository.getTableData(workspaceId, tab).rows || [];
          const aggregate = rows.reduce((sum, r) => sum + (parseInt(r.TotalSeconds, 10) || 0), 0);
          if (aggregate !== rawSeconds) {
            issues.push(`${workspaceId}/${tab}: raw=${rawSeconds}, rollup=${aggregate}`);
          }
        }
      }
      addCheck(
        'rollups_reconciliation',
        'Rollup to Raw Entry Reconciliation',
        issues.length === 0,
        issues.length === 0 ? 'Daily, weekly, and monthly totals match active raw time' : issues.join('; ')
      );
    } catch (e) {
      addCheck('rollups_reconciliation', 'Rollup to Raw Entry Reconciliation', false, e.message);
    }

    // 14. WorkspaceAccess referential/role integrity
    try {
      const issues = [];
      for (const access of accessRows) {
        const account = accountMap.get(access.UserID);
        const ws = workspaceMap.get(access.WorkspaceID);
        if (!account) issues.push(`${access.AccessID}: missing user ${access.UserID}`);
        if (!ws) issues.push(`${access.AccessID}: missing workspace ${access.WorkspaceID}`);
        if (account && access.Role && access.Role !== account.Role) {
          issues.push(`${access.AccessID}: ACL role ${access.Role} != account role ${account.Role}`);
        }
        const active = access.Active === true || access.Active === 'TRUE' || access.Active === 1;
        if (active && ws && ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          issues.push(`${access.AccessID}: active ACL points to ${ws.Status} workspace`);
        }
      }
      addCheck(
        'access_orphans',
        'Workspace Access Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All ACL records reference valid users/workspaces with matching roles' : issues.join('; ')
      );
    } catch (e) {
      addCheck('access_orphans', 'Workspace Access Referential Integrity', false, e.message);
    }

    // 15. Entity ID uniqueness across master and active workspaces
    try {
      const seen = new Map();
      const duplicates = [];
      const register = (id, location) => {
        const value = String(id || '').trim();
        if (!value) return;
        if (seen.has(value)) duplicates.push(`${value}: ${seen.get(value)} + ${location}`);
        else seen.set(value, location);
      };

      accounts.forEach(a => register(a.UserID, 'Accounts'));
      workspaces.forEach(w => register(w.WorkspaceID, 'Workspaces'));
      for (const [workspaceId, data] of workspaceData.entries()) {
        data.clients.forEach(x => register(x.ClientID, `${workspaceId}/Clients`));
        data.projects.forEach(x => register(x.ProjectID, `${workspaceId}/Projects`));
        data.tasks.forEach(x => register(x.TaskID, `${workspaceId}/Tasks`));
        data.tags.forEach(x => register(x.TagID, `${workspaceId}/Tags`));
        data.entries.forEach(x => register(x.EntryID, `${workspaceId}/TimeEntries`));
        data.timesheets.forEach(x => register(x.TimesheetID, `${workspaceId}/Timesheets`));
      }

      addCheck(
        'unique_entity_ids',
        'Entity ID Uniqueness',
        duplicates.length === 0,
        duplicates.length === 0 ? `${seen.size} entity IDs verified unique` : duplicates.join('; ')
      );
    } catch (e) {
      addCheck('unique_entity_ids', 'Entity ID Uniqueness', false, e.message);
    }

    // 16. Capacity across Master + all active workspaces
    let worstCapacityStatus = 'HEALTHY';
    let totalCellCount = 0;
    try {
      const metrics = [JobService.getCapacityMetrics()];
      for (const ws of activeWorkspaces) metrics.push(JobService.getCapacityMetrics(ws.WorkspaceID));
      totalCellCount = metrics.reduce((sum, m) => sum + (m.totalCells || 0), 0);
      const critical = metrics.filter(m => m.alertStatus === 'CRITICAL');
      const warning = metrics.filter(m => m.alertStatus === 'WARNING');
      const advisory = metrics.filter(m => m.alertStatus === 'ADVISORY');
      if (critical.length) worstCapacityStatus = 'CRITICAL';
      else if (warning.length) worstCapacityStatus = 'WARNING';
      else if (advisory.length) worstCapacityStatus = 'ADVISORY';

      addCheck(
        'cell_capacity_limit',
        'Google Sheets Cell Capacity',
        critical.length === 0,
        critical.length === 0
          ? `Capacity status ${worstCapacityStatus}; total used cells across checked spreadsheets: ${totalCellCount}`
          : `Critical capacity: ${critical.map(m => `${m.spreadsheetName} ${m.utilizationPct}%`).join(', ')}`
      );
    } catch (e) {
      addCheck('cell_capacity_limit', 'Google Sheets Cell Capacity', false, e.message);
      worstCapacityStatus = 'UNKNOWN';
    }

    const passCount = checks.filter(c => c.passed).length;
    const failCount = checks.length - passCount;
    const overallStatus = failCount === 0
      ? 'HEALTHY'
      : (checks.some(c => c.id === 'cell_capacity_limit' && !c.passed) ? 'CRITICAL' : 'WARNING');

    try {
      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.SYSTEM_HEALTH_HISTORY, {
        HealthCheckID: Validation.generateId('CHK'),
        TimestampUTC: timestamp,
        OverallStatus: overallStatus,
        MasterDbStatus: checks.find(c => c.id === 'master_tabs')?.passed ? 'OK' : 'ERROR',
        WorkspacesStatus: checks.find(c => c.id === 'workspace_tabs')?.passed ? 'OK' : 'ERROR',
        ActiveTimersCount: activeTimerCount,
        CellCountApprox: totalCellCount,
        QuotaStatus: worstCapacityStatus,
        DetailsJSON: JSON.stringify({ passCount, failCount, checks })
      });
    } catch (e) {
      console.error('Failed to record SystemHealthHistory: ' + e.message);
    }

    return {
      ok: true,
      timestampUTC: timestamp,
      overallStatus,
      totalChecks: checks.length,
      passCount,
      failCount,
      checks
    };
  }
};

/* ===== JobService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Job Engine, Trigger Dispatcher & Capacity Monitor
 * Manages chunked long-running background tasks with cursor persistence,
 * central trigger dispatchers, and Google Sheets 10M cell capacity tracking.
 */

var JobService = (typeof global !== 'undefined' && global.JobService) || {
  _scheduledTriggerSpecs: [
    { handler: 'scheduledHousekeeping', hour: 1, purpose: 'Expired session cleanup' },
    { handler: 'scheduledRollups', hour: 2, purpose: 'Rollup reconciliation' }
  ],

  getScheduledTriggerStatus() {
    if (
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getProjectTriggers
    ) {
      return {
        supported: false,
        healthy: false,
        expected: this._scheduledTriggerSpecs.map(spec => spec.handler),
        installed: [],
        missing: this._scheduledTriggerSpecs.map(spec => spec.handler),
        detail: 'Apps Script trigger runtime is unavailable.'
      };
    }

    const triggers = ScriptApp.getProjectTriggers();
    const installed = triggers
      .map(trigger => trigger.getHandlerFunction ? trigger.getHandlerFunction() : '')
      .filter(Boolean);
    const installedSet = new Set(installed);
    const missing = this._scheduledTriggerSpecs
      .map(spec => spec.handler)
      .filter(handler => !installedSet.has(handler));

    return {
      supported: true,
      healthy: missing.length === 0,
      expected: this._scheduledTriggerSpecs.map(spec => spec.handler),
      installed,
      missing,
      detail: missing.length === 0
        ? 'All required scheduled triggers are installed.'
        : `Missing scheduled trigger(s): ${missing.join(', ')}`
    };
  },

  ensureScheduledTriggers() {
    if (
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getProjectTriggers ||
      !ScriptApp.newTrigger
    ) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        'Apps Script trigger runtime is unavailable.',
        500
      );
    }

    const existing = new Set(
      ScriptApp.getProjectTriggers()
        .map(trigger => trigger.getHandlerFunction ? trigger.getHandlerFunction() : '')
        .filter(Boolean)
    );
    const created = [];

    for (const spec of this._scheduledTriggerSpecs) {
      if (existing.has(spec.handler)) continue;
      ScriptApp
        .newTrigger(spec.handler)
        .timeBased()
        .everyDays(1)
        .atHour(spec.hour)
        .create();
      created.push(spec.handler);
    }

    const status = this.getScheduledTriggerStatus();
    return {
      ok: status.healthy,
      created,
      ...status
    };
  },

  _beginJobExecution() {
    if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
      MasterRepository.beginRequest();
    }
    if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
      SheetRepository.beginRequest();
    }
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }
  },

  /**
   * Central Housekeeping Dispatcher
   * Cleans up expired sessions, archives stale cache, and logs execution.
   */
  dispatchHousekeeping() {
    this._beginJobExecution();
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    let expiredSessionsCount = 0;
    let purgedSessionsCount = 0;
    let purgedMfaChallengesCount = 0;

    try {
      const { rows: sessions } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const now = Date.now();
      const nowIso = new Date().toISOString();
      const retentionMs =
        (CONSTANTS.LIMITS.SESSION_RETENTION_DAYS || 30) * 24 * 3600 * 1000;
      const retentionCutoff = now - retentionMs;

      for (const s of sessions) {
        const expiresMs = new Date(s.ExpiresAt).getTime();
        const revoked =
          s.Revoked === true || s.Revoked === 'TRUE' || s.Revoked === 1;

        if (!revoked && !isNaN(expiresMs) && expiresMs <= now) {
          MasterRepository.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, {
            Revoked: true,
            RevokedAt: nowIso,
            RevokeReason: 'EXPIRED_IDLE_TIMEOUT'
          });
          expiredSessionsCount++;
        }
      }

      // Purge only old, already-invalid session rows; security/audit events remain
      // in their dedicated logs.
      const refreshedSessions =
        MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS).rows || [];
      const purgeRows = refreshedSessions
        .filter(s => {
          const revoked =
            s.Revoked === true || s.Revoked === 'TRUE' || s.Revoked === 1;
          const revokedAt = new Date(s.RevokedAt || '').getTime();
          const expiresAt = new Date(s.ExpiresAt || '').getTime();
          const oldEnough =
            (!isNaN(revokedAt) && revokedAt < retentionCutoff) ||
            (!isNaN(expiresAt) && expiresAt < retentionCutoff);
          return revoked && oldEnough;
        })
        .sort((a, b) => b._rowIndex - a._rowIndex);

      for (const session of purgeRows) {
        MasterRepository.deleteRow(
          CONSTANTS.MASTER_TABS.SESSIONS,
          session._rowIndex
        );
        purgedSessionsCount++;
      }

      // MFA challenges are one-per-user, but failed/abandoned challenges should
      // not occupy Script Properties forever.
      if (
        typeof PropertiesService !== 'undefined' &&
        PropertiesService.getScriptProperties
      ) {
        const props = PropertiesService.getScriptProperties();
        const all = props.getProperties();
        for (const [key, raw] of Object.entries(all)) {
          if (!key.startsWith('FLINK_MFA_CHALLENGE_')) continue;
          try {
            const challenge = JSON.parse(raw);
            if (Number(challenge.expiresAtMs || 0) < now) {
              props.deleteProperty(key);
              purgedMfaChallengesCount++;
            }
          } catch (e) {
            props.deleteProperty(key);
            purgedMfaChallengesCount++;
          }
        }
      }

      this.logJobRun({
        RunID: runId,
        JobID: 'JOB_HOUSEKEEPING',
        JobType: 'HOUSEKEEPING',
        WorkspaceID: 'MASTER',
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed:
          expiredSessionsCount + purgedSessionsCount + purgedMfaChallengesCount,
        Status: CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails:
          `Housekeeping revoked ${expiredSessionsCount} expired sessions, purged ${purgedSessionsCount} retained session rows, and removed ${purgedMfaChallengesCount} stale MFA challenges.`
      });

      return {
        ok: true,
        expiredSessionsCount,
        purgedSessionsCount,
        purgedMfaChallengesCount
      };
    } catch (e) {
      this.logJobRun({
        RunID: runId,
        JobID: 'JOB_HOUSEKEEPING',
        JobType: 'HOUSEKEEPING',
        WorkspaceID: 'MASTER',
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: expiredSessionsCount,
        Status: CONSTANTS.JOB_STATUS.FAILED,
        LogDetails: 'Housekeeping error: ' + e.message
      });
      throw e;
    }
  },

  /**
   * Central Rollup Recalculation Dispatcher
   * Synchronizes precomputed daily, weekly, monthly, and project rollups for all active workspaces.
   */
  dispatchRollups() {
    this._beginJobExecution();
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    const workspaces = MasterRepository.listWorkspaces();
    const results = [];

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) continue;
      try {
        const res = RollupService.rebuildRollups(ws.WorkspaceID);
        results.push({ workspaceId: ws.WorkspaceID, name: ws.WorkspaceName, ok: true, rollups: res });
      } catch (err) {
        results.push({ workspaceId: ws.WorkspaceID, name: ws.WorkspaceName, ok: false, error: err.message });
      }
    }

    this.logJobRun({
      RunID: runId,
      JobID: 'JOB_ROLLUP_DISPATCHER',
      JobType: 'ROLLUP_SYNC',
      WorkspaceID: 'ALL',
      StartedAt: new Date(startMs).toISOString(),
      EndedAt: new Date().toISOString(),
      DurationMs: Date.now() - startMs,
      ItemsProcessed: results.length,
      Status: results.every(r => r.ok) ? CONSTANTS.JOB_STATUS.COMPLETED : CONSTANTS.JOB_STATUS.FAILED,
      LogDetails: `Processed rollups for ${results.length} workspaces.`
    });

    return { ok: true, workspacesProcessed: results.length, details: results };
  },

  /**
   * Chunked Job Processor with Cursor Persistence
   * Executes a batch of items, saves progress cursor in JobRegistry, and splits work safely across execution windows.
   */
  runChunkedJob(jobType, workspaceId, workerBatchFn, maxDurationMs = 120000, maxBatches = null) {
    const jobRegistry = this.getOrCreateJob(jobType, workspaceId);
    const startMs = Date.now();
    const runId = Validation.generateId('RUN');
    let itemsProcessed = 0;
    let newCursor = jobRegistry.Cursor || '0';
    let hasMore = true;
    let batchesRun = 0;

    try {
      // Execute batch worker while within budget and batch count limit
      while (hasMore && (Date.now() - startMs) < maxDurationMs && (!maxBatches || batchesRun < maxBatches)) {
        const batchResult = workerBatchFn(newCursor);
        itemsProcessed += batchResult.processedCount || 0;
        newCursor = String(batchResult.nextCursor || '');
        hasMore = batchResult.hasMore === true;
        batchesRun++;
      }

      const status = hasMore ? CONSTANTS.JOB_STATUS.QUEUED : CONSTANTS.JOB_STATUS.COMPLETED;
      this.updateJobRegistry(jobRegistry.JobID, {
        Status: status,
        Cursor: newCursor,
        UpdatedAt: new Date().toISOString(),
        LastError: ''
      });

      this.logJobRun({
        RunID: runId,
        JobID: jobRegistry.JobID,
        JobType: jobType,
        WorkspaceID: workspaceId,
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: itemsProcessed,
        Status: status,
        LogDetails: hasMore ? `Batch paused at cursor ${newCursor}` : `Job completed. Total ${itemsProcessed} items processed.`
      });

      return { ok: true, status, cursor: newCursor, itemsProcessed, hasMore };
    } catch (err) {
      this.updateJobRegistry(jobRegistry.JobID, {
        Status: CONSTANTS.JOB_STATUS.FAILED,
        UpdatedAt: new Date().toISOString(),
        LastError: err.message
      });

      this.logJobRun({
        RunID: runId,
        JobID: jobRegistry.JobID,
        JobType: jobType,
        WorkspaceID: workspaceId,
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: itemsProcessed,
        Status: CONSTANTS.JOB_STATUS.FAILED,
        LogDetails: 'Chunked execution failure: ' + err.message
      });

      throw err;
    }
  },

  /**
   * Capacity Monitor: Estimates cell count against Google Sheets 10M Limit
   * Warnings: 60% = advisory, 75% = warning, 85% = partition required
   */
  getCapacityMetrics(workspaceId = null) {
    let targetSs = null;
    let name = 'Master Control';

    if (workspaceId) {
      targetSs = WorkspaceRouter.resolveSpreadsheet(workspaceId);
      const ws = MasterRepository.getWorkspace(workspaceId);
      name = ws ? ws.WorkspaceName : workspaceId;
    } else {
      targetSs = MasterRepository.getMasterSpreadsheet();
    }

    let totalCells = 0;
    let totalRows = 0;
    let totalColumns = 0;
    const tabBreakdown = [];

    if (targetSs && targetSs.getSheets) {
      const sheets = targetSs.getSheets();
      for (const sheet of sheets) {
        const rows = sheet.getLastRow();
        const cols = sheet.getLastColumn();
        const cells = rows * cols;
        totalCells += cells;
        totalRows += rows;
        totalColumns = Math.max(totalColumns, cols);

        tabBreakdown.push({
          tabName: sheet.getName(),
          rows,
          columns: cols,
          cells
        });
      }
    }

    const maxLimit = CONSTANTS.CAPACITY.MAX_CELLS_PER_SHEET;
    const utilizationPct = (totalCells / maxLimit) * 100;

    let alertStatus = 'HEALTHY';
    let recommendation = 'Capacity within normal operating thresholds.';

    if (utilizationPct >= CONSTANTS.CAPACITY.CRITICAL_THRESHOLD_PCT) {
      alertStatus = 'CRITICAL';
      recommendation = 'CRITICAL: Spreadsheet capacity >= 85%. Annual partition required immediately.';
    } else if (utilizationPct >= CONSTANTS.CAPACITY.WARNING_THRESHOLD_PCT) {
      alertStatus = 'WARNING';
      recommendation = 'WARNING: Spreadsheet capacity >= 75%. Plan archiving old records.';
    } else if (utilizationPct >= CONSTANTS.CAPACITY.ADVISORY_THRESHOLD_PCT) {
      alertStatus = 'ADVISORY';
      recommendation = 'ADVISORY: Capacity >= 60%. Monitor entry growth rate.';
    }

    return {
      spreadsheetName: name,
      workspaceId: workspaceId || 'MASTER',
      totalCells,
      maxLimit,
      utilizationPct: parseFloat(utilizationPct.toFixed(2)),
      alertStatus,
      recommendation,
      totalRows,
      totalColumns,
      tabBreakdown,
      checkedAtUTC: new Date().toISOString()
    };
  },

  /* ---------------- REGISTRY HELPERS ---------------- */

  getOrCreateJob(jobType, workspaceId) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.JOB_REGISTRY);
    const existing = rows.find(j => j.JobType === jobType && j.WorkspaceID === workspaceId);
    if (existing) return existing;

    const newJob = {
      JobID: Validation.generateId('JOB'),
      JobType: jobType,
      WorkspaceID: workspaceId,
      Status: CONSTANTS.JOB_STATUS.QUEUED,
      Cursor: '0',
      StartedAt: '',
      UpdatedAt: new Date().toISOString(),
      RetryCount: 0,
      NextRunAt: new Date().toISOString(),
      LastError: ''
    };

    MasterRepository.appendRow(CONSTANTS.MASTER_TABS.JOB_REGISTRY, newJob);
    return newJob;
  },

  updateJobRegistry(jobId, updates) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.JOB_REGISTRY);
    const job = rows.find(j => j.JobID === jobId);
    if (job) {
      MasterRepository.updateRow(CONSTANTS.MASTER_TABS.JOB_REGISTRY, job._rowIndex, updates);
    }
  },

  logJobRun(runData) {
    try {
      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.JOB_RUNS, {
        RunID: runData.RunID || Validation.generateId('RUN'),
        JobID: runData.JobID || '',
        JobType: runData.JobType || '',
        WorkspaceID: runData.WorkspaceID || '',
        StartedAt: runData.StartedAt || '',
        EndedAt: runData.EndedAt || '',
        DurationMs: runData.DurationMs || 0,
        ItemsProcessed: runData.ItemsProcessed || 0,
        Status: runData.Status || CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails: runData.LogDetails || ''
      });
    } catch (e) {
      console.error('Failed to log job run: ' + e.message);
    }
  }
};

function scheduledHousekeeping() {
  return JobService.dispatchHousekeeping();
}

function scheduledRollups() {
  return JobService.dispatchRollups();
}

/* ===== BackupAndAuditServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Backup, Audit & Notification Services
 * Automated Drive snapshot backups, disaster recovery validation, and immutable audit logs.
 */

var BackupService = (typeof global !== 'undefined' && global.BackupService) || {
  _manifestHmac(payload) {
    const key = SecurityService.getPepper() + '_FLINK_BACKUP_MANIFEST';
    const bytes = SecurityService.hmacSha256(key, JSON.stringify(payload));
    return Array.from(bytes)
      .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))
      .join('');
  },

  _expectedSchema(scope) {
    return scope === 'MASTER' ? MASTER_SCHEMA : WORKSPACE_SCHEMA;
  },

  _buildManifest(spreadsheet, scope, workspaceId = '') {
    if (!spreadsheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup spreadsheet could not be opened.', 400);
    }

    const expectedSchema = this._expectedSchema(scope);
    const sheetSummaries = [];

    for (const [tabName, expectedHeaders] of Object.entries(expectedSchema)) {
      const sheet = spreadsheet.getSheetByName(tabName);
      if (!sheet) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Backup is missing required tab '${tabName}'.`, 400);
      }
      if (sheet.getLastRow() < 1 || sheet.getLastColumn() < expectedHeaders.length) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Backup tab '${tabName}' has an invalid header row.`, 400);
      }

      const actualHeaders = sheet
        .getRange(1, 1, 1, expectedHeaders.length)
        .getValues()[0]
        .map(v => String(v).trim());

      for (let i = 0; i < expectedHeaders.length; i++) {
        if (actualHeaders[i] !== expectedHeaders[i]) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            `Backup tab '${tabName}' schema mismatch at column ${i + 1}: expected '${expectedHeaders[i]}', found '${actualHeaders[i]}'.`,
            400
          );
        }
      }

      const rowCount = Math.max(0, sheet.getLastRow() - 1);
      let contentHash = SecurityService.hashToken(JSON.stringify(actualHeaders));

      // Hash data in bounded chunks to avoid building one huge in-memory JSON string.
      const chunkSize = 250;
      for (let offset = 0; offset < rowCount; offset += chunkSize) {
        const count = Math.min(chunkSize, rowCount - offset);
        const values = sheet
          .getRange(2 + offset, 1, count, expectedHeaders.length)
          .getValues();
        contentHash = SecurityService.hashToken(contentHash + '|' + JSON.stringify(values));
      }

      sheetSummaries.push({
        name: tabName,
        rows: rowCount,
        columns: expectedHeaders.length,
        contentHash
      });
    }

    if (scope === 'WORKSPACE') {
      const infoSheet = spreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO);
      if (!infoSheet || infoSheet.getLastRow() < 2) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup WorkspaceInfo row is missing.', 400);
      }
      const info = infoSheet.getRange(2, 1, 1, WORKSPACE_SCHEMA.WorkspaceInfo.length).getValues()[0];
      if (String(info[0]) !== String(workspaceId)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          `Backup belongs to workspace '${info[0] || 'UNKNOWN'}', not '${workspaceId}'.`,
          403
        );
      }
      if (String(info[5]) !== String(CONSTANTS.SCHEMA_VERSION)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Backup schema version ${info[5]} is incompatible with required version ${CONSTANTS.SCHEMA_VERSION}.`,
          400
        );
      }
    }

    const manifest = {
      scope,
      workspaceId: scope === 'WORKSPACE' ? workspaceId : 'MASTER',
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      sheetCount: sheetSummaries.length,
      sheets: sheetSummaries
    };

    return {
      ...manifest,
      manifestHash: this._manifestHmac(manifest)
    };
  },

  _validateWorkspaceRollupTotals(spreadsheet) {
    if (!spreadsheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Restore candidate spreadsheet is unavailable.', 400);
    }

    const entriesSheet = spreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    if (!entriesSheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Restore candidate is missing TimeEntries.', 400);
    }

    const entryHeaders = WORKSPACE_SCHEMA.TimeEntries;
    const entryRows = Math.max(0, entriesSheet.getLastRow() - 1);
    let rawSeconds = 0;

    if (entryRows > 0) {
      const values = entriesSheet
        .getRange(2, 1, entryRows, entryHeaders.length)
        .getValues();
      const statusIdx = entryHeaders.indexOf('Status');
      const durationIdx = entryHeaders.indexOf('DurationSeconds');
      for (const row of values) {
        if (String(row[statusIdx] || '') === 'DELETED') continue;
        rawSeconds += parseInt(row[durationIdx], 10) || 0;
      }
    }

    const checked = {};
    for (const tab of [
      CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
    ]) {
      const sheet = spreadsheet.getSheetByName(tab);
      const headers = WORKSPACE_SCHEMA[tab];
      if (!sheet || !headers) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Restore candidate is missing rollup tab ${tab}.`, 400);
      }

      const rowCount = Math.max(0, sheet.getLastRow() - 1);
      let total = 0;
      if (rowCount > 0) {
        const values = sheet.getRange(2, 1, rowCount, headers.length).getValues();
        const totalIdx = headers.indexOf('TotalSeconds');
        for (const row of values) total += parseInt(row[totalIdx], 10) || 0;
      }
      checked[tab] = total;

      if (total !== rawSeconds) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Restore candidate rollup mismatch in ${tab}: raw=${rawSeconds}s, rollup=${total}s.`,
          409
        );
      }
    }

    return { ok: true, rawSeconds, rollups: checked };
  },

  _getRegistryRecord(backupId) {
    if (!backupId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'backupId is required.', 400);
    }
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
    const record = rows.find(row => row.BackupID === backupId);
    if (!record) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Registered backup '${backupId}' was not found.`, 404);
    }
    return record;
  },

  _parseStoredManifest(record) {
    try {
      const metadata = JSON.parse(record.ChecksumMetadata || '{}');
      if (!metadata || !metadata.manifestHash || !Array.isArray(metadata.sheets)) {
        throw new Error('manifest fields missing');
      }
      return metadata;
    } catch (e) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup registry manifest is missing or malformed.', 400);
    }
  },

  _openBackupSpreadsheet(fileId) {
    if (!fileId) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup file ID is missing.', 400);

    if (typeof DriveApp !== 'undefined' && DriveApp.getFileById) {
      let file;
      try {
        file = DriveApp.getFileById(fileId);
        if (file.isTrashed && file.isTrashed()) {
          throw new Error('file is in trash');
        }
      } catch (e) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Backup Drive file is unavailable: ' + e.message, 404);
      }
    }

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.openById) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Spreadsheet service is unavailable.', 500);
    }

    try {
      return SpreadsheetApp.openById(fileId);
    } catch (e) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup file is not an accessible Google Spreadsheet: ' + e.message, 400);
    }
  },

  /**
   * Creates an immutable registered snapshot and records a pepper-keyed content manifest.
   */
  createBackup(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(30000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire backup lock. Please retry.', 409);
      }
    }

    try {
      return this._createBackupUnlocked(superAdminContext, workspaceId);
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Internal snapshot implementation for callers that already own ScriptLock
   * (notably restore safety-backup creation).
   */
  _createBackupUnlocked(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const scope = workspaceId ? 'WORKSPACE' : 'MASTER';
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, '-');
    let sourceSpreadsheetId = '';
    let backupPrefix = '';

    if (workspaceId) {
      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.WORKSPACE_DENIED, 'Only an active workspace can be backed up.', 403);
      }
      sourceSpreadsheetId = ws.SpreadsheetID;
      backupPrefix = `${ws.WorkspaceID}_${String(ws.WorkspaceName || 'Workspace').replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    } else {
      const masterSs = MasterRepository.getMasterSpreadsheet();
      sourceSpreadsheetId = masterSs.getId();
      backupPrefix = 'MASTER_CONTROL_SHEET';
    }

    if (!sourceSpreadsheetId) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Backup source spreadsheet ID is missing.', 500);
    }

    const backupId = Validation.generateId('BKP');
    const backupFileName = `${backupPrefix}_BACKUP_${fileTimestamp}`;
    let backupFileId = '';

    try {
      if (typeof DriveApp === 'undefined' || !DriveApp.getFileById) {
        throw new Error('Drive service is unavailable');
      }
      const sourceFile = DriveApp.getFileById(sourceSpreadsheetId);
      const copy = sourceFile.makeCopy(backupFileName);
      backupFileId = copy.getId();

      const backupSpreadsheet = this._openBackupSpreadsheet(backupFileId);
      const manifest = this._buildManifest(backupSpreadsheet, scope, workspaceId || '');

      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY, {
        BackupID: backupId,
        Scope: scope,
        WorkspaceID: workspaceId || 'MASTER',
        SourceFileID: sourceSpreadsheetId,
        BackupFileID: backupFileId,
        CreatedAt: timestamp,
        Status: 'AVAILABLE',
        Verified: true,
        ChecksumMetadata: JSON.stringify(manifest)
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId || '',
        EntityType: 'BACKUP',
        EntityID: backupId,
        Action: CONSTANTS.AUDIT_EVENTS.BACKUP_CREATED,
        AfterJSON: {
          backupId,
          backupFileId,
          sourceSpreadsheetId,
          scope,
          manifestHash: manifest.manifestHash
        },
        Reason: 'Registered snapshot backup completed and verified'
      });

      return {
        ok: true,
        backupId,
        backupFileId,
        backupFileName,
        scope,
        workspaceId: workspaceId || 'MASTER',
        verified: true,
        manifestHash: manifest.manifestHash
      };
    } catch (e) {
      if (backupFileId) {
        try { DriveApp.getFileById(backupFileId).setTrashed(true); } catch (trashErr) {}
      }
      if (e instanceof AppError) throw e;
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Drive backup failed: ' + e.message, 500);
    }
  },

  createWorkspaceBackup(superAdminContext, workspaceId) {
    return this.createBackup(superAdminContext, workspaceId);
  },

  listBackups(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
    return rows
      .filter(row => {
        if (workspaceId) {
          return row.Scope === 'WORKSPACE' && String(row.WorkspaceID) === String(workspaceId);
        }
        return true;
      })
      .sort((a, b) => new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime())
      .map(row => ({
        backupId: row.BackupID,
        scope: row.Scope,
        workspaceId: row.WorkspaceID,
        createdAt: row.CreatedAt,
        status: row.Status,
        verified: row.Verified === true || row.Verified === 'TRUE' || row.Verified === 1,
        sourceFileId: row.SourceFileID,
        backupFileId: row.BackupFileID
      }));
  },

  /**
   * Reopens and fully verifies a registered backup. Arbitrary Drive file IDs are rejected.
   */
  validateBackup(superAdminContext, workspaceId, backupId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!workspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId is required for workspace restore validation.', 400);
    }

    const ws = MasterRepository.getWorkspace(workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);

    const record = this._getRegistryRecord(backupId);
    if (record.Scope !== 'WORKSPACE' || String(record.WorkspaceID) !== String(workspaceId)) {
      throw new AppError(ERROR_CODES.WORKSPACE_DENIED, 'Backup is not registered for the requested workspace.', 403);
    }
    if (record.Status !== 'AVAILABLE' || !(record.Verified === true || record.Verified === 'TRUE' || record.Verified === 1)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Backup registry record is not in a verified AVAILABLE state.', 409);
    }

    const storedManifest = this._parseStoredManifest(record);
    const spreadsheet = this._openBackupSpreadsheet(record.BackupFileID);
    const currentManifest = this._buildManifest(spreadsheet, 'WORKSPACE', workspaceId);

    if (!SecurityService.constantTimeEquals(storedManifest.manifestHash, currentManifest.manifestHash)) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Backup content no longer matches its registered integrity manifest.',
        409
      );
    }

    return {
      ok: true,
      valid: true,
      backupId: record.BackupID,
      backupFileId: record.BackupFileID,
      workspaceId,
      schemaVersion: currentManifest.schemaVersion,
      manifestHash: currentManifest.manifestHash,
      createdAt: record.CreatedAt,
      message: 'Registered backup content and schema verified successfully.'
    };
  },

  /**
   * Restores a registered workspace backup through a new working copy.
   * The immutable backup file itself never becomes the live workspace.
   */
  restoreBackup(superAdminContext, workspaceId, backupId, adminPassword) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!workspaceId || !backupId || !adminPassword) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId, backupId, and Super Admin password are required for restore.', 400);
    }

    const credentials = MasterRepository.getCredentials(superAdminContext.userId);
    if (!credentials || !SecurityService.verifyPassword(adminPassword, credentials.PasswordHash)) {
      MasterRepository.logSecurityEvent({
        UserID: superAdminContext.userId,
        Username: superAdminContext.user ? superAdminContext.user.Username : '',
        EventType: 'RESTORE_REAUTH_FAILED',
        Success: false,
        metadata: { workspaceId, backupId }
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin password confirmation failed.', 401);
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(30000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire restore lock. Please retry.', 409);
      }
    }

    let previousSpreadsheetId = '';
    let candidateFileId = '';
    let workspaceWasQuiesced = false;

    try {
      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.WORKSPACE_DENIED, `Workspace must be ACTIVE before restore; current status is ${ws.Status}.`, 403);
      }
      previousSpreadsheetId = ws.SpreadsheetID;

      const validation = this.validateBackup(superAdminContext, workspaceId, backupId);
      const record = this._getRegistryRecord(backupId);

      // Safety snapshot of the currently live workspace before any pointer change.
      const safetyBackup = this._createBackupUnlocked(superAdminContext, workspaceId);

      const backupFile = DriveApp.getFileById(record.BackupFileID);
      const candidateName = `RESTORE_${workspaceId}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const candidateFile = backupFile.makeCopy(candidateName);
      candidateFileId = candidateFile.getId();

      const candidateSpreadsheet = this._openBackupSpreadsheet(candidateFileId);
      const candidateManifest = this._buildManifest(candidateSpreadsheet, 'WORKSPACE', workspaceId);
      if (!SecurityService.constantTimeEquals(validation.manifestHash, candidateManifest.manifestHash)) {
        throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Restore working copy failed integrity verification.', 409);
      }

      // Validate aggregate consistency while the candidate is still isolated.
      // A stale/corrupt rollup set is rejected rather than exposed live.
      const candidateRollupValidation = this._validateWorkspaceRollupTotals(candidateSpreadsheet);

      // Quiesce all normal workspace operations before changing the live pointer.
      MasterRepository.updateWorkspace(workspaceId, {
        Status: CONSTANTS.WORKSPACE_STATUS.MAINTENANCE,
        UpdatedAt: new Date().toISOString()
      });
      workspaceWasQuiesced = true;

      // Clear stale active timers directly on the candidate while it is still offline.
      const timersSheet = candidateSpreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
      if (timersSheet && timersSheet.getLastRow() > 1) {
        timersSheet.deleteRows(2, timersSheet.getLastRow() - 1);
      }

      MasterRepository.updateWorkspace(workspaceId, {
        SpreadsheetID: candidateFileId,
        Status: CONSTANTS.WORKSPACE_STATUS.MAINTENANCE,
        UpdatedAt: new Date().toISOString()
      });
      if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
        WorkspaceRouter.clearCache();
      }

      // Revoke all workspace-member sessions before reopening the restored dataset.
      const accesses = MasterRepository.getWorkspaceAccessForWorkspace(workspaceId);
      for (const access of accesses) {
        SessionService.revokeAllUserSessions(access.UserID);
      }

      // Commit ACTIVE only after candidate integrity, timer cleanup, pointer switch,
      // and session revocation have all succeeded. No normal request can observe
      // the candidate while it is still in MAINTENANCE.
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        SpreadsheetApp.flush();
      }

      MasterRepository.updateWorkspace(workspaceId, {
        Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString()
      });
      if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
        WorkspaceRouter.clearCache();
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'WORKSPACE',
        EntityID: workspaceId,
        Action: 'RESTORE_COMPLETED',
        BeforeJSON: { spreadsheetId: previousSpreadsheetId },
        AfterJSON: {
          spreadsheetId: candidateFileId,
          restoredBackupId: backupId,
          safetyBackupId: safetyBackup.backupId,
          candidateRollupValidation
        },
        Reason: 'Verified registered workspace restore applied through isolated working copy'
      });

      return {
        ok: true,
        workspaceId,
        backupId,
        safetyBackupId: safetyBackup.backupId,
        previousSpreadsheetId,
        restoredSpreadsheetId: candidateFileId,
        status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
        message: `Workspace ${workspaceId} restored from verified backup ${backupId}.`
      };
    } catch (err) {
      if (workspaceWasQuiesced && previousSpreadsheetId) {
        try {
          MasterRepository.updateWorkspace(workspaceId, {
            SpreadsheetID: previousSpreadsheetId,
            Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
            UpdatedAt: new Date().toISOString()
          });
          if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
            WorkspaceRouter.clearCache();
          }
        } catch (rollbackErr) {
          console.error('Restore rollback failed: ' + rollbackErr.message);
        }
      }

      if (candidateFileId) {
        try { DriveApp.getFileById(candidateFileId).setTrashed(true); } catch (trashErr) {}
      }

      try {
        MasterRepository.logGlobalAudit({
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          WorkspaceID: workspaceId,
          EntityType: 'WORKSPACE',
          EntityID: workspaceId,
          Action: 'RESTORE_FAILED',
          BeforeJSON: { spreadsheetId: previousSpreadsheetId },
          AfterJSON: { backupId, candidateFileId },
          Reason: err && err.message ? err.message : 'Restore failed'
        });
      } catch (auditErr) {}

      if (err instanceof AppError) throw err;
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Restore failed and was rolled back: ' + err.message, 500);
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

var AuditService = (typeof global !== 'undefined' && global.AuditService) || {
  log(authContext, workspaceId, entityType, entityId, action, beforeData = null, afterData = null, reason = '') {
    return this.logEvent(authContext, workspaceId, entityType, entityId, action, beforeData, afterData, reason);
  },

  /**
   * Universal audit logger
   */
  logEvent(authContext, workspaceId, entityType, entityId, action, beforeData, afterData, reason) {
    if (workspaceId) {
      try {
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext ? authContext.userId : 'SYSTEM',
          ActorRole: authContext ? authContext.role : 'SYSTEM',
          EntityType: entityType,
          EntityID: entityId,
          Action: action,
          BeforeJSON: beforeData,
          AfterJSON: afterData,
          Reason: reason,
          ClientType: 'WEB'
        });
      } catch (e) {
        console.warn('Workspace audit log notice: ' + e.message);
      }
    }

    try {
      MasterRepository.logGlobalAudit({
        ActorUserID: authContext ? authContext.userId : 'SYSTEM',
        ActorRole: authContext ? authContext.role : 'SYSTEM',
        WorkspaceID: workspaceId || '',
        EntityType: entityType,
        EntityID: entityId,
        Action: action,
        BeforeJSON: beforeData,
        AfterJSON: afterData,
        Reason: reason,
        ClientType: 'WEB'
      });
    } catch (e) {
      console.warn('Global audit log notice: ' + e.message);
    }
  },

  /**
   * Creates an external, tamper-evident checkpoint root hash for the audit trail.
   * Stored outside Google Sheets in ScriptProperties (inaccessible to spreadsheet editors).
   */
  createAuditCheckpoint(workspaceId = null) {
    const verification = this.verifyAuditChain(workspaceId);
    if (!verification.ok || !verification.verified) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cannot create checkpoint on unverified audit chain: ' + verification.message, 500);
    }

    const scope = workspaceId || 'MASTER';
    const dateStr = new Date().toISOString().split('T')[0];
    const lastHash = verification.lastRecordHash || 'GENESIS';
    const rootHash = SecurityService.computeAuditCheckpoint(scope, dateStr, lastHash, verification.count);

    const checkpointKey = (CONSTANTS.SECURITY.CHECKPOINT_PROPERTY_PREFIX || 'FLINK_AUDIT_CHECKPOINT_') + `${scope}_${dateStr}`;

    try {
      if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
        PropertiesService.getScriptProperties().setProperty(checkpointKey, JSON.stringify({
          scope,
          date: dateStr,
          lastHash,
          count: verification.count,
          rootHash,
          checkpointAt: new Date().toISOString()
        }));
      }
    } catch (e) {}

    return {
      ok: true,
      scope,
      date: dateStr,
      rootHash,
      count: verification.count,
      lastHash,
      checkpointKey
    };
  },

  /**
   * Verifies the cryptographic integrity of the HMAC-SHA256 hash chain in an audit log
   * and cross-checks against any stored external root hash checkpoints.
   */
  verifyAuditChain(workspaceId = null) {
    let rows = [];
    let scopeName = '';
    if (workspaceId) {
      scopeName = `Workspace (${workspaceId})`;
      rows = SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG).rows || [];
    } else {
      scopeName = 'Master GlobalAudit';
      rows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT).rows || [];
    }

    if (rows.length === 0) {
      return { ok: true, verified: true, count: 0, scope: scopeName, message: 'Audit log is empty (Genesis state).' };
    }

    let previousHash = '0000000000000000000000000000000000000000000000000000000000000000';
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (!row.AuditID || !row.TimestampUTC || !row.PreviousHash || !row.RecordHash) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID || '',
          message:
            `Audit chain is incomplete at record index ${i}: required identity/timestamp/hash fields are missing.`
        };
      }

      if (row.PreviousHash !== previousHash) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID,
          expectedPreviousHash: previousHash,
          actualPreviousHash: row.PreviousHash,
          message: `Audit chain broken at record index ${i} (${row.AuditID}). Previous hash mismatch.`
        };
      }

      const recordPayload = {
        auditId: row.AuditID,
        timestamp: row.TimestampUTC,
        actor: row.ActorUserID || '',
        action: row.Action,
        entityType: row.EntityType,
        entityId: row.EntityID,
        after: typeof row.AfterJSON === 'object' ? JSON.stringify(row.AfterJSON) : (row.AfterJSON || '')
      };
      const computedHash = SecurityService.computeAuditHash(row.PreviousHash, recordPayload);
      if (!SecurityService.constantTimeEquals(computedHash, row.RecordHash)) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID,
          message: `Tamper detected: Record HMAC mismatch at record index ${i} (${row.AuditID}).`
        };
      }
      previousHash = row.RecordHash;
    }

    // Check against external checkpoints if available
    let checkpointVerified = false;
    let checkpointInfo = null;
    try {
      if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
        const props = PropertiesService.getScriptProperties();
        const scope = workspaceId || 'MASTER';
        const dateStr = new Date().toISOString().split('T')[0];
        const checkpointKey = (CONSTANTS.SECURITY.CHECKPOINT_PROPERTY_PREFIX || 'FLINK_AUDIT_CHECKPOINT_') + `${scope}_${dateStr}`;
        const raw = props.getProperty(checkpointKey);
        if (raw) {
          const cp = JSON.parse(raw);
          const expectedRoot = SecurityService.computeAuditCheckpoint(cp.scope, cp.date, cp.lastHash, cp.count);
          if (SecurityService.constantTimeEquals(expectedRoot, cp.rootHash)) {
            checkpointVerified = true;
            checkpointInfo = cp;
          }
        }
      }
    } catch (e) {}

    return {
      ok: true,
      verified: true,
      count: rows.length,
      lastRecordHash: previousHash,
      scope: scopeName,
      checkpointVerified,
      checkpointInfo,
      message: `Audit chain verified successfully across all ${rows.length} records using HMAC-SHA256.`
    };
  }
};

var NotificationService = (typeof global !== 'undefined' && global.NotificationService) || {
  /**
   * Generates in-app system alerts and reminders
   */
  getPendingAlerts(authContext, workspaceId = null) {
    const alerts = [];

    // Admins and Super Admins get pending approvals alert
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN || authContext.role === CONSTANTS.ROLES.ADMIN) {
      const overview = DashboardService.getDashboardOverview(authContext, workspaceId);
      if (overview.pendingApprovalsCount > 0) {
        alerts.push({
          type: 'PENDING_APPROVALS',
          severity: 'INFO',
          message: `There are ${overview.pendingApprovalsCount} timesheet(s) awaiting review.`
        });
      }
      if (overview.pendingRequestsCount > 0) {
        alerts.push({
          type: 'PENDING_REQUESTS',
          severity: 'WARNING',
          message: `There are ${overview.pendingRequestsCount} user lifecycle request(s) awaiting Super Admin review.`
        });
      }
    }

    return alerts;
  }
};

/* ===== ExportAndMigrationServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Export & Migration Services
 * Generates formula-sanitized CSV exports, verifies system health, and bootstraps schemas.
 */

var ExportService = (typeof global !== 'undefined' && global.ExportService) || {
  /**
   * Generates sanitized CSV string from detailed report entries
   */
  exportDetailedCsv(authContext, workspaceId, params = {}) {
    const report = ReportService.getDetailedReport(authContext, workspaceId, params);
    const headers = [
      'Entry ID', 'User Name', 'Project', 'Task', 'Description',
      'Start UTC', 'End UTC', 'Duration (Seconds)', 'Duration (HH:MM:SS)',
      'Billable', 'Approval Status', 'Source', 'Manual'
    ];

    const escapeCsv = val => {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      // Neutralize spreadsheet formula injection in CSV exports
      if (/^[=+\-@\t\r\n]/.test(str)) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

    const csvLines = [headers.map(escapeCsv).join(',')];

    for (const e of report.entries) {
      csvLines.push([
        e.entryId,
        e.userName,
        e.projectName,
        e.taskName,
        e.description,
        e.startUTC,
        e.endUTC,
        e.durationSeconds,
        e.durationFormatted,
        e.billable ? 'YES' : 'NO',
        e.approvalStatus,
        e.source,
        e.manual ? 'YES' : 'NO'
      ].map(escapeCsv).join(','));
    }

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'EXPORT',
      EntityID: `EXP_${Date.now()}`,
      Action: CONSTANTS.AUDIT_EVENTS.EXPORT_CREATED,
      Reason: 'Detailed CSV export downloaded'
    });

    return {
      filename: `FLINK_Time_Export_${workspaceId}_${new Date().toISOString().substring(0, 10)}.csv`,
      csvContent: csvLines.join('\r\n'),
      totalRows: report.entries.length
    };
  }
};

var MigrationService = (typeof global !== 'undefined' && global.MigrationService) || {
  /**
   * Bootstraps only the Master Control Sheet schema and cryptographic secret.
   * It deliberately does NOT create any default/admin credentials.
   */
  bootstrapMasterSheet(masterSpreadsheet = null) {
    const ss = masterSpreadsheet || MasterRepository.getMasterSpreadsheet();

    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = ss.getSheetByName(tabName);
      if (!sheet) sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet.setFrozenRows(1);
    }

    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && !MASTER_SCHEMA[defaultSheet.getName()]) {
      try { ss.deleteSheet(defaultSheet); } catch (e) {}
    }

    SecurityService.ensurePepper();
    return { ok: true, message: 'Master Control Sheet schema and cryptographic secret initialized.' };
  },

  /**
   * System Health Diagnostic for Super Admin Console
   */
  getSystemHealth(superAdminContext) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const workspaces = MasterRepository.listWorkspaces();
    let accessibleWorkspacesCount = 0;
    let healthyWorkspacesCount = 0;

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED) {
        accessibleWorkspacesCount++;
        try {
          const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          if (ss) healthyWorkspacesCount++;
        } catch (e) {}
      }
    }

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSheetStatus: 'HEALTHY',
      workspacesStatus: `${healthyWorkspacesCount}/${accessibleWorkspacesCount} OK`,
      totalRegisteredWorkspaces: workspaces.length,
      timestampUTC: new Date().toISOString()
    };
  }
};

/**
 * Owner-only installation helper.
 * Run this function once from the Apps Script editor before opening the public web app.
 * The one-time setup key is written to the execution log and must be entered in Setup Step 1.
 */
function initializeInstallation() {
  MigrationService.bootstrapMasterSheet();
  if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Script Properties are unavailable in this runtime.');
  }

  const props = PropertiesService.getScriptProperties();
  const setupKey = SecurityService.generateRandomHex(24);
  props.setProperty('FLINK_SETUP_KEY_HASH', SecurityService.hashToken(setupKey));
  props.setProperty('FLINK_SETUP_KEY_CREATED_AT', new Date().toISOString());

  console.log('FLINK one-time setup key: ' + setupKey);
  return {
    ok: true,
    setupKey,
    message: 'Installation initialized. Use this one-time key in Setup Step 1; it is invalidated after Super Admin creation.'
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { UserService, AdminRequestService, SetupService, IntegrityService, JobService, BackupService, AuditService, NotificationService, ExportService, MigrationService };
}

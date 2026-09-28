/**
 * FLINK Time & Workforce Platform — Admin Request Service
 * Mediates Admin-driven user lifecycle requests (new user, make passive, password reset)
 * through a centralized Super Admin review and execution queue.
 */

const AdminRequestService = {
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
      Validation.assertRequired(requestedData, ['username', 'displayName']);
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
        Validation.assertRequired(requestedData, ['username', 'displayName']);

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AdminRequestService
  };
}

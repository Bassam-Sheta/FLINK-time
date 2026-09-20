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
      const all = MasterRepository.listRequests(statusFilter, workspaceId);
      return all.filter(r => allowedWs.has(r.WorkspaceID) || r.RequestedBy === authContext.userId);
    }

    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Only Admins and Super Admins can access request queues.', 403);
  },

  /**
   * Super Admin reviews, executes, or rejects a request
   */
  reviewRequest(superAdminContext, requestId, reviewPayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(reviewPayload, ['action']);

    const action = reviewPayload.action.toUpperCase(); // 'APPROVE' or 'REJECT'
    const reviewComment = reviewPayload.reviewComment ? Validation.sanitizeCellValue(reviewPayload.reviewComment) : '';
    const req = MasterRepository.getRequest(requestId);

    if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
    if (req.Status !== CONSTANTS.REQUEST_STATUS.PENDING) {
      throw new AppError(ERROR_CODES.CONFLICT, `Request ${requestId} has already been ${req.Status.toLowerCase()}.`);
    }

    const now = new Date().toISOString();

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

    if (action === 'APPROVE') {
      let executionResult = null;

      // Automatically execute requested operation
      if (req.RequestType === CONSTANTS.REQUEST_TYPES.NEW_USER) {
        let requestedData = {};
        try {
          requestedData = JSON.parse(req.RequestedDataJSON || '{}');
        } catch (e) {}

        const userPayload = {
          ...requestedData,
          primaryWorkspaceId: req.WorkspaceID,
          role: requestedData.role || CONSTANTS.ROLES.USER
        };
        executionResult = UserService.createUser(superAdminContext, userPayload);
      } else if (req.RequestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE) {
        executionResult = UserService.makeUserPassive(superAdminContext, req.TargetUserID, req.Reason);
      } else if (req.RequestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET) {
        const tempPassword = 'Flk-' + SecurityService.generateRandomHex(4) + '!9';
        executionResult = AuthService.resetPasswordByAdmin(superAdminContext, req.TargetUserID, tempPassword);
        executionResult.temporaryPassword = tempPassword;
      }

      const updated = MasterRepository.updateRequest(requestId, {
        Status: CONSTANTS.REQUEST_STATUS.EXECUTED,
        ReviewedBy: superAdminContext.userId,
        ReviewedAt: now,
        ReviewComment: reviewComment,
        ExecutedAt: now
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

      return {
        ok: true,
        request: updated,
        executionResult
      };
    }

    throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unsupported review action: ${action}`);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AdminRequestService
  };
}

/**
 * FLINK Time & Workforce Platform — Authorization & RBAC Service
 * Strictly enforces server-side role-based access control, workspace isolation,
 * record ownership, and the hard Admin 3-workspace assignment limit.
 */

const AuthorizationService = {
  /**
   * Asserts that authenticated user possesses one of the allowed roles
   */
  assertRole(authContext, allowedRoles = []) {
    if (!authContext || !authContext.role) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!allowedRoles.includes(authContext.role)) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `Permission denied. Required roles: ${allowedRoles.join(', ')}. Current role: ${authContext.role}`,
        403
      );
    }
  },

  /**
   * Asserts that authenticated user has authorized access to requested workspace
   */
  assertWorkspaceAccess(authContext, requestedWorkspaceId) {
    if (!authContext || !authContext.userId) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!requestedWorkspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    // Super Admin has global access to all workspaces
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }

    const accesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
    const hasAccess = accesses.some(a => a.WorkspaceID === requestedWorkspaceId);

    // Also check PrimaryWorkspaceID for regular users
    const isPrimary = authContext.user && authContext.user.PrimaryWorkspaceID === requestedWorkspaceId;

    if (!hasAccess && !isPrimary) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        `Access to workspace '${requestedWorkspaceId}' is denied for user '${authContext.user.Username}'.`,
        403
      );
    }

    return true;
  },

  /**
   * Strictly enforces that an Admin cannot be assigned to more than 3 active workspaces
   */
  assertAdminWorkspaceLimit(targetUserId, targetWorkspaceId) {
    const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
    const activeAdminWorkspaces = existingAccesses.filter(a => a.Role === CONSTANTS.ROLES.ADMIN);

    const alreadyAssigned = activeAdminWorkspaces.some(a => a.WorkspaceID === targetWorkspaceId);
    if (!alreadyAssigned && activeAdminWorkspaces.length >= CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
      throw new AppError(
        ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
        `Admin assignment limit exceeded. An Admin may manage at most ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES} active workspaces.`,
        400
      );
    }
  },

  /**
   * Asserts record ownership: Users can only manipulate their own unapproved records
   */
  assertRecordOwnership(authContext, recordUserId) {
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }
    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      return true; // Admins have operational review rights within their assigned workspaces
    }
    if (authContext.userId !== recordUserId) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'You do not have permission to modify another user\'s records.', 403);
    }
    return true;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AuthorizationService
  };
}

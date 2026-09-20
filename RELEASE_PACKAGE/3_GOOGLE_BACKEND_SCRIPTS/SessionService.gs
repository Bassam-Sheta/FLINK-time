/**
 * FLINK Time & Workforce Platform — Session Service
 * Manages secure 256-bit token sessions with token hashing, idle & absolute timeouts,
 * and automatic revocation upon password changes or account suspension.
 */

const SessionService = {
  /**
   * Creates and registers a new authenticated session
   */
  createSession(userId, clientType = 'WEB') {
    const rawToken = SecurityService.generateSessionToken();
    const tokenHash = SecurityService.hashToken(rawToken);
    const now = new Date();
    const sessionId = Validation.generateId('SES');

    const idleTimeoutMs = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 3600 * 1000;
    const expiresAt = new Date(now.getTime() + idleTimeoutMs);

    const sessionRecord = {
      SessionID: sessionId,
      UserID: userId,
      TokenHash: tokenHash,
      ClientType: clientType,
      CreatedAt: now.toISOString(),
      LastSeenAt: now.toISOString(),
      ExpiresAt: expiresAt.toISOString(),
      Revoked: false,
      RevokedAt: ''
    };

    MasterRepository.createSession(sessionRecord);

    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt: expiresAt.toISOString()
    };
  },

  /**
   * Validates session token, checks timeouts, verifies user active status, and slides expiration
   */
  validateSession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication token required.', 401);
    }

    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHash(tokenHash);

    if (!session) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired session.', 401);
    }

    const now = Date.now();
    const expiresAt = new Date(session.ExpiresAt).getTime();
    const lastSeenAt = new Date(session.LastSeenAt).getTime();
    const createdAt = new Date(session.CreatedAt).getTime();

    // Check expiration and idle timeout
    const idleTimeoutMs = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 3600 * 1000;
    const absoluteTimeoutMs = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000;

    if (now > expiresAt || (now - lastSeenAt) > idleTimeoutMs || (now - createdAt) > absoluteTimeoutMs) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.SESSION_EXPIRED, 'Session has expired due to timeout. Please sign in again.', 401);
    }

    // Verify User Account status
    const user = MasterRepository.findAccountById(session.UserID);
    if (!user) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User account no longer exists.', 401);
    }

    if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Contact Super Admin.', 403);
    }

    if (user.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, 'Account is inactive or suspended.', 403);
    }

    // Slide expiration forward (capped at absolute timeout)
    const newExpiresMs = Math.min(now + idleTimeoutMs, createdAt + absoluteTimeoutMs);
    MasterRepository.updateSession(session.SessionID, {
      LastSeenAt: new Date().toISOString(),
      ExpiresAt: new Date(newExpiresMs).toISOString()
    });

    return {
      session,
      user,
      username: user.Username,
      role: user.Role,
      userId: user.UserID
    };
  },

  /**
   * Explicitly revokes a single session (e.g. on logout)
   */
  revokeSession(rawToken) {
    if (!rawToken) return;
    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHash(tokenHash);
    if (session) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
    }
  },

  /**
   * Revokes all active sessions for a user (e.g. password change, account passive)
   */
  revokeAllUserSessions(userId) {
    MasterRepository.revokeAllUserSessions(userId);
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SessionService
  };
}

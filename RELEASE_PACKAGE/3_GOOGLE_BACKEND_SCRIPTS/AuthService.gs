/**
 * FLINK Time & Workforce Platform — Authentication Service
 * Manages user authentication, lockout protection (5 attempts / 15 min),
 * password changes, administrative resets, and session issuance.
 */

const AuthService = {
  /**
   * Authenticates user with username and password
   */
  login(username, password, clientType = 'WEB') {
    if (!username || !password) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Username and password are required.', 401);
    }

    const cleanUsername = String(username).trim().toLowerCase();
    const account = MasterRepository.findAccountByUsername(cleanUsername);

    // Generic error to mitigate username enumeration
    const invalidAuthError = new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid username or password.', 401);

    if (!account) {
      MasterRepository.logSecurityEvent({
        Username: cleanUsername,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'User not found' }
      });
      throw invalidAuthError;
    }

    const cred = MasterRepository.getCredentials(account.UserID);
    if (!cred) {
      throw invalidAuthError;
    }

    const now = Date.now();

    // Check account lockout status
    if (account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED || (cred.LockUntil && new Date(cred.LockUntil).getTime() > now)) {
      const lockUntil = new Date(cred.LockUntil).getTime();
      if (now < lockUntil) {
        const remainingMinutes = Math.ceil((lockUntil - now) / 60000);
        throw new AppError(
          ERROR_CODES.ACCOUNT_LOCKED,
          `Account is locked due to multiple failed login attempts. Try again in ${remainingMinutes} minutes.`,
          403
        );
      } else {
        // Auto-unlock after timeout expires
        MasterRepository.updateAccount(account.UserID, { Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE });
        MasterRepository.updateCredentials(account.UserID, { FailedLoginCount: 0, LockUntil: '' });
      }
    }

    // Check passive/archived status
    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, 'This account is inactive or has been deactivated.', 403);
    }

    // Verify password hash
    const isValid = SecurityService.verifyPassword(password, cred.PasswordHash);

    if (!isValid) {
      const newFailedCount = (parseInt(cred.FailedLoginCount, 10) || 0) + 1;
      const updates = { FailedLoginCount: newFailedCount };

      if (newFailedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(now + CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000).toISOString();
        updates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, { Status: CONSTANTS.ACCOUNT_STATUS.LOCKED });

        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.ACCOUNT_LOCK,
          Success: false,
          metadata: { failedAttempts: newFailedCount, lockUntil }
        });
      }

      MasterRepository.updateCredentials(account.UserID, updates);

      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { failedAttempts: newFailedCount }
      });

      throw invalidAuthError;
    }

    // Login Successful: Reset failure counters & issue session
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LockUntil: ''
    });

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: { clientType }
    });

    // Check if user has MFA enabled
    if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
      const timestamp = Date.now();
      const sig = SecurityService.hashToken(`${account.UserID}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
      const mfaChallengeToken = `MFA_${account.UserID}_${timestamp}_${sig}`;
      return {
        mfaRequired: true,
        mfaChallengeToken,
        userId: account.UserID,
        clientType
      };
    }

    const sessionData = SessionService.createSession(account.UserID, clientType);

    // Get assigned workspaces
    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        primaryWorkspaceId: account.PrimaryWorkspaceID || assignedWorkspaces[0] || '',
        assignedWorkspaces: assignedWorkspaces,
        mustChangePassword: account.MustChangePassword === true || account.MustChangePassword === 'TRUE'
      }
    };
  },

  /**
   * Verifies RFC 6238 TOTP code during two-factor login challenge
   */
  verifyMfa(mfaChallengeToken, code, clientType = 'WEB') {
    if (!mfaChallengeToken || !code) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token and 6-digit code are required.', 401);
    }

    const parts = mfaChallengeToken.split('_');
    if (parts.length !== 4 || parts[0] !== 'MFA') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid MFA challenge token.', 401);
    }

    const [, userId, timestampStr, sig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Date.now();

    // 5-minute expiration
    if (isNaN(timestamp) || now - timestamp > 5 * 60 * 1000 || now < timestamp - 60 * 1000) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token has expired. Please log in again.', 401);
    }

    const expectedSig = SecurityService.hashToken(`${userId}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
    if (!SecurityService.constantTimeEquals(sig, expectedSig)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token signature invalid.', 401);
    }

    const account = MasterRepository.findAccountById(userId);
    const cred = MasterRepository.getCredentials(userId);
    if (!account || !cred || !cred.TotpSecret) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User credentials or MFA configuration not found.', 401);
    }

    const verification = SecurityService.verifyTotpWithStep(cred.TotpSecret, code);
    if (!verification.valid) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Invalid MFA TOTP code' }
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid two-factor authentication code.', 401);
    }

    // RFC 6238 §5.2 Replay Protection: reject previously validated timestep
    const currentStep = verification.timeStep;
    const lastStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (!isNaN(lastStep) && currentStep <= lastStep) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Replayed MFA TOTP code detected', step: currentStep, lastStep }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Two-factor authentication code has already been used. Please wait for the next 30-second token.',
        401
      );
    }

    // Reset failure counter on success & advance replay protection step
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LockUntil: '',
      LastSuccessfulTotpStep: currentStep
    });

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.MFA_VERIFIED,
      Success: true,
      metadata: { clientType, step: currentStep }
    });

    const sessionData = SessionService.createSession(account.UserID, clientType);
    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        primaryWorkspaceId: account.PrimaryWorkspaceID || assignedWorkspaces[0] || '',
        assignedWorkspaces: assignedWorkspaces,
        mustChangePassword: account.MustChangePassword === true || account.MustChangePassword === 'TRUE'
      }
    };
  },

  /**
   * Enrolls authenticated user in TOTP MFA
   */
  enrollMfa(authContext) {
    const rawSecret = SecurityService.generateTotpSecret();
    const encryptedSecret = SecurityService.encryptSecret(rawSecret);

    MasterRepository.updateCredentials(authContext.userId, {
      PendingTotpSecret: encryptedSecret
    });

    const uri = `otpauth://totp/FLINK:${authContext.user.username}?secret=${rawSecret}&issuer=FLINK`;
    return {
      secret: rawSecret,
      qrUri: uri,
      message: 'Scan the QR code or enter the secret in your authenticator app, then confirm with a 6-digit code.'
    };
  },

  /**
   * Confirms TOTP MFA enrollment
   */
  confirmMfa(authContext, code) {
    const cred = MasterRepository.getCredentials(authContext.userId);
    if (!cred || !cred.PendingTotpSecret) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'No pending MFA enrollment found. Call enrollMfa first.');
    }

    const verification = SecurityService.verifyTotpWithStep(cred.PendingTotpSecret, code);
    if (!verification.valid) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid verification code. Could not verify authenticator app.');
    }

    MasterRepository.updateCredentials(authContext.userId, {
      TotpSecret: cred.PendingTotpSecret,
      MfaEnabled: true,
      PendingTotpSecret: ''
    });

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'USER_SECURITY',
      EntityID: authContext.userId,
      Action: CONSTANTS.AUDIT_EVENTS.MFA_ENROLLED,
      Reason: 'TOTP Multi-factor authentication successfully enabled'
    });

    return { ok: true, message: 'Two-factor authentication successfully enabled.' };
  },

  /**
   * Disables MFA for a user (Super Admin only or user password confirmation)
   */
  disableMfa(superAdminContext, targetUserId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const targetAccount = MasterRepository.findAccountById(targetUserId);
    if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

    MasterRepository.updateCredentials(targetUserId, {
      TotpSecret: '',
      MfaEnabled: false,
      PendingTotpSecret: ''
    });

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      EntityType: 'USER_SECURITY',
      EntityID: targetUserId,
      Action: CONSTANTS.AUDIT_EVENTS.MFA_DISABLED,
      Reason: 'Two-factor authentication disabled by Super Admin'
    });

    return { ok: true, message: `MFA disabled for user ${targetAccount.Username}.` };
  },

  /**
   * Changes authenticated user's password
   */
  changePassword(sessionToken, oldPassword, newPassword) {
    const authContext = SessionService.validateSession(sessionToken);
    Validation.validatePassword(newPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, 'Credentials record not found.');

      const isOldValid = SecurityService.verifyPassword(oldPassword, cred.PasswordHash);
      if (!isOldValid) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Current password is incorrect.');
      }

      const newHash = SecurityService.hashPassword(newPassword);
      MasterRepository.updateCredentials(authContext.userId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(cred.PasswordVersion, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString()
      });

      MasterRepository.updateAccount(authContext.userId, {
        MustChangePassword: false,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: authContext.userId
      });

      // Invalidate all active sessions for security, and issue fresh session
      SessionService.revokeAllUserSessions(authContext.userId);
      const newSession = SessionService.createSession(authContext.userId, 'WEB');

      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.PASSWORD_CHANGED,
        Success: true
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        sessionToken: newSession.sessionToken,
        expiresAt: newSession.expiresAt
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin resets a user's password
   */
  resetPasswordByAdmin(superAdminContext, targetUserId, temporaryPassword) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.validatePassword(temporaryPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, 'Target account not found.');

      const targetCred = MasterRepository.getCredentials(targetUserId);
      const newHash = SecurityService.hashPassword(temporaryPassword);

      MasterRepository.updateCredentials(targetUserId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(targetCred ? targetCred.PasswordVersion : 0, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        FailedLoginCount: 0,
        LockUntil: ''
      });

      MasterRepository.updateAccount(targetUserId, {
        MustChangePassword: true,
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Immediately revoke all existing sessions for target user
      SessionService.revokeAllUserSessions(targetUserId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.PASSWORD_RESET,
        Reason: 'Administrative password reset'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        message: `Password reset successfully for user ${targetAccount.Username}. User will be forced to change password on next login.`
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Logout user and revoke session
   */
  logout(sessionToken) {
    SessionService.revokeSession(sessionToken);
    return { ok: true };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    AuthService
  };
}

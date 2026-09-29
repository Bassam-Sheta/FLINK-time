/**
 * FLINK Time & Workforce Platform — Authentication Service
 * Manages user authentication, lockout protection (5 attempts / 15 min),
 * password changes, administrative resets, and session issuance.
 */

const AuthService = {
  _mfaChallengeMemory: {},

  _mfaChallengePropertyKey(userId) {
    return 'FLINK_MFA_CHALLENGE_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaChallenge(userId, challengeToken, expiresAtMs, googleEmail = '') {
    const record = JSON.stringify({
      tokenHash: SecurityService.hashToken(challengeToken),
      expiresAtMs: Number(expiresAtMs),
      googleEmail: IdentityService.normalizeEmail(googleEmail)
    });

    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .setProperty(this._mfaChallengePropertyKey(userId), record);
      return;
    }

    // Local/unit-test fallback only.
    this._mfaChallengeMemory[userId] = record;
  },

  _getMfaChallenge(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService
        .getScriptProperties()
        .getProperty(this._mfaChallengePropertyKey(userId)) || '';
    } else {
      raw = this._mfaChallengeMemory[userId] || '';
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  _deleteMfaChallenge(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .deleteProperty(this._mfaChallengePropertyKey(userId));
    } else {
      delete this._mfaChallengeMemory[userId];
    }
  },

  /**
   * Authenticates user with username and password
   */
  login(username, password, clientType = 'WEB') {
    const invalidAuth = () => new AppError(
      ERROR_CODES.AUTH_REQUIRED,
      'Invalid username or password.',
      401
    );

    if (!username || !password) {
      throw invalidAuth();
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    const cleanUsername = String(username).trim().toLowerCase();

    // WEB authentication is always bound to the server-observed Google account.
    // This is deliberately resolved before FLINK credential validation so the
    // browser cannot self-assert an email in the request body.
    let googleEmail = '';
    if (normalizedClientType === 'WEB' || normalizedClientType === 'SETUP_WIZARD') {
      googleEmail = IdentityService.getCurrentGoogleEmail(true);
    }

    const account = MasterRepository.findAccountByUsername(cleanUsername);
    if (!account) {
      MasterRepository.logSecurityEvent({
        Username: cleanUsername,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'User not found',
          googleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      ) || googleEmail;
    } catch (identityErr) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity mismatch',
          observedGoogleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    const cred = MasterRepository.getCredentials(account.UserID);
    if (!cred) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Credentials row missing' }
      });
      throw invalidAuth();
    }

    const now = Date.now();
    const lockUntilMs = cred.LockUntil
      ? new Date(cred.LockUntil).getTime()
      : NaN;

    // A timed lock can auto-expire. A LOCKED account without a valid LockUntil
    // is treated as an administrative lock and never auto-unlocks here.
    if (
      Number.isFinite(lockUntilMs) &&
      lockUntilMs <= now &&
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
    ) {
      MasterRepository.updateAccount(account.UserID, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE
      });
      MasterRepository.updateCredentials(account.UserID, {
        FailedLoginCount: 0,
        LastFailedAt: '',
        LockUntil: ''
      });
      account.Status = CONSTANTS.ACCOUNT_STATUS.ACTIVE;
      cred.FailedLoginCount = 0;
      cred.LastFailedAt = '';
      cred.LockUntil = '';
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (Number.isFinite(lockUntilMs) && lockUntilMs > now)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Attempt while account locked',
          lockUntil: cred.LockUntil || ''
        }
      });
      throw invalidAuth();
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Inactive account',
          accountStatus: account.Status
        }
      });
      throw invalidAuth();
    }

    // Graduated retry throttle after failed password attempts. No sleep is used;
    // Apps Script execution time is preserved and the caller must retry later.
    const failedCount = parseInt(cred.FailedLoginCount, 10) || 0;
    const retrySchedule = Array.isArray(CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS)
      ? CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS
      : [0, 2, 5, 15, 30];
    const delaySeconds = retrySchedule[
      Math.min(failedCount, retrySchedule.length - 1)
    ] || 0;
    const lastFailedMs = cred.LastFailedAt
      ? new Date(cred.LastFailedAt).getTime()
      : NaN;

    if (
      failedCount > 0 &&
      delaySeconds > 0 &&
      Number.isFinite(lastFailedMs) &&
      now < lastFailedMs + delaySeconds * 1000
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_THROTTLED,
        Success: false,
        metadata: {
          failedAttempts: failedCount,
          delaySeconds,
          retryAfterMs: Math.max(
            0,
            lastFailedMs + delaySeconds * 1000 - now
          )
        }
      });
      throw invalidAuth();
    }

    const isValid = SecurityService.verifyPassword(
      password,
      cred.PasswordHash
    );

    if (!isValid) {
      const newFailedCount = failedCount + 1;
      const failedAt = new Date(now).toISOString();
      const updates = {
        FailedLoginCount: newFailedCount,
        LastFailedAt: failedAt
      };

      if (newFailedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now +
          CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        updates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });

        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.ACCOUNT_LOCK,
          Success: false,
          metadata: {
            failedAttempts: newFailedCount,
            lockUntil
          }
        });
      }

      MasterRepository.updateCredentials(account.UserID, updates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Invalid password',
          failedAttempts: newFailedCount
        }
      });

      throw invalidAuth();
    }

    // Password-stage failures are cleared only after a valid password.
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
      const timestamp = Date.now();
      const sig = SecurityService
        .hashToken(
          `${account.UserID}|${timestamp}|${SecurityService.getPepper()}`
        )
        .substring(0, 16);
      const mfaChallengeToken =
        `MFA_${account.UserID}_${timestamp}_${sig}`;
      this._storeMfaChallenge(
        account.UserID,
        mfaChallengeToken,
        timestamp + 5 * 60 * 1000,
        googleEmail
      );

      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: 'MFA_CHALLENGE_ISSUED',
        Success: true,
        metadata: {
          clientType: normalizedClientType,
          googleIdentity: googleEmail || ''
        }
      });

      return {
        mfaRequired: true,
        mfaChallengeToken,
        userId: account.UserID,
        clientType: normalizedClientType
      };
    }

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: false,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );

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
        email: account.Email || '',
        primaryWorkspaceId:
          account.PrimaryWorkspaceID ||
          assignedWorkspaces[0] ||
          '',
        assignedWorkspaces,
        mustChangePassword:
          account.MustChangePassword === true ||
          account.MustChangePassword === 'TRUE'
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

    const storedChallenge = this._getMfaChallenge(userId);
    const suppliedChallengeHash = SecurityService.hashToken(mfaChallengeToken);
    if (
      !storedChallenge ||
      !storedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(storedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(storedChallenge.expiresAtMs || 0) < now
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const mfaLock = LockService.getScriptLock();
    mfaLock.waitLock(10000);
    try {
    // Re-check the one-time challenge after entering the critical section.
    // Another concurrent request may have consumed it after our pre-lock check.
    const lockedChallenge = this._getMfaChallenge(userId);
    if (
      !lockedChallenge ||
      !lockedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(lockedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(lockedChallenge.expiresAtMs || 0) < Date.now()
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const account = MasterRepository.findAccountById(userId);
    const cred = MasterRepository.getCredentials(userId);
    if (!account || !cred || !cred.TotpSecret) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User credentials or MFA configuration not found.', 401);
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (cred.LockUntil && new Date(cred.LockUntil).getTime() > now)
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', 403);
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.ACCOUNT_PASSIVE,
        'This account is inactive or has been deactivated.',
        403
      );
    }

    const verification = SecurityService.verifyTotpWithStep(cred.TotpSecret, code);
    if (!verification.valid) {
      const failedCount = (parseInt(cred.FailedLoginCount, 10) || 0) + 1;
      const credUpdates = { FailedLoginCount: failedCount };

      if (failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now + CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        credUpdates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });
      }

      MasterRepository.updateCredentials(account.UserID, credUpdates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Invalid MFA TOTP code', failedAttempts: failedCount }
      });
      throw new AppError(
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? ERROR_CODES.ACCOUNT_LOCKED : ERROR_CODES.AUTH_REQUIRED,
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS
          ? 'Account locked after repeated invalid two-factor codes.'
          : 'Invalid two-factor authentication code.',
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? 403 : 401
      );
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

    // Consume the server-side challenge before minting a session. A later TOTP
    // cannot reuse the same 5-minute challenge to create another session.
    this._deleteMfaChallenge(userId);

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
    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: { clientType, mfa: true }
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
    } finally {
      mfaLock.releaseLock();
    }
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
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
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
        PendingTotpSecret: '',
        // Treat the enrollment code as consumed so it cannot immediately be
        // replayed as the first login MFA code in the same 30-second step.
        LastSuccessfulTotpStep: verification.timeStep
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
    } finally {
      lock.releaseLock();
    }
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
      PendingTotpSecret: '',
      LastSuccessfulTotpStep: ''
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
      if (SecurityService.verifyPassword(newPassword, cred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'New password must be different from the current password.',
          400
        );
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

      // Invalidate all active sessions and any outstanding MFA login challenge.
      SessionService.revokeAllUserSessions(authContext.userId);
      this._deleteMfaChallenge(authContext.userId);
      const replacementClientType =
        authContext.session && authContext.session.ClientType
          ? authContext.session.ClientType
          : 'WEB';
      const newSession = SessionService.createSession(
        authContext.userId,
        replacementClientType
      );

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
      if (
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.ARCHIVED ||
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.DELETED
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Archived or deleted accounts cannot receive a password reset.',
          409
        );
      }

      const targetCred = MasterRepository.getCredentials(targetUserId);
      if (!targetCred) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Target credentials record not found.');
      }
      if (SecurityService.verifyPassword(temporaryPassword, targetCred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Temporary password must be different from the user\'s current password.',
          400
        );
      }
      const newHash = SecurityService.hashPassword(temporaryPassword);
      const nextStatus =
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
          ? CONSTANTS.ACCOUNT_STATUS.ACTIVE
          : targetAccount.Status;

      MasterRepository.updateCredentials(targetUserId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(targetCred ? targetCred.PasswordVersion : 0, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        FailedLoginCount: 0,
        LockUntil: ''
      });

      MasterRepository.updateAccount(targetUserId, {
        MustChangePassword: true,
        Status: nextStatus,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Password reset never serves as a PASSIVE-account activation path.
      // It also invalidates sessions and any outstanding MFA challenge.
      SessionService.revokeAllUserSessions(targetUserId);
      this._deleteMfaChallenge(targetUserId);

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

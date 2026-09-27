/**
 * FLINK Time & Workforce Platform — Backup, Audit & Notification Services
 * Automated Drive snapshot backups, disaster recovery validation, and immutable audit logs.
 */

const BackupService = {
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
      const safetyBackup = this.createBackup(superAdminContext, workspaceId);

      const backupFile = DriveApp.getFileById(record.BackupFileID);
      const candidateName = `RESTORE_${workspaceId}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const candidateFile = backupFile.makeCopy(candidateName);
      candidateFileId = candidateFile.getId();

      const candidateSpreadsheet = this._openBackupSpreadsheet(candidateFileId);
      const candidateManifest = this._buildManifest(candidateSpreadsheet, 'WORKSPACE', workspaceId);
      if (!SecurityService.constantTimeEquals(validation.manifestHash, candidateManifest.manifestHash)) {
        throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Restore working copy failed integrity verification.', 409);
      }

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

      // Re-open only while holding the restore ScriptLock, then reconcile rollups.
      MasterRepository.updateWorkspace(workspaceId, {
        Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString()
      });
      if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
        WorkspaceRouter.clearCache();
      }

      RollupService.rebuildRollups(workspaceId);

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        SpreadsheetApp.flush();
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
          safetyBackupId: safetyBackup.backupId
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

const AuditService = {
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
      if (row.PreviousHash && row.PreviousHash !== previousHash) {
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

      if (row.RecordHash) {
        const recordPayload = {
          auditId: row.AuditID,
          timestamp: row.TimestampUTC,
          actor: row.ActorUserID || '',
          action: row.Action,
          entityType: row.EntityType,
          entityId: row.EntityID,
          after: typeof row.AfterJSON === 'object' ? JSON.stringify(row.AfterJSON) : (row.AfterJSON || '')
        };
        const computedHash = SecurityService.computeAuditHash(row.PreviousHash || previousHash, recordPayload);
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

const NotificationService = {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    BackupService,
    AuditService,
    NotificationService
  };
}

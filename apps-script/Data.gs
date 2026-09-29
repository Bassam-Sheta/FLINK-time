/** FLINK Time — Consolidated Drive, repository, workspace routing/lifecycle, and timezone data services. */


/* ===== DriveManager.gs ===== */
/**
 * Ultra-Account: Super Admin Master Google Drive Vault Manager
 * ALL screenshots are stored EXCLUSIVELY in the Super Admin's Google Drive storage.
 * Employee personal Google Drive accounts are NEVER used or touched.
 * 
 * Strict Master Vault Hierarchy:
 * /UltraAccount_Master_Vault/
 *    ├── [Workspace_Name]/
 *    │     └── [User_Email]/
 *    │           └── [YYYY-MM-DD]/
 *    │                 ├── sc_20260917_120530_ent123.jpg
 *    │                 └── sc_20260917_121030_ent123.jpg
 */

const MASTER_VAULT_ROOT = "UltraAccount_Master_Vault";

/**
 * Stores a screenshot directly into the Super Admin's Google Drive.
 * Executed under the Super Admin's identity via Apps Script Web App (executeAs: USER_DEPLOYING).
 * 
 * @param {string} workspaceName Name of assigned workspace (e.g. "Engineering Core")
 * @param {string} userEmail Email of employee (e.g. "developer@gmail.com")
 * @param {string} dateStr Format "YYYY-MM-DD"
 * @param {string} screenshotId Unique ID (e.g. "sc_a8f9c12e")
 * @param {string} base64ImageBytes Base64 JPEG/WebP image string
 * @returns {object} file_id and view URL in Super Admin's Drive
 */
function saveScreenshotToMasterVault(workspaceName, userEmail, dateStr, screenshotId, base64ImageBytes) {
  try {
    const rootFolder = getOrCreateMasterVault();
    
    // 1. Workspace Folder: /UltraAccount_Master_Vault/{Workspace_Name}
    const sanitizedWs = (workspaceName || 'Default_Workspace').replace(/[^a-zA-Z0-9_ -]/g, '_');
    const wsFolder = getOrCreateSubFolder(rootFolder, sanitizedWs);
    
    // 2. User Folder: /UltraAccount_Master_Vault/{Workspace_Name}/{User_Email}
    const sanitizedUser = (userEmail || 'unassigned_user').replace(/[^a-zA-Z0-9@._-]/g, '_');
    const userFolder = getOrCreateSubFolder(wsFolder, sanitizedUser);
    
    // 3. Date Folder: /UltraAccount_Master_Vault/{Workspace_Name}/{User_Email}/{YYYY-MM-DD}
    const dateFolder = getOrCreateSubFolder(userFolder, dateStr);
    
    // 4. Save file into Super Admin's Drive
    const cleanBase64 = base64ImageBytes.replace(/^data:image\/(jpeg|png|webp);base64,/, '');
    const decodedBytes = Utilities.base64Decode(cleanBase64);
    const blob = Utilities.newBlob(decodedBytes, 'image/jpeg', screenshotId + '.jpg');
    
    const file = dateFolder.createFile(blob);
    file.setDescription('Ultra-Account monitored screenshot. Workspace: ' + workspaceName + ' | User: ' + userEmail);

    return {
      status: 'SUCCESS',
      file_id: file.getId(),
      file_url: file.getUrl(),
      size_bytes: file.getSize(),
      vault_path: MASTER_VAULT_ROOT + '/' + sanitizedWs + '/' + sanitizedUser + '/' + dateStr + '/' + screenshotId + '.jpg'
    };
  } catch (err) {
    Logger.log('Failed to save to master vault: ' + err.toString());
    throw new Error('Master Drive Vault Error: ' + err.toString());
  }
}

function getOrCreateMasterVault() {
  const folders = DriveApp.getFoldersByName(MASTER_VAULT_ROOT);
  if (folders.hasNext()) return folders.next();
  const folder = DriveApp.createFolder(MASTER_VAULT_ROOT);
  folder.setDescription('Ultra-Account Super Admin Master Vault (All workspaces & screenshots)');
  return folder;
}

function getOrCreateSubFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(name);
}

/**
 * Scheduled cleanup trigger: moves archive folders older than retention period to Trash
 */
function runMasterVaultRetention(retentionDays) {
  const days = retentionDays || 90;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoffStr = Utilities.formatDate(cutoffDate, 'GMT', 'yyyy-MM-dd');

  Logger.log('Running Master Vault Retention for dates prior to: ' + cutoffStr);
  const root = getOrCreateMasterVault();
  const wsFolders = root.getFolders();

  while (wsFolders.hasNext()) {
    const ws = wsFolders.next();
    const userFolders = ws.getFolders();
    while (userFolders.hasNext()) {
      const uFolder = userFolders.next();
      const dateFolders = uFolder.getFolders();
      while (dateFolders.hasNext()) {
        const dFolder = dateFolders.next();
        if (/^\d{4}-\d{2}-\d{2}$/.test(dFolder.getName()) && dFolder.getName() < cutoffStr) {
          dFolder.setTrashed(true);
        }
      }
    }
  }
}

/* ===== MasterRepository.gs ===== */
/**
 * FLINK Time & Workforce Platform — Master Control Sheet Repository
 * Encapsulates all read/write operations for the Master Control Sheet.
 * Employs batch reads, header indexing, and sanitization defense.
 */

var MasterRepository = (typeof global !== 'undefined' && global.MasterRepository) || {
  spreadsheetId: null,
  _requestCache: {},

  beginRequest() {
    this._requestCache = {};
  },

  _invalidateTable(tabName) {
    delete this._requestCache[tabName];
  },

  /**
   * Resolves Master Spreadsheet. If spreadsheetId is not set, tries ScriptProperties or getActiveSpreadsheet()
   */
  getMasterSpreadsheet() {
    if (this.spreadsheetId && typeof SpreadsheetApp !== 'undefined') {
      return SpreadsheetApp.openById(this.spreadsheetId);
    }
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const id = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
      if (id && typeof SpreadsheetApp !== 'undefined') {
        this.spreadsheetId = id;
        return SpreadsheetApp.openById(id);
      }
    }
    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet) {
      const active = SpreadsheetApp.getActiveSpreadsheet();
      if (active) return active;
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Master Spreadsheet could not be resolved.');
  },

  /**
   * Helper to retrieve a tab and all rows as array of objects
   */
  getTableData(tabName) {
    if (this._requestCache[tabName]) {
      return this._requestCache[tabName];
    }

    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length <= 1) {
      const empty = { headers: values[0] || [], rows: [], sheet };
      this._requestCache[tabName] = empty;
      return empty;
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const rowObj = { _rowIndex: r + 1 };
      for (let col = 0; col < headers.length; col++) {
        rowObj[headers[col]] = values[r][col];
      }
      rows.push(rowObj);
    }

    const result = { headers, rows, sheet };
    this._requestCache[tabName] = result;
    return result;
  },

  /**
   * Appends an entity row to a master tab
   */
  appendRow(tabName, entity) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }

    const rowData = schemaHeaders.map(col => {
      const val = entity[col] !== undefined ? entity[col] : '';
      return Validation.sanitizeCellValue(val);
    });

    sheet.appendRow(rowData);
    this._invalidateTable(tabName);
    return entity;
  },

  deleteRow(tabName, rowIndex) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    sheet.deleteRow(rowIndex);
    this._invalidateTable(tabName);
  },

  /**
   * Updates specific columns for a row index in a master tab
   */
  updateRow(tabName, rowIndex, updates) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    const changes = Object.entries(updates)
      .map(([colName, val]) => ({
        colIdx: headers.indexOf(colName),
        value: Validation.sanitizeCellValue(val)
      }))
      .filter(change => change.colIdx >= 0)
      .sort((a, b) => a.colIdx - b.colIdx);

    // Batch adjacent changed columns into the smallest possible setValues calls.
    // This reduces Sheets service round-trips without overwriting unrelated columns.
    for (let i = 0; i < changes.length;) {
      const group = [changes[i]];
      let j = i + 1;
      while (
        j < changes.length &&
        changes[j].colIdx === group[group.length - 1].colIdx + 1
      ) {
        group.push(changes[j]);
        j++;
      }

      sheet
        .getRange(rowIndex, group[0].colIdx + 1, 1, group.length)
        .setValues([group.map(change => change.value)]);
      i = j;
    }

    this._invalidateTable(tabName);
  },

  /* ------------------- ACCOUNTS & CREDENTIALS ------------------- */

  findAccountByUsername(username) {
    const cleanUsername = String(username).trim().toLowerCase();
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    return rows.find(r => String(r.Username).trim().toLowerCase() === cleanUsername) || null;
  },

  findAccountById(userId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    return rows.find(r => r.UserID === userId) || null;
  },

  createAccount(accountData, credentialData) {
    if (!accountData || !accountData.UserID || !credentialData || credentialData.UserID !== accountData.UserID) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Account and credential records with the same UserID are required.',
        400
      );
    }

    let accountCreated = false;
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.ACCOUNTS, accountData);
      accountCreated = true;
      this.appendRow(CONSTANTS.MASTER_TABS.CREDENTIALS, credentialData);
      return accountData;
    } catch (err) {
      if (accountCreated) {
        try {
          const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
          const created = rows.find(row => row.UserID === accountData.UserID);
          if (created) this.deleteRow(CONSTANTS.MASTER_TABS.ACCOUNTS, created._rowIndex);
        } catch (rollbackErr) {
          console.error(
            `Account creation rollback failed for ${accountData.UserID}: ${rollbackErr.message}`
          );
        }
      }
      throw err;
    }
  },

  /**
   * Hard rollback helper for a user that failed during initial provisioning.
   * This is intentionally for creation rollback only, not normal user deletion.
   */
  rollbackUserCreation(userId) {
    const deleteMatches = (tabName, predicate) => {
      const { rows } = this.getTableData(tabName);
      rows
        .filter(predicate)
        .sort((a, b) => b._rowIndex - a._rowIndex)
        .forEach(row => this.deleteRow(tabName, row._rowIndex));
    };

    deleteMatches(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.CREDENTIALS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      row => row.UserID === userId
    );
  },

  updateAccount(userId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    const acc = rows.find(r => r.UserID === userId);
    if (!acc) throw new AppError(ERROR_CODES.NOT_FOUND, `Account ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, acc._rowIndex, updates);
    return { ...acc, ...updates };
  },

  getCredentials(userId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS);
    return rows.find(r => r.UserID === userId) || null;
  },

  updateCredentials(userId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS);
    const cred = rows.find(r => r.UserID === userId);
    if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, `Credentials for ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.CREDENTIALS, cred._rowIndex, updates);
    return { ...cred, ...updates };
  },

  /* ------------------- WORKSPACES & ACCESS ------------------- */

  listWorkspaces() {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    return rows;
  },

  getWorkspace(workspaceId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    return rows.find(r => r.WorkspaceID === workspaceId) || null;
  },

  createWorkspace(workspaceData) {
    this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACES, workspaceData);
    return workspaceData;
  },

  updateWorkspace(workspaceId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = rows.find(r => r.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, updates);

    // Workspace status and physical-pointer changes must invalidate the router's
    // warm execution cache immediately; otherwise a previously cached ACTIVE
    // spreadsheet could remain reachable after MAINTENANCE/ARCHIVE transitions.
    if (
      updates &&
      (Object.prototype.hasOwnProperty.call(updates, 'Status') ||
       Object.prototype.hasOwnProperty.call(updates, 'SpreadsheetID')) &&
      typeof WorkspaceRouter !== 'undefined' &&
      WorkspaceRouter.clearCache
    ) {
      WorkspaceRouter.clearCache();
    }

    return { ...ws, ...updates };
  },

  getWorkspaceAccessForUser(userId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    return rows.filter(r => r.UserID === userId && (r.Active === true || r.Active === 'TRUE' || r.Active === 1));
  },

  getWorkspaceAccessForWorkspace(workspaceId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    return rows.filter(r => r.WorkspaceID === workspaceId && (r.Active === true || r.Active === 'TRUE' || r.Active === 1));
  },

  countActiveAdminWorkspaces(userId) {
    const accesses = this.getWorkspaceAccessForUser(userId);
    return accesses.filter(a => a.Role === CONSTANTS.ROLES.ADMIN).length;
  },

  assignWorkspaceAccess(accessData) {
    // Check if mapping already exists
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    const existing = rows.find(r => r.UserID === accessData.UserID && r.WorkspaceID === accessData.WorkspaceID);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Role: accessData.Role,
        Active: true,
        AssignedAt: accessData.AssignedAt || new Date().toISOString(),
        AssignedBy: accessData.AssignedBy || ''
      });
      return { ...existing, ...accessData, Active: true };
    }
    return this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, accessData);
  },

  syncWorkspaceAccessRole(userId, role) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    rows
      .filter(r => r.UserID === userId && (r.Active === true || r.Active === 'TRUE' || r.Active === 1))
      .forEach(r => this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, r._rowIndex, { Role: role }));
  },

  removeWorkspaceAccess(userId, workspaceId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    const existing = rows.find(r => r.UserID === userId && r.WorkspaceID === workspaceId);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Active: false
      });
    }

    // PrimaryWorkspaceID is only a UI/default-selection hint. Keep it synchronized
    // so revoked workspaces are not shown as the user's default workspace.
    const account = this.findAccountById(userId);
    if (account && account.PrimaryWorkspaceID === workspaceId) {
      const replacement = rows.find(r =>
        r.UserID === userId &&
        r.WorkspaceID !== workspaceId &&
        (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
      );
      this.updateAccount(userId, {
        PrimaryWorkspaceID: replacement ? replacement.WorkspaceID : '',
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: 'SYSTEM'
      });
    }
  },

  /* ------------------- SESSIONS ------------------- */

  createSession(sessionData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.SESSIONS, sessionData);
  },

  findSessionByTokenHash(tokenHash) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
    return rows.find(r => r.TokenHash === tokenHash && (r.Revoked === false || r.Revoked === 'FALSE' || r.Revoked === 0 || !r.Revoked)) || null;
  },

  updateSession(sessionId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
    const s = rows.find(r => r.SessionID === sessionId);
    if (s) {
      this.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, updates);
    }
  },

  revokeAllUserSessions(userId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
    const now = new Date().toISOString();
    rows.filter(r => r.UserID === userId && (r.Revoked === false || r.Revoked === 'FALSE' || !r.Revoked)).forEach(s => {
      this.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, {
        Revoked: true,
        RevokedAt: now
      });
    });
  },

  /* ------------------- REQUESTS ------------------- */

  createRequest(requestData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.REQUESTS, requestData);
  },

  getRequest(requestId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.find(r => r.RequestID === requestId) || null;
  },

  listRequests(statusFilter = null, workspaceId = null) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.filter(r => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (workspaceId && r.WorkspaceID !== workspaceId) return false;
      return true;
    });
  },

  updateRequest(requestId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    const req = rows.find(r => r.RequestID === requestId);
    if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.REQUESTS, req._rowIndex, updates);
    return { ...req, ...updates };
  },

  /* ------------------- AUDIT & SECURITY EVENTS ------------------- */

  logSecurityEvent(eventData) {
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.SECURITY_EVENTS, {
        EventID: Validation.generateId('SEC'),
        Timestamp: new Date().toISOString(),
        UserID: eventData.UserID || '',
        Username: eventData.Username || '',
        EventType: eventData.EventType,
        Success: eventData.Success ? true : false,
        MetadataJSON: eventData.MetadataJSON || (eventData.metadata ? JSON.stringify(eventData.metadata) : '')
      });
    } catch (e) {
      // Do not crash primary execution on audit write failure
      console.error('Failed to write security event: ' + e.message);
    }
  },

  logGlobalAudit(auditData) {
    try {
      const auditId = Validation.generateId('AUD');
      const timestamp = new Date().toISOString();
      const beforeStr = typeof auditData.BeforeJSON === 'object' ? JSON.stringify(auditData.BeforeJSON) : (auditData.BeforeJSON || '');
      const afterStr = typeof auditData.AfterJSON === 'object' ? JSON.stringify(auditData.AfterJSON) : (auditData.AfterJSON || '');

      let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
      try {
        const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);
        if (rows.length > 0 && rows[rows.length - 1].RecordHash) {
          prevHash = rows[rows.length - 1].RecordHash;
        }
      } catch (err) {}

      const recordPayload = {
        auditId,
        timestamp,
        actor: auditData.ActorUserID || '',
        action: auditData.Action,
        entityType: auditData.EntityType,
        entityId: auditData.EntityID,
        after: afterStr
      };
      const recordHash = SecurityService.computeAuditHash(prevHash, recordPayload);

      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT, {
        AuditID: auditId,
        TimestampUTC: timestamp,
        ActorUserID: auditData.ActorUserID || '',
        ActorRole: auditData.ActorRole || '',
        WorkspaceID: auditData.WorkspaceID || '',
        EntityType: auditData.EntityType,
        EntityID: auditData.EntityID,
        Action: auditData.Action,
        BeforeJSON: beforeStr,
        AfterJSON: afterStr,
        Reason: auditData.Reason || '',
        CorrelationID: auditData.CorrelationID || '',
        ClientType: auditData.ClientType || 'WEB',
        PreviousHash: prevHash,
        RecordHash: recordHash
      });
    } catch (e) {
      console.error('Failed to write global audit: ' + e.message);
    }
  },

  /* ------------------- GLOBAL SETTINGS ------------------- */

  getAllGlobalSettings() {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const settings = {};
      for (const r of rows) {
        if (r.SettingKey) {
          settings[r.SettingKey] = r.SettingValue;
        }
      }
      return settings;
    } catch (e) {
      return {};
    }
  },

  getGlobalSetting(key, defaultValue = '') {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const row = rows.find(r => r.SettingKey === key);
      return row ? row.SettingValue : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  },

  setGlobalSetting(key, value, updatedBy = 'SYSTEM', description = '') {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const existing = rows.find(r => r.SettingKey === key);
    const now = new Date().toISOString();
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, existing._rowIndex, {
        SettingValue: String(value),
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    } else {
      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, {
        SettingKey: key,
        SettingValue: String(value),
        Description: description,
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    }
  },

  /* ------------------- SECURITY & ACCOUNT MANAGEMENT ------------------- */

  unlockAccount(userId) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const user = this.findAccountById(userId);
      if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${userId} not found.`);

      if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
        this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, user._rowIndex, {
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          UpdatedAt: new Date().toISOString(),
          UpdatedBy: 'SUPER_ADMIN'
        });
      }

      const { rows: credRows } = this.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS);
      const cred = credRows.find(c => c.UserID === userId);
      if (cred) {
        this.updateRow(CONSTANTS.MASTER_TABS.CREDENTIALS, cred._rowIndex, {
          FailedLoginCount: 0,
          LockUntil: ''
        });
      }

      this.logSecurityEvent({
        UserID: userId,
        Username: user.Username,
        EventType: 'ACCOUNT_UNLOCKED',
        Success: true,
        metadata: { unlockedBy: 'SUPER_ADMIN' }
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Account for ${user.Username} unlocked.` };
    } finally {
      lock.releaseLock();
    }
  },

  listActiveSessions() {
    try {
      const { rows: sessionRows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const { rows: accountRows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const userMap = {};
      accountRows.forEach(a => { userMap[a.UserID] = a; });

      const now = Date.now();
      return sessionRows
        .filter(s => !s.Revoked && new Date(s.ExpiresAt).getTime() > now)
        .map(s => {
          const user = userMap[s.UserID] || {};
          return {
            sessionId: s.SessionID,
            userId: s.UserID,
            username: user.Username || 'Unknown',
            displayName: user.DisplayName || 'Unknown',
            role: user.Role || 'USER',
            clientType: s.ClientType || 'WEB',
            createdAt: s.CreatedAt,
            lastSeenAt: s.LastSeenAt,
            expiresAt: s.ExpiresAt
          };
        });
    } catch (e) {
      return [];
    }
  },

  deleteWorkspacePermanent(workspaceId) {
    const { rows: wsRows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = wsRows.find(w => w.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);

    // Archive / flag deleted in Master
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, {
      Status: CONSTANTS.WORKSPACE_STATUS.ARCHIVED,
      ArchivedAt: new Date().toISOString()
    });
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }

    return { ok: true, message: `Workspace ${workspaceId} permanently archived and unlinked.` };
  }
};

/* ===== SheetRepository.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Sheet Repository
 * Handles batch reads, writes, updates, and soft deletions across all 18 tabs
 * of an isolated Workspace Google Sheet.
 */

var SheetRepository = (typeof global !== 'undefined' && global.SheetRepository) || {
  _requestCache: {},

  beginRequest() {
    this._requestCache = {};
  },

  _cacheKey(workspaceId, tabName) {
    return String(workspaceId) + '::' + String(tabName);
  },

  _invalidateTable(workspaceId, tabName) {
    delete this._requestCache[this._cacheKey(workspaceId, tabName)];
  },

  clearTableCache(workspaceId, tabName) {
    this._invalidateTable(workspaceId, tabName);
  },

  /**
   * Helper to retrieve tab data from a specific workspace sheet
   */
  getTableData(workspaceId, tabName) {
    const cacheKey = this._cacheKey(workspaceId, tabName);
    if (this._requestCache[cacheKey]) {
      return this._requestCache[cacheKey];
    }

    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace tab '${tabName}' does not exist.`);
    }

    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) {
      const empty = { headers: values[0] || [], rows: [], sheet };
      this._requestCache[cacheKey] = empty;
      return empty;
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const obj = { _rowIndex: r + 1 };
      for (let col = 0; col < headers.length; col++) {
        obj[headers[col]] = values[r][col];
      }
      rows.push(obj);
    }

    const result = { headers, rows, sheet };
    this._requestCache[cacheKey] = result;
    return result;
  },

  /**
   * Appends an entity row to a workspace tab
   */
  appendRow(workspaceId, tabName, entity) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Tab '${tabName}' not found in workspace '${workspaceId}'.`, 404);
    }

    const schemaHeaders = WORKSPACE_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for workspace tab '${tabName}'.`);
    }

    const rowData = schemaHeaders.map(col => {
      const val = entity[col] !== undefined ? entity[col] : '';
      return Validation.sanitizeCellValue(val);
    });

    sheet.appendRow(rowData);
    this._invalidateTable(workspaceId, tabName);
    return entity;
  },

  /**
   * Updates specific columns for a row index in a workspace tab
   */
  updateRow(workspaceId, tabName, rowIndex, updates) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    const changes = Object.entries(updates)
      .map(([colName, val]) => ({
        colIdx: headers.indexOf(colName),
        value: Validation.sanitizeCellValue(val)
      }))
      .filter(change => change.colIdx >= 0)
      .sort((a, b) => a.colIdx - b.colIdx);

    for (let i = 0; i < changes.length;) {
      const group = [changes[i]];
      let j = i + 1;
      while (
        j < changes.length &&
        changes[j].colIdx === group[group.length - 1].colIdx + 1
      ) {
        group.push(changes[j]);
        j++;
      }

      sheet
        .getRange(rowIndex, group[0].colIdx + 1, 1, group.length)
        .setValues([group.map(change => change.value)]);
      i = j;
    }

    this._invalidateTable(workspaceId, tabName);
  },

  /**
   * Deletes a row by index (e.g. stopping an ActiveTimer)
   */
  deleteRow(workspaceId, tabName, rowIndex) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    sheet.deleteRow(rowIndex);
    this._invalidateTable(workspaceId, tabName);
  },

  /* ------------------- MEMBERS ------------------- */

  listMembers(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    return rows.filter(m => m.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
  },

  getMember(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    return rows.find(m => m.UserID === userId) || null;
  },

  addMember(workspaceId, memberData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS, memberData);
  },

  updateMember(workspaceId, userId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    const mem = rows.find(m => m.UserID === userId);
    if (mem) {
      this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS, mem._rowIndex, updates);
    }
  },

  /* ------------------- CLIENTS & PROJECTS & TASKS & TAGS ------------------- */

  listClients(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS);
    return rows;
  },

  getClient(workspaceId, clientId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS);
    return rows.find(client => client.ClientID === clientId) || null;
  },

  createClient(workspaceId, clientData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS, clientData);
  },

  listProjects(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    return rows;
  },

  getProject(workspaceId, projectId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    return rows.find(p => p.ProjectID === projectId) || null;
  },

  createProject(workspaceId, projectData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS, projectData);
  },

  updateProject(workspaceId, projectId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    const proj = rows.find(p => p.ProjectID === projectId);
    if (!proj) throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS, proj._rowIndex, updates);
    return { ...proj, ...updates };
  },

  listTasks(workspaceId, projectId = null) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS);
    if (projectId) return rows.filter(t => t.ProjectID === projectId);
    return rows;
  },

  getTask(workspaceId, taskId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS);
    return rows.find(t => t.TaskID === taskId) || null;
  },

  createTask(workspaceId, taskData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS, taskData);
  },

  listTags(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS);
    return rows;
  },

  getTag(workspaceId, tagId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS);
    return rows.find(t => t.TagID === tagId) || null;
  },

  listAllUserProjectAccess(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.USER_PROJECT_ACCESS);
    return rows;
  },

  listUserProjectAccess(workspaceId, userId) {
    return this.listAllUserProjectAccess(workspaceId)
      .filter(row => row.UserID === userId);
  },

  createTag(workspaceId, tagData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS, tagData);
  },

  /* ------------------- ACTIVE TIMERS ------------------- */

  getActiveTimer(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    return rows.find(t => t.UserID === userId) || null;
  },

  listActiveTimers(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    return rows;
  },

  createActiveTimer(workspaceId, timerData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS, timerData);
  },

  deleteActiveTimer(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    const timer = rows.find(t => t.UserID === userId);
    if (!timer) return false;
    this.deleteRow(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS, timer._rowIndex);
    return true;
  },

  /* ------------------- TIME ENTRIES ------------------- */

  listTimeEntries(workspaceId, filters = {}) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    return rows.filter(entry => {
      // Exclude soft-deleted
      if (entry.Status === 'DELETED') return false;
      if (filters.userId && entry.UserID !== filters.userId) return false;
      if (filters.projectId && entry.ProjectID !== filters.projectId) return false;
      if (filters.taskId && entry.TaskID !== filters.taskId) return false;
      if (filters.approvalStatus && entry.ApprovalStatus !== filters.approvalStatus) return false;

      if (filters.startDate) {
        const start = new Date(entry.StartUTC).getTime();
        const filterStart = new Date(filters.startDate).getTime();
        if (start < filterStart) return false;
      }
      if (filters.endDate) {
        const end = new Date(entry.EndUTC || entry.StartUTC).getTime();
        const filterEnd = new Date(filters.endDate).getTime();
        if (end > filterEnd) return false;
      }
      return true;
    });
  },

  getEntryAnyStatus(workspaceId, entryId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    return rows.find(e => e.EntryID === entryId) || null;
  },

  getEntry(workspaceId, entryId) {
    const entry = this.getEntryAnyStatus(workspaceId, entryId);
    return entry && entry.Status !== 'DELETED' ? entry : null;
  },

  createTimeEntry(workspaceId, entryData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES, entryData);
  },

  updateTimeEntry(workspaceId, entryId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    const entry = rows.find(e => e.EntryID === entryId);
    if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES, entry._rowIndex, updates);
    return { ...entry, ...updates };
  },

  /* ------------------- TIMESHEETS & APPROVALS ------------------- */

  listTimesheets(workspaceId, filters = {}) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS);
    return rows.filter(ts => {
      if (filters.userId && ts.UserID !== filters.userId) return false;
      if (filters.status && ts.Status !== filters.status) return false;
      return true;
    });
  },

  getTimesheet(workspaceId, timesheetId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS);
    return rows.find(ts => ts.TimesheetID === timesheetId) || null;
  },

  createTimesheet(workspaceId, tsData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, tsData);
  },

  updateTimesheet(workspaceId, timesheetId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS);
    const ts = rows.find(t => t.TimesheetID === timesheetId);
    if (!ts) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, ts._rowIndex, updates);
    return { ...ts, ...updates };
  },

  deleteTimesheet(workspaceId, timesheetId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS);
    const ts = rows.find(t => t.TimesheetID === timesheetId);
    if (!ts) return false;
    this.deleteRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, ts._rowIndex);
    return true;
  },

  logApproval(workspaceId, approvalData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.APPROVALS, approvalData);
  },

  /* ------------------- WORKSPACE AUDIT ------------------- */

  logWorkspaceAudit(workspaceId, auditData) {
    try {
      const auditId = Validation.generateId('WSAUD');
      const timestamp = new Date().toISOString();
      const beforeStr = typeof auditData.BeforeJSON === 'object' ? JSON.stringify(auditData.BeforeJSON) : (auditData.BeforeJSON || '');
      const afterStr = typeof auditData.AfterJSON === 'object' ? JSON.stringify(auditData.AfterJSON) : (auditData.AfterJSON || '');

      let prevHash = '0000000000000000000000000000000000000000000000000000000000000000';
      try {
        const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG);
        if (rows.length > 0 && rows[rows.length - 1].RecordHash) {
          prevHash = rows[rows.length - 1].RecordHash;
        }
      } catch (err) {}

      const recordPayload = {
        auditId,
        timestamp,
        actor: auditData.ActorUserID || '',
        action: auditData.Action,
        entityType: auditData.EntityType,
        entityId: auditData.EntityID,
        after: afterStr
      };
      const recordHash = SecurityService.computeAuditHash(prevHash, recordPayload);

      this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG, {
        AuditID: auditId,
        TimestampUTC: timestamp,
        ActorUserID: auditData.ActorUserID || '',
        ActorRole: auditData.ActorRole || '',
        EntityType: auditData.EntityType,
        EntityID: auditData.EntityID,
        Action: auditData.Action,
        BeforeJSON: beforeStr,
        AfterJSON: afterStr,
        Reason: auditData.Reason || '',
        ClientType: auditData.ClientType || 'WEB',
        PreviousHash: prevHash,
        RecordHash: recordHash
      });
    } catch (e) {
      console.error('Failed to log workspace audit: ' + e.message);
    }
  }
};

/* ===== WorkspaceRouter.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Router
 * Resolves logical workspace IDs to physical Google Spreadsheet instances
 * via the Master Control Sheet registry. Prevents raw Sheet ID manipulation.
 */

var WorkspaceRouter = (typeof global !== 'undefined' && global.WorkspaceRouter) || {
  // In-memory request cache for spreadsheet references
  cache: {},

  /**
   * Resolves physical Google Spreadsheet for a logical workspace ID
   */
  resolveSpreadsheet(workspaceId) {
    if (!workspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    if (this.cache[workspaceId]) {
      return this.cache[workspaceId];
    }

    const wsRecord = MasterRepository.getWorkspace(workspaceId);
    if (!wsRecord) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${workspaceId}' does not exist in registry.`, 404);
    }

    if (wsRecord.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
      const statusCode = wsRecord.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED ? 410 : 403;
      throw new AppError(
        wsRecord.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED ? ERROR_CODES.WORKSPACE_NOT_FOUND : ERROR_CODES.WORKSPACE_DENIED,
        `Workspace '${workspaceId}' is not active (${wsRecord.Status}).`,
        statusCode
      );
    }

    if (!wsRecord.SpreadsheetID) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Spreadsheet ID not registered for workspace '${workspaceId}'.`, 500);
    }

    if (typeof SpreadsheetApp === 'undefined') {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'SpreadsheetApp runtime is unavailable.');
    }

    const ss = SpreadsheetApp.openById(wsRecord.SpreadsheetID);
    this.cache[workspaceId] = ss;
    return ss;
  },

  /**
   * Clears in-memory router cache
   */
  clearCache() {
    this.cache = {};
  }
};

/* ===== WorkspaceService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Service
 * Manages workspace provisioning, automatic 18-tab schema generation,
 * and Admin assignments under the strict <= 3 workspace limit.
 */

var WorkspaceService = (typeof global !== 'undefined' && global.WorkspaceService) || {
  _toWorkspaceDTO(workspace, includePhysicalIds = false) {
    if (!workspace) return null;
    const dto = {
      WorkspaceID: workspace.WorkspaceID,
      WorkspaceCode: workspace.WorkspaceCode || '',
      WorkspaceName: workspace.WorkspaceName,
      Status: workspace.Status,
      Timezone: workspace.Timezone || 'UTC',
      SchemaVersion: workspace.SchemaVersion || CONSTANTS.SCHEMA_VERSION,
      CreatedAt: workspace.CreatedAt || ''
    };

    if (includePhysicalIds) {
      dto.SpreadsheetID = workspace.SpreadsheetID || '';
      dto.DriveFolderID = workspace.DriveFolderID || '';
      dto.CreatedBy = workspace.CreatedBy || '';
      dto.ArchivedAt = workspace.ArchivedAt || '';
      dto.PartitionPolicy = workspace.PartitionPolicy || '';
      dto.CurrentPartition = workspace.CurrentPartition || '';
      dto.Version = workspace.Version || 1;
    }

    return dto;
  },

  /**
   * Super Admin creates and provisions a new isolated workspace
   */
  createWorkspace(superAdminContext, workspacePayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(workspacePayload, ['name']);

    const workspaceName = workspacePayload.name.trim();
    const timezone = TimezoneService._assertValidTimezone(
      workspacePayload.timezone || 'UTC'
    );
    const workspaceId = Validation.generateId('WSP');

    let spreadsheetId = '';
    let driveFolderId = '';

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.create) {
      const newSpreadsheet = SpreadsheetApp.create(`FLINK Workspace — ${workspaceName}`);
      spreadsheetId = newSpreadsheet.getId();

      // Provision all 18 tabs
      const existingSheets = newSpreadsheet.getSheets();
      const defaultSheet = existingSheets[0];

      for (const [tabName, columns] of Object.entries(WORKSPACE_SCHEMA)) {
        let sheet = newSpreadsheet.getSheetByName(tabName);
        if (!sheet) {
          sheet = newSpreadsheet.insertSheet(tabName);
        }
        // Set header row
        sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
        sheet.setFrozenRows(1);
      }

      // Remove original default 'Sheet1' if it is not in schema
      if (defaultSheet && !WORKSPACE_SCHEMA[defaultSheet.getName()]) {
        try {
          newSpreadsheet.deleteSheet(defaultSheet);
        } catch (e) {
          // Ignore if cannot delete
        }
      }

      // Populate WorkspaceInfo row
      const infoSheet = newSpreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO);
      if (infoSheet) {
        const workspaceCode = workspacePayload.code
          ? Validation.sanitizeCellValue(String(workspacePayload.code).trim().toUpperCase())
          : Validation.sanitizeCellValue(workspaceId);
        infoSheet.appendRow([
          workspaceId,
          workspaceCode,
          Validation.sanitizeCellValue(workspaceName),
          CONSTANTS.WORKSPACE_STATUS.ACTIVE,
          timezone,
          CONSTANTS.SCHEMA_VERSION,
          new Date().toISOString()
        ]);
      }
    } else {
      // Mock environment fallback ID
      spreadsheetId = `mock_sheet_${workspaceId.toLowerCase()}`;
    }

    const record = {
      WorkspaceID: workspaceId,
      WorkspaceName: workspaceName,
      SpreadsheetID: spreadsheetId,
      DriveFolderID: driveFolderId,
      Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
      Timezone: timezone,
      CreatedAt: new Date().toISOString(),
      CreatedBy: superAdminContext.userId,
      ArchivedAt: ''
    };

    MasterRepository.createWorkspace(record);

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'WORKSPACE',
      EntityID: workspaceId,
      Action: CONSTANTS.AUDIT_EVENTS.WORKSPACE_CREATED,
      AfterJSON: record,
      Reason: 'Provisioned new workspace'
    });

    return record;
  },

  /**
   * Super Admin assigns an Admin to a workspace (enforcing max 3 workspaces limit)
   */
  assignAdminToWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const adminAccount = MasterRepository.findAccountById(adminUserId);
      if (!adminAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `Admin user ${adminUserId} not found.`);
      if (adminAccount.Role !== CONSTANTS.ROLES.ADMIN) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `User ${adminAccount.Username} is not an Admin.`);
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          `Admin access cannot be granted to inactive workspace '${workspaceId}' (${ws.Status}).`,
          403
        );
      }

      // Hard Limit Check: Max 3 active workspaces
      AuthorizationService.assertAdminWorkspaceLimit(adminUserId, workspaceId);

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: adminUserId,
        WorkspaceID: workspaceId,
        Role: CONSTANTS.ROLES.ADMIN,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      // Register in workspace Members table if not present
      const member = SheetRepository.getMember(workspaceId, adminUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: adminUserId,
          DisplayName: adminAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Management',
          Team: 'Admins',
          JobTitle: 'Workspace Administrator',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'Admin workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Assigns a regular User to a workspace
   */
  assignUserToWorkspace(superAdminContext, targetUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    // An Admin may only assign ordinary users inside a workspace the Admin already manages.
    if (superAdminContext.role === CONSTANTS.ROLES.ADMIN) {
      AuthorizationService.assertWorkspaceAccess(superAdminContext, workspaceId);
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const userAccount = MasterRepository.findAccountById(targetUserId);
      if (!userAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
      if (userAccount.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, `User ${userAccount.Username} is not active (${userAccount.Status}).`, 400);
      }
      if (userAccount.Role !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'The generic user-assignment endpoint may only assign USER accounts. Admin access must be granted by Super Admin through workspaces.assignAdmin.',
          403
        );
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Workspace ${ws.WorkspaceName} is not active (${ws.Status}).`, 400);
      }

      // Check duplicate assignment
      const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      const alreadyAssigned = existingAccesses.find(a => a.WorkspaceID === workspaceId && (a.Active === true || a.Active === 'TRUE'));
      if (alreadyAssigned) {
        return { ok: true, access: alreadyAssigned, message: 'User is already assigned to this workspace.' };
      }

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: targetUserId,
        WorkspaceID: workspaceId,
        Role: userAccount.Role,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      const member = SheetRepository.getMember(workspaceId, targetUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: targetUserId,
          DisplayName: userAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Operations',
          Team: 'General',
          JobTitle: 'Team Member',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'USER_ACCESS',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'User workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin removes an Admin's access to a workspace
   */
  removeAdminFromWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      MasterRepository.removeWorkspaceAccess(adminUserId, workspaceId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_REMOVED,
        Reason: 'Admin workspace access revoked'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Admin access removed for workspace ${workspaceId}.` };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Lists workspaces accessible to authenticated user
   */
  listWorkspaces(authContext) {
    const allWorkspaces = MasterRepository
      .listWorkspaces()
      .filter(w => w.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return allWorkspaces.map(w => this._toWorkspaceDTO(w, true));
    }

    const accesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
    const allowedIds = new Set(accesses.map(a => a.WorkspaceID));

    // Admin/User workspace selectors contain only operational workspaces.
    // Suspended/Maintenance workspaces remain visible to Super Admin only.
    return allWorkspaces
      .filter(w =>
        w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE &&
        allowedIds.has(w.WorkspaceID)
      )
      .map(w => this._toWorkspaceDTO(w, false));
  }
};

/* ===== TimezoneService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Timezone Service
 * Keeps storage timestamps in UTC while deriving business dates/weeks in the
 * workspace's configured IANA timezone.
 */

var TimezoneService = (typeof global !== 'undefined' && global.TimezoneService) || {
  _assertValidTimezone(timezone) {
    const value = String(timezone || '').trim();
    if (!value) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Timezone is required.', 400);
    }

    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return value;
      }
      if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
        Utilities.formatDate(new Date(), value, 'yyyy-MM-dd');
        return value;
      }
    } catch (err) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid IANA timezone: ${value}.`,
        400
      );
    }

    if (value !== 'UTC') {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Timezone ${value} cannot be validated in this runtime.`,
        400
      );
    }
    return value;
  },

  getWorkspaceTimezone(workspaceId) {
    const ws = MasterRepository.getWorkspace(workspaceId);
    const configured = (ws && ws.Timezone) ||
      MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'UTC') ||
      'UTC';
    return this._assertValidTimezone(configured);
  },

  getWeekStartName(workspaceId) {
    const dayNames = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday',
      'Thursday', 'Friday', 'Saturday'
    ];
    const workspaceOverride = MasterRepository.getGlobalSetting(
      `WS_${workspaceId}_WEEK_STARTS`,
      ''
    );
    const configured = String(
      workspaceOverride ||
      MasterRepository.getGlobalSetting('WEEK_STARTS', 'Sunday') ||
      'Sunday'
    ).trim();

    const canonical = dayNames.find(
      day => day.toLowerCase() === configured.toLowerCase()
    );
    if (!canonical) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid week start '${configured}'. Expected a weekday name.`,
        400
      );
    }
    return canonical;
  },

  _parseDateKey(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid local date. Expected YYYY-MM-DD.', 400);
    }
    return {
      year: parseInt(match[1], 10),
      month: parseInt(match[2], 10),
      day: parseInt(match[3], 10)
    };
  },

  _offsetMinutes(date, timezone) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      const raw = Utilities.formatDate(date, timezone, 'Z'); // e.g. +0300
      const match = String(raw).match(/^([+-])(\d{2})(\d{2})$/);
      if (!match) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Could not resolve timezone offset for ${timezone}.`, 500);
      }
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    }

    // Node/test fallback. Compute timezone offset by formatting parts in the
    // target timezone and comparing those wall-clock components to UTC.
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = formatter.formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      const asUtc = Date.UTC(
        parseInt(obj.year, 10),
        parseInt(obj.month, 10) - 1,
        parseInt(obj.day, 10),
        parseInt(obj.hour, 10),
        parseInt(obj.minute, 10),
        parseInt(obj.second, 10)
      );
      return Math.round((asUtc - date.getTime()) / 60000);
    }

    return 0;
  },

  localDateTimeToUtc(dateKey, timezone, hour = 0, minute = 0, second = 0, millisecond = 0) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let resolved = wallClockAsUtc;

    // Two/three passes handle DST offset changes around the target instant.
    for (let i = 0; i < 3; i++) {
      const offsetMinutes = this._offsetMinutes(new Date(resolved), timezone);
      const next = wallClockAsUtc - offsetMinutes * 60000;
      if (next === resolved) break;
      resolved = next;
    }
    return new Date(resolved);
  },

  formatDateKey(workspaceId, dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid UTC timestamp.', 400);
    }
    const timezone = this.getWorkspaceTimezone(workspaceId);
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
    }
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      return `${obj.year}-${obj.month}-${obj.day}`;
    }
    return date.toISOString().substring(0, 10);
  },

  formatDateTime(workspaceId, dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid UTC timestamp.', 400);
    }
    const timezone = this.getWorkspaceTimezone(workspaceId);
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm:ss') + ' ' + timezone;
    }
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }).format(date) + ' ' + timezone;
    }
    return date.toISOString() + ' UTC';
  },

  formatMonthKey(workspaceId, dateValue) {
    return this.formatDateKey(workspaceId, dateValue).substring(0, 7);
  },

  addLocalDays(dateKey, days) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return d.toISOString().substring(0, 10);
  },

  diffLocalDateDays(startDateKey, endDateKey) {
    const s = this._parseDateKey(startDateKey);
    const e = this._parseDateKey(endDateKey);
    const sMs = Date.UTC(s.year, s.month - 1, s.day);
    const eMs = Date.UTC(e.year, e.month - 1, e.day);
    return Math.round((eMs - sMs) / 86400000);
  },

  getWeekBounds(workspaceId, dateOrLocalKey) {
    const timezone = this.getWorkspaceTimezone(workspaceId);
    const input = String(dateOrLocalKey || '');
    const localDateKey = /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? input
      : this.formatDateKey(workspaceId, dateOrLocalKey);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const configured = this.getWeekStartName(workspaceId);
    const startDayIndex = dayNames.indexOf(configured);

    const p = this._parseDateKey(localDateKey);
    const calendarDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const currentDayIndex = calendarDate.getUTCDay();
    const delta = (currentDayIndex - startDayIndex + 7) % 7;

    const startLocalDate = this.addLocalDays(localDateKey, -delta);
    const nextWeekLocalDate = this.addLocalDays(startLocalDate, 7);
    const endLocalDate = this.addLocalDays(startLocalDate, 6);

    const startUtc = this.localDateTimeToUtc(startLocalDate, timezone, 0, 0, 0, 0);
    const nextWeekUtc = this.localDateTimeToUtc(nextWeekLocalDate, timezone, 0, 0, 0, 0);
    const endUtc = new Date(nextWeekUtc.getTime() - 1);

    const dayLabels = [];
    for (let i = 0; i < 7; i++) {
      dayLabels.push(dayNames[(startDayIndex + i) % 7]);
    }

    return {
      timezone,
      startLocalDate,
      endLocalDate,
      startUtc,
      endUtc,
      dayLabels
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { DriveManager, MasterRepository, SheetRepository, WorkspaceRouter, WorkspaceService, TimezoneService };
}

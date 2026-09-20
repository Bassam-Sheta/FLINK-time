/**
 * FLINK Time & Workforce Platform — Master Control Sheet Repository
 * Encapsulates all read/write operations for the Master Control Sheet.
 * Employs batch reads, header indexing, and sanitization defense.
 */

const MasterRepository = {
  spreadsheetId: null,

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
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length <= 1) return { headers: values[0] || [], rows: [], sheet };

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const rowObj = { _rowIndex: r + 1 };
      for (let c = 0; c < headers.length; c++) {
        rowObj[headers[c]] = values[r][c];
      }
      rows.push(rowObj);
    }
    return { headers, rows, sheet };
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
    return entity;
  },

  /**
   * Updates specific columns for a row index in a master tab
   */
  updateRow(tabName, rowIndex, updates) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());

    for (const [colName, val] of Object.entries(updates)) {
      const colIdx = headers.indexOf(colName);
      if (colIdx !== -1) {
        sheet.getRange(rowIndex, colIdx + 1).setValue(Validation.sanitizeCellValue(val));
      }
    }
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
    this.appendRow(CONSTANTS.MASTER_TABS.ACCOUNTS, accountData);
    this.appendRow(CONSTANTS.MASTER_TABS.CREDENTIALS, credentialData);
    return accountData;
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

  removeWorkspaceAccess(userId, workspaceId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    const existing = rows.find(r => r.UserID === userId && r.WorkspaceID === workspaceId);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Active: false
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

    return { ok: true, message: `Workspace ${workspaceId} permanently archived and unlinked.` };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MasterRepository
  };
}

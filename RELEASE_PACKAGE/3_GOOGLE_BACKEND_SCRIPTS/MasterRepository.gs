/**
 * FLINK Time & Workforce Platform — Master Control Sheet Repository
 * Encapsulates all read/write operations for the Master Control Sheet.
 * Employs batch reads, header indexing, and sanitization defense.
 */

const MasterRepository = {
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MasterRepository
  };
}

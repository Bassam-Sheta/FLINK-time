/**
 * FLINK Time & Workforce Platform — Workspace Sheet Repository
 * Handles batch reads, writes, updates, and soft deletions across all 18 tabs
 * of an isolated Workspace Google Sheet.
 */

const SheetRepository = {
  /**
   * Helper to retrieve tab data from a specific workspace sheet
   */
  getTableData(workspaceId, tabName) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Tab '${tabName}' not found in workspace '${workspaceId}'.`, 404);
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
    return entity;
  },

  /**
   * Updates specific columns for a row index in a workspace tab
   */
  updateRow(workspaceId, tabName, rowIndex, updates) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].map(h => String(h).trim());

    for (const [colName, val] of Object.entries(updates)) {
      const colIdx = headers.indexOf(colName);
      if (colIdx !== -1) {
        sheet.getRange(rowIndex, colIdx + 1).setValue(Validation.sanitizeCellValue(val));
      }
    }
  },

  /**
   * Deletes a row by index (e.g. stopping an ActiveTimer)
   */
  deleteRow(workspaceId, tabName, rowIndex) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    sheet.deleteRow(rowIndex);
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

  createTask(workspaceId, taskData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS, taskData);
  },

  listTags(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS);
    return rows;
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
    if (timer) {
      this.deleteRow(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS, timer._rowIndex);
    }
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

  getEntry(workspaceId, entryId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    return rows.find(e => e.EntryID === entryId && e.Status !== 'DELETED') || null;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SheetRepository
  };
}

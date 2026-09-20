/**
 * FLINK Time & Workforce Platform — Export & Migration Services
 * Generates formula-sanitized CSV exports, verifies system health, and bootstraps schemas.
 */

const ExportService = {
  /**
   * Generates sanitized CSV string from detailed report entries
   */
  exportDetailedCsv(authContext, workspaceId, params = {}) {
    const report = ReportService.getDetailedReport(authContext, workspaceId, params);
    const headers = [
      'Entry ID', 'User Name', 'Project', 'Task', 'Description',
      'Start UTC', 'End UTC', 'Duration (Seconds)', 'Duration (HH:MM:SS)',
      'Billable', 'Approval Status', 'Source', 'Manual'
    ];

    const escapeCsv = val => {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      // Neutralize spreadsheet formula injection in CSV exports
      if (/^[=+\-@\t\r\n]/.test(str)) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

    const csvLines = [headers.map(escapeCsv).join(',')];

    for (const e of report.entries) {
      csvLines.push([
        e.entryId,
        e.userName,
        e.projectName,
        e.taskName,
        e.description,
        e.startUTC,
        e.endUTC,
        e.durationSeconds,
        e.durationFormatted,
        e.billable ? 'YES' : 'NO',
        e.approvalStatus,
        e.source,
        e.manual ? 'YES' : 'NO'
      ].map(escapeCsv).join(','));
    }

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'EXPORT',
      EntityID: `EXP_${Date.now()}`,
      Action: CONSTANTS.AUDIT_EVENTS.EXPORT_CREATED,
      Reason: 'Detailed CSV export downloaded'
    });

    return {
      filename: `FLINK_Time_Export_${workspaceId}_${new Date().toISOString().substring(0, 10)}.csv`,
      csvContent: csvLines.join('\r\n'),
      totalRows: report.entries.length
    };
  }
};

const MigrationService = {
  /**
   * Bootstraps Master Control Sheet tabs and creates default Super Admin account if not present
   */
  bootstrapMasterSheet(masterSpreadsheet = null) {
    const ss = masterSpreadsheet || MasterRepository.getMasterSpreadsheet();

    // Create tabs defined in MASTER_SCHEMA
    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = ss.getSheetByName(tabName);
      if (!sheet) {
        sheet = ss.insertSheet(tabName);
      }
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet.setFrozenRows(1);
    }

    // Remove original default 'Sheet1' if present
    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && !MASTER_SCHEMA[defaultSheet.getName()]) {
      try { ss.deleteSheet(defaultSheet); } catch (e) {}
    }

    // Check if default Super Admin exists
    const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    let defaultAdmin = accounts.find(a => a.Role === CONSTANTS.ROLES.SUPER_ADMIN);

    if (!defaultAdmin) {
      const adminUserId = 'USR-ADMIN-ROOT';
      const tempPassword = 'AdminPassword123!';
      const hash = SecurityService.hashPassword(tempPassword);
      const now = new Date().toISOString();

      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.ACCOUNTS, {
        UserID: adminUserId,
        Username: 'admin',
        DisplayName: 'Master Administrator',
        Role: CONSTANTS.ROLES.SUPER_ADMIN,
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        PrimaryWorkspaceID: '',
        Email: 'admin@flink.local',
        CreatedAt: now,
        CreatedBy: 'SYSTEM',
        UpdatedAt: now,
        UpdatedBy: 'SYSTEM',
        LastLoginAt: '',
        MustChangePassword: true
      });

      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.CREDENTIALS, {
        UserID: adminUserId,
        PasswordHash: hash,
        PasswordVersion: 1,
        PasswordChangedAt: now,
        FailedLoginCount: 0,
        LockUntil: ''
      });
    }

    return { ok: true, message: 'Master Control Sheet bootstrapped successfully.' };
  },

  /**
   * System Health Diagnostic for Super Admin Console
   */
  getSystemHealth(superAdminContext) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const workspaces = MasterRepository.listWorkspaces();
    let accessibleWorkspacesCount = 0;
    let healthyWorkspacesCount = 0;

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED) {
        accessibleWorkspacesCount++;
        try {
          const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          if (ss) healthyWorkspacesCount++;
        } catch (e) {}
      }
    }

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSheetStatus: 'HEALTHY',
      workspacesStatus: `${healthyWorkspacesCount}/${accessibleWorkspacesCount} OK`,
      totalRegisteredWorkspaces: workspaces.length,
      timestampUTC: new Date().toISOString()
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ExportService,
    MigrationService
  };
}

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
   * Bootstraps only the Master Control Sheet schema and cryptographic secret.
   * It deliberately does NOT create any default/admin credentials.
   */
  bootstrapMasterSheet(masterSpreadsheet = null) {
    const ss = masterSpreadsheet || MasterRepository.getMasterSpreadsheet();

    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = ss.getSheetByName(tabName);
      if (!sheet) sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet.setFrozenRows(1);
    }

    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && !MASTER_SCHEMA[defaultSheet.getName()]) {
      try { ss.deleteSheet(defaultSheet); } catch (e) {}
    }

    SecurityService.ensurePepper();
    return { ok: true, message: 'Master Control Sheet schema and cryptographic secret initialized.' };
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

/**
 * Owner-only installation helper.
 * Run this function once from the Apps Script editor before opening the public web app.
 * The one-time setup key is written to the execution log and must be entered in Setup Step 1.
 */
function initializeInstallation() {
  MigrationService.bootstrapMasterSheet();
  if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Script Properties are unavailable in this runtime.');
  }

  const props = PropertiesService.getScriptProperties();
  const setupKey = SecurityService.generateRandomHex(24);
  props.setProperty('FLINK_SETUP_KEY_HASH', SecurityService.hashToken(setupKey));
  props.setProperty('FLINK_SETUP_KEY_CREATED_AT', new Date().toISOString());

  console.log('FLINK one-time setup key: ' + setupKey);
  return {
    ok: true,
    setupKey,
    message: 'Installation initialized. Use this one-time key in Setup Step 1; it is invalidated after Super Admin creation.'
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ExportService,
    MigrationService,
    initializeInstallation
  };
}

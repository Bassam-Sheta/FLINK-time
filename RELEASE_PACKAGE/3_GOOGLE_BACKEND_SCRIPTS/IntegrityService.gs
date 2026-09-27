/**
 * FLINK Time & Workforce Platform — Data Integrity & Automated Audit Engine
 * Runs measured integrity checks and records the result in SystemHealthHistory.
 */

const IntegrityService = {
  runNightlyAudit() {
    const checks = [];
    const timestamp = new Date().toISOString();
    let activeTimerCount = 0;

    const addCheck = (id, name, passed, detail) => {
      checks.push({ id, name, passed: passed === true, detail: String(detail || '') });
    };

    let accounts = [];
    let accessRows = [];
    let workspaces = [];
    try {
      accounts = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS).rows || [];
      accessRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS).rows || [];
      workspaces = MasterRepository.listWorkspaces() || [];
    } catch (e) {
      addCheck('master_reference_load', 'Master Reference Data Load', false, e.message);
    }

    const accountMap = new Map(accounts.map(a => [a.UserID, a]));
    const workspaceMap = new Map(workspaces.map(w => [w.WorkspaceID, w]));
    const activeWorkspaces = workspaces.filter(w => w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE);

    // 1. Unique usernames
    try {
      const seen = new Set();
      const duplicates = new Set();
      for (const account of accounts) {
        const username = String(account.Username || '').trim().toLowerCase();
        if (!username) continue;
        if (seen.has(username)) duplicates.add(username);
        seen.add(username);
      }
      addCheck(
        'unique_usernames',
        'Unique Usernames Invariant',
        duplicates.size === 0,
        duplicates.size === 0 ? 'All usernames are unique' : `Duplicates: ${[...duplicates].join(', ')}`
      );
    } catch (e) {
      addCheck('unique_usernames', 'Unique Usernames Invariant', false, e.message);
    }

    // 2. Admin max-workspace rule
    try {
      const violations = [];
      for (const admin of accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN)) {
        const activeCount = accessRows.filter(r =>
          r.UserID === admin.UserID &&
          (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
        ).length;
        if (activeCount > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
          violations.push(`${admin.Username}: ${activeCount}`);
        }
      }
      addCheck(
        'admin_workspace_limit',
        'Admin Workspace Limit Invariant',
        violations.length === 0,
        violations.length === 0 ? 'All Admin assignments are within configured limit' : violations.join('; ')
      );
    } catch (e) {
      addCheck('admin_workspace_limit', 'Admin Workspace Limit Invariant', false, e.message);
    }

    // 3. Master schema tabs
    try {
      const masterSs = MasterRepository.getMasterSpreadsheet();
      const expectedTabs = Object.values(CONSTANTS.MASTER_TABS);
      const missing = expectedTabs.filter(tab => !masterSs.getSheetByName(tab));
      addCheck(
        'master_tabs',
        'Master Control Schema',
        missing.length === 0,
        missing.length === 0 ? `All ${expectedTabs.length} master tabs exist` : `Missing: ${missing.join(', ')}`
      );
    } catch (e) {
      addCheck('master_tabs', 'Master Control Schema', false, e.message);
    }

    // 4. Workspace tabs
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
        const missing = Object.values(CONSTANTS.WORKSPACE_TABS).filter(tab => !ss.getSheetByName(tab));
        if (missing.length) issues.push(`${ws.WorkspaceName}: ${missing.join(', ')}`);
      }
      addCheck(
        'workspace_tabs',
        'Workspace Schema Tabs',
        issues.length === 0,
        issues.length === 0 ? `${activeWorkspaces.length} active workspace(s) have all required tabs` : issues.join('; ')
      );
    } catch (e) {
      addCheck('workspace_tabs', 'Workspace Schema Tabs', false, e.message);
    }

    // 5. WorkspaceInfo/schema-version consistency
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const rows = SheetRepository.getTableData(
          ws.WorkspaceID,
          CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO
        ).rows || [];
        if (rows.length !== 1) {
          issues.push(`${ws.WorkspaceName}: expected one WorkspaceInfo row, found ${rows.length}`);
          continue;
        }
        const info = rows[0];
        if (String(info.WorkspaceID) !== String(ws.WorkspaceID)) {
          issues.push(`${ws.WorkspaceName}: WorkspaceID mismatch`);
        }
        if (String(info.SchemaVersion) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: schema v${info.SchemaVersion}, expected v${CONSTANTS.SCHEMA_VERSION}`);
        }
        if (String(ws.SchemaVersion || CONSTANTS.SCHEMA_VERSION) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: registry schema v${ws.SchemaVersion}`);
        }
      }
      addCheck(
        'schema_version',
        'Schema Version Consistency',
        issues.length === 0,
        issues.length === 0 ? `All active workspaces are on schema v${CONSTANTS.SCHEMA_VERSION}` : issues.join('; ')
      );
    } catch (e) {
      addCheck('schema_version', 'Schema Version Consistency', false, e.message);
    }

    // 6. Active timer owner/access validity
    const allTimers = [];
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const allowedUsers = new Set(
          accessRows
            .filter(r =>
              r.WorkspaceID === ws.WorkspaceID &&
              (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
            )
            .map(r => r.UserID)
        );
        const timers = SheetRepository.listActiveTimers(ws.WorkspaceID) || [];
        activeTimerCount += timers.length;
        for (const timer of timers) {
          allTimers.push({ ...timer, _workspaceId: ws.WorkspaceID });
          const account = accountMap.get(timer.UserID);
          if (!account || account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
            issues.push(`${timer.TimerID}: inactive/missing user ${timer.UserID}`);
          }
          if (!allowedUsers.has(timer.UserID)) {
            issues.push(`${timer.TimerID}: user lacks active workspace access`);
          }
          if (isNaN(new Date(timer.StartedAtUTC).getTime())) {
            issues.push(`${timer.TimerID}: invalid StartedAtUTC`);
          }
        }
      }
      addCheck(
        'active_timer_user_ref',
        'Active Timer Owner/Workspace Integrity',
        issues.length === 0,
        issues.length === 0 ? `${activeTimerCount} active timer(s) have valid owners/access` : issues.join('; ')
      );
    } catch (e) {
      addCheck('active_timer_user_ref', 'Active Timer Owner/Workspace Integrity', false, e.message);
    }

    // 7. One active timer globally per user
    try {
      const counts = new Map();
      for (const timer of allTimers) {
        counts.set(timer.UserID, (counts.get(timer.UserID) || 0) + 1);
      }
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
      addCheck(
        'single_active_timer_invariant',
        'Single Active Timer Invariant',
        duplicates.length === 0,
        duplicates.length === 0
          ? 'No user has more than one active timer globally'
          : duplicates.map(([userId, count]) => `${userId}: ${count} timers`).join('; ')
      );
    } catch (e) {
      addCheck('single_active_timer_invariant', 'Single Active Timer Invariant', false, e.message);
    }

    // Cache workspace operational data for checks 8-15.
    const workspaceData = new Map();
    try {
      for (const ws of activeWorkspaces) {
        const entries = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES).rows || [];
        const projects = SheetRepository.listProjects(ws.WorkspaceID) || [];
        const tasks = SheetRepository.listTasks(ws.WorkspaceID) || [];
        const clients = SheetRepository.listClients(ws.WorkspaceID) || [];
        const tags = SheetRepository.listTags(ws.WorkspaceID) || [];
        const timesheets = SheetRepository.listTimesheets(ws.WorkspaceID, {}) || [];
        workspaceData.set(ws.WorkspaceID, { entries, projects, tasks, clients, tags, timesheets });
      }
    } catch (e) {
      addCheck('workspace_data_load', 'Workspace Integrity Data Load', false, e.message);
    }

    // 8. Start <= End
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end) || end < start) {
            issues.push(`${workspaceId}/${entry.EntryID}`);
          }
        }
      }
      addCheck(
        'entry_timestamps_order',
        'Time Entry Timestamp Ordering',
        issues.length === 0,
        issues.length === 0 ? 'All active entries have valid StartUTC <= EndUTC' : `Invalid entries: ${issues.join(', ')}`
      );
    } catch (e) {
      addCheck('entry_timestamps_order', 'Time Entry Timestamp Ordering', false, e.message);
    }

    // 9. Duration mathematical accuracy
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end)) continue;
          const expected = Math.max(0, Math.round((end - start) / 1000));
          const stored = parseInt(entry.DurationSeconds, 10) || 0;
          if (Math.abs(expected - stored) > 1) {
            issues.push(`${workspaceId}/${entry.EntryID}: stored=${stored}, expected=${expected}`);
          }
        }
      }
      addCheck(
        'duration_calculation_accuracy',
        'Duration Mathematical Accuracy',
        issues.length === 0,
        issues.length === 0 ? 'All active entry durations match timestamp deltas' : issues.join('; ')
      );
    } catch (e) {
      addCheck('duration_calculation_accuracy', 'Duration Mathematical Accuracy', false, e.message);
    }

    // 10. Task -> Project integrity
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        for (const task of data.tasks) {
          if (!projectIds.has(task.ProjectID)) {
            issues.push(`${workspaceId}/${task.TaskID}: missing project ${task.ProjectID}`);
          }
        }
      }
      addCheck(
        'task_project_integrity',
        'Task to Project Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All tasks reference existing projects' : issues.join('; ')
      );
    } catch (e) {
      addCheck('task_project_integrity', 'Task to Project Referential Integrity', false, e.message);
    }

    // 11. TimeEntry project/task references
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        const taskMap = new Map(data.tasks.map(t => [t.TaskID, t]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          if (entry.ProjectID && !projectIds.has(entry.ProjectID)) {
            issues.push(`${workspaceId}/${entry.EntryID}: missing project ${entry.ProjectID}`);
          }
          if (entry.TaskID) {
            const task = taskMap.get(entry.TaskID);
            if (!task) issues.push(`${workspaceId}/${entry.EntryID}: missing task ${entry.TaskID}`);
            else if (entry.ProjectID && task.ProjectID !== entry.ProjectID) {
              issues.push(`${workspaceId}/${entry.EntryID}: task/project mismatch`);
            }
          }
        }
      }
      addCheck(
        'entry_project_reference',
        'Time Entry Project/Task Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All active entries reference valid project/task entities' : issues.join('; ')
      );
    } catch (e) {
      addCheck('entry_project_reference', 'Time Entry Project/Task Referential Integrity', false, e.message);
    }

    // 12. Submitted/approved entries must be locked and tied to matching timesheet state.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const timesheetMap = new Map(data.timesheets.map(ts => [ts.TimesheetID, ts]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const approval = String(entry.ApprovalStatus || '');
          if (![CONSTANTS.TIMESHEET_STATUS.SUBMITTED, CONSTANTS.TIMESHEET_STATUS.APPROVED].includes(approval)) {
            continue;
          }
          const locked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
          if (!locked) issues.push(`${workspaceId}/${entry.EntryID}: ${approval} but unlocked`);
          const ts = timesheetMap.get(entry.TimesheetID);
          if (!ts) issues.push(`${workspaceId}/${entry.EntryID}: missing timesheet ${entry.TimesheetID}`);
          else if (String(ts.Status) !== approval) {
            issues.push(`${workspaceId}/${entry.EntryID}: entry=${approval}, timesheet=${ts.Status}`);
          }
        }
      }
      addCheck(
        'approved_entry_locking',
        'Timesheet Entry Lock/State Integrity',
        issues.length === 0,
        issues.length === 0 ? 'Submitted/approved entries are locked and match timesheet state' : issues.join('; ')
      );
    } catch (e) {
      addCheck('approved_entry_locking', 'Timesheet Entry Lock/State Integrity', false, e.message);
    }

    // 13. Aggregate rollups reconcile to active raw time.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const rawSeconds = data.entries
          .filter(e => e.Status !== 'DELETED')
          .reduce((sum, e) => sum + (parseInt(e.DurationSeconds, 10) || 0), 0);
        for (const tab of [
          CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
        ]) {
          const rows = SheetRepository.getTableData(workspaceId, tab).rows || [];
          const aggregate = rows.reduce((sum, r) => sum + (parseInt(r.TotalSeconds, 10) || 0), 0);
          if (aggregate !== rawSeconds) {
            issues.push(`${workspaceId}/${tab}: raw=${rawSeconds}, rollup=${aggregate}`);
          }
        }
      }
      addCheck(
        'rollups_reconciliation',
        'Rollup to Raw Entry Reconciliation',
        issues.length === 0,
        issues.length === 0 ? 'Daily, weekly, and monthly totals match active raw time' : issues.join('; ')
      );
    } catch (e) {
      addCheck('rollups_reconciliation', 'Rollup to Raw Entry Reconciliation', false, e.message);
    }

    // 14. WorkspaceAccess referential/role integrity
    try {
      const issues = [];
      for (const access of accessRows) {
        const account = accountMap.get(access.UserID);
        const ws = workspaceMap.get(access.WorkspaceID);
        if (!account) issues.push(`${access.AccessID}: missing user ${access.UserID}`);
        if (!ws) issues.push(`${access.AccessID}: missing workspace ${access.WorkspaceID}`);
        if (account && access.Role && access.Role !== account.Role) {
          issues.push(`${access.AccessID}: ACL role ${access.Role} != account role ${account.Role}`);
        }
        const active = access.Active === true || access.Active === 'TRUE' || access.Active === 1;
        if (active && ws && ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          issues.push(`${access.AccessID}: active ACL points to ${ws.Status} workspace`);
        }
      }
      addCheck(
        'access_orphans',
        'Workspace Access Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All ACL records reference valid users/workspaces with matching roles' : issues.join('; ')
      );
    } catch (e) {
      addCheck('access_orphans', 'Workspace Access Referential Integrity', false, e.message);
    }

    // 15. Entity ID uniqueness across master and active workspaces
    try {
      const seen = new Map();
      const duplicates = [];
      const register = (id, location) => {
        const value = String(id || '').trim();
        if (!value) return;
        if (seen.has(value)) duplicates.push(`${value}: ${seen.get(value)} + ${location}`);
        else seen.set(value, location);
      };

      accounts.forEach(a => register(a.UserID, 'Accounts'));
      workspaces.forEach(w => register(w.WorkspaceID, 'Workspaces'));
      for (const [workspaceId, data] of workspaceData.entries()) {
        data.clients.forEach(x => register(x.ClientID, `${workspaceId}/Clients`));
        data.projects.forEach(x => register(x.ProjectID, `${workspaceId}/Projects`));
        data.tasks.forEach(x => register(x.TaskID, `${workspaceId}/Tasks`));
        data.tags.forEach(x => register(x.TagID, `${workspaceId}/Tags`));
        data.entries.forEach(x => register(x.EntryID, `${workspaceId}/TimeEntries`));
        data.timesheets.forEach(x => register(x.TimesheetID, `${workspaceId}/Timesheets`));
      }

      addCheck(
        'unique_entity_ids',
        'Entity ID Uniqueness',
        duplicates.length === 0,
        duplicates.length === 0 ? `${seen.size} entity IDs verified unique` : duplicates.join('; ')
      );
    } catch (e) {
      addCheck('unique_entity_ids', 'Entity ID Uniqueness', false, e.message);
    }

    // 16. Capacity across Master + all active workspaces
    let worstCapacityStatus = 'HEALTHY';
    let totalCellCount = 0;
    try {
      const metrics = [JobService.getCapacityMetrics()];
      for (const ws of activeWorkspaces) metrics.push(JobService.getCapacityMetrics(ws.WorkspaceID));
      totalCellCount = metrics.reduce((sum, m) => sum + (m.totalCells || 0), 0);
      const critical = metrics.filter(m => m.alertStatus === 'CRITICAL');
      const warning = metrics.filter(m => m.alertStatus === 'WARNING');
      const advisory = metrics.filter(m => m.alertStatus === 'ADVISORY');
      if (critical.length) worstCapacityStatus = 'CRITICAL';
      else if (warning.length) worstCapacityStatus = 'WARNING';
      else if (advisory.length) worstCapacityStatus = 'ADVISORY';

      addCheck(
        'cell_capacity_limit',
        'Google Sheets Cell Capacity',
        critical.length === 0,
        critical.length === 0
          ? `Capacity status ${worstCapacityStatus}; total used cells across checked spreadsheets: ${totalCellCount}`
          : `Critical capacity: ${critical.map(m => `${m.spreadsheetName} ${m.utilizationPct}%`).join(', ')}`
      );
    } catch (e) {
      addCheck('cell_capacity_limit', 'Google Sheets Cell Capacity', false, e.message);
      worstCapacityStatus = 'UNKNOWN';
    }

    const passCount = checks.filter(c => c.passed).length;
    const failCount = checks.length - passCount;
    const overallStatus = failCount === 0
      ? 'HEALTHY'
      : (checks.some(c => c.id === 'cell_capacity_limit' && !c.passed) ? 'CRITICAL' : 'WARNING');

    try {
      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.SYSTEM_HEALTH_HISTORY, {
        HealthCheckID: Validation.generateId('CHK'),
        TimestampUTC: timestamp,
        OverallStatus: overallStatus,
        MasterDbStatus: checks.find(c => c.id === 'master_tabs')?.passed ? 'OK' : 'ERROR',
        WorkspacesStatus: checks.find(c => c.id === 'workspace_tabs')?.passed ? 'OK' : 'ERROR',
        ActiveTimersCount: activeTimerCount,
        CellCountApprox: totalCellCount,
        QuotaStatus: worstCapacityStatus,
        DetailsJSON: JSON.stringify({ passCount, failCount, checks })
      });
    } catch (e) {
      console.error('Failed to record SystemHealthHistory: ' + e.message);
    }

    return {
      ok: true,
      timestampUTC: timestamp,
      overallStatus,
      totalChecks: checks.length,
      passCount,
      failCount,
      checks
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IntegrityService };
}

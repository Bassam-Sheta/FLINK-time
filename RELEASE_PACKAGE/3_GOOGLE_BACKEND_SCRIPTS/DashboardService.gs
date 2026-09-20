/**
 * FLINK Time & Workforce Platform — Dashboard Service
 * Provides fast live "Who is working now?" monitoring across authorized workspaces
 * and executive cross-workspace aggregate KPI scorecards without raw-sheet mixing.
 */

const DashboardService = {
  /**
   * Live "Who is working now?" radar
   * Queries ActiveTimers tab only across authorized workspaces.
   */
  getLiveWorkforceRadar(authContext, requestedWorkspaceId = null) {
    const accessibleWorkspaces = WorkspaceService.listWorkspaces(authContext);
    const targetWorkspaces = requestedWorkspaceId
      ? accessibleWorkspaces.filter(w => w.WorkspaceID === requestedWorkspaceId)
      : accessibleWorkspaces;

    const workingNowList = [];

    for (const ws of targetWorkspaces) {
      try {
        const { rows: timers } = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
        const members = SheetRepository.listMembers(ws.WorkspaceID);
        const memberMap = {};
        members.forEach(m => { memberMap[m.UserID] = m.DisplayName; });

        const projects = SheetRepository.listProjects(ws.WorkspaceID);
        const projMap = {};
        projects.forEach(p => { projMap[p.ProjectID] = p.ProjectName; });

        for (const t of timers) {
          const startedAtMs = new Date(t.StartedAtUTC).getTime();
          const elapsedSecs = Math.max(0, Math.round((Date.now() - startedAtMs) / 1000));

          workingNowList.push({
            timerId: t.TimerID,
            userId: t.UserID,
            userName: memberMap[t.UserID] || t.UserID,
            workspaceId: ws.WorkspaceID,
            workspaceName: ws.WorkspaceName,
            projectId: t.ProjectID,
            projectName: projMap[t.ProjectID] || 'No Project',
            taskId: t.TaskID,
            description: t.Description,
            startedAtUTC: t.StartedAtUTC,
            elapsedSeconds: elapsedSecs,
            source: t.Source || 'WEB'
          });
        }
      } catch (e) {
        console.warn(`Could not read active timers for workspace ${ws.WorkspaceID}: ` + e.message);
      }
    }

    return {
      timestampUTC: new Date().toISOString(),
      activeCount: workingNowList.length,
      workers: workingNowList
    };
  },

  /**
   * Executive / Admin Dashboard Overview KPI Cards
   */
  getDashboardOverview(authContext, requestedWorkspaceId = null) {
    const accessibleWorkspaces = WorkspaceService.listWorkspaces(authContext);
    const targetWorkspaces = requestedWorkspaceId
      ? accessibleWorkspaces.filter(w => w.WorkspaceID === requestedWorkspaceId)
      : accessibleWorkspaces;

    const liveRadar = this.getLiveWorkforceRadar(authContext, requestedWorkspaceId);

    let totalTrackedSecondsToday = 0;
    let totalTrackedSecondsThisWeek = 0;
    let pendingApprovalsCount = 0;
    const todayStr = new Date().toISOString().substring(0, 10);

    for (const ws of targetWorkspaces) {
      try {
        // Read fast from DailyRollups
        const { rows: dailyRollups } = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS);
        for (const r of dailyRollups) {
          if (r.RollupDate === todayStr) {
            totalTrackedSecondsToday += parseInt(r.TotalSeconds, 10) || 0;
          }
        }

        // Read fast from WeeklyRollups
        const { rows: weeklyRollups } = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS);
        for (const r of weeklyRollups) {
          totalTrackedSecondsThisWeek += parseInt(r.TotalSeconds, 10) || 0;
        }

        // Count pending timesheets
        const timesheets = SheetRepository.listTimesheets(ws.WorkspaceID, { status: CONSTANTS.TIMESHEET_STATUS.SUBMITTED });
        pendingApprovalsCount += timesheets.length;
      } catch (e) {
        // Skip uninitialized workspace
      }
    }

    // Pending admin requests count (for Super Admin)
    let pendingRequestsCount = 0;
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      const requests = MasterRepository.listRequests(CONSTANTS.REQUEST_STATUS.PENDING);
      pendingRequestsCount = requests.length;
    }

    return {
      accessibleWorkspacesCount: accessibleWorkspaces.length,
      activeTimersCount: liveRadar.activeCount,
      workingNow: liveRadar.workers,
      todayTrackedHours: +(totalTrackedSecondsToday / 3600).toFixed(2),
      weekTrackedHours: +(totalTrackedSecondsThisWeek / 3600).toFixed(2),
      pendingApprovalsCount,
      pendingRequestsCount
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DashboardService
  };
}

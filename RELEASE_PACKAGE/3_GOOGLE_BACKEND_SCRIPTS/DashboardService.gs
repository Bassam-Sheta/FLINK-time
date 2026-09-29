/**
 * FLINK Time & Workforce Platform — Dashboard Service
 * Dashboard values are correctness-first: current-day/week totals are derived
 * from raw active TimeEntries in the workspace timezone, while live workforce
 * status comes from ActiveTimers.
 */

const DashboardService = {
  _resolveTargetWorkspaces(authContext, requestedWorkspaceId = null) {
    const accessible = WorkspaceService.listWorkspaces(authContext);
    if (!requestedWorkspaceId) return { accessible, targets: accessible };

    const target = accessible.find(
      ws => ws.WorkspaceID === requestedWorkspaceId
    );
    if (!target) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        'The requested dashboard workspace is not accessible.',
        403
      );
    }
    return { accessible, targets: [target] };
  },

  _workspaceCurrentTotals(authContext, workspaceId, now = new Date()) {
    const today = TimezoneService.formatDateKey(workspaceId, now);
    const week = TimezoneService.getWeekBounds(workspaceId, now);
    const entries = SheetRepository.listTimeEntries(workspaceId, {});

    let todaySeconds = 0;
    let weekSeconds = 0;

    for (const entry of entries) {
      if (
        authContext.role === CONSTANTS.ROLES.USER &&
        entry.UserID !== authContext.userId
      ) {
        continue;
      }

      const businessDate = TimezoneService.formatDateKey(
        workspaceId,
        entry.StartUTC
      );
      const seconds = parseInt(entry.DurationSeconds, 10) || 0;

      if (businessDate === today) {
        todaySeconds += seconds;
      }
      if (
        businessDate >= week.startLocalDate &&
        businessDate <= week.endLocalDate
      ) {
        weekSeconds += seconds;
      }
    }

    return {
      today,
      weekStart: week.startLocalDate,
      weekEnd: week.endLocalDate,
      todaySeconds,
      weekSeconds
    };
  },

  /**
   * Live "Who is working now?" radar.
   */
  getLiveWorkforceRadar(authContext, requestedWorkspaceId = null) {
    const { targets } = this._resolveTargetWorkspaces(
      authContext,
      requestedWorkspaceId
    );
    const workingNowList = [];

    for (const ws of targets) {
      try {
        const { rows: timers } = SheetRepository.getTableData(
          ws.WorkspaceID,
          CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS
        );
        const members = SheetRepository.listMembers(ws.WorkspaceID);
        const memberMap = {};
        members.forEach(m => { memberMap[m.UserID] = m.DisplayName; });

        const projects = SheetRepository.listProjects(ws.WorkspaceID);
        const projectMap = {};
        projects.forEach(p => { projectMap[p.ProjectID] = p.ProjectName; });

        for (const timer of timers) {
          if (
            authContext.role === CONSTANTS.ROLES.USER &&
            timer.UserID !== authContext.userId
          ) {
            continue;
          }

          const startedAtMs = new Date(timer.StartedAtUTC).getTime();
          const elapsedSeconds = Number.isFinite(startedAtMs)
            ? Math.max(0, Math.round((Date.now() - startedAtMs) / 1000))
            : 0;

          workingNowList.push({
            timerId: timer.TimerID,
            userId: timer.UserID,
            userName: memberMap[timer.UserID] || timer.UserID,
            workspaceId: ws.WorkspaceID,
            workspaceName: ws.WorkspaceName,
            projectId: timer.ProjectID,
            projectName: projectMap[timer.ProjectID] || 'No Project',
            taskId: timer.TaskID,
            description: timer.Description,
            startedAtUTC: timer.StartedAtUTC,
            elapsedSeconds,
            source: timer.Source || 'WEB'
          });
        }
      } catch (err) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          `Dashboard could not read workspace ${ws.WorkspaceID}. Please retry.`,
          503,
          { workspaceId: ws.WorkspaceID, cause: err && err.message ? err.message : String(err) }
        );
      }
    }

    return {
      timestampUTC: new Date().toISOString(),
      activeCount: workingNowList.length,
      workers: workingNowList
    };
  },

  /**
   * Dashboard overview KPI cards.
   */
  getDashboardOverview(authContext, requestedWorkspaceId = null) {
    const { accessible, targets } = this._resolveTargetWorkspaces(
      authContext,
      requestedWorkspaceId
    );

    const liveRadar = this.getLiveWorkforceRadar(
      authContext,
      requestedWorkspaceId
    );

    let totalTrackedSecondsToday = 0;
    let totalTrackedSecondsThisWeek = 0;
    let pendingApprovalsCount = 0;

    for (const ws of targets) {
      try {
        const totals = this._workspaceCurrentTotals(
          authContext,
          ws.WorkspaceID,
          new Date()
        );
        totalTrackedSecondsToday += totals.todaySeconds;
        totalTrackedSecondsThisWeek += totals.weekSeconds;

        const timesheets = SheetRepository.listTimesheets(
          ws.WorkspaceID,
          { status: CONSTANTS.TIMESHEET_STATUS.SUBMITTED }
        );
        pendingApprovalsCount += authContext.role === CONSTANTS.ROLES.USER
          ? timesheets.filter(ts => ts.UserID === authContext.userId).length
          : timesheets.length;
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          `Dashboard could not calculate workspace ${ws.WorkspaceID}. Please retry.`,
          503,
          { workspaceId: ws.WorkspaceID, cause: err && err.message ? err.message : String(err) }
        );
      }
    }

    let pendingRequestsCount = 0;
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      pendingRequestsCount = MasterRepository
        .listRequests(CONSTANTS.REQUEST_STATUS.PENDING)
        .length;
    }

    let activeUsersCount = 0;
    let passiveUsersCount = 0;
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      const { rows: accounts } = MasterRepository.getTableData(
        CONSTANTS.MASTER_TABS.ACCOUNTS
      );
      activeUsersCount = accounts.filter(
        account => account.Status === CONSTANTS.ACCOUNT_STATUS.ACTIVE
      ).length;
      passiveUsersCount = accounts.filter(
        account => account.Status === CONSTANTS.ACCOUNT_STATUS.PASSIVE
      ).length;
    }

    return {
      accessibleWorkspacesCount: accessible.length,
      workspacesCount: accessible.length,
      activeUsersCount,
      passiveUsersCount,
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
  module.exports = { DashboardService };
}

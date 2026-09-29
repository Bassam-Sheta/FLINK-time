/**
 * FLINK Time & Workforce Platform — Clockify-Class Reporting Engine
 * Supports 3-level nested grouping Summary Reports, Detailed Reports,
 * Weekly User Matrix, Attendance/Utilization, Project Budgets, and Anomaly Detection.
 */

const ReportService = {
  _prepareReportFilters(authContext, workspaceId, params = {}, allowedRoles = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (allowedRoles) {
      AuthorizationService.assertRole(authContext, allowedRoles);
    }

    const filters = { ...((params && params.filters) || {}) };

    if (authContext.role === CONSTANTS.ROLES.USER) {
      // USER scope is always server-forced to self.
      filters.userId = authContext.userId;
    } else if (
      authContext.role === CONSTANTS.ROLES.ADMIN &&
      filters.userId
    ) {
      // An Admin may report on any member of an assigned workspace, but a
      // cross-workspace user ID is not accepted merely because it was supplied
      // as a client filter.
      const member = SheetRepository.getMember(workspaceId, filters.userId);
      if (!member) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'The requested report user does not belong to this workspace.',
          403
        );
      }
    }

    return filters;
  },

  _toSummaryNodeDTO(node, includeFinancial) {
    if (!node) return null;
    const dto = {
      key: node.key,
      groupField: node.groupField,
      totalSeconds: parseInt(node.totalSeconds, 10) || 0,
      billableSeconds: parseInt(node.billableSeconds, 10) || 0,
      totalHours: +(Number(node.totalHours) || 0).toFixed(2),
      billableHours: +(Number(node.billableHours) || 0).toFixed(2)
    };
    if (node.entryCount !== undefined) {
      dto.entryCount = parseInt(node.entryCount, 10) || 0;
    }
    if (Array.isArray(node.groups)) {
      dto.groups = node.groups.map(child =>
        this._toSummaryNodeDTO(child, includeFinancial)
      );
    }
    if (includeFinancial) {
      dto.costCents = parseInt(node.costCents, 10) || 0;
      dto.revenueCents = parseInt(node.revenueCents, 10) || 0;
      dto.cost = +(Number(node.cost) || 0).toFixed(2);
      dto.revenue = +(Number(node.revenue) || 0).toFixed(2);
    }
    return dto;
  },

  _toSummaryOverallDTO(tree, includeFinancial) {
    const dto = {
      totalSeconds: parseInt(tree.totalSeconds, 10) || 0,
      billableSeconds: parseInt(tree.billableSeconds, 10) || 0,
      totalHours: +(Number(tree.totalHours) || 0).toFixed(2),
      billableHours: +(Number(tree.billableHours) || 0).toFixed(2)
    };
    if (includeFinancial) {
      dto.costCents = parseInt(tree.costCents, 10) || 0;
      dto.revenueCents = parseInt(tree.revenueCents, 10) || 0;
      dto.cost = +(Number(tree.cost) || 0).toFixed(2);
      dto.revenue = +(Number(tree.revenue) || 0).toFixed(2);
    }
    return dto;
  },

  /**
   * Summary Report: Up to 3 levels of nested grouping
   * Example groupings: ['user', 'project', 'task'], ['client', 'project', 'user']
   */
  getSummaryReport(authContext, workspaceId, params = {}) {
    const groupings = Array.isArray(params.groupings) && params.groupings.length > 0
      ? params.groupings.slice(0, 3)
      : ['project', 'user'];

    const isRegularUser = authContext.role === CONSTANTS.ROLES.USER;
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params
    );

    const entries = SheetRepository.listTimeEntries(workspaceId, filters);

    // Cache project and user names
    const projects = SheetRepository.listProjects(workspaceId);
    const projMap = {};
    projects.forEach(p => { projMap[p.ProjectID] = p.ProjectName; });

    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const tasks = SheetRepository.listTasks(workspaceId);
    const taskMap = {};
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const resolveGroupKey = (entry, groupField) => {
      switch (groupField.toLowerCase()) {
        case 'user':
          return userMap[entry.UserID] || entry.UserID || 'Unknown User';
        case 'project':
          return projMap[entry.ProjectID] || entry.ProjectID || 'No Project';
        case 'task':
          return taskMap[entry.TaskID] || entry.TaskID || 'No Task';
        case 'date':
          return entry.StartUTC
            ? TimezoneService.formatDateKey(workspaceId, entry.StartUTC)
            : 'Unknown Date';
        case 'billable':
          return (entry.Billable === true || entry.Billable === 'TRUE') ? 'Billable' : 'Non-Billable';
        case 'tag':
          return entry.Tags || 'Untagged';
        default:
          return 'Other';
      }
    };

    // Recursive grouping tree builder
    // Recursive grouping tree builder using exact integer arithmetic (seconds & cents)
    const buildGroupTree = (entryList, groupIndex) => {
      if (groupIndex >= groupings.length) {
        let leafSeconds = 0;
        let leafBillableSeconds = 0;
        let leafCostCents = 0;
        let leafRevenueCents = 0;
        for (const e of entryList) {
          const s = parseInt(e.DurationSeconds, 10) || 0;
          leafSeconds += s;
          const isB = e.Billable === true || e.Billable === 'TRUE' || e.Billable === 1;
          if (isB) leafBillableSeconds += s;
          
          const costRate = parseFloat(e.CostRateSnapshot) || 0;
          const hourlyRate = parseFloat(e.HourlyRateSnapshot) || 0;
          // Exact minor-unit calculation: (seconds * rate * 100) / 3600
          leafCostCents += Math.round((s * costRate * 100) / 3600);
          if (isB) {
            leafRevenueCents += Math.round((s * hourlyRate * 100) / 3600);
          }
        }
        return {
          totalSeconds: leafSeconds,
          billableSeconds: leafBillableSeconds,
          totalHours: +(leafSeconds / 3600).toFixed(2),
          billableHours: +(leafBillableSeconds / 3600).toFixed(2),
          costCents: leafCostCents,
          revenueCents: leafRevenueCents,
          cost: +(leafCostCents / 100).toFixed(2),
          revenue: +(leafRevenueCents / 100).toFixed(2),
          entryCount: entryList.length
        };
      }

      const currentField = groupings[groupIndex];
      const buckets = {};

      for (const entry of entryList) {
        const key = resolveGroupKey(entry, currentField);
        if (!buckets[key]) buckets[key] = [];
        buckets[key].push(entry);
      }

      const children = [];
      let groupTotalSeconds = 0;
      let groupBillableSeconds = 0;
      let groupCostCents = 0;
      let groupRevenueCents = 0;

      for (const [key, items] of Object.entries(buckets)) {
        const subResult = buildGroupTree(items, groupIndex + 1);
        children.push({
          key,
          groupField: currentField,
          ...subResult
        });
        groupTotalSeconds += subResult.totalSeconds;
        groupBillableSeconds += (subResult.billableSeconds !== undefined ? subResult.billableSeconds : (subResult.billableHours ? Math.round(subResult.billableHours * 3600) : 0));
        groupCostCents += (subResult.costCents !== undefined ? subResult.costCents : Math.round((subResult.cost || 0) * 100));
        groupRevenueCents += (subResult.revenueCents !== undefined ? subResult.revenueCents : Math.round((subResult.revenue || 0) * 100));
      }

      return {
        totalSeconds: groupTotalSeconds,
        billableSeconds: groupBillableSeconds,
        totalHours: +(groupTotalSeconds / 3600).toFixed(2),
        billableHours: +(groupBillableSeconds / 3600).toFixed(2),
        costCents: groupCostCents,
        revenueCents: groupRevenueCents,
        cost: +(groupCostCents / 100).toFixed(2),
        revenue: +(groupRevenueCents / 100).toFixed(2),
        groups: children
      };
    };

    const tree = buildGroupTree(entries, 0);

    // Explicit response DTO whitelist. USER responses never inherit new
    // internal financial fields accidentally when the calculation model evolves.
    const includeFinancial = !isRegularUser;
    return {
      workspaceId,
      groupings: [...groupings],
      totalEntries: entries.length,
      overall: this._toSummaryOverallDTO(tree, includeFinancial),
      tree: (tree.groups || []).map(node =>
        this._toSummaryNodeDTO(node, includeFinancial)
      )
    };
  },

  /**
   * Detailed Report: Flattened row-by-row time records with filter criteria
   */
  getDetailedReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);

    // Resolve entities for human-readable labels
    const projects = SheetRepository.listProjects(workspaceId);
    const projMap = {};
    projects.forEach(p => { projMap[p.ProjectID] = p.ProjectName; });

    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const tasks = SheetRepository.listTasks(workspaceId);
    const taskMap = {};
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const rows = entries.map(e => {
      const dur = parseInt(e.DurationSeconds, 10) || 0;
      return {
        entryId: e.EntryID,
        userId: e.UserID,
        userName: userMap[e.UserID] || e.UserID,
        projectId: e.ProjectID,
        projectName: projMap[e.ProjectID] || 'No Project',
        taskId: e.TaskID,
        taskName: taskMap[e.TaskID] || '',
        description: e.Description,
        tags: e.Tags,
        startUTC: e.StartUTC,
        endUTC: e.EndUTC,
        businessDate: e.StartUTC ? TimezoneService.formatDateKey(workspaceId, e.StartUTC) : '',
        startLocal: e.StartUTC ? TimezoneService.formatDateTime(workspaceId, e.StartUTC) : '',
        endLocal: e.EndUTC ? TimezoneService.formatDateTime(workspaceId, e.EndUTC) : '',
        timezone: TimezoneService.getWorkspaceTimezone(workspaceId),
        durationSeconds: dur,
        durationFormatted: this._formatSeconds(dur),
        billable: e.Billable === true || e.Billable === 'TRUE' || e.Billable === 1,
        approvalStatus: e.ApprovalStatus,
        source: e.EntrySource,
        manual: e.ManualEntry === true || e.ManualEntry === 'TRUE'
      };
    });

    return {
      workspaceId,
      totalCount: rows.length,
      entries: rows
    };
  },

  /**
   * Attendance & Utilization Report
   * Summarizes daily first/last punch, target vs tracked hours, missing, and overtime.
   */
  getAttendanceReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params,
      [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);
    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    // Group by User + Date
    const userDays = {};

    for (const e of entries) {
      const dateKey = TimezoneService.formatDateKey(workspaceId, e.StartUTC);
      const userKey = e.UserID;
      const compositeKey = `${userKey}__${dateKey}`;

      if (!userDays[compositeKey]) {
        userDays[compositeKey] = {
          userId: userKey,
          userName: userMap[userKey] || userKey,
          date: dateKey,
          firstPunchUTC: e.StartUTC,
          lastPunchUTC: e.EndUTC || e.StartUTC,
          totalSeconds: 0,
          entryCount: 0
        };
      }

      const item = userDays[compositeKey];
      item.totalSeconds += parseInt(e.DurationSeconds, 10) || 0;
      item.entryCount += 1;

      if (new Date(e.StartUTC).getTime() < new Date(item.firstPunchUTC).getTime()) {
        item.firstPunchUTC = e.StartUTC;
      }
      if (new Date(e.EndUTC || e.StartUTC).getTime() > new Date(item.lastPunchUTC).getTime()) {
        item.lastPunchUTC = e.EndUTC || e.StartUTC;
      }
    }

    const configuredTargetHours = parseFloat(
      MasterRepository.getGlobalSetting(
        `WS_${workspaceId}_DAILY_TARGET`,
        MasterRepository.getGlobalSetting('DEFAULT_WORKDAY_HOURS', '8')
      )
    ) || 8;
    const targetSecondsPerDay = configuredTargetHours * 3600;
    const results = Object.values(userDays).map(row => {
      const trackedHours = +(row.totalSeconds / 3600).toFixed(2);
      const targetHours = +(targetSecondsPerDay / 3600).toFixed(2);
      const diffHours = +(trackedHours - targetHours).toFixed(2);
      const overtimeHours = diffHours > 0 ? diffHours : 0;
      const missingHours = diffHours < 0 ? Math.abs(diffHours) : 0;

      return {
        ...row,
        trackedHours,
        targetHours,
        overtimeHours,
        missingHours
      };
    });

    return {
      workspaceId,
      attendance: results
    };
  },

  /**
   * Exceptions & Anomaly Report
   * Flags suspicious patterns: timers > 12h, large manual entries, overlaps.
   */
  getExceptionsReport(authContext, workspaceId, params = {}) {
    const filters = this._prepareReportFilters(
      authContext,
      workspaceId,
      params,
      [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]
    );
    const entries = SheetRepository.listTimeEntries(workspaceId, filters);
    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    const anomalies = [];

    // Sort entries by User and StartUTC for overlap detection
    const sorted = [...entries].sort((a, b) => new Date(a.StartUTC).getTime() - new Date(b.StartUTC).getTime());

    for (let i = 0; i < sorted.length; i++) {
      const current = sorted[i];
      const durationSeconds = parseInt(current.DurationSeconds, 10) || 0;

      // Anomaly 1: Timer > 12 hours
      if (durationSeconds > 12 * 3600) {
        anomalies.push({
          type: 'EXCESSIVE_DURATION',
          severity: 'HIGH',
          entryId: current.EntryID,
          userId: current.UserID,
          userName: userMap[current.UserID] || current.UserID,
          durationHours: +(durationSeconds / 3600).toFixed(2),
          message: `Time entry duration exceeds 12 hours (${+(durationSeconds / 3600).toFixed(2)}h)`
        });
      }

      // Anomaly 2: Missing project or description
      if (!current.ProjectID || !current.Description) {
        anomalies.push({
          type: 'MISSING_METADATA',
          severity: 'LOW',
          entryId: current.EntryID,
          userId: current.UserID,
          userName: userMap[current.UserID] || current.UserID,
          message: 'Entry lacks a project assignment or description'
        });
      }

      // Anomaly 3: Overlapping entries for same user
      if (i > 0) {
        const prev = sorted[i - 1];
        if (prev.UserID === current.UserID && prev.EndUTC && current.StartUTC) {
          const prevEnd = new Date(prev.EndUTC).getTime();
          const curStart = new Date(current.StartUTC).getTime();
          if (curStart < prevEnd - 60000) { // Overlap of more than 1 minute
            anomalies.push({
              type: 'OVERLAPPING_ENTRIES',
              severity: 'MEDIUM',
              entryId: current.EntryID,
              conflictWithEntryId: prev.EntryID,
              userId: current.UserID,
              userName: userMap[current.UserID] || current.UserID,
              message: `Entry overlaps with previous entry ${prev.EntryID}`
            });
          }
        }
      }
    }

    return {
      workspaceId,
      totalAnomalies: anomalies.length,
      anomalies
    };
  },

  _formatSeconds(sec) {
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ReportService
  };
}

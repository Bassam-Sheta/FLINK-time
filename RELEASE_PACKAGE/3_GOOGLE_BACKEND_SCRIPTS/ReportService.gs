/**
 * FLINK Time & Workforce Platform — Clockify-Class Reporting Engine
 * Supports 3-level nested grouping Summary Reports, Detailed Reports,
 * Weekly User Matrix, Attendance/Utilization, Project Budgets, and Anomaly Detection.
 */

const ReportService = {
  /**
   * Summary Report: Up to 3 levels of nested grouping
   * Example groupings: ['user', 'project', 'task'], ['client', 'project', 'user']
   */
  getSummaryReport(authContext, workspaceId, params = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const groupings = Array.isArray(params.groupings) && params.groupings.length > 0
      ? params.groupings.slice(0, 3)
      : ['project', 'user'];

    const entries = SheetRepository.listTimeEntries(workspaceId, params.filters || {});

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
          return (entry.StartUTC || '').substring(0, 10) || 'Unknown Date';
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

    return {
      workspaceId,
      groupings,
      totalEntries: entries.length,
      overall: {
        totalSeconds: tree.totalSeconds,
        billableSeconds: tree.billableSeconds,
        totalHours: tree.totalHours,
        billableHours: tree.billableHours,
        costCents: tree.costCents,
        revenueCents: tree.revenueCents,
        cost: tree.cost,
        revenue: tree.revenue
      },
      tree: tree.groups || []
    };
  },

  /**
   * Detailed Report: Flattened row-by-row time records with filter criteria
   */
  getDetailedReport(authContext, workspaceId, params = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const entries = SheetRepository.listTimeEntries(workspaceId, params.filters || {});

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
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const entries = SheetRepository.listTimeEntries(workspaceId, params.filters || {});
    const members = SheetRepository.listMembers(workspaceId);
    const userMap = {};
    members.forEach(m => { userMap[m.UserID] = m.DisplayName; });

    // Group by User + Date
    const userDays = {};

    for (const e of entries) {
      const dateKey = (e.StartUTC || '').substring(0, 10);
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

    const targetSecondsPerDay = 8 * 3600; // Standard 8h target
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
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const entries = SheetRepository.listTimeEntries(workspaceId, params.filters || {});
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

/**
 * FLINK Time & Workforce Platform — Rollup Service
 * Pre-computes and incrementally updates multi-dimensional aggregations
 * (Daily, Weekly, Monthly, Project, User) to eliminate full-table raw scans.
 */

const RollupService = {
  /**
   * Incrementally updates rollups when a time entry is created or stopped
   */
  recordTimeEntry(workspaceId, entry) {
    if (!entry || entry.Status === 'DELETED') return;

    const startDate = new Date(entry.StartUTC);
    if (isNaN(startDate.getTime())) return;

    const rollupDate = entry.StartUTC.substring(0, 10);
    const monthKey = entry.StartUTC.substring(0, 7);

    // Calculate WeekStart (Monday-based)
    const d = new Date(startDate);
    const day = d.getUTCDay();
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setUTCDate(diff));
    const weekStart = monday.toISOString().substring(0, 10);
    const sunday = new Date(monday.getTime() + 6 * 24 * 3600 * 1000);
    const weekEnd = sunday.toISOString().substring(0, 10);

    const seconds = parseInt(entry.DurationSeconds, 10) || 0;
    const isBillable = entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1;
    const billableSeconds = isBillable ? seconds : 0;
    const hourlyRate = parseFloat(entry.HourlyRateSnapshot) || 0;
    const costRate = parseFloat(entry.CostRateSnapshot) || 0;
    const hours = seconds / 3600;
    const billableAmount = isBillable ? hours * hourlyRate : 0;
    const costAmount = hours * costRate;

    const now = new Date().toISOString();

    // 1. Update DailyRollups
    this._updateDailyRollup(workspaceId, {
      RollupDate: rollupDate,
      UserID: entry.UserID,
      ProjectID: entry.ProjectID || 'unassigned',
      TotalSeconds: seconds,
      BillableSeconds: billableSeconds,
      CostAmount: costAmount,
      BillableAmount: billableAmount,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    // 2. Update WeeklyRollups
    this._updateWeeklyRollup(workspaceId, {
      WeekStart: weekStart,
      WeekEnd: weekEnd,
      UserID: entry.UserID,
      ProjectID: entry.ProjectID || 'unassigned',
      TotalSeconds: seconds,
      BillableSeconds: billableSeconds,
      CostAmount: costAmount,
      BillableAmount: billableAmount,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    // 3. Update MonthlyRollups
    this._updateMonthlyRollup(workspaceId, {
      MonthKey: monthKey,
      UserID: entry.UserID,
      ProjectID: entry.ProjectID || 'unassigned',
      TotalSeconds: seconds,
      BillableSeconds: billableSeconds,
      CostAmount: costAmount,
      BillableAmount: billableAmount,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    // 4. Update ProjectRollups
    this._updateProjectRollup(workspaceId, entry.ProjectID, seconds, billableSeconds, costAmount, billableAmount);
  },

  _updateDailyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS);
    const existing = rows.find(r => r.RollupDate === record.RollupDate && r.UserID === record.UserID && r.ProjectID === record.ProjectID);

    if (existing) {
      SheetRepository.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS, existing._rowIndex, {
        TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
        BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
        CostAmount: (parseFloat(existing.CostAmount) || 0) + record.CostAmount,
        BillableAmount: (parseFloat(existing.BillableAmount) || 0) + record.BillableAmount,
        EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
        LastCalculatedAt: record.LastCalculatedAt
      });
    } else {
      SheetRepository.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS, record);
    }
  },

  _updateWeeklyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS);
    const existing = rows.find(r => r.WeekStart === record.WeekStart && r.UserID === record.UserID && r.ProjectID === record.ProjectID);

    if (existing) {
      SheetRepository.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS, existing._rowIndex, {
        TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
        BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
        CostAmount: (parseFloat(existing.CostAmount) || 0) + record.CostAmount,
        BillableAmount: (parseFloat(existing.BillableAmount) || 0) + record.BillableAmount,
        EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
        LastCalculatedAt: record.LastCalculatedAt
      });
    } else {
      SheetRepository.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS, record);
    }
  },

  _updateMonthlyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS);
    const existing = rows.find(r => r.MonthKey === record.MonthKey && r.UserID === record.UserID && r.ProjectID === record.ProjectID);

    if (existing) {
      SheetRepository.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS, existing._rowIndex, {
        TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
        BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
        CostAmount: (parseFloat(existing.CostAmount) || 0) + record.CostAmount,
        BillableAmount: (parseFloat(existing.BillableAmount) || 0) + record.BillableAmount,
        EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
        LastCalculatedAt: record.LastCalculatedAt
      });
    } else {
      SheetRepository.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS, record);
    }
  },

  _updateProjectRollup(workspaceId, projectId, seconds, billableSeconds, costAmount, billableAmount) {
    if (!projectId) return;
    const { rows } = SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS);
    const existing = rows.find(r => r.ProjectID === projectId);
    const now = new Date().toISOString();

    if (existing) {
      const proj = SheetRepository.getProject(workspaceId, projectId);
      const estimateHours = proj ? (parseFloat(proj.EstimateHours) || 0) : 0;
      const totalSecs = (parseInt(existing.TotalSeconds, 10) || 0) + seconds;
      const remainingHours = Math.max(0, estimateHours - (totalSecs / 3600));

      SheetRepository.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS, existing._rowIndex, {
        TotalSeconds: totalSecs,
        BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + billableSeconds,
        RemainingHours: +remainingHours.toFixed(2),
        TotalCost: (parseFloat(existing.TotalCost) || 0) + costAmount,
        TotalRevenue: (parseFloat(existing.TotalRevenue) || 0) + billableAmount,
        LastCalculatedAt: now
      });
    } else {
      const proj = SheetRepository.getProject(workspaceId, projectId);
      const estimateHours = proj ? (parseFloat(proj.EstimateHours) || 0) : 0;
      const remainingHours = Math.max(0, estimateHours - (seconds / 3600));

      SheetRepository.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS, {
        ProjectID: projectId,
        TotalSeconds: seconds,
        BillableSeconds: billableSeconds,
        RemainingHours: +remainingHours.toFixed(2),
        TotalCost: costAmount,
        TotalRevenue: billableAmount,
        ContributorCount: 1,
        LastCalculatedAt: now
      });
    }
  },

  /**
   * Full reconciliation job: rebuilds rollups from scratch from raw TimeEntries
   */
  rebuildRollups(workspaceId) {
    const rawEntries = SheetRepository.listTimeEntries(workspaceId, {});

    // Clear existing rollup tabs
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const tabsToReset = [
      CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS
    ];

    for (const tab of tabsToReset) {
      const sheet = ss.getSheetByName(tab);
      if (sheet && sheet.getLastRow() > 1) {
        sheet.deleteRows(2, sheet.getLastRow() - 1);
      }
    }

    // Replay each active entry
    for (const entry of rawEntries) {
      if (entry.Status !== 'DELETED') {
        this.recordTimeEntry(workspaceId, entry);
      }
    }

    return { ok: true, entriesProcessed: rawEntries.length };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RollupService
  };
}

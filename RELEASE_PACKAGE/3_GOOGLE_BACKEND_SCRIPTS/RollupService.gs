/**
 * FLINK Time & Workforce Platform — Rollup Service
 * Canonical source-of-truth reconciliation plus safe incremental CREATE updates.
 *
 * Rules:
 * - Raw active TimeEntries are authoritative.
 * - New entries may update rollups incrementally while the caller owns the write lock.
 * - Edits/deletes/project/rate/date/billable changes rebuild from raw source.
 * - Currency is accumulated as integer cents per entry to avoid floating drift.
 */

const RollupService = {
  _getWeekBounds(workspaceId, startDate) {
    const bounds = TimezoneService.getWeekBounds(workspaceId, startDate);
    return {
      weekStart: bounds.startLocalDate,
      weekEnd: bounds.endLocalDate
    };
  },

  _amountCents(seconds, rate) {
    return Math.round(((parseInt(seconds, 10) || 0) * (parseFloat(rate) || 0) * 100) / 3600);
  },

  _entryContribution(workspaceId, entry) {
    if (!entry || entry.Status === 'DELETED') return null;

    const startDate = new Date(entry.StartUTC);
    if (!Number.isFinite(startDate.getTime())) return null;

    const seconds = Math.max(0, parseInt(entry.DurationSeconds, 10) || 0);
    const isBillable =
      entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1;
    const projectId = entry.ProjectID || 'unassigned';
    const rollupDate = TimezoneService.formatDateKey(workspaceId, startDate);
    const monthKey = TimezoneService.formatMonthKey(workspaceId, startDate);
    const { weekStart, weekEnd } = this._getWeekBounds(workspaceId, startDate);

    return {
      userId: entry.UserID,
      projectId,
      rollupDate,
      monthKey,
      weekStart,
      weekEnd,
      seconds,
      billableSeconds: isBillable ? seconds : 0,
      costCents: this._amountCents(seconds, entry.CostRateSnapshot),
      revenueCents: isBillable
        ? this._amountCents(seconds, entry.HourlyRateSnapshot)
        : 0
    };
  },

  _addAggregate(map, key, seed, contribution) {
    let item = map.get(key);
    if (!item) {
      item = { ...seed, _costCents: 0, _revenueCents: 0 };
      map.set(key, item);
    }
    item.TotalSeconds += contribution.seconds;
    item.BillableSeconds += contribution.billableSeconds;
    item._costCents += contribution.costCents;
    item._revenueCents += contribution.revenueCents;
    item.EntryCount += 1;
    return item;
  },

  _finalizeAggregateRows(map, calculatedAt) {
    return [...map.values()]
      .map(item => {
        const row = { ...item };
        row.CostAmount = +(row._costCents / 100).toFixed(2);
        row.BillableAmount = +(row._revenueCents / 100).toFixed(2);
        row.LastCalculatedAt = calculatedAt;
        delete row._costCents;
        delete row._revenueCents;
        return row;
      });
  },

  /**
   * Deterministically derives every rollup row from raw source entries.
   */
  _buildCanonicalRollups(workspaceId, rawEntries, calculatedAt = new Date().toISOString()) {
    const daily = new Map();
    const weekly = new Map();
    const monthly = new Map();
    const projects = new Map();

    for (const entry of rawEntries || []) {
      const c = this._entryContribution(workspaceId, entry);
      if (!c) continue;

      this._addAggregate(
        daily,
        [c.rollupDate, c.userId, c.projectId].join('|'),
        {
          RollupDate: c.rollupDate,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      this._addAggregate(
        weekly,
        [c.weekStart, c.userId, c.projectId].join('|'),
        {
          WeekStart: c.weekStart,
          WeekEnd: c.weekEnd,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      this._addAggregate(
        monthly,
        [c.monthKey, c.userId, c.projectId].join('|'),
        {
          MonthKey: c.monthKey,
          UserID: c.userId,
          ProjectID: c.projectId,
          TotalSeconds: 0,
          BillableSeconds: 0,
          EntryCount: 0
        },
        c
      );

      if (c.projectId !== 'unassigned') {
        let project = projects.get(c.projectId);
        if (!project) {
          project = {
            ProjectID: c.projectId,
            TotalSeconds: 0,
            BillableSeconds: 0,
            _costCents: 0,
            _revenueCents: 0,
            contributors: new Set()
          };
          projects.set(c.projectId, project);
        }
        project.TotalSeconds += c.seconds;
        project.BillableSeconds += c.billableSeconds;
        project._costCents += c.costCents;
        project._revenueCents += c.revenueCents;
        project.contributors.add(c.userId);
      }
    }

    const sortBy = fields => (a, b) => {
      for (const field of fields) {
        const cmp = String(a[field] || '').localeCompare(String(b[field] || ''));
        if (cmp !== 0) return cmp;
      }
      return 0;
    };

    const dailyRows = this._finalizeAggregateRows(daily, calculatedAt)
      .sort(sortBy(['RollupDate', 'UserID', 'ProjectID']));
    const weeklyRows = this._finalizeAggregateRows(weekly, calculatedAt)
      .sort(sortBy(['WeekStart', 'UserID', 'ProjectID']));
    const monthlyRows = this._finalizeAggregateRows(monthly, calculatedAt)
      .sort(sortBy(['MonthKey', 'UserID', 'ProjectID']));

    const projectRows = [...projects.values()].map(item => {
      const project = SheetRepository.getProject(workspaceId, item.ProjectID);
      const estimateHours = project ? (parseFloat(project.EstimateHours) || 0) : 0;
      const remainingHours = Math.max(
        0,
        estimateHours - item.TotalSeconds / 3600
      );
      return {
        ProjectID: item.ProjectID,
        TotalSeconds: item.TotalSeconds,
        BillableSeconds: item.BillableSeconds,
        RemainingHours: +remainingHours.toFixed(2),
        TotalCost: +(item._costCents / 100).toFixed(2),
        TotalRevenue: +(item._revenueCents / 100).toFixed(2),
        ContributorCount: item.contributors.size,
        LastCalculatedAt: calculatedAt
      };
    }).sort(sortBy(['ProjectID']));

    return {
      DailyRollups: dailyRows,
      WeeklyRollups: weeklyRows,
      MonthlyRollups: monthlyRows,
      ProjectRollups: projectRows
    };
  },

  /**
   * Safe incremental path for a newly-created entry only.
   */
  recordTimeEntry(workspaceId, entry) {
    const c = this._entryContribution(workspaceId, entry);
    if (!c) return { ok: true, skipped: true };

    const now = new Date().toISOString();

    this._updateDailyRollup(workspaceId, {
      RollupDate: c.rollupDate,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateWeeklyRollup(workspaceId, {
      WeekStart: c.weekStart,
      WeekEnd: c.weekEnd,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateMonthlyRollup(workspaceId, {
      MonthKey: c.monthKey,
      UserID: c.userId,
      ProjectID: c.projectId,
      TotalSeconds: c.seconds,
      BillableSeconds: c.billableSeconds,
      CostCents: c.costCents,
      RevenueCents: c.revenueCents,
      EntryCount: 1,
      LastCalculatedAt: now
    });

    this._updateProjectRollup(workspaceId, c, now);
    return { ok: true, mode: 'incremental-create' };
  },

  _updateDailyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.RollupDate === record.RollupDate &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
        {
          RollupDate: record.RollupDate,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateWeeklyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.WeekStart === record.WeekStart &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
        existing._rowIndex,
        {
          WeekEnd: record.WeekEnd,
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
        {
          WeekStart: record.WeekStart,
          WeekEnd: record.WeekEnd,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateMonthlyRollup(workspaceId, record) {
    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
    );
    const existing = rows.find(r =>
      r.MonthKey === record.MonthKey &&
      r.UserID === record.UserID &&
      r.ProjectID === record.ProjectID
    );

    if (existing) {
      const costCents = Math.round((parseFloat(existing.CostAmount) || 0) * 100) + record.CostCents;
      const revenueCents = Math.round((parseFloat(existing.BillableAmount) || 0) * 100) + record.RevenueCents;
      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: (parseInt(existing.TotalSeconds, 10) || 0) + record.TotalSeconds,
          BillableSeconds: (parseInt(existing.BillableSeconds, 10) || 0) + record.BillableSeconds,
          CostAmount: +(costCents / 100).toFixed(2),
          BillableAmount: +(revenueCents / 100).toFixed(2),
          EntryCount: (parseInt(existing.EntryCount, 10) || 0) + 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS,
        {
          MonthKey: record.MonthKey,
          UserID: record.UserID,
          ProjectID: record.ProjectID,
          TotalSeconds: record.TotalSeconds,
          BillableSeconds: record.BillableSeconds,
          CostAmount: +(record.CostCents / 100).toFixed(2),
          BillableAmount: +(record.RevenueCents / 100).toFixed(2),
          EntryCount: 1,
          LastCalculatedAt: record.LastCalculatedAt
        }
      );
    }
  },

  _updateProjectRollup(workspaceId, contribution, calculatedAt) {
    if (!contribution.projectId || contribution.projectId === 'unassigned') return;

    const { rows } = SheetRepository.getTableData(
      workspaceId,
      CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS
    );
    const existing = rows.find(r => r.ProjectID === contribution.projectId);
    const project = SheetRepository.getProject(workspaceId, contribution.projectId);
    const estimateHours = project ? (parseFloat(project.EstimateHours) || 0) : 0;

    const allProjectEntries = SheetRepository.listTimeEntries(workspaceId, {
      projectId: contribution.projectId
    });
    const contributorCount = new Set(allProjectEntries.map(e => e.UserID)).size;

    if (existing) {
      const totalSeconds =
        (parseInt(existing.TotalSeconds, 10) || 0) + contribution.seconds;
      const costCents =
        Math.round((parseFloat(existing.TotalCost) || 0) * 100) +
        contribution.costCents;
      const revenueCents =
        Math.round((parseFloat(existing.TotalRevenue) || 0) * 100) +
        contribution.revenueCents;

      SheetRepository.updateRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS,
        existing._rowIndex,
        {
          TotalSeconds: totalSeconds,
          BillableSeconds:
            (parseInt(existing.BillableSeconds, 10) || 0) +
            contribution.billableSeconds,
          RemainingHours: +Math.max(
            0,
            estimateHours - totalSeconds / 3600
          ).toFixed(2),
          TotalCost: +(costCents / 100).toFixed(2),
          TotalRevenue: +(revenueCents / 100).toFixed(2),
          ContributorCount: contributorCount,
          LastCalculatedAt: calculatedAt
        }
      );
    } else {
      SheetRepository.appendRow(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS,
        {
          ProjectID: contribution.projectId,
          TotalSeconds: contribution.seconds,
          BillableSeconds: contribution.billableSeconds,
          RemainingHours: +Math.max(
            0,
            estimateHours - contribution.seconds / 3600
          ).toFixed(2),
          TotalCost: +(contribution.costCents / 100).toFixed(2),
          TotalRevenue: +(contribution.revenueCents / 100).toFixed(2),
          ContributorCount: contributorCount,
          LastCalculatedAt: calculatedAt
        }
      );
    }
  },

  _rollupRelevantState(entry) {
    if (!entry) return null;
    return {
      UserID: entry.UserID || '',
      ProjectID: entry.ProjectID || '',
      StartUTC: entry.StartUTC || '',
      EndUTC: entry.EndUTC || '',
      DurationSeconds: parseInt(entry.DurationSeconds, 10) || 0,
      Billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
      HourlyRateSnapshot: parseFloat(entry.HourlyRateSnapshot) || 0,
      CostRateSnapshot: parseFloat(entry.CostRateSnapshot) || 0,
      Status: entry.Status || 'ACTIVE'
    };
  },

  mutationAffectsRollups(beforeEntry, afterEntry) {
    return JSON.stringify(this._rollupRelevantState(beforeEntry)) !==
      JSON.stringify(this._rollupRelevantState(afterEntry));
  },

  reconcileMutation(workspaceId, beforeEntry, afterEntry, mutationType = 'UPDATE') {
    const type = String(mutationType || 'UPDATE').toUpperCase();
    if (type === 'CREATE' && !beforeEntry && afterEntry) {
      return this.recordTimeEntry(workspaceId, afterEntry);
    }
    if (!this.mutationAffectsRollups(beforeEntry, afterEntry)) {
      return { ok: true, skipped: true, mode: 'metadata-only' };
    }
    return this.rebuildRollups(workspaceId);
  },

  /**
   * Full source-of-truth reconciliation from raw active TimeEntries.
   */
  rebuildRollups(workspaceId) {
    const rawEntries = SheetRepository.listTimeEntries(workspaceId, {});
    const calculatedAt = new Date().toISOString();
    const canonical = this._buildCanonicalRollups(
      workspaceId,
      rawEntries,
      calculatedAt
    );

    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const tabMappings = [
      [CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS, canonical.DailyRollups],
      [CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS, canonical.WeeklyRollups],
      [CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS, canonical.MonthlyRollups],
      [CONSTANTS.WORKSPACE_TABS.PROJECT_ROLLUPS, canonical.ProjectRollups]
    ];

    for (const [tab, rows] of tabMappings) {
      const sheet = ss.getSheetByName(tab);
      if (!sheet) {
        throw new AppError(
          ERROR_CODES.NOT_FOUND,
          `Workspace rollup tab '${tab}' does not exist.`,
          404
        );
      }
      if (sheet.getLastRow() > 1) {
        sheet.deleteRows(2, sheet.getLastRow() - 1);
      }
      if (SheetRepository.clearTableCache) {
        SheetRepository.clearTableCache(workspaceId, tab);
      }
      for (const row of rows) {
        SheetRepository.appendRow(workspaceId, tab, row);
      }
    }

    return {
      ok: true,
      mode: 'full-rebuild',
      entriesProcessed: rawEntries.length,
      rowCounts: {
        daily: canonical.DailyRollups.length,
        weekly: canonical.WeeklyRollups.length,
        monthly: canonical.MonthlyRollups.length,
        project: canonical.ProjectRollups.length
      }
    };
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { RollupService };
}

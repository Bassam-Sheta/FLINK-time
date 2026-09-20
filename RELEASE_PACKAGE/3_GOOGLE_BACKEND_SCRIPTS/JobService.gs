/**
 * FLINK Time & Workforce Platform — Job Engine, Trigger Dispatcher & Capacity Monitor
 * Manages chunked long-running background tasks with cursor persistence,
 * central trigger dispatchers, and Google Sheets 10M cell capacity tracking.
 */

const JobService = {
  /**
   * Central Housekeeping Dispatcher
   * Cleans up expired sessions, archives stale cache, and logs execution.
   */
  dispatchHousekeeping() {
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    let expiredSessionsCount = 0;

    try {
      const { rows: sessions } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const now = Date.now();
      const nowIso = new Date().toISOString();

      for (const s of sessions) {
        if (!s.Revoked && new Date(s.ExpiresAt).getTime() <= now) {
          MasterRepository.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, {
            Revoked: true,
            RevokedAt: nowIso,
            RevokeReason: 'EXPIRED_IDLE_TIMEOUT'
          });
          expiredSessionsCount++;
        }
      }

      this.logJobRun({
        RunID: runId,
        JobID: 'JOB_HOUSEKEEPING',
        JobType: 'HOUSEKEEPING',
        WorkspaceID: 'MASTER',
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: expiredSessionsCount,
        Status: CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails: `Housekeeping pruned ${expiredSessionsCount} expired sessions.`
      });

      return { ok: true, expiredSessionsCount };
    } catch (e) {
      this.logJobRun({
        RunID: runId,
        JobID: 'JOB_HOUSEKEEPING',
        JobType: 'HOUSEKEEPING',
        WorkspaceID: 'MASTER',
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: expiredSessionsCount,
        Status: CONSTANTS.JOB_STATUS.FAILED,
        LogDetails: 'Housekeeping error: ' + e.message
      });
      throw e;
    }
  },

  /**
   * Central Rollup Recalculation Dispatcher
   * Synchronizes precomputed daily, weekly, monthly, and project rollups for all active workspaces.
   */
  dispatchRollups() {
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    const workspaces = MasterRepository.listWorkspaces();
    const results = [];

    for (const ws of workspaces) {
      if (ws.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED) continue;
      try {
        const res = RollupService.rebuildRollups(ws.WorkspaceID);
        results.push({ workspaceId: ws.WorkspaceID, name: ws.WorkspaceName, ok: true, rollups: res });
      } catch (err) {
        results.push({ workspaceId: ws.WorkspaceID, name: ws.WorkspaceName, ok: false, error: err.message });
      }
    }

    this.logJobRun({
      RunID: runId,
      JobID: 'JOB_ROLLUP_DISPATCHER',
      JobType: 'ROLLUP_SYNC',
      WorkspaceID: 'ALL',
      StartedAt: new Date(startMs).toISOString(),
      EndedAt: new Date().toISOString(),
      DurationMs: Date.now() - startMs,
      ItemsProcessed: results.length,
      Status: results.every(r => r.ok) ? CONSTANTS.JOB_STATUS.COMPLETED : CONSTANTS.JOB_STATUS.FAILED,
      LogDetails: `Processed rollups for ${results.length} workspaces.`
    });

    return { ok: true, workspacesProcessed: results.length, details: results };
  },

  /**
   * Chunked Job Processor with Cursor Persistence
   * Executes a batch of items, saves progress cursor in JobRegistry, and splits work safely across execution windows.
   */
  runChunkedJob(jobType, workspaceId, workerBatchFn, maxDurationMs = 120000, maxBatches = null) {
    const jobRegistry = this.getOrCreateJob(jobType, workspaceId);
    const startMs = Date.now();
    const runId = Validation.generateId('RUN');
    let itemsProcessed = 0;
    let newCursor = jobRegistry.Cursor || '0';
    let hasMore = true;
    let batchesRun = 0;

    try {
      // Execute batch worker while within budget and batch count limit
      while (hasMore && (Date.now() - startMs) < maxDurationMs && (!maxBatches || batchesRun < maxBatches)) {
        const batchResult = workerBatchFn(newCursor);
        itemsProcessed += batchResult.processedCount || 0;
        newCursor = String(batchResult.nextCursor || '');
        hasMore = batchResult.hasMore === true;
        batchesRun++;
      }

      const status = hasMore ? CONSTANTS.JOB_STATUS.QUEUED : CONSTANTS.JOB_STATUS.COMPLETED;
      this.updateJobRegistry(jobRegistry.JobID, {
        Status: status,
        Cursor: newCursor,
        UpdatedAt: new Date().toISOString(),
        LastError: ''
      });

      this.logJobRun({
        RunID: runId,
        JobID: jobRegistry.JobID,
        JobType: jobType,
        WorkspaceID: workspaceId,
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: itemsProcessed,
        Status: status,
        LogDetails: hasMore ? `Batch paused at cursor ${newCursor}` : `Job completed. Total ${itemsProcessed} items processed.`
      });

      return { ok: true, status, cursor: newCursor, itemsProcessed, hasMore };
    } catch (err) {
      this.updateJobRegistry(jobRegistry.JobID, {
        Status: CONSTANTS.JOB_STATUS.FAILED,
        UpdatedAt: new Date().toISOString(),
        LastError: err.message
      });

      this.logJobRun({
        RunID: runId,
        JobID: jobRegistry.JobID,
        JobType: jobType,
        WorkspaceID: workspaceId,
        StartedAt: new Date(startMs).toISOString(),
        EndedAt: new Date().toISOString(),
        DurationMs: Date.now() - startMs,
        ItemsProcessed: itemsProcessed,
        Status: CONSTANTS.JOB_STATUS.FAILED,
        LogDetails: 'Chunked execution failure: ' + err.message
      });

      throw err;
    }
  },

  /**
   * Capacity Monitor: Estimates cell count against Google Sheets 10M Limit
   * Warnings: 60% = advisory, 75% = warning, 85% = partition required
   */
  getCapacityMetrics(workspaceId = null) {
    let targetSs = null;
    let name = 'Master Control';

    if (workspaceId) {
      targetSs = WorkspaceRouter.resolveSpreadsheet(workspaceId);
      const ws = MasterRepository.getWorkspace(workspaceId);
      name = ws ? ws.WorkspaceName : workspaceId;
    } else {
      targetSs = MasterRepository.getMasterSpreadsheet();
    }

    let totalCells = 0;
    let totalRows = 0;
    let totalColumns = 0;
    const tabBreakdown = [];

    if (targetSs && targetSs.getSheets) {
      const sheets = targetSs.getSheets();
      for (const sheet of sheets) {
        const rows = sheet.getLastRow();
        const cols = sheet.getLastColumn();
        const cells = rows * cols;
        totalCells += cells;
        totalRows += rows;
        totalColumns = Math.max(totalColumns, cols);

        tabBreakdown.push({
          tabName: sheet.getName(),
          rows,
          columns: cols,
          cells
        });
      }
    }

    const maxLimit = CONSTANTS.CAPACITY.MAX_CELLS_PER_SHEET;
    const utilizationPct = (totalCells / maxLimit) * 100;

    let alertStatus = 'HEALTHY';
    let recommendation = 'Capacity within normal operating thresholds.';

    if (utilizationPct >= CONSTANTS.CAPACITY.CRITICAL_THRESHOLD_PCT) {
      alertStatus = 'CRITICAL';
      recommendation = 'CRITICAL: Spreadsheet capacity >= 85%. Annual partition required immediately.';
    } else if (utilizationPct >= CONSTANTS.CAPACITY.WARNING_THRESHOLD_PCT) {
      alertStatus = 'WARNING';
      recommendation = 'WARNING: Spreadsheet capacity >= 75%. Plan archiving old records.';
    } else if (utilizationPct >= CONSTANTS.CAPACITY.ADVISORY_THRESHOLD_PCT) {
      alertStatus = 'ADVISORY';
      recommendation = 'ADVISORY: Capacity >= 60%. Monitor entry growth rate.';
    }

    return {
      spreadsheetName: name,
      workspaceId: workspaceId || 'MASTER',
      totalCells,
      maxLimit,
      utilizationPct: parseFloat(utilizationPct.toFixed(2)),
      alertStatus,
      recommendation,
      totalRows,
      totalColumns,
      tabBreakdown,
      checkedAtUTC: new Date().toISOString()
    };
  },

  /* ---------------- REGISTRY HELPERS ---------------- */

  getOrCreateJob(jobType, workspaceId) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.JOB_REGISTRY);
    const existing = rows.find(j => j.JobType === jobType && j.WorkspaceID === workspaceId);
    if (existing) return existing;

    const newJob = {
      JobID: Validation.generateId('JOB'),
      JobType: jobType,
      WorkspaceID: workspaceId,
      Status: CONSTANTS.JOB_STATUS.QUEUED,
      Cursor: '0',
      StartedAt: '',
      UpdatedAt: new Date().toISOString(),
      RetryCount: 0,
      NextRunAt: new Date().toISOString(),
      LastError: ''
    };

    MasterRepository.appendRow(CONSTANTS.MASTER_TABS.JOB_REGISTRY, newJob);
    return newJob;
  },

  updateJobRegistry(jobId, updates) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.JOB_REGISTRY);
    const job = rows.find(j => j.JobID === jobId);
    if (job) {
      MasterRepository.updateRow(CONSTANTS.MASTER_TABS.JOB_REGISTRY, job._rowIndex, updates);
    }
  },

  logJobRun(runData) {
    try {
      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.JOB_RUNS, {
        RunID: runData.RunID || Validation.generateId('RUN'),
        JobID: runData.JobID || '',
        JobType: runData.JobType || '',
        WorkspaceID: runData.WorkspaceID || '',
        StartedAt: runData.StartedAt || '',
        EndedAt: runData.EndedAt || '',
        DurationMs: runData.DurationMs || 0,
        ItemsProcessed: runData.ItemsProcessed || 0,
        Status: runData.Status || CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails: runData.LogDetails || ''
      });
    } catch (e) {
      console.error('Failed to log job run: ' + e.message);
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JobService
  };
}

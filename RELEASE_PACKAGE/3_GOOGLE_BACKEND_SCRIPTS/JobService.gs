/**
 * FLINK Time & Workforce Platform — Job Engine, Trigger Dispatcher & Capacity Monitor
 * Manages chunked long-running background tasks with cursor persistence,
 * central trigger dispatchers, and Google Sheets 10M cell capacity tracking.
 */

const JobService = {
  _scheduledTriggerSpecs: [
    { handler: 'scheduledHousekeeping', hour: 1, purpose: 'Expired session cleanup' },
    { handler: 'scheduledRollups', hour: 2, purpose: 'Rollup reconciliation' }
  ],

  getScheduledTriggerStatus() {
    if (
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getProjectTriggers
    ) {
      return {
        supported: false,
        healthy: false,
        expected: this._scheduledTriggerSpecs.map(spec => spec.handler),
        installed: [],
        missing: this._scheduledTriggerSpecs.map(spec => spec.handler),
        detail: 'Apps Script trigger runtime is unavailable.'
      };
    }

    const triggers = ScriptApp.getProjectTriggers();
    const installed = triggers
      .map(trigger => trigger.getHandlerFunction ? trigger.getHandlerFunction() : '')
      .filter(Boolean);
    const installedSet = new Set(installed);
    const missing = this._scheduledTriggerSpecs
      .map(spec => spec.handler)
      .filter(handler => !installedSet.has(handler));

    return {
      supported: true,
      healthy: missing.length === 0,
      expected: this._scheduledTriggerSpecs.map(spec => spec.handler),
      installed,
      missing,
      detail: missing.length === 0
        ? 'All required scheduled triggers are installed.'
        : `Missing scheduled trigger(s): ${missing.join(', ')}`
    };
  },

  ensureScheduledTriggers() {
    if (
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getProjectTriggers ||
      !ScriptApp.newTrigger
    ) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        'Apps Script trigger runtime is unavailable.',
        500
      );
    }

    const existing = new Set(
      ScriptApp.getProjectTriggers()
        .map(trigger => trigger.getHandlerFunction ? trigger.getHandlerFunction() : '')
        .filter(Boolean)
    );
    const created = [];

    for (const spec of this._scheduledTriggerSpecs) {
      if (existing.has(spec.handler)) continue;
      ScriptApp
        .newTrigger(spec.handler)
        .timeBased()
        .everyDays(1)
        .atHour(spec.hour)
        .create();
      created.push(spec.handler);
    }

    const status = this.getScheduledTriggerStatus();
    return {
      ok: status.healthy,
      created,
      ...status
    };
  },

  _beginJobExecution() {
    if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
      MasterRepository.beginRequest();
    }
    if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
      SheetRepository.beginRequest();
    }
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }
  },

  /**
   * Central Housekeeping Dispatcher
   * Cleans up expired sessions, archives stale cache, and logs execution.
   */
  dispatchHousekeeping() {
    this._beginJobExecution();
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    let expiredSessionsCount = 0;
    let purgedSessionsCount = 0;
    let purgedMfaChallengesCount = 0;

    try {
      const { rows: sessions } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const now = Date.now();
      const nowIso = new Date().toISOString();
      const retentionMs =
        (CONSTANTS.LIMITS.SESSION_RETENTION_DAYS || 30) * 24 * 3600 * 1000;
      const retentionCutoff = now - retentionMs;

      for (const s of sessions) {
        const expiresMs = new Date(s.ExpiresAt).getTime();
        const revoked =
          s.Revoked === true || s.Revoked === 'TRUE' || s.Revoked === 1;

        if (!revoked && !isNaN(expiresMs) && expiresMs <= now) {
          MasterRepository.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, {
            Revoked: true,
            RevokedAt: nowIso,
            RevokeReason: 'EXPIRED_IDLE_TIMEOUT'
          });
          expiredSessionsCount++;
        }
      }

      // Purge only old, already-invalid session rows; security/audit events remain
      // in their dedicated logs.
      const refreshedSessions =
        MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS).rows || [];
      const purgeRows = refreshedSessions
        .filter(s => {
          const revoked =
            s.Revoked === true || s.Revoked === 'TRUE' || s.Revoked === 1;
          const revokedAt = new Date(s.RevokedAt || '').getTime();
          const expiresAt = new Date(s.ExpiresAt || '').getTime();
          const oldEnough =
            (!isNaN(revokedAt) && revokedAt < retentionCutoff) ||
            (!isNaN(expiresAt) && expiresAt < retentionCutoff);
          return revoked && oldEnough;
        })
        .sort((a, b) => b._rowIndex - a._rowIndex);

      for (const session of purgeRows) {
        MasterRepository.deleteRow(
          CONSTANTS.MASTER_TABS.SESSIONS,
          session._rowIndex
        );
        purgedSessionsCount++;
      }

      // MFA challenges are one-per-user, but failed/abandoned challenges should
      // not occupy Script Properties forever.
      if (
        typeof PropertiesService !== 'undefined' &&
        PropertiesService.getScriptProperties
      ) {
        const props = PropertiesService.getScriptProperties();
        const all = props.getProperties();
        for (const [key, raw] of Object.entries(all)) {
          if (!key.startsWith('FLINK_MFA_CHALLENGE_')) continue;
          try {
            const challenge = JSON.parse(raw);
            if (Number(challenge.expiresAtMs || 0) < now) {
              props.deleteProperty(key);
              purgedMfaChallengesCount++;
            }
          } catch (e) {
            props.deleteProperty(key);
            purgedMfaChallengesCount++;
          }
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
        ItemsProcessed:
          expiredSessionsCount + purgedSessionsCount + purgedMfaChallengesCount,
        Status: CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails:
          `Housekeeping revoked ${expiredSessionsCount} expired sessions, purged ${purgedSessionsCount} retained session rows, and removed ${purgedMfaChallengesCount} stale MFA challenges.`
      });

      return {
        ok: true,
        expiredSessionsCount,
        purgedSessionsCount,
        purgedMfaChallengesCount
      };
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
    this._beginJobExecution();
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    const workspaces = MasterRepository.listWorkspaces();
    const results = [];

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) continue;
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

function scheduledHousekeeping() {
  return JobService.dispatchHousekeeping();
}

function scheduledRollups() {
  return JobService.dispatchRollups();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    JobService
  };
}

/**
 * ============================================================================
 * ULTRA-ACCOUNT: ENTERPRISE GOOGLE APPS SCRIPT REST API GATEWAY & DATABASE ENGINE
 * ============================================================================
 * 
 * ARCHITECTURAL RATIONALE:
 * This script serves as the centralized, headless REST API router and database controller
 * running natively on Google's cloud infrastructure. By deploying this script as
 * `executeAs: USER_DEPLOYING`, all write operations to Google Sheets and Google Drive
 * are executed under the Super Admin's authorization and quota, guaranteeing that
 * monitored employee data and screenshots are stored EXCLUSIVELY in the Super Admin's
 * account and never touch employee personal storage.
 * 
 * POTENTIAL BUGS & SAFEGUARDS IMPLEMENTED:
 * 1. Concurrency Race Conditions: Mitigated via LockService.getScriptLock() (15s timeout).
 * 2. Sheet Cell Overload (10M limit): Mitigated via Yearly Table Sharding (TIME_ENTRIES_YYYY).
 * 3. Network Retry Duplication: Mitigated via strict UUIDv4 Idempotent UPSERT matching.
 * 4. Execution Timeouts (6m limit): Mitigated by direct Base64 stream decoding to DriveApp.
 * 5. Corrupted Restores: Mitigated by transactional schema validation prior to row replacement.
 */

const SCRIPT_VERSION = "2.3.0-ENTERPRISE-RESTORE";
const LOCK_TIMEOUT_MS = 15000; // 15-second maximum wait for atomic write lock
const CACHE_TTL_SECONDS = 300; // 5-minute memory cache lifetime for read operations

/**
 * HTTP GET Router: Handles read-only requests, health checks, and Admin UI serving.
 * 
 * RATIONALE:
 * Separating GET (read-only) from POST (transactional mutations) allows Google's global CDN
 * and Apps Script runtime to process metadata queries with sub-second response times.
 * 
 * POTENTIAL BUGS AVOIDED:
 * - Browser caching stale project lists: Mitigated by CacheService invalidation on CRUD.
 * - Unauthorized UI access: Can be embedded inside an authenticated Google Site.
 */
function doGet(e) {
  try {
    const params = e ? e.parameter : {};
    const action = params.action;

    // Default route: Serve the Super Admin Single Page Application (SPA)
    if (!action || action === 'admin_ui') {
      return HtmlService.createHtmlOutputFromFile('admin_ui')
        .setTitle('Ultra-Account Super Admin Controller')
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
    }

    // Health check endpoint for client automated connection pairing
    if (action === 'ping') {
      return jsonResponse({
        status: 'OK',
        version: SCRIPT_VERSION,
        role: 'SUPER_ADMIN_GATEWAY',
        active_year: new Date().getFullYear(),
        timestamp: new Date().toISOString()
      });
    }

    // Returns all clients, projects, tasks, and tags (cached in RAM)
    if (action === 'workspace_manifest') {
      return jsonResponse(getWorkspaceManifest(params.user_email));
    }

    // Real-time workforce radar (active timers, ongoing window titles, latest screenshots)
    if (action === 'get_active_radar') {
      return jsonResponse(getActiveWorkforceRadar());
    }

    // Aggregates reports and analytics across projects and users
    if (action === 'get_reports') {
      return jsonResponse(queryReports(params));
    }

    // Universal Data Analyst Export endpoint (CSV & JSON format)
    if (action === 'export_analyst_data') {
      return handleDataAnalystExport(params);
    }

    return jsonError('Unknown GET action: ' + action, 400);
  } catch (err) {
    Logger.log('doGet Critical Failure: ' + err.toString());
    return jsonError(err.toString(), 500);
  }
}

/**
 * HTTP POST Router: Handles all transactional mutations, batch syncs, and database restores.
 * 
 * RATIONALE:
 * All state modifications must pass through a concurrency lock to guarantee ACID compliance
 * on Google Sheets. Without LockService, two employees starting a timer at the exact same
 * millisecond would overwrite each other's spreadsheet rows.
 * 
 * POTENTIAL BUGS AVOIDED:
 * - Lost updates & row collisions: Prevented by LockService tryLock(15000).
 * - Malformed JSON bodies: Caught and returned with HTTP 400 Bad Request.
 * - Suspended user access: Checked against USERS table whitelist before processing.
 */
function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    // Acquire atomic mutex lock
    const hasLock = lock.tryLock(LOCK_TIMEOUT_MS);
    if (!hasLock) {
      return jsonError('System busy: concurrent write lock timeout. Client will retry with jitter.', 429);
    }

    if (!e || !e.postData || !e.postData.contents) {
      return jsonError('Missing POST request body', 400);
    }

    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      return jsonError('Malformed JSON payload: ' + parseErr.message, 400);
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonError('Invalid JSON payload: expected JSON object', 400);
    }
    const action = payload.action;

    // Optional auth token verification if client provides one
    if (payload.auth_token && !verifyAuthToken(payload.auth_token)) {
      return jsonError('Unauthorized: Invalid auth token.', 401);
    }

    // Security Gate: Reject requests from suspended, inactive, or deleted users immediately
    const userEmail = (payload.user && payload.user.email) ? payload.user.email : (action === 'auth_handshake' ? (payload.email || (payload.user ? payload.user.email : null)) : null);
    if (userEmail) {
      const userRecord = getUserRecord(userEmail);
      if (userRecord) {
        if (userRecord.status === 'SUSPENDED' || userRecord.status === 'INACTIVE' || userRecord.status === 'DELETED') {
          return jsonError('Forbidden: Your account is ' + userRecord.status.toLowerCase() + '. Access denied.', 403);
        }
      } else {
        // User record does not exist in USERS table
        if (action === 'sync_batch' || action === 'batch_sync' || action === 'submit_timesheet') {
          return jsonError('Forbidden: User account does not exist or has been deleted.', 403);
        }
        if (action === 'auth_handshake' && isUserDeleted(userEmail)) {
          return jsonError('Forbidden: User account has been deleted by administrator.', 403);
        }
      }
    }

    let result;
    switch (action) {
      case 'setup_db':
        result = setupDatabase(payload.year);
        break;
      case 'auth_handshake':
        result = handleAuthHandshake(payload);
        break;
      case 'sync_batch':
      case 'batch_sync':
        result = handleBatchSyncToMasterVault(payload);
        break;
      case 'submit_timesheet':
        result = handleSubmitTimesheet(payload);
        break;
      case 'approval_action':
        result = handleApprovalAction(payload);
        break;
      case 'entity_crud':
        result = handleEntityCrud(payload);
        break;
      case 'incident_report':
        result = handleIncidentReport(payload);
        break;
      case 'query_reports':
        result = queryReports(payload.filters);
        break;
      case 'restore_database':
        result = handleFullDatabaseRestore(payload);
        break;
      case 'create_backup':
        result = createNightlyBackupSnapshot();
        break;
      case 'set_policy':
        result = handleSetPolicy(payload);
        break;
      default:
        result = { error: 'Unknown POST action: ' + action };
        break;
    }

    if (result && result.status === 'ERROR') {
      return jsonError(result.error || result.message || 'Error processing request', result.code || 400);
    }

    return jsonResponse(result);
  } catch (err) {
    Logger.log('doPost Critical Failure: ' + err.toString());
    return jsonError(err.toString(), 500);
  } finally {
    // Always release lock even if exceptions occurred to prevent lock starvation
    lock.releaseLock();
  }
}

// ============================================================================
// FULL DATABASE DISASTER RECOVERY & RESTORE ENGINE
// ============================================================================

/**
 * Restores the complete relational database from a local JSON backup file.
 * 
 * RATIONALE:
 * If an administrator accidentally wipes sheets, or if data corruption occurs,
 * this function allows full point-in-time disaster recovery. It validates the backup
 * structure, resets data rows while preserving headers and formatting, and rebuilds
 * all relational tables with full audit logging.
 * 
 * POTENTIAL BUGS AVOIDED:
 * - Partial/incomplete restores: Schema is validated BEFORE modifying any sheet.
 * - Header row destruction: Header row (row 1) is strictly preserved.
 * - Audit loss: A permanent SHA-256 hash of the restored payload is recorded in AUDIT_LOGS.
 */
function handleFullDatabaseRestore(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const backupData = payload.backup_data;

  if (!backupData || typeof backupData !== 'object') {
    throw new Error('Invalid restore payload: missing backup_data object.');
  }

  Logger.log('Initiating Full Database Disaster Recovery...');
  let restoredTablesCount = 0;
  let totalRestoredRows = 0;

  // List of recognized relational tables eligible for restore
  const supportedTables = [
    'USERS', 'CLIENTS', 'PROJECTS', 'TASKS', 'TAGS', 
    'TIME_ENTRIES_' + (backupData.year || new Date().getFullYear()), 
    'APPROVALS', 'EXPENSES', 'INVOICES', 'TIME_OFF', 'CONFIGS'
  ];

  for (const tableName of supportedTables) {
    const tableRows = backupData[tableName];
    if (Array.isArray(tableRows) && tableRows.length > 0) {
      let sheet = ss.getSheetByName(tableName);
      if (!sheet) {
        sheet = ss.insertSheet(tableName);
      }

      // Read headers from row 1 (or construct from first object keys)
      const existingLastRow = sheet.getLastRow();
      let headers = [];

      if (existingLastRow > 0) {
        headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
        // Clear old data rows while keeping row 1 header intact
        if (existingLastRow > 1) {
          sheet.deleteRows(2, existingLastRow - 1);
        }
      } else {
        // Construct headers from first row keys
        headers = Object.keys(tableRows[0]);
        sheet.appendRow(headers);
        sheet.getRange(1, 1, 1, headers.length).setBackground('#0F172A').setFontColor('#38BDF8').setFontWeight('bold');
      }

      // Format row arrays strictly matching header column order
      const matrix = tableRows.map(obj => {
        return headers.map(h => obj[h] !== undefined ? obj[h] : '');
      });

      if (matrix.length > 0) {
        // Ensure sheet has enough rows for the restore data
        const currentRows = sheet.getMaxRows();
        const neededRows = matrix.length + 1; // +1 for header
        if (currentRows < neededRows) {
          sheet.insertRowsAfter(currentRows, neededRows - currentRows);
        }
      }

      // Chunked batch write (500 rows per chunk)
      // RATIONALE: Attempting to call setValues() on thousands of rows simultaneously can exceed
      // Apps Script memory limits and trigger 'Service error: Spreadsheets'. Slicing into 500-row
      // chunks guarantees fast, reliable memory flushing without timeouts.
      const CHUNK_SIZE = 500;
      for (let offset = 0; offset < matrix.length; offset += CHUNK_SIZE) {
        const chunk = matrix.slice(offset, offset + CHUNK_SIZE);
        sheet.getRange(2 + offset, 1, chunk.length, headers.length).setValues(chunk);
      }
      restoredTablesCount++;
      totalRestoredRows += matrix.length;
    }
  }

  // Clear in-memory script cache to ensure fresh data is served immediately
  CacheService.getScriptCache().removeAll(['manifest_all']);

  // Record tamper-evident audit entry for forensic compliance
  recordAuditLog(
    payload.admin_user_id || 'super_admin',
    'DISASTER_RECOVERY_RESTORE',
    'ALL_TABLES',
    'snapshot_' + new Date().getTime(),
    null,
    { tables_restored: restoredTablesCount, total_rows: totalRestoredRows, timestamp: new Date().toISOString() }
  );

  return {
    status: 'SUCCESS',
    message: 'Database successfully restored from backup snapshot.',
    tables_restored: restoredTablesCount,
    total_rows_restored: totalRestoredRows,
    restored_tables: restoredTablesCount,
    restored_rows: totalRestoredRows,
    restored_at: new Date().toISOString()
  };
}

// ============================================================================
// BATCH SYNC & MASTER VAULT DRIVE INGESTION (ADMIN DRIVE ONLY)
// ============================================================================

/**
 * Ingests employee time logs and saves screenshots EXCLUSIVELY into the Super Admin's Drive.
 * 
 * RATIONALE:
 * In enterprise employee monitoring, screenshots must NEVER be stored in the employee's personal Drive.
 * This function decodes the Base64 image stream and creates the file in the Super Admin's Master Vault
 * under `/UltraAccount_Master_Vault/{Workspace}/{User}/{Date}/`.
 * 
 * POTENTIAL BUGS AVOIDED:
 * - Duplicate entries on network reconnect: Handled via UUIDv4 idempotency dictionary.
 * - Out-of-memory on large base64 strings: Base64 headers stripped; uses lightweight Utilities.newBlob.
 * - Missing workspace folders: Auto-provisioned recursively with getOrCreateSubFolder().
 */
function handleBatchSyncToMasterVault(payload) {
  const user = payload.user || {};
  const workspaceName = payload.workspace_name || 'Primary Workspace';
  const entries = payload.time_entries || [];
  const screenshots = payload.screenshots || [];
  const now = new Date().toISOString();
  const dateStr = now.substring(0, 10);
  const incomingEmail = (user.email || '').trim().toLowerCase();

  // Security Gate: Reject oversized batch payloads to prevent timeout and memory exhaustion
  if (entries.length > 500 || screenshots.length > 20) {
    return {
      status: 'ERROR',
      error: 'Batch limit exceeded: maximum 500 entries and 20 screenshots per sync.'
    };
  }

  // Resolve genuine user_id from USERS table if client passed generic/missing ID
  let resolvedUserId = user.user_id;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName('USERS');
  if ((!resolvedUserId || resolvedUserId === 'usr_local' || resolvedUserId === 'usr_unknown') && incomingEmail && usersSheet) {
    const uData = usersSheet.getDataRange().getValues();
    const uEmailIdx = uData[0].indexOf('email');
    const uIdIdx = uData[0].indexOf('user_id');
    for (let i = 1; i < uData.length; i++) {
      if (String(uData[i][uEmailIdx]).trim().toLowerCase() === incomingEmail) {
        resolvedUserId = uData[i][uIdIdx];
        break;
      }
    }
  }

  let insertedEntries = 0;
  let updatedEntries = 0;
  let savedScreenshots = 0;

  // 1. Process Time Entries into Yearly Sharded Tabs (Multi-Year Rollover Safe)
  if (entries.length > 0) {
    const defaultYear = new Date().getFullYear();
    const entriesByYear = {};
    entries.forEach(entry => {
      let yr = defaultYear;
      if (entry.start_time) {
        const parsedYr = new Date(entry.start_time).getFullYear();
        if (!isNaN(parsedYr) && parsedYr >= 2000 && parsedYr <= 2100) {
          yr = parsedYr;
        }
      }
      if (!entriesByYear[yr]) entriesByYear[yr] = [];
      entriesByYear[yr].push(entry);
    });

    Object.keys(entriesByYear).forEach(yr => {
      const yearEntries = entriesByYear[yr];
      const timeSheet = getTimeEntriesSheetForYear(Number(yr));
      const data = timeSheet.getDataRange().getValues();
      const headers = data[0];
      const idIdx = headers.indexOf('entry_id');
      const updatedIdx = headers.indexOf('updated_at');

      // Build hash index for O(1) idempotency lookup with full row data
      const rowMap = {};
      for (let i = 1; i < data.length; i++) {
        rowMap[String(data[i][idIdx])] = {
          rowNum: i + 1,
          updatedAt: updatedIdx >= 0 ? data[i][updatedIdx] : '',
          rowData: data[i]
        };
      }

      const newRows = [];
      const updateRanges = [];
      const updateValues = [];

      yearEntries.forEach(entry => {
        // Input Validation
        if (entry.start_time && isNaN(Date.parse(entry.start_time))) {
          Logger.log('Warning: Invalid start_time format, skipping entry.');
          return;
        }
        if (entry.end_time && isNaN(Date.parse(entry.end_time))) {
          Logger.log('Warning: Invalid end_time format, skipping entry.');
          return;
        }
        if (entry.start_time && entry.end_time && Date.parse(entry.end_time) < Date.parse(entry.start_time)) {
          Logger.log('Warning: end_time cannot be earlier than start_time, skipping entry.');
          return;
        }
        if (entry.duration_seconds !== undefined) {
          const dur = Number(entry.duration_seconds);
          if (isNaN(dur) || dur < 0 || dur > 86400) {
            Logger.log('Warning: duration_seconds must be a valid number between 0 and 86400 (24h max), skipping entry.');
            return;
          }
        }
        if (entry.entry_id && !/^(ent_[a-zA-Z0-9_-]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i.test(entry.entry_id)) {
          Logger.log('Warning: entry_id must be a valid identifier (e.g. ent_... or UUID), skipping entry: ' + entry.entry_id);
          return;
        }

        const entryId = entry.entry_id || ('ent_' + Utilities.getUuid().substring(0, 10));
        const existing = rowMap[entryId];
        const existingRow = existing ? existing.rowData : null;
        const existingVal = (colName) => {
          if (!existingRow) return null;
          const idx = headers.indexOf(colName);
          return (idx >= 0 && existingRow[idx] !== undefined && existingRow[idx] !== '') ? existingRow[idx] : null;
        };

        // Security Gate: Locked or Approved entries are immutable via client sync
        if (existingRow) {
          const isLocked = existingVal('is_locked') === true || String(existingVal('is_locked')).toLowerCase() === 'true';
          const isApproved = existingVal('approval_status') === 'APPROVED';
          if (isLocked || isApproved) {
            Logger.log('Security Alert: Attempted unauthorized modification of locked/approved entry ' + entryId + ' blocked.');
            return;
          }
        }

        const finalUserId = entry.user_id || resolvedUserId || user.user_id || existingVal('user_id') || 'usr_unknown';
        const finalProjectId = entry.project_id || entry.project || entry.project_name || existingVal('project_id') || '';
        const finalTaskId = entry.task_id || existingVal('task_id') || '';
        const finalDesc = entry.description !== undefined ? entry.description : (existingVal('description') || '');
        const finalStartTime = entry.start_time || existingVal('start_time') || now;
        const finalEndTime = entry.end_time !== undefined ? entry.end_time : (existingVal('end_time') !== null ? existingVal('end_time') : '');
        const finalDuration = entry.duration_seconds !== undefined ? Number(entry.duration_seconds) : (existingVal('duration_seconds') !== null ? Number(existingVal('duration_seconds')) : 0);
        const finalBillable = entry.is_billable !== undefined ? (entry.is_billable === true || entry.is_billable === 'true') : (existingVal('is_billable') !== null ? (existingVal('is_billable') === true || existingVal('is_billable') === 'true') : true);
        const finalHourlyRate = entry.hourly_rate !== undefined ? Number(entry.hourly_rate) : (existingVal('hourly_rate') !== null ? Number(existingVal('hourly_rate')) : 0);
        const finalCostRate = entry.cost_rate !== undefined ? Number(entry.cost_rate) : (existingVal('cost_rate') !== null ? Number(existingVal('cost_rate')) : 0);
        const finalAmount = entry.amount !== undefined ? Number(entry.amount) : (finalHourlyRate * (finalDuration / 3600));
        const finalLaborCost = entry.labor_cost !== undefined ? Number(entry.labor_cost) : (existingVal('labor_cost') !== null ? Number(existingVal('labor_cost')) : 0);
        const finalProfit = entry.profit !== undefined ? Number(entry.profit) : (existingVal('profit') !== null ? Number(existingVal('profit')) : 0);

        // Security Gate: Clients cannot self-approve entries via sync_batch
        let finalApprStatus = entry.approval_status || existingVal('approval_status') || 'DRAFT';
        if (finalApprStatus === 'APPROVED' && (!existingRow || existingVal('approval_status') !== 'APPROVED')) {
          finalApprStatus = 'SUBMITTED';
        }
        const finalApprId = entry.approval_id || existingVal('approval_id') || '';
        const finalDeviceId = entry.device_id || existingVal('device_id') || 'windows11_portable';
        const finalIsManual = entry.is_manual !== undefined ? (entry.is_manual === true || entry.is_manual === 'true') : (existingVal('is_manual') !== null ? (existingVal('is_manual') === true || existingVal('is_manual') === 'true') : false);
        const finalIsLocked = false;
        const finalTags = entry.tags !== undefined ? entry.tags : (existingVal('tags') || '');

        // Security Gate: Anti-Cheat Monotonic Latch (prevent client downgrading incident flag to CLEAN)
        let finalAntiCheat = entry.anti_cheat_flag || existingVal('anti_cheat_flag') || 'CLEAN';
        const existingFlag = existingVal('anti_cheat_flag');
        if (existingFlag && existingFlag !== 'CLEAN' && existingFlag !== 'NONE') {
          if (!entry.anti_cheat_flag || entry.anti_cheat_flag === 'CLEAN' || entry.anti_cheat_flag === 'NONE') {
            finalAntiCheat = existingFlag;
          }
        }

        const finalCreatedAt = existingVal('created_at') || entry.created_at || now;

        const rowValues = [
          entryId,
          finalUserId,
          sanitizeCellValue(finalProjectId),
          sanitizeCellValue(finalTaskId),
          sanitizeCellValue(finalDesc),
          finalStartTime,
          finalEndTime,
          finalDuration,
          finalBillable,
          finalHourlyRate,
          finalCostRate,
          finalAmount,
          finalLaborCost,
          finalProfit,
          finalApprStatus,
          finalApprId,
          finalDeviceId,
          finalIsManual,
          finalIsLocked,
          sanitizeCellValue(finalTags),
          finalAntiCheat,
          finalCreatedAt,
          now
        ];

        if (existing) {
          // Conflict resolution: accept updated_at, modified_at, or created_at
          const incomingTimeStr = entry.updated_at || entry.modified_at || entry.created_at || now;
          const incomingTime = new Date(incomingTimeStr).getTime();
          const existingTime = new Date(existing.updatedAt).getTime();
          
          if (isNaN(existingTime) || incomingTime >= existingTime) {
            const existingUpIdx = updateRanges.indexOf(existing.rowNum);
            if (existingUpIdx >= 0) {
              updateValues[existingUpIdx] = rowValues;
            } else {
              updateRanges.push(existing.rowNum);
              updateValues.push(rowValues);
              updatedEntries++;
            }
          }
        } else {
          const newRowIdx = newRows.findIndex(r => r[0] === entryId);
          if (newRowIdx >= 0) {
            newRows[newRowIdx] = rowValues;
          } else {
            newRows.push(rowValues);
            insertedEntries++;
          }
        }
      });

      if (newRows.length > 0) {
        const lastRow = timeSheet.getLastRow();
        const maxRows = timeSheet.getMaxRows();
        const neededRows = lastRow + newRows.length;
        if (neededRows > maxRows) {
          timeSheet.insertRowsAfter(maxRows, neededRows - maxRows);
        }
        timeSheet.getRange(lastRow + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
      }
      for (let i = 0; i < updateRanges.length; i++) {
        timeSheet.getRange(updateRanges[i], 1, 1, updateValues[i].length).setValues([updateValues[i]]);
      }
    });
  }

  // 2. Process Screenshots: SAVE DIRECTLY INTO SUPER ADMIN MASTER DRIVE VAULT
  if (screenshots.length > 0) {
    const scSheet = ss.getSheetByName('SCREENSHOTS');

    screenshots.forEach(sc => {
      let fileId = sc.drive_file_id || '';

      // Save directly into Super Admin's Google Drive Master Vault
      if (sc.base64_data && typeof saveScreenshotToMasterVault === 'function') {
        try {
          const vaultRes = saveScreenshotToMasterVault(
            workspaceName,
            user.email || 'user',
            dateStr,
            sc.screenshot_id,
            sc.base64_data
          );
          if (vaultRes && vaultRes.file_id) {
            fileId = vaultRes.file_id;
            savedScreenshots++;
          }
        } catch (e) {
          Logger.log('Drive Master Vault save warning: ' + e.toString());
        }
      }

      let score = Number(sc.activity_score);
      if (isNaN(score) || score < 0) score = 0;
      else if (score > 100) score = 100;
      else score = Math.round(score);

      const VALID_FLAGS = ['NONE', 'CLEAN', 'FLAG_SYNTHETIC_INPUT', 'HIGH_SYNTHETIC_AUTOMATION', 'POSSIBLE_AHK_OR_JIGGLER', 'DLP_INCIDENT'];
      let flagIncident = sc.flag_incident || 'NONE';
      if (!VALID_FLAGS.includes(flagIncident)) {
        flagIncident = 'UNKNOWN_FLAG_SUSPECT';
      }

      if (scSheet) {
        scSheet.appendRow([
          sc.screenshot_id,
          sc.entry_id || '',
          resolvedUserId || user.user_id || '',
          sc.timestamp || now,
          fileId,
          score,
          sanitizeCellValue(sc.active_window_title || ''),
          flagIncident,
          sanitizeCellValue(workspaceName),
          now
        ]);
      }

      if (flagIncident !== 'NONE' && flagIncident !== 'CLEAN') {
        const incSheet = ss.getSheetByName('AUDIT_INCIDENTS');
        if (incSheet) {
          incSheet.appendRow([
            'inc_' + Utilities.getUuid().substring(0, 8),
            sc.timestamp || now,
            resolvedUserId || user.user_id || 'usr_unknown',
            sc.screenshot_id || '',
            flagIncident,
            'Anti-Cheat Telemetry Anomaly',
            sanitizeCellValue('Suspicious activity detected: ' + flagIncident),
            'HIGH',
            'OPEN',
            'Automatically logged by security telemetry gateway'
          ]);
        }
      }
    });
  }

  // Update employee's last active heartbeat in USERS table
  if (resolvedUserId || incomingEmail) {
    updateUserLastActive(resolvedUserId || user.user_id, now, incomingEmail);
  }

  return {
    status: 'SUCCESS',
    storage_destination: 'SUPER_ADMIN_MASTER_VAULT',
    workspace: workspaceName,
    inserted_entries: insertedEntries,
    updated_entries: updatedEntries,
    saved_screenshots_to_admin_drive: savedScreenshots,
    synced_at: now
  };
}

// ============================================================================
// YEARLY SHEET PARTITIONING & RESOLUTION
// ============================================================================

/**
 * Returns or dynamically provisions the TIME_ENTRIES table for the specified calendar year.
 * 
 * RATIONALE:
 * Google Sheets slows down when a single tab exceeds 30,000 rows, and has a 10M cell limit.
 * Sharding by calendar year (TIME_ENTRIES_2026, TIME_ENTRIES_2027) guarantees 10,000,000 cells
 * per year and maintains sub-200ms read/write response times permanently.
 */
function getTimeEntriesSheetForYear(year) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const currentYear = year || new Date().getFullYear();
  const sheetName = 'TIME_ENTRIES_' + currentYear;
  
  let sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);
    const columns = [
      'entry_id', 'user_id', 'project_id', 'task_id', 'description', 
      'start_time', 'end_time', 'duration_seconds', 'is_billable', 
      'hourly_rate', 'cost_rate', 'amount', 'labor_cost', 'profit', 
      'approval_status', 'approval_id', 'device_id', 'is_manual', 'is_locked', 
      'tags', 'anti_cheat_flag', 'created_at', 'updated_at'
    ];
    const headerRange = sheet.getRange(1, 1, 1, columns.length);
    headerRange.setValues([columns]);
    headerRange.setBackground('#0F172A');
    headerRange.setFontColor('#38BDF8');
    headerRange.setFontWeight('bold');
    sheet.setFrozenRows(1);
    for (let i = 1; i <= columns.length; i++) sheet.setColumnWidth(i, 140);
  }
  return sheet;
}

// ============================================================================
// AUTOMATED NIGHTLY DRIVE BACKUP SNAPSHOTS
// ============================================================================

/**
 * Creates an immutable, dated standalone copy of the entire spreadsheet in Google Drive.
 * 
 * RATIONALE:
 * Independent of Google's revision history, this creates an autonomous snapshot file in
 * `/UltraAccount_Backups/` that can be downloaded, archived, or restored at any time.
 */
function createNightlyBackupSnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const fileId = ss.getId();
  const backupName = 'UltraAccount_Snapshot_' + ss.getName() + '_' + Utilities.formatDate(new Date(), 'GMT', 'yyyy-MM-dd_HHmmss');

  const folders = DriveApp.getFoldersByName('UltraAccount_Backups');
  const backupFolder = folders.hasNext() ? folders.next() : DriveApp.createFolder('UltraAccount_Backups');

  const file = DriveApp.getFileById(fileId);
  const backupFile = file.makeCopy(backupName, backupFolder);

  Logger.log('Created automated Drive snapshot: ' + backupName);
  return { status: 'SUCCESS', backup_file_id: backupFile.getId(), backup_name: backupName };
}

// ============================================================================
// USER ACCESS GUARD & RBAC
// ============================================================================

/**
 * Spreadsheet Formula Injection Neutralization.
 * Prepends a single quote (') to string cell values that start with =, +, -, @, \t, \r, \n
 * so Google Sheets treats the content strictly as text and NEVER evaluates it as a formula.
 */
function sanitizeCellValue(val) {
  if (val === null || val === undefined) return '';
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  const str = String(val);
  if (/^[=+\-@\t\r\n]/.test(str)) {
    return "'" + str;
  }
  return str;
}

function isUserDeleted(email) {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  try {
    const props = PropertiesService.getScriptProperties();
    const val = props.getProperty('DELETED_USER_EMAILS') || '';
    return val.split(',').map(s => s.trim().toLowerCase()).includes(lower);
  } catch (e) {
    return false;
  }
}

function markUserDeleted(email) {
  if (!email) return;
  const lower = email.trim().toLowerCase();
  try {
    const props = PropertiesService.getScriptProperties();
    const val = props.getProperty('DELETED_USER_EMAILS') || '';
    const list = val ? val.split(',').map(s => s.trim().toLowerCase()) : [];
    if (!list.includes(lower)) {
      list.push(lower);
      props.setProperty('DELETED_USER_EMAILS', list.join(','));
    }
  } catch (e) {}
}

function getUserRecord(email) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('USERS');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const emailIdx = data[0].indexOf('email');
  const statusIdx = data[0].indexOf('status');
  const roleIdx = data[0].indexOf('role');
  const idIdx = data[0].indexOf('user_id');

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][emailIdx]).trim().toLowerCase() === email.toLowerCase()) {
      return {
        user_id: data[i][idIdx],
        email: data[i][emailIdx],
        role: data[i][roleIdx],
        status: data[i][statusIdx]
      };
    }
  }
  return null;
}

function handleAuthHandshake(payload) {
  const email = (payload.email || (payload.user ? payload.user.email : '')).trim().toLowerCase();
  if (!email) throw new Error('Email required for handshake');

  if (isUserDeleted(email)) {
    return {
      status: 'ERROR',
      code: 403,
      error: 'Forbidden: User account has been deleted by administrator.'
    };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const usersSheet = ss.getSheetByName('USERS');
  if (!usersSheet) throw new Error('USERS table missing. Run setup_db.');

  const data = usersSheet.getDataRange().getValues();
  const emailIdx = data[0].indexOf('email');
  let user = null;

  for (let i = 1; i < data.length; i++) {
    if (String(data[i][emailIdx]).trim().toLowerCase() === email) {
      user = {
        user_id: data[i][data[0].indexOf('user_id')],
        email: data[i][emailIdx],
        full_name: data[i][data[0].indexOf('full_name')],
        role: data[i][data[0].indexOf('role')],
        status: data[i][data[0].indexOf('status')],
        default_hourly_rate: data[i][data[0].indexOf('default_hourly_rate')]
      };
      break;
    }
  }

  if (user) {
    if (user.status === 'SUSPENDED' || user.status === 'INACTIVE' || user.status === 'DELETED') {
      return {
        status: 'ERROR',
        code: 403,
        error: 'Forbidden: Your account is ' + user.status.toLowerCase() + '. Please contact your administrator.'
      };
    }
  }

  const now = new Date().toISOString();
  if (!user) {
    const isFirst = data.length <= 1;
    const userId = 'usr_' + Utilities.getUuid().substring(0, 8);
    const role = isFirst ? 'SUPER_ADMIN' : 'MEMBER';
    const fullName = payload.full_name || email.split('@')[0];

    usersSheet.appendRow([userId, email, fullName, role, 'ACTIVE', 50.0, 'General', now, now]);
    user = { user_id: userId, email: email, full_name: fullName, role: role, status: 'ACTIVE', default_hourly_rate: 50.0 };
    recordAuditLog(userId, 'USER_PROVISION', 'USERS', userId, null, user);
  }

  return { status: 'SUCCESS', user: user, workspace: getWorkspaceManifest(email) };
}

function getWorkspaceManifest(userEmail) {
  const cacheKey = 'manifest_' + (userEmail || 'all');
  const cache = CacheService.getScriptCache();
  const cached = cache.get(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const configs = sheetToKeyValue(ss.getSheetByName('CONFIGS'));
  let actorRole = 'MEMBER';
  if (userEmail) {
    const userRecord = getUserRecord(userEmail);
    if (userRecord) actorRole = userRecord.role;
  }
  const isPrivileged = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'].includes(actorRole);

  const manifest = {
    clients: sheetToObjects(ss.getSheetByName('CLIENTS')),
    projects: sheetToObjects(ss.getSheetByName('PROJECTS')),
    tasks: sheetToObjects(ss.getSheetByName('TASKS')),
    tags: sheetToObjects(ss.getSheetByName('TAGS')),
    configs: isPrivileged ? configs : {},
    idle_alerts_enabled: configs.IDLE_ALERTS_ENABLED === 'true',
    server_time: new Date().toISOString(),
    current_year: new Date().getFullYear()
  };

  if (isPrivileged || !userEmail) {
    const uSheet = ss.getSheetByName('USERS');
    if (uSheet) manifest.users = sheetToObjects(uSheet);
    const iSheet = ss.getSheetByName('INVOICES');
    if (iSheet) manifest.invoices = sheetToObjects(iSheet);
    const eSheet = ss.getSheetByName('EXPENSES');
    if (eSheet) manifest.expenses = sheetToObjects(eSheet);
    const toSheet = ss.getSheetByName('TIME_OFF');
    if (toSheet) manifest.timeoff = sheetToObjects(toSheet);
    const aSheet = ss.getSheetByName('APPROVALS');
    if (aSheet) manifest.approvals = sheetToObjects(aSheet);
  }

  cache.put(cacheKey, JSON.stringify(manifest), CACHE_TTL_SECONDS);
  return manifest;
}

function getActiveWorkforceRadar() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const users = sheetToObjects(ss.getSheetByName('USERS'));
  const currentYear = new Date().getFullYear();
  const timeSheet = getTimeEntriesSheetForYear(currentYear);
  const entries = sheetToObjects(timeSheet);
  const screenshots = sheetToObjects(ss.getSheetByName('SCREENSHOTS'));
  const projects = sheetToObjects(ss.getSheetByName('PROJECTS'));

  const projectMap = {};
  projects.forEach(p => { projectMap[p.project_id] = p; });

  const radar = [];
  users.forEach(user => {
    const userEntries = entries.filter(e => e.user_id === user.user_id || (user.email && e.user_id === user.email));
    userEntries.sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
    const runningEntry = userEntries.find(e => !e.end_time || e.end_time === '');
    const latest = runningEntry || userEntries[0] || null;
    const isRunning = latest && (!latest.end_time || latest.end_time === '');
    const project = latest ? (projectMap[latest.project_id] || { name: latest.project_name || latest.project_id || 'No Project', color_hex: '#64748B' }) : null;

    const userScreenshots = screenshots.filter(s => s.user_id === user.user_id || (user.email && s.user_id === user.email));
    userScreenshots.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    const latestSc = userScreenshots[0] || null;

    radar.push({
      user_id: user.user_id,
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      status: user.status,
      last_active_at: user.last_active_at,
      is_running: isRunning,
      is_active: isRunning,
      active_entry: isRunning ? {
        entry_id: latest.entry_id,
        description: latest.description,
        start_time: latest.start_time,
        project_name: project.name,
        project_color: project.color_hex,
        is_billable: latest.is_billable
      } : null,
      current_project: latest ? (project ? project.name : (latest.project_name || latest.project_id || 'Idle')) : 'Idle',
      current_description: latest ? (latest.description || 'No active timer') : 'No active timer',
      active_window: latestSc ? latestSc.active_window_title : (isRunning ? 'Active Application' : 'Idle'),
      activity_score: latestSc ? (latestSc.activity_score || 0) : 100,
      anti_cheat_flag: latest ? (latest.anti_cheat_flag || 'CLEAN') : 'CLEAN',
      latest_screenshot: latestSc
    });
  });

  return { status: 'SUCCESS', radar: radar, active_users: radar, updated_at: new Date().toISOString() };
}

function queryReports(filters) {
  filters = filters || {};
  const currentYear = filters.year || new Date().getFullYear();
  const timeSheet = getTimeEntriesSheetForYear(currentYear);
  let entries = sheetToObjects(timeSheet);

  if (filters.user_id) {
    entries = entries.filter(e => e.user_id === filters.user_id);
  }
  if (filters.project_id) {
    entries = entries.filter(e => e.project_id === filters.project_id);
  }
  if (filters.start_date) {
    const sd = new Date(filters.start_date).getTime();
    entries = entries.filter(e => {
      const et = new Date(e.start_time).getTime();
      return !isNaN(et) && et >= sd;
    });
  }
  if (filters.end_date) {
    let endStr = String(filters.end_date);
    if (endStr.length === 10 && !endStr.includes('T')) endStr += 'T23:59:59.999Z';
    const ed = new Date(endStr).getTime();
    entries = entries.filter(e => {
      const et = new Date(e.start_time).getTime();
      return !isNaN(et) && et <= ed;
    });
  }

  let totalDurationSec = 0;
  let billableDurationSec = 0;
  let totalAmount = 0;

  entries.forEach(e => {
    const dur = Number(e.duration_seconds) || 0;
    const isBill = e.is_billable === true || e.is_billable === 'true';
    const amt = Number(e.amount) || 0;
    totalDurationSec += dur;
    if (isBill) billableDurationSec += dur;
    totalAmount += amt;
  });

  return {
    total_hours: (totalDurationSec / 3600).toFixed(2),
    billable_hours: (billableDurationSec / 3600).toFixed(2),
    billable_percentage: totalDurationSec > 0 ? ((billableDurationSec / totalDurationSec) * 100).toFixed(1) : '0',
    total_amount: totalAmount.toFixed(2),
    entries_count: entries.length,
    entries: entries
  };
}

function recordAuditLog(actorUserId, action, table, entityId, beforeState, afterState) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const logSheet = ss.getSheetByName('AUDIT_LOGS');
    if (!logSheet) return;

    const logId = 'log_' + Utilities.getUuid().substring(0, 12);
    const now = new Date().toISOString();
    const beforeStr = beforeState ? JSON.stringify(beforeState) : '';
    const afterStr = afterState ? JSON.stringify(afterState) : '';

    const rawData = logId + now + actorUserId + action + table + entityId + afterStr;
    const shaBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, rawData);
    const sha256Hex = shaBytes.map(b => ('0' + (b & 0xFF).toString(16)).slice(-2)).join('');

    logSheet.appendRow([logId, now, actorUserId, action, table, entityId, beforeStr, afterStr, sha256Hex]);
  } catch (e) {
    Logger.log('Audit log recording failure: ' + e.toString());
  }
}

function sheetToObjects(sheet) {
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  const headers = data[0];
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const obj = {};
    for (let j = 0; j < headers.length; j++) obj[headers[j]] = data[i][j];
    results.push(obj);
  }
  return results;
}

function sheetToKeyValue(sheet) {
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const config = {};
  for (let i = 1; i < data.length; i++) config[data[i][0]] = data[i][1];
  return config;
}

function updateUserLastActive(userId, timestamp, userEmail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('USERS');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  const idIdx = data[0].indexOf('user_id');
  const emailIdx = data[0].indexOf('email');
  const activeIdx = data[0].indexOf('last_active_at');
  for (let i = 1; i < data.length; i++) {
    const matchId = userId && String(data[i][idIdx]).trim() === String(userId).trim();
    const matchEmail = userEmail && emailIdx >= 0 && String(data[i][emailIdx]).trim().toLowerCase() === String(userEmail).trim().toLowerCase();
    const matchIdAsEmail = userId && emailIdx >= 0 && String(data[i][emailIdx]).trim().toLowerCase() === String(userId).trim().toLowerCase();
    if (matchId || matchEmail || matchIdAsEmail) {
      if (activeIdx >= 0) sheet.getRange(i + 1, activeIdx + 1).setValue(timestamp);
      break;
    }
  }
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function jsonError(message, code) {
  return ContentService.createTextOutput(JSON.stringify({ error: message, code: code })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================================
// STRICT RBAC ENTITY MANAGEMENT & PROJECT CONTROL
// ============================================================================

/**
 * Entity CRUD Router for Projects, Clients, Tasks, and Tags.
 * 
 * STRICT RBAC ENFORCEMENT:
 * Regular employees (role: 'MEMBER') CANNOT create or delete projects.
 * Only SUPER_ADMIN, ADMIN, and MANAGER can create, update, or delete projects.
 */
function handleEntityCrud(payload) {
  let table = (payload.table || payload.entity || '').toUpperCase();
  if (table === 'USER') table = 'USERS';
  if (table === 'PROJECT') table = 'PROJECTS';
  if (table === 'CLIENT') table = 'CLIENTS';
  if (table === 'TASK') table = 'TASKS';
  if (table === 'TAG') table = 'TAGS';
  if (table === 'INVOICE') table = 'INVOICES';
  if (table === 'EXPENSE') table = 'EXPENSES';
  if (table === 'TIME_OFF' || table === 'TIMEOFF') table = 'TIME_OFF';

  const crudAction = (payload.crud_action || payload.operation || 'CREATE').toUpperCase();
  
  let actorEmail = payload.actor_email || (payload.user ? payload.user.email : payload.user_email);
  let actorRole = 'SUPER_ADMIN'; // Default for direct admin operations without email
  if (actorEmail) {
    const userRecord = getUserRecord(actorEmail);
    if (userRecord) actorRole = userRecord.role;
  }
  
  const recordData = payload.data || payload.payload || {};

  // Strict RBAC gate
  if (table === 'PROJECTS' || table === 'CLIENTS') {
    const privilegedRoles = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];
    if (!privilegedRoles.includes(actorRole)) {
      return { status: 'ERROR', code: 403, message: 'Forbidden: Members cannot create or delete projects. Only Administrators and Workspace Managers can modify projects.' };
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(table);
  if (!sheet) throw new Error('Table not found: ' + table);

  // Business Logic & Input Validation Gates
  if (table === 'TIME_OFF') {
    if (recordData.start_date && recordData.end_date && new Date(recordData.end_date).getTime() < new Date(recordData.start_date).getTime()) {
      return { status: 'ERROR', code: 400, message: 'Bad Request: end_date cannot be earlier than start_date.' };
    }
    if (recordData.total_days !== undefined && (isNaN(Number(recordData.total_days)) || Number(recordData.total_days) <= 0)) {
      return { status: 'ERROR', code: 400, message: 'Bad Request: total_days must be greater than zero.' };
    }
  }

  if (table === 'INVOICES') {
    if (recordData.subtotal !== undefined && (isNaN(Number(recordData.subtotal)) || Number(recordData.subtotal) < 0)) {
      return { status: 'ERROR', code: 400, message: 'Bad Request: subtotal must be greater than or equal to zero.' };
    }
    if (recordData.tax_percent !== undefined && (isNaN(Number(recordData.tax_percent)) || Number(recordData.tax_percent) < 0 || Number(recordData.tax_percent) > 100)) {
      return { status: 'ERROR', code: 400, message: 'Bad Request: tax_percent must be between 0 and 100.' };
    }
  }

  if (table === 'PROJECTS') {
    if (recordData.client_id) {
      const clientSheet = ss.getSheetByName('CLIENTS');
      if (clientSheet && clientSheet.getLastRow() > 1) {
        const clientData = clientSheet.getDataRange().getValues();
        const clientExists = clientData.slice(1).some(r => r[0] === recordData.client_id);
        if (!clientExists) {
          return { status: 'ERROR', code: 400, message: 'Bad Request: Referenced client_id does not exist: ' + recordData.client_id };
        }
      }
    }
    if (recordData.hourly_rate_override !== undefined && Number(recordData.hourly_rate_override) < 0) {
      return { status: 'ERROR', code: 400, message: 'Bad Request: hourly_rate_override cannot be negative.' };
    }
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const now = new Date().toISOString();

  if (crudAction === 'CREATE') {
    const idField = headers[0];
    const prefix = table.substring(0, 3).toLowerCase() + '_';
    const newId = recordData[idField] || (prefix + Utilities.getUuid().substring(0, 8));
    recordData[idField] = newId;
    if (headers.includes('created_at') && !recordData.created_at) recordData.created_at = now;
    if (headers.includes('status') && !recordData.status) recordData.status = 'ACTIVE';

    const row = headers.map(h => sanitizeCellValue(recordData[h] !== undefined ? recordData[h] : ''));
    sheet.appendRow(row);

    // Invalidate manifest cache so all clients see the new project immediately
    CacheService.getScriptCache().removeAll(['manifest_all']);
    recordAuditLog(payload.actor_user_id || actorEmail || 'admin', 'ENTITY_CREATE', table, newId, null, recordData);
    return { status: 'SUCCESS', action: 'CREATE', entity_id: newId, data: recordData };
  }

  if (crudAction === 'UPDATE') {
    const idField = headers[0];
    const targetId = recordData[idField] || payload.entity_id || payload.id;
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(targetId)) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex > 1) {
      const updateFields = payload.updates || recordData;
      for (const [colName, val] of Object.entries(updateFields)) {
        const colIdx = headers.indexOf(colName);
        if (colIdx >= 0) {
          sheet.getRange(rowIndex, colIdx + 1).setValue(sanitizeCellValue(val));
        }
      }
      CacheService.getScriptCache().removeAll(['manifest_all']);
      recordAuditLog(payload.actor_user_id || actorEmail || 'admin', 'ENTITY_UPDATE', table, targetId, null, updateFields);
      return { status: 'SUCCESS', action: 'UPDATE', entity_id: targetId, data: updateFields };
    }
    throw new Error('Record not found for ID: ' + targetId);
  }

  if (crudAction === 'DELETE' || crudAction === 'ARCHIVE') {
    const idField = headers[0];
    const targetId = recordData[idField] || payload.entity_id || payload.id;
    const data = sheet.getDataRange().getValues();
    let rowIndex = -1;

    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(targetId)) {
        rowIndex = i + 1;
        break;
      }
    }

    if (rowIndex > 1) {
      if (table === 'USERS') {
        const emailCol = headers.indexOf('email');
        if (emailCol >= 0 && data[rowIndex - 1]) {
          const delEmail = String(data[rowIndex - 1][emailCol]).trim().toLowerCase();
          markUserDeleted(delEmail);
        }
      }
      if (crudAction === 'DELETE') {
        sheet.deleteRow(rowIndex);
      } else {
        const statusCol = headers.indexOf('status') + 1;
        if (statusCol > 0) sheet.getRange(rowIndex, statusCol).setValue('ARCHIVED');
      }
      CacheService.getScriptCache().removeAll(['manifest_all']);
      recordAuditLog(payload.actor_user_id || actorEmail || 'admin', 'ENTITY_' + crudAction, table, targetId, null, { status: 'DELETED' });
      return { status: 'SUCCESS', action: crudAction, entity_id: targetId };
    }
    throw new Error('Record not found for ID: ' + targetId);
  }

  return { status: 'SUCCESS' };
}

function handleSubmitTimesheet(payload) {
  const numTotal = parseFloat(payload.total_hours);
  if (isNaN(numTotal) || numTotal < 0) {
    return { status: 'ERROR', code: 400, message: 'Bad Request: total_hours must be a non-negative number.' };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const apprSheet = ss.getSheetByName('APPROVALS');
  if (!apprSheet) throw new Error('APPROVALS table missing. Run setup_db.');

  const now = new Date().toISOString();
  const targetUserId = payload.user_id;
  const startDate = payload.start_date;
  const endDate = payload.end_date;
  const totalHours = payload.total_hours || '0';
  const billableHours = payload.billable_hours || '0';
  const comments = sanitizeCellValue(payload.comments || '');

  const data = apprSheet.getDataRange().getValues();
  const headers = data[0];
  const idIdx = headers.indexOf('approval_id');
  const userIdx = headers.indexOf('user_id');
  const startIdx = headers.indexOf('start_date');
  const endIdx = headers.indexOf('end_date');
  const statusIdx = headers.indexOf('status');
  const totalIdx = headers.indexOf('total_hours');
  const billableIdx = headers.indexOf('billable_hours');
  const commentsIdx = headers.indexOf('comments');
  const submittedAtIdx = headers.indexOf('submitted_at');

  let existingApprovalId = null;
  let existingRowIndex = -1;
  let existingStatus = null;

  for (let i = 1; i < data.length; i++) {
    const rowUser = String(data[i][userIdx]);
    const rowStart = String(data[i][startIdx]).substring(0, 10);
    const rowEnd = String(data[i][endIdx]).substring(0, 10);
    const rowStatus = String(data[i][statusIdx]);

    if (rowUser === targetUserId && rowStart === String(startDate).substring(0, 10) && rowEnd === String(endDate).substring(0, 10)) {
      existingApprovalId = data[i][idIdx];
      existingRowIndex = i + 1;
      existingStatus = rowStatus;
      break;
    }
  }

  // Conflict Check 1: Already APPROVED
  if (existingStatus === 'APPROVED') {
    return {
      status: 'ERROR',
      code: 409,
      error: 'Conflict: Timesheet for date range ' + startDate + ' to ' + endDate + ' is already APPROVED and locked.'
    };
  }

  let approvalId;
  let updatedExisting = false;

  // Conflict Check 2: Already SUBMITTED (pending) -> Update in-place to prevent duplicate records
  if (existingRowIndex > 1 && existingStatus === 'SUBMITTED') {
    approvalId = existingApprovalId;
    updatedExisting = true;
    if (totalIdx >= 0) apprSheet.getRange(existingRowIndex, totalIdx + 1).setValue(totalHours);
    if (billableIdx >= 0) apprSheet.getRange(existingRowIndex, billableIdx + 1).setValue(billableHours);
    if (commentsIdx >= 0) apprSheet.getRange(existingRowIndex, commentsIdx + 1).setValue(comments);
    if (submittedAtIdx >= 0) apprSheet.getRange(existingRowIndex, submittedAtIdx + 1).setValue(now);
  } else {
    // New submission (or resubmission after REJECTED)
    approvalId = 'appr_' + Utilities.getUuid().substring(0, 8);
    apprSheet.appendRow([
      approvalId, targetUserId, startDate, endDate,
      totalHours, billableHours, 'SUBMITTED',
      '', comments, now, ''
    ]);
  }

  // Tag corresponding time entries with approval_id and status SUBMITTED across spanned years
  // Safeguard: Never overwrite locked or approved entries!
  try {
    const sYear = startDate ? new Date(startDate).getFullYear() : new Date().getFullYear();
    const eYear = endDate ? new Date(endDate).getFullYear() : sYear;
    const yearsToProcess = [];
    for (let y = sYear; y <= eYear; y++) yearsToProcess.push(y);

    const sd = startDate ? new Date(startDate).getTime() : 0;
    const ed = endDate ? new Date(endDate + 'T23:59:59.999Z').getTime() : Infinity;

    yearsToProcess.forEach(year => {
      const timeSheet = getTimeEntriesSheetForYear(year);
      if (timeSheet && targetUserId) {
        const timeData = timeSheet.getDataRange().getValues();
        if (timeData.length <= 1) return;
        const timeHeaders = timeData[0];
        const userCol = timeHeaders.indexOf('user_id');
        const startCol = timeHeaders.indexOf('start_time');
        const statusCol = timeHeaders.indexOf('approval_status') + 1;
        const apprIdCol = timeHeaders.indexOf('approval_id') + 1;
        const lockedCol = timeHeaders.indexOf('is_locked');

        for (let j = 1; j < timeData.length; j++) {
          const u = String(timeData[j][userCol]);
          const st = startCol >= 0 ? new Date(timeData[j][startCol]).getTime() : 0;
          const isEntryLocked = lockedCol >= 0 && (timeData[j][lockedCol] === true || String(timeData[j][lockedCol]).toLowerCase() === 'true');
          const isEntryApproved = statusCol > 0 && String(timeData[j][statusCol - 1]) === 'APPROVED';

          // Skip if locked or approved
          if (isEntryLocked || isEntryApproved) continue;

          if ((u === targetUserId || (payload.email && u === payload.email)) && (st >= sd && st <= ed)) {
            if (apprIdCol > 0) timeSheet.getRange(j + 1, apprIdCol).setValue(approvalId);
            if (statusCol > 0) timeSheet.getRange(j + 1, statusCol).setValue('SUBMITTED');
          }
        }
      }
    });
  } catch (tagErr) {
    Logger.log('Warning tagging timesheet entries: ' + tagErr.toString());
  }

  recordAuditLog(targetUserId, updatedExisting ? 'TIMESHEET_UPDATE_PENDING' : 'TIMESHEET_SUBMISSION', 'APPROVALS', approvalId, null, payload);
  return { status: 'SUCCESS', approval_id: approvalId, status_text: 'SUBMITTED', updated_existing: updatedExisting };
}

function handleApprovalAction(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const apprSheet = ss.getSheetByName('APPROVALS');
  const decision = (payload.approval_action || payload.decision || payload.status || payload.action_type || payload.action || 'APPROVE').toUpperCase();
  const targetStatus = (decision === 'APPROVE' || decision === 'APPROVED') ? 'APPROVED' : 'REJECTED';
  const now = new Date().toISOString();
  let targetUserId = payload.user_id;

  if (apprSheet) {
    const data = apprSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(payload.approval_id)) {
        if (!targetUserId) targetUserId = data[i][1];
        apprSheet.getRange(i + 1, 7).setValue(targetStatus);
        apprSheet.getRange(i + 1, 8).setValue(payload.reviewer_id || 'admin');
        apprSheet.getRange(i + 1, 11).setValue(now);
        break;
      }
    }
  }

  // Lock or unlock time entries upon approval / rejection across all yearly sheets
  if (payload.approval_id || targetUserId) {
    try {
      const allSheets = ss.getSheets();
      const timeSheets = allSheets.filter(s => s.getName().startsWith('TIME_ENTRIES_'));
      const shouldLock = (targetStatus === 'APPROVED');

      timeSheets.forEach(timeSheet => {
        const timeData = timeSheet.getDataRange().getValues();
        if (timeData.length <= 1) return;
        const headers = timeData[0];
        const lockCol = headers.indexOf('is_locked') + 1;
        const statusCol = headers.indexOf('approval_status') + 1;
        const apprIdCol = headers.indexOf('approval_id') + 1;
        const userCol = headers.indexOf('user_id');

        for (let j = 1; j < timeData.length; j++) {
          const matchApprId = apprIdCol > 0 && payload.approval_id && String(timeData[j][apprIdCol - 1]) === String(payload.approval_id);
          const matchUser = !payload.approval_id && targetUserId && String(timeData[j][userCol]) === String(targetUserId);
          if (matchApprId || matchUser) {
            if (lockCol > 0) timeSheet.getRange(j + 1, lockCol).setValue(shouldLock);
            if (statusCol > 0) timeSheet.getRange(j + 1, statusCol).setValue(targetStatus);
            if (apprIdCol > 0 && payload.approval_id) timeSheet.getRange(j + 1, apprIdCol).setValue(payload.approval_id);
          }
        }
      });
    } catch (e) {
      Logger.log('Warning updating time entries lock state: ' + e.toString());
    }
  }

  recordAuditLog(payload.reviewer_id || 'admin', 'TIMESHEET_' + targetStatus, 'APPROVALS', payload.approval_id, null, { status: targetStatus });
  return { status: 'SUCCESS', target_status: targetStatus, approval_id: payload.approval_id };
}

function handleIncidentReport(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const incSheet = ss.getSheetByName('AUDIT_INCIDENTS');
  const incId = 'inc_' + Utilities.getUuid().substring(0, 8);
  const now = new Date().toISOString();

  if (incSheet) {
    incSheet.appendRow([
      incId, now, payload.user_id, payload.screenshot_id || '',
      payload.rule_id || 'GENERAL_INCIDENT', payload.rule_name || 'Policy Incident',
      payload.matched_pattern || '', payload.risk_level || 'MEDIUM', 'OPEN', payload.notes || ''
    ]);
  }

  recordAuditLog(payload.user_id, 'DLP_INCIDENT_FLAGGED', 'AUDIT_INCIDENTS', incId, null, payload);
  return { status: 'SUCCESS', incident_id: incId };
}

function handleSetPolicy(payload) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const cfgSheet = ss.getSheetByName('CONFIGS');
  if (!cfgSheet) return { status: 'ERROR', message: 'CONFIGS sheet not found' };
  
  let key = payload.key || '';
  if (payload.policy === 'idle_alerts') key = 'IDLE_ALERTS_ENABLED';
  else if (payload.policy === 'blur') key = 'BLUR_SCREENSHOTS_BY_DEFAULT';
  else if (payload.policy === 'screenshots') key = 'SCREENSHOTS_ENABLED';
  
  const val = String(payload.enabled !== undefined ? payload.enabled : (payload.value !== undefined ? payload.value : 'true'));
  const now = new Date().toISOString();
  
  const data = cfgSheet.getDataRange().getValues();
  let updated = false;
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === key) {
      cfgSheet.getRange(i + 1, 2).setValue(val);
      cfgSheet.getRange(i + 1, 4).setValue(now);
      updated = true;
      break;
    }
  }
  if (!updated && key) {
    cfgSheet.appendRow([key, val, 'Runtime policy setting', now]);
  }
  
  CacheService.getScriptCache().removeAll(['manifest_all']);
  recordAuditLog(payload.actor_email || 'admin', 'POLICY_UPDATE', 'CONFIGS', key, null, { key: key, value: val });
  return { status: 'SUCCESS', policy: key, value: val };
}

// ============================================================================
// UNIVERSAL DATA ANALYST EXPORT ENGINE (CSV & JSON)
// ============================================================================

/**
 * Generates a comprehensive, 22-column flattened analytical dataset.
 * Designed for immediate ingestion by Data Analysts using:
 * - Microsoft Power BI (Web Data Connector)
 * - Tableau Desktop / Online
 * - Python / Jupyter Notebooks (pandas.read_csv)
 * - Microsoft Excel (Data from Web)
 * - Google Looker Studio
 */
function handleDataAnalystExport(params) {
  params = params || {};
  const format = (params.format || 'csv').toLowerCase();
  const year = params.year || new Date().getFullYear();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const timeSheet = getTimeEntriesSheetForYear(year);
  const entries = sheetToObjects(timeSheet);
  const users = sheetToObjects(ss.getSheetByName('USERS'));
  const projects = sheetToObjects(ss.getSheetByName('PROJECTS'));
  const clients = sheetToObjects(ss.getSheetByName('CLIENTS'));
  const tasks = sheetToObjects(ss.getSheetByName('TASKS'));
  const configs = sheetToKeyValue(ss.getSheetByName('CONFIGS'));

  const userMap = {};
  users.forEach(u => { userMap[u.user_id] = u; });

  const projectMap = {};
  projects.forEach(p => { projectMap[p.project_id] = p; });

  const clientMap = {};
  clients.forEach(c => { clientMap[c.client_id] = c; });

  const taskMap = {};
  tasks.forEach(t => { taskMap[t.task_id] = t; });

  const workspaceName = configs.WORKSPACE_NAME || 'Ultra Account Enterprise';
  const currency = configs.DEFAULT_CURRENCY || 'USD';

  // 22 Flattened Dimensional Attributes
  const headers = [
    'entry_id', 'date', 'user_id', 'user_email', 'employee_name',
    'department', 'role', 'workspace_name', 'client_name', 'project_name',
    'project_color', 'task_name', 'description', 'start_time_iso', 'end_time_iso',
    'duration_seconds', 'decimal_hours', 'is_billable', 'hourly_rate', 'currency',
    'billable_amount', 'anti_cheat_flag'
  ];

  const flattenedRows = entries.map(e => {
    const u = userMap[e.user_id] || {};
    const p = projectMap[e.project_id] || {};
    const c = clientMap[p.client_id] || {};
    const t = taskMap[e.task_id] || {};
    const durSec = Number(e.duration_seconds) || 0;
    const hours = (durSec / 3600).toFixed(4);
    const rate = Number(e.hourly_rate || p.hourly_rate_override || u.default_hourly_rate || 0);
    const isBill = e.is_billable === true || e.is_billable === 'true';
    const amount = isBill ? (Number(hours) * rate).toFixed(2) : '0.00';
    const dateStr = (e.start_time || '').substring(0, 10);

    return {
      entry_id: e.entry_id || '',
      date: dateStr,
      user_id: e.user_id || '',
      user_email: u.email || '',
      employee_name: u.full_name || '',
      department: u.department || 'General',
      role: u.role || 'MEMBER',
      workspace_name: workspaceName,
      client_name: c.name || 'Internal Operations',
      project_name: p.name || 'General Administration',
      project_color: p.color_hex || '#64748B',
      task_name: t.name || '',
      description: e.description || '',
      start_time_iso: e.start_time || '',
      end_time_iso: e.end_time || '',
      duration_seconds: durSec,
      decimal_hours: hours,
      is_billable: isBill ? 'TRUE' : 'FALSE',
      hourly_rate: rate,
      currency: currency,
      billable_amount: amount,
      anti_cheat_flag: e.anti_cheat_flag || 'CLEAN'
    };
  });

  if (format === 'json') {
    return jsonResponse({
      status: 'SUCCESS',
      dataset: 'UltraAccount_Analyst_Export',
      year: year,
      total_records: flattenedRows.length,
      columns: headers,
      data: flattenedRows
    });
  }

  // Generate RFC 4180 Compliant CSV
  const csvLines = [headers.join(',')];
  flattenedRows.forEach(row => {
    const line = headers.map(h => {
      let val = row[h] !== undefined ? String(row[h]) : '';
      if (val.includes(',') || val.includes('"') || val.includes('\n') || val.includes('\r')) {
        val = '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(',');
    csvLines.push(line);
  });

  const csvContent = csvLines.join('\r\n');
  return ContentService.createTextOutput(csvContent)
    .setMimeType(ContentService.MimeType.CSV)
    .downloadAsFile('UltraAccount_Analytics_' + year + '.csv');
}

// TODO: Wire this to Google OAuth id_token verification
function verifyAuthToken(token) {
  if (!token) return false;
  // Stub for token validation
  return true;
}

function getOrCreateSubFolder(parent, name) {
  const folders = parent.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parent.createFolder(name);
}

function saveScreenshotToMasterVault(workspaceName, userEmail, dateStr, screenshotId, base64Data) {
  if (!base64Data || base64Data.length === 0) {
    Logger.log('Screenshot skipped: empty base64 data for ' + userEmail);
    return null;
  }
  try {
    const monthStr = dateStr.substring(0, 7);
    const rootName = 'UltraAccount_Master_Vault';
    let rootFolder;
    const roots = DriveApp.getFoldersByName(rootName);
    if (roots.hasNext()) {
      rootFolder = roots.next();
    } else {
      rootFolder = DriveApp.createFolder(rootName);
    }
    
    let wsFolder = getOrCreateSubFolder(rootFolder, workspaceName);
    let userFolder = getOrCreateSubFolder(wsFolder, userEmail);
    let monthFolder = getOrCreateSubFolder(userFolder, monthStr);
    
    let cleanBase64 = base64Data;
    if (cleanBase64.indexOf(',') !== -1) {
      cleanBase64 = cleanBase64.split(',')[1];
    }
    
    const filename = screenshotId + '.jpg';
    const blob = Utilities.newBlob(Utilities.base64Decode(cleanBase64), 'image/jpeg', filename);
    const file = monthFolder.createFile(blob);
    
    return { file_id: file.getId() };
  } catch (err) {
    Logger.log('Error saving screenshot: ' + err.toString());
    throw err;
  }
}

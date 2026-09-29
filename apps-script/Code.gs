/**
 * FLINK Time — Consolidated application gateway, constants, validation, and API routing.
 * Generated from the stabilized source modules; edit this file as the authoritative gateway/core.
 */


/* ===== Errors.gs ===== */
/**
 * FLINK Time & Workforce Platform — Error Definitions
 */

const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE',
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WORKSPACE_DENIED: 'WORKSPACE_DENIED',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ACTIVE_TIMER_EXISTS: 'ACTIVE_TIMER_EXISTS',
  TIMER_NOT_FOUND: 'TIMER_NOT_FOUND',
  ENTRY_LOCKED: 'ENTRY_LOCKED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_BUSY: 'SERVER_BUSY',
  NOT_FOUND: 'NOT_FOUND',
  ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED',
  CRYPTO_FAILURE: 'CRYPTO_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        details: this.details
      }
    };
  }
}

/* ===== Constants.gs ===== */
/**
 * FLINK Time & Workforce Platform — System Constants & Schema Specifications
 * Obeying strict Google Workspace constraints:
 * - Master Control Sheet Schema (18 Tabs)
 * - Workspace Sheet Schema (20 Tabs)
 * - 3-Role RBAC Model (SUPER_ADMIN, ADMIN, USER)
 * - Admin Max 3 Active Workspaces
 */

const CONSTANTS = {
  VERSION: '1.0.0',
  SCHEMA_VERSION: 1,

  ROLES: {
    SUPER_ADMIN: 'SUPER_ADMIN',
    ADMIN: 'ADMIN',
    USER: 'USER'
  },

  ACCOUNT_STATUS: {
    ACTIVE: 'ACTIVE',
    PASSIVE: 'PASSIVE',
    LOCKED: 'LOCKED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED'
  },

  WORKSPACE_STATUS: {
    ACTIVE: 'ACTIVE',
    SUSPENDED: 'SUSPENDED',
    MAINTENANCE: 'MAINTENANCE',
    ARCHIVED: 'ARCHIVED'
  },

  REQUEST_TYPES: {
    NEW_USER: 'NEW_USER',
    MAKE_PASSIVE: 'MAKE_PASSIVE',
    PASSWORD_RESET: 'PASSWORD_RESET',
    PROFILE_CHANGE: 'PROFILE_CHANGE',
    OTHER_ADMIN_REQUEST: 'OTHER_ADMIN_REQUEST'
  },

  REQUEST_STATUS: {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    CANCELLED: 'CANCELLED',
    EXECUTED: 'EXECUTED'
  },

  TIMESHEET_STATUS: {
    OPEN: 'OPEN',
    SUBMITTED: 'SUBMITTED',
    APPROVED: 'APPROVED',
    REJECTED: 'REJECTED',
    LOCKED: 'LOCKED'
  },

  // Canonical timesheet state machine. LOCKED remains a legacy/storage value
  // but is not a valid workflow transition target.
  TIMESHEET_TRANSITIONS: {
    OPEN: ['SUBMITTED'],
    REJECTED: ['SUBMITTED'],
    SUBMITTED: ['APPROVED', 'REJECTED'],
    APPROVED: ['OPEN']
  },

  ENTRY_SOURCE: {
    WEB: 'WEB',
    PORTABLE_WINDOWS: 'PORTABLE_WINDOWS',
    MANUAL: 'MANUAL',
    OFFLINE_SYNC: 'OFFLINE_SYNC'
  },

  AUDIT_EVENTS: {
    LOGIN_SUCCESS: 'LOGIN_SUCCESS',
    LOGIN_FAIL: 'LOGIN_FAIL',
    ACCOUNT_LOCK: 'ACCOUNT_LOCK',
    LOGIN_THROTTLED: 'LOGIN_THROTTLED',
    IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
    PASSWORD_RESET: 'PASSWORD_RESET',
    PASSWORD_CHANGED: 'PASSWORD_CHANGED',
    USER_CREATED: 'USER_CREATED',
    USER_PASSIVE: 'USER_PASSIVE',
    USER_ACTIVATED: 'USER_ACTIVATED',
    USER_DELETED: 'USER_DELETED',
    WORKSPACE_CREATED: 'WORKSPACE_CREATED',
    WORKSPACE_UPDATED: 'WORKSPACE_UPDATED',
    ADMIN_ASSIGNED: 'ADMIN_ASSIGNED',
    ADMIN_REMOVED: 'ADMIN_REMOVED',
    REQUEST_SUBMITTED: 'REQUEST_SUBMITTED',
    REQUEST_REVIEWED: 'REQUEST_REVIEWED',
    REQUEST_EXECUTED: 'REQUEST_EXECUTED',
    TIMER_STARTED: 'TIMER_STARTED',
    TIMER_STOPPED: 'TIMER_STOPPED',
    ENTRY_CREATED: 'ENTRY_CREATED',
    ENTRY_UPDATED: 'ENTRY_UPDATED',
    ENTRY_DELETED: 'ENTRY_DELETED',
    TIMESHEET_SUBMITTED: 'TIMESHEET_SUBMITTED',
    TIMESHEET_APPROVED: 'TIMESHEET_APPROVED',
    TIMESHEET_REJECTED: 'TIMESHEET_REJECTED',
    TIMESHEET_REOPENED: 'TIMESHEET_REOPENED',
    PROJECT_CREATED: 'PROJECT_CREATED',
    PROJECT_UPDATED: 'PROJECT_UPDATED',
    USER_ASSIGNED: 'USER_ASSIGNED',
    MFA_ENROLLED: 'MFA_ENROLLED',
    MFA_VERIFIED: 'MFA_VERIFIED',
    MFA_DISABLED: 'MFA_DISABLED',
    ACCOUNT_UNLOCKED: 'ACCOUNT_UNLOCKED',
    SETTINGS_CHANGED: 'SETTINGS_CHANGED',
    EXPORT_CREATED: 'EXPORT_CREATED',
    BACKUP_CREATED: 'BACKUP_CREATED',
    RESTORE_EXECUTED: 'RESTORE_EXECUTED'
  },

  LIMITS: {
    ADMIN_MAX_ACTIVE_WORKSPACES: 3,
    MAX_FAILED_LOGIN_ATTEMPTS: 5,
    LOCKOUT_DURATION_MINUTES: 15,
    LOGIN_RETRY_DELAYS_SECONDS: [0, 2, 5, 15, 30],
    SESSION_IDLE_TIMEOUT_HOURS: 8,
    SESSION_ABSOLUTE_TIMEOUT_HOURS: 24,
    SESSION_TOUCH_INTERVAL_MINUTES: 5,
    MIN_PASSWORD_LENGTH: 12,
    MAX_PASSWORD_LENGTH: 128,
    MAX_SINGLE_ENTRY_HOURS: 24,
    DASHBOARD_LIVE_WINDOW_SECONDS: 60,
    SESSION_RETENTION_DAYS: 30
  },

  SECURITY: {
    PBKDF2_ITERATIONS: 10000,
    PBKDF2_KEY_BYTES: 32,
    SALT_BYTES: 16,
    TOKEN_BYTES: 32,
    PEPPER_PROPERTY_KEY: 'FLINK_SECURITY_PEPPER',
    DEFAULT_PEPPER: 'FLINK_TIME_PEPPER_SECURE_2026',
    CHECKPOINT_PROPERTY_PREFIX: 'FLINK_AUDIT_CHECKPOINT_',
    AUDIT_KEY_SUFFIX: '_FLINK_AUDIT_KEY',
    SECRET_KEY_SUFFIX: '_FLINK_SECRET_KEY'
  },

  MASTER_TABS: {
    SYSTEM: 'System',
    ACCOUNTS: 'Accounts',
    CREDENTIALS: 'Credentials',
    WORKSPACES: 'Workspaces',
    WORKSPACE_ACCESS: 'WorkspaceAccess',
    REQUESTS: 'Requests',
    SESSIONS: 'Sessions',
    GLOBAL_SETTINGS: 'GlobalSettings',
    SAVED_REPORTS: 'SavedReports',
    SAVED_DASHBOARDS: 'SavedDashboards',
    SCHEDULED_REPORTS: 'ScheduledReports',
    SECURITY_EVENTS: 'SecurityEvents',
    GLOBAL_AUDIT: 'GlobalAudit',
    JOB_REGISTRY: 'JobRegistry',
    JOB_RUNS: 'JobRuns',
    MIGRATION_HISTORY: 'MigrationHistory',
    BACKUP_REGISTRY: 'BackupRegistry',
    SYSTEM_HEALTH_HISTORY: 'SystemHealthHistory'
  },

  WORKSPACE_TABS: {
    WORKSPACE_INFO: 'WorkspaceInfo',
    MEMBERS: 'Members',
    CLIENTS: 'Clients',
    PROJECTS: 'Projects',
    TASKS: 'Tasks',
    TAGS: 'Tags',
    USER_PROJECT_ACCESS: 'UserProjectAccess',
    ACTIVE_TIMERS: 'ActiveTimers',
    TIME_ENTRIES: 'TimeEntries',
    TIMESHEETS: 'Timesheets',
    APPROVALS: 'Approvals',
    COMMENTS: 'Comments',
    DAILY_ROLLUPS: 'DailyRollups',
    WEEKLY_ROLLUPS: 'WeeklyRollups',
    MONTHLY_ROLLUPS: 'MonthlyRollups',
    USER_ROLLUPS: 'UserRollups',
    PROJECT_ROLLUPS: 'ProjectRollups',
    ALERTS: 'Alerts',
    WORKSPACE_SETTINGS: 'WorkspaceSettings',
    AUDIT_LOG: 'AuditLog'
  },

  JOB_STATUS: {
    QUEUED: 'QUEUED',
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED',
    RETRY: 'RETRY',
    DEAD: 'DEAD'
  },

  CAPACITY: {
    MAX_CELLS_PER_SHEET: 10000000,
    ADVISORY_THRESHOLD_PCT: 60,
    WARNING_THRESHOLD_PCT: 75,
    CRITICAL_THRESHOLD_PCT: 85
  }
};

/**
 * Master Control Sheet Column Definitions (18 Tabs)
 */
const MASTER_SCHEMA = {
  System: [
    'SystemID', 'InstanceName', 'Version', 'SchemaVersion', 'InstalledAtUTC', 'UpdatedAtUTC', 'LastHealthCheckUTC', 'Status'
  ],
  Accounts: [
    'UserID', 'Username', 'DisplayName', 'Role', 'Status',
    'PrimaryWorkspaceID', 'Email', 'EmployeeCode', 'CreatedAt', 'CreatedBy',
    'UpdatedAt', 'UpdatedBy', 'LastLoginAt', 'MustChangePassword', 'Version'
  ],
  Credentials: [
    'UserID', 'PasswordHash', 'PasswordVersion', 'PasswordChangedAt',
    'FailedLoginCount', 'LastFailedAt', 'LockUntil', 'ResetIssuedAt', 'ResetExpiresAt',
    'TotpSecret', 'MfaEnabled', 'PendingTotpSecret', 'LastSuccessfulTotpStep'
  ],
  Workspaces: [
    'WorkspaceID', 'WorkspaceCode', 'WorkspaceName', 'SpreadsheetID', 'DriveFolderID',
    'Status', 'Timezone', 'SchemaVersion', 'CreatedAt', 'CreatedBy', 'ArchivedAt',
    'PartitionPolicy', 'CurrentPartition', 'Version'
  ],
  WorkspaceAccess: [
    'AccessID', 'UserID', 'WorkspaceID', 'Role', 'Active',
    'AssignedAt', 'AssignedBy', 'RemovedAt', 'Version'
  ],
  Requests: [
    'RequestID', 'RequestType', 'RequestedBy', 'WorkspaceID',
    'TargetUserID', 'RequestedDataJSON', 'Reason', 'Status',
    'RequestedAt', 'ReviewedBy', 'ReviewedAt', 'ReviewComment', 'ExecutedAt', 'Version'
  ],
  Sessions: [
    'SessionID', 'UserID', 'TokenHash', 'ClientType', 'ClientLabel',
    'CreatedAt', 'LastSeenAt', 'ExpiresAt', 'AbsoluteExpiresAt', 'Revoked', 'RevokedAt', 'RevokeReason'
  ],
  GlobalSettings: [
    'SettingKey', 'SettingValue', 'Description', 'UpdatedAt', 'UpdatedBy'
  ],
  SavedReports: [
    'ReportID', 'ReportName', 'ReportType', 'OwnerUserID', 'WorkspacesJSON',
    'GroupingsJSON', 'FiltersJSON', 'ChartType', 'CreatedAt'
  ],
  SavedDashboards: [
    'DashboardID', 'DashboardName', 'OwnerUserID', 'WidgetsJSON', 'CreatedAt', 'UpdatedAt'
  ],
  ScheduledReports: [
    'ScheduleID', 'ReportID', 'Frequency', 'RecipientsJSON', 'Format',
    'LastRunAt', 'Status', 'CreatedAt'
  ],
  SecurityEvents: [
    'EventID', 'Timestamp', 'UserID', 'Username', 'EventType', 'Success', 'MetadataJSON'
  ],
  GlobalAudit: [
    'AuditID', 'TimestampUTC', 'ActorUserID', 'ActorRole', 'WorkspaceID',
    'EntityType', 'EntityID', 'Action', 'BeforeJSON', 'AfterJSON', 'Reason', 'CorrelationID', 'ClientType',
    'PreviousHash', 'RecordHash'
  ],
  JobRegistry: [
    'JobID', 'JobType', 'WorkspaceID', 'Status', 'Cursor', 'StartedAt', 'UpdatedAt', 'RetryCount', 'NextRunAt', 'LastError'
  ],
  JobRuns: [
    'RunID', 'JobID', 'JobType', 'WorkspaceID', 'StartedAt', 'EndedAt', 'DurationMs', 'ItemsProcessed', 'Status', 'LogDetails'
  ],
  MigrationHistory: [
    'MigrationID', 'FromVersion', 'ToVersion', 'ExecutedAt', 'ExecutedBy', 'Status', 'DetailsJSON'
  ],
  BackupRegistry: [
    'BackupID', 'Scope', 'WorkspaceID', 'SourceFileID', 'BackupFileID', 'CreatedAt', 'Status', 'Verified', 'ChecksumMetadata'
  ],
  SystemHealthHistory: [
    'HealthCheckID', 'TimestampUTC', 'OverallStatus', 'MasterDbStatus', 'WorkspacesStatus', 'ActiveTimersCount', 'CellCountApprox', 'QuotaStatus', 'DetailsJSON'
  ]
};

/**
 * Workspace Sheet Column Definitions (20 Tabs)
 */
const WORKSPACE_SCHEMA = {
  WorkspaceInfo: [
    'WorkspaceID', 'WorkspaceCode', 'WorkspaceName', 'Status', 'Timezone', 'SchemaVersion', 'CreatedAt'
  ],
  Members: [
    'UserID', 'DisplayName', 'Status', 'JoinedAt', 'LeftAt',
    'Department', 'Team', 'JobTitle', 'EmployeeCode'
  ],
  Clients: [
    'ClientID', 'ClientName', 'Status', 'Notes', 'CreatedAt'
  ],
  Projects: [
    'ProjectID', 'ClientID', 'ProjectName', 'Code', 'Status',
    'BillableDefault', 'HourlyRate', 'CostRate', 'EstimateHours',
    'BudgetAmount', 'StartDate', 'EndDate', 'ColorKey', 'Notes'
  ],
  Tasks: [
    'TaskID', 'ProjectID', 'TaskName', 'Status', 'EstimateHours',
    'BillableDefault', 'SortOrder'
  ],
  Tags: [
    'TagID', 'TagName', 'Status', 'Category'
  ],
  UserProjectAccess: [
    'UserID', 'ProjectID', 'CanTrack', 'AssignedAt'
  ],
  ActiveTimers: [
    'TimerID', 'UserID', 'ProjectID', 'TaskID', 'Description',
    'TagIDs', 'StartedAtUTC', 'StartedAtLocal', 'Billable', 'Source', 'LastHeartbeat'
  ],
  TimeEntries: [
    'EntryID', 'UserID', 'ProjectID', 'TaskID', 'Description', 'Tags',
    'StartUTC', 'EndUTC', 'DurationSeconds', 'Billable',
    'HourlyRateSnapshot', 'CostRateSnapshot', 'EntrySource', 'ManualEntry',
    'Status', 'ApprovalStatus', 'TimesheetID', 'Locked',
    'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy', 'Version'
  ],
  Timesheets: [
    'TimesheetID', 'UserID', 'PeriodStart', 'PeriodEnd', 'TotalSeconds',
    'Status', 'SubmittedAt', 'ReviewedBy', 'ReviewedAt', 'ReviewComment', 'LockedAt',
    'EntrySnapshotJSON'
  ],
  Approvals: [
    'ApprovalID', 'TimesheetID', 'UserID', 'Action', 'ActorUserID',
    'ActorRole', 'TimestampUTC', 'Comment', 'SnapshotTotalSeconds'
  ],
  Comments: [
    'CommentID', 'EntityType', 'EntityID', 'UserID', 'CommentText', 'CreatedAt'
  ],
  DailyRollups: [
    'RollupDate', 'UserID', 'ProjectID', 'TotalSeconds', 'BillableSeconds',
    'CostAmount', 'BillableAmount', 'EntryCount', 'LastCalculatedAt'
  ],
  WeeklyRollups: [
    'WeekStart', 'WeekEnd', 'UserID', 'ProjectID', 'TotalSeconds',
    'BillableSeconds', 'CostAmount', 'BillableAmount', 'EntryCount', 'LastCalculatedAt'
  ],
  MonthlyRollups: [
    'MonthKey', 'UserID', 'ProjectID', 'TotalSeconds', 'BillableSeconds',
    'CostAmount', 'BillableAmount', 'EntryCount', 'LastCalculatedAt'
  ],
  ProjectRollups: [
    'ProjectID', 'TotalSeconds', 'BillableSeconds', 'RemainingHours',
    'TotalCost', 'TotalRevenue', 'ContributorCount', 'LastCalculatedAt'
  ],
  UserRollups: [
    'UserID', 'MonthKey', 'TrackedSeconds', 'TargetSeconds', 'UtilizationPct',
    'OvertimeSeconds', 'MissingSeconds', 'LastCalculatedAt'
  ],
  Alerts: [
    'AlertID', 'AlertType', 'Severity', 'TriggeredAt', 'Message', 'Resolved', 'ResolvedAt', 'ResolvedBy'
  ],
  WorkspaceSettings: [
    'SettingKey', 'SettingValue', 'Description', 'UpdatedAt', 'UpdatedBy'
  ],
  AuditLog: [
    'AuditID', 'TimestampUTC', 'ActorUserID', 'ActorRole', 'EntityType',
    'EntityID', 'Action', 'BeforeJSON', 'AfterJSON', 'Reason', 'ClientType',
    'PreviousHash', 'RecordHash'
  ]
};

/* ===== Validation.gs ===== */
/**
 * FLINK Time & Workforce Platform — Input Validation & Sanitization
 */

const Validation = {
  /**
   * Spreadsheet Formula Injection Defense
   * Neutralizes formula execution by prepending a single quote if the string starts with =, +, -, @, tab, or newline.
   */
  sanitizeCellValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    const str = String(val);
    if (/^[=+\-@\t\r\n]/.test(str)) {
      return "'" + str;
    }
    return str;
  },

  /**
   * Sanitizes all string values within an object or array
   */
  sanitizeRow(row) {
    if (Array.isArray(row)) {
      return row.map(v => Validation.sanitizeCellValue(v));
    }
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      clean[k] = Validation.sanitizeCellValue(v);
    }
    return clean;
  },

  validateUsername(username) {
    if (!username || typeof username !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username is required and must be a string.');
    }
    const trimmed = username.trim().toLowerCase();
    if (trimmed.length < 3 || trimmed.length > 50) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username must be between 3 and 50 characters.');
    }
    if (!/^[a-z0-9_.\-]+$/.test(trimmed)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username may only contain letters, numbers, underscores, dashes, and periods.');
    }
    return trimmed;
  },

  validateEmail(email) {
    if (!email || typeof email !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Email is required.');
    }
    const normalized = email.trim().toLowerCase();
    if (
      normalized.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    ) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A valid email address is required.');
    }
    return normalized;
  },

  validatePassword(password) {
    if (!password || typeof password !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password is required.');
    }
    if (password.length < CONSTANTS.LIMITS.MIN_PASSWORD_LENGTH) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Password must be at least ${CONSTANTS.LIMITS.MIN_PASSWORD_LENGTH} characters long.`);
    }
    if (password.length > CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Password cannot exceed ${CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH} characters.`);
    }
    // Complexity: require at least one uppercase, one lowercase, one digit, one special character
    if (!/[A-Z]/.test(password)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password must contain at least one uppercase letter.');
    }
    if (!/[a-z]/.test(password)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password must contain at least one lowercase letter.');
    }
    if (!/[0-9]/.test(password)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password must contain at least one digit.');
    }
    if (!/[^A-Za-z0-9]/.test(password)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password must contain at least one special character.');
    }
    return password;
  },

  validateRole(role) {
    if (!role || !Object.values(CONSTANTS.ROLES).includes(role)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid role. Allowed roles: ${Object.values(CONSTANTS.ROLES).join(', ')}`);
    }
    return role;
  },

  validateDateRange(startUtc, endUtc, allowFuture = false) {
    const s = new Date(startUtc).getTime();
    const e = new Date(endUtc).getTime();
    if (isNaN(s) || isNaN(e)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid timestamp provided.');
    }
    if (e < s) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'End time cannot be earlier than start time.');
    }
    // Anti-Cheat: Reject future-dated time logs (allowing 5 min clock skew tolerance)
    const now = Date.now();
    if (!allowFuture && e > (now + 5 * 60 * 1000)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Time entries cannot be logged with future end dates.');
    }
    const durationSeconds = Math.round((e - s) / 1000);
    const maxSeconds = CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS * 3600;
    if (durationSeconds > maxSeconds) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Time entry duration cannot exceed ${CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS} hours.`);
    }
    return durationSeconds;
  },

  generateId(prefix = 'ID') {
    // Use Utilities.getUuid() for better entropy than Math.random()
    if (typeof Utilities !== 'undefined' && Utilities.getUuid) {
      const uuid = Utilities.getUuid().replace(/-/g, '').substring(0, 12);
      return `${prefix}-${uuid}`.toUpperCase();
    }
    // Fallback for testing environments without Apps Script Utilities
    const randomHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    const ts = Date.now().toString(36);
    return `${prefix}-${ts}-${randomHex()}${randomHex()}`.toUpperCase();
  },

  assertRequired(obj, fields = []) {
    if (!obj || typeof obj !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Request payload missing or invalid.');
    }
    for (const f of fields) {
      if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Missing required field: ${f}`);
      }
    }
  },

  /**
   * Optimistic Concurrency Control (Record Versioning)
   * Section 43: Prevents silent overwrites by asserting expected version equals record current version.
   */
  assertRecordVersion(record, expectedVersion) {
    if (expectedVersion === undefined || expectedVersion === null) return;
    const currentVer = parseInt(record.Version || 1, 10);
    const expVer = parseInt(expectedVersion, 10);
    if (currentVer !== expVer) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `Record was modified by another user (expected v${expVer}, current v${currentVer}). Please refresh and try again.`,
        409
      );
    }
  },

  /**
   * Action Idempotency Cache
   * Section 49: Avoids duplicate execution on browser network retry.
   */
  _idempotencyCache: new Map(),

  getIdempotencyResult(actionId) {
    if (!actionId) return null;
    if (this._idempotencyCache.has(actionId)) {
      return this._idempotencyCache.get(actionId);
    }
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try {
        const cached = CacheService.getScriptCache().get(`IDEMP_${actionId}`);
        if (cached) return JSON.parse(cached);
      } catch (e) {}
    }
    return null;
  },

  setIdempotencyResult(actionId, result) {
    if (!actionId) return;
    this._idempotencyCache.set(actionId, result);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try {
        CacheService.getScriptCache().put(`IDEMP_${actionId}`, JSON.stringify(result), 3600);
      } catch (e) {}
    }
  }
};

/* ===== App.gs ===== */
/**
 * FLINK Time & Workforce Platform — Main Application Dispatcher & API Controller
 * Serves Google Apps Script Web App (doGet / doPost), embeds into Google Sites,
 * and routes API actions with LockService concurrency guards and unified error handling.
 */

function doGet(e) {
  const params = e ? e.parameter : {};
  const action = params ? params.action : '';
  const view = params ? params.view : '';

  // API GET requests are read-only; privileged/admin HTML is not served from this deployment.
  // If action query parameter is passed, treat as GET API request
  if (action) {
    return handleApiRequest(action, params, 'GET');
  }

  // Otherwise serve the Google Workspace-Native Web Application UI
  try {
    const template = HtmlService.createTemplateFromFile('App');
    const output = template.evaluate();
    output.setTitle('FLINK Time & Workforce Platform');
    output.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // Allows embedding inside Google Sites
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return output;
  } catch (err) {
    return ContentService.createTextOutput('FLINK Platform Portal: ' + err.message)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function doPost(e) {
  let action = '';
  let payload = {};

  try {
    if (e && e.postData && e.postData.contents) {
      const parsed = JSON.parse(e.postData.contents);
      action = parsed.action || '';
      payload = parsed;
    } else if (e && e.parameter) {
      action = e.parameter.action || '';
      payload = e.parameter;
    }
  } catch (err) {
    return buildJsonResponse({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON payload: ' + err.message }
    });
  }

  return handleApiRequest(action, payload, 'POST');
}

/**
 * Centralized Action Permissions Matrix (Default-Deny)
 * Every API endpoint MUST be explicitly declared with its authentication,
 * role authorizations, workspace binding, and mutation requirements.
 */
const ACTION_PERMISSIONS = {
  // Public / Unauthenticated
  'auth.login': { authRequired: false, isWrite: true },
  'auth.verifyMfa': { authRequired: false, isWrite: true },
  'setup.status': { authRequired: false, isWrite: false },

  // User Authentication, MFA & Profile
  'auth.validateSession': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'auth.logout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.changePassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.enrollMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.confirmMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: true },
  'auth.disableMfa': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Setup Wizard
  'setup.completeStep': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true, allowUnauthStep1: true },
  'setup.finalize': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Workspaces
  'workspaces.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'workspaces.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.assignAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.removeAdmin': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'workspaces.deletePermanent': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Users
  'users.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], isWrite: false },
  'users.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.makePassive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.activate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.resetPassword': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.unlock': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.forceLogout': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'users.assignWorkspace': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: true },

  // Requests
  'requests.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: true },
  'requests.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'requests.review': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Timer & Time Entries
  'timer.start': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.stop': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timer.getActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.createManual': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.delete': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'entries.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'entries.bulkAction': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },

  // Timesheet & Approvals
  'timesheet.getWeekly': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'timesheet.listForReview': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'timesheet.submit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: true },
  'timesheet.approve': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reject': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'timesheet.reopen': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], requiresWorkspace: true, isWrite: true },

  // Master Data
  'clients.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'clients.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'projects.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'projects.update': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tasks.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tasks.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'tags.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'tags.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Reports & Dashboards
  'reports.summary': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.detailed': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: true, isWrite: false },
  'reports.attendance': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exceptions': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: false },
  'reports.exportCsv': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },
  'dashboard.radar': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },
  'dashboard.overview': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.USER], requiresWorkspace: false, isWrite: false },

  // System Diagnostics & Repairs
  'system.health': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'system.repair': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'system.diagnostics': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },

  // Settings & Configuration
  'settings.get': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'settings.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Sessions & Security
  'sessions.listActive': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'sessions.revoke': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

  // Backups & Restores
  'backups.create': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'backups.list': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'backups.restoreValidate': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'backups.restoreApply': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'rollups.rebuild': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], requiresWorkspace: true, isWrite: true },

  // Jobs & Capacity
  'jobs.dispatchHousekeeping': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.dispatchRollups': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'jobs.capacity': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },

  // Integrity & Audit
  'integrity.audit': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'audit.verifyChain': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false }
};

/**
 * Explicit unauthenticated boundary. Any new public action must be added here
 * and to ACTION_PERMISSIONS with authRequired:false, or CI will fail.
 */
const PUBLIC_ACTIONS = new Set([
  'auth.login',
  'auth.verifyMfa',
  'setup.status'
]);

/**
 * Explicit API GET allowlist.
 *
 * Authenticated actions intentionally remain POST-only even when logically
 * read-only, because this application carries session tokens in request data.
 * Allowing authenticated GET would encourage tokens in URLs, browser history,
 * proxy logs, and referrer surfaces.
 */
const GET_SAFE_ACTIONS = new Set([
  'setup.status'
]);

function isHttpMethodAllowed(action, method) {
  if (!ACTION_PERMISSIONS[action]) return false;
  const normalized = String(method || '').toUpperCase();
  if (normalized === 'POST') return true;
  if (normalized === 'GET') return GET_SAFE_ACTIONS.has(action);
  return false;
}

/**
 * Universal API Request Handler
 */
function executeApiRequest(action, requestData, httpMethod = 'POST') {
  // Explicit request boundary for repository caches. Apps Script V8 isolates may
  // be reused between executions, so never allow cached Sheet rows to survive
  // from one API request into another.
  if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
    MasterRepository.beginRequest();
  }
  if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
    SheetRepository.beginRequest();
  }
  if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
    WorkspaceRouter.clearCache();
  }

  const perm = ACTION_PERMISSIONS[action];

  if (!perm) {
    return {
      ok: false,
      error: { code: ERROR_CODES.NOT_FOUND, message: `Unknown or forbidden API action: ${action}`, statusCode: 404 }
    };
  }

  if (!isHttpMethodAllowed(action, httpMethod)) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `HTTP method ${String(httpMethod || '').toUpperCase()} is not allowed for action ${action}.`,
        statusCode: 405
      }
    };
  }

  // Transactional locking is owned by the service performing the mutation.
  try {
    const result = dispatchAction(action, requestData);
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof AppError) {
      return err.toJSON();
    }
    return {
      ok: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: err && err.message ? err.message : 'An unexpected internal error occurred.',
        statusCode: 500
      }
    };
  }
}

function handleApiRequest(action, requestData, httpMethod = 'POST') {
  return buildJsonResponse(executeApiRequest(action, requestData, httpMethod));
}

/**
 * In-process bridge for HtmlService/google.script.run.
 * Returns a plain serializable object rather than ContentService.TextOutput.
 */
function handleClientRequest(action, requestData) {
  return executeApiRequest(action, requestData, 'POST');
}

/**
 * Action Router with Centralized Default-Deny Authorization
 */
function dispatchAction(action, data, authContextOverride = null) {
  const perm = ACTION_PERMISSIONS[action];
  if (!perm) {
    throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }

  const token = data.sessionToken || data.token || '';
  const wsId = data.workspaceId || (data.payload && data.payload.workspaceId) || '';
  const payload = data.payload || data;

  // Unauthenticated actions
  if (PUBLIC_ACTIONS.has(action)) {
    if (action === 'auth.login') {
      return AuthService.login(payload.username, payload.password, payload.clientType);
    }
    if (action === 'auth.verifyMfa') {
      return AuthService.verifyMfa(payload.mfaChallengeToken, payload.code, payload.clientType);
    }
    if (action === 'setup.status') {
      return SetupService.getSetupStatus();
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Unhandled unauthenticated action: ${action}`);
  }

  // Allow unauthenticated bootstrap for Setup step 1 if system is fresh
  if (perm.allowUnauthStep1 === true && (payload.step === 1 || payload.step === '1') && !token) {
    return SetupService.processStep(1, payload, null);
  }

  // All other actions require authenticated session
  const authContext = authContextOverride || SessionService.validateSession(token);

  // Forced password change is a server-side security state, not a UI hint.
  // Temporary/reset-password sessions may only validate, change password, or logout.
  const mustChangePassword = authContext.user &&
    (authContext.user.MustChangePassword === true || authContext.user.MustChangePassword === 'TRUE');
  if (mustChangePassword) {
    const allowedDuringForcedChange = new Set([
      'auth.validateSession',
      'auth.changePassword',
      'auth.logout'
    ]);
    if (!allowedDuringForcedChange.has(action)) {
      throw new AppError(
        ERROR_CODES.PASSWORD_CHANGE_REQUIRED,
        'Password change is required before using the application.',
        403
      );
    }
  }

  // Centralized RBAC Enforcement (Default-Deny)
  if (perm.roles && !perm.roles.includes(authContext.role)) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      `Permission denied: Required role not held for action ${action}. Current role: ${authContext.role}`,
      403
    );
  }

  // Centralized Workspace Access Enforcement
  if (perm.requiresWorkspace) {
    if (!wsId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `workspaceId is required for action ${action}.`, 400);
    }
    AuthorizationService.assertWorkspaceAccess(authContext, wsId);
  }

  switch (action) {
    case 'auth.validateSession':
      return { user: authContext.user, role: authContext.role };

    case 'auth.logout':
      return AuthService.logout(token);

    case 'auth.changePassword':
      return AuthService.changePassword(token, payload.oldPassword, payload.newPassword);

    case 'auth.enrollMfa':
      return AuthService.enrollMfa(authContext);

    case 'auth.confirmMfa':
      return AuthService.confirmMfa(authContext, payload.code);

    case 'auth.disableMfa':
      return AuthService.disableMfa(authContext, payload.targetUserId);

    case 'users.assignWorkspace':
      return WorkspaceService.assignUserToWorkspace(authContext, payload.targetUserId, payload.workspaceId || wsId);

    case 'audit.verifyChain':
      return AuditService.verifyAuditChain(payload.workspaceId || wsId || null);

    /* ---------------- WORKSPACES ---------------- */
    case 'workspaces.list':
      return WorkspaceService.listWorkspaces(authContext);

    case 'workspaces.create':
      return WorkspaceService.createWorkspace(authContext, payload);

    case 'workspaces.assignAdmin':
      return WorkspaceService.assignAdminToWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    case 'workspaces.removeAdmin':
      return WorkspaceService.removeAdminFromWorkspace(authContext, payload.adminUserId, payload.workspaceId);

    /* ---------------- USERS ---------------- */
    case 'users.list':
      return UserService.listUsers(authContext, wsId);

    case 'users.create':
      return UserService.createUser(authContext, payload);

    case 'users.update':
      return UserService.updateUser(authContext, payload.targetUserId, payload.updates);

    case 'users.makePassive':
      return UserService.makeUserPassive(authContext, payload.targetUserId, payload.reason);

    case 'users.activate':
      return UserService.activateUser(authContext, payload.targetUserId);

    case 'users.resetPassword':
      return AuthService.resetPasswordByAdmin(authContext, payload.targetUserId, payload.temporaryPassword);

    /* ---------------- REQUESTS ---------------- */
    case 'requests.submit':
      return AdminRequestService.submitRequest(authContext, payload);

    case 'requests.list':
      return AdminRequestService.listRequests(authContext, payload.statusFilter, wsId);

    case 'requests.review':
      return AdminRequestService.reviewRequest(authContext, payload.requestId, payload);

    /* ---------------- TIMER & ENTRIES ---------------- */
    case 'timer.start':
      return TimerService.startTimer(authContext, wsId, payload);

    case 'timer.stop':
      return TimerService.stopTimer(authContext, wsId, payload);

    case 'timer.getActive':
      return TimerService.getActiveTimer(authContext, wsId);

    case 'entries.createManual':
      return TimeEntryService.createManualEntry(authContext, wsId, payload);

    case 'entries.update':
      return TimeEntryService.updateEntry(
        authContext,
        wsId,
        payload.entryId,
        payload.updates,
        payload.expectedVersion
      );

    case 'entries.delete':
      return TimeEntryService.deleteEntry(
        authContext,
        wsId,
        payload.entryId,
        payload.expectedVersion
      );

    case 'entries.list':
      return TimeEntryService.listEntries(authContext, wsId, payload.filters);

    /* ---------------- TIMESHEET & APPROVALS ---------------- */
    case 'timesheet.getWeekly':
      return TimesheetService.getWeeklyTimesheet(authContext, wsId, payload.targetUserId, payload.weekStartDate);

    case 'timesheet.listForReview':
      return TimesheetService.listTimesheetsForManager(
        authContext,
        wsId,
        payload.statusFilter
      );

    case 'timesheet.submit':
      return TimesheetService.submitTimesheet(authContext, wsId, payload);

    case 'timesheet.approve':
      return ApprovalService.approveTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reject':
      return ApprovalService.rejectTimesheet(authContext, wsId, payload.timesheetId, payload.comment);

    case 'timesheet.reopen':
      return ApprovalService.reopenTimesheet(authContext, wsId, payload.timesheetId, payload.reason);

    /* ---------------- MASTER DATA ---------------- */
    case 'clients.list':
      return ClientService.listClients(authContext, wsId);

    case 'clients.create':
      return ClientService.createClient(authContext, wsId, payload);

    case 'projects.list':
      return ProjectService.listProjects(authContext, wsId);

    case 'projects.create':
      return ProjectService.createProject(authContext, wsId, payload);

    case 'projects.update':
      return ProjectService.updateProject(authContext, wsId, payload.projectId, payload.updates);

    case 'tasks.list':
      return TaskService.listTasks(authContext, wsId, payload.projectId);

    case 'tasks.create':
      return TaskService.createTask(authContext, wsId, payload);

    case 'tags.list':
      return TagService.listTags(authContext, wsId);

    case 'tags.create':
      return TagService.createTag(authContext, wsId, payload);

    /* ---------------- REPORTS & DASHBOARDS ---------------- */
    case 'reports.summary':
      return ReportService.getSummaryReport(authContext, wsId, payload);

    case 'reports.detailed':
      return ReportService.getDetailedReport(authContext, wsId, payload);

    case 'reports.attendance':
      return ReportService.getAttendanceReport(authContext, wsId, payload);

    case 'reports.exceptions':
      return ReportService.getExceptionsReport(authContext, wsId, payload);

    case 'reports.exportCsv':
      return ExportService.exportDetailedCsv(authContext, wsId, payload);

    case 'dashboard.radar':
      return DashboardService.getLiveWorkforceRadar(authContext, wsId);

    case 'dashboard.overview':
      return DashboardService.getDashboardOverview(authContext, wsId);

    case 'system.health':
      return SetupService.processStep(9, {}, authContext);

    case 'system.repair':
      return SetupService.repairSystem(authContext);

    case 'system.diagnostics':
      return SetupService.getAdvancedDiagnostics(authContext);

    case 'setup.completeStep':
      return SetupService.processStep(payload.step, payload, authContext);

    case 'setup.finalize':
      return SetupService.processStep(9, payload, authContext);

    /* ---------------- SETTINGS & CONFIGURATION ---------------- */
    case 'settings.get':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      return MasterRepository.getAllGlobalSettings();

    case 'settings.save':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      for (const [k, v] of Object.entries(payload.settings || {})) {
        MasterRepository.setGlobalSetting(k, v, authContext.userId);
      }
      return { ok: true, message: 'Settings saved successfully.' };

    /* ---------------- SECURITY & SESSIONS ---------------- */
    case 'users.unlock':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.unlockAccount(payload.targetUserId);

    case 'users.forceLogout':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      SessionService.revokeAllUserSessions(payload.targetUserId);
      return { ok: true, message: `All active sessions revoked for user ${payload.targetUserId}.` };

    case 'sessions.listActive':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return MasterRepository.listActiveSessions();

    case 'sessions.revoke':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      MasterRepository.updateSession(payload.sessionId, { Revoked: true, RevokedAt: new Date().toISOString() });
      return { ok: true, message: 'Session revoked successfully.' };

    /* ---------------- TIME ENTRY BULK & ADVANCED ---------------- */
    case 'entries.bulkAction':
      return {
        ok: true,
        affected: TimeEntryService.bulkAction(authContext, wsId, payload.entryIds, payload.actionType, payload.params)
      };

    case 'workspaces.deletePermanent':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      Validation.assertRequired(payload, ['workspaceId', 'workspaceName', 'adminPassword']);
      const credRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS).rows;
      const userCred = credRows.find(c => c.UserID === authContext.userId);
      if (!userCred || !SecurityService.verifyPassword(payload.adminPassword, userCred.PasswordHash)) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid Super Admin password confirmation.', 401);
      }
      return MasterRepository.deleteWorkspacePermanent(payload.workspaceId);

    /* ---------------- BACKUP & RESTORE ---------------- */
    case 'backups.create':
      return BackupService.createBackup(authContext, wsId);

    case 'backups.list':
      return BackupService.listBackups(authContext, payload.workspaceId || wsId || null);

    case 'backups.restoreValidate':
      return BackupService.validateBackup(authContext, payload.workspaceId || wsId, payload.backupId);

    case 'backups.restoreApply':
      return BackupService.restoreBackup(
        authContext,
        payload.workspaceId || wsId,
        payload.backupId,
        payload.adminPassword
      );

    case 'rollups.rebuild':
      return RollupService.rebuildRollups(wsId);

    /* ---------------- JOBS & CAPACITY ---------------- */
    case 'jobs.dispatchHousekeeping':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchHousekeeping();

    case 'jobs.dispatchRollups':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return JobService.dispatchRollups();

    case 'jobs.capacity':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      return JobService.getCapacityMetrics(payload.workspaceId || wsId);

    /* ---------------- INTEGRITY & AUDIT ---------------- */
    case 'integrity.audit':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return IntegrityService.runNightlyAudit();

    default:
      throw new AppError(ERROR_CODES.NOT_FOUND, `Unknown API action: ${action}`, 404);
  }
}

/**
 * Builds ContentService JSON HTTP response
 */
function buildJsonResponse(obj) {
  const jsonString = JSON.stringify(obj);
  if (typeof ContentService !== 'undefined' && ContentService.createTextOutput) {
    return ContentService.createTextOutput(jsonString).setMimeType(ContentService.MimeType.JSON);
  }
  return obj;
}

const App = {
  ACTION_PERMISSIONS,
  PUBLIC_ACTIONS,
  GET_SAFE_ACTIONS,
  isHttpMethodAllowed,
  doGet,
  doPost,
  handleApiRequest,
  handleClientRequest,
  executeApiRequest,
  dispatchAction,
  buildJsonResponse
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ERROR_CODES, AppError,
    CONSTANTS, MASTER_SCHEMA, WORKSPACE_SCHEMA,
    Validation,
    ACTION_PERMISSIONS, PUBLIC_ACTIONS, GET_SAFE_ACTIONS,
    isHttpMethodAllowed, App, doGet, doPost,
    handleApiRequest, handleClientRequest, executeApiRequest,
    dispatchAction, buildJsonResponse
  };
}

/**
 * FLINK Time & Workforce Platform
 * FINAL SINGLE-FILE GOOGLE APPS SCRIPT BACKEND
 */

/**
 * FLINK Time — Consolidated application gateway, constants, validation, and API routing.
 * Generated from the stabilized source modules; edit this file as the authoritative gateway/core.
 */


/* ===== Errors.gs ===== */
/**
 * FLINK Time & Workforce Platform — Error Definitions
 */

var ERROR_CODES = {
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
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_BUSY: 'SERVER_BUSY',
  NOT_FOUND: 'NOT_FOUND',
  ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED',
  CRYPTO_FAILURE: 'CRYPTO_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

var AppError = (typeof global !== 'undefined' && global.AppError) || class AppError extends Error {
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

/**
 * Optional install-time bootstrap values.
 *
 * Normal/template installs leave the sentinels untouched; installerBootstrapValue_()
 * treats them as empty. The separate official installer may replace only these two
 * sentinel strings before uploading the five production files into a newly created
 * bound Apps Script project.
 */
var INSTALLER_BOOTSTRAP = {
  masterSpreadsheetId: '__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__',
  ownerEmail: '__FLINK_INSTALLER_OWNER_EMAIL__'
};

function installerBootstrapValue_(value) {
  const raw = String(value || '').trim();
  if (!raw || /^__FLINK_INSTALLER_[A-Z0-9_]+__$/.test(raw)) return '';
  return raw;
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

var CONSTANTS = {
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
    LOGIN_CALLER_ATTEMPTS_PER_MINUTE: 30,
    LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE: 1000,
    SESSION_IDLE_TIMEOUT_HOURS: 8,
    SESSION_ABSOLUTE_TIMEOUT_HOURS: 24,
    SESSION_TOUCH_INTERVAL_MINUTES: 5,
    MIN_PASSWORD_LENGTH: 12,
    MAX_PASSWORD_LENGTH: 128,
    RESET_PASSWORD_TTL_MINUTES: 60,
    INITIAL_PASSWORD_TTL_HOURS: 24,
    SETUP_KEY_TTL_MINUTES: 15,
    MFA_ENROLLMENT_TTL_MINUTES: 10,
    STEP_UP_TTL_MINUTES: 5,
    MAX_SINGLE_ENTRY_HOURS: 24,
    DASHBOARD_LIVE_WINDOW_SECONDS: 60,
    SESSION_RETENTION_DAYS: 7,
    AUDIT_CHECKPOINT_RETENTION_DAYS: 90
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
var MASTER_SCHEMA = {
  System: [
    'SystemID', 'InstanceName', 'Version', 'SchemaVersion', 'InstalledAtUTC', 'UpdatedAtUTC', 'LastHealthCheckUTC', 'Status'
  ],
  Accounts: [
    'UserID', 'Username', 'DisplayName', 'Role', 'Status',
    'PrimaryWorkspaceID', 'Email', 'EmployeeCode', 'CreatedAt', 'CreatedBy',
    'UpdatedAt', 'UpdatedBy', 'LastLoginAt', 'MustChangePassword', 'Version', 'SessionEpoch'
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
    'CreatedAt', 'LastSeenAt', 'ExpiresAt', 'AbsoluteExpiresAt', 'Revoked', 'RevokedAt', 'RevokeReason', 'AccountEpoch'
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
var WORKSPACE_SCHEMA = {
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
    'TagIDs', 'StartedAtUTC', 'StartedAtLocal', 'Billable', 'Source', 'LastHeartbeat', 'WorkMode'
  ],
  TimeEntries: [
    'EntryID', 'UserID', 'ProjectID', 'TaskID', 'Description', 'Tags',
    'StartUTC', 'EndUTC', 'DurationSeconds', 'Billable',
    'HourlyRateSnapshot', 'CostRateSnapshot', 'EntrySource', 'ManualEntry',
    'Status', 'ApprovalStatus', 'TimesheetID', 'Locked',
    'CreatedAt', 'CreatedBy', 'UpdatedAt', 'UpdatedBy', 'DeletedAt', 'DeletedBy', 'Version', 'WorkMode'
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

/* ===== SettingsCatalog.gs ===== */
/**
 * Canonical settings catalog. Adding a configurable feature requires a catalog
 * entry plus a server-side guard; the Super Admin UI renders this catalog.
 */
var SETTINGS_CATALOG = [
  { key:'COMPANY_NAME', group:'General', label:'Company Legal Name', type:'text', default:'FLINK Business Solutions', min:1, max:120, options:[], scope:'GLOBAL', stepUp:false, help:'Company name shown in system-facing labels and exports.' },
  { key:'DEFAULT_TIMEZONE', group:'General', label:'Default Timezone', type:'text', default:'Africa/Cairo', min:1, max:64, options:[], scope:'GLOBAL', stepUp:false, help:'Default IANA timezone for new workspaces.' },
  { key:'AUTO_STOP_HOURS', group:'Time Tracking', label:'Auto-stop Long Timers (Hours)', type:'number', default:14, min:1, max:168, options:[], scope:'GLOBAL', stepUp:false, help:'Maximum timer length before automated protection applies.' },
  { key:'IDLE_TIMEOUT_HOURS', group:'Compatibility', label:'Legacy Idle Timeout (Hours)', type:'number', default:8, min:1, max:24, options:[], scope:'GLOBAL', stepUp:false, help:'Compatibility setting retained for older installations.', visible:false },

  { key:'PASSWORD_RECOVERY_EMAIL', group:'Security', label:'Email Password Recovery', type:'bool', default:false, min:null, max:null, options:[], scope:'GLOBAL', stepUp:true, help:'Enables the email recovery workflow once WP6 is installed.' },
  { key:'MFA_REQUIRED', group:'Security', label:'Require MFA', type:'bool', default:true, min:null, max:null, options:[], scope:'GLOBAL', stepUp:true, help:'Security policy flag for mandatory authenticator verification.' },
  { key:'SESSION_IDLE_MINUTES', group:'Security', label:'Session Idle Timeout (Minutes)', type:'number', default:480, min:5, max:1440, options:[], scope:'GLOBAL', stepUp:true, help:'Maximum inactivity before a session expires.' },
  { key:'SESSION_MAX_HOURS', group:'Security', label:'Maximum Session Length (Hours)', type:'number', default:24, min:1, max:168, options:[], scope:'GLOBAL', stepUp:true, help:'Absolute maximum session lifetime.' },
  { key:'PBKDF2_ITERATIONS', group:'Security', label:'Password Hash Iterations', type:'number', default:10000, min:10000, max:1000000, options:[], scope:'GLOBAL', stepUp:true, help:'PBKDF2 work factor. Use System Health calibration before increasing it.' },

  { key:'FEATURE_TIMESHEET_APPROVAL', group:'Optional Modules', label:'Timesheet Approval', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:true, help:'Approval workflow feature flag. Target design keeps this off.' },
  { key:'FEATURE_TIME_OFF', group:'Optional Modules', label:'Time Off & Leaves', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Time off and leave tracking module. Off by default.' },
  { key:'FEATURE_SCHEDULING', group:'Optional Modules', label:'Scheduling & Shifts', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Shift and schedule planning module. Off by default.' },
  { key:'FEATURE_EXPENSES', group:'Optional Modules', label:'Expenses Tracking', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Project expenses and reimbursables module. Off by default.' },
  { key:'FEATURE_INVOICING', group:'Optional Modules', label:'Invoicing & Billing', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Client invoicing and billing module. Off by default.' },

  { key:'WEEK_STARTS', group:'Time Tracking', label:'Week Start Day', type:'select', default:'Sunday', min:null, max:null, options:['Sunday','Monday','Saturday'], scope:'WORKSPACE', stepUp:false, help:'First day of the business week for this workspace.' },
  { key:'FEATURE_WFH_TRACKING', group:'Workforce Policy', label:'Enable WFH Labeling & Logging', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables WFH / Office labeling and logs for managers and Super Admin.' },
  { key:'WFH_DAYS_PER_WEEK', group:'Workforce Policy', label:'Allowed WFH Days / Week', type:'number', default:2, min:0, max:7, options:[], scope:'WORKSPACE', stepUp:false, help:'Maximum allowed work-from-home days per week for team members.' },

  { key:'ALLOW_USER_PROJECT_SWITCH', group:'Time Tracking', label:'Allow Project Switching', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Allows users to change projects according to WP3 rules.' },
  { key:'ENTRY_EDIT_WINDOW_DAYS', group:'Time Tracking', label:'Entry Edit Window (Days)', type:'number', default:0, min:0, max:3650, options:[], scope:'WORKSPACE', stepUp:false, help:'0 means no edit-age limit.' },
  { key:'ALLOW_MANUAL_ENTRIES', group:'Time Tracking', label:'Allow Manual Entries', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Allows manual time entry creation.' },
  { key:'ALLOW_USER_DELETE_ENTRY', group:'Time Tracking', label:'Allow User Entry Deletion', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Allows users to delete their own entries.' },
  { key:'REQUIRE_DESCRIPTION', group:'Time Tracking', label:'Require Description', type:'bool', default:false, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Requires a description on tracked time.' },
  { key:'FEATURE_TAGS', group:'Features', label:'Tags', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables tags in the workspace.' },
  { key:'FEATURE_TASKS', group:'Features', label:'Tasks', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables project tasks in the workspace.' },
  { key:'FEATURE_LIVE_VIEW', group:'Features', label:'Live View', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables live workforce views.' },
  { key:'FEATURE_REPORT_EXPORT', group:'Features', label:'Report Export', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables report export on the server.' },
  { key:'FEATURE_SAVED_DASHBOARDS', group:'Features', label:'Saved Dashboards', type:'bool', default:true, min:null, max:null, options:[], scope:'WORKSPACE', stepUp:false, help:'Enables saved dashboard functionality.' }
];

function getSettingCatalogEntry_(key) {
  return SETTINGS_CATALOG.find(entry => entry.key === String(key || '')) || null;
}

/* ===== Validation.gs ===== */
/**
 * FLINK Time & Workforce Platform — Input Validation & Sanitization
 */

var Validation = {
  /**
   * Spreadsheet Formula Injection Defense
   * Neutralizes formula execution by prepending a single quote if the string starts with =, +, -, @, tab, or newline.
   */
  sanitizeCellValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    const str = String(val);
    if (/^\s*[-+]?\d+(\.\d+)?\s*$/.test(str)) {
      return str;
    }
    if (/^\s*[=+\-@\t\r\n]/.test(str)) {
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

  validateSettingsPatch(settings, scope = 'GLOBAL') {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A settings object is required.', 400);
    }
    const normalizedScope = String(scope || 'GLOBAL').toUpperCase();
    if (!['GLOBAL', 'WORKSPACE'].includes(normalizedScope)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Setting scope must be GLOBAL or WORKSPACE.', 400);
    }

    const keys = Object.keys(settings);
    if (keys.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one setting is required.', 400);
    }

    const clean = {};
    for (const key of keys) {
      const entry = getSettingCatalogEntry_(key);
      if (!entry || entry.scope !== normalizedScope) {
        const label = normalizedScope === 'GLOBAL' ? 'global setting' : 'workspace setting';
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unsupported ${label}: ${key}`, 400);
      }
      const raw = settings[key];

      if (entry.type === 'bool') {
        if (![true, false, 1, 0, 'true', 'false', 'TRUE', 'FALSE', '1', '0'].includes(raw)) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${entry.label} must be true or false.`, 400);
        }
        clean[key] = (raw === true || raw === 1 || raw === 'true' || raw === 'TRUE' || raw === '1')
          ? 'true'
          : 'false';
        continue;
      }

      if (entry.type === 'number') {
        const value = Number(raw);
        if (!Number.isFinite(value) || !Number.isInteger(value)) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${entry.label} must be a whole number.`, 400);
        }
        if (entry.min !== null && entry.min !== undefined && value < Number(entry.min)) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${entry.label} must be at least ${entry.min}.`, 400);
        }
        if (entry.max !== null && entry.max !== undefined && value > Number(entry.max)) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${entry.label} must be at most ${entry.max}.`, 400);
        }
        clean[key] = String(value);
        continue;
      }

      if (entry.type === 'select') {
        const value = String(raw === null || raw === undefined ? '' : raw).trim();
        if (!Array.isArray(entry.options) || !entry.options.includes(value)) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid value for ${entry.label}.`, 400);
        }
        clean[key] = this.sanitizeCellValue(value);
        continue;
      }

      const value = String(raw === null || raw === undefined ? '' : raw).trim();
      const minLength = entry.min === null || entry.min === undefined ? 0 : Number(entry.min);
      const maxLength = entry.max === null || entry.max === undefined ? 500 : Number(entry.max);
      if (value.length < minLength || value.length > maxLength) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `${entry.label} must be between ${minLength} and ${maxLength} characters.`,
          400
        );
      }
      if (key === 'DEFAULT_TIMEZONE' && !/^[A-Za-z0-9_+\-/]+$/.test(value)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Default timezone format is invalid.', 400);
      }
      clean[key] = this.sanitizeCellValue(value);
    }
    return clean;
  },

  validateGlobalSettingsPatch(settings) {
    return this.validateSettingsPatch(settings, 'GLOBAL');
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


/* Node regression harness may inject partial dependency/config mocks.
 * Production Apps Script has no global object, so these overlays are inert there.
 */
function __mergeConfigForTests_(base, override) {
  if (!override || typeof override !== 'object') return base;
  Object.keys(override).forEach(key => {
    const incoming = override[key];
    if (
      incoming &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming) &&
      base[key] &&
      typeof base[key] === 'object' &&
      !Array.isArray(base[key])
    ) {
      __mergeConfigForTests_(base[key], incoming);
    } else {
      base[key] = incoming;
    }
  });
  return base;
}

if (typeof global !== 'undefined') {
  if (global.ERROR_CODES) __mergeConfigForTests_(ERROR_CODES, global.ERROR_CODES);
  if (global.CONSTANTS) __mergeConfigForTests_(CONSTANTS, global.CONSTANTS);
  if (global.MASTER_SCHEMA) __mergeConfigForTests_(MASTER_SCHEMA, global.MASTER_SCHEMA);
  if (global.WORKSPACE_SCHEMA) __mergeConfigForTests_(WORKSPACE_SCHEMA, global.WORKSPACE_SCHEMA);
  if (global.Validation) __mergeConfigForTests_(Validation, global.Validation);
}

/* ===== App.gs ===== */
/**
 * FLINK Time & Workforce Platform — Main Application Dispatcher & API Controller
 * Serves Google Apps Script Web App (doGet / doPost), embeds into Google Sites,
 * and routes API actions with LockService concurrency guards and unified error handling.
 */

function doGet(e) {
  const params = e ? e.parameter : {};
  const action = params ? params.action : '';
  const view = String(params && params.view ? params.view : 'user').trim().toLowerCase();

  // API-created installations can reach the Web App before the deployment
  // owner's Drive/Sheets scopes have been granted to this new script project.
  // Handle that specific first-run state inside the Web App instead of sending
  // the owner into the Apps Script editor. Manual/template installations are
  // unaffected because their installer bootstrap sentinels remain inert.
  if (!action) {
    const authorizationGate = maybeRenderInstallerAuthorizationGate_(view);
    if (authorizationGate) return authorizationGate;
  }

  // API GET requests are read-only; privileged/admin HTML is not served from this deployment.
  // If action query parameter is passed, treat as GET API request
  if (action) {
    return handleApiRequest_(action, params, 'GET');
  }

  // Otherwise serve the Google Workspace-Native Web Application UI
  try {
    const viewFiles = {
      user: 'User',
      admin: 'Admin',
      superadmin: 'SuperAdmin'
    };
    const fileName = viewFiles[view];
    if (!fileName) {
      throw new AppError(
        ERROR_CODES.NOT_FOUND,
        'Unknown portal view. Use ?view=user, ?view=admin, or ?view=superadmin.',
        404
      );
    }
    const template = HtmlService.createTemplateFromFile(fileName);
    const output = template.evaluate();
    const titles = {
      user: 'FLINK Time — Employee',
      admin: 'FLINK Time — Manager',
      superadmin: 'FLINK Time — Super Admin'
    };
    output.setTitle(titles[view]);
    output.setXFrameOptionsMode(
      view === 'user'
        ? HtmlService.XFrameOptionsMode.ALLOWALL
        : HtmlService.XFrameOptionsMode.DEFAULT
    );
    output.addMetaTag('viewport', 'width=device-width, initial-scale=1');
    return output;
  } catch (err) {
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' portal rendering error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return ContentService
      .createTextOutput('FLINK Platform Portal could not be loaded. Reference: ' + correlationId)
      .setMimeType(ContentService.MimeType.TEXT);
  }
}

function maybeRenderInstallerAuthorizationGate_(view) {
  try {
    if (
      typeof PropertiesService === 'undefined' ||
      !PropertiesService.getScriptProperties ||
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getAuthorizationInfo
    ) {
      return null;
    }

    const props = PropertiesService.getScriptProperties();
    if (props.getProperty('FLINK_INSTALL_OWNER_EMAIL')) return null;

    const installerOwner = IdentityService.normalizeEmail(
      installerBootstrapValue_(
        INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.ownerEmail
      )
    );
    if (!installerOwner) return null;

    const activeEmail = IdentityService.getCurrentGoogleEmail(false);
    if (!activeEmail || activeEmail !== installerOwner) {
      return buildInstallerAuthorizationPage_({
        title: 'Installation owner required',
        message:
          'Sign in with the Google Workspace account that installed FLINK Time before continuing first-time setup.',
        authorizationUrl: '',
        continueUrl: '',
        actionLabel: ''
      });
    }

    const authInfo = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    const status = authInfo.getAuthorizationStatus();
    if (status !== ScriptApp.AuthorizationStatus.REQUIRED) return null;

    const authorizationUrl = String(authInfo.getAuthorizationUrl() || '');
    const serviceUrl = (
      ScriptApp.getService &&
      ScriptApp.getService() &&
      ScriptApp.getService().getUrl
    ) ? String(ScriptApp.getService().getUrl() || '') : '';
    const safeView = ['user', 'admin', 'superadmin'].includes(view)
      ? view
      : 'superadmin';
    const continueUrl = serviceUrl
      ? serviceUrl + '?view=' + encodeURIComponent(safeView)
      : '';

    return buildInstallerAuthorizationPage_({
      title: 'Authorize FLINK Time',
      message:
        'Google requires the installation owner to approve FLINK Time access to its Master Sheet and managed workspace files before first use.',
      authorizationUrl: authorizationUrl,
      continueUrl: continueUrl,
      actionLabel: 'AUTHORIZE FLINK TIME'
    });
  } catch (err) {
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' installer authorization gate error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return buildInstallerAuthorizationPage_({
      title: 'FLINK Time authorization could not be checked',
      message:
        'Reload this page while signed in with the installation owner account. If the problem continues, contact your FLINK Time administrator. Reference: ' +
        correlationId,
      authorizationUrl: '',
      continueUrl: '',
      actionLabel: ''
    });
  }
}

function buildInstallerAuthorizationPage_(options) {
  const opts = options || {};
  const title = escapeInstallerHtml_(opts.title || 'FLINK Time');
  const message = escapeInstallerHtml_(opts.message || '');
  const authorizationUrl = escapeInstallerHtml_(opts.authorizationUrl || '');
  const continueUrl = escapeInstallerHtml_(opts.continueUrl || '');
  const actionLabel = escapeInstallerHtml_(
    opts.actionLabel || 'AUTHORIZE FLINK TIME'
  );

  let actions = '';
  if (authorizationUrl) {
    actions +=
      '<a class="primary" target="_blank" rel="noopener" href="' +
      authorizationUrl + '">' + actionLabel + '</a>';
  }
  if (continueUrl) {
    actions +=
      '<a class="secondary" href="' + continueUrl + '">I HAVE AUTHORIZED — CONTINUE</a>';
  }

  const html =
    '<!doctype html><html><head><base target="_top">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{margin:0;background:#0b111c;color:#f8fafc;font:15px/1.5 Arial,sans-serif}' +
    'main{max-width:680px;margin:0 auto;padding:72px 24px}' +
    '.card{background:#121b2b;border:1px solid #2a3850;border-radius:14px;padding:28px}' +
    'h1{margin:0 0 10px;font-size:26px}p{color:#a6b2c5;margin:0 0 22px}' +
    '.actions{display:flex;gap:10px;flex-wrap:wrap}' +
    'a{padding:12px 16px;border-radius:8px;text-decoration:none;font-weight:800}' +
    '.primary{background:#3b82f6;color:#fff}.secondary{background:#1c283a;color:#fff;border:1px solid #2a3850}' +
    '.note{font-size:12px;color:#8290a5;margin-top:18px}' +
    '</style></head><body><main><div class="card">' +
    '<h1>' + title + '</h1><p>' + message + '</p>' +
    '<div class="actions">' + actions + '</div>' +
    '<div class="note">This authorization is generated by Google. FLINK Time never receives your Google password.</div>' +
    '</div></main></body></html>';

  return HtmlService
    .createHtmlOutput(html)
    .setTitle(opts.title || 'FLINK Time')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
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
    return buildJsonResponse_({
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Malformed JSON payload: ' + err.message }
    });
  }

  return handleApiRequest_(action, payload, 'POST');
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
  'auth.stepUp': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
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
  'security.calibrateKdf': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },

  // Settings & Configuration
  'settings.get': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN], isWrite: false },
  'settings.save': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },
  'settings.getCatalog': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: false },
  'settings.patch': { authRequired: true, roles: [CONSTANTS.ROLES.SUPER_ADMIN], isWrite: true },

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

const PRIVILEGED_STEP_UP_ACTIONS = new Set([
  'workspaces.create',
  'workspaces.assignAdmin',
  'workspaces.removeAdmin',
  'workspaces.deletePermanent',
  'users.create',
  'users.update',
  'users.makePassive',
  'users.activate',
  'users.resetPassword',
  'users.unlock',
  'users.forceLogout',
  'users.assignWorkspace',
  'requests.review',
  'timesheet.reopen',
  'system.health',
  'system.repair',
  'settings.save',
  'settings.patch',
  'sessions.revoke',
  'backups.create',
  'backups.restoreApply',
  'jobs.dispatchHousekeeping',
  'jobs.dispatchRollups',
  'integrity.audit'
]);

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

/**
 * Own-property lookup so inherited names such as 'constructor' or '__proto__'
 * can never be mistaken for an action. Returns the permission entry or null.
 */
function getActionPermission_(action) {
  if (typeof action !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(ACTION_PERMISSIONS, action) ? ACTION_PERMISSIONS[action] : null;
}

function isHttpMethodAllowed_(action, method) {
  if (!getActionPermission_(action)) return false;
  const normalized = String(method || '').toUpperCase();
  if (normalized === 'POST') return true;
  if (normalized === 'GET') return GET_SAFE_ACTIONS.has(action);
  return false;
}

/**
 * Universal API Request Handler
 */
function executeApiRequest_(action, requestData, httpMethod = 'POST') {
  // Explicit request boundary for repository caches. Apps Script V8 isolates may
  // be reused between executions, so never allow cached Sheet rows to survive
  // from one API request into another.
  if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
    MasterRepository.beginRequest();
  }
  if (typeof Flags !== 'undefined' && Flags.beginRequest) {
    Flags.beginRequest();
  }
  if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
    SheetRepository.beginRequest();
  }
  if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
    WorkspaceRouter.clearCache();
  }
  if (typeof TimezoneService !== 'undefined' && TimezoneService.beginRequest) {
    TimezoneService.beginRequest();
  }

  const perm = getActionPermission_(action);

  if (!perm) {
    return {
      ok: false,
      error: { code: ERROR_CODES.NOT_FOUND, message: `Unknown or forbidden API action: ${action}`, statusCode: 404 }
    };
  }

  if (!isHttpMethodAllowed_(action, httpMethod)) {
    return {
      ok: false,
      error: {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: `HTTP method ${String(httpMethod || '').toUpperCase()} is not allowed for action ${action}.`,
        statusCode: 405
      }
    };
  }

  // google.script.run may deliver null/undefined; anything that is not a plain object is a client error, not a 500.
  if (requestData === undefined || requestData === null) requestData = {};
  if (typeof requestData !== 'object' || Array.isArray(requestData)) {
    return {
      ok: false,
      error: { code: ERROR_CODES.VALIDATION_ERROR, message: 'Request body must be an object.', statusCode: 400 }
    };
  }

  // Transactional locking is owned by the service performing the mutation.
  try {
    const result = dispatchAction_(action, requestData);
    return { ok: true, data: result };
  } catch (err) {
    if (err instanceof AppError && Number(err.statusCode || 400) < 500) {
      return err.toJSON();
    }
    const correlationId = Validation.generateId('ERR');
    console.error(
      correlationId + ' unexpected API error: ' +
      (err && err.stack ? err.stack : String(err))
    );
    return {
      ok: false,
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'An unexpected internal error occurred. Reference: ' + correlationId,
        statusCode: 500,
        correlationId
      }
    };
  }
}

function handleApiRequest_(action, requestData, httpMethod = 'POST') {
  return buildJsonResponse_(executeApiRequest_(action, requestData, httpMethod));
}

/**
 * In-process bridge for HtmlService/google.script.run.
 * Returns a plain serializable object rather than ContentService.TextOutput.
 */
function handleClientRequest(action, requestData) {
  return executeApiRequest_(action, requestData, 'POST');
}

/**
 * Action Router with Centralized Default-Deny Authorization
 */
function dispatchAction_(action, data) {
  const perm = getActionPermission_(action);
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
  const authContext = SessionService.validateSession(token);

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

  if (
    authContext.role === CONSTANTS.ROLES.SUPER_ADMIN &&
    PRIVILEGED_STEP_UP_ACTIONS.has(action)
  ) {
    AuthService.assertStepUp(authContext, payload.stepUpToken || '');
    AuditService.requirePrivilegedActionAudit(authContext, action, wsId || '');
  }

  switch (action) {
    case 'auth.validateSession':
      return { user: authContext.user, role: authContext.role };

    case 'auth.stepUp':
      return AuthService.stepUp(
        authContext,
        token,
        payload.currentPassword,
        payload.totpCode
      );

    case 'auth.logout':
      return AuthService.logout(token);

    case 'auth.changePassword':
      return AuthService.changePassword(token, payload.oldPassword, payload.newPassword);

    case 'auth.enrollMfa':
      return AuthService.enrollMfa(
        authContext,
        payload.currentPassword,
        payload.currentMfaCode
      );

    case 'auth.confirmMfa':
      return AuthService.confirmMfa(authContext, payload.code);

    case 'auth.disableMfa':
      return AuthService.disableMfa(
        authContext,
        payload.targetUserId,
        payload.adminPassword,
        payload.adminTotpCode
      );

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
      Flags.assertOn('FEATURE_REPORT_EXPORT', wsId, 'Report export is disabled for this workspace.');
      return ExportService.exportDetailedCsv(authContext, wsId, payload);

    case 'dashboard.radar':
      Flags.assertOn('FEATURE_LIVE_VIEW', wsId, 'Live view is disabled for this workspace.');
      return DashboardService.getLiveWorkforceRadar(authContext, wsId);

    case 'dashboard.overview':
      return DashboardService.getDashboardOverview(authContext, wsId);

    case 'system.health':
      return SetupService.processStep(9, {}, authContext);

    case 'system.repair':
      return SetupService.repairSystem(authContext);

    case 'system.diagnostics':
      return SetupService.getAdvancedDiagnostics(authContext);

    case 'security.calibrateKdf':
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      return SecurityService.calibratePasswordKdf(payload.targetMs || 700);

    case 'setup.completeStep':
      return SetupService.processStep(payload.step, payload, authContext);

    case 'setup.finalize':
      return SetupService.processStep(9, payload, authContext);

    /* ---------------- SETTINGS & CONFIGURATION ---------------- */
    case 'settings.getCatalog':
      return SettingsService.getCatalog(authContext, payload.workspaceId || wsId || '');

    case 'settings.patch':
      return SettingsService.patch(
        authContext,
        payload.scope,
        payload.workspaceId || wsId || '',
        payload.settings
      );

    case 'settings.get': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      const allSettings = MasterRepository.getAllGlobalSettingsStrict();
      if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) return allSettings;

      const allowedWorkspaceIds = MasterRepository
        .getWorkspaceAccessForUser(authContext.userId)
        .map(access => String(access.WorkspaceID || ''));
      const filtered = {};
      for (const [key, value] of Object.entries(allSettings)) {
        if (!String(key).startsWith('WS_')) {
          filtered[key] = value;
          continue;
        }
        if (allowedWorkspaceIds.some(id => id && String(key).startsWith(`WS_${id}_`))) {
          filtered[key] = value;
        }
      }
      return filtered;
    }

    case 'settings.save': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      const cleanSettings = Validation.validateGlobalSettingsPatch(
        payload.settings
      );
      const beforeSettings = {};
      for (const key of Object.keys(cleanSettings)) {
        beforeSettings[key] = MasterRepository.getGlobalSetting(key, '');
      }
      for (const [key, value] of Object.entries(cleanSettings)) {
        MasterRepository.setGlobalSetting(key, value, authContext.userId);
      }
      MasterRepository.logGlobalAudit({
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        WorkspaceID: 'MASTER',
        EntityType: 'GLOBAL_SETTINGS',
        EntityID: 'GLOBAL_SETTINGS',
        Action: CONSTANTS.AUDIT_EVENTS.SETTINGS_CHANGED,
        BeforeJSON: beforeSettings,
        AfterJSON: cleanSettings,
        Reason: 'Validated global settings update'
      });
      return { ok: true, message: 'Settings saved successfully.' };
    }

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

    case 'workspaces.deletePermanent': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
      Validation.assertRequired(payload, ['workspaceId', 'workspaceName', 'adminPassword']);
      const targetWorkspace = MasterRepository.getWorkspace(payload.workspaceId);
      if (!targetWorkspace) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${payload.workspaceId} not found.`, 404);
      }
      if (
        String(payload.workspaceName || '').trim() !==
        String(targetWorkspace.WorkspaceName || '').trim()
      ) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Workspace name confirmation does not match the server record.',
          400
        );
      }
      const credRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS).rows;
      const userCred = credRows.find(c => c.UserID === authContext.userId);
      if (!userCred || !SecurityService.verifyPassword(payload.adminPassword, userCred.PasswordHash)) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid Super Admin password confirmation.', 401);
      }
      return MasterRepository.deleteWorkspacePermanent(payload.workspaceId);
    }

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

    case 'jobs.capacity': {
      AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
      const requestedCapacityWorkspace = payload.workspaceId || wsId || '';
      if (authContext.role === CONSTANTS.ROLES.ADMIN) {
        if (!requestedCapacityWorkspace) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId is required for Admin capacity requests.', 400);
        }
        AuthorizationService.assertWorkspaceAccess(authContext, requestedCapacityWorkspace);
        return JobService.getCapacityMetrics(requestedCapacityWorkspace);
      }
      return JobService.getCapacityMetrics(requestedCapacityWorkspace || null);
    }

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
function buildJsonResponse_(obj) {
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
  isHttpMethodAllowed: isHttpMethodAllowed_,
  doGet,
  doPost,
  handleApiRequest: handleApiRequest_,
  handleClientRequest,
  executeApiRequest: executeApiRequest_,
  dispatchAction: dispatchAction_,
  buildJsonResponse: buildJsonResponse_
};

/* ============================================================ */

/** FLINK Time — Consolidated identity, authentication, authorization, session, MFA, and tracking policy services. */


/* ===== SettingsService.gs ===== */
var Flags = (typeof global !== 'undefined' && global.Flags) || {
  _requestCache: { FLAGS: null, workspaces: {} },

  beginRequest() {
    this._requestCache = { FLAGS: null, workspaces: {} };
  },

  _decodeValue(entry, raw) {
    if (raw === '' || raw === null || raw === undefined) return entry.default;
    if (entry.type === 'bool') {
      return raw === true || raw === 1 || raw === '1' || raw === 'true' || raw === 'TRUE';
    }
    if (entry.type === 'number') {
      const value = Number(raw);
      return Number.isFinite(value) ? value : Number(entry.default);
    }
    return String(raw);
  },

  _loadGlobal() {
    if (this._requestCache.FLAGS) return this._requestCache.FLAGS;

    let stored = null;
    try {
      if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
        const raw = CacheService.getScriptCache().get('FLAGS');
        if (raw) stored = JSON.parse(raw);
      }
    } catch (err) {
      stored = null;
    }

    if (!stored) {
      stored = MasterRepository.getAllGlobalSettingsStrict();
      try {
        if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
          CacheService.getScriptCache().put('FLAGS', JSON.stringify(stored), 60);
        }
      } catch (err) {}
    }

    this._requestCache.FLAGS = stored || {};
    return this._requestCache.FLAGS;
  },

  _loadWorkspace(workspaceId) {
    const id = String(workspaceId || '');
    if (!id) return {};
    if (!this._requestCache.workspaces[id]) {
      this._requestCache.workspaces[id] = SheetRepository.getWorkspaceSettings(id);
    }
    return this._requestCache.workspaces[id];
  },

  getValue(key, workspaceId = '') {
    const entry = getSettingCatalogEntry_(key);
    if (!entry) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unknown setting: ${key}`, 400);
    }
    const stored = entry.scope === 'WORKSPACE'
      ? this._loadWorkspace(workspaceId)
      : this._loadGlobal();
    return this._decodeValue(entry, Object.prototype.hasOwnProperty.call(stored, entry.key) ? stored[entry.key] : '');
  },

  isOn(key, workspaceId = '') {
    return this.getValue(key, workspaceId) === true;
  },

  getNumber(key, workspaceId = '') {
    return Number(this.getValue(key, workspaceId));
  },

  assertOn(key, workspaceId = '', message = '') {
    if (!this.isOn(key, workspaceId)) {
      throw new AppError(
        ERROR_CODES.FEATURE_DISABLED,
        message || `${key} is disabled for this workspace.`,
        403
      );
    }
    return true;
  },

  invalidate() {
    this.beginRequest();
    try {
      if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
        CacheService.getScriptCache().remove('FLAGS');
      }
    } catch (err) {}
  }
};

var SettingsService = {
  getCatalog(authContext, workspaceId = '') {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const id = String(workspaceId || '');
    if (id && !MasterRepository.getWorkspace(id)) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${id} not found.`, 404);
    }

    return {
      workspaceId: id,
      catalog: SETTINGS_CATALOG
        .filter(entry => entry.visible !== false)
        .map(entry => ({
          key: entry.key,
          group: entry.group,
          label: entry.label,
          type: entry.type,
          default: entry.default,
          min: entry.min,
          max: entry.max,
          options: entry.options,
          scope: entry.scope,
          stepUp: entry.stepUp,
          help: entry.help,
          value: Flags.getValue(entry.key, entry.scope === 'WORKSPACE' ? id : '')
        }))
    };
  },

  patch(authContext, scope, workspaceId, settings) {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const normalizedScope = String(scope || '').toUpperCase();
    const id = String(workspaceId || '');
    const clean = Validation.validateSettingsPatch(settings, normalizedScope);

    if (normalizedScope === 'WORKSPACE') {
      if (!id) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId is required for workspace settings.', 400);
      }
      if (!MasterRepository.getWorkspace(id)) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${id} not found.`, 404);
      }
    }

    const before = {};
    for (const key of Object.keys(clean)) {
      before[key] = Flags.getValue(key, normalizedScope === 'WORKSPACE' ? id : '');
    }

    const auditOk = MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: normalizedScope === 'WORKSPACE' ? id : 'MASTER',
      EntityType: 'SETTINGS',
      EntityID: normalizedScope === 'WORKSPACE' ? id : 'GLOBAL',
      Action: CONSTANTS.AUDIT_EVENTS.SETTINGS_CHANGED,
      BeforeJSON: before,
      AfterJSON: clean,
      Reason: `Validated ${normalizedScope.toLowerCase()} settings patch`
    });
    if (!auditOk) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Security audit trail is unavailable. Settings were not changed.',
        503
      );
    }

    for (const [key, value] of Object.entries(clean)) {
      const entry = getSettingCatalogEntry_(key);
      if (normalizedScope === 'WORKSPACE') {
        SheetRepository.setWorkspaceSetting(id, key, value, authContext.userId, entry.help || '');
      } else {
        MasterRepository.setGlobalSetting(key, value, authContext.userId, entry.help || '');
      }
    }
    Flags.invalidate();
    return { ok: true, scope: normalizedScope, workspaceId: id, settings: clean };
  }
};

/* ===== IdentityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Google Workspace Identity Service
 * Binds browser sessions to the server-observed Google account identity.
 *
 * Security rule:
 * - Never trust a client-supplied email as proof of identity.
 * - WEB sessions require Session.getActiveUser().getEmail().
 * - The observed email must exactly match the FLINK account Email.
 */
var IdentityService = (typeof global !== 'undefined' && global.IdentityService) || {
  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  getCurrentGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getActiveUser
      ) {
        const activeUser = Session.getActiveUser();
        if (activeUser && activeUser.getEmail) {
          email = this.normalizeEmail(activeUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace sign-in is required to use FLINK Time.',
        401
      );
    }
    return email;
  },

  getEffectiveGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getEffectiveUser
      ) {
        const effectiveUser = Session.getEffectiveUser();
        if (effectiveUser && effectiveUser.getEmail) {
          email = this.normalizeEmail(effectiveUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'The FLINK Time deployment owner could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'The FLINK Time deployment owner could not be verified.',
        401
      );
    }
    return email;
  },

  assertInstallationOwner() {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        'Installation settings are unavailable.',
        500
      );
    }

    const props = PropertiesService.getScriptProperties();
    let preparedOwner = this.normalizeEmail(
      props.getProperty('FLINK_INSTALL_OWNER_EMAIL') || ''
    );
    const installerOwner = this.normalizeEmail(
      installerBootstrapValue_(
        INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.ownerEmail
      )
    );
    if (!preparedOwner && installerOwner) preparedOwner = installerOwner;

    if (!preparedOwner) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'FLINK Time has not been prepared yet. Open the Master Sheet and choose FLINK Time → Prepare Installation.',
        401
      );
    }

    const activeEmail = this.getCurrentGoogleEmail(true);
    const effectiveEmail = this.getEffectiveGoogleEmail(true);
    if (activeEmail !== preparedOwner || effectiveEmail !== preparedOwner) {
      throw new AppError(
        ERROR_CODES.UNAUTHORIZED,
        'First-time setup must be completed by the Google Workspace account that owns the Master Sheet and deployed this Web App.',
        403
      );
    }

    // Persist installer-injected bootstrap values only after both Google identity
    // checks succeed. From this point onward Script Properties are authoritative.
    if (!props.getProperty('FLINK_INSTALL_OWNER_EMAIL')) {
      props.setProperty('FLINK_INSTALL_OWNER_EMAIL', preparedOwner);
    }
    const installerSpreadsheetId = installerBootstrapValue_(
      INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.masterSpreadsheetId
    );
    if (
      installerSpreadsheetId &&
      !props.getProperty('MASTER_SPREADSHEET_ID')
    ) {
      props.setProperty('MASTER_SPREADSHEET_ID', installerSpreadsheetId);
    }

    return preparedOwner;
  },

  assertAccountIdentity(account, clientType = 'WEB') {
    const normalizedClient = String(clientType || 'WEB').toUpperCase();
    if (normalizedClient !== 'WEB' && normalizedClient !== 'SETUP_WIZARD') {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Unsupported authentication channel.',
        401
      );
    }

    const actualEmail = this.getCurrentGoogleEmail(true);
    const expectedEmail = this.normalizeEmail(account && account.Email);

    if (!expectedEmail || actualEmail !== expectedEmail) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity does not match this FLINK account.',
        401
      );
    }
    return actualEmail;
  }
};

/* ===== SecurityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Cryptographic Security Service
 * Implements:
 * - PBKDF2-HMAC-SHA256 one-way salted password hashing
 * - Server-side pepper from Script Properties
 * - Constant-time timing-safe hash comparison
 * - Cryptographic session token generation and SHA-256 token hashing
 * - Full compatibility with both Google Apps Script runtime and Node.js testing environments
 */

var SecurityService = (typeof global !== 'undefined' && global.SecurityService) || {
  /**
   * Ensures a high-entropy server pepper exists in Script Properties.
   * Intended to be called only during owner-controlled installation/bootstrap.
   */
  ensurePepper() {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const props = PropertiesService.getScriptProperties();
      let pepper = props.getProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY);
      if (!pepper) {
        pepper = this.generateRandomHex(32);
        props.setProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY, pepper);
      }
      return pepper;
    }
    // Local/unit-test fallback only. Production Apps Script must use Script Properties.
    return CONSTANTS.SECURITY.DEFAULT_PEPPER;
  },

  /**
   * Retrieves server pepper. In Apps Script production this fails closed if the
   * installation step has not initialized the secret.
   */
  getPepper() {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const props = PropertiesService.getScriptProperties();
      const pepper = props.getProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY);
      if (pepper) return pepper;
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Server cryptographic secret is not initialized. Open the Master Sheet and choose FLINK Time → Prepare Installation.',
        500
      );
    }
    // Local/unit-test fallback only.
    return CONSTANTS.SECURITY.DEFAULT_PEPPER;
  },

  /**
   * Cross-runtime crypto resolver (resolves Node crypto or falls back cleanly in Apps Script)
   */
  _getCrypto() {
    if (typeof global !== 'undefined' && global.crypto && global.crypto.createHmac) return global.crypto;
    if (typeof crypto !== 'undefined' && crypto && crypto.createHmac) return crypto;
    try {
      if (typeof require === 'function') {
        const c = require('crypto');
        if (c && c.createHmac) return c;
      }
    } catch (e) {}
    return null;
  },

  /**
   * Generates cryptographically strong random hex string
   */
  generateRandomHex(numBytes = 16) {
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.randomBytes) {
      return nodeCrypto.randomBytes(numBytes).toString('hex');
    }
    // Apps Script fallback using UUID & timestamps
    let hex = '';
    while (hex.length < numBytes * 2) {
      const uuid = Utilities.getUuid().replace(/-/g, '');
      hex += uuid;
    }
    return hex.substring(0, numBytes * 2);
  },

  /**
   * Generates an opaque, cryptographically unpredictable 256-bit session token
   * Derived via HMAC-SHA256 with high-entropy server secret (pepper)
   */
  generateTemporaryPassword() {
    return 'Flk-' + this.generateRandomHex(16) + '!9aA';
  },

  generateSessionToken() {
    const nodeCrypto = this._getCrypto();
    const rawEntropy = (nodeCrypto && nodeCrypto.randomBytes)
      ? nodeCrypto.randomBytes(CONSTANTS.SECURITY.TOKEN_BYTES).toString('hex')
      : (Utilities.getUuid() + '-' + Date.now() + '-' + Math.random().toString(36).substring(2));

    const pepper = this.getPepper();
    const derivedBytes = this.hmacSha256(pepper, rawEntropy);
    const tokenHex = Array.from(derivedBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
    return 'FLK_' + tokenHex;
  },

  /**
   * Computes SHA-256 hash of a string (used for session tokens)
   */
  hashToken(token) {
    if (!token) return '';
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.createHash) {
      return nodeCrypto.createHash('sha256').update(token).digest('hex');
    }
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
    return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  },

  /**
   * Encodes a JavaScript string to UTF-8 bytes without relying on TextEncoder.
   */
  _utf8Bytes(value) {
    const str = String(value);
    const encoded = unescape(encodeURIComponent(str));
    const bytes = [];
    for (let i = 0; i < encoded.length; i++) {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
    return bytes;
  },

  _toSignedBytes(bytes) {
    return Array.from(bytes || []).map(b => {
      const value = Number(b) & 0xff;
      return value > 127 ? value - 256 : value;
    });
  },

  /**
   * Computes HMAC-SHA256 over true bytes in both Node and Apps Script.
   */
  hmacSha256(key, message) {
    const nodeCrypto = this._getCrypto();
    const keyBytes = Array.isArray(key) ? Array.from(key) : this._utf8Bytes(String(key));
    const messageBytes = Array.isArray(message) ? Array.from(message) : this._utf8Bytes(String(message));

    if (nodeCrypto && nodeCrypto.createHmac) {
      return Array.from(
        nodeCrypto
          .createHmac('sha256', Buffer.from(keyBytes))
          .update(Buffer.from(messageBytes))
          .digest()
      );
    }

    if (typeof Utilities === 'undefined' || !Utilities.computeHmacSha256Signature) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'HMAC-SHA256 runtime is unavailable.', 500);
    }

    const sig = Utilities.computeHmacSha256Signature(
      this._toSignedBytes(messageBytes),
      this._toSignedBytes(keyBytes)
    );
    return Array.from(sig).map(b => (b < 0 ? b + 256 : b));
  },

  /**
   * PBKDF2-HMAC-SHA256 Implementation
   * Standard RFC 2898 implementation compatible with Google Apps Script runtime.
   */
  pbkdf2Sync(password, salt, iterations = 10000, keyLenBytes = 32) {
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.pbkdf2Sync) {
      return nodeCrypto.pbkdf2Sync(password, salt, iterations, keyLenBytes, 'sha256').toString('hex');
    }

    const hLen = 32;
    const blockCount = Math.ceil(keyLenBytes / hLen);
    const finalBlockLength = keyLenBytes - (blockCount - 1) * hLen;
    const derived = [];
    const passwordBytes = this._utf8Bytes(password);
    const saltBytes = this._utf8Bytes(salt);

    for (let i = 1; i <= blockCount; i++) {
      const blockIndex = [
        (i >>> 24) & 0xff,
        (i >>> 16) & 0xff,
        (i >>> 8) & 0xff,
        i & 0xff
      ];

      let u = this.hmacSha256(passwordBytes, saltBytes.concat(blockIndex));
      const t = Array.from(u);

      for (let j = 1; j < iterations; j++) {
        u = this.hmacSha256(passwordBytes, u);
        for (let k = 0; k < hLen; k++) {
          t[k] ^= u[k];
        }
      }

      const take = i === blockCount ? finalBlockLength : hLen;
      for (let m = 0; m < take; m++) derived.push(t[m] & 0xff);
    }

    return derived.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  getStoredPasswordMetadata(storedHashString) {
    if (!storedHashString) return { version: '', iterations: 0 };
    const match = String(storedHashString).match(/^\$pbkdf2\$(v1|v2)\$i=(\d+)\$([^$]+)\$([^$]+)$/);
    if (!match) return { version: '', iterations: 0 };
    const iterations = parseInt(match[2], 10);
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) {
      return { version: '', iterations: 0 };
    }
    return { version: match[1], iterations };
  },

  getStoredPasswordIterations(storedHashString) {
    return this.getStoredPasswordMetadata(storedHashString).iterations;
  },

  getConfiguredPasswordIterations() {
    const hardFloor = Math.max(10000, Number(CONSTANTS.SECURITY.PBKDF2_ITERATIONS) || 10000);
    const hardCeiling = 1000000;
    let configured = hardFloor;
    try {
      if (
        typeof MasterRepository !== 'undefined' &&
        MasterRepository.getGlobalSettingFast
      ) {
        const raw = MasterRepository.getGlobalSettingFast(
          'PBKDF2_ITERATIONS',
          String(hardFloor)
        );
        configured = parseInt(raw, 10);
      }
    } catch (err) {
      configured = hardFloor;
    }
    if (!Number.isInteger(configured)) configured = hardFloor;
    return Math.min(hardCeiling, Math.max(hardFloor, configured));
  },

  needsPasswordHashUpgrade(storedHashString) {
    const stored = this.getStoredPasswordMetadata(storedHashString);
    if (!stored.iterations) return false;
    return stored.version !== 'v2' || stored.iterations < this.getConfiguredPasswordIterations();
  },

  /**
   * Hashes a password using PBKDF2-HMAC-SHA256 with per-user salt and server pepper.
   * The encoded iteration count permits safe upgrade-on-login.
   */
  hashPassword(plaintextPassword, iterationOverride = null) {
    Validation.validatePassword(plaintextPassword);
    const salt = this.generateRandomHex(CONSTANTS.SECURITY.SALT_BYTES);
    const pepper = this.getPepper();
    const saltedPepperedPassword = plaintextPassword + pepper;
    const configured = this.getConfiguredPasswordIterations();
    const requested = iterationOverride === null
      ? configured
      : parseInt(iterationOverride, 10);
    const iterations = Math.min(1000000, Math.max(10000, requested || configured));
    const hash = this.pbkdf2Sync(saltedPepperedPassword, salt, iterations, CONSTANTS.SECURITY.PBKDF2_KEY_BYTES);

    const separator = String.fromCharCode(36);
    return separator + 'pbkdf2' + separator + 'v2' + separator + 'i=' + iterations + separator + salt + separator + hash;
  },

  calibratePasswordKdf(targetMs = 700) {
    const safeTargetMs = Math.min(1500, Math.max(300, parseInt(targetMs, 10) || 700));
    const samplePassword = 'FLINK-PBKDF2-BENCHMARK-NOT-A-REAL-PASSWORD';
    const sampleSalt = '00112233445566778899aabbccddeeff';
    const keyBytes = CONSTANTS.SECURITY.PBKDF2_KEY_BYTES;
    const targets = [10000, 25000, 50000, 100000];
    const results = [];
    const overallStartedAt = Date.now();

    this.pbkdf2Sync(samplePassword, sampleSalt, 1000, keyBytes);
    for (const iterations of targets) {
      const startedAt = Date.now();
      this.pbkdf2Sync(samplePassword, sampleSalt, iterations, keyBytes);
      const elapsedMs = Math.max(1, Date.now() - startedAt);
      results.push({
        iterations,
        elapsedMs,
        millisecondsPerIteration: elapsedMs / iterations
      });
      if (elapsedMs >= 10000 || Date.now() - overallStartedAt >= 45000) break;
    }

    const usable = results.filter(result => result.elapsedMs > 0);
    const averageMsPerIteration = usable.length
      ? usable.reduce((sum, result) => sum + result.millisecondsPerIteration, 0) / usable.length
      : 0;
    const rawRecommendation = averageMsPerIteration > 0
      ? Math.round(safeTargetMs / averageMsPerIteration)
      : CONSTANTS.SECURITY.PBKDF2_ITERATIONS;
    const recommendedIterations = Math.min(
      1000000,
      Math.max(10000, Math.round(rawRecommendation / 1000) * 1000)
    );

    return {
      targetMs: safeTargetMs,
      currentIterations: this.getConfiguredPasswordIterations(),
      recommendedIterations,
      results,
      measuredAtUTC: new Date().toISOString()
    };
  },

  /**
   * Constant-time string comparison to mitigate timing attacks
   */
  constantTimeEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    // Use the longer length to avoid leaking length information via timing
    const len = Math.max(a.length, b.length);
    let mismatch = a.length !== b.length ? 1 : 0;
    for (let i = 0; i < len; i++) {
      const charA = i < a.length ? a.charCodeAt(i) : 0;
      const charB = i < b.length ? b.charCodeAt(i) : 0;
      mismatch |= (charA ^ charB);
    }
    return mismatch === 0;
  },

  /**
   * Verifies a plaintext password against a stored PBKDF2 hash
   */
  verifyPassword(plaintextPassword, storedHashString) {
    if (!plaintextPassword || !storedHashString) return false;
    const parts = String(storedHashString).split('$');
    // Expected parts: ["", "pbkdf2", "v1|v2", "i=<iterations>", "salt", "hash"]
    if (
      parts.length !== 6 ||
      parts[1] !== 'pbkdf2' ||
      (parts[2] !== 'v1' && parts[2] !== 'v2')
    ) {
      return false;
    }

    const iterMatch = parts[3].match(/^i=(\d+)$/);
    const iterations = iterMatch ? parseInt(iterMatch[1], 10) : 0;
    if (!Number.isInteger(iterations) || iterations < 10000 || iterations > 1000000) {
      return false;
    }
    const salt = parts[4];
    const expectedHash = parts[5];
    if (!salt || !expectedHash) return false;

    const pepper = this.getPepper();
    const saltedPepperedPassword = plaintextPassword + pepper;
    const computedHash = this.pbkdf2Sync(
      saltedPepperedPassword,
      salt,
      iterations,
      CONSTANTS.SECURITY.PBKDF2_KEY_BYTES
    );

    return this.constantTimeEquals(computedHash, expectedHash);
  },

  /* ------------------- RFC 6238 TOTP MFA ------------------- */

  /**
   * Base32 decoding for RFC 6238 TOTP
   */
  base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanStr = String(str).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const output = [];

    for (let i = 0; i < cleanStr.length; i++) {
      const idx = alphabet.indexOf(cleanStr[i]);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return output;
  },

  /**
   * Base32 encoding for RFC 6238 TOTP
   */
  base32Encode(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | (bytes[i] & 0xff);
      bits += 8;
      while (bits >= 5) {
        output += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += alphabet[(value << (5 - bits)) & 31];
    }
    return output;
  },

  /**
   * Generates a random Base32 secret for TOTP (160 bits / 20 bytes -> 32 chars)
   */
  generateTotpSecret(numBytes = 20) {
    const hex = this.generateRandomHex(numBytes);
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return this.base32Encode(bytes);
  },

  /**
   * Generates RFC 6238 TOTP code for a secret and time
   */
  /**
   * Derives a 256-bit encryption key from server pepper
   */
  _getSecretEncryptionKey() {
    const pepper = this.getPepper();
    const keyBytes = this.hmacSha256(pepper, 'FLINK_TOTP_KEY_ENCRYPTION');
    return keyBytes;
  },

  /**
   * Symmetrically encrypts sensitive secret material (e.g. TOTP secrets) at rest
   * using an authenticated HMAC-SHA256 keystream cipher (IND-CPA + INT-CTXT).
   */
  encryptSecret(plaintext) {
    if (!plaintext) return '';
    if (String(plaintext).startsWith('enc$v1$')) return plaintext;

    const key = this._getSecretEncryptionKey();
    const ivHex = this.generateRandomHex(16);
    const textBytes = [];
    for (let i = 0; i < plaintext.length; i++) {
      textBytes.push(plaintext.charCodeAt(i) & 0xff);
    }

    const cipherBytes = [];
    const hLen = 32;
    const blocksNeeded = Math.ceil(textBytes.length / hLen);

    for (let b = 0; b < blocksNeeded; b++) {
      const ks = this.hmacSha256(key, `${ivHex}:${b}`);
      for (let j = 0; j < hLen; j++) {
        const byteIdx = b * hLen + j;
        if (byteIdx >= textBytes.length) break;
        cipherBytes.push(textBytes[byteIdx] ^ ks[j]);
      }
    }

    const cipherHex = cipherBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    const tagBytes = this.hmacSha256(key, `TAG:${ivHex}:${cipherHex}`);
    const tagHex = Array.from(tagBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');

    return `enc$v1$${ivHex}$${cipherHex}$${tagHex}`;
  },

  /**
   * Decrypts secret material encrypted via encryptSecret
   */
  decryptSecret(encryptedStr) {
    if (!encryptedStr) return '';
    if (!String(encryptedStr).startsWith('enc$v1$')) {
      return encryptedStr;
    }

    const parts = encryptedStr.split('$');
    if (parts.length < 5) throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Malformed encrypted secret format.', 500);

    const ivHex = parts[2];
    const cipherHex = parts[3];
    const tagHex = parts[4];

    const key = this._getSecretEncryptionKey();
    const expectedTagBytes = this.hmacSha256(key, `TAG:${ivHex}:${cipherHex}`);
    const expectedTagHex = Array.from(expectedTagBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');

    if (!this.constantTimeEquals(tagHex, expectedTagHex)) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Secret integrity validation failed. Tampering detected.', 500);
    }

    const cipherBytes = [];
    for (let i = 0; i < cipherHex.length; i += 2) {
      cipherBytes.push(parseInt(cipherHex.substr(i, 2), 16));
    }

    const plainBytes = [];
    const hLen = 32;
    const blocksNeeded = Math.ceil(cipherBytes.length / hLen);

    for (let b = 0; b < blocksNeeded; b++) {
      const ks = this.hmacSha256(key, `${ivHex}:${b}`);
      for (let j = 0; j < hLen; j++) {
        const byteIdx = b * hLen + j;
        if (byteIdx >= cipherBytes.length) break;
        plainBytes.push(cipherBytes[byteIdx] ^ ks[j]);
      }
    }

    return plainBytes.map(b => String.fromCharCode(b)).join('');
  },

  /**
   * Generates RFC 6238 TOTP code for a secret and time
   */
  generateTotpCode(secret, timeMs = Date.now(), stepSeconds = 30, codeLength = 6, userId = '', secretIsPlaintext = false) {
    const rawSecret = secretIsPlaintext
      ? String(secret || '')
      : KmsSecretService.decryptTotpSecret(userId, secret);
    const keyBytes = this.base32Decode(rawSecret);
    const counter = Math.floor(timeMs / 1000 / stepSeconds);

    // Convert 64-bit integer counter to 8 big-endian bytes
    const counterBytes = [];
    let temp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = temp & 0xff;
      temp = Math.floor(temp / 256);
    }

    let hmacResult;
    let nodeCrypto = null;
    try {
      if (typeof require !== 'undefined') {
        nodeCrypto = require('crypto');
      }
    } catch (e) {}

    if (nodeCrypto && nodeCrypto.createHmac) {
      const keyBuf = Buffer.from(keyBytes);
      const msgBuf = Buffer.from(counterBytes);
      hmacResult = Array.from(nodeCrypto.createHmac('sha1', keyBuf).update(msgBuf).digest());
    } else if (typeof Utilities !== 'undefined' && Utilities.computeHmacSignature) {
      // Google Apps Script byte[] overload. Never route binary key/counter bytes
      // through JavaScript strings/character encodings.
      const algo = (Utilities.MacAlgorithm && Utilities.MacAlgorithm.HMAC_SHA_1)
        ? Utilities.MacAlgorithm.HMAC_SHA_1
        : 'HMAC_SHA_1';
      const sig = Utilities.computeHmacSignature(
        algo,
        this._toSignedBytes(counterBytes),
        this._toSignedBytes(keyBytes)
      );
      hmacResult = Array.from(sig).map(b => (b < 0 ? b + 256 : b));
    }

    const offset = hmacResult[hmacResult.length - 1] & 0x0f;
    const binary =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, codeLength);
    return String(otp).padStart(codeLength, '0');
  },

  /**
   * Verifies an RFC 6238 TOTP code with time drift window tolerance and returns matched step
   */
  verifyTotpWithStep(secret, code, window = 1, timeMs = Date.now(), stepSeconds = 30, userId = '') {
    if (!secret || !code) return { valid: false, timeStep: null };
    const cleanCode = String(code).trim();
    if (cleanCode.length !== 6) return { valid: false, timeStep: null };

    // Decrypt once. KMS ciphertext is bound to this UserID through authenticated data.
    const rawSecret = KmsSecretService.decryptTotpSecret(userId, secret);

    for (let errorStep = -window; errorStep <= window; errorStep++) {
      const checkTime = timeMs + (errorStep * stepSeconds * 1000);
      const expectedCode = this.generateTotpCode(rawSecret, checkTime, stepSeconds, 6, userId, true);
      if (this.constantTimeEquals(cleanCode, expectedCode)) {
        return {
          valid: true,
          timeStep: Math.floor(checkTime / 1000 / stepSeconds)
        };
      }
    }
    return { valid: false, timeStep: null };
  },

  /**
   * Verifies an RFC 6238 TOTP code with time drift window tolerance (boolean response)
   */
  verifyTotp(secret, code, window = 1, timeMs = Date.now(), stepSeconds = 30, userId = '') {
    return this.verifyTotpWithStep(secret, code, window, timeMs, stepSeconds, userId).valid;
  },

  /* ------------------- TAMPER-EVIDENT AUDIT HASH CHAINING ------------------- */

  /**
   * Computes HMAC-SHA256 hash for audit record chained to previous hash.
   * Keyed with external server pepper (inaccessible to spreadsheet viewers).
   */
  buildAuditPayloadV2(record, workspaceScope = '') {
    const asStoredString = value => {
      if (value === null || value === undefined) return '';
      return typeof value === 'object' ? JSON.stringify(value) : String(value);
    };
    return {
      version: 2,
      auditId: asStoredString(record.AuditID),
      timestamp: asStoredString(record.TimestampUTC),
      actor: asStoredString(record.ActorUserID),
      actorRole: asStoredString(record.ActorRole),
      workspaceId: asStoredString(workspaceScope || record.WorkspaceID || ''),
      entityType: asStoredString(record.EntityType),
      entityId: asStoredString(record.EntityID),
      action: asStoredString(record.Action),
      before: asStoredString(record.BeforeJSON),
      after: asStoredString(record.AfterJSON),
      reason: asStoredString(record.Reason),
      correlationId: asStoredString(record.CorrelationID),
      clientType: asStoredString(record.ClientType || 'WEB')
    };
  },

  computeAuditHash(previousHash, recordPayload) {
    const prev = previousHash || '0000000000000000000000000000000000000000000000000000000000000000';
    const payloadStr = typeof recordPayload === 'object' ? JSON.stringify(recordPayload) : String(recordPayload);
    const auditKey = this.getPepper() + (CONSTANTS.SECURITY.AUDIT_KEY_SUFFIX || '_FLINK_AUDIT_KEY');
    const bytes = this.hmacSha256(auditKey, `${prev}|${payloadStr}`);
    return Array.from(bytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  },

  computeAuditRecordHashV2(previousHash, record, workspaceScope = '') {
    return 'v2:' + this.computeAuditHash(
      previousHash,
      this.buildAuditPayloadV2(record, workspaceScope)
    );
  },

  /**
   * Computes external audit checkpoint root hash
   */
  computeAuditCheckpoint(scope, dateStr, lastHash, totalRecords) {
    const auditKey = this.getPepper() + (CONSTANTS.SECURITY.AUDIT_KEY_SUFFIX || '_FLINK_AUDIT_KEY');
    const message = `CHECKPOINT|${scope}|${dateStr}|${lastHash}|${totalRecords}`;
    const bytes = this.hmacSha256(auditKey, message);
    return Array.from(bytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  }
};

/* ===== KmsSecretService.gs ===== */
/**
 * Versioned TOTP secret storage using Google Cloud KMS.
 *
 * Modes:
 * - DISABLED: legacy enc$v1$ remains active for backwards compatibility.
 * - DUAL_READ: new secrets are KMS-backed; legacy enc$v1$ can still be read for migration.
 * - KMS_REQUIRED: only kms$v1$ is accepted by normal authentication paths.
 */
var KmsSecretService = {
  MODES: {
    DISABLED: 'DISABLED',
    DUAL_READ: 'DUAL_READ',
    KMS_REQUIRED: 'KMS_REQUIRED'
  },

  getMode() {
    let mode = this.MODES.DISABLED;
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      mode = String(
        PropertiesService.getScriptProperties().getProperty('FLINK_KMS_MODE') ||
        this.MODES.DISABLED
      ).toUpperCase();
    }
    if (!Object.values(this.MODES).includes(mode)) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Invalid FLINK_KMS_MODE configuration.', 500);
    }
    return mode;
  },

  getKeyResource() {
    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      return '';
    }
    const value = String(
      PropertiesService.getScriptProperties().getProperty('FLINK_KMS_KEY_RESOURCE') || ''
    ).trim();
    if (!value) return '';
    if (!/^projects\/[^/]+\/locations\/[^/]+\/keyRings\/[^/]+\/cryptoKeys\/[^/]+$/.test(value)) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Invalid Cloud KMS key resource configuration.', 500);
    }
    return value;
  },

  _aad(userId) {
    const id = String(userId || '').trim();
    if (!id) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'User binding is required for protected MFA secrets.',
        500
      );
    }
    return 'FLINK_TOTP_V1|' + id;
  },

  _base64EncodeUtf8(value) {
    const text = String(value === null || value === undefined ? '' : value);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(text, 'utf8').toString('base64');
    }
    return Utilities.base64Encode(text, Utilities.Charset.UTF_8);
  },

  _base64DecodeUtf8(value) {
    const encoded = String(value || '');
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(encoded, 'base64').toString('utf8');
    }
    const bytes = Utilities.base64Decode(encoded);
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  },

  _sleep(ms) {
    if (typeof Utilities !== 'undefined' && Utilities.sleep) {
      Utilities.sleep(ms);
    }
  },

  _requestKms(operation, payload) {
    const keyResource = this.getKeyResource();
    if (!keyResource) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Cloud KMS is not configured for FLINK Time.',
        503
      );
    }
    if (
      typeof UrlFetchApp === 'undefined' ||
      !UrlFetchApp.fetch ||
      typeof ScriptApp === 'undefined' ||
      !ScriptApp.getOAuthToken
    ) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cloud KMS runtime is unavailable.', 503);
    }

    const correlationId = SecurityService.generateRandomHex(8);
    const url = 'https://cloudkms.googleapis.com/v1/' + keyResource + ':' + operation;
    const token = ScriptApp.getOAuthToken();

    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      let status = 0;
      try {
        response = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { Authorization: 'Bearer ' + token },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        status = Number(response.getResponseCode() || 0);
      } catch (err) {
        if (attempt < 2) {
          this._sleep(250 * (attempt + 1));
          continue;
        }
        console.error('Cloud KMS transport failure', {
          operation,
          correlationId
        });
        throw new AppError(
          ERROR_CODES.CRYPTO_FAILURE,
          'Security service is temporarily unavailable. Reference: ' + correlationId,
          503
        );
      }

      if (status >= 200 && status < 300) {
        try {
          return JSON.parse(response.getContentText() || '{}');
        } catch (err) {
          throw new AppError(
            ERROR_CODES.CRYPTO_FAILURE,
            'Cloud KMS returned an invalid response.',
            503
          );
        }
      }

      const transient = status === 429 || status >= 500;
      if (transient && attempt < 2) {
        this._sleep(250 * (attempt + 1));
        continue;
      }

      console.error('Cloud KMS request rejected', {
        operation,
        status,
        correlationId
      });
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Security service is temporarily unavailable. Reference: ' + correlationId,
        503
      );
    }

    throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cloud KMS request failed.', 503);
  },

  _encryptWithKms(userId, plaintextSecret) {
    const result = this._requestKms('encrypt', {
      plaintext: this._base64EncodeUtf8(plaintextSecret),
      additionalAuthenticatedData: this._base64EncodeUtf8(this._aad(userId))
    });
    if (!result || !result.ciphertext) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cloud KMS encryption failed.', 503);
    }
    return 'kms$v1$' + String(result.ciphertext);
  },

  _decryptWithKms(userId, storedCiphertext) {
    const value = String(storedCiphertext || '');
    if (!value.startsWith('kms$v1$')) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Malformed KMS-protected secret format.', 500);
    }
    const ciphertext = value.slice('kms$v1$'.length);
    if (!ciphertext) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Malformed KMS-protected secret format.', 500);
    }
    const result = this._requestKms('decrypt', {
      ciphertext,
      additionalAuthenticatedData: this._base64EncodeUtf8(this._aad(userId))
    });
    if (!result || !result.plaintext) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cloud KMS decryption failed.', 503);
    }
    return this._base64DecodeUtf8(result.plaintext);
  },

  encryptTotpSecret(userId, plaintextSecret) {
    if (!plaintextSecret) return '';
    const mode = this.getMode();
    if (mode === this.MODES.DISABLED) {
      return SecurityService.encryptSecret(String(plaintextSecret));
    }
    return this._encryptWithKms(userId, String(plaintextSecret));
  },

  decryptTotpSecret(userId, storedCiphertext) {
    if (!storedCiphertext) return '';
    const value = String(storedCiphertext);

    // Never fall back from a KMS record to legacy cryptography.
    if (value.startsWith('kms$v1$')) {
      return this._decryptWithKms(userId, value);
    }

    const mode = this.getMode();
    if (value.startsWith('enc$v1$')) {
      if (mode === this.MODES.KMS_REQUIRED) {
        throw new AppError(
          ERROR_CODES.CRYPTO_FAILURE,
          'Legacy MFA secret rejected because Cloud KMS is required.',
          503
        );
      }
      return SecurityService.decryptSecret(value);
    }

    // Plaintext compatibility is allowed only before KMS migration is activated.
    if (mode === this.MODES.DISABLED) {
      return SecurityService.decryptSecret(value);
    }

    throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Unversioned MFA secret rejected.', 503);
  },

  migrateTotpSecret(userId, storedCiphertext) {
    const value = String(storedCiphertext || '');
    if (!value) return '';
    if (value.startsWith('kms$v1$')) return value;

    const plaintext = value.startsWith('enc$v1$')
      ? SecurityService.decryptSecret(value)
      : value;
    const migrated = this._encryptWithKms(userId, plaintext);
    const verified = this._decryptWithKms(userId, migrated);
    if (!SecurityService.constantTimeEquals(String(plaintext), String(verified))) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'KMS migration verification failed.', 503);
    }
    return migrated;
  },

  getStatus() {
    return {
      mode: this.getMode(),
      keyConfigured: !!this.getKeyResource()
    };
  }
};

/* ===== AuthorizationService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Authorization & RBAC Service
 * Strictly enforces server-side role-based access control, workspace isolation,
 * record ownership, and the hard Admin 3-workspace assignment limit.
 */

var AuthorizationService = (typeof global !== 'undefined' && global.AuthorizationService) || {
  /**
   * Asserts that authenticated user possesses one of the allowed roles
   */
  assertRole(authContext, allowedRoles = []) {
    if (!authContext || !authContext.role) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!allowedRoles.includes(authContext.role)) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `Permission denied. Required roles: ${allowedRoles.join(', ')}. Current role: ${authContext.role}`,
        403
      );
    }
  },

  /**
   * Asserts that authenticated user has authorized access to requested workspace
   */
  assertWorkspaceAccess(authContext, requestedWorkspaceId) {
    if (!authContext || !authContext.userId) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!requestedWorkspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    const workspace = MasterRepository.getWorkspace(requestedWorkspaceId);
    if (!workspace) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${requestedWorkspaceId}' does not exist.`, 404);
    }
    if (workspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        `Workspace '${requestedWorkspaceId}' is not active (${workspace.Status}).`,
        403
      );
    }

    // Super Admin has global access to active workspaces.
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }

    // Authorization is based only on active WorkspaceAccess mappings.
    // PrimaryWorkspaceID is profile/default-selection metadata, not an ACL.
    const userBundle = MasterRepository.getUserAuthBundle
      ? MasterRepository.getUserAuthBundle(authContext.userId)
      : { account: authContext.user, accesses: MasterRepository.getWorkspaceAccessForUser(authContext.userId) };
    const accesses = userBundle.accesses || [];
    const hasAccess = accesses.some(a =>
      a.WorkspaceID === requestedWorkspaceId &&
      (a.Active === true || a.Active === 'TRUE' || a.Active === 1)
    );

    if (!hasAccess) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        `Access to workspace '${requestedWorkspaceId}' is denied for user '${authContext.user.Username}'.`,
        403
      );
    }

    return true;
  },

  /**
   * Strictly enforces that an Admin cannot be assigned to more than 3 active workspaces
   */
  assertAdminWorkspaceLimit(targetUserId, targetWorkspaceId) {
    const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);

    // The business rule is "maximum active workspaces", not "maximum active ACL
    // rows". A stale ACL pointing at SUSPENDED/MAINTENANCE/ARCHIVED workspace
    // must not consume one of the three operational Admin slots.
    const activeAdminWorkspaces = existingAccesses.filter(access => {
      if (access.Role !== CONSTANTS.ROLES.ADMIN) return false;
      const workspace = MasterRepository.getWorkspace(access.WorkspaceID);
      return workspace && workspace.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
    });

    const alreadyAssigned = activeAdminWorkspaces.some(a => a.WorkspaceID === targetWorkspaceId);
    if (!alreadyAssigned && activeAdminWorkspaces.length >= CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
      throw new AppError(
        ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
        `Admin assignment limit exceeded. An Admin may manage at most ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES} active workspaces.`,
        400
      );
    }
  },

  /**
   * Asserts record ownership: Users can only manipulate their own unapproved records
   */
  assertRecordOwnership(authContext, recordUserId) {
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }
    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      return true; // Admins have operational review rights within their assigned workspaces
    }
    if (authContext.userId !== recordUserId) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'You do not have permission to modify another user\'s records.', 403);
    }
    return true;
  }
};

/* ===== SessionService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Session Service
 * Manages secure 256-bit token sessions with token hashing, idle & absolute timeouts,
 * and automatic revocation upon password changes or account suspension.
 */

var SessionService = (typeof global !== 'undefined' && global.SessionService) || {
  _sessionCacheMemory: {},

  _sessionCacheKey(tokenHash) {
    return 'S:' + String(tokenHash || '');
  },

  _getCachedSession(tokenHash) {
    const key = this._sessionCacheKey(tokenHash);
    let raw = '';
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { raw = CacheService.getScriptCache().get(key) || ''; } catch (e) {}
    } else {
      raw = this._sessionCacheMemory[key] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) {
      this._deleteCachedSession(tokenHash);
      return null;
    }
  },

  _putCachedSession(tokenHash, session) {
    if (!tokenHash || !session) return;
    const key = this._sessionCacheKey(tokenHash);
    const raw = JSON.stringify(session);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().put(key, raw, 300); } catch (e) {}
    } else {
      this._sessionCacheMemory[key] = raw;
    }
  },

  _deleteCachedSession(tokenHash) {
    const key = this._sessionCacheKey(tokenHash);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().remove(key); } catch (e) {}
    }
    delete this._sessionCacheMemory[key];
  },

  /**
   * Creates and registers a new authenticated session
   */
  createSession(userId, clientType = 'WEB', clientLabel = '') {
    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    let verifiedClientLabel = String(clientLabel || '').trim();
    let sessionAccount = null;

    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Unsupported authentication channel.',
        401
      );
    }

    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      const accountBundle = MasterRepository.getUserAuthBundle
        ? MasterRepository.getUserAuthBundle(userId)
        : { account: MasterRepository.findAccountById(userId), accesses: [] };
      const account = accountBundle.account;
      sessionAccount = account;
      if (!account) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'User account could not be resolved for session creation.',
          401
        );
      }
      const verifiedEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      if (
        verifiedClientLabel &&
        IdentityService.normalizeEmail(verifiedClientLabel) !== verifiedEmail
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Verified Google Workspace identity changed before session creation.',
          401
        );
      }
      verifiedClientLabel = verifiedEmail;
    }

    const rawToken = SecurityService.generateSessionToken();
    const tokenHash = SecurityService.hashToken(rawToken);
    const now = new Date();
    const sessionId = Validation.generateId('SES');

    let idleTimeoutMinutes = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 60;
    let absoluteTimeoutHours = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS;
    try {
      if (typeof Flags !== 'undefined' && Flags.getNumber) {
        idleTimeoutMinutes = Flags.getNumber('SESSION_IDLE_MINUTES') || idleTimeoutMinutes;
        absoluteTimeoutHours = Flags.getNumber('SESSION_MAX_HOURS') || absoluteTimeoutHours;
      }
    } catch (err) {}
    const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
    const absoluteTimeoutMs = absoluteTimeoutHours * 3600 * 1000;
    const expiresAt = new Date(now.getTime() + idleTimeoutMs);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteTimeoutMs);

    const sessionRecord = {
      SessionID: sessionId,
      UserID: userId,
      TokenHash: tokenHash,
      ClientType: normalizedClientType,
      ClientLabel: verifiedClientLabel,
      CreatedAt: now.toISOString(),
      LastSeenAt: now.toISOString(),
      ExpiresAt: expiresAt.toISOString(),
      AbsoluteExpiresAt: absoluteExpiresAt.toISOString(),
      Revoked: false,
      RevokedAt: '',
      AccountEpoch:
        sessionAccount && Number(sessionAccount.SessionEpoch) > 0
          ? Number(sessionAccount.SessionEpoch)
          : 1
    };

    MasterRepository.createSession(sessionRecord);
    this._putCachedSession(tokenHash, sessionRecord);

    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt: expiresAt.toISOString()
    };
  },

  /**
   * Validates session token, checks timeouts, verifies user active status, and slides expiration
   */
  validateSession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication token required.', 401);
    }

    const tokenHash = SecurityService.hashToken(rawToken.trim());
    let session = this._getCachedSession(tokenHash);
    if (!session) {
      session = MasterRepository.findSessionByTokenHashFast
        ? MasterRepository.findSessionByTokenHashFast(tokenHash)
        : MasterRepository.findSessionByTokenHash(tokenHash);
      if (session) this._putCachedSession(tokenHash, session);
    }

    if (!session) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired session.', 401);
    }

    const now = Date.now();
    const expiresAt = new Date(session.ExpiresAt).getTime();
    const lastSeenAt = new Date(session.LastSeenAt).getTime();
    const createdAt = new Date(session.CreatedAt).getTime();

    if ([expiresAt, lastSeenAt, createdAt].some(v => !Number.isFinite(v))) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Session record is invalid. Please sign in again.', 401);
    }

    let idleTimeoutMinutes = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 60;
    let absoluteTimeoutHours = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS;
    try {
      if (typeof Flags !== 'undefined' && Flags.getNumber) {
        idleTimeoutMinutes = Flags.getNumber('SESSION_IDLE_MINUTES') || idleTimeoutMinutes;
        absoluteTimeoutHours = Flags.getNumber('SESSION_MAX_HOURS') || absoluteTimeoutHours;
      }
    } catch (err) {}
    const idleTimeoutMs = idleTimeoutMinutes * 60 * 1000;
    const absoluteTimeoutMs = absoluteTimeoutHours * 3600 * 1000;
    const storedAbsoluteExpiresAt = new Date(session.AbsoluteExpiresAt || '').getTime();
    const absoluteExpiresAt = isNaN(storedAbsoluteExpiresAt)
      ? createdAt + absoluteTimeoutMs
      : storedAbsoluteExpiresAt;

    if (
      now > expiresAt ||
      (now - lastSeenAt) > idleTimeoutMs ||
      now > absoluteExpiresAt
    ) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.SESSION_EXPIRED, 'Session has expired due to timeout. Please sign in again.', 401);
    }

    // Verify current account/access state. The U:<userId> cache is short-lived
    // and explicitly invalidated by account/access mutations.
    const userBundle = MasterRepository.getUserAuthBundle
      ? MasterRepository.getUserAuthBundle(session.UserID)
      : { account: MasterRepository.findAccountById(session.UserID), accesses: [] };
    const user = userBundle.account;
    if (!user) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User account no longer exists.', 401);
    }

    if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Sign in again after it is unlocked.', 403);
    }

    if (user.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, 'Account is inactive or suspended.', 403);
    }

    const currentEpoch = Number(user.SessionEpoch) > 0 ? Number(user.SessionEpoch) : 1;
    const sessionEpoch = Number(session.AccountEpoch) > 0 ? Number(session.AccountEpoch) : 1;
    if (sessionEpoch !== currentEpoch) {
      this._deleteCachedSession(tokenHash);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Session has been revoked. Please sign in again.',
        401
      );
    }

    const normalizedClientType = String(session.ClientType || '').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString(),
        RevokeReason: 'UNSUPPORTED_CLIENT_TYPE'
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Session authentication channel is no longer supported. Please sign in again.',
        401
      );
    }

    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      try {
        const currentGoogleEmail = IdentityService.assertAccountIdentity(
          user,
          normalizedClientType
        );
        const boundGoogleEmail = IdentityService.normalizeEmail(
          session.ClientLabel || ''
        );
        if (!boundGoogleEmail || boundGoogleEmail !== currentGoogleEmail) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Session identity binding does not match the active Google account.',
            401
          );
        }
      } catch (identityErr) {
        MasterRepository.updateSession(session.SessionID, {
          Revoked: true,
          RevokedAt: new Date().toISOString(),
          RevokeReason: 'GOOGLE_IDENTITY_MISMATCH'
        });
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Google Workspace identity changed. Please sign in again.',
          401
        );
      }
    }

    // Persist activity at a coarse interval instead of writing to Sheets on
    // every authenticated read/poll. Idle semantics remain unchanged because
    // the touch interval is tiny compared with the idle timeout.
    const touchIntervalMs =
      (CONSTANTS.LIMITS.SESSION_TOUCH_INTERVAL_MINUTES || 5) * 60 * 1000;
    if ((now - lastSeenAt) >= touchIntervalMs) {
      const newExpiresMs = Math.min(now + idleTimeoutMs, absoluteExpiresAt);
      const touch = {
        LastSeenAt: new Date(now).toISOString(),
        ExpiresAt: new Date(newExpiresMs).toISOString(),
        AbsoluteExpiresAt: new Date(absoluteExpiresAt).toISOString()
      };
      MasterRepository.updateSession(session.SessionID, touch);
      session = { ...session, ...touch };
      this._putCachedSession(tokenHash, session);
    }

    return {
      session,
      user,
      username: user.Username,
      role: user.Role,
      userId: user.UserID
    };
  },

  /**
   * Explicitly revokes a single session (e.g. on logout)
   */
  revokeSession(rawToken) {
    if (!rawToken) return;
    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHashFast
      ? MasterRepository.findSessionByTokenHashFast(tokenHash)
      : MasterRepository.findSessionByTokenHash(tokenHash);
    if (session) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
    }
    this._deleteCachedSession(tokenHash);
  },

  /**
   * Revokes all active sessions for a user (e.g. password change, account passive)
   */
  revokeAllUserSessions(userId) {
    MasterRepository.revokeAllUserSessions(userId);
  }
};

/* ===== AuthService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Authentication Service
 * Manages user authentication, lockout protection (5 attempts / 15 min),
 * password changes, administrative resets, and session issuance.
 */

var AuthService = (typeof global !== 'undefined' && global.AuthService) || {
  _mfaChallengeMemory: {},
  _mfaEnrollmentMemory: {},
  _stepUpMemory: {},

  _mfaChallengePropertyKey(userId) {
    return 'FLINK_MFA_CHALLENGE_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaChallenge(userId, challengeToken, expiresAtMs, googleEmail = '') {
    const record = JSON.stringify({
      tokenHash: SecurityService.hashToken(challengeToken),
      expiresAtMs: Number(expiresAtMs),
      googleEmail: IdentityService.normalizeEmail(googleEmail)
    });

    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .setProperty(this._mfaChallengePropertyKey(userId), record);
      return;
    }

    // Local/unit-test fallback only.
    this._mfaChallengeMemory[userId] = record;
  },

  _getMfaChallenge(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService
        .getScriptProperties()
        .getProperty(this._mfaChallengePropertyKey(userId)) || '';
    } else {
      raw = this._mfaChallengeMemory[userId] || '';
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  _deleteMfaChallenge(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .deleteProperty(this._mfaChallengePropertyKey(userId));
    } else {
      delete this._mfaChallengeMemory[userId];
    }
  },

  _mfaEnrollmentPropertyKey(userId) {
    return 'FLINK_MFA_ENROLLMENT_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaEnrollment(userId, record) {
    const serialized = JSON.stringify(record || {});
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().setProperty(
        this._mfaEnrollmentPropertyKey(userId),
        serialized
      );
    } else {
      this._mfaEnrollmentMemory[userId] = serialized;
    }
  },

  _getMfaEnrollment(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService.getScriptProperties().getProperty(
        this._mfaEnrollmentPropertyKey(userId)
      ) || '';
    } else {
      raw = this._mfaEnrollmentMemory[userId] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  _deleteMfaEnrollment(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().deleteProperty(
        this._mfaEnrollmentPropertyKey(userId)
      );
    } else {
      delete this._mfaEnrollmentMemory[userId];
    }
  },

  _stepUpPropertyKey(sessionId) {
    return 'FLINK_STEP_UP_' + String(sessionId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeStepUp(sessionId, record) {
    const serialized = JSON.stringify(record || {});
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().setProperty(this._stepUpPropertyKey(sessionId), serialized);
    } else {
      this._stepUpMemory[sessionId] = serialized;
    }
  },

  _getStepUp(sessionId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService.getScriptProperties().getProperty(this._stepUpPropertyKey(sessionId)) || '';
    } else {
      raw = this._stepUpMemory[sessionId] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  _deleteStepUp(sessionId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService.getScriptProperties().deleteProperty(this._stepUpPropertyKey(sessionId));
    } else {
      delete this._stepUpMemory[sessionId];
    }
  },

  _withLoginStateLock(fn) {
    if (
      typeof LockService === 'undefined' ||
      !LockService.getScriptLock
    ) {
      return fn();
    }

    const lock = LockService.getScriptLock();
    if (!lock || typeof lock.hasLock !== 'function') {
      // Unit-test/non-Apps-Script adapters may not implement hasLock().
      return fn();
    }
    if (lock.hasLock()) return fn();

    lock.waitLock(5000);
    try {
      return fn();
    } finally {
      try { lock.releaseLock(); } catch (e) {}
    }
  },

  _enforceLoginRateLimit(googleEmail) {
    if (
      typeof CacheService === 'undefined' ||
      !CacheService.getScriptCache
    ) {
      return;
    }

    try {
      const cache = CacheService.getScriptCache();
      if (!cache || !cache.get || !cache.put) return;

      const minuteBucket = Math.floor(Date.now() / 60000);
      const identityKey = SecurityService
        .hashToken(IdentityService.normalizeEmail(googleEmail || 'unknown'))
        .substring(0, 20);
      const callerKey = `FLINK_LOGIN_CALLER_${identityKey}_${minuteBucket}`;
      const globalKey = `FLINK_LOGIN_GLOBAL_${minuteBucket}`;

      const updateCounters = () => {
        const callerCount = (parseInt(cache.get(callerKey), 10) || 0) + 1;
        cache.put(callerKey, String(callerCount), 120);

        if (
          callerCount >
            (CONSTANTS.LIMITS.LOGIN_CALLER_ATTEMPTS_PER_MINUTE || 30)
        ) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Invalid username or password.',
            401
          );
        }

        const globalCount = (parseInt(cache.get(globalKey), 10) || 0) + 1;
        cache.put(globalKey, String(globalCount), 120);
        if (
          globalCount >
            (CONSTANTS.LIMITS.LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE || 1000)
        ) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Invalid username or password.',
            401
          );
        }
      };

      // CacheService has no atomic increment. Serialize this tiny counter update
      // when the real Apps Script Lock API is available.
      if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
        const lock = LockService.getScriptLock();
        if (lock && typeof lock.hasLock === 'function' && !lock.hasLock()) {
          lock.waitLock(2000);
          try {
            updateCounters();
          } finally {
            try { lock.releaseLock(); } catch (e) {}
          }
          return;
        }
      }
      updateCounters();
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Cache/rate-limit infrastructure failure must not disclose internals.
      console.warn('Login rate-limit cache unavailable: ' + err.message);
    }
  },

  _shouldLogRejectedLogin(keyMaterial) {
    if (
      typeof CacheService === 'undefined' ||
      !CacheService.getScriptCache
    ) {
      return true;
    }
    try {
      const cache = CacheService.getScriptCache();
      const bucket = Math.floor(Date.now() / 60000);
      const digest = SecurityService.hashToken(String(keyMaterial || '')).substring(0, 20);
      const key = `FLINK_LOGIN_EVENT_${digest}_${bucket}`;
      if (cache.get(key)) return false;
      cache.put(key, '1', 120);
      return true;
    } catch (e) {
      return true;
    }
  },

  /**
   * Authenticates user with username and password
   */
  login(username, password, clientType = 'WEB') {
    const invalidAuth = () => new AppError(
      ERROR_CODES.AUTH_REQUIRED,
      'Invalid username or password.',
      401
    );

    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username ||
      !password ||
      username.length > 50 ||
      password.length > (CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH || 128)
    ) {
      throw invalidAuth();
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      throw invalidAuth();
    }
    const cleanUsername = String(username).trim().toLowerCase();

    // WEB authentication is always bound to the server-observed Google account.
    // This is deliberately resolved before FLINK credential validation so the
    // browser cannot self-assert an email in the request body.
    let googleEmail = '';
    if (normalizedClientType === 'WEB' || normalizedClientType === 'SETUP_WIZARD') {
      googleEmail = IdentityService.getCurrentGoogleEmail(true);
    }
    this._enforceLoginRateLimit(googleEmail);

    let account = MasterRepository.findAccountByUsername(cleanUsername);
    if (!account) {
      if (this._shouldLogRejectedLogin('UNKNOWN|' + googleEmail + '|' + cleanUsername)) {
        MasterRepository.logSecurityEvent({
          Username: cleanUsername,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
          Success: false,
          metadata: {
            reason: 'User not found',
            googleIdentity: googleEmail || ''
          }
        });
      }
      throw invalidAuth();
    }

    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      ) || googleEmail;
    } catch (identityErr) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity mismatch',
          observedGoogleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    let cred = MasterRepository.getCredentials(account.UserID);
    if (!cred) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Credentials row missing' }
      });
      throw invalidAuth();
    }

    const now = Date.now();
    const resetExpiresAtMs = cred.ResetExpiresAt
      ? new Date(cred.ResetExpiresAt).getTime()
      : NaN;
    const mustChangePassword =
      account.MustChangePassword === true ||
      account.MustChangePassword === 'TRUE';
    if (
      mustChangePassword &&
      Number.isFinite(resetExpiresAtMs) &&
      resetExpiresAtMs <= now
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Temporary password expired' }
      });
      throw invalidAuth();
    }

    const lockUntilMs = cred.LockUntil
      ? new Date(cred.LockUntil).getTime()
      : NaN;

    // A timed lock can auto-expire. A LOCKED account without a valid LockUntil
    // is treated as an administrative lock and never auto-unlocks here.
    if (
      Number.isFinite(lockUntilMs) &&
      lockUntilMs <= now &&
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
    ) {
      MasterRepository.updateAccount(account.UserID, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE
      });
      MasterRepository.updateCredentials(account.UserID, {
        FailedLoginCount: 0,
        LastFailedAt: '',
        LockUntil: ''
      });
      account.Status = CONSTANTS.ACCOUNT_STATUS.ACTIVE;
      cred.FailedLoginCount = 0;
      cred.LastFailedAt = '';
      cred.LockUntil = '';
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (Number.isFinite(lockUntilMs) && lockUntilMs > now)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Attempt while account locked',
          lockUntil: cred.LockUntil || ''
        }
      });
      throw invalidAuth();
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Inactive account',
          accountStatus: account.Status
        }
      });
      throw invalidAuth();
    }

    // Graduated retry throttle after failed password attempts. No sleep is used;
    // Apps Script execution time is preserved and the caller must retry later.
    const failedCount = parseInt(cred.FailedLoginCount, 10) || 0;
    const retrySchedule = Array.isArray(CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS)
      ? CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS
      : [0, 2, 5, 15, 30];
    const delaySeconds = retrySchedule[
      Math.min(failedCount, retrySchedule.length - 1)
    ] || 0;
    const lastFailedMs = cred.LastFailedAt
      ? new Date(cred.LastFailedAt).getTime()
      : NaN;

    if (
      failedCount > 0 &&
      delaySeconds > 0 &&
      Number.isFinite(lastFailedMs) &&
      now < lastFailedMs + delaySeconds * 1000
    ) {
      if (this._shouldLogRejectedLogin('THROTTLED|' + account.UserID)) {
        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_THROTTLED,
          Success: false,
          metadata: {
            failedAttempts: failedCount,
            delaySeconds,
            retryAfterMs: Math.max(
              0,
              lastFailedMs + delaySeconds * 1000 - now
            )
          }
        });
      }
      throw invalidAuth();
    }

    const isValid = SecurityService.verifyPassword(
      password,
      cred.PasswordHash
    );

    if (!isValid) {
      return this._withLoginStateLock(() => {
        if (MasterRepository._invalidateTable) {
          MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.CREDENTIALS);
          MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.ACCOUNTS);
        }
        const latestCred = MasterRepository.getCredentials(account.UserID);
        const latestAccount = MasterRepository.findAccountById(account.UserID);
        if (!latestCred || !latestAccount) throw invalidAuth();

        // If credentials changed after the expensive password check, do not
        // mutate counters based on stale authentication state.
        if (String(latestCred.PasswordHash) !== String(cred.PasswordHash)) {
          throw invalidAuth();
        }

        const latestLockUntilMs = latestCred.LockUntil
          ? new Date(latestCred.LockUntil).getTime()
          : NaN;
        if (
          latestAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
          (Number.isFinite(latestLockUntilMs) && latestLockUntilMs > Date.now())
        ) {
          throw invalidAuth();
        }

        const latestFailedCount =
          parseInt(latestCred.FailedLoginCount, 10) || 0;
        const newFailedCount = latestFailedCount + 1;
        const failedAt = new Date().toISOString();
        const updates = {
          FailedLoginCount: newFailedCount,
          LastFailedAt: failedAt
        };

        if (newFailedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
          const lockUntil = new Date(
            Date.now() +
            CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
          ).toISOString();
          updates.LockUntil = lockUntil;
          MasterRepository.updateAccount(account.UserID, {
            Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
          });

          MasterRepository.logSecurityEvent({
            UserID: account.UserID,
            Username: account.Username,
            EventType: CONSTANTS.AUDIT_EVENTS.ACCOUNT_LOCK,
            Success: false,
            metadata: {
              failedAttempts: newFailedCount,
              lockUntil
            }
          });
        }

        MasterRepository.updateCredentials(account.UserID, updates);
        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
          Success: false,
          metadata: {
            reason: 'Invalid password',
            failedAttempts: newFailedCount
          }
        });

        throw invalidAuth();
      });
    }

    // Re-read the authentication state atomically. MFA-enabled accounts are
    // not fully authenticated until the second factor succeeds, so failure
    // counters must not be cleared at the password-only stage.
    this._withLoginStateLock(() => {
      if (MasterRepository._invalidateTable) {
        MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.CREDENTIALS);
        MasterRepository._invalidateTable(CONSTANTS.MASTER_TABS.ACCOUNTS);
      }
      const latestCred = MasterRepository.getCredentials(account.UserID);
      const latestAccount = MasterRepository.findAccountById(account.UserID);
      if (
        !latestCred ||
        !latestAccount ||
        latestAccount.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE ||
        String(latestCred.PasswordHash) !== String(cred.PasswordHash)
      ) {
        throw invalidAuth();
      }

      cred = latestCred;
      account = latestAccount;

      if (
        typeof SecurityService.needsPasswordHashUpgrade === 'function' &&
        SecurityService.needsPasswordHashUpgrade(cred.PasswordHash)
      ) {
        const beforeIterations = SecurityService.getStoredPasswordIterations(cred.PasswordHash);
        const targetIterations = SecurityService.getConfiguredPasswordIterations();
        const upgradedHash = SecurityService.hashPassword(password, targetIterations);
        MasterRepository.updateCredentials(account.UserID, {
          PasswordHash: upgradedHash
        });
        cred = Object.assign({}, cred, {
          PasswordHash: upgradedHash
        });
        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: 'PASSWORD_HASH_UPGRADED',
          Success: true,
          metadata: {
            fromIterations: beforeIterations,
            toIterations: targetIterations
          }
        });
      }
    });

    if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
      const timestamp = Date.now();
      const sig = SecurityService
        .hashToken(
          `${account.UserID}|${timestamp}|${SecurityService.getPepper()}`
        )
        .substring(0, 16);
      const mfaChallengeToken =
        `MFA_${account.UserID}_${timestamp}_${sig}`;
      this._storeMfaChallenge(
        account.UserID,
        mfaChallengeToken,
        timestamp + 5 * 60 * 1000,
        googleEmail
      );

      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: 'MFA_CHALLENGE_ISSUED',
        Success: true,
        metadata: {
          clientType: normalizedClientType,
          googleIdentity: googleEmail || ''
        }
      });

      return {
        mfaRequired: true,
        mfaChallengeToken,
        userId: account.UserID,
        clientType: normalizedClientType
      };
    }

    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: false,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );

    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId:
          account.PrimaryWorkspaceID ||
          assignedWorkspaces[0] ||
          '',
        assignedWorkspaces,
        mustChangePassword:
          account.MustChangePassword === true ||
          account.MustChangePassword === 'TRUE'
      }
    };
  },

  /**
   * Verifies RFC 6238 TOTP code during two-factor login challenge
   */
  verifyMfa(mfaChallengeToken, code, clientType = 'WEB') {
    if (!mfaChallengeToken || !code) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token and 6-digit code are required.', 401);
    }

    const parts = mfaChallengeToken.split('_');
    if (parts.length !== 4 || parts[0] !== 'MFA') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid MFA challenge token.', 401);
    }

    const [, userId, timestampStr, sig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Date.now();

    // 5-minute expiration
    if (isNaN(timestamp) || now - timestamp > 5 * 60 * 1000 || now < timestamp - 60 * 1000) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token has expired. Please log in again.', 401);
    }

    const expectedSig = SecurityService.hashToken(`${userId}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
    if (!SecurityService.constantTimeEquals(sig, expectedSig)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token signature invalid.', 401);
    }

    const storedChallenge = this._getMfaChallenge(userId);
    const suppliedChallengeHash = SecurityService.hashToken(mfaChallengeToken);
    if (
      !storedChallenge ||
      !storedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(storedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(storedChallenge.expiresAtMs || 0) < now
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const mfaLock = LockService.getScriptLock();
    mfaLock.waitLock(10000);
    try {
    // Re-check the one-time challenge after entering the critical section.
    // Another concurrent request may have consumed it after our pre-lock check.
    const lockedChallenge = this._getMfaChallenge(userId);
    if (
      !lockedChallenge ||
      !lockedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(lockedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(lockedChallenge.expiresAtMs || 0) < Date.now()
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const account = MasterRepository.findAccountById(userId);
    const cred = MasterRepository.getCredentials(userId);
    if (!account || !cred || !cred.TotpSecret) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User credentials or MFA configuration not found.', 401);
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    if (
      normalizedClientType !== 'WEB' &&
      normalizedClientType !== 'SETUP_WIZARD'
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Invalid authentication challenge. Please log in again.',
        401
      );
    }
    let googleEmail = '';
    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      const challengeEmail = IdentityService.normalizeEmail(
        lockedChallenge.googleEmail || ''
      );
      if (
        (normalizedClientType === 'WEB' ||
          normalizedClientType === 'SETUP_WIZARD') &&
        (!challengeEmail || challengeEmail !== googleEmail)
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'MFA challenge identity mismatch.',
          401
        );
      }
    } catch (identityErr) {
      this._deleteMfaChallenge(userId);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity changed during MFA'
        }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Invalid authentication challenge. Please log in again.',
        401
      );
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (cred.LockUntil && new Date(cred.LockUntil).getTime() > now)
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', 403);
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.ACCOUNT_PASSIVE,
        'This account is inactive or has been deactivated.',
        403
      );
    }

    const verification = SecurityService.verifyTotpWithStep(
      cred.TotpSecret,
      code,
      1,
      Date.now(),
      30,
      account.UserID
    );
    if (!verification.valid) {
      const failedCount = (parseInt(cred.FailedLoginCount, 10) || 0) + 1;
      const credUpdates = {
        FailedLoginCount: failedCount,
        LastFailedAt: new Date(now).toISOString()
      };

      if (failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now + CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        credUpdates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });
      }

      MasterRepository.updateCredentials(account.UserID, credUpdates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Invalid MFA TOTP code', failedAttempts: failedCount }
      });
      throw new AppError(
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? ERROR_CODES.ACCOUNT_LOCKED : ERROR_CODES.AUTH_REQUIRED,
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS
          ? 'Account locked after repeated invalid two-factor codes.'
          : 'Invalid two-factor authentication code.',
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? 403 : 401
      );
    }

    // RFC 6238 §5.2 Replay Protection: reject previously validated timestep
    const currentStep = verification.timeStep;
    const lastStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (!isNaN(lastStep) && currentStep <= lastStep) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Replayed MFA TOTP code detected', step: currentStep, lastStep }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Two-factor authentication code has already been used. Please wait for the next 30-second token.',
        401
      );
    }

    // Reset failure counter on success & advance replay protection step
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: '',
      LastSuccessfulTotpStep: currentStep
    });

    // Consume the server-side challenge before minting a session. A later TOTP
    // cannot reuse the same 5-minute challenge to create another session.
    this._deleteMfaChallenge(userId);

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.MFA_VERIFIED,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        step: currentStep,
        googleIdentity: googleEmail || ''
      }
    });
    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: true,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );
    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId: account.PrimaryWorkspaceID || assignedWorkspaces[0] || '',
        assignedWorkspaces: assignedWorkspaces,
        mustChangePassword: account.MustChangePassword === true || account.MustChangePassword === 'TRUE'
      }
    };
    } finally {
      mfaLock.releaseLock();
    }
  },

  /**
   * Fresh password + TOTP verification for high-risk Super Admin actions.
   * Rotates the session and binds a short-lived step-up token to the new SessionID.
   */
  stepUp(authContext, rawSessionToken, currentPassword, totpCode = '') {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!authContext.session || !authContext.session.SessionID) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
    }

    const cred = MasterRepository.getCredentials(authContext.userId);
    if (!cred || !SecurityService.verifyPassword(currentPassword, cred.PasswordHash)) {
      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user ? authContext.user.Username : '',
        EventType: 'STEP_UP_FAILED',
        Success: false,
        metadata: { reason: 'Invalid current password' }
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin reauthentication failed.', 401);
    }

    const mfaEnabled = cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE';
    if (!mfaEnabled || !cred.TotpSecret) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Super Admin MFA must be enabled before high-risk administrative actions can be performed.',
        401
      );
    }

    const verification = SecurityService.verifyTotpWithStep(
      cred.TotpSecret,
      totpCode,
      1,
      Date.now(),
      30,
      authContext.userId
    );
    const previousStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (
      !verification.valid ||
      (!isNaN(previousStep) && verification.timeStep <= previousStep)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user ? authContext.user.Username : '',
        EventType: 'STEP_UP_FAILED',
        Success: false,
        metadata: { reason: 'Invalid or replayed MFA code' }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin MFA verification failed. Use the next authenticator code if the current code was just used.',
        401
      );
    }

    MasterRepository.updateCredentials(authContext.userId, {
      LastSuccessfulTotpStep: verification.timeStep
    });

    const replacement = SessionService.createSession(
      authContext.userId,
      authContext.session.ClientType || 'WEB',
      authContext.session.ClientLabel || ''
    );
    const stepUpToken = 'STP_' + SecurityService.generateRandomHex(32);
    const stepUpExpiresAtMs =
      Date.now() + (CONSTANTS.LIMITS.STEP_UP_TTL_MINUTES || 5) * 60 * 1000;
    this._storeStepUp(replacement.sessionId, {
      userId: authContext.userId,
      sessionId: replacement.sessionId,
      tokenHash: SecurityService.hashToken(stepUpToken),
      expiresAtMs: stepUpExpiresAtMs
    });

    const auditOk = MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: 'MASTER',
      EntityType: 'USER_SECURITY',
      EntityID: authContext.userId,
      Action: 'STEP_UP_AUTHENTICATED',
      Reason: 'Fresh Super Admin password and MFA verification succeeded'
    });
    if (!auditOk) {
      this._deleteStepUp(replacement.sessionId);
      SessionService.revokeSession(replacement.sessionToken);
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Security audit trail is unavailable. Step-up authentication was not activated.',
        503
      );
    }

    // Invalidate the previous session's privileged grant before revocation.
    // Even if the old session row cannot be updated immediately, it must not
    // retain high-risk authorization after the rotation.
    this._deleteStepUp(authContext.session.SessionID);
    SessionService.revokeSession(rawSessionToken);
    MasterRepository.logSecurityEvent({
      UserID: authContext.userId,
      Username: authContext.user ? authContext.user.Username : '',
      EventType: 'STEP_UP_SUCCESS',
      Success: true,
      metadata: { expiresAtMs: stepUpExpiresAtMs }
    });

    return {
      ok: true,
      sessionToken: replacement.sessionToken,
      expiresAt: replacement.expiresAt,
      stepUpToken,
      stepUpExpiresAt: new Date(stepUpExpiresAtMs).toISOString()
    };
  },

  assertStepUp(authContext, stepUpToken) {
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!authContext.session || !authContext.session.SessionID || !stepUpToken) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin reauthentication is required for this action.',
        401
      );
    }

    const record = this._getStepUp(authContext.session.SessionID);
    if (
      !record ||
      record.userId !== authContext.userId ||
      record.sessionId !== authContext.session.SessionID ||
      Number(record.expiresAtMs || 0) < Date.now() ||
      !record.tokenHash ||
      !SecurityService.constantTimeEquals(
        record.tokenHash,
        SecurityService.hashToken(String(stepUpToken))
      )
    ) {
      this._deleteStepUp(authContext.session.SessionID);
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Fresh Super Admin reauthentication is required for this action.',
        401
      );
    }
    return true;
  },

  /**
   * Enrolls or replaces TOTP MFA only after fresh credential verification.
   * Pending enrollment is bound to the current authenticated session and expires.
   */
  enrollMfa(authContext, currentPassword, currentMfaCode = '') {
    if (!authContext || !authContext.userId || !authContext.session || !authContext.session.SessionID) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
    }
    const cred = MasterRepository.getCredentials(authContext.userId);
    if (!cred || !SecurityService.verifyPassword(currentPassword, cred.PasswordHash)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh password verification is required before changing MFA.', 401);
    }

    const replacing =
      cred.MfaEnabled === true ||
      cred.MfaEnabled === 'TRUE';

    if (replacing) {
      if (!currentMfaCode || !cred.TotpSecret) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'The existing authenticator code is required before replacing MFA.', 401);
      }
      const currentVerification = SecurityService.verifyTotpWithStep(
        cred.TotpSecret,
        currentMfaCode,
        1,
        Date.now(),
        30,
        authContext.userId
      );
      const previousStep = parseInt(cred.LastSuccessfulTotpStep, 10);
      if (
        !currentVerification.valid ||
        (!isNaN(previousStep) && currentVerification.timeStep <= previousStep)
      ) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Existing MFA verification failed.', 401);
      }
      MasterRepository.updateCredentials(authContext.userId, {
        LastSuccessfulTotpStep: currentVerification.timeStep
      });
    }

    const rawSecret = SecurityService.generateTotpSecret();
    const encryptedSecret = KmsSecretService.encryptTotpSecret(authContext.userId, rawSecret);
    const expiresAtMs =
      Date.now() +
      (CONSTANTS.LIMITS.MFA_ENROLLMENT_TTL_MINUTES || 10) * 60 * 1000;

    MasterRepository.updateCredentials(authContext.userId, {
      PendingTotpSecret: encryptedSecret
    });
    this._storeMfaEnrollment(authContext.userId, {
      sessionId: authContext.session.SessionID,
      expiresAtMs,
      replacing
    });

    const username =
      authContext.username ||
      (authContext.user && (authContext.user.Username || authContext.user.username)) ||
      'user';
    const uri = `otpauth://totp/FLINK:${username}?secret=${rawSecret}&issuer=FLINK`;
    return {
      secret: rawSecret,
      qrUri: uri,
      expiresAt: new Date(expiresAtMs).toISOString(),
      replacing,
      message: 'Scan the QR code or enter the secret in your authenticator app, then confirm with a 6-digit code.'
    };
  },

  /**
   * Confirms TOTP MFA enrollment. Enrollment is one-time, session-bound, and short-lived.
   */
  confirmMfa(authContext, code) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      if (!authContext || !authContext.session || !authContext.session.SessionID) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'A current authenticated session is required.', 401);
      }
      const enrollment = this._getMfaEnrollment(authContext.userId);
      if (
        !enrollment ||
        enrollment.sessionId !== authContext.session.SessionID ||
        Number(enrollment.expiresAtMs || 0) < Date.now()
      ) {
        this._deleteMfaEnrollment(authContext.userId);
        MasterRepository.updateCredentials(authContext.userId, { PendingTotpSecret: '' });
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA enrollment is invalid, expired, or belongs to another session.', 401);
      }

      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred || !cred.PendingTotpSecret) {
        this._deleteMfaEnrollment(authContext.userId);
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'No pending MFA enrollment found. Call enrollMfa first.');
      }

      const verification = SecurityService.verifyTotpWithStep(
        cred.PendingTotpSecret,
        code,
        1,
        Date.now(),
        30,
        authContext.userId
      );
      if (!verification.valid) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid verification code. Could not verify authenticator app.');
      }

      MasterRepository.updateCredentials(authContext.userId, {
        TotpSecret: cred.PendingTotpSecret,
        MfaEnabled: true,
        PendingTotpSecret: '',
        LastSuccessfulTotpStep: verification.timeStep
      });
      this._deleteMfaEnrollment(authContext.userId);

      let replacementSession = null;
      if (enrollment.replacing === true) {
        SessionService.revokeAllUserSessions(authContext.userId);
        replacementSession = SessionService.createSession(
          authContext.userId,
          authContext.session.ClientType || 'WEB',
          authContext.session.ClientLabel || ''
        );
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'USER_SECURITY',
        EntityID: authContext.userId,
        Action: CONSTANTS.AUDIT_EVENTS.MFA_ENROLLED,
        Reason: enrollment.replacing === true
          ? 'TOTP multi-factor authentication replaced after fresh reauthentication'
          : 'TOTP multi-factor authentication successfully enabled'
      });

      return {
        ok: true,
        replaced: enrollment.replacing === true,
        sessionToken: replacementSession ? replacementSession.sessionToken : undefined,
        expiresAt: replacementSession ? replacementSession.expiresAt : undefined,
        message: enrollment.replacing === true
          ? 'Two-factor authentication replaced successfully. Other sessions were revoked.'
          : 'Two-factor authentication successfully enabled.'
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Disables MFA for a user (Super Admin only or user password confirmation)
   */
  disableMfa(superAdminContext, targetUserId, adminPassword, adminTotpCode = '') {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const targetAccount = MasterRepository.findAccountById(targetUserId);
    if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
    if (targetAccount.Role === CONSTANTS.ROLES.SUPER_ADMIN) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'MFA cannot be disabled for the root Super Admin through the web application.',
        403
      );
    }

    const adminCred = MasterRepository.getCredentials(superAdminContext.userId);
    if (!adminCred || !SecurityService.verifyPassword(adminPassword, adminCred.PasswordHash)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin password verification is required.', 401);
    }
    if (adminCred.MfaEnabled === true || adminCred.MfaEnabled === 'TRUE') {
      const verification = SecurityService.verifyTotpWithStep(
        adminCred.TotpSecret,
        adminTotpCode,
        1,
        Date.now(),
        30,
        superAdminContext.userId
      );
      const previousStep = parseInt(adminCred.LastSuccessfulTotpStep, 10);
      if (
        !verification.valid ||
        (!isNaN(previousStep) && verification.timeStep <= previousStep)
      ) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Fresh Super Admin MFA verification is required.', 401);
      }
      MasterRepository.updateCredentials(superAdminContext.userId, {
        LastSuccessfulTotpStep: verification.timeStep
      });
    }

    MasterRepository.updateCredentials(targetUserId, {
      TotpSecret: '',
      MfaEnabled: false,
      PendingTotpSecret: '',
      LastSuccessfulTotpStep: ''
    });

    this._deleteMfaChallenge(targetUserId);
    this._deleteMfaEnrollment(targetUserId);
    SessionService.revokeAllUserSessions(targetUserId);

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      EntityType: 'USER_SECURITY',
      EntityID: targetUserId,
      Action: CONSTANTS.AUDIT_EVENTS.MFA_DISABLED,
      Reason: 'Two-factor authentication disabled by Super Admin after fresh reauthentication'
    });

    return { ok: true, message: `MFA disabled for user ${targetAccount.Username}. Active sessions were revoked.` };
  },

  /**
   * Changes authenticated user's password
   */
  changePassword(sessionToken, oldPassword, newPassword) {
    const authContext = SessionService.validateSession(sessionToken);
    Validation.validatePassword(newPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, 'Credentials record not found.');

      const isOldValid = SecurityService.verifyPassword(oldPassword, cred.PasswordHash);
      if (!isOldValid) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Current password is incorrect.');
      }
      if (SecurityService.verifyPassword(newPassword, cred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'New password must be different from the current password.',
          400
        );
      }

      const newHash = SecurityService.hashPassword(newPassword);
      MasterRepository.updateCredentials(authContext.userId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(cred.PasswordVersion, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        ResetIssuedAt: '',
        ResetExpiresAt: ''
      });

      MasterRepository.updateAccount(authContext.userId, {
        MustChangePassword: false,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: authContext.userId
      });

      // Invalidate all active sessions and any outstanding MFA login challenge.
      SessionService.revokeAllUserSessions(authContext.userId);
      this._deleteMfaChallenge(authContext.userId);
      this._deleteMfaEnrollment(authContext.userId);
      const replacementClientType =
        authContext.session && authContext.session.ClientType
          ? authContext.session.ClientType
          : 'WEB';
      const newSession = SessionService.createSession(
        authContext.userId,
        replacementClientType
      );

      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.PASSWORD_CHANGED,
        Success: true
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        sessionToken: newSession.sessionToken,
        expiresAt: newSession.expiresAt
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin resets a user's password
   */
  resetPasswordByAdmin(superAdminContext, targetUserId, temporaryPassword) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.validatePassword(temporaryPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, 'Target account not found.');
      if (
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.ARCHIVED ||
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.DELETED
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Archived or deleted accounts cannot receive a password reset.',
          409
        );
      }

      const targetCred = MasterRepository.getCredentials(targetUserId);
      if (!targetCred) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Target credentials record not found.');
      }
      if (SecurityService.verifyPassword(temporaryPassword, targetCred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Temporary password must be different from the user\'s current password.',
          400
        );
      }
      const newHash = SecurityService.hashPassword(temporaryPassword);
      const resetIssuedAt = new Date();
      const resetExpiresAt = new Date(
        resetIssuedAt.getTime() +
        (CONSTANTS.LIMITS.RESET_PASSWORD_TTL_MINUTES || 60) * 60 * 1000
      );
      const nextStatus =
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
          ? CONSTANTS.ACCOUNT_STATUS.ACTIVE
          : targetAccount.Status;

      MasterRepository.updateCredentials(targetUserId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(targetCred ? targetCred.PasswordVersion : 0, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        FailedLoginCount: 0,
        LockUntil: '',
        ResetIssuedAt: resetIssuedAt.toISOString(),
        ResetExpiresAt: resetExpiresAt.toISOString()
      });

      MasterRepository.updateAccount(targetUserId, {
        MustChangePassword: true,
        Status: nextStatus,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Password reset never serves as a PASSIVE-account activation path.
      // It also invalidates sessions and any outstanding MFA challenge.
      SessionService.revokeAllUserSessions(targetUserId);
      this._deleteMfaChallenge(targetUserId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.PASSWORD_RESET,
        Reason: 'Administrative password reset'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        message: `Password reset successfully for user ${targetAccount.Username}. User will be forced to change password on next login.`
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Logout user and revoke session
   */
  logout(sessionToken) {
    SessionService.revokeSession(sessionToken);
    return { ok: true };
  }
};

/* ===== TrackingPolicyService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Tracking Policy Service
 * Centralizes time-tracking policy and referential-integrity checks.
 */

var TrackingPolicyService = (typeof global !== 'undefined' && global.TrackingPolicyService) || {
  _toBoolean(value, defaultValue = false) {
    if (value === true || value === 1 || value === 'TRUE' || value === 'true' || value === '1') return true;
    if (value === false || value === 0 || value === 'FALSE' || value === 'false' || value === '0') return false;
    return defaultValue;
  },

  _getBooleanSetting(key, defaultValue) {
    const raw = MasterRepository.getGlobalSettingStrict(key, '');
    if (raw === '' || raw === null || raw === undefined) return defaultValue;
    return this._toBoolean(raw, defaultValue);
  },

  getPolicy(workspaceId) {
    const workspaceManual = MasterRepository.getGlobalSettingStrict(`WS_${workspaceId}_ALLOW_MANUAL`, '');
    const globalManual = this._getBooleanSetting('RULE_ALLOW_MANUAL', true);

    return {
      projectRequired: this._getBooleanSetting('RULE_PROJECT_REQUIRED', false),
      taskRequired: this._getBooleanSetting('RULE_TASK_REQUIRED', false),
      descriptionRequired: this._getBooleanSetting('RULE_DESC_REQUIRED', false),
      tagsRequired: this._getBooleanSetting('RULE_TAGS_REQUIRED', false),
      allowManual: workspaceManual === '' ? globalManual : this._toBoolean(workspaceManual, globalManual),
      pastEntryEditDays: Math.max(
        0,
        parseInt(MasterRepository.getGlobalSettingStrict('PAST_ENTRY_EDIT_DAYS', '7'), 10) || 0
      )
    };
  },

  normalizeTagIds(rawTags) {
    if (rawTags === null || rawTags === undefined || rawTags === '') return [];
    const values = Array.isArray(rawTags) ? rawTags : String(rawTags).split(',');
    return [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
  },

  getProjectAccessState(authContext, workspaceId) {
    if (authContext.role !== CONSTANTS.ROLES.USER) {
      return { aclEnabled: false, allowedProjectIds: null };
    }

    const allAssignments = SheetRepository.listAllUserProjectAccess(workspaceId);
    if (allAssignments.length === 0) {
      return { aclEnabled: false, allowedProjectIds: null };
    }

    const allowedProjectIds = new Set(
      allAssignments
        .filter(row =>
          row.UserID === authContext.userId &&
          this._toBoolean(row.CanTrack, false)
        )
        .map(row => row.ProjectID)
    );

    return { aclEnabled: true, allowedProjectIds };
  },

  assertProjectAccess(authContext, workspaceId, projectId) {
    if (!projectId || authContext.role !== CONSTANTS.ROLES.USER) return true;

    const state = this.getProjectAccessState(authContext, workspaceId);
    if (!state.aclEnabled) return true;

    if (!state.allowedProjectIds.has(projectId)) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'You are not authorized to track time against the selected project.',
        403
      );
    }
    return true;
  },

  validateTrackingContext(authContext, workspaceId, payload = {}, options = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const policy = this.getPolicy(workspaceId);
    const isManual = options.manual === true;
    const enforceRequired = options.enforceRequired !== false;

    if (isManual && !policy.allowManual) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'Manual time entry is disabled for this workspace.',
        403
      );
    }

    const projectId = payload.projectId ? String(payload.projectId).trim() : '';
    const taskId = payload.taskId ? String(payload.taskId).trim() : '';
    const description = payload.description
      ? Validation.sanitizeCellValue(String(payload.description).trim())
      : '';
    const tagIds = this.normalizeTagIds(
      payload.tagIds !== undefined ? payload.tagIds : payload.tags
    );

    if (enforceRequired && policy.projectRequired && !projectId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A project is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.taskRequired && !taskId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.descriptionRequired && !description) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A description is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.tagsRequired && tagIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one tag is required by the tracking policy.', 400);
    }

    let project = null;
    if (projectId) {
      project = SheetRepository.getProject(workspaceId, projectId);
      if (!project) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} was not found.`, 404);
      }
      if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected project is not active.', 400);
      }
      this.assertProjectAccess(authContext, workspaceId, projectId);
    }

    let task = null;
    if (taskId) {
      if (!projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task cannot be selected without its project.', 400);
      }
      task = SheetRepository.getTask(workspaceId, taskId);
      if (!task) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Task ${taskId} was not found.`, 404);
      }
      if (task.ProjectID !== projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task does not belong to the selected project.', 400);
      }
      const taskStatus = String(task.Status || '').toUpperCase();
      if (!['OPEN', 'ACTIVE'].includes(taskStatus)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task is not open for time tracking.', 400);
      }
    }

    if (tagIds.length > 0) {
      const tags = SheetRepository.listTags(workspaceId);
      const tagMap = new Map(tags.map(tag => [tag.TagID, tag]));
      for (const tagId of tagIds) {
        const tag = tagMap.get(tagId);
        if (!tag) {
          throw new AppError(ERROR_CODES.NOT_FOUND, `Tag ${tagId} was not found.`, 404);
        }
        if (String(tag.Status || '').toUpperCase() !== 'ACTIVE') {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Tag ${tagId} is not active.`, 400);
        }
      }
    }

    let billable;
    if (payload.billable !== undefined) {
      billable = this._toBoolean(payload.billable, false);
    } else if (project) {
      billable = this._toBoolean(project.BillableDefault, true);
    } else {
      billable = true;
    }

    return {
      policy,
      project,
      task,
      projectId,
      taskId,
      description,
      tagIds,
      tagIdsCsv: tagIds.join(','),
      billable
    };
  },

  assertEntryEditableByAge(workspaceId, entry) {
    const policy = this.getPolicy(workspaceId);
    if (!policy.pastEntryEditDays) return true;

    const entryTime = new Date(entry.EndUTC || entry.StartUTC).getTime();
    if (isNaN(entryTime)) return true;

    const cutoff = Date.now() - policy.pastEntryEditDays * 24 * 3600 * 1000;
    if (entryTime < cutoff) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `This entry is older than the ${policy.pastEntryEditDays}-day edit window.`,
        403
      );
    }
    return true;
  }
};

/* ============================================================ */

/** FLINK Time — Consolidated Drive, repository, workspace routing/lifecycle, and timezone data services. */


/* Legacy screenshot-vault subsystem removed: no unauthenticated Drive RPC surface. */

/* ===== MasterRepository.gs ===== */
/**
 * FLINK Time & Workforce Platform — Master Control Sheet Repository
 * Encapsulates all read/write operations for the Master Control Sheet.
 * Employs batch reads, header indexing, and sanitization defense.
 */

var MasterRepository = (typeof global !== 'undefined' && global.MasterRepository) || {
  spreadsheetId: null,
  _requestCache: {},
  _userCacheMemory: {},

  beginRequest() {
    this._requestCache = {};
    if (typeof TimezoneService !== 'undefined' && TimezoneService._clearCache) {
      TimezoneService._clearCache();
    }
  },

  _userCacheKey(userId) {
    return 'U:' + String(userId || '');
  },

  invalidateUserCache(userId) {
    const key = this._userCacheKey(userId);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().remove(key); } catch (e) {}
    }
    delete this._userCacheMemory[key];
  },

  _getCachedUserBundle(userId) {
    const key = this._userCacheKey(userId);
    let raw = '';
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { raw = CacheService.getScriptCache().get(key) || ''; } catch (e) {}
    } else {
      raw = this._userCacheMemory[key] || '';
    }
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) {
      this.invalidateUserCache(userId);
      return null;
    }
  },

  _putCachedUserBundle(userId, bundle) {
    const key = this._userCacheKey(userId);
    const raw = JSON.stringify(bundle);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try { CacheService.getScriptCache().put(key, raw, 60); } catch (e) {}
    } else {
      this._userCacheMemory[key] = raw;
    }
  },

  _invalidateTable(tabName) {
    delete this._requestCache[tabName];
  },

  /**
   * Resolves Master Spreadsheet. If spreadsheetId is not set, tries ScriptProperties or getActiveSpreadsheet()
   */
  getMasterSpreadsheet() {
    if (this.spreadsheetId && typeof SpreadsheetApp !== 'undefined') {
      return SpreadsheetApp.openById(this.spreadsheetId);
    }
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const id = PropertiesService.getScriptProperties().getProperty('MASTER_SPREADSHEET_ID');
      if (id && typeof SpreadsheetApp !== 'undefined') {
        this.spreadsheetId = id;
        return SpreadsheetApp.openById(id);
      }
    }

    const installerSpreadsheetId = installerBootstrapValue_(
      INSTALLER_BOOTSTRAP && INSTALLER_BOOTSTRAP.masterSpreadsheetId
    );
    if (installerSpreadsheetId && typeof SpreadsheetApp !== 'undefined') {
      this.spreadsheetId = installerSpreadsheetId;
      return SpreadsheetApp.openById(installerSpreadsheetId);
    }

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.getActiveSpreadsheet) {
      const active = SpreadsheetApp.getActiveSpreadsheet();
      if (active) return active;
    }
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Master Spreadsheet could not be resolved.');
  },

  /**
   * Helper to retrieve a tab and all rows as array of objects
   */
  getTableData(tabName) {
    if (this._requestCache[tabName]) {
      return this._requestCache[tabName];
    }

    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const range = sheet.getDataRange();
    const values = range.getValues();
    if (values.length <= 1) {
      const empty = { headers: values[0] || [], rows: [], sheet };
      this._requestCache[tabName] = empty;
      return empty;
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const rowObj = { _rowIndex: r + 1 };
      for (let col = 0; col < headers.length; col++) {
        rowObj[headers[col]] = values[r][col];
      }
      rows.push(rowObj);
    }

    const result = { headers, rows, sheet };
    this._requestCache[tabName] = result;
    return result;
  },

  /**
   * Finds one row by key without loading the entire tab.
   * Growing request-time tables must prefer this path over getTableData().
   */
  findRowByKey(tabName, columnName, value, options = {}) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }
    const columnIndex = schemaHeaders.indexOf(columnName);
    if (columnIndex < 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Column '${columnName}' is not defined for '${tabName}'.`);
    }

    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return null;

    const cell = sheet
      .getRange(2, columnIndex + 1, lastRow - 1, 1)
      .createTextFinder(String(value))
      .matchEntireCell(true)
      .matchCase(options.matchCase !== false)
      .findNext();
    if (!cell) return null;

    const rowIndex = cell.getRow();
    const values = sheet.getRange(rowIndex, 1, 1, schemaHeaders.length).getValues()[0];
    const row = { _rowIndex: rowIndex };
    for (let i = 0; i < schemaHeaders.length; i++) row[schemaHeaders[i]] = values[i];
    return row;
  },

  /**
   * Finds all rows matching one key column without loading the whole tab.
   */
  findRowsByKey(tabName, columnName, value, options = {}) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }
    const columnIndex = schemaHeaders.indexOf(columnName);
    if (columnIndex < 0) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Column '${columnName}' is not defined for '${tabName}'.`);
    }
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return [];

    const cells = sheet
      .getRange(2, columnIndex + 1, lastRow - 1, 1)
      .createTextFinder(String(value))
      .matchEntireCell(true)
      .matchCase(options.matchCase !== false)
      .findAll();

    return cells.map(cell => {
      const rowIndex = cell.getRow();
      const values = sheet.getRange(rowIndex, 1, 1, schemaHeaders.length).getValues()[0];
      const row = { _rowIndex: rowIndex };
      for (let i = 0; i < schemaHeaders.length; i++) row[schemaHeaders[i]] = values[i];
      return row;
    });
  },

  getUserAuthBundle(userId) {
    const cached = this._getCachedUserBundle(userId);
    if (cached) return cached;

    const account = this.findAccountById(userId);
    const accesses = account ? this.getWorkspaceAccessForUser(userId) : [];
    const bundle = { account, accesses };
    this._putCachedUserBundle(userId, bundle);
    return bundle;
  },

  /**
   * Appends an entity row to a master tab
   */
  appendRow(tabName, entity) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }

    const rowData = schemaHeaders.map(col => {
      const val = entity[col] !== undefined ? entity[col] : '';
      return Validation.sanitizeCellValue(val);
    });

    sheet.appendRow(rowData);
    this._invalidateTable(tabName);
    return entity;
  },

  /**
   * Appends multiple entity rows in a single batch to a master tab
   */
  appendRows(tabName, entities) {
    if (!entities || !entities.length) return [];
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }

    const schemaHeaders = MASTER_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for master tab '${tabName}'.`);
    }

    const rowsData = entities.map(entity => {
      return schemaHeaders.map(col => {
        const val = entity[col] !== undefined ? entity[col] : '';
        return Validation.sanitizeCellValue(val);
      });
    });

    if (sheet.getRange) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rowsData.length, schemaHeaders.length).setValues(rowsData);
    } else {
      for (const row of rowsData) {
        sheet.appendRow(row);
      }
    }
    this._invalidateTable(tabName);
    return entities;
  },

  deleteRow(tabName, rowIndex) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    sheet.deleteRow(rowIndex);
    this._invalidateTable(tabName);
  },

  deleteRows(tabName, startRow, howMany) {
    const count = Number(howMany || 0);
    if (!Number.isInteger(startRow) || startRow < 2 || !Number.isInteger(count) || count < 1) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid batch row deletion request.', 400);
    }
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Master tab '${tabName}' does not exist.`);
    }
    sheet.deleteRows(startRow, count);
    this._invalidateTable(tabName);
  },

  /**
   * Updates specific columns for a row index in a master tab
   */
  updateRow(tabName, rowIndex, updates) {
    const ss = this.getMasterSpreadsheet();
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    const changes = Object.entries(updates)
      .map(([colName, val]) => ({
        colIdx: headers.indexOf(colName),
        value: Validation.sanitizeCellValue(val)
      }))
      .filter(change => change.colIdx >= 0)
      .sort((a, b) => a.colIdx - b.colIdx);

    // Batch adjacent changed columns into the smallest possible setValues calls.
    // This reduces Sheets service round-trips without overwriting unrelated columns.
    for (let i = 0; i < changes.length;) {
      const group = [changes[i]];
      let j = i + 1;
      while (
        j < changes.length &&
        changes[j].colIdx === group[group.length - 1].colIdx + 1
      ) {
        group.push(changes[j]);
        j++;
      }

      sheet
        .getRange(rowIndex, group[0].colIdx + 1, 1, group.length)
        .setValues([group.map(change => change.value)]);
      i = j;
    }

    this._invalidateTable(tabName);
  },

  /* ------------------- ACCOUNTS & CREDENTIALS ------------------- */

  findAccountByUsername(username) {
    const cleanUsername = String(username).trim().toLowerCase();
    return this.findRowByKey(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      'Username',
      cleanUsername,
      { matchCase: false }
    );
  },

  findAccountById(userId) {
    return this.findRowByKey(CONSTANTS.MASTER_TABS.ACCOUNTS, 'UserID', userId);
  },

  findAccountByEmail(email) {
    const cleanEmail = String(email || '').trim().toLowerCase();
    return this.findRowByKey(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      'Email',
      cleanEmail,
      { matchCase: false }
    );
  },

  createAccount(accountData, credentialData) {
    if (!accountData || !accountData.UserID || !credentialData || credentialData.UserID !== accountData.UserID) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Account and credential records with the same UserID are required.',
        400
      );
    }

    let accountCreated = false;
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.ACCOUNTS, accountData);
      accountCreated = true;
      this.appendRow(CONSTANTS.MASTER_TABS.CREDENTIALS, credentialData);
      return accountData;
    } catch (err) {
      if (accountCreated) {
        try {
          const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
          const created = rows.find(row => row.UserID === accountData.UserID);
          if (created) this.deleteRow(CONSTANTS.MASTER_TABS.ACCOUNTS, created._rowIndex);
        } catch (rollbackErr) {
          console.error(
            `Account creation rollback failed for ${accountData.UserID}: ${rollbackErr.message}`
          );
        }
      }
      throw err;
    }
  },

  /**
   * Hard rollback helper for a user that failed during initial provisioning.
   * This is intentionally for creation rollback only, not normal user deletion.
   */
  rollbackUserCreation(userId) {
    const deleteMatches = (tabName, predicate) => {
      const { rows } = this.getTableData(tabName);
      rows
        .filter(predicate)
        .sort((a, b) => b._rowIndex - a._rowIndex)
        .forEach(row => this.deleteRow(tabName, row._rowIndex));
    };

    deleteMatches(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.CREDENTIALS,
      row => row.UserID === userId
    );
    deleteMatches(
      CONSTANTS.MASTER_TABS.ACCOUNTS,
      row => row.UserID === userId
    );
  },

  updateAccount(userId, updates) {
    const acc = this.findAccountById(userId);
    if (!acc) throw new AppError(ERROR_CODES.NOT_FOUND, `Account ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, acc._rowIndex, updates);
    this.invalidateUserCache(userId);
    return { ...acc, ...updates };
  },

  getCredentials(userId) {
    return this.findRowByKey(CONSTANTS.MASTER_TABS.CREDENTIALS, 'UserID', userId);
  },

  updateCredentials(userId, updates) {
    const cred = this.getCredentials(userId);
    if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, `Credentials for ${userId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.CREDENTIALS, cred._rowIndex, updates);
    return { ...cred, ...updates };
  },

  /* ------------------- WORKSPACES & ACCESS ------------------- */

  listWorkspaces() {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    return rows;
  },

  getWorkspace(workspaceId) {
    if (!workspaceId) return null;
    const cacheKey = 'WS:' + workspaceId;
    if (this._requestCache && this._requestCache[cacheKey] !== undefined) {
      return this._requestCache[cacheKey];
    }
    const ws = this.findRowByKey(CONSTANTS.MASTER_TABS.WORKSPACES, 'WorkspaceID', workspaceId);
    if (this._requestCache) {
      this._requestCache[cacheKey] = ws;
    }
    return ws;
  },

  createWorkspace(workspaceData) {
    this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACES, workspaceData);
    if (this._requestCache && workspaceData && workspaceData.WorkspaceID) {
      this._requestCache['WS:' + workspaceData.WorkspaceID] = workspaceData;
    }
    return workspaceData;
  },

  updateWorkspace(workspaceId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = rows.find(r => r.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, updates);

    if (this._requestCache) {
      delete this._requestCache['WS:' + workspaceId];
    }

    if (typeof TimezoneService !== 'undefined' && TimezoneService._clearCache) {
      TimezoneService._clearCache(workspaceId);
    }

    // Workspace status and physical-pointer changes must invalidate the router's
    // warm execution cache immediately; otherwise a previously cached ACTIVE
    // spreadsheet could remain reachable after MAINTENANCE/ARCHIVE transitions.
    if (
      updates &&
      (Object.prototype.hasOwnProperty.call(updates, 'Status') ||
       Object.prototype.hasOwnProperty.call(updates, 'SpreadsheetID')) &&
      typeof WorkspaceRouter !== 'undefined' &&
      WorkspaceRouter.clearCache
    ) {
      WorkspaceRouter.clearCache();
    }

    return { ...ws, ...updates };
  },

  getWorkspaceAccessForUser(userId) {
    return this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      userId
    ).filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1);
  },

  getWorkspaceAccessForWorkspace(workspaceId) {
    return this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'WorkspaceID',
      workspaceId
    ).filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1);
  },

  countActiveAdminWorkspaces(userId) {
    const accesses = this.getWorkspaceAccessForUser(userId);
    return accesses.filter(a => a.Role === CONSTANTS.ROLES.ADMIN).length;
  },

  assignWorkspaceAccess(accessData) {
    const rows = this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      accessData.UserID
    );
    const existing = rows.find(r => r.WorkspaceID === accessData.WorkspaceID);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Role: accessData.Role,
        Active: true,
        AssignedAt: accessData.AssignedAt || new Date().toISOString(),
        AssignedBy: accessData.AssignedBy || ''
      });
      this.invalidateUserCache(accessData.UserID);
      return { ...existing, ...accessData, Active: true };
    }
    const created = this.appendRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, accessData);
    this.invalidateUserCache(accessData.UserID);
    return created;
  },

  syncWorkspaceAccessRole(userId, role) {
    this.getWorkspaceAccessForUser(userId)
      .forEach(r => this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, r._rowIndex, { Role: role }));
    this.invalidateUserCache(userId);
  },

  removeWorkspaceAccess(userId, workspaceId) {
    const rows = this.findRowsByKey(
      CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS,
      'UserID',
      userId
    );
    const existing = rows.find(r => r.WorkspaceID === workspaceId);
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS, existing._rowIndex, {
        Active: false
      });
    }

    // PrimaryWorkspaceID is only a UI/default-selection hint. Keep it synchronized
    // so revoked workspaces are not shown as the user's default workspace.
    const account = this.findAccountById(userId);
    if (account && account.PrimaryWorkspaceID === workspaceId) {
      const replacement = rows.find(r =>
        r.UserID === userId &&
        r.WorkspaceID !== workspaceId &&
        (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
      );
      this.updateAccount(userId, {
        PrimaryWorkspaceID: replacement ? replacement.WorkspaceID : '',
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: 'SYSTEM'
      });
    }
    this.invalidateUserCache(userId);
  },

  /* ------------------- SESSIONS ------------------- */

  getSessionEpoch(userId) {
    const account = this.findAccountById(userId);
    if (!account) return null;
    const epoch = Number(account.SessionEpoch);
    return Number.isInteger(epoch) && epoch > 0 ? epoch : 1;
  },

  bumpSessionEpoch(userId) {
    const lock =
      typeof LockService !== 'undefined' && LockService.getScriptLock
        ? LockService.getScriptLock()
        : null;
    const alreadyHeld = !!(lock && typeof lock.hasLock === 'function' && lock.hasLock());
    let acquiredHere = false;

    if (lock && !alreadyHeld) {
      lock.waitLock(10000);
      acquiredHere = true;
    }

    try {
      const account = this.findAccountById(userId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `Account ${userId} not found.`);
      const current = Number(account.SessionEpoch);
      const nextEpoch = (Number.isInteger(current) && current > 0 ? current : 1) + 1;
      this.updateRow(CONSTANTS.MASTER_TABS.ACCOUNTS, account._rowIndex, {
        SessionEpoch: nextEpoch,
        UpdatedAt: new Date().toISOString()
      });
      this.invalidateUserCache(userId);
      return nextEpoch;
    } finally {
      if (acquiredHere) lock.releaseLock();
    }
  },

  createSession(sessionData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.SESSIONS, sessionData);
  },

  findSessionByTokenHashFast(tokenHash) {
    const row = this.findRowByKey(CONSTANTS.MASTER_TABS.SESSIONS, 'TokenHash', tokenHash);
    if (!row) return null;
    const revoked = row.Revoked === true || row.Revoked === 'TRUE' || row.Revoked === 1;
    return revoked ? null : row;
  },

  findSessionByTokenHash(tokenHash) {
    return this.findSessionByTokenHashFast(tokenHash);
  },

  updateSession(sessionId, updates) {
    const s = this.findRowByKey(CONSTANTS.MASTER_TABS.SESSIONS, 'SessionID', sessionId);
    if (s) {
      this.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, updates);
      if (
        s.TokenHash &&
        typeof SessionService !== 'undefined' &&
        SessionService._deleteCachedSession
      ) {
        SessionService._deleteCachedSession(s.TokenHash);
      }
    }
  },

  revokeAllUserSessions(userId) {
    // Constant-cost revocation: rotate the account epoch. Existing session rows
    // are made invalid immediately and are physically marked/purged by housekeeping.
    return this.bumpSessionEpoch(userId);
  },

  /* ------------------- REQUESTS ------------------- */

  createRequest(requestData) {
    return this.appendRow(CONSTANTS.MASTER_TABS.REQUESTS, requestData);
  },

  getRequest(requestId) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.find(r => r.RequestID === requestId) || null;
  },

  listRequests(statusFilter = null, workspaceId = null) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    return rows.filter(r => {
      if (statusFilter && r.Status !== statusFilter) return false;
      if (workspaceId && r.WorkspaceID !== workspaceId) return false;
      return true;
    });
  },

  updateRequest(requestId, updates) {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.REQUESTS);
    const req = rows.find(r => r.RequestID === requestId);
    if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
    this.updateRow(CONSTANTS.MASTER_TABS.REQUESTS, req._rowIndex, updates);
    return { ...req, ...updates };
  },

  /* ------------------- AUDIT & SECURITY EVENTS ------------------- */

  logSecurityEvent(eventData) {
    try {
      this.appendRow(CONSTANTS.MASTER_TABS.SECURITY_EVENTS, {
        EventID: Validation.generateId('SEC'),
        Timestamp: new Date().toISOString(),
        UserID: eventData.UserID || '',
        Username: eventData.Username || '',
        EventType: eventData.EventType,
        Success: eventData.Success ? true : false,
        MetadataJSON: eventData.MetadataJSON || (eventData.metadata ? JSON.stringify(eventData.metadata) : '')
      });
    } catch (e) {
      // Do not crash primary execution on audit write failure
      console.error('Failed to write security event: ' + e.message);
    }
  },

  getLastAuditHash(tabName = CONSTANTS.MASTER_TABS.GLOBAL_AUDIT) {
    try {
      const ss = this.getMasterSpreadsheet();
      const sheet = ss && ss.getSheetByName ? ss.getSheetByName(tabName) : null;
      if (sheet && typeof sheet.getLastRow === 'function' && typeof sheet.getRange === 'function') {
        const lastRow = sheet.getLastRow();
        if (lastRow <= 1) return '0000000000000000000000000000000000000000000000000000000000000000';
        const lastCol = typeof sheet.getLastColumn === 'function' ? sheet.getLastColumn() : (MASTER_SCHEMA[tabName] ? MASTER_SCHEMA[tabName].length : 15);
        const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
        const colIdx = headers.indexOf('RecordHash');
        if (colIdx >= 0) {
          const val = sheet.getRange(lastRow, colIdx + 1, 1, 1).getValue();
          if (val) return String(val).trim();
        }
      }
    } catch (e) {
      // Fallback to table data if sheet range methods are unmocked
    }
    const { rows } = this.getTableData(tabName);
    if (rows && rows.length > 0 && rows[rows.length - 1].RecordHash) {
      return rows[rows.length - 1].RecordHash;
    }
    return '0000000000000000000000000000000000000000000000000000000000000000';
  },

  logGlobalAudit(auditData) {
    let auditLock = null;
    let acquiredAuditLock = false;
    try {
      if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
        auditLock = LockService.getScriptLock();
        if (
          auditLock &&
          typeof auditLock.hasLock === 'function' &&
          !auditLock.hasLock()
        ) {
          auditLock.waitLock(10000);
          acquiredAuditLock = true;
        }
      }

      // Refresh the chain head after acquiring the lock so concurrent audit
      // writers cannot legitimately select the same predecessor.
      this._invalidateTable(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);

      const auditId = Validation.generateId('AUD');
      const timestamp = new Date().toISOString();
      const beforeStr = typeof auditData.BeforeJSON === 'object'
        ? JSON.stringify(auditData.BeforeJSON)
        : (auditData.BeforeJSON || '');
      const afterStr = typeof auditData.AfterJSON === 'object'
        ? JSON.stringify(auditData.AfterJSON)
        : (auditData.AfterJSON || '');

      const prevHash = this.getLastAuditHash(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT);

      const record = Validation.sanitizeRow({
        AuditID: auditId,
        TimestampUTC: timestamp,
        ActorUserID: auditData.ActorUserID || '',
        ActorRole: auditData.ActorRole || '',
        WorkspaceID: auditData.WorkspaceID || '',
        EntityType: auditData.EntityType,
        EntityID: auditData.EntityID,
        Action: auditData.Action,
        BeforeJSON: beforeStr,
        AfterJSON: afterStr,
        Reason: auditData.Reason || '',
        CorrelationID: auditData.CorrelationID || '',
        ClientType: auditData.ClientType || 'WEB',
        PreviousHash: prevHash,
        RecordHash: ''
      });
      record.RecordHash = SecurityService.computeAuditRecordHashV2(
        prevHash,
        record,
        record.WorkspaceID
      );

      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT, record);
      return true;
    } catch (e) {
      console.error('Failed to write global audit: ' + e.message);
      return false;
    } finally {
      if (acquiredAuditLock && auditLock) {
        try { auditLock.releaseLock(); } catch (releaseErr) {}
      }
    }
  },

  /* ------------------- GLOBAL SETTINGS ------------------- */

  getAllGlobalSettings() {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const settings = {};
      for (const r of rows) {
        if (r.SettingKey) {
          settings[r.SettingKey] = r.SettingValue;
        }
      }
      return settings;
    } catch (e) {
      return {};
    }
  },

  getAllGlobalSettingsStrict() {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const settings = {};
    for (const r of rows) {
      if (r.SettingKey) settings[r.SettingKey] = r.SettingValue;
    }
    return settings;
  },

  getGlobalSettingStrict(key, defaultValue = '') {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const row = rows.find(r => r.SettingKey === key);
    return row ? row.SettingValue : defaultValue;
  },

  getGlobalSettingFast(key, defaultValue = '') {
    const row = this.findRowByKey(
      CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS,
      'SettingKey',
      key
    );
    return row ? row.SettingValue : defaultValue;
  },

  getGlobalSetting(key, defaultValue = '') {
    try {
      const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
      const row = rows.find(r => r.SettingKey === key);
      return row ? row.SettingValue : defaultValue;
    } catch (e) {
      return defaultValue;
    }
  },

  setGlobalSetting(key, value, updatedBy = 'SYSTEM', description = '') {
    const { rows } = this.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS);
    const existing = rows.find(r => r.SettingKey === key);
    const now = new Date().toISOString();
    if (existing) {
      this.updateRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, existing._rowIndex, {
        SettingValue: String(value),
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    } else {
      this.appendRow(CONSTANTS.MASTER_TABS.GLOBAL_SETTINGS, {
        SettingKey: key,
        SettingValue: String(value),
        Description: description,
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    }
  },

  /* ------------------- SECURITY & ACCOUNT MANAGEMENT ------------------- */

  unlockAccount(userId) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const user = this.findAccountById(userId);
      if (!user) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${userId} not found.`);

      if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
        this.updateAccount(userId, {
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          UpdatedAt: new Date().toISOString(),
          UpdatedBy: 'SUPER_ADMIN'
        });
      }

      const cred = this.getCredentials(userId);
      if (cred) {
        this.updateCredentials(userId, {
          FailedLoginCount: 0,
          LockUntil: ''
        });
      }

      this.logSecurityEvent({
        UserID: userId,
        Username: user.Username,
        EventType: 'ACCOUNT_UNLOCKED',
        Success: true,
        metadata: { unlockedBy: 'SUPER_ADMIN' }
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Account for ${user.Username} unlocked.` };
    } finally {
      lock.releaseLock();
    }
  },

  listActiveSessions() {
    try {
      const { rows: sessionRows } = this.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const { rows: accountRows } = this.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const userMap = {};
      accountRows.forEach(a => { userMap[a.UserID] = a; });

      const now = Date.now();
      return sessionRows
        .filter(s => {
          if (s.Revoked || new Date(s.ExpiresAt).getTime() <= now) return false;
          const account = userMap[s.UserID];
          if (!account) return false;
          const accountEpoch = Number(account.SessionEpoch) > 0 ? Number(account.SessionEpoch) : 1;
          const sessionEpoch = Number(s.AccountEpoch) > 0 ? Number(s.AccountEpoch) : 1;
          return accountEpoch === sessionEpoch;
        })
        .map(s => {
          const user = userMap[s.UserID] || {};
          return {
            sessionId: s.SessionID,
            userId: s.UserID,
            username: user.Username || 'Unknown',
            displayName: user.DisplayName || 'Unknown',
            role: user.Role || 'USER',
            clientType: s.ClientType || 'WEB',
            createdAt: s.CreatedAt,
            lastSeenAt: s.LastSeenAt,
            expiresAt: s.ExpiresAt
          };
        });
    } catch (e) {
      return [];
    }
  },

  deleteWorkspacePermanent(workspaceId) {
    const { rows: wsRows } = this.getTableData(CONSTANTS.MASTER_TABS.WORKSPACES);
    const ws = wsRows.find(w => w.WorkspaceID === workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);

    // Archive / flag deleted in Master
    this.updateRow(CONSTANTS.MASTER_TABS.WORKSPACES, ws._rowIndex, {
      Status: CONSTANTS.WORKSPACE_STATUS.ARCHIVED,
      ArchivedAt: new Date().toISOString()
    });
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }

    return { ok: true, message: `Workspace ${workspaceId} permanently archived and unlinked.` };
  }
};

/* ===== SheetRepository.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Sheet Repository
 * Handles batch reads, writes, updates, and soft deletions across all 18 tabs
 * of an isolated Workspace Google Sheet.
 */

var SheetRepository = (typeof global !== 'undefined' && global.SheetRepository) || {
  _requestCache: {},

  beginRequest() {
    this._requestCache = {};
  },

  _cacheKey(workspaceId, tabName) {
    return String(workspaceId) + '::' + String(tabName);
  },

  _invalidateTable(workspaceId, tabName) {
    delete this._requestCache[this._cacheKey(workspaceId, tabName)];
  },

  clearTableCache(workspaceId, tabName) {
    this._invalidateTable(workspaceId, tabName);
  },

  /**
   * Helper to retrieve tab data from a specific workspace sheet
   */
  getTableData(workspaceId, tabName) {
    const cacheKey = this._cacheKey(workspaceId, tabName);
    if (this._requestCache[cacheKey]) {
      return this._requestCache[cacheKey];
    }

    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace tab '${tabName}' does not exist.`);
    }

    const values = sheet.getDataRange().getValues();
    if (values.length <= 1) {
      const empty = { headers: values[0] || [], rows: [], sheet };
      this._requestCache[cacheKey] = empty;
      return empty;
    }

    const headers = values[0].map(h => String(h).trim());
    const rows = [];
    for (let r = 1; r < values.length; r++) {
      const obj = { _rowIndex: r + 1 };
      for (let col = 0; col < headers.length; col++) {
        obj[headers[col]] = values[r][col];
      }
      rows.push(obj);
    }

    const result = { headers, rows, sheet };
    this._requestCache[cacheKey] = result;
    return result;
  },

  /**
   * Finds one row in a workspace tab matching a key column without reading the whole tab
   */
  findRowByKey(workspaceId, tabName, columnName, value, options = {}) {
    if (value === undefined || value === null || value === '') return null;
    const cacheKey = this._cacheKey(workspaceId, tabName);
    if (this._requestCache[cacheKey]) {
      const cached = this._requestCache[cacheKey];
      const match = cached.rows.find(r => {
        const cell = r[columnName];
        if (options.matchCase === false) {
          return String(cell || '').toLowerCase() === String(value).toLowerCase();
        }
        return String(cell || '') === String(value);
      });
      return match || null;
    }

    try {
      const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
      const sheet = ss && ss.getSheetByName ? ss.getSheetByName(tabName) : null;
      const schemaHeaders = WORKSPACE_SCHEMA[tabName];
      if (
        sheet &&
        schemaHeaders &&
        typeof sheet.getLastRow === 'function' &&
        typeof sheet.getRange === 'function'
      ) {
        const columnIndex = schemaHeaders.indexOf(columnName);
        if (columnIndex >= 0) {
          const lastRow = sheet.getLastRow();
          if (lastRow < 2) return null;

          const finderRange = sheet.getRange(2, columnIndex + 1, lastRow - 1, 1);
          if (finderRange && typeof finderRange.createTextFinder === 'function') {
            const cell = finderRange
              .createTextFinder(String(value))
              .matchEntireCell(true)
              .matchCase(options.matchCase !== false)
              .findNext();
            if (!cell) return null;

            const rowIndex = cell.getRow();
            const values = sheet.getRange(rowIndex, 1, 1, schemaHeaders.length).getValues()[0];
            const row = { _rowIndex: rowIndex };
            for (let i = 0; i < schemaHeaders.length; i++) row[schemaHeaders[i]] = values[i];
            return row;
          }
        }
      }
    } catch (e) {
      // Fall back to table rows if sheet range methods are unavailable
    }

    const { rows } = this.getTableData(workspaceId, tabName);
    return rows.find(r => {
      const cell = r[columnName];
      if (options.matchCase === false) {
        return String(cell || '').toLowerCase() === String(value).toLowerCase();
      }
      return String(cell || '') === String(value);
    }) || null;
  },

  /**
   * Appends an entity row to a workspace tab
   */
  appendRow(workspaceId, tabName, entity) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Tab '${tabName}' not found in workspace '${workspaceId}'.`, 404);
    }

    const schemaHeaders = WORKSPACE_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for workspace tab '${tabName}'.`);
    }

    const rowData = schemaHeaders.map(col => {
      const val = entity[col] !== undefined ? entity[col] : '';
      return Validation.sanitizeCellValue(val);
    });

    sheet.appendRow(rowData);
    this._invalidateTable(workspaceId, tabName);
    return entity;
  },

  /**
   * Appends multiple entity rows in a single batch to a workspace tab
   */
  appendRows(workspaceId, tabName, entities) {
    if (!entities || !entities.length) return [];
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    if (!sheet) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Tab '${tabName}' not found in workspace '${workspaceId}'.`, 404);
    }

    const schemaHeaders = WORKSPACE_SCHEMA[tabName];
    if (!schemaHeaders) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Schema missing for workspace tab '${tabName}'.`);
    }

    const rowsData = entities.map(entity => {
      return schemaHeaders.map(col => {
        const val = entity[col] !== undefined ? entity[col] : '';
        return Validation.sanitizeCellValue(val);
      });
    });

    if (sheet.getRange) {
      const startRow = sheet.getLastRow() + 1;
      sheet.getRange(startRow, 1, rowsData.length, schemaHeaders.length).setValues(rowsData);
    } else {
      for (const row of rowsData) {
        sheet.appendRow(row);
      }
    }
    this._invalidateTable(workspaceId, tabName);
    return entities;
  },

  /**
   * Updates specific columns for a row index in a workspace tab
   */
  updateRow(workspaceId, tabName, rowIndex, updates) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    const headers = sheet
      .getRange(1, 1, 1, sheet.getLastColumn())
      .getValues()[0]
      .map(h => String(h).trim());

    const changes = Object.entries(updates)
      .map(([colName, val]) => ({
        colIdx: headers.indexOf(colName),
        value: Validation.sanitizeCellValue(val)
      }))
      .filter(change => change.colIdx >= 0)
      .sort((a, b) => a.colIdx - b.colIdx);

    for (let i = 0; i < changes.length;) {
      const group = [changes[i]];
      let j = i + 1;
      while (
        j < changes.length &&
        changes[j].colIdx === group[group.length - 1].colIdx + 1
      ) {
        group.push(changes[j]);
        j++;
      }

      sheet
        .getRange(rowIndex, group[0].colIdx + 1, 1, group.length)
        .setValues([group.map(change => change.value)]);
      i = j;
    }

    this._invalidateTable(workspaceId, tabName);
  },

  /**
   * Deletes a row by index (e.g. stopping an ActiveTimer)
   */
  deleteRow(workspaceId, tabName, rowIndex) {
    const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
    const sheet = ss.getSheetByName(tabName);
    sheet.deleteRow(rowIndex);
    this._invalidateTable(workspaceId, tabName);
  },

  /* ------------------- MEMBERS ------------------- */

  listMembers(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    return rows.filter(m => m.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
  },

  getMember(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    return rows.find(m => m.UserID === userId) || null;
  },

  addMember(workspaceId, memberData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS, memberData);
  },

  updateMember(workspaceId, userId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS);
    const mem = rows.find(m => m.UserID === userId);
    if (mem) {
      this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.MEMBERS, mem._rowIndex, updates);
    }
  },

  /* ------------------- CLIENTS & PROJECTS & TASKS & TAGS ------------------- */

  listClients(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS);
    return rows;
  },

  getClient(workspaceId, clientId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS);
    return rows.find(client => client.ClientID === clientId) || null;
  },

  createClient(workspaceId, clientData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.CLIENTS, clientData);
  },

  listProjects(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    return rows;
  },

  getProject(workspaceId, projectId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    return rows.find(p => p.ProjectID === projectId) || null;
  },

  createProject(workspaceId, projectData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS, projectData);
  },

  updateProject(workspaceId, projectId, updates) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS);
    const proj = rows.find(p => p.ProjectID === projectId);
    if (!proj) throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.PROJECTS, proj._rowIndex, updates);
    return { ...proj, ...updates };
  },

  listTasks(workspaceId, projectId = null) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS);
    if (projectId) return rows.filter(t => t.ProjectID === projectId);
    return rows;
  },

  getTask(workspaceId, taskId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS);
    return rows.find(t => t.TaskID === taskId) || null;
  },

  createTask(workspaceId, taskData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TASKS, taskData);
  },

  listTags(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS);
    return rows;
  },

  getTag(workspaceId, tagId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS);
    return rows.find(t => t.TagID === tagId) || null;
  },

  listAllUserProjectAccess(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.USER_PROJECT_ACCESS);
    return rows;
  },

  listUserProjectAccess(workspaceId, userId) {
    return this.listAllUserProjectAccess(workspaceId)
      .filter(row => row.UserID === userId);
  },

  createTag(workspaceId, tagData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TAGS, tagData);
  },

  /* ------------------- ACTIVE TIMERS ------------------- */

  getActiveTimer(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    return rows.find(t => t.UserID === userId) || null;
  },

  listActiveTimers(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    return rows;
  },

  createActiveTimer(workspaceId, timerData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS, timerData);
  },

  deleteActiveTimer(workspaceId, userId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
    const timer = rows.find(t => t.UserID === userId);
    if (!timer) return false;
    this.deleteRow(workspaceId, CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS, timer._rowIndex);
    return true;
  },

  /* ------------------- TIME ENTRIES ------------------- */

  listTimeEntries(workspaceId, filters = {}) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    return rows.filter(entry => {
      // Exclude soft-deleted
      if (entry.Status === 'DELETED') return false;
      if (filters.userId && entry.UserID !== filters.userId) return false;
      if (filters.projectId && entry.ProjectID !== filters.projectId) return false;
      if (filters.taskId && entry.TaskID !== filters.taskId) return false;
      if (filters.approvalStatus && entry.ApprovalStatus !== filters.approvalStatus) return false;

      if (filters.startDate) {
        const start = new Date(entry.StartUTC).getTime();
        const filterStart = new Date(filters.startDate).getTime();
        if (start < filterStart) return false;
      }
      if (filters.endDate) {
        const end = new Date(entry.EndUTC || entry.StartUTC).getTime();
        const filterEnd = new Date(filters.endDate).getTime();
        if (end > filterEnd) return false;
      }
      return true;
    });
  },

  getEntryAnyStatus(workspaceId, entryId) {
    if (!entryId) return null;
    return this.findRowByKey(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES, 'EntryID', entryId);
  },

  getEntry(workspaceId, entryId) {
    const entry = this.getEntryAnyStatus(workspaceId, entryId);
    return entry && entry.Status !== 'DELETED' ? entry : null;
  },

  createTimeEntry(workspaceId, entryData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES, entryData);
  },

  updateTimeEntry(workspaceId, entryId, updates) {
    const entry = this.getEntryAnyStatus(workspaceId, entryId);
    if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES, entry._rowIndex, updates);
    return { ...entry, ...updates };
  },

  /* ------------------- TIMESHEETS & APPROVALS ------------------- */

  listTimesheets(workspaceId, filters = {}) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS);
    return rows.filter(ts => {
      if (filters.userId && ts.UserID !== filters.userId) return false;
      if (filters.status && ts.Status !== filters.status) return false;
      return true;
    });
  },

  getTimesheet(workspaceId, timesheetId) {
    if (!timesheetId) return null;
    return this.findRowByKey(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, 'TimesheetID', timesheetId);
  },

  createTimesheet(workspaceId, tsData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, tsData);
  },

  updateTimesheet(workspaceId, timesheetId, updates) {
    const ts = this.getTimesheet(workspaceId, timesheetId);
    if (!ts) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
    this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, ts._rowIndex, updates);
    return { ...ts, ...updates };
  },

  deleteTimesheet(workspaceId, timesheetId) {
    const ts = this.getTimesheet(workspaceId, timesheetId);
    if (!ts) return false;
    this.deleteRow(workspaceId, CONSTANTS.WORKSPACE_TABS.TIMESHEETS, ts._rowIndex);
    return true;
  },

  logApproval(workspaceId, approvalData) {
    return this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.APPROVALS, approvalData);
  },

  /* ------------------- WORKSPACE AUDIT ------------------- */

  getLastAuditHash(workspaceId, tabName = CONSTANTS.WORKSPACE_TABS.AUDIT_LOG) {
    try {
      const ss = WorkspaceRouter.resolveSpreadsheet(workspaceId);
      const sheet = ss && ss.getSheetByName ? ss.getSheetByName(tabName) : null;
      if (sheet && typeof sheet.getLastRow === 'function' && typeof sheet.getRange === 'function') {
        const lastRow = sheet.getLastRow();
        if (lastRow <= 1) return '0000000000000000000000000000000000000000000000000000000000000000';
        const lastCol = typeof sheet.getLastColumn === 'function' ? sheet.getLastColumn() : (WORKSPACE_SCHEMA[tabName] ? WORKSPACE_SCHEMA[tabName].length : 13);
        const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
        const colIdx = headers.indexOf('RecordHash');
        if (colIdx >= 0) {
          const val = sheet.getRange(lastRow, colIdx + 1, 1, 1).getValue();
          if (val) return String(val).trim();
        }
      }
    } catch (e) {
      // Fallback to table data if sheet range methods are unmocked
    }
    const { rows } = this.getTableData(workspaceId, tabName);
    if (rows && rows.length > 0 && rows[rows.length - 1].RecordHash) {
      return rows[rows.length - 1].RecordHash;
    }
    return '0000000000000000000000000000000000000000000000000000000000000000';
  },

  logWorkspaceAudit(workspaceId, auditData) {
    let auditLock = null;
    let acquiredAuditLock = false;
    try {
      if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
        auditLock = LockService.getScriptLock();
        if (
          auditLock &&
          typeof auditLock.hasLock === 'function' &&
          !auditLock.hasLock()
        ) {
          auditLock.waitLock(10000);
          acquiredAuditLock = true;
        }
      }

      this._invalidateTable(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG);

      const auditId = Validation.generateId('WSAUD');
      const timestamp = new Date().toISOString();
      const beforeStr = typeof auditData.BeforeJSON === 'object'
        ? JSON.stringify(auditData.BeforeJSON)
        : (auditData.BeforeJSON || '');
      const afterStr = typeof auditData.AfterJSON === 'object'
        ? JSON.stringify(auditData.AfterJSON)
        : (auditData.AfterJSON || '');

      const prevHash = this.getLastAuditHash(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG);

      const record = Validation.sanitizeRow({
        AuditID: auditId,
        TimestampUTC: timestamp,
        ActorUserID: auditData.ActorUserID || '',
        ActorRole: auditData.ActorRole || '',
        EntityType: auditData.EntityType,
        EntityID: auditData.EntityID,
        Action: auditData.Action,
        BeforeJSON: beforeStr,
        AfterJSON: afterStr,
        Reason: auditData.Reason || '',
        ClientType: auditData.ClientType || 'WEB',
        PreviousHash: prevHash,
        RecordHash: ''
      });
      record.RecordHash = SecurityService.computeAuditRecordHashV2(
        prevHash,
        record,
        workspaceId
      );

      this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG, record);
      return true;
    } catch (e) {
      console.error('Failed to log workspace audit: ' + e.message);
      return false;
    } finally {
      if (acquiredAuditLock && auditLock) {
        try { auditLock.releaseLock(); } catch (releaseErr) {}
      }
    }
  },
  getWorkspaceSettings(workspaceId) {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.WORKSPACE_SETTINGS);
    const settings = {};
    for (const row of rows) {
      if (row.SettingKey) settings[row.SettingKey] = row.SettingValue;
    }
    return settings;
  },

  setWorkspaceSetting(workspaceId, key, value, updatedBy = 'SYSTEM', description = '') {
    const { rows } = this.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.WORKSPACE_SETTINGS);
    const existing = rows.find(row => row.SettingKey === key);
    const now = new Date().toISOString();
    if (existing) {
      this.updateRow(workspaceId, CONSTANTS.WORKSPACE_TABS.WORKSPACE_SETTINGS, existing._rowIndex, {
        SettingValue: String(value),
        Description: description || existing.Description || '',
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    } else {
      this.appendRow(workspaceId, CONSTANTS.WORKSPACE_TABS.WORKSPACE_SETTINGS, {
        SettingKey: key,
        SettingValue: String(value),
        Description: description,
        UpdatedAt: now,
        UpdatedBy: updatedBy
      });
    }
  }

};

/* ===== WorkspaceRouter.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Router
 * Resolves logical workspace IDs to physical Google Spreadsheet instances
 * via the Master Control Sheet registry. Prevents raw Sheet ID manipulation.
 */

var WorkspaceRouter = (typeof global !== 'undefined' && global.WorkspaceRouter) || {
  // In-memory request cache for spreadsheet references
  cache: {},

  /**
   * Resolves physical Google Spreadsheet for a logical workspace ID
   */
  resolveSpreadsheet(workspaceId) {
    if (!workspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    if (this.cache[workspaceId]) {
      return this.cache[workspaceId];
    }

    const wsRecord = MasterRepository.getWorkspace(workspaceId);
    if (!wsRecord) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${workspaceId}' does not exist in registry.`, 404);
    }

    if (wsRecord.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
      const statusCode = wsRecord.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED ? 410 : 403;
      throw new AppError(
        wsRecord.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED ? ERROR_CODES.WORKSPACE_NOT_FOUND : ERROR_CODES.WORKSPACE_DENIED,
        `Workspace '${workspaceId}' is not active (${wsRecord.Status}).`,
        statusCode
      );
    }

    if (!wsRecord.SpreadsheetID) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Spreadsheet ID not registered for workspace '${workspaceId}'.`, 500);
    }

    if (typeof SpreadsheetApp === 'undefined') {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'SpreadsheetApp runtime is unavailable.');
    }

    const ss = SpreadsheetApp.openById(wsRecord.SpreadsheetID);
    this.cache[workspaceId] = ss;
    return ss;
  },

  /**
   * Clears in-memory router cache
   */
  clearCache() {
    this.cache = {};
  }
};

/* ===== WorkspaceService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Service
 * Manages workspace provisioning, automatic 18-tab schema generation,
 * and Admin assignments under the strict <= 3 workspace limit.
 */

var WorkspaceService = (typeof global !== 'undefined' && global.WorkspaceService) || {
  _toWorkspaceDTO(workspace, includePhysicalIds = false) {
    if (!workspace) return null;
    const dto = {
      WorkspaceID: workspace.WorkspaceID,
      WorkspaceCode: workspace.WorkspaceCode || '',
      WorkspaceName: workspace.WorkspaceName,
      Status: workspace.Status,
      Timezone: workspace.Timezone || 'UTC',
      SchemaVersion: workspace.SchemaVersion || CONSTANTS.SCHEMA_VERSION,
      CreatedAt: workspace.CreatedAt || ''
    };

    if (includePhysicalIds) {
      dto.SpreadsheetID = workspace.SpreadsheetID || '';
      dto.DriveFolderID = workspace.DriveFolderID || '';
      dto.CreatedBy = workspace.CreatedBy || '';
      dto.ArchivedAt = workspace.ArchivedAt || '';
      dto.PartitionPolicy = workspace.PartitionPolicy || '';
      dto.CurrentPartition = workspace.CurrentPartition || '';
      dto.Version = workspace.Version || 1;
    }

    return dto;
  },

  /**
   * Super Admin creates and provisions a new isolated workspace
   */
  createWorkspace(superAdminContext, workspacePayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(workspacePayload, ['name']);

    const workspaceName = workspacePayload.name.trim();
    const timezone = TimezoneService._assertValidTimezone(
      workspacePayload.timezone || 'UTC'
    );
    const workspaceId = Validation.generateId('WSP');

    let spreadsheetId = '';
    let driveFolderId = '';

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.create) {
      const newSpreadsheet = SpreadsheetApp.create(`FLINK Workspace — ${workspaceName}`);
      spreadsheetId = newSpreadsheet.getId();

      // Provision all 18 tabs
      const existingSheets = newSpreadsheet.getSheets();
      const defaultSheet = existingSheets[0];

      for (const [tabName, columns] of Object.entries(WORKSPACE_SCHEMA)) {
        let sheet = newSpreadsheet.getSheetByName(tabName);
        if (!sheet) {
          sheet = newSpreadsheet.insertSheet(tabName);
        }
        // Set header row
        sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
        sheet.setFrozenRows(1);
        trimSheetToSchema_(sheet, columns.length, 1000);
      }

      // Remove original default 'Sheet1' if it is not in schema
      if (defaultSheet && !WORKSPACE_SCHEMA[defaultSheet.getName()]) {
        try {
          newSpreadsheet.deleteSheet(defaultSheet);
        } catch (e) {
          // Ignore if cannot delete
        }
      }

      // Populate WorkspaceInfo row
      const infoSheet = newSpreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO);
      if (infoSheet) {
        const workspaceCode = workspacePayload.code
          ? Validation.sanitizeCellValue(String(workspacePayload.code).trim().toUpperCase())
          : Validation.sanitizeCellValue(workspaceId);
        infoSheet.appendRow([
          workspaceId,
          workspaceCode,
          Validation.sanitizeCellValue(workspaceName),
          CONSTANTS.WORKSPACE_STATUS.ACTIVE,
          timezone,
          CONSTANTS.SCHEMA_VERSION,
          new Date().toISOString()
        ]);
      }
    } else {
      // Mock environment fallback ID
      spreadsheetId = `mock_sheet_${workspaceId.toLowerCase()}`;
    }

    const record = {
      WorkspaceID: workspaceId,
      WorkspaceName: workspaceName,
      SpreadsheetID: spreadsheetId,
      DriveFolderID: driveFolderId,
      Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
      Timezone: timezone,
      CreatedAt: new Date().toISOString(),
      CreatedBy: superAdminContext.userId,
      ArchivedAt: ''
    };

    MasterRepository.createWorkspace(record);

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'WORKSPACE',
      EntityID: workspaceId,
      Action: CONSTANTS.AUDIT_EVENTS.WORKSPACE_CREATED,
      AfterJSON: record,
      Reason: 'Provisioned new workspace'
    });

    return record;
  },

  /**
   * Super Admin assigns an Admin to a workspace (enforcing max 3 workspaces limit)
   */
  assignAdminToWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const adminAccount = MasterRepository.findAccountById(adminUserId);
      if (!adminAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `Admin user ${adminUserId} not found.`);
      if (adminAccount.Role !== CONSTANTS.ROLES.ADMIN) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `User ${adminAccount.Username} is not an Admin.`);
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          `Admin access cannot be granted to inactive workspace '${workspaceId}' (${ws.Status}).`,
          403
        );
      }

      // Hard Limit Check: Max 3 active workspaces
      AuthorizationService.assertAdminWorkspaceLimit(adminUserId, workspaceId);

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: adminUserId,
        WorkspaceID: workspaceId,
        Role: CONSTANTS.ROLES.ADMIN,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      // Register in workspace Members table if not present
      const member = SheetRepository.getMember(workspaceId, adminUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: adminUserId,
          DisplayName: adminAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Management',
          Team: 'Admins',
          JobTitle: 'Workspace Administrator',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'Admin workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Assigns a regular User to a workspace
   */
  assignUserToWorkspace(superAdminContext, targetUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    // An Admin may only assign ordinary users inside a workspace the Admin already manages.
    if (superAdminContext.role === CONSTANTS.ROLES.ADMIN) {
      AuthorizationService.assertWorkspaceAccess(superAdminContext, workspaceId);
    }

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const userAccount = MasterRepository.findAccountById(targetUserId);
      if (!userAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
      if (userAccount.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, `User ${userAccount.Username} is not active (${userAccount.Status}).`, 400);
      }
      if (userAccount.Role !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'The generic user-assignment endpoint may only assign USER accounts. Admin access must be granted by Super Admin through workspaces.assignAdmin.',
          403
        );
      }

      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Workspace ${ws.WorkspaceName} is not active (${ws.Status}).`, 400);
      }

      // Check duplicate assignment
      const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      const alreadyAssigned = existingAccesses.find(a => a.WorkspaceID === workspaceId && (a.Active === true || a.Active === 'TRUE'));
      if (alreadyAssigned) {
        return { ok: true, access: alreadyAssigned, message: 'User is already assigned to this workspace.' };
      }

      const accessData = {
        AccessID: Validation.generateId('ACC'),
        UserID: targetUserId,
        WorkspaceID: workspaceId,
        Role: userAccount.Role,
        Active: true,
        AssignedAt: new Date().toISOString(),
        AssignedBy: superAdminContext.userId
      };

      MasterRepository.assignWorkspaceAccess(accessData);

      const member = SheetRepository.getMember(workspaceId, targetUserId);
      if (!member) {
        SheetRepository.addMember(workspaceId, {
          UserID: targetUserId,
          DisplayName: userAccount.DisplayName,
          Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
          JoinedAt: new Date().toISOString(),
          LeftAt: '',
          Department: 'Operations',
          Team: 'General',
          JobTitle: 'Team Member',
          EmployeeCode: ''
        });
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'USER_ACCESS',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_ASSIGNED,
        AfterJSON: accessData,
        Reason: 'User workspace assignment'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, access: accessData };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin removes an Admin's access to a workspace
   */
  removeAdminFromWorkspace(superAdminContext, adminUserId, workspaceId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      MasterRepository.removeWorkspaceAccess(adminUserId, workspaceId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'ADMIN_ACCESS',
        EntityID: adminUserId,
        Action: CONSTANTS.AUDIT_EVENTS.ADMIN_REMOVED,
        Reason: 'Admin workspace access revoked'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, message: `Admin access removed for workspace ${workspaceId}.` };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Lists workspaces accessible to authenticated user
   */
  listWorkspaces(authContext) {
    const allWorkspaces = MasterRepository
      .listWorkspaces()
      .filter(w => w.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return allWorkspaces.map(w => this._toWorkspaceDTO(w, true));
    }

    const accesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
    const allowedIds = new Set(accesses.map(a => a.WorkspaceID));

    // Admin/User workspace selectors contain only operational workspaces.
    // Suspended/Maintenance workspaces remain visible to Super Admin only.
    return allWorkspaces
      .filter(w =>
        w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE &&
        allowedIds.has(w.WorkspaceID)
      )
      .map(w => this._toWorkspaceDTO(w, false));
  }
};

/* ===== TimezoneService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Workspace Timezone Service
 * Keeps storage timestamps in UTC while deriving business dates/weeks in the
 * workspace's configured IANA timezone.
 */

var TimezoneService = (typeof global !== 'undefined' && global.TimezoneService) || {
  _timezoneCache: {},
  _weekStartCache: {},

  _clearCache(workspaceId) {
    if (!this._timezoneCache) this._timezoneCache = {};
    if (!this._weekStartCache) this._weekStartCache = {};
    if (workspaceId) {
      delete this._timezoneCache[String(workspaceId)];
      delete this._weekStartCache[String(workspaceId)];
    } else {
      this._timezoneCache = {};
      this._weekStartCache = {};
    }
  },

  beginRequest() {
    this._clearCache();
  },

  _assertValidTimezone(timezone) {
    const value = String(timezone || '').trim();
    if (!value) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Timezone is required.', 400);
    }

    try {
      if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
        new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return value;
      }
      if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
        Utilities.formatDate(new Date(), value, 'yyyy-MM-dd');
        return value;
      }
    } catch (err) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid IANA timezone: ${value}.`,
        400
      );
    }

    if (value !== 'UTC') {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Timezone ${value} cannot be validated in this runtime.`,
        400
      );
    }
    return value;
  },

  getWorkspaceTimezone(workspaceId) {
    if (!this._timezoneCache) this._timezoneCache = {};
    const cacheKey = String(workspaceId || '__GLOBAL__');
    if (this._timezoneCache[cacheKey]) {
      return this._timezoneCache[cacheKey];
    }
    const ws = workspaceId && typeof MasterRepository !== 'undefined' && MasterRepository.getWorkspace
      ? MasterRepository.getWorkspace(workspaceId)
      : null;
    const configured = (ws && ws.Timezone) ||
      (typeof MasterRepository !== 'undefined' && MasterRepository.getGlobalSetting ? MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'UTC') : 'UTC') ||
      'UTC';
    const validated = this._assertValidTimezone(configured);
    this._timezoneCache[cacheKey] = validated;
    return validated;
  },

  getWeekStartName(workspaceId) {
    if (!this._weekStartCache) this._weekStartCache = {};
    const cacheKey = String(workspaceId || '__GLOBAL__');
    if (this._weekStartCache[cacheKey]) {
      return this._weekStartCache[cacheKey];
    }
    const dayNames = [
      'Sunday', 'Monday', 'Tuesday', 'Wednesday',
      'Thursday', 'Friday', 'Saturday'
    ];
    let configured = '';
    // 1. Explicit workspace-specific override in MasterRepository (e.g. WS_W1_WEEK_STARTS)
    if (workspaceId && typeof MasterRepository !== 'undefined' && MasterRepository.getGlobalSetting) {
      configured = MasterRepository.getGlobalSetting(`WS_${workspaceId}_WEEK_STARTS`, '');
    }
    // 2. Explicit workspace setting via Flags if stored
    if (!configured && workspaceId && typeof Flags !== 'undefined' && Flags._loadWorkspace) {
      try {
        const wsMap = Flags._loadWorkspace(workspaceId);
        if (wsMap && wsMap.WEEK_STARTS) {
          configured = wsMap.WEEK_STARTS;
        }
      } catch (e) {}
    }
    // 3. Global setting in MasterRepository (e.g. WEEK_STARTS)
    if (!configured && typeof MasterRepository !== 'undefined' && MasterRepository.getGlobalSetting) {
      configured = MasterRepository.getGlobalSetting('WEEK_STARTS', '');
    }
    // 4. Default to Sunday
    if (!configured) {
      configured = 'Sunday';
    }
    configured = String(configured).trim();

    const canonical = dayNames.find(
      day => day.toLowerCase() === configured.toLowerCase()
    );
    if (!canonical) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid week start '${configured}'. Expected a weekday name.`,
        400
      );
    }
    this._weekStartCache[cacheKey] = canonical;
    return canonical;
  },

  _parseDateKey(dateKey) {
    const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid local date. Expected YYYY-MM-DD.', 400);
    }
    return {
      year: parseInt(match[1], 10),
      month: parseInt(match[2], 10),
      day: parseInt(match[3], 10)
    };
  },

  _offsetMinutes(date, timezone) {
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      const raw = Utilities.formatDate(date, timezone, 'Z'); // e.g. +0300
      const match = String(raw).match(/^([+-])(\d{2})(\d{2})$/);
      if (!match) {
        throw new AppError(ERROR_CODES.INTERNAL_ERROR, `Could not resolve timezone offset for ${timezone}.`, 500);
      }
      const sign = match[1] === '-' ? -1 : 1;
      return sign * (parseInt(match[2], 10) * 60 + parseInt(match[3], 10));
    }

    // Node/test fallback. Compute timezone offset by formatting parts in the
    // target timezone and comparing those wall-clock components to UTC.
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      });
      const parts = formatter.formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      const asUtc = Date.UTC(
        parseInt(obj.year, 10),
        parseInt(obj.month, 10) - 1,
        parseInt(obj.day, 10),
        parseInt(obj.hour, 10),
        parseInt(obj.minute, 10),
        parseInt(obj.second, 10)
      );
      return Math.round((asUtc - date.getTime()) / 60000);
    }

    return 0;
  },

  localDateTimeToUtc(dateKey, timezone, hour = 0, minute = 0, second = 0, millisecond = 0) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const wallClockAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let resolved = wallClockAsUtc;

    // Two/three passes handle DST offset changes around the target instant.
    for (let i = 0; i < 3; i++) {
      const offsetMinutes = this._offsetMinutes(new Date(resolved), timezone);
      const next = wallClockAsUtc - offsetMinutes * 60000;
      if (next === resolved) break;
      resolved = next;
    }
    return new Date(resolved);
  },

  formatDateKey(workspaceId, dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid UTC timestamp.', 400);
    }
    const timezone = this.getWorkspaceTimezone(workspaceId);
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(date, timezone, 'yyyy-MM-dd');
    }
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(date);
      const obj = {};
      parts.forEach(p => {
        if (p.type !== 'literal') obj[p.type] = p.value;
      });
      return `${obj.year}-${obj.month}-${obj.day}`;
    }
    return date.toISOString().substring(0, 10);
  },

  formatDateTime(workspaceId, dateValue) {
    const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
    if (isNaN(date.getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid UTC timestamp.', 400);
    }
    const timezone = this.getWorkspaceTimezone(workspaceId);
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      return Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm:ss') + ' ' + timezone;
    }
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      return new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
      }).format(date) + ' ' + timezone;
    }
    return date.toISOString() + ' UTC';
  },

  formatMonthKey(workspaceId, dateValue) {
    return this.formatDateKey(workspaceId, dateValue).substring(0, 7);
  },

  addLocalDays(dateKey, days) {
    const { year, month, day } = this._parseDateKey(dateKey);
    const d = new Date(Date.UTC(year, month - 1, day + days));
    return d.toISOString().substring(0, 10);
  },

  diffLocalDateDays(startDateKey, endDateKey) {
    const s = this._parseDateKey(startDateKey);
    const e = this._parseDateKey(endDateKey);
    const sMs = Date.UTC(s.year, s.month - 1, s.day);
    const eMs = Date.UTC(e.year, e.month - 1, e.day);
    return Math.round((eMs - sMs) / 86400000);
  },

  getWeekBounds(workspaceId, dateOrLocalKey) {
    const timezone = this.getWorkspaceTimezone(workspaceId);
    const input = String(dateOrLocalKey || '');
    const localDateKey = /^\d{4}-\d{2}-\d{2}$/.test(input)
      ? input
      : this.formatDateKey(workspaceId, dateOrLocalKey);

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const configured = this.getWeekStartName(workspaceId);
    const startDayIndex = dayNames.indexOf(configured);

    const p = this._parseDateKey(localDateKey);
    const calendarDate = new Date(Date.UTC(p.year, p.month - 1, p.day));
    const currentDayIndex = calendarDate.getUTCDay();
    const delta = (currentDayIndex - startDayIndex + 7) % 7;

    const startLocalDate = this.addLocalDays(localDateKey, -delta);
    const nextWeekLocalDate = this.addLocalDays(startLocalDate, 7);
    const endLocalDate = this.addLocalDays(startLocalDate, 6);

    const startUtc = this.localDateTimeToUtc(startLocalDate, timezone, 0, 0, 0, 0);
    const nextWeekUtc = this.localDateTimeToUtc(nextWeekLocalDate, timezone, 0, 0, 0, 0);
    const endUtc = new Date(nextWeekUtc.getTime() - 1);

    const dayLabels = [];
    for (let i = 0; i < 7; i++) {
      dayLabels.push(dayNames[(startDayIndex + i) % 7]);
    }

    return {
      timezone,
      startLocalDate,
      endLocalDate,
      startUtc,
      endUtc,
      dayLabels
    };
  }
};

/* ============================================================ */

/** FLINK Time — Consolidated master data, time tracking, timer, timesheet, approval, report, rollup, and dashboard services. */


/* ===== MasterDataServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Master Data Services
 * ClientService, ProjectService, TaskService, and TagService.
 * Governs workspace master entities, billing rate configurations, and estimates.
 */

var ClientService = (typeof global !== 'undefined' && global.ClientService) || {
  listClients(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const clients = SheetRepository.listClients(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return clients;
    return clients
      .filter(client => String(client.Status || '').toUpperCase() === 'ACTIVE')
      .map(client => ({
        ClientID: client.ClientID,
        ClientName: client.ClientName,
        Status: client.Status
      }));
  },

  createClient(authContext, workspaceId, clientPayload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(clientPayload, ['clientName']);

    const clientName = String(clientPayload.clientName || '').trim();
    if (!clientName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Client name cannot be blank.', 400);
    }
    const duplicateClient = SheetRepository.listClients(workspaceId)
      .some(client =>
        String(client.Status || '').toUpperCase() === 'ACTIVE' &&
        String(client.ClientName || '').trim().toLowerCase() === clientName.toLowerCase()
      );
    if (duplicateClient) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active client with this name already exists.', 409);
    }

    const clientId = Validation.generateId('CLI');
    const clientRecord = {
      ClientID: clientId,
      ClientName: Validation.sanitizeCellValue(clientName),
      Status: 'ACTIVE',
      Notes: clientPayload.notes ? Validation.sanitizeCellValue(clientPayload.notes) : '',
      CreatedAt: new Date().toISOString()
    };

    SheetRepository.createClient(workspaceId, clientRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'CLIENT',
      EntityID: clientId,
      Action: 'CLIENT_CREATED',
      AfterJSON: clientRecord
    });

    return clientRecord;
  }
};

var ProjectService = (typeof global !== 'undefined' && global.ProjectService) || {
  listProjects(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    let projects = SheetRepository.listProjects(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return projects;

    const accessState = TrackingPolicyService.getProjectAccessState(authContext, workspaceId);
    if (accessState.aclEnabled) {
      projects = projects.filter(project => accessState.allowedProjectIds.has(project.ProjectID));
    }
    projects = projects.filter(project => String(project.Status || '').toUpperCase() === 'ACTIVE');

    // USER-facing DTO deliberately excludes rates, costs, budgets, and internal notes.
    return projects.map(p => ({
      ProjectID: p.ProjectID,
      ClientID: p.ClientID,
      ProjectName: p.ProjectName,
      Code: p.Code,
      Status: p.Status,
      BillableDefault: p.BillableDefault,
      EstimateHours: p.EstimateHours,
      StartDate: p.StartDate,
      EndDate: p.EndDate,
      ColorKey: p.ColorKey
    }));
  },

  getProject(authContext, workspaceId, projectId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const project = SheetRepository.getProject(workspaceId, projectId);
    if (!project || authContext.role !== CONSTANTS.ROLES.USER) return project;

    if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
      throw new AppError(ERROR_CODES.NOT_FOUND, 'Project is not active.', 404);
    }
    TrackingPolicyService.assertProjectAccess(authContext, workspaceId, projectId);

    return {
      ProjectID: project.ProjectID,
      ClientID: project.ClientID,
      ProjectName: project.ProjectName,
      Code: project.Code,
      Status: project.Status,
      BillableDefault: project.BillableDefault,
      EstimateHours: project.EstimateHours,
      StartDate: project.StartDate,
      EndDate: project.EndDate,
      ColorKey: project.ColorKey
    };
  },

  createProject(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['projectName']);

    const projectName = String(payload.projectName || '').trim();
    if (!projectName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project name cannot be blank.', 400);
    }

    const hourlyRate = Number(payload.hourlyRate || 0);
    const costRate = Number(payload.costRate || 0);
    const estimateHours = Number(payload.estimateHours || 0);
    const budgetAmount = Number(payload.budgetAmount || 0);
    for (const [label, value] of [
      ['hourlyRate', hourlyRate],
      ['costRate', costRate],
      ['estimateHours', estimateHours],
      ['budgetAmount', budgetAmount]
    ]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${label} must be a non-negative number.`, 400);
      }
    }

    if (payload.startDate && isNaN(new Date(payload.startDate).getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project startDate is invalid.', 400);
    }
    if (payload.endDate && isNaN(new Date(payload.endDate).getTime())) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project endDate is invalid.', 400);
    }
    if (payload.startDate && payload.endDate &&
        new Date(payload.endDate).getTime() < new Date(payload.startDate).getTime()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project endDate cannot be before startDate.', 400);
    }

    const clientId = payload.clientId ? String(payload.clientId).trim() : '';
    if (clientId) {
      const client = SheetRepository.getClient(workspaceId, clientId);
      if (!client) throw new AppError(ERROR_CODES.NOT_FOUND, `Client ${clientId} not found.`, 404);
      if (String(client.Status || '').toUpperCase() !== 'ACTIVE') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Selected client is not active.', 400);
      }
    }

    const projectId = Validation.generateId('PRJ');
    const projectRecord = {
      ProjectID: projectId,
      ClientID: clientId,
      ProjectName: Validation.sanitizeCellValue(projectName),
      Code: payload.code ? Validation.sanitizeCellValue(payload.code.trim()) : '',
      Status: 'ACTIVE',
      BillableDefault: payload.billableDefault !== undefined ? (payload.billableDefault ? true : false) : true,
      HourlyRate: hourlyRate,
      CostRate: costRate,
      EstimateHours: estimateHours,
      BudgetAmount: budgetAmount,
      StartDate: payload.startDate || '',
      EndDate: payload.endDate || '',
      ColorKey: payload.colorKey || '#3B82F6',
      Notes: payload.notes ? Validation.sanitizeCellValue(payload.notes) : ''
    };

    SheetRepository.createProject(workspaceId, projectRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'PROJECT',
      EntityID: projectId,
      Action: CONSTANTS.AUDIT_EVENTS.PROJECT_CREATED,
      AfterJSON: projectRecord
    });

    return projectRecord;
  },

  updateProject(authContext, workspaceId, projectId, updates) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    const existing = SheetRepository.getProject(workspaceId, projectId);
    if (!existing) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} not found.`, 404);
    }

    const sanitizedUpdates = {};
    if (updates.projectName !== undefined) {
      const projectName = String(updates.projectName || '').trim();
      if (!projectName) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project name cannot be blank.', 400);
      }
      sanitizedUpdates.ProjectName = Validation.sanitizeCellValue(projectName);
    }
    if (updates.code !== undefined) sanitizedUpdates.Code = Validation.sanitizeCellValue(String(updates.code || '').trim());

    if (updates.status !== undefined) {
      const nextStatus = String(updates.status || '').trim().toUpperCase();
      if (!nextStatus) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Project status cannot be blank.', 400);
      }
      if (nextStatus !== 'ACTIVE') {
        const activeTimers = SheetRepository.listActiveTimers(workspaceId);
        const hasRunningTimer = activeTimers.some(timer => timer.ProjectID === projectId);
        if (hasRunningTimer) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            'Project cannot be made inactive while an active timer is using it.',
            409
          );
        }
      }
      sanitizedUpdates.Status = nextStatus;
    }

    for (const [inputKey, columnName] of [
      ['hourlyRate', 'HourlyRate'],
      ['costRate', 'CostRate'],
      ['estimateHours', 'EstimateHours'],
      ['budgetAmount', 'BudgetAmount']
    ]) {
      if (updates[inputKey] !== undefined) {
        const value = Number(updates[inputKey]);
        if (!Number.isFinite(value) || value < 0) {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `${inputKey} must be a non-negative number.`, 400);
        }
        sanitizedUpdates[columnName] = value;
      }
    }
    if (updates.colorKey) sanitizedUpdates.ColorKey = updates.colorKey;

    const updated = SheetRepository.updateProject(workspaceId, projectId, sanitizedUpdates);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'PROJECT',
      EntityID: projectId,
      Action: CONSTANTS.AUDIT_EVENTS.PROJECT_UPDATED,
      AfterJSON: updated
    });

    return updated;
  }
};

var TaskService = (typeof global !== 'undefined' && global.TaskService) || {
  listTasks(authContext, workspaceId, projectId = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    if (authContext.role !== CONSTANTS.ROLES.USER) {
      return SheetRepository.listTasks(workspaceId, projectId);
    }

    const accessState = TrackingPolicyService.getProjectAccessState(authContext, workspaceId);
    const allowedProjectIds = accessState.aclEnabled
      ? accessState.allowedProjectIds
      : null;

    if (projectId) {
      const project = SheetRepository.getProject(workspaceId, projectId);
      if (!project || String(project.Status || '').toUpperCase() !== 'ACTIVE') return [];
      TrackingPolicyService.assertProjectAccess(authContext, workspaceId, projectId);
    }

    return SheetRepository.listTasks(workspaceId, projectId).filter(task => {
      if (allowedProjectIds && !allowedProjectIds.has(task.ProjectID)) return false;
      return ['OPEN', 'ACTIVE'].includes(String(task.Status || '').toUpperCase());
    });
  },

  createTask(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['projectId', 'taskName']);

    const project = SheetRepository.getProject(workspaceId, payload.projectId);
    if (!project) throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${payload.projectId} not found.`, 404);
    if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Tasks can only be added to active projects.', 400);
    }

    const taskName = String(payload.taskName || '').trim();
    if (!taskName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Task name cannot be blank.', 400);
    }
    const duplicateTask = SheetRepository.listTasks(workspaceId, payload.projectId)
      .some(task =>
        ['OPEN', 'ACTIVE'].includes(String(task.Status || '').toUpperCase()) &&
        String(task.TaskName || '').trim().toLowerCase() === taskName.toLowerCase()
      );
    if (duplicateTask) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active task with this name already exists in the project.', 409);
    }

    const taskId = Validation.generateId('TSK');
    const taskRecord = {
      TaskID: taskId,
      ProjectID: payload.projectId,
      TaskName: Validation.sanitizeCellValue(taskName),
      Status: 'OPEN',
      EstimateHours: parseFloat(payload.estimateHours) || 0,
      BillableDefault: payload.billableDefault !== undefined ? (payload.billableDefault ? true : false) : true,
      SortOrder: parseInt(payload.sortOrder, 10) || 1
    };

    SheetRepository.createTask(workspaceId, taskRecord);

    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      EntityType: 'TASK',
      EntityID: taskId,
      Action: 'TASK_CREATED',
      AfterJSON: taskRecord
    });

    return taskRecord;
  }
};

var TagService = (typeof global !== 'undefined' && global.TagService) || {
  listTags(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const tags = SheetRepository.listTags(workspaceId);
    if (authContext.role !== CONSTANTS.ROLES.USER) return tags;
    return tags.filter(tag => String(tag.Status || '').toUpperCase() === 'ACTIVE');
  },

  createTag(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);
    Validation.assertRequired(payload, ['tagName']);

    const tagName = String(payload.tagName || '').trim();
    if (!tagName) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Tag name cannot be blank.', 400);
    }
    const duplicateTag = SheetRepository.listTags(workspaceId)
      .some(tag =>
        String(tag.Status || '').toUpperCase() === 'ACTIVE' &&
        String(tag.TagName || '').trim().toLowerCase() === tagName.toLowerCase()
      );
    if (duplicateTag) {
      throw new AppError(ERROR_CODES.CONFLICT, 'An active tag with this name already exists.', 409);
    }

    const tagId = Validation.generateId('TAG');
    const tagRecord = {
      TagID: tagId,
      TagName: Validation.sanitizeCellValue(tagName),
      Status: 'ACTIVE',
      Category: payload.category ? Validation.sanitizeCellValue(payload.category) : 'General'
    };

    SheetRepository.createTag(workspaceId, tagRecord);
    return tagRecord;
  }
};

/* ===== TimeEntryService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Time Entry Service
 * Manages manual time entry creation, optimistic concurrency edits,
 * soft deletion, and status assertions (locking against approved records).
 */

var TimeEntryService = (typeof global !== 'undefined' && global.TimeEntryService) || {
  _canonicalUtcTimestamp(value, fieldName) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `${fieldName} must be a valid timestamp.`,
        400
      );
    }
    return date.toISOString();
  },

  /**
   * Creates a manual time entry
   */
  createManualEntry(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    Validation.assertRequired(payload, ['startUtc', 'endUtc']);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to create manual entry. Please retry.', 409);
      }
    }

    try {
      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        payload,
        { manual: true, enforceRequired: true }
      );
      const startUtc = this._canonicalUtcTimestamp(payload.startUtc, 'startUtc');
      const endUtc = this._canonicalUtcTimestamp(payload.endUtc, 'endUtc');
      const durationSeconds = Validation.validateDateRange(startUtc, endUtc);
      if (durationSeconds <= 0) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Manual time entry duration must be greater than zero.',
          400
        );
      }
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, {
          StartUTC: startUtc,
          EndUTC: endUtc
        });
      }
      const now = new Date().toISOString();

      const hourlyRateSnapshot = tracking.project ? (parseFloat(tracking.project.HourlyRate) || 0) : 0;
      const costRateSnapshot = tracking.project ? (parseFloat(tracking.project.CostRate) || 0) : 0;

      const entryId = Validation.generateId('ENT');
      const timeEntry = {
        EntryID: entryId,
        UserID: authContext.userId,
        ProjectID: tracking.projectId,
        TaskID: tracking.taskId,
        Description: tracking.description,
        Tags: tracking.tagIdsCsv,
        StartUTC: startUtc,
        EndUTC: endUtc,
        DurationSeconds: durationSeconds,
        Billable: tracking.billable,
        HourlyRateSnapshot: hourlyRateSnapshot,
        CostRateSnapshot: costRateSnapshot,
        EntrySource: CONSTANTS.ENTRY_SOURCE.MANUAL,
        ManualEntry: true,
        Status: 'ACTIVE',
        ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
        TimesheetID: '',
        Locked: false,
        CreatedAt: now,
        CreatedBy: authContext.userId,
        UpdatedAt: now,
        UpdatedBy: authContext.userId,
        DeletedAt: '',
        DeletedBy: '',
        Version: 1,
        WorkMode: payload.workMode === 'WFH' ? 'WFH' : 'OFFICE'
      };

      SheetRepository.createTimeEntry(workspaceId, timeEntry);

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        SpreadsheetApp.flush();
      }

      if (typeof RollupService !== 'undefined' && RollupService.recordTimeEntry) {
        try {
          RollupService.recordTimeEntry(workspaceId, timeEntry);
        } catch (rollupErr) {
          console.warn('Manual-entry rollup update notice: ' + rollupErr.message);
        }
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_CREATED,
        AfterJSON: timeEntry,
        ClientType: 'WEB'
      });

      return this.toTimeEntryDTO(
        timeEntry,
        authContext.role !== CONSTANTS.ROLES.USER
      );
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Updates an existing time entry with optimistic concurrency guard
   */
  updateEntry(authContext, workspaceId, entryId, updates, expectedVersionParam = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'updates must be an object.', 400);
    }

    const mutableFields = [
      'projectId', 'taskId', 'description', 'tags', 'billable', 'startUtc', 'endUtc', 'workMode'
    ];
    if (!mutableFields.some(field => Object.prototype.hasOwnProperty.call(updates, field))) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'At least one editable time-entry field is required.',
        400
      );
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      try {
        scriptLock = LockService.getScriptLock();
        scriptLock.waitLock(10000);
      } catch (lockErr) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Server is busy processing concurrent writes. Please retry.', 409);
      }
    }

    try {
      // Re-read inside critical section
      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);

      AuthorizationService.assertRecordOwnership(authContext, entry.UserID);
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
      }

      // Locking check
      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'This time entry is locked, pending approval, or part of an approved timesheet.', 403);
      }

      // Every client mutation must name the version it read. Optional version
      // checks allow silent lost updates, so fail closed when the version is absent.
      const expVer = updates.expectedVersion !== undefined
        ? updates.expectedVersion
        : expectedVersionParam;
      if (expVer === null || expVer === undefined || expVer === '') {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'expectedVersion is required when updating a time entry.',
          400
        );
      }
      Validation.assertRecordVersion(entry, expVer);

      const mergedTrackingPayload = {
        projectId: updates.projectId !== undefined ? updates.projectId : entry.ProjectID,
        taskId: updates.taskId !== undefined ? updates.taskId : entry.TaskID,
        description: updates.description !== undefined ? updates.description : entry.Description,
        tags: updates.tags !== undefined ? updates.tags : entry.Tags,
        billable: updates.billable !== undefined ? updates.billable : entry.Billable
      };
      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        mergedTrackingPayload,
        { manual: false, enforceRequired: true }
      );

      const allowed = {};
      if (updates.projectId !== undefined) {
        allowed.ProjectID = tracking.projectId;
        const projectChanged = String(tracking.projectId || '') !== String(entry.ProjectID || '');
        if (projectChanged) {
          allowed.HourlyRateSnapshot = tracking.project
            ? (parseFloat(tracking.project.HourlyRate) || 0)
            : 0;
          allowed.CostRateSnapshot = tracking.project
            ? (parseFloat(tracking.project.CostRate) || 0)
            : 0;
        }
      }
      if (updates.taskId !== undefined) allowed.TaskID = tracking.taskId;
      if (updates.description !== undefined) allowed.Description = tracking.description;
      if (updates.tags !== undefined) allowed.Tags = tracking.tagIdsCsv;
      if (updates.billable !== undefined) allowed.Billable = tracking.billable;
      if (updates.workMode !== undefined) allowed.WorkMode = updates.workMode === 'WFH' ? 'WFH' : 'OFFICE';

      if (updates.startUtc !== undefined || updates.endUtc !== undefined) {
        const nextStart = this._canonicalUtcTimestamp(
          updates.startUtc !== undefined ? updates.startUtc : entry.StartUTC,
          'startUtc'
        );
        const nextEnd = this._canonicalUtcTimestamp(
          updates.endUtc !== undefined ? updates.endUtc : entry.EndUTC,
          'endUtc'
        );
        const nextDuration = Validation.validateDateRange(nextStart, nextEnd);
        if (nextDuration <= 0) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Time entry duration must be greater than zero.',
            400
          );
        }
        if (authContext.role === CONSTANTS.ROLES.USER) {
          TrackingPolicyService.assertEntryEditableByAge(workspaceId, {
            ...entry,
            StartUTC: nextStart,
            EndUTC: nextEnd
          });
        }
        allowed.StartUTC = nextStart;
        allowed.EndUTC = nextEnd;
        allowed.DurationSeconds = nextDuration;
      }

      allowed.UpdatedAt = new Date().toISOString();
      allowed.UpdatedBy = authContext.userId;
      allowed.Version = (parseInt(entry.Version, 10) || 1) + 1;

      const updated = SheetRepository.updateTimeEntry(workspaceId, entryId, allowed);

      // Explicit flush in Google Apps Script to guarantee write persistence before reconciliation.
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (typeof RollupService !== 'undefined' && RollupService.reconcileMutation) {
        RollupService.reconcileMutation(
          workspaceId,
          entry,
          updated,
          'UPDATE'
        );
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_UPDATED,
        BeforeJSON: entry,
        AfterJSON: updated
      });

      return this.toTimeEntryDTO(
        updated,
        authContext.role !== CONSTANTS.ROLES.USER
      );
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Domain-to-DTO Mapper: strictly isolates Sheet storage schema from API response contracts
   */
  toTimeEntryDTO(entry, includeFinancial = false) {
    if (!entry) return null;
    const durationSeconds = parseInt(entry.DurationSeconds, 10) || 0;
    const dto = {
      entryId: entry.EntryID,
      userId: entry.UserID,
      projectId: entry.ProjectID || '',
      taskId: entry.TaskID || '',
      description: entry.Description || '',
      tags: entry.Tags || '',
      workMode: entry.WorkMode || 'OFFICE',
      startUtc: entry.StartUTC,
      endUtc: entry.EndUTC,
      durationSeconds: durationSeconds,
      durationHours: +(durationSeconds / 3600).toFixed(2),
      billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
      status: entry.Status || 'ACTIVE',
      approvalStatus: entry.ApprovalStatus || 'OPEN',
      locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      timesheetId: entry.TimesheetID || '',
      version: parseInt(entry.Version, 10) || 1,
      createdAt: entry.CreatedAt,
      updatedAt: entry.UpdatedAt,
      // Non-financial compatibility aliases.
      EntryID: entry.EntryID,
      UserID: entry.UserID,
      WorkMode: entry.WorkMode || 'OFFICE',
      DurationSeconds: durationSeconds,
      ApprovalStatus: entry.ApprovalStatus || 'OPEN',
      Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
      Version: parseInt(entry.Version, 10) || 1
    };

    if (includeFinancial) {
      dto.hourlyRateSnapshot = parseFloat(entry.HourlyRateSnapshot) || 0;
      dto.costRateSnapshot = parseFloat(entry.CostRateSnapshot) || 0;
    }

    return dto;
  },

  /**
   * Soft-deletes a time entry inside atomic LockService critical section
   */
  deleteEntry(authContext, workspaceId, entryId, expectedVersion = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    if (expectedVersion === null || expectedVersion === undefined || expectedVersion === '') {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'expectedVersion is required when deleting a time entry.',
        400
      );
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(10000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to delete entry. Please retry.', 409);
      }
    }

    try {
      // Re-read row after acquiring lock
      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${entryId} not found.`);

      AuthorizationService.assertRecordOwnership(authContext, entry.UserID);
      Validation.assertRecordVersion(entry, expectedVersion);
      if (authContext.role === CONSTANTS.ROLES.USER) {
        TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
      }

      if (entry.Locked === true || entry.Locked === 'TRUE' || 
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED ||
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
        throw new AppError(ERROR_CODES.ENTRY_LOCKED, 'Cannot delete an entry that is locked, pending approval, or approved.', 403);
      }

      const now = new Date().toISOString();
      const deletedEntry = SheetRepository.updateTimeEntry(workspaceId, entryId, {
        Status: 'DELETED',
        DeletedAt: now,
        DeletedBy: authContext.userId,
        UpdatedAt: now,
        UpdatedBy: authContext.userId,
        Version: (parseInt(entry.Version, 10) || 1) + 1
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (typeof RollupService !== 'undefined' && RollupService.reconcileMutation) {
        RollupService.reconcileMutation(
          workspaceId,
          entry,
          deletedEntry,
          'DELETE'
        );
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIME_ENTRY',
        EntityID: entryId,
        Action: CONSTANTS.AUDIT_EVENTS.ENTRY_DELETED,
        BeforeJSON: entry,
        Reason: 'User deleted time entry'
      });

      return {
        ok: true,
        entryId,
        version: (parseInt(entry.Version, 10) || 1) + 1,
        message: `Time entry ${entryId} deleted.`
      };
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Lists time entries with filtering and role-based data visibility
   */
  listEntries(authContext, workspaceId, filters = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const queryFilters = { ...filters };

    // Regular users can only list their own entries
    if (authContext.role === CONSTANTS.ROLES.USER) {
      queryFilters.userId = authContext.userId;
    }

    const rows = SheetRepository.listTimeEntries(workspaceId, queryFilters);
    const includeFinancial = authContext.role !== CONSTANTS.ROLES.USER;
    return rows.map(entry => this.toTimeEntryDTO(entry, includeFinancial));
  },

  /**
   * Performs bulk administration actions on time entries
   */
  bulkAction(authContext, workspaceId, entryIds = [], actionType, params = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    if (!Array.isArray(entryIds) || entryIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'entryIds must contain at least one time entry.');
    }
    if (entryIds.length > 100) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Bulk actions are limited to 100 entries per request.', 400);
    }
    if (new Set(entryIds.map(String)).size !== entryIds.length) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'entryIds must not contain duplicates.', 400);
    }

    const expectedVersions = params && params.expectedVersions;
    if (!expectedVersions || typeof expectedVersions !== 'object' || Array.isArray(expectedVersions)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'params.expectedVersions is required for every bulk-mutated entry.',
        400
      );
    }

    const normalizedAction = String(actionType || '').toUpperCase();
    const allowedActions = ['DELETE', 'LOCK', 'UNLOCK', 'CHANGE_PROJECT'];
    if (!allowedActions.includes(normalizedAction)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        normalizedAction === 'APPROVE'
          ? 'Bulk approval is not allowed. Approve the submitted timesheet instead.'
          : `Unsupported bulk action: ${normalizedAction}`
      );
    }

    if (
      (normalizedAction === 'LOCK' || normalizedAction === 'UNLOCK') &&
      ![CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN].includes(authContext.role)
    ) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Only Admin or Super Admin can lock/unlock entries.', 403);
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(15000)) {
        throw new AppError(ERROR_CODES.CONFLICT, 'Could not acquire lock for bulk action. Please retry.', 409);
      }
    }

    try {
      // Phase 1: validate the entire batch before changing any record.
      const entries = entryIds.map(id => {
        const entry = SheetRepository.getEntry(workspaceId, id);
        if (!entry) throw new AppError(ERROR_CODES.NOT_FOUND, `Time entry ${id} not found.`, 404);

        AuthorizationService.assertRecordOwnership(authContext, entry.UserID);
        if (!Object.prototype.hasOwnProperty.call(expectedVersions, id)) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            `Missing expected version for time entry ${id}.`,
            400
          );
        }
        Validation.assertRecordVersion(entry, expectedVersions[id]);

        if (
          authContext.role === CONSTANTS.ROLES.USER &&
          (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT')
        ) {
          TrackingPolicyService.assertEntryEditableByAge(workspaceId, entry);
        }

        const isLocked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
        const isSubmitted = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED;
        const isApproved = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED;

        const modifiesContent =
          normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT';
        if (modifiesContent && (isLocked || isSubmitted || isApproved)) {
          throw new AppError(
            ERROR_CODES.ENTRY_LOCKED,
            `Entry ${entry.EntryID} is locked or belongs to a submitted/approved timesheet. Reopen/reject the timesheet first.`,
            403
          );
        }
        if (
          (normalizedAction === 'LOCK' || normalizedAction === 'UNLOCK') &&
          (isSubmitted || isApproved)
        ) {
          throw new AppError(
            ERROR_CODES.ENTRY_LOCKED,
            `Entry ${entry.EntryID} belongs to a submitted/approved timesheet and its lock state cannot be changed directly.`,
            403
          );
        }

        return entry;
      });

      if (normalizedAction === 'CHANGE_PROJECT' && !params.projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'projectId is required for CHANGE_PROJECT.');
      }

      // Validate target project/task/access for every affected entry before writing.
      // This also refreshes the rate snapshots so financial rollups cannot retain
      // rates from the previous project.
      const changeContexts = new Map();
      if (normalizedAction === 'CHANGE_PROJECT') {
        for (const entry of entries) {
          const tracking = TrackingPolicyService.validateTrackingContext(
            authContext,
            workspaceId,
            {
              projectId: params.projectId,
              taskId: params.taskId || '',
              description: entry.Description || '',
              tags: entry.Tags || '',
              billable: entry.Billable
            },
            { manual: false, enforceRequired: true }
          );
          changeContexts.set(entry.EntryID, tracking);
        }
      }

      // Phase 2: create the complete mutation plan after all validation succeeds.
      const now = new Date().toISOString();
      const plans = entries.map(entry => {
        const nextVersion = (parseInt(entry.Version, 10) || 1) + 1;
        let updates = null;

        if (normalizedAction === 'DELETE') {
          updates = {
            Status: 'DELETED',
            DeletedAt: now,
            DeletedBy: authContext.userId,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'LOCK') {
          updates = {
            Locked: true,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'UNLOCK') {
          updates = {
            Locked: false,
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        } else if (normalizedAction === 'CHANGE_PROJECT') {
          const tracking = changeContexts.get(entry.EntryID);
          const projectChanged =
            String(tracking.projectId || '') !== String(entry.ProjectID || '');
          updates = {
            ProjectID: tracking.projectId,
            TaskID: tracking.taskId,
            Billable: tracking.billable,
            HourlyRateSnapshot: projectChanged
              ? (tracking.project ? (parseFloat(tracking.project.HourlyRate) || 0) : 0)
              : (parseFloat(entry.HourlyRateSnapshot) || 0),
            CostRateSnapshot: projectChanged
              ? (tracking.project ? (parseFloat(tracking.project.CostRate) || 0) : 0)
              : (parseFloat(entry.CostRateSnapshot) || 0),
            UpdatedAt: now,
            UpdatedBy: authContext.userId,
            Version: nextVersion
          };
        }

        return { entry, updates };
      });

      // Sheets has no multi-row transaction. Apply the fully validated plan and
      // roll back any already-written records if a later write fails.
      const changedPlans = [];
      try {
        for (const plan of plans) {
          SheetRepository.updateTimeEntry(workspaceId, plan.entry.EntryID, plan.updates);
          changedPlans.push(plan);
        }
      } catch (mutationErr) {
        for (const plan of changedPlans.reverse()) {
          const before = plan.entry;
          try {
            SheetRepository.updateTimeEntry(workspaceId, before.EntryID, {
              ProjectID: before.ProjectID || '',
              TaskID: before.TaskID || '',
              Billable: before.Billable,
              HourlyRateSnapshot: before.HourlyRateSnapshot || 0,
              CostRateSnapshot: before.CostRateSnapshot || 0,
              Status: before.Status || 'ACTIVE',
              Locked: before.Locked === true || before.Locked === 'TRUE' || before.Locked === 1,
              DeletedAt: before.DeletedAt || '',
              DeletedBy: before.DeletedBy || '',
              UpdatedAt: before.UpdatedAt || '',
              UpdatedBy: before.UpdatedBy || '',
              Version: parseInt(before.Version, 10) || 1
            });
          } catch (rollbackErr) {
            console.error(`Bulk action rollback failed for entry ${before.EntryID}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      if (
        typeof RollupService !== 'undefined' &&
        RollupService.rebuildRollups &&
        (normalizedAction === 'DELETE' || normalizedAction === 'CHANGE_PROJECT')
      ) {
        const requiresRebuild = plans.some(plan =>
          !RollupService.mutationAffectsRollups ||
          RollupService.mutationAffectsRollups(
            plan.entry,
            { ...plan.entry, ...plan.updates }
          )
        );
        if (requiresRebuild) {
          RollupService.rebuildRollups(workspaceId);
        }
      }

      return entries.length;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

/* ===== TimerService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Timer Service
 * Authoritative server-side start/stop engine.
 *
 * Invariants:
 * - one active timer per user across every ACTIVE accessible workspace
 * - start/stop mutations execute under ScriptLock
 * - timer start supports client operation-id idempotency without schema changes
 * - each timer maps to one deterministic TimeEntry ID, making stop retries harmless
 */

var TimerService = (typeof global !== 'undefined' && global.TimerService) || {
  _normalizeOperationId(rawOperationId) {
    if (rawOperationId === undefined || rawOperationId === null || rawOperationId === '') {
      return '';
    }
    const value = String(rawOperationId).trim();
    if (
      value.length < 8 ||
      value.length > 128 ||
      !/^[A-Za-z0-9._:-]+$/.test(value)
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'operationId must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen.',
        400
      );
    }
    return value;
  },

  _timerIdForOperation(authContext, workspaceId, operationId) {
    if (!operationId) return '';
    const hash = SecurityService.hashToken(
      'timer:start:' + authContext.userId + ':' + workspaceId + ':' + operationId
    );
    return 'TMR-' + hash.substring(0, 24);
  },

  _entryIdForTimer(timerId) {
    const hash = SecurityService.hashToken('timer:entry:' + String(timerId || ''));
    return 'ENT-' + hash.substring(0, 24);
  },

  _toActiveTimerResponse(workspaceId, active, extras = {}) {
    return {
      timerId: active.TimerID,
      userId: active.UserID,
      workspaceId,
      projectId: active.ProjectID || '',
      taskId: active.TaskID || '',
      description: active.Description || '',
      tagIds: active.TagIDs || '',
      workMode: active.WorkMode || 'OFFICE',
      billable: active.Billable === true || active.Billable === 'TRUE' || active.Billable === 1,
      startedAtUTC: active.StartedAtUTC,
      source: active.Source || CONSTANTS.ENTRY_SOURCE.WEB,
      ...extras
    };
  },

  _findActiveTimerAcrossWorkspaces(authContext) {
    let workspaceIds = [];

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      workspaceIds = MasterRepository.listWorkspaces()
        .filter(ws => ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE)
        .map(ws => ws.WorkspaceID);
    } else {
      workspaceIds = MasterRepository.getWorkspaceAccessForUser(authContext.userId)
        .map(access => access.WorkspaceID)
        .filter(workspaceId => {
          const workspace = MasterRepository.getWorkspace(workspaceId);
          return workspace && workspace.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
        });
    }

    for (const wsId of [...new Set(workspaceIds)]) {
      try {
        const active = SheetRepository.getActiveTimer(wsId, authContext.userId);
        if (active) {
          return { workspaceId: wsId, timer: active };
        }
      } catch (err) {
        // Fail closed. If one ACTIVE workspace cannot be inspected, starting a
        // second timer would risk violating the global one-timer invariant.
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Unable to verify global active-timer state. Please retry.',
          409,
          { workspaceId: wsId, cause: err && err.message ? err.message : String(err) }
        );
      }
    }
    return null;
  },

  _formatWorkspaceLocalTime(workspaceId, date) {
    const ws = MasterRepository.getWorkspace(workspaceId);
    const timezone = ws && ws.Timezone ? ws.Timezone : 'UTC';
    if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
      try {
        return Utilities.formatDate(date, timezone, 'yyyy-MM-dd HH:mm:ss') + ' ' + timezone;
      } catch (e) {}
    }
    return date.toISOString();
  },

  startTimer(authContext, workspaceId, timerPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const operationId = this._normalizeOperationId(timerPayload.operationId);
    const deterministicTimerId = this._timerIdForOperation(
      authContext,
      workspaceId,
      operationId
    );

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Could not acquire lock to start timer. Please retry.',
          409
        );
      }
    }

    try {
      const activeAnywhere = this._findActiveTimerAcrossWorkspaces(authContext);
      if (activeAnywhere) {
        const active = activeAnywhere.timer;

        // Same operation replay while its timer is still active: return the
        // original logical result instead of reporting a conflict.
        if (
          deterministicTimerId &&
          activeAnywhere.workspaceId === workspaceId &&
          active.TimerID === deterministicTimerId
        ) {
          return this._toActiveTimerResponse(workspaceId, active, {
            operationId,
            replayed: true
          });
        }

        throw new AppError(
          ERROR_CODES.ACTIVE_TIMER_EXISTS,
          `An active timer is already running in workspace ${activeAnywhere.workspaceId}. Stop it before starting another timer.`,
          409,
          {
            activeWorkspaceId: activeAnywhere.workspaceId,
            activeTimerId: active.TimerID,
            startedAtUTC: active.StartedAtUTC
          }
        );
      }

      // A delayed/retried start request may arrive after the timer was already
      // stopped. Detect the deterministic completion record and never restart it.
      if (deterministicTimerId) {
        const completedEntryId = this._entryIdForTimer(deterministicTimerId);
        const completedEntry = SheetRepository.getEntryAnyStatus(
          workspaceId,
          completedEntryId
        );
        if (completedEntry && completedEntry.UserID === authContext.userId) {
          if (completedEntry.Status === 'DELETED') {
            throw new AppError(
              ERROR_CODES.CONFLICT,
              'This timer operation exists in a rolled-back state and cannot be restarted with the same operationId.',
              409
            );
          }
          return {
            timerId: deterministicTimerId,
            userId: authContext.userId,
            workspaceId,
            startedAtUTC: completedEntry.StartUTC,
            operationId,
            replayed: true,
            completed: true,
            entryId: completedEntry.EntryID
          };
        }
      }

      const tracking = TrackingPolicyService.validateTrackingContext(
        authContext,
        workspaceId,
        timerPayload,
        { manual: false, enforceRequired: true }
      );

      const source = timerPayload.source || CONSTANTS.ENTRY_SOURCE.WEB;
      const timerId = deterministicTimerId || Validation.generateId('TMR');
      const now = new Date();
      const startedAtUTC = now.toISOString();

      const timerRecord = {
        TimerID: timerId,
        UserID: authContext.userId,
        ProjectID: tracking.projectId,
        TaskID: tracking.taskId,
        Description: tracking.description,
        TagIDs: tracking.tagIdsCsv,
        StartedAtUTC: startedAtUTC,
        StartedAtLocal: this._formatWorkspaceLocalTime(workspaceId, now),
        Billable: tracking.billable ? true : false,
        Source: source,
        LastHeartbeat: startedAtUTC,
        WorkMode: timerPayload.workMode === 'WFH' ? 'WFH' : 'OFFICE'
      };

      SheetRepository.createActiveTimer(workspaceId, timerRecord);

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      SheetRepository.logWorkspaceAudit(workspaceId, {
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'TIMER',
        EntityID: timerId,
        Action: CONSTANTS.AUDIT_EVENTS.TIMER_STARTED,
        AfterJSON: {
          ...timerRecord,
          operationId: operationId || ''
        },
        ClientType: source
      });

      return this._toActiveTimerResponse(workspaceId, timerRecord, {
        operationId: operationId || '',
        replayed: false
      });
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Finalizes an already-resolved active timer while the caller owns ScriptLock.
   * Used by normal timer stop and administrative user deactivation.
   */
  _finalizeActiveTimerLocked(ownerContext, workspaceId, activeTimer, stopPayload = {}, auditActorContext = null) {
    if (!activeTimer) {
      throw new AppError(
        ERROR_CODES.TIMER_NOT_FOUND,
        'No running timer found in this workspace.',
        404
      );
    }

    const now = new Date();
    const startedAtMs = new Date(activeTimer.StartedAtUTC).getTime();
    if (isNaN(startedAtMs)) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'Active timer has an invalid StartedAtUTC value.',
        400
      );
    }

    const elapsedSeconds = Math.max(
      1,
      Math.round((now.getTime() - startedAtMs) / 1000)
    );
    let configuredAutoStop = 0;
    try {
      if (
        typeof Flags !== 'undefined' &&
        Flags.getValue &&
        typeof MasterRepository !== 'undefined' &&
        typeof MasterRepository.getAllGlobalSettingsStrict === 'function'
      ) {
        configuredAutoStop = Number(Flags.getValue('AUTO_STOP_HOURS'));
      }
    } catch (e) {
      configuredAutoStop = 0;
    }
    const effectiveMaxHours =
      configuredAutoStop > 0
        ? Math.min(CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS, configuredAutoStop)
        : CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS;
    const maxSeconds = effectiveMaxHours * 3600;
    const durationSeconds = Math.min(elapsedSeconds, maxSeconds);
    const endUTC = durationSeconds < elapsedSeconds
      ? new Date(startedAtMs + durationSeconds * 1000).toISOString()
      : now.toISOString();

    const mergedTrackingPayload = {
      projectId: stopPayload.projectId !== undefined
        ? stopPayload.projectId
        : activeTimer.ProjectID,
      taskId: stopPayload.taskId !== undefined
        ? stopPayload.taskId
        : activeTimer.TaskID,
      description: stopPayload.description !== undefined
        ? stopPayload.description
        : activeTimer.Description,
      tags: stopPayload.tags !== undefined
        ? stopPayload.tags
        : activeTimer.TagIDs,
      billable: stopPayload.billable !== undefined
        ? stopPayload.billable
        : activeTimer.Billable
    };

    const tracking = TrackingPolicyService.validateTrackingContext(
      ownerContext,
      workspaceId,
      mergedTrackingPayload,
      { manual: false, enforceRequired: false }
    );

    const hourlyRateSnapshot = tracking.project
      ? (parseFloat(tracking.project.HourlyRate) || 0)
      : 0;
    const costRateSnapshot = tracking.project
      ? (parseFloat(tracking.project.CostRate) || 0)
      : 0;

    // One timer has exactly one logical final time entry.
    const entryId = this._entryIdForTimer(activeTimer.TimerID);
    const existingEntry = SheetRepository.getEntryAnyStatus(workspaceId, entryId);

    if (
      existingEntry &&
      existingEntry.UserID !== ownerContext.userId
    ) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Deterministic timer entry ID is already owned by another user.',
        409
      );
    }

    // Repair/idempotency path: entry already exists and is active. Finish the
    // timer deletion only; do not create or roll up a duplicate entry.
    if (existingEntry && existingEntry.Status !== 'DELETED') {
      const deleted = SheetRepository.deleteActiveTimer(
        workspaceId,
        ownerContext.userId
      );
      if (!deleted) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timer finalization could not remove the active timer.',
          409
        );
      }
      return existingEntry;
    }

    const timeEntry = {
      EntryID: entryId,
      UserID: ownerContext.userId,
      ProjectID: tracking.projectId,
      TaskID: tracking.taskId,
      Description: tracking.description,
      Tags: tracking.tagIdsCsv,
      StartUTC: activeTimer.StartedAtUTC,
      EndUTC: endUTC,
      DurationSeconds: durationSeconds,
      Billable:
        tracking.billable === true ||
        tracking.billable === 'TRUE' ||
        tracking.billable === 1,
      HourlyRateSnapshot: hourlyRateSnapshot,
      CostRateSnapshot: costRateSnapshot,
      EntrySource: activeTimer.Source || CONSTANTS.ENTRY_SOURCE.WEB,
      ManualEntry: false,
      Status: 'ACTIVE',
      ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
      TimesheetID: '',
      Locked: false,
      CreatedAt: existingEntry && existingEntry.CreatedAt
        ? existingEntry.CreatedAt
        : endUTC,
      CreatedBy: ownerContext.userId,
      UpdatedAt: endUTC,
      UpdatedBy: ownerContext.userId,
      DeletedAt: '',
      DeletedBy: '',
      Version: existingEntry
        ? (parseInt(existingEntry.Version, 10) || 1) + 1
        : 1,
      WorkMode: (activeTimer && activeTimer.WorkMode === 'WFH') || stopPayload.workMode === 'WFH' ? 'WFH' : 'OFFICE'
    };

    let entryMutated = false;
    try {
      if (existingEntry) {
        SheetRepository.updateTimeEntry(workspaceId, entryId, timeEntry);
      } else {
        SheetRepository.createTimeEntry(workspaceId, timeEntry);
      }
      entryMutated = true;

      const deleted = SheetRepository.deleteActiveTimer(
        workspaceId,
        ownerContext.userId
      );
      if (!deleted) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timer finalization could not remove the active timer.',
          409
        );
      }
    } catch (mutationErr) {
      if (entryMutated) {
        try {
          SheetRepository.updateTimeEntry(workspaceId, entryId, {
            Status: 'DELETED',
            DeletedAt: existingEntry
              ? (existingEntry.DeletedAt || new Date().toISOString())
              : new Date().toISOString(),
            DeletedBy: existingEntry
              ? (existingEntry.DeletedBy || ownerContext.userId)
              : ((auditActorContext && auditActorContext.userId) || ownerContext.userId),
            Version: existingEntry
              ? (parseInt(existingEntry.Version, 10) || 1)
              : timeEntry.Version
          });
        } catch (rollbackErr) {
          console.error(
            `Timer finalization rollback failed for entry ${entryId}: ${rollbackErr.message}`
          );
        }
      }
      throw mutationErr;
    }

    if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
      try { SpreadsheetApp.flush(); } catch (fErr) {}
    }

    try {
      if (
        typeof RollupService !== 'undefined' &&
        RollupService.recordTimeEntry
      ) {
        RollupService.recordTimeEntry(workspaceId, timeEntry);
      }
    } catch (e) {
      console.warn('Rollup calculation notice: ' + e.message);
    }

    const auditActor = auditActorContext || ownerContext;
    SheetRepository.logWorkspaceAudit(workspaceId, {
      ActorUserID: auditActor.userId,
      ActorRole: auditActor.role,
      EntityType: 'TIME_ENTRY',
      EntityID: entryId,
      Action: CONSTANTS.AUDIT_EVENTS.TIMER_STOPPED,
      AfterJSON: timeEntry,
      Reason: stopPayload.reason || '',
      ClientType: activeTimer.Source || 'WEB'
    });

    return timeEntry;
  },

  stopTimer(authContext, workspaceId, stopPayload = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const operationId = this._normalizeOperationId(stopPayload.operationId);
    const requestedTimerId = stopPayload.timerId
      ? String(stopPayload.timerId).trim()
      : '';

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(10000)) {
        throw new AppError(
          ERROR_CODES.SERVER_BUSY,
          'Could not acquire lock to stop timer. Please retry.',
          409
        );
      }
    }

    try {
      const activeTimer = SheetRepository.getActiveTimer(
        workspaceId,
        authContext.userId
      );

      if (!activeTimer) {
        // A retry after a successful stop can return the exact prior entry when
        // the caller includes the timerId it originally received.
        if (requestedTimerId) {
          const existingEntry = SheetRepository.getEntryAnyStatus(
            workspaceId,
            this._entryIdForTimer(requestedTimerId)
          );
          if (
            existingEntry &&
            existingEntry.UserID === authContext.userId
          ) {
            if (existingEntry.Status === 'DELETED') {
              throw new AppError(
                ERROR_CODES.CONFLICT,
                'The previous stop attempt rolled back and no active timer remains. Administrative reconciliation is required.',
                409
              );
            }
            const replayDto = TimeEntryService.toTimeEntryDTO(
              existingEntry,
              authContext.role !== CONSTANTS.ROLES.USER
            );
            replayDto.timerId = requestedTimerId;
            replayDto.operationId = operationId || '';
            replayDto.replayed = true;
            return replayDto;
          }
        }

        throw new AppError(
          ERROR_CODES.TIMER_NOT_FOUND,
          'No running timer found in this workspace.',
          404
        );
      }

      if (
        requestedTimerId &&
        activeTimer.TimerID !== requestedTimerId
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'The supplied timerId does not match the currently active timer.',
          409
        );
      }

      const timeEntry = this._finalizeActiveTimerLocked(
        authContext,
        workspaceId,
        activeTimer,
        stopPayload
      );

      const dto = TimeEntryService.toTimeEntryDTO(
        timeEntry,
        authContext.role !== CONSTANTS.ROLES.USER
      );
      dto.timerId = activeTimer.TimerID;
      dto.operationId = operationId || '';
      dto.replayed = false;
      return dto;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  getActiveTimer(authContext, workspaceId) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    const active = SheetRepository.getActiveTimer(
      workspaceId,
      authContext.userId
    );
    if (!active) return null;

    const startedAtMs = new Date(active.StartedAtUTC).getTime();
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.now() - startedAtMs) / 1000)
    );

    let configuredAutoStop = 0;
    try {
      if (
        typeof Flags !== 'undefined' &&
        Flags.getValue &&
        typeof MasterRepository !== 'undefined' &&
        typeof MasterRepository.getAllGlobalSettingsStrict === 'function'
      ) {
        configuredAutoStop = Number(Flags.getValue('AUTO_STOP_HOURS'));
      }
    } catch (e) {
      configuredAutoStop = 0;
    }
    const effectiveMaxHours =
      configuredAutoStop > 0
        ? Math.min(CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS, configuredAutoStop)
        : CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS;
    const maxSeconds = effectiveMaxHours * 3600;

    return {
      ...this._toActiveTimerResponse(workspaceId, active),
      elapsedSeconds,
      maxAllowedSeconds: maxSeconds,
      isOvertime: elapsedSeconds >= maxSeconds
    };
  },

  /**
   * Scans active workspaces for runaway timers exceeding AUTO_STOP_HOURS and
   * finalizes them into completed TimeEntry records clamped to the maximum duration.
   */
  autoStopRunawayTimers(asOfDate = new Date()) {
    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(15000)) {
        return { stoppedCount: 0, skipped: true, reason: 'LOCK_UNAVAILABLE' };
      }
    }

    let configuredAutoStop = 0;
    try {
      if (
        typeof Flags !== 'undefined' &&
        Flags.getValue &&
        typeof MasterRepository !== 'undefined' &&
        typeof MasterRepository.getAllGlobalSettingsStrict === 'function'
      ) {
        configuredAutoStop = Number(Flags.getValue('AUTO_STOP_HOURS'));
      }
    } catch (e) {
      configuredAutoStop = 0;
    }
    const effectiveMaxHours =
      configuredAutoStop > 0
        ? Math.min(CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS, configuredAutoStop)
        : CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS;
    const maxMs = effectiveMaxHours * 3600 * 1000;
    const nowMs = asOfDate.getTime();

    let stoppedCount = 0;
    try {
      const activeWorkspaces = (MasterRepository.listWorkspaces && MasterRepository.listWorkspaces()) ||
        (MasterRepository.getAllWorkspaces && MasterRepository.getAllWorkspaces()) || [];
      for (const ws of activeWorkspaces) {
        if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) continue;
        try {
          const timers = SheetRepository.listActiveTimers(ws.WorkspaceID) || [];
          for (const timer of timers) {
            const startedAtMs = new Date(timer.StartedAtUTC).getTime();
            if (isNaN(startedAtMs)) continue;
            if (nowMs - startedAtMs >= maxMs) {
              const account = MasterRepository.getAccount(timer.UserID);
              const ownerContext = {
                userId: timer.UserID,
                email: (account && account.Email) || 'unknown@user',
                role: (account && account.Role) || CONSTANTS.ROLES.USER,
                isOwner: false,
                allowedWorkspaces: [ws.WorkspaceID]
              };
              const systemAuditContext = {
                userId: 'SYSTEM',
                email: 'system@flink.local',
                role: CONSTANTS.ROLES.SUPER_ADMIN,
                isOwner: true
              };
              try {
                this._finalizeActiveTimerLocked(
                  ownerContext,
                  ws.WorkspaceID,
                  timer,
                  { reason: 'AUTO_STOP_RUNAWAY' },
                  systemAuditContext
                );
                stoppedCount++;
              } catch (finErr) {
                console.error(`Auto-stop failed for timer ${timer.TimerID} in workspace ${ws.WorkspaceID}: ${finErr.message}`);
              }
            }
          }
        } catch (wsErr) {
          console.error(`Auto-stop failed checking workspace ${ws.WorkspaceID}: ${wsErr.message}`);
        }
      }
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
    return { stoppedCount };
  }
};

/* ===== TimesheetService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Timesheet Service
 * Manages weekly matrix generation, empty timesheet protection,
 * and user submission into the approval queue.
 */

var TimesheetService = (typeof global !== 'undefined' && global.TimesheetService) || {
  _assertTransition(fromStatus, toStatus) {
    const from = String(fromStatus || '').toUpperCase();
    const to = String(toStatus || '').toUpperCase();
    const allowed = (CONSTANTS.TIMESHEET_TRANSITIONS &&
      CONSTANTS.TIMESHEET_TRANSITIONS[from]) || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `Invalid timesheet state transition: ${from || 'UNKNOWN'} -> ${to || 'UNKNOWN'}.`,
        409
      );
    }
    return true;
  },

  _buildSubmissionSnapshot(entries) {
    const seen = new Set();
    return entries.map(entry => {
      const entryId = String(entry.EntryID || '');
      if (!entryId || seen.has(entryId)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet contains duplicate or missing entry IDs and cannot be submitted.',
          409
        );
      }
      seen.add(entryId);

      const nextVersion = (parseInt(entry.Version, 10) || 1) + 1;
      return {
        entryId,
        version: nextVersion,
        startUtc: entry.StartUTC || '',
        endUtc: entry.EndUTC || '',
        durationSeconds: parseInt(entry.DurationSeconds, 10) || 0,
        projectId: entry.ProjectID || '',
        taskId: entry.TaskID || '',
        billable: entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1,
        hourlyRateSnapshot: parseFloat(entry.HourlyRateSnapshot) || 0,
        costRateSnapshot: parseFloat(entry.CostRateSnapshot) || 0
      };
    });
  },

  _restoreTimesheetHeader(workspaceId, timesheet) {
    SheetRepository.updateTimesheet(workspaceId, timesheet.TimesheetID, {
      UserID: timesheet.UserID,
      PeriodStart: timesheet.PeriodStart,
      PeriodEnd: timesheet.PeriodEnd,
      TotalSeconds: parseInt(timesheet.TotalSeconds, 10) || 0,
      Status: timesheet.Status,
      SubmittedAt: timesheet.SubmittedAt || '',
      ReviewedBy: timesheet.ReviewedBy || '',
      ReviewedAt: timesheet.ReviewedAt || '',
      ReviewComment: timesheet.ReviewComment || '',
      LockedAt: timesheet.LockedAt || '',
      EntrySnapshotJSON: timesheet.EntrySnapshotJSON || ''
    });
  },

  _resolveWeek(workspaceId, dateStr) {
    if (!dateStr) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid week date.');
    }
    const bounds = TimezoneService.getWeekBounds(workspaceId, dateStr);
    return {
      startDate: bounds.startUtc,
      endDate: bounds.endUtc,
      startLocalDate: bounds.startLocalDate,
      endLocalDate: bounds.endLocalDate,
      dayLabels: bounds.dayLabels,
      timezone: bounds.timezone
    };
  }, 

  _findCanonicalTimesheet(timesheets, startDate, endDate) {
    const startMs = startDate.getTime();
    const endMs = endDate.getTime();
    const exact = [];
    const overlaps = [];

    for (const ts of timesheets || []) {
      const tsStart = new Date(ts.PeriodStart).getTime();
      const tsEnd = new Date(ts.PeriodEnd).getTime();
      if (!Number.isFinite(tsStart) || !Number.isFinite(tsEnd) || tsEnd < tsStart) {
        continue;
      }

      const isExact = tsStart === startMs && tsEnd === endMs;
      if (isExact) {
        exact.push(ts);
        continue;
      }

      if (tsStart <= endMs && tsEnd >= startMs) {
        overlaps.push(ts);
      }
    }

    if (exact.length > 1) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Multiple timesheets exist for the same canonical week. Administrative repair is required.',
        409
      );
    }
    if (overlaps.length > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'An existing timesheet overlaps this canonical workspace week. Administrative repair is required before submission.',
        409
      );
    }

    return exact[0] || null;
  },

  /**
   * Generates weekly timesheet grid data for a user and date
   */
  getWeeklyTimesheet(authContext, workspaceId, targetUserId, weekStartDateStr) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const userId = (authContext.role === CONSTANTS.ROLES.USER) ? authContext.userId : (targetUserId || authContext.userId);

    // Treat the supplied date as "a date in the requested week"; the server
    // resolves the actual configured week boundary.
    const { startDate, endDate, startLocalDate, endLocalDate, dayLabels, timezone } =
      this._resolveWeek(workspaceId, weekStartDateStr);

    const startIso = startDate.toISOString();
    const endIso = endDate.toISOString();

    const entries = SheetRepository.listTimeEntries(workspaceId, {
      userId,
      startDate: startIso,
      endDate: endIso
    });

    // Check existing timesheet record
    const timesheets = SheetRepository.listTimesheets(workspaceId, { userId });
    const existingTimesheet = this._findCanonicalTimesheet(
      timesheets,
      startDate,
      endDate
    );

    // Build project/task matrix
    const matrixMap = {};
    const dailyTotalsSeconds = [0, 0, 0, 0, 0, 0, 0];
    let totalSeconds = 0;

    for (const entry of entries) {
      const pId = entry.ProjectID || 'unassigned';
      const tId = entry.TaskID || 'none';
      const key = `${pId}__${tId}`;

      if (!matrixMap[key]) {
        matrixMap[key] = {
          projectId: pId,
          taskId: tId,
          days: [0, 0, 0, 0, 0, 0, 0],
          totalSeconds: 0
        };
      }

      const entryLocalDate = TimezoneService.formatDateKey(workspaceId, entry.StartUTC);
      const dayDiff = TimezoneService.diffLocalDateDays(startLocalDate, entryLocalDate);
      const dayIdx = Math.max(0, Math.min(6, dayDiff));
      const secs = parseInt(entry.DurationSeconds, 10) || 0;

      matrixMap[key].days[dayIdx] += secs;
      matrixMap[key].totalSeconds += secs;
      dailyTotalsSeconds[dayIdx] += secs;
      totalSeconds += secs;
    }

    const projects = SheetRepository.listProjects(workspaceId);
    const tasks = SheetRepository.listTasks(workspaceId);
    const projectMap = {};
    const taskMap = {};
    projects.forEach(p => { projectMap[p.ProjectID] = p.ProjectName; });
    tasks.forEach(t => { taskMap[t.TaskID] = t.TaskName; });

    const rows = Object.values(matrixMap).map(row => ({
      ...row,
      projectName: projectMap[row.projectId] || (row.projectId === 'unassigned' ? 'Unassigned' : row.projectId),
      taskName: taskMap[row.taskId] || (row.taskId === 'none' ? '' : row.taskId)
    }));

    return {
      userId,
      workspaceId,
      periodStart: startIso,
      periodEnd: endIso,
      periodStartLocal: startLocalDate,
      periodEndLocal: endLocalDate,
      timezone,
      dayLabels,
      totalSeconds,
      totalHours: +(totalSeconds / 3600).toFixed(2),
      dailyTotalsSeconds,
      rows,
      timesheet: existingTimesheet,
      status: existingTimesheet ? existingTimesheet.Status : CONSTANTS.TIMESHEET_STATUS.OPEN
    };
  },

  /**
   * Manager/Super Admin queue view for one authorized workspace.
   */
  listTimesheetsForManager(authContext, workspaceId, statusFilter = null) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [
      CONSTANTS.ROLES.SUPER_ADMIN,
      CONSTANTS.ROLES.ADMIN
    ]);

    const normalizedStatus = statusFilter
      ? String(statusFilter).toUpperCase()
      : '';
    if (
      normalizedStatus &&
      !Object.values(CONSTANTS.TIMESHEET_STATUS).includes(normalizedStatus)
    ) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        `Invalid timesheet status filter: ${normalizedStatus}.`,
        400
      );
    }

    const rows = SheetRepository.listTimesheets(
      workspaceId,
      normalizedStatus ? { status: normalizedStatus } : {}
    );
    const members = SheetRepository.listMembers(workspaceId);
    const names = {};
    members.forEach(member => {
      names[member.UserID] = member.DisplayName || member.UserID;
    });

    return rows
      .map(ts => ({
        timesheetId: ts.TimesheetID,
        userId: ts.UserID,
        userName: names[ts.UserID] || ts.UserID,
        periodStart: ts.PeriodStart,
        periodEnd: ts.PeriodEnd,
        totalSeconds: parseInt(ts.TotalSeconds, 10) || 0,
        status: ts.Status,
        submittedAt: ts.SubmittedAt || '',
        reviewedBy: ts.ReviewedBy || '',
        reviewedAt: ts.ReviewedAt || '',
        reviewComment: ts.ReviewComment || ''
      }))
      .sort((a, b) =>
        String(b.submittedAt || b.periodEnd || '').localeCompare(
          String(a.submittedAt || a.periodEnd || '')
        )
      );
  },

  /**
   * Submits a weekly timesheet for review with atomic state transition under LockService
   */
  submitTimesheet(authContext, workspaceId, payload) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    Validation.assertRequired(payload, ['periodStart', 'periodEnd']);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to submit timesheet. Please retry.', 409);
      }
    }

    try {
      const userId = authContext.userId;
      const requestedStart = new Date(payload.periodStart);
      const requestedEnd = new Date(payload.periodEnd);
      if (
        isNaN(requestedStart.getTime()) ||
        isNaN(requestedEnd.getTime()) ||
        requestedEnd.getTime() < requestedStart.getTime()
      ) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A valid timesheet periodStart and periodEnd are required.');
      }

      // Canonicalize the period on the server. Clients may submit only one exact
      // configured workspace week; arbitrary/overlapping partial ranges are rejected.
      const expectedWeek = TimezoneService.getWeekBounds(workspaceId, requestedStart);
      const startDate = expectedWeek.startUtc;
      const endDate = expectedWeek.endUtc;
      if (
        requestedStart.getTime() !== startDate.getTime() ||
        requestedEnd.getTime() !== endDate.getTime()
      ) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Timesheet period must match the configured workspace week (${expectedWeek.startLocalDate} to ${expectedWeek.endLocalDate}, ${expectedWeek.timezone}).`,
          400
        );
      }

      const startIso = startDate.toISOString();
      const endIso = endDate.toISOString();

      const entries = SheetRepository.listTimeEntries(workspaceId, {
        userId,
        startDate: startIso,
        endDate: endIso
      });

      let totalSeconds = 0;
      for (const e of entries) {
        totalSeconds += parseInt(e.DurationSeconds, 10) || 0;
      }

      // Rejection of empty timesheet
      if (totalSeconds <= 0 || entries.length === 0) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Cannot submit an empty timesheet with 0 hours.');
      }

      // A user may have at most one record for this exact canonical week, and
      // no other period may overlap it.
      const existingTimesheets = SheetRepository.listTimesheets(workspaceId, { userId });
      const existing = this._findCanonicalTimesheet(
        existingTimesheets,
        startDate,
        endDate
      );

      const currentStatus = existing
        ? String(existing.Status || '').toUpperCase()
        : CONSTANTS.TIMESHEET_STATUS.OPEN;
      this._assertTransition(currentStatus, CONSTANTS.TIMESHEET_STATUS.SUBMITTED);

      const now = new Date().toISOString();
      const timesheetId = existing ? existing.TimesheetID : Validation.generateId('TMS');

      for (const entry of entries) {
        const isLocked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
        const isApproved = entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.APPROVED;
        const belongsToOtherSubmission =
          entry.ApprovalStatus === CONSTANTS.TIMESHEET_STATUS.SUBMITTED &&
          entry.TimesheetID &&
          entry.TimesheetID !== timesheetId;
        if (isLocked || isApproved || belongsToOtherSubmission) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Time entry ${entry.EntryID} is already locked or belongs to another submitted/approved timesheet.`,
            409
          );
        }
      }

      const entrySnapshot = this._buildSubmissionSnapshot(entries);
      const snapshotTotalSeconds = entrySnapshot.reduce(
        (sum, item) => sum + item.durationSeconds,
        0
      );
      if (snapshotTotalSeconds !== totalSeconds) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet snapshot total does not match the selected entries.',
          409
        );
      }

      const tsData = {
        TimesheetID: timesheetId,
        UserID: userId,
        PeriodStart: startIso,
        PeriodEnd: endIso,
        TotalSeconds: totalSeconds,
        Status: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
        SubmittedAt: now,
        ReviewedBy: '',
        ReviewedAt: '',
        ReviewComment: '',
        LockedAt: '',
        EntrySnapshotJSON: JSON.stringify(entrySnapshot)
      };

      // Sheets has no multi-row transaction primitive. Mutate the member entries first,
      // remember their exact previous state, then commit the timesheet header last.
      // If any write fails, roll entries back best-effort before surfacing the error.
      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousState = {
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus || CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: parseInt(entry.Version, 10) || 1
          };
          // Register compensation state before the write so even a partially
          // applied Sheet mutation that throws can be restored.
          changedEntries.push(previousState);
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.SUBMITTED,
            Locked: true,
            Version: previousState.Version + 1,
            UpdatedAt: now,
            UpdatedBy: authContext.userId
          });
        }

        headerAttempted = true;
        if (existing) {
          SheetRepository.updateTimesheet(workspaceId, existing.TimesheetID, tsData);
        } else {
          SheetRepository.createTimesheet(workspaceId, tsData);
        }
      } catch (mutationErr) {
        if (headerAttempted) {
          try {
            if (existing) {
              this._restoreTimesheetHeader(workspaceId, existing);
            } else {
              SheetRepository.deleteTimesheet(workspaceId, timesheetId);
            }
          } catch (headerRollbackErr) {
            console.error('Submission header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version
            });
          } catch (rollbackErr) {
            console.error(`Submission rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_SUBMITTED,
          AfterJSON: tsData
        });
      } catch (auditErr) {
        console.error('Timesheet submission audit failed after commit: ' + auditErr.message);
      }

      return tsData;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

/* ===== ApprovalService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Approval Service
 * Governs timesheet reviews (approve / reject with mandatory comments),
 * entry locking, immutable approval history, and Super Admin reopen override.
 */

var ApprovalService = (typeof global !== 'undefined' && global.ApprovalService) || {
  /**
   * Resolve the exact entry membership captured at submission time.
   * Legacy submitted sheets without a snapshot fall back only to entries already
   * carrying the same TimesheetID; never to unassigned entries in the date range.
   */
  _assertTransition(fromStatus, toStatus) {
    const from = String(fromStatus || '').toUpperCase();
    const to = String(toStatus || '').toUpperCase();
    const allowed = (CONSTANTS.TIMESHEET_TRANSITIONS &&
      CONSTANTS.TIMESHEET_TRANSITIONS[from]) || [];
    if (!allowed.includes(to)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `Invalid timesheet state transition: ${from || 'UNKNOWN'} -> ${to || 'UNKNOWN'}.`,
        409
      );
    }
    return true;
  },

  _restoreTimesheetHeader(workspaceId, timesheet) {
    SheetRepository.updateTimesheet(workspaceId, timesheet.TimesheetID, {
      Status: timesheet.Status,
      SubmittedAt: timesheet.SubmittedAt || '',
      ReviewedBy: timesheet.ReviewedBy || '',
      ReviewedAt: timesheet.ReviewedAt || '',
      ReviewComment: timesheet.ReviewComment || '',
      LockedAt: timesheet.LockedAt || '',
      EntrySnapshotJSON: timesheet.EntrySnapshotJSON || '',
      TotalSeconds: parseInt(timesheet.TotalSeconds, 10) || 0
    });
  },

  /**
   * Resolve and verify the exact immutable entry membership captured at submission.
   * Missing snapshots fail closed: pre-snapshot legacy submissions must be reopened
   * and resubmitted rather than approved from an unverifiable date range.
   */
  _resolveSubmissionEntries(workspaceId, timesheet) {
    if (!timesheet.EntrySnapshotJSON) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet has no immutable submission snapshot. Reopen and resubmit it before review.',
        409
      );
    }

    let snapshot;
    try {
      snapshot = JSON.parse(timesheet.EntrySnapshotJSON);
    } catch (e) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet submission snapshot is malformed.', 409);
    }
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Timesheet submission snapshot is empty or invalid.', 409);
    }

    const snapshotIds = new Set();
    const entries = [];
    let snapshotTotalSeconds = 0;

    for (const item of snapshot) {
      const entryId = String(item && item.entryId || '');
      if (!entryId || snapshotIds.has(entryId)) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Timesheet submission snapshot contains duplicate or missing entry IDs.',
          409
        );
      }
      snapshotIds.add(entryId);

      const entry = SheetRepository.getEntry(workspaceId, entryId);
      if (!entry) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} no longer exists.`, 409);
      }
      if (entry.UserID !== timesheet.UserID) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} belongs to another user.`, 409);
      }
      if (entry.TimesheetID !== timesheet.TimesheetID) {
        throw new AppError(ERROR_CODES.CONFLICT, `Submitted entry ${entryId} is no longer bound to this timesheet.`, 409);
      }

      const currentBillable =
        entry.Billable === true || entry.Billable === 'TRUE' || entry.Billable === 1;
      const snapshotBillable =
        item.billable === true || item.billable === 'TRUE' || item.billable === 1;

      const comparisons = [
        ['version', parseInt(entry.Version, 10) || 1, parseInt(item.version, 10) || 1],
        ['duration', parseInt(entry.DurationSeconds, 10) || 0, parseInt(item.durationSeconds, 10) || 0],
        ['start', String(entry.StartUTC || ''), String(item.startUtc || '')],
        ['end', String(entry.EndUTC || ''), String(item.endUtc || '')],
        ['project', String(entry.ProjectID || ''), String(item.projectId || '')],
        ['task', String(entry.TaskID || ''), String(item.taskId || '')],
        ['billable', currentBillable, snapshotBillable],
        ['hourly rate', Number(entry.HourlyRateSnapshot || 0), Number(item.hourlyRateSnapshot || 0)],
        ['cost rate', Number(entry.CostRateSnapshot || 0), Number(item.costRateSnapshot || 0)]
      ];
      const mismatch = comparisons.find(([, current, submitted]) => current !== submitted);
      if (mismatch) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Submitted entry ${entryId} changed after submission (${mismatch[0]} mismatch). Reopen/resubmit before review.`,
          409
        );
      }

      snapshotTotalSeconds += parseInt(item.durationSeconds, 10) || 0;
      entries.push(entry);
    }

    if (snapshotTotalSeconds !== (parseInt(timesheet.TotalSeconds, 10) || 0)) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet total no longer matches its immutable submission snapshot.',
        409
      );
    }

    // Detect any extra entry bound to the same timesheet but omitted from the
    // snapshot. Membership must be exact in both directions.
    const boundEntries = SheetRepository.listTimeEntries(workspaceId, {
      userId: timesheet.UserID,
      startDate: timesheet.PeriodStart,
      endDate: timesheet.PeriodEnd
    }).filter(entry => entry.TimesheetID === timesheet.TimesheetID);

    const boundIds = new Set(boundEntries.map(entry => String(entry.EntryID || '')));
    if (
      boundIds.size !== snapshotIds.size ||
      [...boundIds].some(id => !snapshotIds.has(id))
    ) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'Timesheet entry membership changed after submission. Reopen/resubmit before review.',
        409
      );
    }

    return entries;
  },

  /**
   * Admin or Super Admin approves a submitted timesheet
   */
  /**
   * Admin or Super Admin approves a submitted timesheet inside LockService critical section
   */
  approveTimesheet(authContext, workspaceId, timesheetId, comment = '') {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to approve timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);

      if (timesheet.UserID === authContext.userId) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'Self-approval is forbidden. Timesheets must be approved by another administrator.',
          403
        );
      }

      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.APPROVED
      );

      const now = new Date().toISOString();
      const cleanComment = comment ? Validation.sanitizeCellValue(comment) : 'Approved';

      // Resolve and validate the immutable submission membership BEFORE mutating
      // the timesheet header. This prevents an APPROVED header with invalid entries.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in SUBMITTED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: parseInt(entry.Version, 10) || 1,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: timesheetId,
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.APPROVED,
            Locked: true
          });
        }

        headerAttempted = true;
        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.APPROVED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment,
          LockedAt: now
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Approval header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Approval rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'APPROVED',
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          TimestampUTC: now,
          Comment: cleanComment,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_APPROVED,
          Reason: cleanComment
        });
      } catch (auditErr) {
        console.error('Approval audit failed after committed state transition: ' + auditErr.message);
      }

      return updatedTimesheet;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Admin or Super Admin rejects a submitted timesheet with required comments inside LockService critical section
   */
  rejectTimesheet(authContext, workspaceId, timesheetId, reasonComment) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN, CONSTANTS.ROLES.ADMIN]);

    if (!reasonComment || !reasonComment.trim()) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A comment explaining the rejection is required.');
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to reject timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.REJECTED
      );

      const now = new Date().toISOString();
      const cleanComment = Validation.sanitizeCellValue(reasonComment.trim());

      // Validate exact submission membership before changing the header state.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.SUBMITTED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in SUBMITTED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousVersion = parseInt(entry.Version, 10) || 1;
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: previousVersion,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: '',
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.REJECTED,
            Locked: false,
            Version: previousVersion + 1,
            UpdatedAt: now,
            UpdatedBy: authContext.userId
          });
        }

        headerAttempted = true;
        var updatedTimesheet = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.REJECTED,
          ReviewedBy: authContext.userId,
          ReviewedAt: now,
          ReviewComment: cleanComment,
          LockedAt: '',
          EntrySnapshotJSON: ''
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Rejection header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Rejection rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'REJECTED',
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          TimestampUTC: now,
          Comment: cleanComment,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext.userId,
          ActorRole: authContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_REJECTED,
          Reason: cleanComment
        });
      } catch (auditErr) {
        console.error('Rejection audit failed after committed state transition: ' + auditErr.message);
      }

      return updatedTimesheet;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Super Admin override to reopen an already approved timesheet inside LockService critical section
   */
  reopenTimesheet(superAdminContext, workspaceId, timesheetId, reason) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    AuthorizationService.assertWorkspaceAccess(superAdminContext, workspaceId);
    if (!reason || !String(reason).trim()) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        'A reason is required when reopening an approved timesheet.',
        400
      );
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      const hasLock = scriptLock.tryLock(15000);
      if (!hasLock) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire lock to reopen timesheet. Please retry.', 409);
      }
    }

    try {
      const timesheet = SheetRepository.getTimesheet(workspaceId, timesheetId);
      if (!timesheet) throw new AppError(ERROR_CODES.NOT_FOUND, `Timesheet ${timesheetId} not found.`);
      this._assertTransition(
        timesheet.Status,
        CONSTANTS.TIMESHEET_STATUS.OPEN
      );

      const now = new Date().toISOString();
      const cleanReason = Validation.sanitizeCellValue(String(reason).trim());

      // Resolve the original immutable membership while the header is still APPROVED.
      const entries = this._resolveSubmissionEntries(workspaceId, timesheet);
      for (const entry of entries) {
        if (entry.ApprovalStatus !== CONSTANTS.TIMESHEET_STATUS.APPROVED) {
          throw new AppError(
            ERROR_CODES.CONFLICT,
            `Entry ${entry.EntryID} is not in APPROVED state.`,
            409
          );
        }
      }

      const changedEntries = [];
      let headerAttempted = false;
      try {
        for (const entry of entries) {
          const previousVersion = parseInt(entry.Version, 10) || 1;
          changedEntries.push({
            entryId: entry.EntryID,
            TimesheetID: entry.TimesheetID || '',
            ApprovalStatus: entry.ApprovalStatus,
            Locked: entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1,
            Version: previousVersion,
            UpdatedAt: entry.UpdatedAt || '',
            UpdatedBy: entry.UpdatedBy || ''
          });
          SheetRepository.updateTimeEntry(workspaceId, entry.EntryID, {
            TimesheetID: '',
            ApprovalStatus: CONSTANTS.TIMESHEET_STATUS.OPEN,
            Locked: false,
            Version: previousVersion + 1,
            UpdatedAt: now,
            UpdatedBy: superAdminContext.userId
          });
        }

        headerAttempted = true;
        var updated = SheetRepository.updateTimesheet(workspaceId, timesheetId, {
          Status: CONSTANTS.TIMESHEET_STATUS.OPEN,
          ReviewedBy: '',
          ReviewedAt: '',
          ReviewComment: '',
          LockedAt: '',
          EntrySnapshotJSON: ''
        });
      } catch (mutationErr) {
        if (headerAttempted) {
          try { this._restoreTimesheetHeader(workspaceId, timesheet); }
          catch (headerRollbackErr) {
            console.error('Reopen header rollback failed: ' + headerRollbackErr.message);
          }
        }
        for (const prior of changedEntries.reverse()) {
          try {
            SheetRepository.updateTimeEntry(workspaceId, prior.entryId, {
              TimesheetID: prior.TimesheetID,
              ApprovalStatus: prior.ApprovalStatus,
              Locked: prior.Locked,
              Version: prior.Version,
              UpdatedAt: prior.UpdatedAt,
              UpdatedBy: prior.UpdatedBy
            });
          } catch (rollbackErr) {
            console.error(`Reopen rollback failed for entry ${prior.entryId}: ${rollbackErr.message}`);
          }
        }
        throw mutationErr;
      }

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      try {
        SheetRepository.logApproval(workspaceId, {
          ApprovalID: Validation.generateId('APP'),
          TimesheetID: timesheetId,
          UserID: timesheet.UserID,
          Action: 'REOPENED',
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          TimestampUTC: now,
          Comment: cleanReason,
          SnapshotTotalSeconds: timesheet.TotalSeconds
        });
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          EntityType: 'TIMESHEET',
          EntityID: timesheetId,
          Action: CONSTANTS.AUDIT_EVENTS.TIMESHEET_REOPENED,
          Reason: cleanReason
        });
      } catch (auditErr) {
        console.error('Reopen audit failed after committed state transition: ' + auditErr.message);
      }

      return updated;
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

/* ===== ReportService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Clockify-Class Reporting Engine
 * Supports 3-level nested grouping Summary Reports, Detailed Reports,
 * Weekly User Matrix, Attendance/Utilization, Project Budgets, and Anomaly Detection.
 */

var ReportService = (typeof global !== 'undefined' && global.ReportService) || {
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

/* ===== RollupService.gs ===== */
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

var RollupService = (typeof global !== 'undefined' && global.RollupService) || {
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
      if (rows.length > 0) {
        if (SheetRepository.appendRows) {
          SheetRepository.appendRows(workspaceId, tab, rows);
        } else {
          for (const row of rows) {
            SheetRepository.appendRow(workspaceId, tab, row);
          }
        }
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

/* ===== DashboardService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Dashboard Service
 * Dashboard values are correctness-first: current-day/week totals are derived
 * from raw active TimeEntries in the workspace timezone, while live workforce
 * status comes from ActiveTimers.
 */

var DashboardService = (typeof global !== 'undefined' && global.DashboardService) || {
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
    const periodSummaries = [];

    for (const ws of targets) {
      try {
        const totals = this._workspaceCurrentTotals(
          authContext,
          ws.WorkspaceID,
          new Date()
        );
        totalTrackedSecondsToday += totals.todaySeconds;
        totalTrackedSecondsThisWeek += totals.weekSeconds;
        periodSummaries.push({
          workspaceId: ws.WorkspaceID,
          businessDate: totals.today,
          weekStart: totals.weekStart,
          weekEnd: totals.weekEnd
        });

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
      currentBusinessDate:
        periodSummaries.length === 1 ? periodSummaries[0].businessDate : '',
      currentWeekStart:
        periodSummaries.length === 1 ? periodSummaries[0].weekStart : '',
      currentWeekEnd:
        periodSummaries.length === 1 ? periodSummaries[0].weekEnd : '',
      workspacePeriods: periodSummaries,
      pendingApprovalsCount,
      pendingRequestsCount
    };
  }
};

/* ============================================================ */

/** FLINK Time — Consolidated user lifecycle, setup, admin requests, integrity, jobs, backup/audit, export, and migration services. */


/* ===== UserService.gs ===== */
/**
 * FLINK Time & Workforce Platform — User Service
 * Dedicated to Super Admin global user management, status transitions,
 * password generation, and cross-workspace membership registration.
 */

var UserService = (typeof global !== 'undefined' && global.UserService) || {
  _toUserDTO(user, assignedWorkspaceIds = [], detailLevel = 'SELF') {
    if (!user) return null;

    const dto = {
      UserID: user.UserID,
      Username: user.Username,
      DisplayName: user.DisplayName,
      Role: user.Role,
      Status: user.Status,
      PrimaryWorkspaceID: user.PrimaryWorkspaceID || '',
      Email: user.Email || '',
      EmployeeCode: user.EmployeeCode || '',
      AssignedWorkspaceIDs: Array.isArray(assignedWorkspaceIds)
        ? assignedWorkspaceIds
        : []
    };

    if (detailLevel === 'SUPER_ADMIN') {
      dto.CreatedAt = user.CreatedAt || '';
      dto.CreatedBy = user.CreatedBy || '';
      dto.UpdatedAt = user.UpdatedAt || '';
      dto.UpdatedBy = user.UpdatedBy || '';
      dto.LastLoginAt = user.LastLoginAt || '';
      dto.MustChangePassword =
        user.MustChangePassword === true || user.MustChangePassword === 'TRUE';
      dto.Version = parseInt(user.Version, 10) || 1;
    }

    return dto;
  },

  /**
   * Super Admin creates a new user account with initial salted credentials
   */
  createUser(superAdminContext, userPayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(
      userPayload,
      ['username', 'displayName', 'role', 'email']
    );

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const username = Validation.validateUsername(userPayload.username);
      const role = Validation.validateRole(userPayload.role);
      if (role === CONSTANTS.ROLES.SUPER_ADMIN) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'SUPER_ADMIN accounts cannot be created through generic user CRUD.',
          403
        );
      }
      const displayName = Validation.sanitizeCellValue(userPayload.displayName.trim());
      const email = Validation.validateEmail(userPayload.email);
      const primaryWorkspaceId = userPayload.primaryWorkspaceId || '';

      // Verify username uniqueness inside lock
      const existing = MasterRepository.findAccountByUsername(username);
      if (existing) {
        throw new AppError(ERROR_CODES.CONFLICT, `Username '${username}' is already taken.`);
      }

      // Verify email uniqueness inside lock
      if (typeof MasterRepository.findAccountByEmail === 'function') {
        const existingEmail = MasterRepository.findAccountByEmail(email);
        if (existingEmail) {
          throw new AppError(ERROR_CODES.CONFLICT, `Email '${email}' is already registered to another account.`);
        }
      }

      const userId = Validation.generateId('USR');
      const temporaryPassword = userPayload.temporaryPassword || userPayload.password || SecurityService.generateTemporaryPassword();
      Validation.validatePassword(temporaryPassword);

      if (primaryWorkspaceId) {
        const primaryWorkspace = MasterRepository.getWorkspace(primaryWorkspaceId);
        if (!primaryWorkspace) {
          throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${primaryWorkspaceId}' does not exist.`, 404);
        }
        if (primaryWorkspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          throw new AppError(
            ERROR_CODES.WORKSPACE_DENIED,
            `Workspace '${primaryWorkspaceId}' is not active (${primaryWorkspace.Status}).`,
            403
          );
        }
      }

      const passwordHash = SecurityService.hashPassword(temporaryPassword);
      const nowDate = new Date();
      const now = nowDate.toISOString();
      const initialPasswordExpiresAt = new Date(
        nowDate.getTime() +
        (CONSTANTS.LIMITS.INITIAL_PASSWORD_TTL_HOURS || 24) * 60 * 60 * 1000
      ).toISOString();

      const accountRecord = {
        UserID: userId,
        Username: username,
        DisplayName: displayName,
        Role: role,
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        PrimaryWorkspaceID: primaryWorkspaceId,
        Email: email,
        CreatedAt: now,
        CreatedBy: superAdminContext.userId,
        UpdatedAt: now,
        UpdatedBy: superAdminContext.userId,
        LastLoginAt: '',
        MustChangePassword: true
      };

      const credentialRecord = {
        UserID: userId,
        PasswordHash: passwordHash,
        PasswordVersion: 1,
        PasswordChangedAt: now,
        FailedLoginCount: 0,
        LockUntil: '',
        ResetIssuedAt: now,
        ResetExpiresAt: initialPasswordExpiresAt
      };

      MasterRepository.createAccount(accountRecord, credentialRecord);

      try {
        // If primary workspace is provided, assignment and membership are part of
        // the same provisioning unit. A failure rolls the new account back.
        if (primaryWorkspaceId) {
          MasterRepository.assignWorkspaceAccess({
            AccessID: Validation.generateId('ACC'),
            UserID: userId,
            WorkspaceID: primaryWorkspaceId,
            Role: role,
            Active: true,
            AssignedAt: now,
            AssignedBy: superAdminContext.userId
          });

          SheetRepository.addMember(primaryWorkspaceId, {
            UserID: userId,
            DisplayName: displayName,
            Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            JoinedAt: now,
            LeftAt: '',
            Department: userPayload.department || 'Operations',
            Team: userPayload.team || 'General',
            JobTitle: userPayload.jobTitle || 'Team Member',
            EmployeeCode: userPayload.employeeCode || ''
          });
        }
      } catch (provisionErr) {
        // Remove a member row if the workspace append completed before a later
        // provisioning error surfaced.
        if (primaryWorkspaceId) {
          try {
            const member = SheetRepository.getMember(primaryWorkspaceId, userId);
            if (member && member._rowIndex) {
              SheetRepository.deleteRow(
                primaryWorkspaceId,
                CONSTANTS.WORKSPACE_TABS.MEMBERS,
                member._rowIndex
              );
            }
          } catch (memberRollbackErr) {
            console.error(
              `Workspace member rollback failed for ${userId}: ${memberRollbackErr.message}`
            );
          }
        }

        try {
          MasterRepository.rollbackUserCreation(userId);
        } catch (masterRollbackErr) {
          console.error(
            `Master user rollback failed for ${userId}: ${masterRollbackErr.message}`
          );
        }
        throw provisionErr;
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: primaryWorkspaceId,
        EntityType: 'USER',
        EntityID: userId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_CREATED,
        AfterJSON: accountRecord,
        Reason: 'User created by Super Admin'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        userId,
        username,
        displayName,
        role,
        status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        primaryWorkspaceId,
        temporaryPassword
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin updates account details
   */
  updateUser(superAdminContext, targetUserId, updates) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const existing = MasterRepository.findAccountById(targetUserId);
      if (!existing) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

      const isRootSuperAdmin = existing.Role === CONSTANTS.ROLES.SUPER_ADMIN;
      const allowedUpdates = {};
      if (updates.displayName) allowedUpdates.DisplayName = Validation.sanitizeCellValue(updates.displayName.trim());
      if (updates.email !== undefined) {
        const nextEmail = Validation.validateEmail(updates.email);
        if (
          isRootSuperAdmin &&
          IdentityService.normalizeEmail(nextEmail) !==
            IdentityService.normalizeEmail(existing.Email || '')
        ) {
          throw new AppError(
            ERROR_CODES.PERMISSION_DENIED,
            'The root Super Admin Google Workspace identity cannot be changed through generic user CRUD.',
            403
          );
        }
        allowedUpdates.Email = nextEmail;
      }

      if (updates.role) {
        const requestedRole = Validation.validateRole(updates.role);
        if (requestedRole !== existing.Role) {
          if (isRootSuperAdmin) {
            throw new AppError(
              ERROR_CODES.PERMISSION_DENIED,
              'The root Super Admin role cannot be demoted through generic user CRUD.',
              403
            );
          }
          if (requestedRole === CONSTANTS.ROLES.SUPER_ADMIN) {
            throw new AppError(
              ERROR_CODES.PERMISSION_DENIED,
              'Promotion to SUPER_ADMIN is not allowed through the generic user-update endpoint.',
              403
            );
          }

          const activeAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
          if (
            requestedRole === CONSTANTS.ROLES.ADMIN &&
            activeAccesses.length > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES
          ) {
            throw new AppError(
              ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
              `Cannot promote this user to Admin while assigned to ${activeAccesses.length} workspaces. Maximum is ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES}.`,
              400
            );
          }

          allowedUpdates.Role = requestedRole;
          MasterRepository.syncWorkspaceAccessRole(targetUserId, requestedRole);
        }
      }

      if (updates.primaryWorkspaceId !== undefined) {
        const requestedPrimary = updates.primaryWorkspaceId || '';
        if (requestedPrimary) {
          const activeAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
          const hasAccess = activeAccesses.some(a => a.WorkspaceID === requestedPrimary);
          if (!hasAccess) {
            throw new AppError(
              ERROR_CODES.WORKSPACE_DENIED,
              'Primary workspace can only be set to a workspace the user is actively assigned to.',
              403
            );
          }
        }
        allowedUpdates.PrimaryWorkspaceID = requestedPrimary;
      }

      allowedUpdates.UpdatedAt = new Date().toISOString();
      allowedUpdates.UpdatedBy = superAdminContext.userId;

      const updated = MasterRepository.updateAccount(targetUserId, allowedUpdates);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: 'USER_UPDATED',
        BeforeJSON: existing,
        AfterJSON: updated,
        Reason: 'User details updated'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return updated;
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin deactivates an account to PASSIVE status.
   * Immediately revokes all sessions and cleanly terminates running timers.
   */
  makeUserPassive(superAdminContext, targetUserId, reason = 'Deactivated by Super Admin') {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const account = MasterRepository.findAccountById(targetUserId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);
      if (account.Role === CONSTANTS.ROLES.SUPER_ADMIN) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'The root Super Admin account cannot be deactivated.',
          403
        );
      }

      // Revoke sessions first. Any concurrent timer start is blocked by this same ScriptLock.
      SessionService.revokeAllUserSessions(targetUserId);

      const ownerContext = {
        userId: targetUserId,
        role: account.Role,
        user: account
      };

      const accesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      const activeAccesses = accesses.filter(acc => {
        const ws = MasterRepository.getWorkspace(acc.WorkspaceID);
        return ws && ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
      });
      const finalizedTimers = [];

      // Phase 1: preserve every active timer before changing account/member state.
      for (const acc of activeAccesses) {
        const timer = SheetRepository.getActiveTimer(acc.WorkspaceID, targetUserId);
        if (timer) {
          const entry = TimerService._finalizeActiveTimerLocked(
            ownerContext,
            acc.WorkspaceID,
            timer,
            { reason: 'Timer finalized automatically during account deactivation' },
            superAdminContext
          );
          finalizedTimers.push({
            workspaceId: acc.WorkspaceID,
            timerId: timer.TimerID,
            entryId: entry.EntryID,
            durationSeconds: entry.DurationSeconds
          });
        }
      }

      // Phase 2: transition all active workspace member rows. Do not silently
      // continue if one workspace fails, because that would leave a PASSIVE
      // account with an ACTIVE membership record. Roll back member rows already
      // changed and leave the account ACTIVE so the operation can be retried.
      const changedMembers = [];
      const leftAt = new Date().toISOString();
      try {
        for (const acc of activeAccesses) {
          const beforeMember = SheetRepository.getMember(acc.WorkspaceID, targetUserId);
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
            LeftAt: leftAt
          });
          changedMembers.push({
            workspaceId: acc.WorkspaceID,
            status: beforeMember ? beforeMember.Status : CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            leftAt: beforeMember ? (beforeMember.LeftAt || '') : ''
          });
        }
      } catch (memberErr) {
        for (const changed of changedMembers.reverse()) {
          try {
            SheetRepository.updateMember(changed.workspaceId, targetUserId, {
              Status: changed.status || CONSTANTS.ACCOUNT_STATUS.ACTIVE,
              LeftAt: changed.leftAt
            });
          } catch (rollbackErr) {
            console.error(
              `Member rollback failed for ${targetUserId} in ${changed.workspaceId}: ${rollbackErr.message}`
            );
          }
        }
        throw memberErr;
      }

      // Only mark the account passive after active time and every active member
      // row have been transitioned safely.
      MasterRepository.updateAccount(targetUserId, {
        Status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_PASSIVE,
        AfterJSON: { finalizedTimers },
        Reason: reason
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        userId: targetUserId,
        status: CONSTANTS.ACCOUNT_STATUS.PASSIVE,
        finalizedTimers
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin reactivates a PASSIVE or LOCKED account
   */
  activateUser(superAdminContext, targetUserId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const account = MasterRepository.findAccountById(targetUserId);
      if (!account) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

      MasterRepository.updateAccount(targetUserId, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      MasterRepository.updateCredentials(targetUserId, {
        FailedLoginCount: 0,
        LockUntil: ''
      });

      const accesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);
      for (const acc of accesses) {
        try {
          SheetRepository.updateMember(acc.WorkspaceID, targetUserId, {
            Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
            LeftAt: ''
          });
        } catch (e) {}
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.USER_ACTIVATED,
        Reason: 'Account reactivated'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }
      return { ok: true, userId: targetUserId, status: CONSTANTS.ACCOUNT_STATUS.ACTIVE };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Lists users based on requester's role
   */
  listUsers(authContext, workspaceId = null) {
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    const { rows: allAccessRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
    const activeAccessRows = allAccessRows.filter(a =>
      a.Active === true || a.Active === 'TRUE' || a.Active === 1
    );

    const assignedIdsFor = userId => activeAccessRows
      .filter(a => a.UserID === userId)
      .map(a => a.WorkspaceID);

    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      let visibleRows = rows;
      if (workspaceId) {
        const userIds = new Set(
          activeAccessRows
            .filter(a => a.WorkspaceID === workspaceId)
            .map(a => a.UserID)
        );
        visibleRows = rows.filter(u => userIds.has(u.UserID));
      }

      return visibleRows.map(user =>
        this._toUserDTO(user, assignedIdsFor(user.UserID), 'SUPER_ADMIN')
      );
    }

    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      const adminWorkspaceIds = MasterRepository
        .getWorkspaceAccessForUser(authContext.userId)
        .map(a => a.WorkspaceID);
      const targetWorkspace = workspaceId || adminWorkspaceIds[0];

      if (!targetWorkspace || !adminWorkspaceIds.includes(targetWorkspace)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Access denied to requested workspace users.',
          403
        );
      }

      const teamUserIds = new Set(
        activeAccessRows
          .filter(a => a.WorkspaceID === targetWorkspace)
          .map(a => a.UserID)
      );

      return rows
        .filter(u => teamUserIds.has(u.UserID))
        .map(user => this._toUserDTO(user, assignedIdsFor(user.UserID), 'ADMIN'));
    }

    const self = rows.find(u => u.UserID === authContext.userId);
    return self
      ? [this._toUserDTO(self, assignedIdsFor(self.UserID), 'SELF')]
      : [];
  }
};

/* ===== AdminRequestService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Admin Request Service
 * Mediates Admin-driven user lifecycle requests (new user, make passive, password reset)
 * through a centralized Super Admin review and execution queue.
 */

var AdminRequestService = (typeof global !== 'undefined' && global.AdminRequestService) || {
  /**
   * Admin submits a user lifecycle request
   */
  submitRequest(adminContext, payload) {
    AuthorizationService.assertRole(adminContext, [CONSTANTS.ROLES.ADMIN, CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(payload, ['requestType', 'workspaceId', 'reason']);

    const { requestType, workspaceId, targetUserId, requestedData, reason } = payload;
    AuthorizationService.assertWorkspaceAccess(adminContext, workspaceId);

    if (!Object.values(CONSTANTS.REQUEST_TYPES).includes(requestType)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid request type: ${requestType}`);
    }

    if ((requestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE || requestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET) && !targetUserId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Target user ID is required for this request type.');
    }

    if (
      requestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE ||
      requestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET
    ) {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Target user ${targetUserId} was not found.`, 404);
      }
      if (targetAccount.Role !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'Admin lifecycle requests may only target ordinary USER accounts.',
          403
        );
      }

      const targetAccess = MasterRepository
        .getWorkspaceAccessForUser(targetUserId)
        .some(access => access.WorkspaceID === workspaceId);

      if (!targetAccess) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'The target user is not actively assigned to the requested workspace.',
          403
        );
      }
    }

    let cleanRequestedData = null;
    if (requestType === CONSTANTS.REQUEST_TYPES.NEW_USER) {
      if (!requestedData || typeof requestedData !== 'object' || Array.isArray(requestedData)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'requestedData is required for NEW_USER requests.',
          400
        );
      }
      Validation.assertRequired(
        requestedData,
        ['username', 'displayName', 'email']
      );
      const cleanEmail = Validation.validateEmail(requestedData.email);
      const cleanUsername = typeof Validation.validateUsername === 'function'
        ? Validation.validateUsername(requestedData.username)
        : String(requestedData.username || '').trim().toLowerCase();
      const cleanDisplayName = Validation.sanitizeCellValue(String(requestedData.displayName || '').trim());
      const requestedRole = requestedData.role || CONSTANTS.ROLES.USER;
      if (requestedRole !== CONSTANTS.ROLES.USER) {
        throw new AppError(
          ERROR_CODES.PERMISSION_DENIED,
          'Admin-created user requests may only request ordinary USER accounts.',
          403
        );
      }
      cleanRequestedData = {
        username: cleanUsername,
        displayName: cleanDisplayName,
        email: cleanEmail,
        role: CONSTANTS.ROLES.USER
      };
      if (requestedData.temporaryPassword) {
        cleanRequestedData.temporaryPassword = String(requestedData.temporaryPassword);
      }
    }

    const requestId = Validation.generateId('REQ');
    const now = new Date().toISOString();

    const requestRecord = {
      RequestID: requestId,
      RequestType: requestType,
      RequestedBy: adminContext.userId,
      WorkspaceID: workspaceId,
      TargetUserID: targetUserId || '',
      RequestedDataJSON: cleanRequestedData ? JSON.stringify(cleanRequestedData) : (requestedData ? JSON.stringify(Validation.sanitizeRow(requestedData)) : ''),
      Reason: Validation.sanitizeCellValue(reason),
      Status: CONSTANTS.REQUEST_STATUS.PENDING,
      RequestedAt: now,
      ReviewedBy: '',
      ReviewedAt: '',
      ReviewComment: '',
      ExecutedAt: ''
    };

    MasterRepository.createRequest(requestRecord);

    MasterRepository.logGlobalAudit({
      ActorUserID: adminContext.userId,
      ActorRole: adminContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'REQUEST',
      EntityID: requestId,
      Action: CONSTANTS.AUDIT_EVENTS.REQUEST_SUBMITTED,
      AfterJSON: requestRecord,
      Reason: reason
    });

    return requestRecord;
  },

  /**
   * Lists requests according to role
   */
  listRequests(authContext, statusFilter = null, workspaceId = null) {
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return MasterRepository.listRequests(statusFilter, workspaceId);
    }

    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      const adminAccesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
      const allowedWs = new Set(adminAccesses.map(a => a.WorkspaceID));
      if (workspaceId && !allowedWs.has(workspaceId)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Access denied to request queue for this workspace.',
          403
        );
      }
      const all = MasterRepository.listRequests(statusFilter, workspaceId);
      // Losing workspace access also removes visibility of historical requests
      // from that workspace. RequestedBy is not an authorization grant.
      return all.filter(r => allowedWs.has(r.WorkspaceID));
    }

    throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'Only Admins and Super Admins can access request queues.', 403);
  },

  /**
   * Super Admin reviews, executes, or rejects a request
   */
  reviewRequest(superAdminContext, requestId, reviewPayload) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(reviewPayload, ['action']);

    const action = String(reviewPayload.action || '').toUpperCase();
    if (!['APPROVE', 'REJECT'].includes(action)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Unsupported review action: ${action}`);
    }
    const reviewComment = reviewPayload.reviewComment
      ? Validation.sanitizeCellValue(reviewPayload.reviewComment)
      : '';
    const now = new Date().toISOString();

    // Claim/reject the request under a short ScriptLock. Do not hold this lock
    // while executing UserService/AuthService because those services acquire
    // their own ScriptLock and Apps Script locks are not re-entrant.
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    let req;
    try {
      req = MasterRepository.getRequest(requestId);
      if (!req) throw new AppError(ERROR_CODES.NOT_FOUND, `Request ${requestId} not found.`);
      if (req.Status !== CONSTANTS.REQUEST_STATUS.PENDING) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Request ${requestId} has already been ${String(req.Status).toLowerCase()}.`,
          409
        );
      }

      if (action === 'REJECT') {
        const updated = MasterRepository.updateRequest(requestId, {
          Status: CONSTANTS.REQUEST_STATUS.REJECTED,
          ReviewedBy: superAdminContext.userId,
          ReviewedAt: now,
          ReviewComment: reviewComment
        });

        MasterRepository.logGlobalAudit({
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          WorkspaceID: req.WorkspaceID,
          EntityType: 'REQUEST',
          EntityID: requestId,
          Action: 'REQUEST_REJECTED',
          Reason: reviewComment
        });

        return { ok: true, request: updated };
      }

      // APPROVED is the exclusive execution claim. A concurrent reviewer will
      // now see a non-PENDING request and cannot execute it a second time.
      MasterRepository.updateRequest(requestId, {
        Status: CONSTANTS.REQUEST_STATUS.APPROVED,
        ReviewedBy: superAdminContext.userId,
        ReviewedAt: now,
        ReviewComment: reviewComment
      });
    } finally {
      lock.releaseLock();
    }

    try {
      const originWorkspace = MasterRepository.getWorkspace(req.WorkspaceID);
      if (!originWorkspace || originWorkspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          'Request can no longer be executed because the originating workspace is not active.',
          403
        );
      }

      let executionResult = null;

      if (req.RequestType === CONSTANTS.REQUEST_TYPES.NEW_USER) {
        let requestedData;
        try {
          requestedData = JSON.parse(req.RequestedDataJSON || '');
        } catch (e) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Stored NEW_USER request data is invalid and cannot be executed.',
            400
          );
        }
        if (!requestedData || typeof requestedData !== 'object' || Array.isArray(requestedData)) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            'Stored NEW_USER request data is invalid and cannot be executed.',
            400
          );
        }
        Validation.assertRequired(
          requestedData,
          ['username', 'displayName', 'email']
        );
        const cleanUserPayload = {
          username: typeof Validation.validateUsername === 'function'
            ? Validation.validateUsername(requestedData.username)
            : String(requestedData.username || '').trim().toLowerCase(),
          displayName: Validation.sanitizeCellValue(String(requestedData.displayName || '').trim()),
          email: Validation.validateEmail(requestedData.email),
          role: CONSTANTS.ROLES.USER,
          primaryWorkspaceId: req.WorkspaceID
        };
        if (requestedData.temporaryPassword) {
          cleanUserPayload.temporaryPassword = String(requestedData.temporaryPassword);
        }

        executionResult = UserService.createUser(superAdminContext, cleanUserPayload);
      } else if (
        req.RequestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE ||
        req.RequestType === CONSTANTS.REQUEST_TYPES.PASSWORD_RESET
      ) {
        // Revalidate identity and membership at execution time. A queued request
        // must not retain authority after role/access changes.
        const targetAccount = MasterRepository.findAccountById(req.TargetUserID);
        if (!targetAccount) {
          throw new AppError(ERROR_CODES.NOT_FOUND, `Target user ${req.TargetUserID} was not found.`, 404);
        }
        if (targetAccount.Role !== CONSTANTS.ROLES.USER) {
          throw new AppError(
            ERROR_CODES.PERMISSION_DENIED,
            'Request can no longer be executed because the target is not an ordinary USER account.',
            403
          );
        }
        const stillAssigned = MasterRepository
          .getWorkspaceAccessForUser(req.TargetUserID)
          .some(access => access.WorkspaceID === req.WorkspaceID);
        if (!stillAssigned) {
          throw new AppError(
            ERROR_CODES.WORKSPACE_DENIED,
            'Request can no longer be executed because the target user is not actively assigned to the originating workspace.',
            403
          );
        }

        if (req.RequestType === CONSTANTS.REQUEST_TYPES.MAKE_PASSIVE) {
          executionResult = UserService.makeUserPassive(
            superAdminContext,
            req.TargetUserID,
            req.Reason
          );
        } else {
          const tempPassword = SecurityService.generateTemporaryPassword();
          executionResult = AuthService.resetPasswordByAdmin(
            superAdminContext,
            req.TargetUserID,
            tempPassword
          );
          executionResult.temporaryPassword = tempPassword;
        }
      } else {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Unsupported executable request type: ${req.RequestType}`,
          400
        );
      }

      const updated = MasterRepository.updateRequest(requestId, {
        Status: CONSTANTS.REQUEST_STATUS.EXECUTED,
        ExecutedAt: new Date().toISOString()
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: req.WorkspaceID,
        EntityType: 'REQUEST',
        EntityID: requestId,
        Action: CONSTANTS.AUDIT_EVENTS.REQUEST_EXECUTED,
        AfterJSON: updated,
        Reason: reviewComment
      });

      return { ok: true, request: updated, executionResult };
    } catch (executionErr) {
      // Release the execution claim for a safe retry while preserving the error
      // to the reviewer. Another reviewer can only retry after this reset.
      try {
        MasterRepository.updateRequest(requestId, {
          Status: CONSTANTS.REQUEST_STATUS.PENDING,
          ReviewedBy: '',
          ReviewedAt: '',
          ReviewComment: ''
        });
      } catch (resetErr) {
        console.error(
          `Failed to reset request ${requestId} after execution failure: ${resetErr.message}`
        );
      }
      throw executionErr;
    }
  }
};

/* ===== SetupService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Setup & Self-Healing Service
 * Manages the 9-Step Guided Setup Wizard, first-run initialization,
 * 10-point system integrity verification, and zero-code automated self-healing.
 */

var SetupService = (typeof global !== 'undefined' && global.SetupService) || {
  /**
   * Evaluates current installation setup status
   */
  getSetupStatus() {
    let superAdminExists = false;
    let workspaceCount = 0;
    let adminCount = 0;
    let userCount = 0;
    let isSetupComplete = false;

    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      superAdminExists = accounts.some(a => a.Role === CONSTANTS.ROLES.SUPER_ADMIN && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED);
      adminCount = accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED).length;
      userCount = accounts.filter(a => a.Role === CONSTANTS.ROLES.USER && a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED).length;
    } catch (e) {
      superAdminExists = false;
    }

    try {
      const workspaces = MasterRepository.listWorkspaces();
      workspaceCount = workspaces.filter(w => w.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED).length;
    } catch (e) {
      workspaceCount = 0;
    }

    let setupFlag = 'false';
    try {
      setupFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
    } catch (e) {
      setupFlag = 'false';
    }
    isSetupComplete = (setupFlag === 'true' || setupFlag === true) && superAdminExists && workspaceCount > 0;

    // Once initialization is complete, the public setup-status endpoint only needs
    // to tell the login page that setup is finished. Do not expose company settings,
    // workspace counts, or account counts to unauthenticated callers.
    if (isSetupComplete) {
      return {
        initialized: true,
        setupComplete: true
      };
    }

    // Before setup is complete, unauthenticated callers only need to know
    // whether the installation still requires setup. Do not expose account,
    // workspace, company, or partial-configuration metadata.
    return {
      initialized: false,
      setupComplete: false,
      setupRequired: true
    };
  },

  /**
   * Executes a step in the 9-step guided setup wizard
   */
  processStep(stepNumber, payload, authContext = null) {
    const step = parseInt(stepNumber, 10);

    if (step >= 2 && step <= 8) {
      const setupFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
      if (setupFlag === true || setupFlag === 'true') {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Setup wizard configuration steps are closed after installation. Use the normal administration APIs.',
          409
        );
      }
    }

    switch (step) {
      case 1:
        return this._step1_SystemOwner(payload);

      case 2:
        return this._step2_CompanySettings(payload, authContext);

      case 3:
        return this._step3_Workspace(payload, authContext);

      case 4:
        return this._step4_Admin(payload, authContext);

      case 5:
        return this._step5_Employees(payload, authContext);

      case 6:
        return this._step6_Projects(payload, authContext);

      case 7:
        return this._step7_TimeRules(payload, authContext);

      case 8:
        return this._step8_ReportingAlerts(payload, authContext);

      case 9:
        return this._step9_SystemCheck(authContext);

      default:
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid setup wizard step: ${step}`);
    }
  },

  /* ---------------- WIZARD STEP IMPLEMENTATIONS ---------------- */

  _step1_SystemOwner(payload) {
    const lock = LockService.getScriptLock();
    lock.waitLock(15000);
    try {
      return this._step1_SystemOwnerLocked(payload);
    } finally {
      lock.releaseLock();
    }
  },

  _step1_SystemOwnerLocked(payload) {
    Validation.assertRequired(payload, ['fullName', 'username', 'password', 'confirmPassword']);

    // The first unauthenticated setup mutation is allowed only for the account
    // that prepared the Master Sheet AND owns the execute-as-deployer Web App.
    // Verify this before any schema or credential mutation.
    const googleEmail = IdentityService.assertInstallationOwner();

    // Caller already holds the script-wide installation lock. Do not reacquire
    // the same lock here; Apps Script locks are not a re-entrant transaction.
    MigrationService.bootstrapMasterSheet();

    if (payload.password !== payload.confirmPassword) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Passwords do not match.');
    }
    Validation.validatePassword(payload.password);

    const setupFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
    if (setupFlag === true || setupFlag === 'true') {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        'FLINK Time setup is already complete. Please sign in.',
        409
      );
    }

    // Verify no Super Admin already registered.
    const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
    const existing = accounts.find(
      a => a.Role === CONSTANTS.ROLES.SUPER_ADMIN &&
        a.Status !== CONSTANTS.ACCOUNT_STATUS.DELETED
    );
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Super Admin account already exists. Please log in.');
    }

    const cleanUsername = String(payload.username).trim().toLowerCase();
    const adminUserId = Validation.generateId('USR');
    const hash = SecurityService.hashPassword(payload.password);
    const now = new Date().toISOString();

    const accountRecord = {
      UserID: adminUserId,
      Username: cleanUsername,
      DisplayName: String(payload.fullName).trim(),
      Role: CONSTANTS.ROLES.SUPER_ADMIN,
      Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE,
      PrimaryWorkspaceID: '',
      Email: googleEmail,
      CreatedAt: now,
      CreatedBy: 'SETUP_WIZARD',
      UpdatedAt: now,
      UpdatedBy: 'SETUP_WIZARD',
      LastLoginAt: '',
      MustChangePassword: false
    };

    MasterRepository.createAccount(accountRecord, {
      UserID: adminUserId,
      PasswordHash: hash,
      PasswordVersion: 1,
      PasswordChangedAt: now,
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    MasterRepository.logGlobalAudit({
      ActorUserID: adminUserId,
      ActorRole: CONSTANTS.ROLES.SUPER_ADMIN,
      WorkspaceID: 'MASTER',
      EntityType: 'USER',
      EntityID: adminUserId,
      Action: CONSTANTS.AUDIT_EVENTS.USER_CREATED,
      AfterJSON: { username: cleanUsername, role: CONSTANTS.ROLES.SUPER_ADMIN },
      Reason: 'Root Super Admin created via owner-bound Setup Wizard Step 1'
    });

    // Remove any legacy setup-key state left by an older release.
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const props = PropertiesService.getScriptProperties();
      props.deleteProperty('FLINK_SETUP_KEY_HASH');
      props.deleteProperty('FLINK_SETUP_KEY_CREATED_AT');
    }

    // Automatically issue session for immediate progression.
    const session = SessionService.createSession(
      adminUserId,
      'SETUP_WIZARD',
      googleEmail
    );

    return {
      ok: true,
      message: 'Super Admin initialized successfully.',
      user: {
        userId: adminUserId,
        username: cleanUsername,
        displayName: accountRecord.DisplayName,
        role: CONSTANTS.ROLES.SUPER_ADMIN,
        email: googleEmail
      },
      sessionToken: session.sessionToken
    };
  },

  _step2_CompanySettings(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.companyName) MasterRepository.setGlobalSetting('COMPANY_NAME', payload.companyName, actorId, 'Company Legal Name');
    if (payload.timezone) MasterRepository.setGlobalSetting('DEFAULT_TIMEZONE', payload.timezone, actorId, 'Default Company Timezone');
    if (payload.weekStarts) MasterRepository.setGlobalSetting('WEEK_STARTS', payload.weekStarts, actorId, 'First day of timesheet week');
    if (payload.workdayHours) MasterRepository.setGlobalSetting('DEFAULT_WORKDAY_HOURS', String(payload.workdayHours), actorId, 'Daily target workday hours');
    if (payload.workweekHours) MasterRepository.setGlobalSetting('DEFAULT_WORKWEEK_HOURS', String(payload.workweekHours), actorId, 'Weekly target workweek hours');

    return { ok: true, message: 'Company settings saved successfully.' };
  },

  _step3_Workspace(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 3.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.assertRequired(payload, ['name']);

    const ws = WorkspaceService.createWorkspace(authContext, {
      name: payload.name,
      timezone: payload.timezone || MasterRepository.getGlobalSetting('DEFAULT_TIMEZONE', 'Africa/Cairo')
    });

    if (payload.dailyTargetHours) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_DAILY_TARGET`, String(payload.dailyTargetHours), authContext.userId);
    }
    if (payload.requireWeeklyApproval !== undefined) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_REQUIRE_APPROVAL`, String(payload.requireWeeklyApproval), authContext.userId);
    }
    if (payload.allowManualTime !== undefined) {
      MasterRepository.setGlobalSetting(`WS_${ws.WorkspaceID}_ALLOW_MANUAL`, String(payload.allowManualTime), authContext.userId);
    }

    return { ok: true, workspace: ws, message: 'Initial workspace provisioned with all 18 tabs.' };
  },

  _step4_Admin(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 4.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Admin creation skipped.' };
    }

    Validation.assertRequired(
      payload,
      ['fullName', 'username', 'email', 'temporaryPassword', 'workspaceIds']
    );

    const workspaceIds = Array.isArray(payload.workspaceIds) ? payload.workspaceIds : [payload.workspaceIds];
    if (workspaceIds.length > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
      throw new AppError(
        ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
        `Admins can only be assigned to a maximum of ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES} active workspaces.`,
        400
      );
    }

    const adminUser = UserService.createUser(authContext, {
      username: payload.username,
      displayName: payload.fullName,
      email: Validation.validateEmail(payload.email),
      role: CONSTANTS.ROLES.ADMIN,
      primaryWorkspaceId: workspaceIds[0] || '',
      temporaryPassword: payload.temporaryPassword,
      mustChangePassword: true
    });

    // Assign to selected workspaces
    for (const wsId of workspaceIds) {
      WorkspaceService.assignAdminToWorkspace(authContext, adminUser.userId, wsId);
    }

    return { ok: true, admin: adminUser, message: 'Admin created and assigned successfully.' };
  },

  _step5_Employees(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 5.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Employee intake skipped.' };
    }

    const usersToCreate = Array.isArray(payload.users) ? payload.users : [payload];
    const createdUsers = [];

    for (const u of usersToCreate) {
      if (!u.username || !u.fullName) continue;
      if (!u.email) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `email is required for user ${u.username}.`,
          400
        );
      }
      const created = UserService.createUser(authContext, {
        username: u.username,
        displayName: u.fullName,
        email: Validation.validateEmail(u.email),
        role: CONSTANTS.ROLES.USER,
        primaryWorkspaceId: u.workspaceId || '',
        department: u.department || '',
        jobTitle: u.jobTitle || '',
        employeeCode: u.employeeCode || '',
        temporaryPassword: (() => {
          if (!u.temporaryPassword) {
            throw new AppError(ERROR_CODES.VALIDATION_ERROR, `temporaryPassword is required for user ${u.username}.`);
          }
          Validation.validatePassword(u.temporaryPassword);
          return u.temporaryPassword;
        })(),
        mustChangePassword: true
      });
      createdUsers.push(created);
    }

    return { ok: true, count: createdUsers.length, users: createdUsers, message: `Created ${createdUsers.length} employees.` };
  },

  _step6_Projects(payload, authContext) {
    if (!authContext) throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for Step 6.');
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    if (payload.skip) {
      return { ok: true, message: 'Project scaffolding skipped.' };
    }

    Validation.assertRequired(payload, ['workspaceId', 'projectName']);
    const wsId = payload.workspaceId;

    let clientId = '';
    if (payload.clientName) {
      const client = ClientService.createClient(authContext, wsId, {
        clientName: payload.clientName,
        notes: 'Created via setup wizard'
      });
      clientId = client.ClientID;
    }

    const project = ProjectService.createProject(authContext, wsId, {
      clientId,
      projectName: payload.projectName,
      code: payload.projectCode || payload.projectName.substring(0, 6).toUpperCase(),
      billableDefault: payload.billable !== false,
      hourlyRate: payload.hourlyRate || 0,
      estimateHours: payload.estimateHours || 0
    });

    // Create tasks if provided
    const tasks = Array.isArray(payload.tasks) ? payload.tasks : ['General Tasks', 'Review'];
    const createdTasks = [];
    for (const tName of tasks) {
      const task = TaskService.createTask(authContext, wsId, {
        projectId: project.ProjectID,
        taskName: tName,
        billableDefault: project.BillableDefault
      });
      createdTasks.push(task);
    }

    return { ok: true, project, tasks: createdTasks, message: 'Project and tasks scaffolded successfully.' };
  },

  _step7_TimeRules(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.projectRequired !== undefined) MasterRepository.setGlobalSetting('RULE_PROJECT_REQUIRED', String(payload.projectRequired), actorId);
    if (payload.taskRequired !== undefined) MasterRepository.setGlobalSetting('RULE_TASK_REQUIRED', String(payload.taskRequired), actorId);
    if (payload.descRequired !== undefined) MasterRepository.setGlobalSetting('RULE_DESC_REQUIRED', String(payload.descRequired), actorId);
    if (payload.tagsRequired !== undefined) MasterRepository.setGlobalSetting('RULE_TAGS_REQUIRED', String(payload.tagsRequired), actorId);
    if (payload.allowManual !== undefined) MasterRepository.setGlobalSetting('RULE_ALLOW_MANUAL', String(payload.allowManual), actorId);
    if (payload.timerWarningHours) MasterRepository.setGlobalSetting('TIMER_WARNING_HOURS', String(payload.timerWarningHours), actorId);
    if (payload.autoStopHours) MasterRepository.setGlobalSetting('AUTO_STOP_HOURS', String(payload.autoStopHours), actorId);
    if (payload.pastEntryEditDays) MasterRepository.setGlobalSetting('PAST_ENTRY_EDIT_DAYS', String(payload.pastEntryEditDays), actorId);

    return { ok: true, message: 'Time rules saved successfully.' };
  },

  _step8_ReportingAlerts(payload, authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const actorId = authContext ? authContext.userId : 'SETUP_WIZARD';

    if (payload.liveActivity !== undefined) MasterRepository.setGlobalSetting('ALERT_LIVE_ACTIVITY', String(payload.liveActivity), actorId);
    if (payload.missingTime !== undefined) MasterRepository.setGlobalSetting('ALERT_MISSING_TIME', String(payload.missingTime), actorId);
    if (payload.overtime !== undefined) MasterRepository.setGlobalSetting('ALERT_OVERTIME', String(payload.overtime), actorId);
    if (payload.longRunningTimer !== undefined) MasterRepository.setGlobalSetting('ALERT_LONG_TIMERS', String(payload.longRunningTimer), actorId);
    if (payload.weeklyReminder !== undefined) MasterRepository.setGlobalSetting('ALERT_WEEKLY_REMINDER', String(payload.weeklyReminder), actorId);
    if (payload.pendingApprovalReminder !== undefined) MasterRepository.setGlobalSetting('ALERT_PENDING_APPROVAL', String(payload.pendingApprovalReminder), actorId);
    if (payload.dashboardRefreshSeconds) MasterRepository.setGlobalSetting('DASHBOARD_REFRESH_SECONDS', String(payload.dashboardRefreshSeconds), actorId);

    const triggerStatus = JobService.ensureScheduledTriggers();
    return {
      ok: true,
      triggers: triggerStatus,
      message: 'Reporting, alerts, and required scheduled jobs configured successfully.'
    };
  },

  _step9_SystemCheck(authContext) {
    if (!authContext) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin session required for final system verification.', 401);
    }
    AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const checks = [];
    const workspaces = MasterRepository.listWorkspaces();
    const activeWorkspaces = workspaces.filter(w => w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE);

    // 1. Master schema
    try {
      const ss = MasterRepository.getMasterSpreadsheet();
      const expectedTabs = Object.values(CONSTANTS.MASTER_TABS);
      const missingTabs = expectedTabs.filter(tab => !ss.getSheetByName(tab));
      checks.push({
        id: 'master_db',
        name: 'Master Control Database',
        passed: missingTabs.length === 0,
        detail: missingTabs.length === 0
          ? `All ${expectedTabs.length} required master tabs verified`
          : `Missing tabs: ${missingTabs.join(', ')}`
      });
    } catch (e) {
      checks.push({ id: 'master_db', name: 'Master Control Database', passed: false, detail: e.message });
    }

    // 2. Active workspace schema/isolation
    try {
      const issues = [];
      if (activeWorkspaces.length === 0) issues.push('No active workspace exists');
      for (const ws of activeWorkspaces) {
        try {
          const wss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          const missing = Object.values(CONSTANTS.WORKSPACE_TABS)
            .filter(tab => !wss.getSheetByName(tab));
          if (missing.length > 0) issues.push(`${ws.WorkspaceName}: missing ${missing.join(', ')}`);
        } catch (e) {
          issues.push(`${ws.WorkspaceName}: ${e.message}`);
        }
      }
      checks.push({
        id: 'workspace_db',
        name: 'Workspace Database Isolation',
        passed: issues.length === 0,
        detail: issues.length === 0
          ? `${activeWorkspaces.length} active workspace(s) verified`
          : issues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'workspace_db', name: 'Workspace Database Isolation', passed: false, detail: e.message });
    }

    // 3. Root account + credentials + production cryptographic secret
    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const rootAdmins = accounts.filter(a =>
        a.Role === CONSTANTS.ROLES.SUPER_ADMIN &&
        a.Status === CONSTANTS.ACCOUNT_STATUS.ACTIVE
      );
      let detail = '';
      let passed = rootAdmins.length === 1;
      if (passed) {
        const credentials = MasterRepository.getCredentials(rootAdmins[0].UserID);
        passed = !!(credentials && credentials.PasswordHash);
        SecurityService.getPepper(); // fails closed if Script Property is missing
        detail = passed
          ? `Root Super Admin '${rootAdmins[0].Username}' and cryptographic secret verified`
          : 'Root Super Admin credentials record is missing';
      } else {
        detail = `Expected exactly one active Super Admin; found ${rootAdmins.length}`;
      }
      checks.push({ id: 'auth_security', name: 'Authentication & Cryptographic Configuration', passed, detail });
    } catch (e) {
      checks.push({ id: 'auth_security', name: 'Authentication & Cryptographic Configuration', passed: false, detail: e.message });
    }

    // 4. RBAC/workspace-access invariants
    try {
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const { rows: accessRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS);
      const accountMap = new Map(accounts.map(a => [a.UserID, a]));
      const workspaceMap = new Map(workspaces.map(w => [w.WorkspaceID, w]));
      const violations = [];

      for (const admin of accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN)) {
        const count = accessRows.filter(r =>
          r.UserID === admin.UserID &&
          (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
        ).length;
        if (count > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
          violations.push(`${admin.Username}: ${count} active workspaces`);
        }
      }

      for (const access of accessRows.filter(r => r.Active === true || r.Active === 'TRUE' || r.Active === 1)) {
        if (!accountMap.has(access.UserID)) violations.push(`orphan user access ${access.UserID}`);
        const ws = workspaceMap.get(access.WorkspaceID);
        if (!ws) violations.push(`orphan workspace access ${access.WorkspaceID}`);
        else if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          violations.push(`active ACL points to non-active workspace ${access.WorkspaceID}`);
        }
      }

      checks.push({
        id: 'rbac',
        name: 'RBAC & Workspace Access Invariants',
        passed: violations.length === 0,
        detail: violations.length === 0
          ? 'Admin limits and active workspace ACL references verified'
          : violations.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'rbac', name: 'RBAC & Workspace Access Invariants', passed: false, detail: e.message });
    }

    // 5. Timer invariants: valid owner/workspace and globally one active timer per user
    try {
      const seenUsers = new Set();
      const timerIssues = [];
      for (const ws of activeWorkspaces) {
        const timers = SheetRepository.listActiveTimers(ws.WorkspaceID);
        const allowedUsers = new Set(
          MasterRepository.getWorkspaceAccessForWorkspace(ws.WorkspaceID).map(a => a.UserID)
        );
        for (const timer of timers) {
          if (!allowedUsers.has(timer.UserID)) {
            timerIssues.push(`${timer.TimerID}: user lacks workspace access`);
          }
          if (seenUsers.has(timer.UserID)) {
            timerIssues.push(`${timer.UserID}: more than one active timer globally`);
          }
          seenUsers.add(timer.UserID);
          if (isNaN(new Date(timer.StartedAtUTC).getTime())) {
            timerIssues.push(`${timer.TimerID}: invalid StartedAtUTC`);
          }
        }
      }
      checks.push({
        id: 'timer_engine',
        name: 'Timer Engine Invariants',
        passed: timerIssues.length === 0,
        detail: timerIssues.length === 0
          ? `${seenUsers.size} active timer owner(s) verified`
          : timerIssues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'timer_engine', name: 'Timer Engine Invariants', passed: false, detail: e.message });
    }

    // 6. Raw-entry totals must reconcile to all aggregate time rollups.
    try {
      const rollupIssues = [];
      for (const ws of activeWorkspaces) {
        const rawEntries = SheetRepository.listTimeEntries(ws.WorkspaceID, {});
        const rawSeconds = rawEntries.reduce((sum, e) => sum + (parseInt(e.DurationSeconds, 10) || 0), 0);

        for (const tab of [
          CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
        ]) {
          const { rows } = SheetRepository.getTableData(ws.WorkspaceID, tab);
          const rollupSeconds = rows.reduce((sum, r) => sum + (parseInt(r.TotalSeconds, 10) || 0), 0);
          if (rollupSeconds !== rawSeconds) {
            rollupIssues.push(
              `${ws.WorkspaceName}/${tab}: raw=${rawSeconds}s rollup=${rollupSeconds}s`
            );
          }
        }
      }
      checks.push({
        id: 'reporting',
        name: 'Reporting Rollup Reconciliation',
        passed: rollupIssues.length === 0,
        detail: rollupIssues.length === 0
          ? 'Daily, weekly, and monthly totals reconcile to raw entries'
          : rollupIssues.join('; ')
      });
    } catch (e) {
      checks.push({ id: 'reporting', name: 'Reporting Rollup Reconciliation', passed: false, detail: e.message });
    }

    // 7. Cryptographic audit chain
    try {
      const masterAudit = AuditService.verifyAuditChain();
      checks.push({
        id: 'audit_log',
        name: 'Master Audit Chain Integrity',
        passed: !!(masterAudit && masterAudit.ok && masterAudit.verified),
        detail: masterAudit && masterAudit.message ? masterAudit.message : 'Audit verification returned no result'
      });
    } catch (e) {
      checks.push({ id: 'audit_log', name: 'Master Audit Chain Integrity', passed: false, detail: e.message });
    }

    // 8. Perform/confirm a real verified initial Master backup.
    try {
      const { rows: backupRows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
      let masterBackup = backupRows.find(row =>
        row.Scope === 'MASTER' &&
        row.Status === 'AVAILABLE' &&
        (row.Verified === true || row.Verified === 'TRUE' || row.Verified === 1)
      );
      let createdBackupId = '';
      if (!masterBackup) {
        const backup = BackupService.createBackup(authContext);
        createdBackupId = backup.backupId;
        masterBackup = { BackupID: backup.backupId };
      }
      checks.push({
        id: 'backup_folder',
        name: 'Verified Backup Subsystem',
        passed: !!masterBackup,
        detail: createdBackupId
          ? `Initial verified Master backup created: ${createdBackupId}`
          : `Verified Master backup registered: ${masterBackup.BackupID}`
      });
    } catch (e) {
      checks.push({ id: 'backup_folder', name: 'Verified Backup Subsystem', passed: false, detail: e.message });
    }

    // 9. Required Apps Script scheduled triggers
    try {
      const triggerStatus = JobService.getScheduledTriggerStatus();
      checks.push({
        id: 'scheduled_jobs',
        name: 'Scheduled Background Jobs',
        passed: triggerStatus.healthy === true,
        detail: triggerStatus.detail
      });
    } catch (e) {
      checks.push({ id: 'scheduled_jobs', name: 'Scheduled Background Jobs', passed: false, detail: e.message });
    }

    // 10. Verify the runtime capability used by doGet for Google Sites embedding.
    try {
      const embedRuntimeAvailable =
        typeof HtmlService !== 'undefined' &&
        HtmlService.XFrameOptionsMode &&
        HtmlService.XFrameOptionsMode.ALLOWALL !== undefined;
      checks.push({
        id: 'sites_embed',
        name: 'HTML Embed Runtime',
        passed: embedRuntimeAvailable,
        detail: embedRuntimeAvailable
          ? 'HtmlService ALLOWALL embed runtime is available'
          : 'HtmlService ALLOWALL embed runtime is unavailable'
      });
    } catch (e) {
      checks.push({ id: 'sites_embed', name: 'HTML Embed Runtime', passed: false, detail: e.message });
    }

    const allPassed = checks.every(check => check.passed);
    if (allPassed) {
      MasterRepository.setGlobalSetting(
        'SETUP_COMPLETE',
        'true',
        authContext.userId,
        'Setup wizard completion flag'
      );
    }

    return {
      allPassed,
      checks,
      timestampUTC: new Date().toISOString(),
      statusText: allPassed ? 'SYSTEM READY' : 'SYSTEM CHECK WARNINGS'
    };
  },

  /**
   * Automated Self-Healing Engine:
   * Recreates missing tabs, fixes header rows, and resyncs out-of-date rollups
   */
  repairSystem(authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const repairedTabs = [];
    const rollupsRebuilt = [];

    // 1. Check and repair Master Control Sheet tabs
    const masterSs = MasterRepository.getMasterSpreadsheet();
    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = masterSs.getSheetByName(tabName);
      if (!sheet) {
        sheet = masterSs.insertSheet(tabName);
        sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
        sheet.setFrozenRows(1);
        repairedTabs.push(`Master Tab: ${tabName}`);
      } else {
        // Verify header row
        const currentHeaders = sheet.getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1)).getValues()[0];
        if (currentHeaders.length < columns.length || !columns.every((c, i) => currentHeaders[i] === c)) {
          sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
          sheet.setFrozenRows(1);
          repairedTabs.push(`Master Header: ${tabName}`);
        }
      }
      const trimResult = trimSheetToSchema_(sheet, columns.length, 1000);
      if (trimResult.changed) repairedTabs.push(`Master Trim: ${tabName}`);
    }

    // 2. Check and repair all active Workspaces
    const workspaces = MasterRepository.listWorkspaces();
    for (const ws of workspaces) {
      if (ws.Status === CONSTANTS.WORKSPACE_STATUS.ARCHIVED) continue;
      try {
        const wss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
        for (const [tabName, columns] of Object.entries(WORKSPACE_SCHEMA)) {
          let sheet = wss.getSheetByName(tabName);
          if (!sheet) {
            sheet = wss.insertSheet(tabName);
            sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
            sheet.setFrozenRows(1);
            repairedTabs.push(`Workspace ${ws.WorkspaceName} Tab: ${tabName}`);
          } else {
            const currentHeaders = sheet
              .getRange(1, 1, 1, Math.max(sheet.getLastColumn(), 1))
              .getValues()[0];
            if (
              currentHeaders.length < columns.length ||
              !columns.every((c, i) => currentHeaders[i] === c)
            ) {
              sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
              sheet.setFrozenRows(1);
              repairedTabs.push(`Workspace ${ws.WorkspaceName} Header: ${tabName}`);
            }
          }
          const trimResult = trimSheetToSchema_(sheet, columns.length, 1000);
          if (trimResult.changed) {
            repairedTabs.push(`Workspace ${ws.WorkspaceName} Trim: ${tabName}`);
          }
        }

        // Rebuild rollups to ensure 100% cache sync
        RollupService.rebuildRollups(ws.WorkspaceID);
        rollupsRebuilt.push(ws.WorkspaceName);
      } catch (wsErr) {
        console.error(`Error repairing workspace ${ws.WorkspaceID}: ` + wsErr.message);
      }
    }

    // Existing production installations may predate newly required scheduled
    // handlers. Self-heal reconciles them so upgrades do not require reopening
    // the bootstrap-only setup wizard.
    const triggerStatus = JobService.ensureScheduledTriggers();

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext ? authContext.userId : 'SYSTEM',
      ActorRole: authContext ? authContext.role : 'SUPER_ADMIN',
      WorkspaceID: 'MASTER',
      EntityType: 'SYSTEM',
      EntityID: 'SELF_HEAL',
      Action: 'SYSTEM_REPAIRED',
      Reason: `Self-healing repaired ${repairedTabs.length} tabs, rebuilt rollups for ${rollupsRebuilt.length} workspaces, and reconciled scheduled security jobs.`
    });

    return {
      ok: true,
      repairedTabs,
      rollupsRebuilt,
      triggerStatus,
      message: `Self-healing completed: ${repairedTabs.length} schema corrections applied, rollups synchronized across ${rollupsRebuilt.length} workspaces, and required scheduled jobs reconciled.`
    };
  },

  /**
   * Advanced Diagnostics for Super Admin
   */
  getAdvancedDiagnostics(authContext) {
    if (authContext) AuthorizationService.assertRole(authContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const masterSs = MasterRepository.getMasterSpreadsheet();
    const workspaces = MasterRepository.listWorkspaces();

    const wsDetails = workspaces.map(w => {
      let sheetOk = false;
      let totalMembers = 0;
      let totalEntries = 0;
      try {
        const wss = WorkspaceRouter.resolveSpreadsheet(w.WorkspaceID);
        sheetOk = !!wss;
        const memSheet = wss.getSheetByName(CONSTANTS.WORKSPACE_TABS.MEMBERS);
        if (memSheet) totalMembers = Math.max(0, memSheet.getLastRow() - 1);
        const entriesSheet = wss.getSheetByName(CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
        if (entriesSheet) totalEntries = Math.max(0, entriesSheet.getLastRow() - 1);
      } catch (e) {}

      return {
        workspaceId: w.WorkspaceID,
        name: w.WorkspaceName,
        spreadsheetId: w.SpreadsheetID,
        status: w.Status,
        timezone: w.Timezone,
        sheetConnected: sheetOk,
        memberCount: totalMembers,
        timeEntryCount: totalEntries
      };
    });

    const activeSessions = MasterRepository.listActiveSessions();
    const triggerStatus = JobService.getScheduledTriggerStatus();

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSpreadsheetId: masterSs.getId ? masterSs.getId() : 'mock_master',
      masterSpreadsheetUrl: masterSs.getUrl ? masterSs.getUrl() : '',
      workspaces: wsDetails,
      activeSessionsCount: activeSessions.length,
      triggersHealthy: triggerStatus.healthy === true,
      triggerStatus,
      timestampUTC: new Date().toISOString()
    };
  }
};

/* ===== IntegrityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Data Integrity & Automated Audit Engine
 * Runs measured integrity checks and records the result in SystemHealthHistory.
 */

var IntegrityService = (typeof global !== 'undefined' && global.IntegrityService) || {
  runNightlyAudit() {
    const checks = [];
    const timestamp = new Date().toISOString();
    let activeTimerCount = 0;

    const addCheck = (id, name, passed, detail) => {
      checks.push({ id, name, passed: passed === true, detail: String(detail || '') });
    };

    let accounts = [];
    let accessRows = [];
    let workspaces = [];
    try {
      accounts = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS).rows || [];
      accessRows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.WORKSPACE_ACCESS).rows || [];
      workspaces = MasterRepository.listWorkspaces() || [];
    } catch (e) {
      addCheck('master_reference_load', 'Master Reference Data Load', false, e.message);
    }

    const accountMap = new Map(accounts.map(a => [a.UserID, a]));
    const workspaceMap = new Map(workspaces.map(w => [w.WorkspaceID, w]));
    const activeWorkspaces = workspaces.filter(w => w.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE);

    // 1. Unique usernames
    try {
      const seen = new Set();
      const duplicates = new Set();
      for (const account of accounts) {
        const username = String(account.Username || '').trim().toLowerCase();
        if (!username) continue;
        if (seen.has(username)) duplicates.add(username);
        seen.add(username);
      }
      addCheck(
        'unique_usernames',
        'Unique Usernames Invariant',
        duplicates.size === 0,
        duplicates.size === 0 ? 'All usernames are unique' : `Duplicates: ${[...duplicates].join(', ')}`
      );
    } catch (e) {
      addCheck('unique_usernames', 'Unique Usernames Invariant', false, e.message);
    }

    // 2. Admin max-workspace rule
    try {
      const violations = [];
      for (const admin of accounts.filter(a => a.Role === CONSTANTS.ROLES.ADMIN)) {
        const activeCount = accessRows.filter(r =>
          r.UserID === admin.UserID &&
          (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
        ).length;
        if (activeCount > CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
          violations.push(`${admin.Username}: ${activeCount}`);
        }
      }
      addCheck(
        'admin_workspace_limit',
        'Admin Workspace Limit Invariant',
        violations.length === 0,
        violations.length === 0 ? 'All Admin assignments are within configured limit' : violations.join('; ')
      );
    } catch (e) {
      addCheck('admin_workspace_limit', 'Admin Workspace Limit Invariant', false, e.message);
    }

    // 3. Master schema tabs
    try {
      const masterSs = MasterRepository.getMasterSpreadsheet();
      const expectedTabs = Object.values(CONSTANTS.MASTER_TABS);
      const missing = expectedTabs.filter(tab => !masterSs.getSheetByName(tab));
      addCheck(
        'master_tabs',
        'Master Control Schema',
        missing.length === 0,
        missing.length === 0 ? `All ${expectedTabs.length} master tabs exist` : `Missing: ${missing.join(', ')}`
      );
    } catch (e) {
      addCheck('master_tabs', 'Master Control Schema', false, e.message);
    }

    // 4. Workspace tabs
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
        const missing = Object.values(CONSTANTS.WORKSPACE_TABS).filter(tab => !ss.getSheetByName(tab));
        if (missing.length) issues.push(`${ws.WorkspaceName}: ${missing.join(', ')}`);
      }
      addCheck(
        'workspace_tabs',
        'Workspace Schema Tabs',
        issues.length === 0,
        issues.length === 0 ? `${activeWorkspaces.length} active workspace(s) have all required tabs` : issues.join('; ')
      );
    } catch (e) {
      addCheck('workspace_tabs', 'Workspace Schema Tabs', false, e.message);
    }

    // 5. WorkspaceInfo/schema-version consistency
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const rows = SheetRepository.getTableData(
          ws.WorkspaceID,
          CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO
        ).rows || [];
        if (rows.length !== 1) {
          issues.push(`${ws.WorkspaceName}: expected one WorkspaceInfo row, found ${rows.length}`);
          continue;
        }
        const info = rows[0];
        if (String(info.WorkspaceID) !== String(ws.WorkspaceID)) {
          issues.push(`${ws.WorkspaceName}: WorkspaceID mismatch`);
        }
        if (String(info.SchemaVersion) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: schema v${info.SchemaVersion}, expected v${CONSTANTS.SCHEMA_VERSION}`);
        }
        if (String(ws.SchemaVersion || CONSTANTS.SCHEMA_VERSION) !== String(CONSTANTS.SCHEMA_VERSION)) {
          issues.push(`${ws.WorkspaceName}: registry schema v${ws.SchemaVersion}`);
        }
      }
      addCheck(
        'schema_version',
        'Schema Version Consistency',
        issues.length === 0,
        issues.length === 0 ? `All active workspaces are on schema v${CONSTANTS.SCHEMA_VERSION}` : issues.join('; ')
      );
    } catch (e) {
      addCheck('schema_version', 'Schema Version Consistency', false, e.message);
    }

    // 6. Active timer owner/access validity
    const allTimers = [];
    try {
      const issues = [];
      for (const ws of activeWorkspaces) {
        const allowedUsers = new Set(
          accessRows
            .filter(r =>
              r.WorkspaceID === ws.WorkspaceID &&
              (r.Active === true || r.Active === 'TRUE' || r.Active === 1)
            )
            .map(r => r.UserID)
        );
        const timers = SheetRepository.listActiveTimers(ws.WorkspaceID) || [];
        activeTimerCount += timers.length;
        for (const timer of timers) {
          allTimers.push({ ...timer, _workspaceId: ws.WorkspaceID });
          const account = accountMap.get(timer.UserID);
          if (!account || account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
            issues.push(`${timer.TimerID}: inactive/missing user ${timer.UserID}`);
          }
          if (!allowedUsers.has(timer.UserID)) {
            issues.push(`${timer.TimerID}: user lacks active workspace access`);
          }
          if (isNaN(new Date(timer.StartedAtUTC).getTime())) {
            issues.push(`${timer.TimerID}: invalid StartedAtUTC`);
          }
        }
      }
      addCheck(
        'active_timer_user_ref',
        'Active Timer Owner/Workspace Integrity',
        issues.length === 0,
        issues.length === 0 ? `${activeTimerCount} active timer(s) have valid owners/access` : issues.join('; ')
      );
    } catch (e) {
      addCheck('active_timer_user_ref', 'Active Timer Owner/Workspace Integrity', false, e.message);
    }

    // 7. One active timer globally per user
    try {
      const counts = new Map();
      for (const timer of allTimers) {
        counts.set(timer.UserID, (counts.get(timer.UserID) || 0) + 1);
      }
      const duplicates = [...counts.entries()].filter(([, count]) => count > 1);
      addCheck(
        'single_active_timer_invariant',
        'Single Active Timer Invariant',
        duplicates.length === 0,
        duplicates.length === 0
          ? 'No user has more than one active timer globally'
          : duplicates.map(([userId, count]) => `${userId}: ${count} timers`).join('; ')
      );
    } catch (e) {
      addCheck('single_active_timer_invariant', 'Single Active Timer Invariant', false, e.message);
    }

    // Cache workspace operational data for checks 8-15.
    const workspaceData = new Map();
    try {
      for (const ws of activeWorkspaces) {
        const entries = SheetRepository.getTableData(ws.WorkspaceID, CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES).rows || [];
        const projects = SheetRepository.listProjects(ws.WorkspaceID) || [];
        const tasks = SheetRepository.listTasks(ws.WorkspaceID) || [];
        const clients = SheetRepository.listClients(ws.WorkspaceID) || [];
        const tags = SheetRepository.listTags(ws.WorkspaceID) || [];
        const timesheets = SheetRepository.listTimesheets(ws.WorkspaceID, {}) || [];
        workspaceData.set(ws.WorkspaceID, { entries, projects, tasks, clients, tags, timesheets });
      }
    } catch (e) {
      addCheck('workspace_data_load', 'Workspace Integrity Data Load', false, e.message);
    }

    // 8. Start <= End
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end) || end < start) {
            issues.push(`${workspaceId}/${entry.EntryID}`);
          }
        }
      }
      addCheck(
        'entry_timestamps_order',
        'Time Entry Timestamp Ordering',
        issues.length === 0,
        issues.length === 0 ? 'All active entries have valid StartUTC <= EndUTC' : `Invalid entries: ${issues.join(', ')}`
      );
    } catch (e) {
      addCheck('entry_timestamps_order', 'Time Entry Timestamp Ordering', false, e.message);
    }

    // 9. Duration mathematical accuracy
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const start = new Date(entry.StartUTC).getTime();
          const end = new Date(entry.EndUTC).getTime();
          if (isNaN(start) || isNaN(end)) continue;
          const expected = Math.max(0, Math.round((end - start) / 1000));
          const stored = parseInt(entry.DurationSeconds, 10) || 0;
          if (Math.abs(expected - stored) > 1) {
            issues.push(`${workspaceId}/${entry.EntryID}: stored=${stored}, expected=${expected}`);
          }
        }
      }
      addCheck(
        'duration_calculation_accuracy',
        'Duration Mathematical Accuracy',
        issues.length === 0,
        issues.length === 0 ? 'All active entry durations match timestamp deltas' : issues.join('; ')
      );
    } catch (e) {
      addCheck('duration_calculation_accuracy', 'Duration Mathematical Accuracy', false, e.message);
    }

    // 10. Task -> Project integrity
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        for (const task of data.tasks) {
          if (!projectIds.has(task.ProjectID)) {
            issues.push(`${workspaceId}/${task.TaskID}: missing project ${task.ProjectID}`);
          }
        }
      }
      addCheck(
        'task_project_integrity',
        'Task to Project Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All tasks reference existing projects' : issues.join('; ')
      );
    } catch (e) {
      addCheck('task_project_integrity', 'Task to Project Referential Integrity', false, e.message);
    }

    // 11. TimeEntry project/task references
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const projectIds = new Set(data.projects.map(p => p.ProjectID));
        const taskMap = new Map(data.tasks.map(t => [t.TaskID, t]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          if (entry.ProjectID && !projectIds.has(entry.ProjectID)) {
            issues.push(`${workspaceId}/${entry.EntryID}: missing project ${entry.ProjectID}`);
          }
          if (entry.TaskID) {
            const task = taskMap.get(entry.TaskID);
            if (!task) issues.push(`${workspaceId}/${entry.EntryID}: missing task ${entry.TaskID}`);
            else if (entry.ProjectID && task.ProjectID !== entry.ProjectID) {
              issues.push(`${workspaceId}/${entry.EntryID}: task/project mismatch`);
            }
          }
        }
      }
      addCheck(
        'entry_project_reference',
        'Time Entry Project/Task Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All active entries reference valid project/task entities' : issues.join('; ')
      );
    } catch (e) {
      addCheck('entry_project_reference', 'Time Entry Project/Task Referential Integrity', false, e.message);
    }

    // 12. Submitted/approved entries must be locked and tied to matching timesheet state.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const timesheetMap = new Map(data.timesheets.map(ts => [ts.TimesheetID, ts]));
        for (const entry of data.entries.filter(e => e.Status !== 'DELETED')) {
          const approval = String(entry.ApprovalStatus || '');
          if (![CONSTANTS.TIMESHEET_STATUS.SUBMITTED, CONSTANTS.TIMESHEET_STATUS.APPROVED].includes(approval)) {
            continue;
          }
          const locked = entry.Locked === true || entry.Locked === 'TRUE' || entry.Locked === 1;
          if (!locked) issues.push(`${workspaceId}/${entry.EntryID}: ${approval} but unlocked`);
          const ts = timesheetMap.get(entry.TimesheetID);
          if (!ts) issues.push(`${workspaceId}/${entry.EntryID}: missing timesheet ${entry.TimesheetID}`);
          else if (String(ts.Status) !== approval) {
            issues.push(`${workspaceId}/${entry.EntryID}: entry=${approval}, timesheet=${ts.Status}`);
          }
        }
      }
      addCheck(
        'approved_entry_locking',
        'Timesheet Entry Lock/State Integrity',
        issues.length === 0,
        issues.length === 0 ? 'Submitted/approved entries are locked and match timesheet state' : issues.join('; ')
      );
    } catch (e) {
      addCheck('approved_entry_locking', 'Timesheet Entry Lock/State Integrity', false, e.message);
    }

    // 13. Aggregate rollups reconcile to active raw time.
    try {
      const issues = [];
      for (const [workspaceId, data] of workspaceData.entries()) {
        const rawSeconds = data.entries
          .filter(e => e.Status !== 'DELETED')
          .reduce((sum, e) => sum + (parseInt(e.DurationSeconds, 10) || 0), 0);
        for (const tab of [
          CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
          CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
        ]) {
          const rows = SheetRepository.getTableData(workspaceId, tab).rows || [];
          const aggregate = rows.reduce((sum, r) => sum + (parseInt(r.TotalSeconds, 10) || 0), 0);
          if (aggregate !== rawSeconds) {
            issues.push(`${workspaceId}/${tab}: raw=${rawSeconds}, rollup=${aggregate}`);
          }
        }
      }
      addCheck(
        'rollups_reconciliation',
        'Rollup to Raw Entry Reconciliation',
        issues.length === 0,
        issues.length === 0 ? 'Daily, weekly, and monthly totals match active raw time' : issues.join('; ')
      );
    } catch (e) {
      addCheck('rollups_reconciliation', 'Rollup to Raw Entry Reconciliation', false, e.message);
    }

    // 14. WorkspaceAccess referential/role integrity
    try {
      const issues = [];
      for (const access of accessRows) {
        const account = accountMap.get(access.UserID);
        const ws = workspaceMap.get(access.WorkspaceID);
        if (!account) issues.push(`${access.AccessID}: missing user ${access.UserID}`);
        if (!ws) issues.push(`${access.AccessID}: missing workspace ${access.WorkspaceID}`);
        if (account && access.Role && access.Role !== account.Role) {
          issues.push(`${access.AccessID}: ACL role ${access.Role} != account role ${account.Role}`);
        }
        const active = access.Active === true || access.Active === 'TRUE' || access.Active === 1;
        if (active && ws && ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
          issues.push(`${access.AccessID}: active ACL points to ${ws.Status} workspace`);
        }
      }
      addCheck(
        'access_orphans',
        'Workspace Access Referential Integrity',
        issues.length === 0,
        issues.length === 0 ? 'All ACL records reference valid users/workspaces with matching roles' : issues.join('; ')
      );
    } catch (e) {
      addCheck('access_orphans', 'Workspace Access Referential Integrity', false, e.message);
    }

    // 15. Entity ID uniqueness across master and active workspaces
    try {
      const seen = new Map();
      const duplicates = [];
      const register = (id, location) => {
        const value = String(id || '').trim();
        if (!value) return;
        if (seen.has(value)) duplicates.push(`${value}: ${seen.get(value)} + ${location}`);
        else seen.set(value, location);
      };

      accounts.forEach(a => register(a.UserID, 'Accounts'));
      workspaces.forEach(w => register(w.WorkspaceID, 'Workspaces'));
      for (const [workspaceId, data] of workspaceData.entries()) {
        data.clients.forEach(x => register(x.ClientID, `${workspaceId}/Clients`));
        data.projects.forEach(x => register(x.ProjectID, `${workspaceId}/Projects`));
        data.tasks.forEach(x => register(x.TaskID, `${workspaceId}/Tasks`));
        data.tags.forEach(x => register(x.TagID, `${workspaceId}/Tags`));
        data.entries.forEach(x => register(x.EntryID, `${workspaceId}/TimeEntries`));
        data.timesheets.forEach(x => register(x.TimesheetID, `${workspaceId}/Timesheets`));
      }

      addCheck(
        'unique_entity_ids',
        'Entity ID Uniqueness',
        duplicates.length === 0,
        duplicates.length === 0 ? `${seen.size} entity IDs verified unique` : duplicates.join('; ')
      );
    } catch (e) {
      addCheck('unique_entity_ids', 'Entity ID Uniqueness', false, e.message);
    }

    // 16. Capacity across Master + all active workspaces
    let worstCapacityStatus = 'HEALTHY';
    let totalCellCount = 0;
    try {
      const metrics = [JobService.getCapacityMetrics()];
      for (const ws of activeWorkspaces) metrics.push(JobService.getCapacityMetrics(ws.WorkspaceID));
      totalCellCount = metrics.reduce((sum, m) => sum + (m.totalCells || 0), 0);
      const critical = metrics.filter(m => m.alertStatus === 'CRITICAL');
      const warning = metrics.filter(m => m.alertStatus === 'WARNING');
      const advisory = metrics.filter(m => m.alertStatus === 'ADVISORY');
      if (critical.length) worstCapacityStatus = 'CRITICAL';
      else if (warning.length) worstCapacityStatus = 'WARNING';
      else if (advisory.length) worstCapacityStatus = 'ADVISORY';

      addCheck(
        'cell_capacity_limit',
        'Google Sheets Cell Capacity',
        critical.length === 0,
        critical.length === 0
          ? `Capacity status ${worstCapacityStatus}; total used cells across checked spreadsheets: ${totalCellCount}`
          : `Critical capacity: ${critical.map(m => `${m.spreadsheetName} ${m.utilizationPct}%`).join(', ')}`
      );
    } catch (e) {
      addCheck('cell_capacity_limit', 'Google Sheets Cell Capacity', false, e.message);
      worstCapacityStatus = 'UNKNOWN';
    }

    const passCount = checks.filter(c => c.passed).length;
    const failCount = checks.length - passCount;
    const overallStatus = failCount === 0
      ? 'HEALTHY'
      : (checks.some(c => c.id === 'cell_capacity_limit' && !c.passed) ? 'CRITICAL' : 'WARNING');

    try {
      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.SYSTEM_HEALTH_HISTORY, {
        HealthCheckID: Validation.generateId('CHK'),
        TimestampUTC: timestamp,
        OverallStatus: overallStatus,
        MasterDbStatus: checks.find(c => c.id === 'master_tabs')?.passed ? 'OK' : 'ERROR',
        WorkspacesStatus: checks.find(c => c.id === 'workspace_tabs')?.passed ? 'OK' : 'ERROR',
        ActiveTimersCount: activeTimerCount,
        CellCountApprox: totalCellCount,
        QuotaStatus: worstCapacityStatus,
        DetailsJSON: JSON.stringify({ passCount, failCount, checks })
      });
    } catch (e) {
      console.error('Failed to record SystemHealthHistory: ' + e.message);
    }

    return {
      ok: true,
      timestampUTC: timestamp,
      overallStatus,
      totalChecks: checks.length,
      passCount,
      failCount,
      checks
    };
  }
};

/* ===== JobService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Job Engine, Trigger Dispatcher & Capacity Monitor
 * Manages chunked long-running background tasks with cursor persistence,
 * central trigger dispatchers, and Google Sheets 10M cell capacity tracking.
 */

var JobService = (typeof global !== 'undefined' && global.JobService) || {
  _scheduledTriggerSpecs: [
    { handler: 'scheduledHousekeeping_', hour: 1, purpose: 'Expired session cleanup' },
    { handler: 'scheduledRollups_', hour: 2, purpose: 'Rollup reconciliation' },
    { handler: 'scheduledAuditCheckpoints_', hour: 3, purpose: 'Audit checkpoint anchoring' }
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

    const projectTriggers = ScriptApp.getProjectTriggers();
    const legacyHandlers = new Set(['scheduledHousekeeping', 'scheduledRollups']);
    const removedLegacy = [];
    for (const trigger of projectTriggers) {
      const handler = trigger.getHandlerFunction ? trigger.getHandlerFunction() : '';
      if (legacyHandlers.has(handler) && ScriptApp.deleteTrigger) {
        ScriptApp.deleteTrigger(trigger);
        removedLegacy.push(handler);
      }
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
      removedLegacy,
      ...status
    };
  },

  _beginJobExecution() {
    if (typeof MasterRepository !== 'undefined' && MasterRepository.beginRequest) {
      MasterRepository.beginRequest();
    }
    if (typeof Flags !== 'undefined' && Flags.beginRequest) {
      Flags.beginRequest();
    }
    if (typeof SheetRepository !== 'undefined' && SheetRepository.beginRequest) {
      SheetRepository.beginRequest();
    }
    if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
      WorkspaceRouter.clearCache();
    }
    if (typeof TimezoneService !== 'undefined' && TimezoneService.beginRequest) {
      TimezoneService.beginRequest();
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
    let purgedMfaEnrollmentsCount = 0;
    let purgedStepUpsCount = 0;
    let purgedCheckpointsCount = 0;

    try {
      const { rows: sessions } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.SESSIONS);
      const { rows: accounts } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.ACCOUNTS);
      const accountEpochs = {};
      accounts.forEach(account => {
        accountEpochs[account.UserID] =
          Number(account.SessionEpoch) > 0 ? Number(account.SessionEpoch) : 1;
      });
      const now = Date.now();
      const nowIso = new Date().toISOString();
      const retentionMs =
        (CONSTANTS.LIMITS.SESSION_RETENTION_DAYS || 30) * 24 * 3600 * 1000;
      const retentionCutoff = now - retentionMs;

      for (const s of sessions) {
        const expiresMs = new Date(s.ExpiresAt).getTime();
        const revoked =
          s.Revoked === true || s.Revoked === 'TRUE' || s.Revoked === 1;

        const sessionEpoch = Number(s.AccountEpoch) > 0 ? Number(s.AccountEpoch) : 1;
        const currentEpoch = accountEpochs[s.UserID];
        const epochRevoked = currentEpoch === undefined || sessionEpoch !== currentEpoch;

        if (!revoked && (epochRevoked || (!isNaN(expiresMs) && expiresMs <= now))) {
          MasterRepository.updateRow(CONSTANTS.MASTER_TABS.SESSIONS, s._rowIndex, {
            Revoked: true,
            RevokedAt: nowIso,
            RevokeReason: epochRevoked ? 'ACCOUNT_EPOCH_REVOKED' : 'EXPIRED_IDLE_TIMEOUT'
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

      // Delete contiguous row groups from highest to lowest so row shifts
      // never invalidate a later group. This keeps service calls bounded by
      // fragmentation rather than by the number of retained sessions.
      for (let i = 0; i < purgeRows.length;) {
        let high = purgeRows[i]._rowIndex;
        let low = high;
        let count = 1;
        let j = i + 1;
        while (
          j < purgeRows.length &&
          purgeRows[j]._rowIndex === low - 1
        ) {
          low = purgeRows[j]._rowIndex;
          count++;
          j++;
        }
        MasterRepository.deleteRows(
          CONSTANTS.MASTER_TABS.SESSIONS,
          low,
          count
        );
        purgedSessionsCount += count;
        i = j;
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
          if (key.startsWith('FLINK_MFA_CHALLENGE_')) {
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
            continue;
          }

          if (key.startsWith('FLINK_MFA_ENROLLMENT_')) {
            let expired = false;
            try {
              const enrollment = JSON.parse(raw);
              expired = Number(enrollment.expiresAtMs || 0) < now;
            } catch (e) {
              expired = true;
            }
            if (expired) {
              props.deleteProperty(key);
              purgedMfaEnrollmentsCount++;
              const userId = key.substring('FLINK_MFA_ENROLLMENT_'.length);
              try {
                const cred = MasterRepository.getCredentials(userId);
                if (cred && cred.PendingTotpSecret) {
                  MasterRepository.updateCredentials(userId, { PendingTotpSecret: '' });
                }
              } catch (cleanupErr) {}
            }
            continue;
          }

          if (key.startsWith('FLINK_STEP_UP_')) {
            let expired = false;
            try {
              const stepUp = JSON.parse(raw);
              expired = Number(stepUp.expiresAtMs || 0) < now;
            } catch (e) {
              expired = true;
            }
            if (expired) {
              props.deleteProperty(key);
              purgedStepUpsCount++;
            }
            continue;
          }

          const checkpointPrefix =
            (CONSTANTS.SECURITY && CONSTANTS.SECURITY.CHECKPOINT_PROPERTY_PREFIX) ||
            'FLINK_AUDIT_CHECKPOINT_';
          if (key.startsWith(checkpointPrefix)) {
            const checkpointRetentionDays =
              (CONSTANTS.LIMITS && CONSTANTS.LIMITS.AUDIT_CHECKPOINT_RETENTION_DAYS) || 90;
            const checkpointCutoffMs =
              now - checkpointRetentionDays * 24 * 3600 * 1000;
            let expired = false;
            try {
              const cp = JSON.parse(raw);
              const cpDate = new Date(cp.date || cp.checkpointAt || '').getTime();
              expired = !isNaN(cpDate) && cpDate < checkpointCutoffMs;
            } catch (e) {
              expired = true;
            }
            if (expired) {
              props.deleteProperty(key);
              purgedCheckpointsCount++;
            }
          }
        }
      }

      // Auto-stop runaway active timers older than AUTO_STOP_HOURS
      let autoStoppedTimersCount = 0;
      try {
        if (typeof TimerService !== 'undefined' && TimerService.autoStopRunawayTimers) {
          const autoStopRes = TimerService.autoStopRunawayTimers(new Date(startMs));
          autoStoppedTimersCount = (autoStopRes && autoStopRes.stoppedCount) || 0;
        }
      } catch (autoStopErr) {
        console.warn('Runaway timer auto-stop notice: ' + autoStopErr.message);
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
          expiredSessionsCount + purgedSessionsCount + purgedMfaChallengesCount +
          purgedMfaEnrollmentsCount + purgedStepUpsCount + purgedCheckpointsCount +
          autoStoppedTimersCount,
        Status: CONSTANTS.JOB_STATUS.COMPLETED,
        LogDetails:
          `Housekeeping revoked ${expiredSessionsCount} expired sessions, purged ${purgedSessionsCount} retained session rows, removed ${purgedMfaChallengesCount} stale MFA challenges, ${purgedMfaEnrollmentsCount} stale MFA enrollments, ${purgedStepUpsCount} expired step-up grants, ${purgedCheckpointsCount} stale audit checkpoints, and auto-stopped ${autoStoppedTimersCount} runaway timers.`
      });

      return {
        ok: true,
        expiredSessionsCount,
        purgedSessionsCount,
        purgedMfaChallengesCount,
        purgedMfaEnrollmentsCount,
        purgedStepUpsCount,
        purgedCheckpointsCount,
        autoStoppedTimersCount
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

  dispatchAuditCheckpoints() {
    this._beginJobExecution();
    const runId = Validation.generateId('RUN');
    const startMs = Date.now();
    const results = [];

    const scopes = [{ workspaceId: null, label: 'MASTER' }];
    for (const ws of MasterRepository.listWorkspaces()) {
      if (ws.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        scopes.push({ workspaceId: ws.WorkspaceID, label: ws.WorkspaceID });
      }
    }

    for (const scope of scopes) {
      try {
        const checkpoint = AuditService.createAuditCheckpoint(scope.workspaceId);
        results.push({ scope: scope.label, ok: true, checkpoint });
      } catch (err) {
        results.push({
          scope: scope.label,
          ok: false,
          error: String(err && err.message ? err.message : err)
        });
      }
    }

    const allOk = results.every(result => result.ok);
    this.logJobRun({
      RunID: runId,
      JobID: 'JOB_AUDIT_CHECKPOINTS',
      JobType: 'AUDIT_CHECKPOINT',
      WorkspaceID: 'ALL',
      StartedAt: new Date(startMs).toISOString(),
      EndedAt: new Date().toISOString(),
      DurationMs: Date.now() - startMs,
      ItemsProcessed: results.length,
      Status: allOk ? CONSTANTS.JOB_STATUS.COMPLETED : CONSTANTS.JOB_STATUS.FAILED,
      LogDetails: `Anchored audit checkpoints for ${results.filter(r => r.ok).length}/${results.length} scopes.`
    });

    if (!allOk) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'One or more audit checkpoint scopes could not be anchored.',
        500
      );
    }
    return { ok: true, scopesProcessed: results.length, details: results };
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

function scheduledHousekeeping_() {
  return JobService.dispatchHousekeeping();
}

function scheduledRollups_() {
  return JobService.dispatchRollups();
}

function scheduledAuditCheckpoints_() {
  return JobService.dispatchAuditCheckpoints();
}

/* ===== BackupAndAuditServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Backup, Audit & Notification Services
 * Automated Drive snapshot backups, disaster recovery validation, and immutable audit logs.
 */

var BackupService = (typeof global !== 'undefined' && global.BackupService) || {
  _manifestHmac(payload) {
    const key = SecurityService.getPepper() + '_FLINK_BACKUP_MANIFEST';
    const bytes = SecurityService.hmacSha256(key, JSON.stringify(payload));
    return Array.from(bytes)
      .map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0'))
      .join('');
  },

  _expectedSchema(scope) {
    return scope === 'MASTER' ? MASTER_SCHEMA : WORKSPACE_SCHEMA;
  },

  _buildManifest(spreadsheet, scope, workspaceId = '') {
    if (!spreadsheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup spreadsheet could not be opened.', 400);
    }

    const expectedSchema = this._expectedSchema(scope);
    const sheetSummaries = [];

    for (const [tabName, expectedHeaders] of Object.entries(expectedSchema)) {
      const sheet = spreadsheet.getSheetByName(tabName);
      if (!sheet) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Backup is missing required tab '${tabName}'.`, 400);
      }
      if (sheet.getLastRow() < 1 || sheet.getLastColumn() < expectedHeaders.length) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Backup tab '${tabName}' has an invalid header row.`, 400);
      }

      const actualHeaders = sheet
        .getRange(1, 1, 1, expectedHeaders.length)
        .getValues()[0]
        .map(v => String(v).trim());

      for (let i = 0; i < expectedHeaders.length; i++) {
        if (actualHeaders[i] !== expectedHeaders[i]) {
          throw new AppError(
            ERROR_CODES.VALIDATION_ERROR,
            `Backup tab '${tabName}' schema mismatch at column ${i + 1}: expected '${expectedHeaders[i]}', found '${actualHeaders[i]}'.`,
            400
          );
        }
      }

      const rowCount = Math.max(0, sheet.getLastRow() - 1);
      let contentHash = SecurityService.hashToken(JSON.stringify(actualHeaders));

      // Hash data in bounded chunks to avoid building one huge in-memory JSON string.
      const chunkSize = 250;
      for (let offset = 0; offset < rowCount; offset += chunkSize) {
        const count = Math.min(chunkSize, rowCount - offset);
        const values = sheet
          .getRange(2 + offset, 1, count, expectedHeaders.length)
          .getValues();
        contentHash = SecurityService.hashToken(contentHash + '|' + JSON.stringify(values));
      }

      sheetSummaries.push({
        name: tabName,
        rows: rowCount,
        columns: expectedHeaders.length,
        contentHash
      });
    }

    if (scope === 'WORKSPACE') {
      const infoSheet = spreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.WORKSPACE_INFO);
      if (!infoSheet || infoSheet.getLastRow() < 2) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup WorkspaceInfo row is missing.', 400);
      }
      const info = infoSheet.getRange(2, 1, 1, WORKSPACE_SCHEMA.WorkspaceInfo.length).getValues()[0];
      if (String(info[0]) !== String(workspaceId)) {
        throw new AppError(
          ERROR_CODES.WORKSPACE_DENIED,
          `Backup belongs to workspace '${info[0] || 'UNKNOWN'}', not '${workspaceId}'.`,
          403
        );
      }
      if (String(info[5]) !== String(CONSTANTS.SCHEMA_VERSION)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          `Backup schema version ${info[5]} is incompatible with required version ${CONSTANTS.SCHEMA_VERSION}.`,
          400
        );
      }
    }

    const manifest = {
      scope,
      workspaceId: scope === 'WORKSPACE' ? workspaceId : 'MASTER',
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      sheetCount: sheetSummaries.length,
      sheets: sheetSummaries
    };

    return {
      ...manifest,
      manifestHash: this._manifestHmac(manifest)
    };
  },

  _validateWorkspaceRollupTotals(spreadsheet) {
    if (!spreadsheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Restore candidate spreadsheet is unavailable.', 400);
    }

    const entriesSheet = spreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.TIME_ENTRIES);
    if (!entriesSheet) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Restore candidate is missing TimeEntries.', 400);
    }

    const entryHeaders = WORKSPACE_SCHEMA.TimeEntries;
    const entryRows = Math.max(0, entriesSheet.getLastRow() - 1);
    let rawSeconds = 0;

    if (entryRows > 0) {
      const values = entriesSheet
        .getRange(2, 1, entryRows, entryHeaders.length)
        .getValues();
      const statusIdx = entryHeaders.indexOf('Status');
      const durationIdx = entryHeaders.indexOf('DurationSeconds');
      for (const row of values) {
        if (String(row[statusIdx] || '') === 'DELETED') continue;
        rawSeconds += parseInt(row[durationIdx], 10) || 0;
      }
    }

    const checked = {};
    for (const tab of [
      CONSTANTS.WORKSPACE_TABS.DAILY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.WEEKLY_ROLLUPS,
      CONSTANTS.WORKSPACE_TABS.MONTHLY_ROLLUPS
    ]) {
      const sheet = spreadsheet.getSheetByName(tab);
      const headers = WORKSPACE_SCHEMA[tab];
      if (!sheet || !headers) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Restore candidate is missing rollup tab ${tab}.`, 400);
      }

      const rowCount = Math.max(0, sheet.getLastRow() - 1);
      let total = 0;
      if (rowCount > 0) {
        const values = sheet.getRange(2, 1, rowCount, headers.length).getValues();
        const totalIdx = headers.indexOf('TotalSeconds');
        for (const row of values) total += parseInt(row[totalIdx], 10) || 0;
      }
      checked[tab] = total;

      if (total !== rawSeconds) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          `Restore candidate rollup mismatch in ${tab}: raw=${rawSeconds}s, rollup=${total}s.`,
          409
        );
      }
    }

    return { ok: true, rawSeconds, rollups: checked };
  },

  _getRegistryRecord(backupId) {
    if (!backupId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'backupId is required.', 400);
    }
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
    const record = rows.find(row => row.BackupID === backupId);
    if (!record) {
      throw new AppError(ERROR_CODES.NOT_FOUND, `Registered backup '${backupId}' was not found.`, 404);
    }
    return record;
  },

  _parseStoredManifest(record) {
    try {
      const metadata = JSON.parse(record.ChecksumMetadata || '{}');
      if (!metadata || !metadata.manifestHash || !Array.isArray(metadata.sheets)) {
        throw new Error('manifest fields missing');
      }
      return metadata;
    } catch (e) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup registry manifest is missing or malformed.', 400);
    }
  },

  _openBackupSpreadsheet(fileId) {
    if (!fileId) throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup file ID is missing.', 400);

    if (typeof DriveApp !== 'undefined' && DriveApp.getFileById) {
      let file;
      try {
        file = DriveApp.getFileById(fileId);
        if (file.isTrashed && file.isTrashed()) {
          throw new Error('file is in trash');
        }
      } catch (e) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Backup Drive file is unavailable: ' + e.message, 404);
      }
    }

    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.openById) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Spreadsheet service is unavailable.', 500);
    }

    try {
      return SpreadsheetApp.openById(fileId);
    } catch (e) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Backup file is not an accessible Google Spreadsheet: ' + e.message, 400);
    }
  },

  /**
   * Creates an immutable registered snapshot and records a pepper-keyed content manifest.
   */
  createBackup(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(30000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire backup lock. Please retry.', 409);
      }
    }

    try {
      return this._createBackupUnlocked(superAdminContext, workspaceId);
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  },

  /**
   * Internal snapshot implementation for callers that already own ScriptLock
   * (notably restore safety-backup creation).
   */
  _createBackupUnlocked(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const scope = workspaceId ? 'WORKSPACE' : 'MASTER';
    const timestamp = new Date().toISOString();
    const fileTimestamp = timestamp.replace(/[:.]/g, '-');
    let sourceSpreadsheetId = '';
    let backupPrefix = '';

    if (workspaceId) {
      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.WORKSPACE_DENIED, 'Only an active workspace can be backed up.', 403);
      }
      sourceSpreadsheetId = ws.SpreadsheetID;
      backupPrefix = `${ws.WorkspaceID}_${String(ws.WorkspaceName || 'Workspace').replace(/[^A-Za-z0-9_-]+/g, '_')}`;
    } else {
      const masterSs = MasterRepository.getMasterSpreadsheet();
      sourceSpreadsheetId = masterSs.getId();
      backupPrefix = 'MASTER_CONTROL_SHEET';
    }

    if (!sourceSpreadsheetId) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Backup source spreadsheet ID is missing.', 500);
    }

    const backupId = Validation.generateId('BKP');
    const backupFileName = `${backupPrefix}_BACKUP_${fileTimestamp}`;
    let backupFileId = '';

    try {
      if (typeof DriveApp === 'undefined' || !DriveApp.getFileById) {
        throw new Error('Drive service is unavailable');
      }
      const sourceFile = DriveApp.getFileById(sourceSpreadsheetId);
      const copy = sourceFile.makeCopy(backupFileName);
      backupFileId = copy.getId();

      const backupSpreadsheet = this._openBackupSpreadsheet(backupFileId);
      const manifest = this._buildManifest(backupSpreadsheet, scope, workspaceId || '');

      MasterRepository.appendRow(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY, {
        BackupID: backupId,
        Scope: scope,
        WorkspaceID: workspaceId || 'MASTER',
        SourceFileID: sourceSpreadsheetId,
        BackupFileID: backupFileId,
        CreatedAt: timestamp,
        Status: 'AVAILABLE',
        Verified: true,
        ChecksumMetadata: JSON.stringify(manifest)
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId || '',
        EntityType: 'BACKUP',
        EntityID: backupId,
        Action: CONSTANTS.AUDIT_EVENTS.BACKUP_CREATED,
        AfterJSON: {
          backupId,
          backupFileId,
          sourceSpreadsheetId,
          scope,
          manifestHash: manifest.manifestHash
        },
        Reason: 'Registered snapshot backup completed and verified'
      });

      return {
        ok: true,
        backupId,
        backupFileId,
        backupFileName,
        scope,
        workspaceId: workspaceId || 'MASTER',
        verified: true,
        manifestHash: manifest.manifestHash
      };
    } catch (e) {
      if (backupFileId) {
        try { DriveApp.getFileById(backupFileId).setTrashed(true); } catch (trashErr) {}
      }
      if (e instanceof AppError) throw e;
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Drive backup failed: ' + e.message, 500);
    }
  },

  createWorkspaceBackup(superAdminContext, workspaceId) {
    return this.createBackup(superAdminContext, workspaceId);
  },

  listBackups(superAdminContext, workspaceId = null) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const { rows } = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.BACKUP_REGISTRY);
    return rows
      .filter(row => {
        if (workspaceId) {
          return row.Scope === 'WORKSPACE' && String(row.WorkspaceID) === String(workspaceId);
        }
        return true;
      })
      .sort((a, b) => new Date(b.CreatedAt).getTime() - new Date(a.CreatedAt).getTime())
      .map(row => ({
        backupId: row.BackupID,
        scope: row.Scope,
        workspaceId: row.WorkspaceID,
        createdAt: row.CreatedAt,
        status: row.Status,
        verified: row.Verified === true || row.Verified === 'TRUE' || row.Verified === 1,
        sourceFileId: row.SourceFileID,
        backupFileId: row.BackupFileID
      }));
  },

  /**
   * Reopens and fully verifies a registered backup. Arbitrary Drive file IDs are rejected.
   */
  validateBackup(superAdminContext, workspaceId, backupId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!workspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId is required for workspace restore validation.', 400);
    }

    const ws = MasterRepository.getWorkspace(workspaceId);
    if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);

    const record = this._getRegistryRecord(backupId);
    if (record.Scope !== 'WORKSPACE' || String(record.WorkspaceID) !== String(workspaceId)) {
      throw new AppError(ERROR_CODES.WORKSPACE_DENIED, 'Backup is not registered for the requested workspace.', 403);
    }
    if (record.Status !== 'AVAILABLE' || !(record.Verified === true || record.Verified === 'TRUE' || record.Verified === 1)) {
      throw new AppError(ERROR_CODES.CONFLICT, 'Backup registry record is not in a verified AVAILABLE state.', 409);
    }

    const storedManifest = this._parseStoredManifest(record);
    const spreadsheet = this._openBackupSpreadsheet(record.BackupFileID);
    const currentManifest = this._buildManifest(spreadsheet, 'WORKSPACE', workspaceId);

    if (!SecurityService.constantTimeEquals(storedManifest.manifestHash, currentManifest.manifestHash)) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Backup content no longer matches its registered integrity manifest.',
        409
      );
    }

    return {
      ok: true,
      valid: true,
      backupId: record.BackupID,
      backupFileId: record.BackupFileID,
      workspaceId,
      schemaVersion: currentManifest.schemaVersion,
      manifestHash: currentManifest.manifestHash,
      createdAt: record.CreatedAt,
      message: 'Registered backup content and schema verified successfully.'
    };
  },

  /**
   * Restores a registered workspace backup through a new working copy.
   * The immutable backup file itself never becomes the live workspace.
   */
  restoreBackup(superAdminContext, workspaceId, backupId, adminPassword) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    if (!workspaceId || !backupId || !adminPassword) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'workspaceId, backupId, and Super Admin password are required for restore.', 400);
    }

    const credentials = MasterRepository.getCredentials(superAdminContext.userId);
    if (!credentials || !SecurityService.verifyPassword(adminPassword, credentials.PasswordHash)) {
      MasterRepository.logSecurityEvent({
        UserID: superAdminContext.userId,
        Username: superAdminContext.user ? superAdminContext.user.Username : '',
        EventType: 'RESTORE_REAUTH_FAILED',
        Success: false,
        metadata: { workspaceId, backupId }
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Super Admin password confirmation failed.', 401);
    }

    let scriptLock = null;
    if (typeof LockService !== 'undefined' && LockService.getScriptLock) {
      scriptLock = LockService.getScriptLock();
      if (!scriptLock.tryLock(30000)) {
        throw new AppError(ERROR_CODES.SERVER_BUSY, 'Could not acquire restore lock. Please retry.', 409);
      }
    }

    let previousSpreadsheetId = '';
    let candidateFileId = '';
    let workspaceWasQuiesced = false;

    try {
      const ws = MasterRepository.getWorkspace(workspaceId);
      if (!ws) throw new AppError(ERROR_CODES.NOT_FOUND, `Workspace ${workspaceId} not found.`, 404);
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
        throw new AppError(ERROR_CODES.WORKSPACE_DENIED, `Workspace must be ACTIVE before restore; current status is ${ws.Status}.`, 403);
      }
      previousSpreadsheetId = ws.SpreadsheetID;

      const validation = this.validateBackup(superAdminContext, workspaceId, backupId);
      const record = this._getRegistryRecord(backupId);

      // Safety snapshot of the currently live workspace before any pointer change.
      const safetyBackup = this._createBackupUnlocked(superAdminContext, workspaceId);

      const backupFile = DriveApp.getFileById(record.BackupFileID);
      const candidateName = `RESTORE_${workspaceId}_${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const candidateFile = backupFile.makeCopy(candidateName);
      candidateFileId = candidateFile.getId();

      const candidateSpreadsheet = this._openBackupSpreadsheet(candidateFileId);
      const candidateManifest = this._buildManifest(candidateSpreadsheet, 'WORKSPACE', workspaceId);
      if (!SecurityService.constantTimeEquals(validation.manifestHash, candidateManifest.manifestHash)) {
        throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Restore working copy failed integrity verification.', 409);
      }

      // Validate aggregate consistency while the candidate is still isolated.
      // A stale/corrupt rollup set is rejected rather than exposed live.
      const candidateRollupValidation = this._validateWorkspaceRollupTotals(candidateSpreadsheet);

      // Quiesce all normal workspace operations before changing the live pointer.
      MasterRepository.updateWorkspace(workspaceId, {
        Status: CONSTANTS.WORKSPACE_STATUS.MAINTENANCE,
        UpdatedAt: new Date().toISOString()
      });
      workspaceWasQuiesced = true;

      // Clear stale active timers directly on the candidate while it is still offline.
      const timersSheet = candidateSpreadsheet.getSheetByName(CONSTANTS.WORKSPACE_TABS.ACTIVE_TIMERS);
      if (timersSheet && timersSheet.getLastRow() > 1) {
        timersSheet.deleteRows(2, timersSheet.getLastRow() - 1);
      }

      MasterRepository.updateWorkspace(workspaceId, {
        SpreadsheetID: candidateFileId,
        Status: CONSTANTS.WORKSPACE_STATUS.MAINTENANCE,
        UpdatedAt: new Date().toISOString()
      });
      if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
        WorkspaceRouter.clearCache();
      }

      // Revoke all workspace-member sessions before reopening the restored dataset.
      const accesses = MasterRepository.getWorkspaceAccessForWorkspace(workspaceId);
      for (const access of accesses) {
        SessionService.revokeAllUserSessions(access.UserID);
      }

      // Commit ACTIVE only after candidate integrity, timer cleanup, pointer switch,
      // and session revocation have all succeeded. No normal request can observe
      // the candidate while it is still in MAINTENANCE.
      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        SpreadsheetApp.flush();
      }

      MasterRepository.updateWorkspace(workspaceId, {
        Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
        UpdatedAt: new Date().toISOString()
      });
      if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
        WorkspaceRouter.clearCache();
      }

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        WorkspaceID: workspaceId,
        EntityType: 'WORKSPACE',
        EntityID: workspaceId,
        Action: 'RESTORE_COMPLETED',
        BeforeJSON: { spreadsheetId: previousSpreadsheetId },
        AfterJSON: {
          spreadsheetId: candidateFileId,
          restoredBackupId: backupId,
          safetyBackupId: safetyBackup.backupId,
          candidateRollupValidation
        },
        Reason: 'Verified registered workspace restore applied through isolated working copy'
      });

      return {
        ok: true,
        workspaceId,
        backupId,
        safetyBackupId: safetyBackup.backupId,
        previousSpreadsheetId,
        restoredSpreadsheetId: candidateFileId,
        status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
        message: `Workspace ${workspaceId} restored from verified backup ${backupId}.`
      };
    } catch (err) {
      if (workspaceWasQuiesced && previousSpreadsheetId) {
        try {
          MasterRepository.updateWorkspace(workspaceId, {
            SpreadsheetID: previousSpreadsheetId,
            Status: CONSTANTS.WORKSPACE_STATUS.ACTIVE,
            UpdatedAt: new Date().toISOString()
          });
          if (typeof WorkspaceRouter !== 'undefined' && WorkspaceRouter.clearCache) {
            WorkspaceRouter.clearCache();
          }
        } catch (rollbackErr) {
          console.error('Restore rollback failed: ' + rollbackErr.message);
        }
      }

      if (candidateFileId) {
        try { DriveApp.getFileById(candidateFileId).setTrashed(true); } catch (trashErr) {}
      }

      try {
        MasterRepository.logGlobalAudit({
          ActorUserID: superAdminContext.userId,
          ActorRole: superAdminContext.role,
          WorkspaceID: workspaceId,
          EntityType: 'WORKSPACE',
          EntityID: workspaceId,
          Action: 'RESTORE_FAILED',
          BeforeJSON: { spreadsheetId: previousSpreadsheetId },
          AfterJSON: { backupId, candidateFileId },
          Reason: err && err.message ? err.message : 'Restore failed'
        });
      } catch (auditErr) {}

      if (err instanceof AppError) throw err;
      throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Restore failed and was rolled back: ' + err.message, 500);
    } finally {
      if (scriptLock) {
        try { scriptLock.releaseLock(); } catch (e) {}
      }
    }
  }
};

var AuditService = (typeof global !== 'undefined' && global.AuditService) || {
  log(authContext, workspaceId, entityType, entityId, action, beforeData = null, afterData = null, reason = '') {
    return this.logEvent(authContext, workspaceId, entityType, entityId, action, beforeData, afterData, reason);
  },

  /**
   * Universal audit logger
   */
  logEvent(authContext, workspaceId, entityType, entityId, action, beforeData, afterData, reason) {
    if (workspaceId) {
      try {
        SheetRepository.logWorkspaceAudit(workspaceId, {
          ActorUserID: authContext ? authContext.userId : 'SYSTEM',
          ActorRole: authContext ? authContext.role : 'SYSTEM',
          EntityType: entityType,
          EntityID: entityId,
          Action: action,
          BeforeJSON: beforeData,
          AfterJSON: afterData,
          Reason: reason,
          ClientType: 'WEB'
        });
      } catch (e) {
        console.warn('Workspace audit log notice: ' + e.message);
      }
    }

    try {
      MasterRepository.logGlobalAudit({
        ActorUserID: authContext ? authContext.userId : 'SYSTEM',
        ActorRole: authContext ? authContext.role : 'SYSTEM',
        WorkspaceID: workspaceId || '',
        EntityType: entityType,
        EntityID: entityId,
        Action: action,
        BeforeJSON: beforeData,
        AfterJSON: afterData,
        Reason: reason,
        ClientType: 'WEB'
      });
    } catch (e) {
      console.warn('Global audit log notice: ' + e.message);
    }
  },

  _computeSnapshotHash(rows, count = null) {
    const take = count === null ? rows.length : Math.max(0, Number(count) || 0);
    const normalized = (rows || []).slice(0, take).map(row => ({
      AuditID: String(row.AuditID || ''),
      TimestampUTC: String(row.TimestampUTC || ''),
      ActorUserID: String(row.ActorUserID || ''),
      ActorRole: String(row.ActorRole || ''),
      WorkspaceID: String(row.WorkspaceID || ''),
      EntityType: String(row.EntityType || ''),
      EntityID: String(row.EntityID || ''),
      Action: String(row.Action || ''),
      BeforeJSON: typeof row.BeforeJSON === 'object' ? JSON.stringify(row.BeforeJSON) : String(row.BeforeJSON || ''),
      AfterJSON: typeof row.AfterJSON === 'object' ? JSON.stringify(row.AfterJSON) : String(row.AfterJSON || ''),
      Reason: String(row.Reason || ''),
      CorrelationID: String(row.CorrelationID || ''),
      ClientType: String(row.ClientType || ''),
      PreviousHash: String(row.PreviousHash || ''),
      RecordHash: String(row.RecordHash || '')
    }));
    return SecurityService.computeAuditHash('SNAPSHOT', normalized);
  },

  requirePrivilegedActionAudit(authContext, action, workspaceId = '') {
    const ok = MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: workspaceId || 'MASTER',
      EntityType: 'PRIVILEGED_ACTION',
      EntityID: action,
      Action: 'PRIVILEGED_ACTION_AUTHORIZED',
      Reason: 'Fresh step-up authentication verified before privileged mutation'
    });
    if (!ok) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Security audit trail is unavailable. Privileged action blocked.',
        503
      );
    }
    return true;
  },

  /**
   * Creates an external, tamper-evident checkpoint root hash for the audit trail.
   * Stored outside Google Sheets in ScriptProperties (inaccessible to spreadsheet editors).
   */
  createAuditCheckpoint(workspaceId = null) {
    const verification = this.verifyAuditChain(workspaceId);
    if (!verification.ok || !verification.verified) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Cannot create checkpoint on unverified audit chain: ' + verification.message, 500);
    }

    const scope = workspaceId || 'MASTER';
    const dateStr = new Date().toISOString().split('T')[0];
    const lastHash = verification.lastRecordHash || 'GENESIS';
    const rootHash = SecurityService.computeAuditCheckpoint(scope, dateStr, lastHash, verification.count);
    const rows = workspaceId
      ? (SheetRepository.getTableData(workspaceId, CONSTANTS.WORKSPACE_TABS.AUDIT_LOG).rows || [])
      : (MasterRepository.getTableData(CONSTANTS.MASTER_TABS.GLOBAL_AUDIT).rows || []);
    const snapshotHash = this._computeSnapshotHash(rows, verification.count);

    const checkpointKey = (CONSTANTS.SECURITY.CHECKPOINT_PROPERTY_PREFIX || 'FLINK_AUDIT_CHECKPOINT_') + `${scope}_${dateStr}`;

    if (typeof PropertiesService === 'undefined' || !PropertiesService.getScriptProperties) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Audit checkpoint storage is unavailable.',
        500
      );
    }
    try {
      PropertiesService.getScriptProperties().setProperty(checkpointKey, JSON.stringify({
        scope,
        date: dateStr,
        lastHash,
        count: verification.count,
        rootHash,
        snapshotHash,
        checkpointAt: new Date().toISOString()
      }));
    } catch (e) {
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Audit checkpoint could not be persisted.',
        500
      );
    }

    return {
      ok: true,
      scope,
      date: dateStr,
      rootHash,
      snapshotHash,
      count: verification.count,
      lastHash,
      checkpointKey
    };
  },

  /**
   * Verifies the cryptographic integrity of the HMAC-SHA256 hash chain in an audit log
   * and cross-checks against any stored external root hash checkpoints.
   */
  verifyAuditChain(workspaceId = null) {
    let rows = [];
    let scopeName = '';
    const scope = workspaceId || 'MASTER';
    if (workspaceId) {
      scopeName = `Workspace (${workspaceId})`;
      rows = SheetRepository.getTableData(
        workspaceId,
        CONSTANTS.WORKSPACE_TABS.AUDIT_LOG
      ).rows || [];
    } else {
      scopeName = 'Master GlobalAudit';
      rows = MasterRepository.getTableData(
        CONSTANTS.MASTER_TABS.GLOBAL_AUDIT
      ).rows || [];
    }

    let previousHash =
      '0000000000000000000000000000000000000000000000000000000000000000';

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      if (!row.AuditID || !row.TimestampUTC || !row.PreviousHash || !row.RecordHash) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID || '',
          message:
            `Audit chain is incomplete at record index ${i}: required identity/timestamp/hash fields are missing.`
        };
      }

      if (!SecurityService.constantTimeEquals(String(row.PreviousHash), String(previousHash))) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID,
          expectedPreviousHash: previousHash,
          actualPreviousHash: row.PreviousHash,
          message:
            `Audit chain broken at record index ${i} (${row.AuditID}). Previous hash mismatch.`
        };
      }

      let expectedRecordHash = '';
      if (String(row.RecordHash).startsWith('v2:')) {
        if (
          !SecurityService.buildAuditPayloadV2 ||
          !SecurityService.computeAuditRecordHashV2
        ) {
          return {
            ok: false,
            verified: false,
            brokenAtIndex: i,
            auditId: row.AuditID,
            message: 'Audit v2 verification support is unavailable.'
          };
        }
        expectedRecordHash = SecurityService.computeAuditRecordHashV2(
          row.PreviousHash,
          row,
          workspaceId || row.WorkspaceID || ''
        );
      } else {
        // Backward-compatible verification for records created before audit v2.
        const legacyPayload = {
          auditId: row.AuditID,
          timestamp: row.TimestampUTC,
          actor: row.ActorUserID || '',
          action: row.Action,
          entityType: row.EntityType,
          entityId: row.EntityID,
          after: typeof row.AfterJSON === 'object'
            ? JSON.stringify(row.AfterJSON)
            : (row.AfterJSON || '')
        };
        expectedRecordHash = SecurityService.computeAuditHash(
          row.PreviousHash,
          legacyPayload
        );
      }

      if (!SecurityService.constantTimeEquals(expectedRecordHash, row.RecordHash)) {
        return {
          ok: false,
          verified: false,
          brokenAtIndex: i,
          auditId: row.AuditID,
          message:
            `Tamper detected: Record HMAC mismatch at record index ${i} (${row.AuditID}).`
        };
      }
      previousHash = row.RecordHash;
    }

    let checkpointVerified = false;
    const checkpointInfo = [];
    if (
      typeof PropertiesService !== 'undefined' &&
      PropertiesService.getScriptProperties
    ) {
      try {
        const props = PropertiesService.getScriptProperties();
        const prefix =
          (CONSTANTS.SECURITY.CHECKPOINT_PROPERTY_PREFIX ||
            'FLINK_AUDIT_CHECKPOINT_') +
          scope +
          '_';
        let stored = {};

        if (props.getProperties) {
          stored = props.getProperties() || {};
        } else if (props.getProperty) {
          const today = new Date().toISOString().split('T')[0];
          const key = prefix + today;
          const raw = props.getProperty(key);
          if (raw) stored[key] = raw;
        }

        const checkpointEntries = Object.entries(stored)
          .filter(([key]) => key.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b));

        for (const [key, raw] of checkpointEntries) {
          let cp;
          try {
            cp = JSON.parse(raw);
          } catch (parseErr) {
            return {
              ok: false,
              verified: false,
              scope: scopeName,
              message: `Audit checkpoint ${key} is malformed.`
            };
          }

          const count = Number(cp.count);
          if (
            cp.scope !== scope ||
            !Number.isInteger(count) ||
            count < 0 ||
            !cp.date ||
            !cp.lastHash ||
            !cp.rootHash
          ) {
            return {
              ok: false,
              verified: false,
              scope: scopeName,
              message: `Audit checkpoint ${key} is incomplete or has an invalid scope/count.`
            };
          }

          const expectedRoot = SecurityService.computeAuditCheckpoint(
            cp.scope,
            cp.date,
            cp.lastHash,
            count
          );
          if (!SecurityService.constantTimeEquals(expectedRoot, cp.rootHash)) {
            return {
              ok: false,
              verified: false,
              scope: scopeName,
              message: `Audit checkpoint ${key} failed integrity verification.`
            };
          }

          if (count > rows.length) {
            return {
              ok: false,
              verified: false,
              scope: scopeName,
              count: rows.length,
              checkpointCount: count,
              message:
                `Audit truncation detected: checkpoint ${key} proves at least ${count} records existed, but only ${rows.length} remain.`
            };
          }

          const chainHashAtCheckpoint =
            count === 0 ? 'GENESIS' : String(rows[count - 1].RecordHash || '');
          if (!SecurityService.constantTimeEquals(chainHashAtCheckpoint, String(cp.lastHash))) {
            return {
              ok: false,
              verified: false,
              scope: scopeName,
              message:
                `Audit checkpoint ${key} does not match the recorded chain prefix.`
            };
          }

          if (cp.snapshotHash) {
            const expectedSnapshot = this._computeSnapshotHash(rows, count);
            if (!SecurityService.constantTimeEquals(expectedSnapshot, String(cp.snapshotHash))) {
              return {
                ok: false,
                verified: false,
                scope: scopeName,
                message:
                  `Audit checkpoint ${key} detected mutation within the sealed audit prefix.`
              };
            }
          }

          checkpointVerified = true;
          checkpointInfo.push(cp);
        }
      } catch (checkpointErr) {
        return {
          ok: false,
          verified: false,
          scope: scopeName,
          message: 'Audit checkpoint verification could not be completed.'
        };
      }
    }

    return {
      ok: true,
      verified: true,
      count: rows.length,
      lastRecordHash: rows.length > 0 ? previousHash : '',
      scope: scopeName,
      checkpointVerified,
      checkpointInfo,
      message: rows.length > 0
        ? `Audit chain verified successfully across all ${rows.length} records.`
        : 'Audit log is empty and no durable checkpoint contradicts Genesis state.'
    };
  }
};

var NotificationService = (typeof global !== 'undefined' && global.NotificationService) || {
  /**
   * Generates in-app system alerts and reminders
   */
  getPendingAlerts(authContext, workspaceId = null) {
    const alerts = [];

    // Admins and Super Admins get pending approvals alert
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN || authContext.role === CONSTANTS.ROLES.ADMIN) {
      const overview = DashboardService.getDashboardOverview(authContext, workspaceId);
      if (overview.pendingApprovalsCount > 0) {
        alerts.push({
          type: 'PENDING_APPROVALS',
          severity: 'INFO',
          message: `There are ${overview.pendingApprovalsCount} timesheet(s) awaiting review.`
        });
      }
      if (overview.pendingRequestsCount > 0) {
        alerts.push({
          type: 'PENDING_REQUESTS',
          severity: 'WARNING',
          message: `There are ${overview.pendingRequestsCount} user lifecycle request(s) awaiting Super Admin review.`
        });
      }
    }

    return alerts;
  }
};

/* ===== ExportAndMigrationServices.gs ===== */
/**
 * FLINK Time & Workforce Platform — Export & Migration Services
 * Generates formula-sanitized CSV exports, verifies system health, and bootstraps schemas.
 */

var ExportService = (typeof global !== 'undefined' && global.ExportService) || {
  /**
   * Generates sanitized CSV string from detailed report entries
   */
  exportDetailedCsv(authContext, workspaceId, params = {}) {
    const report = ReportService.getDetailedReport(authContext, workspaceId, params);
    const headers = [
      'Entry ID', 'User Name', 'Project', 'Task', 'Description',
      'Start UTC', 'End UTC', 'Duration (Seconds)', 'Duration (HH:MM:SS)',
      'Billable', 'Approval Status', 'Source', 'Manual'
    ];

    const escapeCsv = val => {
      if (val === null || val === undefined) return '""';
      let str = String(val);
      // Neutralize spreadsheet formula injection in CSV exports
      if (!/^\s*[-+]?\d+(\.\d+)?\s*$/.test(str) && /^\s*[=+\-@\t\r\n]/.test(str)) {
        str = "'" + str;
      }
      return '"' + str.replace(/"/g, '""') + '"';
    };

    const csvLines = [headers.map(escapeCsv).join(',')];

    for (const e of report.entries) {
      csvLines.push([
        e.entryId,
        e.userName,
        e.projectName,
        e.taskName,
        e.description,
        e.startUTC,
        e.endUTC,
        e.durationSeconds,
        e.durationFormatted,
        e.billable ? 'YES' : 'NO',
        e.approvalStatus,
        e.source,
        e.manual ? 'YES' : 'NO'
      ].map(escapeCsv).join(','));
    }

    MasterRepository.logGlobalAudit({
      ActorUserID: authContext.userId,
      ActorRole: authContext.role,
      WorkspaceID: workspaceId,
      EntityType: 'EXPORT',
      EntityID: `EXP_${Date.now()}`,
      Action: CONSTANTS.AUDIT_EVENTS.EXPORT_CREATED,
      Reason: 'Detailed CSV export downloaded'
    });

    return {
      filename: `FLINK_Time_Export_${workspaceId}_${new Date().toISOString().substring(0, 10)}.csv`,
      csvContent: csvLines.join('\r\n'),
      totalRows: report.entries.length
    };
  }
};

function trimSheetToSchema_(sheet, columnCount, minimumRows = 1000) {
  if (!sheet || !Number.isInteger(columnCount) || columnCount < 1) return { changed: false };

  const canInspectColumns =
    typeof sheet.getLastColumn === 'function' &&
    typeof sheet.getMaxColumns === 'function';
  const canInspectRows =
    typeof sheet.getLastRow === 'function' &&
    typeof sheet.getMaxRows === 'function';

  let columnsTrimmed = 0;
  let rowsTrimmed = 0;

  if (canInspectColumns) {
    const lastColumn = Math.max(1, Number(sheet.getLastColumn()) || 1);
    const maxColumns = Number(sheet.getMaxColumns()) || lastColumn;
    // Never delete populated data outside the known schema automatically.
    if (
      maxColumns > columnCount &&
      lastColumn <= columnCount &&
      typeof sheet.deleteColumns === 'function'
    ) {
      columnsTrimmed = maxColumns - columnCount;
      sheet.deleteColumns(columnCount + 1, columnsTrimmed);
    }
  }

  if (canInspectRows) {
    const lastRow = Math.max(1, Number(sheet.getLastRow()) || 1);
    const maxRows = Number(sheet.getMaxRows()) || lastRow;
    const targetRows = Math.max(Number(minimumRows) || 1000, lastRow);
    if (maxRows > targetRows && typeof sheet.deleteRows === 'function') {
      rowsTrimmed = maxRows - targetRows;
      sheet.deleteRows(targetRows + 1, rowsTrimmed);
    }
  }

  return {
    changed: columnsTrimmed > 0 || rowsTrimmed > 0,
    columnsTrimmed,
    rowsTrimmed
  };
}

var MigrationService = (typeof global !== 'undefined' && global.MigrationService) || {
  /**
   * Bootstraps only the Master Control Sheet schema and cryptographic secret.
   * It deliberately does NOT create any default/admin credentials.
   */
  bootstrapMasterSheet(masterSpreadsheet = null) {
    const ss = masterSpreadsheet || MasterRepository.getMasterSpreadsheet();

    for (const [tabName, columns] of Object.entries(MASTER_SCHEMA)) {
      let sheet = ss.getSheetByName(tabName);
      if (!sheet) sheet = ss.insertSheet(tabName);
      sheet.getRange(1, 1, 1, columns.length).setValues([columns]);
      sheet.setFrozenRows(1);
      trimSheetToSchema_(sheet, columns.length, 1000);
    }

    const defaultSheet = ss.getSheetByName('Sheet1');
    if (defaultSheet && !MASTER_SCHEMA[defaultSheet.getName()]) {
      try { ss.deleteSheet(defaultSheet); } catch (e) {}
    }

    SecurityService.ensurePepper();
    return { ok: true, message: 'Master Control Sheet schema and cryptographic secret initialized.' };
  },

  /**
   * System Health Diagnostic for Super Admin Console
   */
  getSystemHealth(superAdminContext) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);

    const workspaces = MasterRepository.listWorkspaces();
    let accessibleWorkspacesCount = 0;
    let healthyWorkspacesCount = 0;

    for (const ws of workspaces) {
      if (ws.Status !== CONSTANTS.WORKSPACE_STATUS.ARCHIVED) {
        accessibleWorkspacesCount++;
        try {
          const ss = WorkspaceRouter.resolveSpreadsheet(ws.WorkspaceID);
          if (ss) healthyWorkspacesCount++;
        } catch (e) {}
      }
    }

    return {
      platformVersion: CONSTANTS.VERSION,
      schemaVersion: CONSTANTS.SCHEMA_VERSION,
      masterSheetStatus: 'HEALTHY',
      workspacesStatus: `${healthyWorkspacesCount}/${accessibleWorkspacesCount} OK`,
      totalRegisteredWorkspaces: workspaces.length,
      timestampUTC: new Date().toISOString()
    };
  }
};

/**
 * Deployment-owner-only PBKDF2 benchmark.
 *
 * Run this private function from the Apps Script editor against the production
 * Apps Script runtime. It does not read or write user credentials. The sample
 * password and salt below are fixed, non-secret benchmark data.
 */
/**
 * Deployment-owner-only bounded migration of stored MFA secrets to Cloud KMS.
 * Run repeatedly from the Apps Script editor until done=true.
 */
function migrateTotpSecretsToKms_() {
  IdentityService.assertInstallationOwner();
  const mode = KmsSecretService.getMode();
  if (mode === KmsSecretService.MODES.DISABLED) {
    throw new AppError(
      ERROR_CODES.CRYPTO_FAILURE,
      'Set FLINK_KMS_MODE to DUAL_READ before migrating MFA secrets.',
      400
    );
  }

  const props = PropertiesService.getScriptProperties();
  const cursorKey = 'FLINK_KMS_MIGRATION_CURSOR';
  const batchSize = 25;
  const rows = MasterRepository.getTableData(CONSTANTS.MASTER_TABS.CREDENTIALS).rows;
  let cursor = Math.max(0, parseInt(props.getProperty(cursorKey), 10) || 0);
  let scanned = 0;
  let migratedRecords = 0;

  for (; cursor < rows.length && scanned < batchSize; cursor++, scanned++) {
    const row = rows[cursor];
    const userId = String(row.UserID || '').trim();
    if (!userId) continue;

    const updates = {};
    for (const field of ['TotpSecret', 'PendingTotpSecret']) {
      const current = String(row[field] || '');
      if (!current || current.startsWith('kms$v1$')) continue;
      updates[field] = KmsSecretService.migrateTotpSecret(userId, current);
    }

    if (Object.keys(updates).length) {
      MasterRepository.updateCredentials(userId, updates);
      migratedRecords++;
      MasterRepository.logSecurityEvent({
        UserID: userId,
        Username: '',
        EventType: 'TOTP_KMS_MIGRATED',
        Success: true,
        metadata: { fields: Object.keys(updates) }
      });
    }
  }

  const done = cursor >= rows.length;
  if (done) props.deleteProperty(cursorKey);
  else props.setProperty(cursorKey, String(cursor));

  const report = {
    scanned,
    migratedRecords,
    nextCursor: done ? null : cursor,
    done,
    mode
  };
  console.log(JSON.stringify(report));
  return report;
}

function benchmarkPasswordKdf_() {
  const report = SecurityService.calibratePasswordKdf(700);
  console.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Adds a tiny installer menu to the bound Master Sheet.
 * The only public simple-trigger entrypoint is onOpen(); all menu handlers stay
 * private (trailing underscore) and therefore are unavailable to google.script.run.
 */
function onOpen() {
  try {
    if (typeof SpreadsheetApp === 'undefined' || !SpreadsheetApp.getUi) return;
    SpreadsheetApp.getUi()
      .createMenu('FLINK Time')
      .addItem('1. Prepare Installation', 'prepareInstallation_')
      .addItem('2. Deployment Instructions', 'showDeploymentInstructions_')
      .addItem('3. Open FLINK Time', 'showWebAppLink_')
      .addToUi();
  } catch (err) {
    console.error('FLINK Time menu could not be added: ' + (err && err.message ? err.message : String(err)));
  }
}

function getBoundMasterSheetOwnerEmail_(spreadsheet) {
  if (!spreadsheet || !spreadsheet.getId) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'The bound Master Sheet could not be resolved.', 500);
  }

  const activeEmail = IdentityService.getCurrentGoogleEmail(true);
  let ownerEmail = '';
  try {
    if (typeof DriveApp === 'undefined' || !DriveApp.getFileById) {
      throw new Error('Drive service unavailable');
    }
    const file = DriveApp.getFileById(spreadsheet.getId());
    const owner = file && file.getOwner ? file.getOwner() : null;
    ownerEmail = IdentityService.normalizeEmail(
      owner && owner.getEmail ? owner.getEmail() : ''
    );
  } catch (err) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'Initial setup must use a Master Sheet copy owned in My Drive. Make your own copy of the template before preparing FLINK Time.',
      403
    );
  }

  if (!ownerEmail || activeEmail !== ownerEmail) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'Only the Google account that owns this Master Sheet can prepare FLINK Time.',
      403
    );
  }
  return ownerEmail;
}

function prepareInstallationCore_() {
  if (
    typeof SpreadsheetApp === 'undefined' ||
    !SpreadsheetApp.getActiveSpreadsheet
  ) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Google Sheets is unavailable in this runtime.', 500);
  }
  if (
    typeof PropertiesService === 'undefined' ||
    !PropertiesService.getScriptProperties
  ) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 'Script Properties are unavailable in this runtime.', 500);
  }

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      'Open the FLINK Time Master Sheet before preparing the installation.',
      500
    );
  }

  const ownerEmail = getBoundMasterSheetOwnerEmail_(spreadsheet);
  const spreadsheetId = spreadsheet.getId();
  const props = PropertiesService.getScriptProperties();
  const configuredSpreadsheetId = String(
    props.getProperty('MASTER_SPREADSHEET_ID') || ''
  ).trim();
  const configuredOwner = IdentityService.normalizeEmail(
    props.getProperty('FLINK_INSTALL_OWNER_EMAIL') || ''
  );

  if (configuredSpreadsheetId && configuredSpreadsheetId !== spreadsheetId) {
    throw new AppError(
      ERROR_CODES.CONFLICT,
      'This Apps Script project is already bound to a different FLINK Time Master Sheet.',
      409
    );
  }
  if (configuredOwner && configuredOwner !== ownerEmail) {
    throw new AppError(
      ERROR_CODES.UNAUTHORIZED,
      'This FLINK Time installation is already bound to another installation owner.',
      403
    );
  }

  props.setProperty('MASTER_SPREADSHEET_ID', spreadsheetId);
  props.setProperty('FLINK_INSTALL_OWNER_EMAIL', ownerEmail);
  props.setProperty('FLINK_INSTALL_PREPARED_AT', new Date().toISOString());
  MasterRepository.spreadsheetId = spreadsheetId;

  let alreadyComplete = false;
  try {
    const existingFlag = MasterRepository.getGlobalSetting('SETUP_COMPLETE', 'false');
    alreadyComplete = existingFlag === true || existingFlag === 'true';
  } catch (err) {
    alreadyComplete = false;
  }

  if (!alreadyComplete) {
    MigrationService.bootstrapMasterSheet(spreadsheet);
  }

  return {
    ok: true,
    alreadyComplete,
    ownerEmail,
    spreadsheetId,
    message: alreadyComplete
      ? 'FLINK Time is already prepared and setup is complete.'
      : 'FLINK Time is prepared. Deploy the Web App, then open the Super Admin link to finish setup.'
  };
}

function prepareInstallation_() {
  try {
    const result = prepareInstallationCore_();
    SpreadsheetApp.getUi().alert(
      'FLINK Time',
      result.message + '\n\nNext: choose FLINK Time → Deployment Instructions.',
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    return result;
  } catch (err) {
    const message = err && err.message ? err.message : 'Installation preparation failed.';
    SpreadsheetApp.getUi().alert(
      'FLINK Time setup could not continue',
      message,
      SpreadsheetApp.getUi().ButtonSet.OK
    );
    throw err;
  }
}

function showDeploymentInstructions_() {
  SpreadsheetApp.getUi().alert(
    'FLINK Time — Deployment Instructions',
    [
      '1. In this Sheet, choose Extensions → Apps Script.',
      '2. In Apps Script choose Deploy → New deployment → Web app.',
      '3. Set Execute as: Me.',
      '4. Set access to users in your Google Workspace domain.',
      '5. Deploy, authorize when Google asks, then return to this Sheet.',
      '6. Choose FLINK Time → Open FLINK Time and open the Super Admin link.',
      '',
      'Only the Employee portal may be embedded in Google Sites. Admin and Super Admin must be opened directly.'
    ].join('\n'),
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function escapeInstallerHtml_(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[ch]);
}

function showWebAppLink_() {
  const ui = SpreadsheetApp.getUi();
  const baseUrl = (
    typeof ScriptApp !== 'undefined' &&
    ScriptApp.getService &&
    ScriptApp.getService().getUrl
  ) ? String(ScriptApp.getService().getUrl() || '') : '';

  if (!baseUrl) {
    ui.alert(
      'FLINK Time is not deployed yet',
      'Complete FLINK Time → Deployment Instructions first, then try again.',
      ui.ButtonSet.OK
    );
    return;
  }

  const safeBase = escapeInstallerHtml_(baseUrl);
  const userUrl = safeBase + '?view=user';
  const adminUrl = safeBase + '?view=admin';
  const superAdminUrl = safeBase + '?view=superadmin';
  const html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial,sans-serif;padding:18px;line-height:1.55">' +
      '<h2 style="margin-top:0">FLINK Time</h2>' +
      '<p><strong>First installation:</strong> open Super Admin and complete the guided setup.</p>' +
      '<p><a target="_blank" href="' + superAdminUrl + '">Open Super Admin</a></p>' +
      '<p><a target="_blank" href="' + adminUrl + '">Open Admin</a></p>' +
      '<p><a target="_blank" href="' + userUrl + '">Open Employee Portal</a></p>' +
      '<p style="font-size:12px;color:#666">Admin and Super Admin are direct links. Only the Employee portal may be embedded in Google Sites.</p>' +
    '</div>'
  ).setWidth(430).setHeight(300);
  ui.showModalDialog(html, 'FLINK Time Links');
}

/**
 * Backward-compatible private owner helper for maintainers.
 * Normal installers do not need to run code in the Apps Script editor.
 */
function initializeInstallation_() {
  return prepareInstallationCore_();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ERROR_CODES, AppError,
    CONSTANTS, MASTER_SCHEMA, WORKSPACE_SCHEMA, SETTINGS_CATALOG, Validation,
    ACTION_PERMISSIONS, PUBLIC_ACTIONS, GET_SAFE_ACTIONS,
    isHttpMethodAllowed: isHttpMethodAllowed_, getActionPermission: getActionPermission_, App, doGet, doPost,
    handleApiRequest: handleApiRequest_, handleClientRequest, executeApiRequest: executeApiRequest_,
    dispatchAction: dispatchAction_, buildJsonResponse: buildJsonResponse_,
    Flags, SettingsService,
    IdentityService, SecurityService, KmsSecretService, AuthorizationService,
    SessionService, AuthService, TrackingPolicyService,
    MasterRepository, SheetRepository, WorkspaceRouter,
    WorkspaceService, TimezoneService,
    ClientService, ProjectService, TaskService, TagService,
    TimeEntryService, TimerService, TimesheetService,
    ApprovalService, ReportService, RollupService, DashboardService,
    UserService, AdminRequestService, SetupService, IntegrityService,
    JobService, BackupService, AuditService, NotificationService,
    ExportService, MigrationService, initializeInstallation: initializeInstallation_
  };
}

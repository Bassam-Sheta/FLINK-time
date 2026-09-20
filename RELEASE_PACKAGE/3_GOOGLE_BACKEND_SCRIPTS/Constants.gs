/**
 * FLINK Time & Workforce Platform — System Constants & Schema Specifications
 * Obeying strict Google Workspace constraints:
 * - Master Control Sheet Schema (11 Tabs)
 * - Workspace Sheet Schema (18 Tabs)
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
    SESSION_IDLE_TIMEOUT_HOURS: 8,
    SESSION_ABSOLUTE_TIMEOUT_HOURS: 24,
    MIN_PASSWORD_LENGTH: 12,
    MAX_PASSWORD_LENGTH: 128,
    MAX_SINGLE_ENTRY_HOURS: 24,
    DASHBOARD_LIVE_WINDOW_SECONDS: 60
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
    'Status', 'SubmittedAt', 'ReviewedBy', 'ReviewedAt', 'ReviewComment', 'LockedAt'
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONSTANTS,
    MASTER_SCHEMA,
    WORKSPACE_SCHEMA
  };
}

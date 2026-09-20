/**
 * Ultra-Account: Scalable Relational Database Schema Initializer
 * This script runs inside Google Apps Script to bootstrap all relational tabs,
 * apply header styling, cell data validations, freeze header rows, and insert default records.
 */

const DB_SCHEMA = {
  USERS: {
    columns: [
      'user_id', 'email', 'full_name', 'role', 'status', 
      'default_hourly_rate', 'department', 'created_at', 'last_active_at'
    ],
    defaults: [
      [
        'usr_admin_master', 'admin@example.com', 'Super Administrator', 
        'SUPER_ADMIN', 'ACTIVE', 100.00, 'Executive', 
        new Date().toISOString(), new Date().toISOString()
      ]
    ]
  },
  CLIENTS: {
    columns: ['client_id', 'name', 'address', 'currency', 'status', 'created_at'],
    defaults: [
      ['cli_internal', 'Internal Operations', 'HQ', 'USD', 'ACTIVE', new Date().toISOString()]
    ]
  },
  PROJECTS: {
    columns: [
      'project_id', 'client_id', 'name', 'color_hex', 'is_billable', 
      'hourly_rate_override', 'estimated_hours', 'status', 'created_at'
    ],
    defaults: [
      ['prj_general', 'cli_internal', 'General Administration', '#3B82F6', true, 0, 100, 'ACTIVE', new Date().toISOString()],
      ['prj_dev', 'cli_internal', 'Core Development', '#10B981', true, 0, 500, 'ACTIVE', new Date().toISOString()]
    ]
  },
  TASKS: {
    columns: ['task_id', 'project_id', 'name', 'estimated_hours', 'hourly_rate_override', 'status', 'created_at'],
    defaults: [
      ['tsk_planning', 'prj_general', 'Strategy & Planning', 20, 0, 'OPEN', new Date().toISOString()],
      ['tsk_coding', 'prj_dev', 'Feature Implementation', 200, 0, 'OPEN', new Date().toISOString()]
    ]
  },
  TAGS: {
    columns: ['tag_id', 'name', 'color_hex', 'created_at'],
    defaults: [
      ['tag_urgent', 'Urgent', '#EF4444', new Date().toISOString()],
      ['tag_meeting', 'Meeting', '#F59E0B', new Date().toISOString()],
      ['tag_review', 'Code Review', '#8B5CF6', new Date().toISOString()]
    ]
  },
  // TIME_ENTRIES is a template schema for dynamically generated yearly sheets (e.g. TIME_ENTRIES_2026)
  TIME_ENTRIES: {
    columns: [
      'entry_id', 'user_id', 'project_id', 'task_id', 'description', 
      'start_time', 'end_time', 'duration_seconds', 'is_billable', 
      'hourly_rate', 'cost_rate', 'amount', 'labor_cost', 'profit', 
      'approval_status', 'approval_id', 'device_id', 'is_manual', 'is_locked', 
      'tags', 'anti_cheat_flag', 'created_at', 'updated_at'
    ],
    defaults: []
  },
  SCREENSHOTS: {
    columns: [
      'screenshot_id', 'entry_id', 'user_id', 'timestamp', 'drive_file_id', 
      'activity_score', 'active_window_title', 'flag_incident', 'workspace_name', 'created_at'
    ],
    defaults: []
  },
  APPROVALS: {
    columns: [
      'approval_id', 'user_id', 'start_date', 'end_date', 'total_hours', 
      'billable_hours', 'status', 'reviewer_user_id', 'comments', 
      'submitted_at', 'reviewed_at'
    ],
    defaults: []
  },
  EXPENSES: {
    columns: [
      'expense_id', 'user_id', 'project_id', 'category', 'amount', 
      'currency', 'is_billable', 'receipt_drive_file_id', 'date', 'status', 'created_at'
    ],
    defaults: []
  },
  INVOICES: {
    columns: [
      'invoice_id', 'client_id', 'invoice_number', 'issue_date', 'due_date', 
      'subtotal', 'tax_percent', 'discount_amount', 'total_amount', 
      'currency', 'status', 'notes', 'created_at'
    ],
    defaults: []
  },
  TIME_OFF: {
    columns: [
      'request_id', 'user_id', 'policy_type', 'start_date', 'end_date', 
      'total_days', 'status', 'reviewer_user_id', 'notes', 'created_at'
    ],
    defaults: []
  },
  AUDIT_LOGS: {
    columns: [
      'log_id', 'timestamp', 'actor_user_id', 'action', 'entity_table', 
      'entity_id', 'before_state_json', 'after_state_json', 'sha256_hash'
    ],
    defaults: []
  },
  AUDIT_INCIDENTS: {
    columns: [
      'incident_id', 'timestamp', 'user_id', 'screenshot_id', 'rule_id', 
      'rule_name', 'matched_pattern', 'risk_level', 'status', 'reviewer_notes'
    ],
    defaults: []
  },
  CONFIGS: {
    columns: ['key', 'value', 'description', 'updated_at'],
    defaults: [
      ['WORKSPACE_NAME', 'Ultra Account Enterprise', 'Primary organization title', new Date().toISOString()],
      ['DEFAULT_CURRENCY', 'USD', 'Workspace default currency symbol', new Date().toISOString()],
      ['SCREENSHOT_INTERVAL_MINUTES', '5', 'Interval between randomized client screenshots (1-30)', new Date().toISOString()],
      ['SCREENSHOTS_ENABLED', 'true', 'Global switch to capture desktop screenshots', new Date().toISOString()],
      ['BLUR_SCREENSHOTS_BY_DEFAULT', 'false', 'Enable client-side blurring for privacy compliance', new Date().toISOString()],
      ['IDLE_ALERTS_ENABLED', 'false', 'Enable client-side idle alert popups and prompts (false = continuous tracking)', new Date().toISOString()],
      ['IDLE_THRESHOLD_SECONDS', '300', 'Inactivity duration before idle alert dialog is triggered (5m)', new Date().toISOString()],
      ['AUTO_LOCK_TIMESHEETS', 'true', 'Lock time entries once approval is granted', new Date().toISOString()],
      ['DLP_SCANNING_ENABLED', 'true', 'Enable on-device Windows Media OCR DLP compliance audit', new Date().toISOString()]
    ]
  }
};

/**
 * Bootstraps the active spreadsheet into a full relational database.
 * Run this function once from the Apps Script Editor or setup endpoint.
 */
function setupDatabase(year) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const existingSheets = ss.getSheets().map(s => s.getName());

  for (const [tableName, schema] of Object.entries(DB_SCHEMA)) {
    let targetTableName = tableName;
    if (tableName === 'TIME_ENTRIES') {
      const targetYear = year || new Date().getFullYear();
      targetTableName = 'TIME_ENTRIES_' + targetYear;
    }

    let sheet;
    if (existingSheets.includes(targetTableName)) {
      sheet = ss.getSheetByName(targetTableName);
    } else {
      sheet = ss.insertSheet(targetTableName);
    }

    // Check if headers already exist
    const currentRows = sheet.getLastRow();
    if (currentRows === 0) {
      // Set Header Row
      const headerRange = sheet.getRange(1, 1, 1, schema.columns.length);
      headerRange.setValues([schema.columns]);
      headerRange.setBackground('#1E293B');
      headerRange.setFontColor('#F8FAFC');
      headerRange.setFontWeight('bold');
      headerRange.setHorizontalAlignment('center');
      sheet.setFrozenRows(1);

      // Auto-fit columns
      for (let i = 1; i <= schema.columns.length; i++) {
        sheet.setColumnWidth(i, 160);
      }

      // Add Default Data if any
      if (schema.defaults && schema.defaults.length > 0) {
        const dataRange = sheet.getRange(2, 1, schema.defaults.length, schema.columns.length);
        dataRange.setValues(schema.defaults);
      }
    }
  }

  // Remove default 'Sheet1' if it exists and is empty
  const sheets = ss.getSheets();
  if (sheets.length > 1) {
    const firstSheet = sheets[0];
    // If the first sheet has no data and is not one of our schema tables, delete it
    const schemaNames = Object.keys(DB_SCHEMA);
    if (!schemaNames.includes(firstSheet.getName()) && firstSheet.getLastRow() === 0) {
      ss.deleteSheet(firstSheet);
    }
  }

  Logger.log('Database successfully initialized with %s relational tables.', Object.keys(DB_SCHEMA).length);
  return { status: 'SUCCESS', tables: Object.keys(DB_SCHEMA) };
}

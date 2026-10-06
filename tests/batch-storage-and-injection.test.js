'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function cleanGlobals() {
  global.AppError = AppError;
  global.ERROR_CODES = {
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    WORKSPACE_DENIED: 'WORKSPACE_DENIED',
    PERMISSION_DENIED: 'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { USER: 'USER', ADMIN: 'ADMIN', SUPER_ADMIN: 'SUPER_ADMIN' },
    AUDIT_EVENTS: { TIME_ENTRY_CREATED: 'TIME_ENTRY_CREATED' },
    MASTER_TABS: {
      ACCOUNTS: 'Accounts',
      CREDENTIALS: 'Credentials',
      WORKSPACES: 'Workspaces',
      WORKSPACE_ACCESS: 'WorkspaceAccess',
      SESSIONS: 'Sessions',
      REQUESTS: 'Requests',
      SECURITY_EVENTS: 'SecurityEvents',
      GLOBAL_AUDIT: 'GlobalAudit',
      GLOBAL_SETTINGS: 'GlobalSettings'
    },
    WORKSPACE_TABS: {
      MEMBERS: 'Members',
      CLIENTS: 'Clients',
      PROJECTS: 'Projects',
      TASKS: 'Tasks',
      TAGS: 'Tags',
      ACTIVE_TIMERS: 'ActiveTimers',
      TIME_ENTRIES: 'TimeEntries',
      TIMESHEETS: 'Timesheets',
      APPROVALS: 'Approvals',
      AUDIT_LOG: 'AuditLog',
      WORKSPACE_SETTINGS: 'WorkspaceSettings',
      DAILY_ROLLUPS: 'DailyRollups',
      WEEKLY_ROLLUPS: 'WeeklyRollups',
      MONTHLY_ROLLUPS: 'MonthlyRollups',
      PROJECT_ROLLUPS: 'ProjectRollups'
    }
  };
  delete global.MasterRepository;
  delete global.SheetRepository;
  delete global.WorkspaceRouter;
  delete global.TimezoneService;
  delete global.AuthorizationService;
  delete global.ReportService;
  delete global.ExportService;
  delete global.Validation;
  delete global.Flags;
  delete require.cache[require.resolve(codePath)];
}

test('Validation.sanitizeCellValue neutralizes whitespace-padded formula injection', () => {
  cleanGlobals();
  const { Validation } = require(codePath);

  // Attack vectors with leading whitespace, tabs, or newlines
  const attackVectors = [
    '=HYPERLINK("http://evil.com")',
    ' =HYPERLINK("http://evil.com")',
    '   =CMD("calc")',
    '\t=1+1',
    '\r\n=1+1',
    ' +cmd|\' /C calc\'!A0',
    '   -2+3+cmd|...!',
    '  @SUM(1,2)',
    '\t-10+cmd|'
  ];

  for (const vector of attackVectors) {
    const sanitized = Validation.sanitizeCellValue(vector);
    assert.ok(
      sanitized.startsWith("'"),
      `Attack vector '${vector}' should be neutralized with leading single quote, got '${sanitized}'`
    );
  }
});

test('Validation.sanitizeCellValue preserves legitimate numeric and ordinary text values', () => {
  cleanGlobals();
  const { Validation } = require(codePath);

  // Legitimate numbers and signed numeric strings
  assert.equal(Validation.sanitizeCellValue(42), 42);
  assert.equal(Validation.sanitizeCellValue(-17.5), -17.5);
  assert.equal(Validation.sanitizeCellValue(0), 0);
  assert.equal(Validation.sanitizeCellValue(true), true);
  assert.equal(Validation.sanitizeCellValue(false), false);
  assert.equal(Validation.sanitizeCellValue(null), '');
  assert.equal(Validation.sanitizeCellValue(undefined), '');

  assert.equal(Validation.sanitizeCellValue('42'), '42');
  assert.equal(Validation.sanitizeCellValue('-100'), '-100');
  assert.equal(Validation.sanitizeCellValue('+50.25'), '+50.25');
  assert.equal(Validation.sanitizeCellValue(' -7 '), ' -7 ');
  assert.equal(Validation.sanitizeCellValue('0.00'), '0.00');

  // Ordinary strings without formula prefixes
  assert.equal(Validation.sanitizeCellValue('Normal Description'), 'Normal Description');
  assert.equal(Validation.sanitizeCellValue('Project Alpha - Phase 1'), 'Project Alpha - Phase 1');
});

test('ExportService.exportDetailedCsv neutralizes formula injection in CSV cells while preserving signed numbers', () => {
  cleanGlobals();

  global.AuthorizationService = {
    assertWorkspaceAccess() {},
    assertRole() {}
  };
  global.TimezoneService = {
    getWorkspaceTimezone() { return 'UTC'; },
    formatDateKey() { return '2026-10-01'; },
    formatDateTime(_ws, val) { return String(val) + ' UTC'; }
  };
  global.MasterRepository = {
    getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
    logGlobalAudit() {},
    getGlobalSetting(_k, fallback) { return fallback; }
  };
  global.SheetRepository = {
    getMember(ws, id) { return { DisplayName: id === 'U1' ? 'Alice' : 'Bob' }; },
    listMembers() { return [{ UserID: 'U1', DisplayName: 'Alice' }, { UserID: 'U2', DisplayName: 'Bob' }]; },
    listProjects() {
      return [
        { ProjectID: 'P1', ProjectName: ' =HYPERLINK("http://evil.com")' },
        { ProjectID: 'P2', ProjectName: ' +cmd|\' /C calc\'!A0' }
      ];
    },
    listTasks() {
      return [
        { TaskID: 'T1', TaskName: '\t=1+1' },
        { TaskID: 'T2', TaskName: 'Normal Task' }
      ];
    },
    listTimeEntries() {
      return [
        {
          EntryID: 'E1',
          UserID: 'U1',
          ProjectID: 'P1',
          TaskID: 'T1',
          Description: '-100', // valid negative number
          StartUTC: '2026-10-01T08:00:00.000Z',
          EndUTC: '2026-10-01T09:00:00.000Z',
          DurationSeconds: 3600,
          Billable: true,
          ApprovalStatus: 'APPROVED',
          EntrySource: 'WEB',
          ManualEntry: false
        },
        {
          EntryID: 'E2',
          UserID: 'U2',
          ProjectID: 'P2',
          TaskID: 'T2',
          Description: '+50.5', // valid positive number
          StartUTC: '2026-10-01T09:00:00.000Z',
          EndUTC: '2026-10-01T10:00:00.000Z',
          DurationSeconds: 3600,
          Billable: false,
          ApprovalStatus: 'OPEN',
          EntrySource: 'WEB',
          ManualEntry: true
        }
      ];
    }
  };

  const { ExportService } = require(codePath);

  const auth = { userId: 'U1', role: 'SUPER_ADMIN' };
  const res = ExportService.exportDetailedCsv(auth, 'W1', {});
  assert.ok(res.csvContent);

  const lines = res.csvContent.split('\r\n');
  assert.equal(lines.length, 3); // header + 2 rows

  // Row 1 checks:
  // projectName has leading space + = -> must be escaped with single quote
  assert.ok(lines[1].includes('"\' =HYPERLINK(""http://evil.com"")"'));
  // taskName has tab + = -> escaped with single quote
  assert.ok(lines[1].includes('"\'\t=1+1"'));
  // description is '-100' -> legitimate numeric, not escaped with single quote
  assert.ok(lines[1].includes('"-100"'));

  // Row 2 checks:
  // projectName has leading space + + -> escaped with single quote
  assert.ok(lines[2].includes('"\' +cmd|\' /C calc\'!A0"'));
  // description is '+50.5' -> legitimate numeric, not escaped with single quote
  assert.ok(lines[2].includes('"+50.5"'));
});

test('SheetRepository.appendRows batches insertion with setValues and sanitizes all cells', () => {
  cleanGlobals();

  let writtenRange = null;
  let writtenValues = null;

  const mockSheet = {
    getLastRow() { return 1; },
    getRange(row, col, numRows, numCols) {
      writtenRange = { row, col, numRows, numCols };
      return {
        setValues(vals) {
          writtenValues = vals;
        }
      };
    }
  };

  global.WorkspaceRouter = {
    resolveSpreadsheet(wsId) {
      assert.equal(wsId, 'W1');
      return {
        getSheetByName(tab) {
          assert.equal(tab, 'TimeEntries');
          return mockSheet;
        }
      };
    }
  };

  const backend = require(codePath);
  const { SheetRepository, WORKSPACE_SCHEMA } = backend;

  const entities = [
    {
      EntryID: 'E1',
      UserID: 'U1',
      ProjectID: 'P1',
      Description: ' =FORMULA()',
      DurationSeconds: 1800,
      Billable: true
    },
    {
      EntryID: 'E2',
      UserID: 'U2',
      ProjectID: 'P2',
      Description: '-42', // valid numeric string
      DurationSeconds: 3600,
      Billable: false
    }
  ];

  SheetRepository.beginRequest();
  const result = SheetRepository.appendRows('W1', 'TimeEntries', entities);
  assert.equal(result.length, 2);

  assert.ok(writtenRange);
  assert.equal(writtenRange.row, 2); // row 1 header + 1
  assert.equal(writtenRange.col, 1);
  assert.equal(writtenRange.numRows, 2);

  // Check sanitization in batch row data
  const headers = WORKSPACE_SCHEMA.TimeEntries;
  const descColIdx = headers.indexOf('Description');
  assert.ok(descColIdx >= 0);

  assert.equal(writtenValues[0][descColIdx], "' =FORMULA()");
  assert.equal(writtenValues[1][descColIdx], '-42');
});

test('MasterRepository.appendRows batches insertion with setValues and invalidates cache', () => {
  cleanGlobals();

  let writtenRange = null;
  let writtenValues = null;

  const mockSheet = {
    getLastRow() { return 5; },
    getRange(row, col, numRows, numCols) {
      writtenRange = { row, col, numRows, numCols };
      return {
        setValues(vals) {
          writtenValues = vals;
        }
      };
    }
  };

  const backend = require(codePath);
  const { MasterRepository, MASTER_SCHEMA } = backend;

  MasterRepository.getMasterSpreadsheet = () => ({
    getSheetByName(tab) {
      assert.equal(tab, 'Accounts');
      return mockSheet;
    }
  });

  const entities = [
    {
      UserID: 'U1',
      Username: 'alice',
      DisplayName: ' @Alice',
      Email: 'alice@example.com',
      Role: 'USER',
      Status: 'ACTIVE'
    },
    {
      UserID: 'U2',
      Username: 'bob',
      DisplayName: 'Bob Smith',
      Email: 'bob@example.com',
      Role: 'ADMIN',
      Status: 'ACTIVE'
    }
  ];

  MasterRepository.beginRequest();
  const result = MasterRepository.appendRows('Accounts', entities);
  assert.equal(result.length, 2);

  assert.ok(writtenRange);
  assert.equal(writtenRange.row, 6);
  assert.equal(writtenRange.col, 1);
  assert.equal(writtenRange.numRows, 2);

  const headers = MASTER_SCHEMA.Accounts;
  const nameColIdx = headers.indexOf('DisplayName');
  assert.ok(nameColIdx >= 0);

  assert.equal(writtenValues[0][nameColIdx], "' @Alice");
  assert.equal(writtenValues[1][nameColIdx], 'Bob Smith');
});

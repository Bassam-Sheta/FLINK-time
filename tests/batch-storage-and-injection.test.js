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
  // ExportService.escapeCsv direct unit assertions
  assert.equal(typeof ExportService.escapeCsv, 'function');
  assert.equal(ExportService.escapeCsv('=SUM(1,2)'), '"\'=SUM(1,2)"');
  assert.equal(ExportService.escapeCsv('-123.45'), '"-123.45"');
  assert.equal(ExportService.escapeCsv(null), '""');
  assert.equal(ExportService.escapeCsv('   @MALICIOUS'), '"\'   @MALICIOUS"');
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

test('SheetRepository.updateRow reuses _headerCache across multiple updates in a request', () => {
  cleanGlobals();

  let headerReads = 0;
  const mockSheet = {
    getLastRow() { return 10; },
    getLastColumn() { return 10; },
    getRange(row, col, numRows, numCols) {
      if (row === 1 && numRows === 1) {
        headerReads++;
        return {
          getValues() {
            return [['EntryID', 'UserID', 'ProjectID', 'DurationSeconds', 'Description']];
          }
        };
      }
      return {
        setValues() {}
      };
    }
  };

  global.WorkspaceRouter = {
    resolveSpreadsheet() {
      return {
        getSheetByName() { return mockSheet; }
      };
    }
  };

  const backend = require(codePath);
  const { SheetRepository } = backend;

  SheetRepository.beginRequest();
  assert.equal(headerReads, 0);

  // First update reads and caches headers
  SheetRepository.updateRow('W1', 'TimeEntries', 2, { Description: 'First' });
  assert.equal(headerReads, 1);

  // Second update reuses cached headers without re-querying row 1
  SheetRepository.updateRow('W1', 'TimeEntries', 3, { Description: 'Second' });
  assert.equal(headerReads, 1);

  // Third update on same tab still uses cache
  SheetRepository.updateRow('W1', 'TimeEntries', 4, { Description: 'Third' });
  assert.equal(headerReads, 1);

  // beginRequest resets cache
  SheetRepository.beginRequest();
  SheetRepository.updateRow('W1', 'TimeEntries', 5, { Description: 'Fourth' });
  assert.equal(headerReads, 2);
});

test('MasterRepository.updateRow reuses _headerCache across multiple updates in a request', () => {
  cleanGlobals();

  let headerReads = 0;
  const mockSheet = {
    getLastRow() { return 10; },
    getLastColumn() { return 10; },
    getRange(row, col, numRows, numCols) {
      if (row === 1 && numRows === 1) {
        headerReads++;
        return {
          getValues() {
            return [['UserID', 'Username', 'DisplayName', 'Email', 'Role', 'Status']];
          }
        };
      }
      return {
        setValues() {}
      };
    }
  };

  const backend = require(codePath);
  const { MasterRepository } = backend;

  MasterRepository.getMasterSpreadsheet = () => ({
    getSheetByName() { return mockSheet; }
  });

  MasterRepository.beginRequest();
  assert.equal(headerReads, 0);

  // First update reads and caches headers
  MasterRepository.updateRow('Accounts', 2, { DisplayName: 'Alice Updated' });
  assert.equal(headerReads, 1);

  // Second update reuses cached headers
  MasterRepository.updateRow('Accounts', 3, { DisplayName: 'Bob Updated' });
  assert.equal(headerReads, 1);

  // beginRequest resets cache
  MasterRepository.beginRequest();
  MasterRepository.updateRow('Accounts', 4, { DisplayName: 'Charlie Updated' });
  assert.equal(headerReads, 2);
});

test('SheetRepository.deleteRows executes batch row deletion and invalidates table cache', () => {
  cleanGlobals();

  let deletedStart = 0;
  let deletedCount = 0;
  let getTableDataCalls = 0;

  const mockSheet = {
    deleteRows(start, count) {
      deletedStart = start;
      deletedCount = count;
    },
    getDataRange() {
      getTableDataCalls++;
      return {
        getValues() {
          return [
            ['RollupID', 'WorkspaceID', 'PeriodKey', 'TotalSeconds'],
            ['R1', 'W1', '2026-09-29', 3600],
            ['R2', 'W1', '2026-09-30', 7200]
          ];
        }
      };
    }
  };

  global.WorkspaceRouter = {
    resolveSpreadsheet(wsId) {
      return {
        getSheetByName(tab) {
          if (tab === 'DailyRollups') return mockSheet;
          return null;
        }
      };
    }
  };

  const backend = require(codePath);
  const { SheetRepository } = backend;

  SheetRepository.beginRequest();

  // Populate cache
  const first = SheetRepository.getTableData('W1', 'DailyRollups');
  assert.equal(first.rows.length, 2);
  assert.equal(getTableDataCalls, 1);

  // Cached read
  const cached = SheetRepository.getTableData('W1', 'DailyRollups');
  assert.equal(getTableDataCalls, 1);

  // Batch delete rows
  SheetRepository.deleteRows('W1', 'DailyRollups', 2, 5);
  assert.equal(deletedStart, 2);
  assert.equal(deletedCount, 5);

  // Cache is invalidated, next read queries sheet again
  SheetRepository.getTableData('W1', 'DailyRollups');
  assert.equal(getTableDataCalls, 2);
});

test('SheetRepository.deleteRows validates row boundaries and fails closed', () => {
  cleanGlobals();
  global.WorkspaceRouter = {
    resolveSpreadsheet() {
      return { getSheetByName() { return {}; } };
    }
  };
  const backend = require(codePath);
  const { SheetRepository } = backend;

  // Cannot delete header row (startRow < 2)
  assert.throws(
    () => SheetRepository.deleteRows('W1', 'DailyRollups', 1, 1),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );

  // Cannot delete 0 or negative count
  assert.throws(
    () => SheetRepository.deleteRows('W1', 'DailyRollups', 2, 0),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
  assert.throws(
    () => SheetRepository.deleteRows('W1', 'DailyRollups', 2, -1),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );

  // Non-integer inputs
  assert.throws(
    () => SheetRepository.deleteRows('W1', 'DailyRollups', 'invalid', 1),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
});

test('Validation.sanitizeCellValue clamps strings to Google Sheets 50,000 character cell ceiling', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { Validation } = backend;

  const oversized = 'A'.repeat(60000);
  const sanitized = Validation.sanitizeCellValue(oversized);
  assert.equal(sanitized.length, 50000);

  // Still checks formula prefix on clamped string
  const formulaOversized = '=CMD' + 'B'.repeat(59996);
  const formulaSanitized = Validation.sanitizeCellValue(formulaOversized);
  assert.equal(formulaSanitized.startsWith("''=CMD"), false);
  assert.equal(formulaSanitized.startsWith("'=CMD"), true);
  assert.equal(formulaSanitized.length, 50001); // 1 single quote + 50000 characters
});

test('doPost rejects request payloads larger than MAX_POST_BODY_BYTES with 413', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { doPost } = backend;

  const oversizedPost = {
    postData: {
      contents: '{"action":"test","payload":"' + 'X'.repeat(1050000) + '"}'
    }
  };

  const response = doPost(oversizedPost);
  const parsed = response && typeof response.getContent === 'function'
    ? JSON.parse(response.getContent())
    : response;
  assert.ok(parsed);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error.code, 'VALIDATION_ERROR');
  assert.equal(parsed.error.statusCode, 413);
});

test('TrackingPolicyService.validateTrackingContext rejects descriptions exceeding MAX_DESCRIPTION_LENGTH', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { TrackingPolicyService, AuthorizationService, MasterRepository, AppError, CONSTANTS } = backend;

  AuthorizationService.assertWorkspaceAccess = () => true;
  MasterRepository.getGlobalSettingStrict = (_key, fallback) => fallback;

  const authContext = { userId: 'U1', role: CONSTANTS.ROLES.USER };
  const longDesc = 'D'.repeat(2001);

  assert.throws(
    () => TrackingPolicyService.validateTrackingContext(authContext, 'W1', {
      description: longDesc
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400 &&
      err.message.includes('cannot exceed 2000 characters')
  );
});

test('JobService.getCapacityMetrics accounts for allocated grid cells (getMaxRows * getMaxColumns)', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { JobService, MasterRepository } = backend;

  const mockSheet = {
    getName() { return 'TimeEntries'; },
    getLastRow() { return 100; },
    getLastColumn() { return 12; }, // 1,200 filled data cells
    getMaxRows() { return 1000; },
    getMaxColumns() { return 26; }  // 26,000 allocated cells
  };

  MasterRepository.getMasterSpreadsheet = () => ({
    getSheets() {
      return [mockSheet];
    }
  });

  const metrics = JobService.getCapacityMetrics();
  assert.equal(metrics.totalCells, 26000);
  assert.equal(metrics.tabBreakdown[0].rows, 100);
  assert.equal(metrics.tabBreakdown[0].columns, 12);
  assert.equal(metrics.tabBreakdown[0].allocatedRows, 1000);
  assert.equal(metrics.tabBreakdown[0].allocatedColumns, 26);
  assert.equal(metrics.tabBreakdown[0].cells, 26000);
});

test('SheetRepository.getLastAuditHash and MasterRepository.getLastAuditHash reuse _headerCache across calls', () => {
  cleanGlobals();
  let masterHeaderReads = 0;
  let wsHeaderReads = 0;

  const mockMasterSheet = {
    getLastRow() { return 10; },
    getLastColumn() { return 15; },
    getRange(row, col, numRows, numCols) {
      if (row === 1 && numRows === 1) {
        masterHeaderReads++;
        return { getValues() { return [['AuditID', 'TimestampUTC', 'RecordHash']]; } };
      }
      return { getValue() { return 'HASH_MASTER_123'; } };
    }
  };

  const mockWsSheet = {
    getLastRow() { return 20; },
    getLastColumn() { return 13; },
    getRange(row, col, numRows, numCols) {
      if (row === 1 && numRows === 1) {
        wsHeaderReads++;
        return { getValues() { return [['AuditID', 'TimestampUTC', 'RecordHash']]; } };
      }
      return { getValue() { return 'HASH_WS_456'; } };
    }
  };

  global.WorkspaceRouter = {
    resolveSpreadsheet() {
      return { getSheetByName() { return mockWsSheet; } };
    }
  };

  const backend = require(codePath);
  const { MasterRepository, SheetRepository } = backend;

  MasterRepository.getMasterSpreadsheet = () => ({
    getSheetByName() { return mockMasterSheet; }
  });

  MasterRepository.beginRequest();
  SheetRepository.beginRequest();

  // First calls populate _headerCache
  const hashM1 = MasterRepository.getLastAuditHash('GlobalAudit');
  const hashW1 = SheetRepository.getLastAuditHash('W1', 'AuditLog');
  assert.equal(hashM1, 'HASH_MASTER_123');
  assert.equal(hashW1, 'HASH_WS_456');
  assert.equal(masterHeaderReads, 1);
  assert.equal(wsHeaderReads, 1);

  // Subsequent calls reuse _headerCache without re-reading row 1
  const hashM2 = MasterRepository.getLastAuditHash('GlobalAudit');
  const hashW2 = SheetRepository.getLastAuditHash('W1', 'AuditLog');
  assert.equal(hashM2, 'HASH_MASTER_123');
  assert.equal(hashW2, 'HASH_WS_456');
  assert.equal(masterHeaderReads, 1);
  assert.equal(wsHeaderReads, 1);
});

test('RollupService._updateProjectRollup derives contributor count from MonthlyRollups without calling listTimeEntries', () => {
  cleanGlobals();
  let listTimeEntriesCalled = false;
  let updateRowPayload = null;

  const mockProject = { ProjectID: 'P1', EstimateHours: 50 };
  const mockMonthlyRollups = [
    { MonthKey: '2026-10', UserID: 'U1', ProjectID: 'P1' },
    { MonthKey: '2026-10', UserID: 'U2', ProjectID: 'P1' }
  ];
  const mockProjectRollups = [
    { ProjectID: 'P1', TotalSeconds: 7200, TotalCost: 200, TotalRevenue: 400, ContributorCount: 2, _rowIndex: 2 }
  ];

  const backend = require(codePath);
  const { RollupService, SheetRepository } = backend;

  SheetRepository.getProject = () => mockProject;
  SheetRepository.listTimeEntries = () => {
    listTimeEntriesCalled = true;
    return [];
  };
  SheetRepository.getTableData = (_ws, tab) => {
    if (tab === 'ProjectRollups') return { rows: mockProjectRollups };
    if (tab === 'MonthlyRollups') return { rows: mockMonthlyRollups };
    return { rows: [] };
  };
  SheetRepository.updateRow = (_ws, _tab, _rowIdx, updates) => {
    updateRowPayload = updates;
  };

  const contribution = {
    projectId: 'P1',
    userId: 'U3', // New contributor
    seconds: 3600,
    billableSeconds: 3600,
    costCents: 5000,
    revenueCents: 10000
  };

  RollupService._updateProjectRollup('W1', contribution, '2026-10-06T12:00:00Z');

  // Verify listTimeEntries was bypassed completely
  assert.equal(listTimeEntriesCalled, false);
  // Verify contributor count increased from 2 to 3 (U1, U2 + new U3)
  assert.ok(updateRowPayload);
  assert.equal(updateRowPayload.ContributorCount, 3);
});

test('TimerService._findActiveTimerAcrossWorkspaces prioritizes preferredWorkspaceId', () => {
  cleanGlobals();
  const checkedWorkspaces = [];

  const backend = require(codePath);
  const { TimerService, MasterRepository, SheetRepository } = backend;

  MasterRepository.getWorkspace = (id) => ({ WorkspaceID: id, Status: 'ACTIVE' });
  SheetRepository.getActiveTimer = (wsId) => {
    checkedWorkspaces.push(wsId);
    if (wsId === 'W2') {
      return { TimerID: 'TMR-ACTIVE-W2', UserID: 'U1', StartedAtUTC: '2026-10-06T10:00:00Z' };
    }
    return null;
  };

  const authContext = {
    userId: 'U1',
    role: 'USER',
    accesses: [
      { WorkspaceID: 'W1', Active: true },
      { WorkspaceID: 'W2', Active: true },
      { WorkspaceID: 'W3', Active: true }
    ]
  };

  // When W2 is passed as preferredWorkspaceId, W2 must be inspected first and terminate early
  const result = TimerService._findActiveTimerAcrossWorkspaces(authContext, 'W2');
  assert.ok(result);
  assert.equal(result.workspaceId, 'W2');
  assert.equal(result.timer.TimerID, 'TMR-ACTIVE-W2');
  assert.deepEqual(checkedWorkspaces, ['W2']); // Only W2 was queried!
});

test('WorkspaceService.listWorkspaces filters out revoked/inactive access records', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { WorkspaceService, MasterRepository } = backend;

  MasterRepository.listWorkspaces = () => [
    { WorkspaceID: 'W1', WorkspaceName: 'Active Team', Status: 'ACTIVE' },
    { WorkspaceID: 'W2', WorkspaceName: 'Revoked Team', Status: 'ACTIVE' }
  ];

  const authContext = {
    userId: 'U1',
    role: 'USER',
    accesses: [
      { WorkspaceID: 'W1', Active: true },
      { WorkspaceID: 'W2', Active: false } // Inactive access
    ]
  };

  const list = WorkspaceService.listWorkspaces(authContext);
  assert.equal(list.length, 1);
  assert.equal(list[0].WorkspaceID, 'W1');
});

test('ReportService._prepareReportFilters rejects invalid date formats and inverted ranges', () => {
  cleanGlobals();
  const backend = require(codePath);
  const { ReportService, AuthorizationService, AppError } = backend;

  AuthorizationService.assertWorkspaceAccess = () => true;

  const authContext = { userId: 'U1', role: 'SUPER_ADMIN' };

  // Invalid startDate format
  assert.throws(
    () => ReportService._prepareReportFilters(authContext, 'W1', {
      filters: { startDate: 'not-a-valid-date' }
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400 &&
      err.message.includes('Invalid startDate filter format')
  );

  // Invalid endDate format
  assert.throws(
    () => ReportService._prepareReportFilters(authContext, 'W1', {
      filters: { endDate: 'invalid-end-date' }
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400 &&
      err.message.includes('Invalid endDate filter format')
  );

  // Inverted range (startDate after endDate)
  assert.throws(
    () => ReportService._prepareReportFilters(authContext, 'W1', {
      filters: {
        startDate: '2026-10-15T00:00:00.000Z',
        endDate: '2026-10-01T00:00:00.000Z'
      }
    }),
    err => err instanceof AppError &&
      err.code === 'VALIDATION_ERROR' &&
      err.statusCode === 400 &&
      err.message.includes('startDate cannot be after endDate')
  );

  // Valid date range passes
  const valid = ReportService._prepareReportFilters(authContext, 'W1', {
    filters: {
      startDate: '2026-10-01T00:00:00.000Z',
      endDate: '2026-10-15T00:00:00.000Z'
    }
  });
  assert.equal(valid.startDate, '2026-10-01T00:00:00.000Z');
  assert.equal(valid.endDate, '2026-10-15T00:00:00.000Z');
});

test('DashboardService._workspaceCurrentTotals bounds listTimeEntries query with week.startUtc', () => {
  cleanGlobals();
  let capturedFilters = null;

  const backend = require(codePath);
  const { DashboardService, TimezoneService, SheetRepository } = backend;

  const mockStartUtc = new Date('2026-09-26T22:00:00.000Z');

  TimezoneService.formatDateKey = () => '2026-09-29';
  TimezoneService.getWeekBounds = () => ({
    startLocalDate: '2026-09-27',
    endLocalDate: '2026-10-03',
    startUtc: mockStartUtc
  });

  SheetRepository.listTimeEntries = (_wsId, filters) => {
    capturedFilters = filters;
    return [
      {
        EntryID: 'E1',
        UserID: 'U1',
        StartUTC: '2026-09-29T10:00:00.000Z',
        DurationSeconds: 3600
      }
    ];
  };

  const authContext = { userId: 'U1', role: 'SUPER_ADMIN' };
  const totals = DashboardService._workspaceCurrentTotals(authContext, 'W1');

  assert.ok(capturedFilters);
  assert.equal(capturedFilters.startDate, '2026-09-26T22:00:00.000Z');
  assert.equal(totals.todaySeconds, 3600);
  assert.equal(totals.weekSeconds, 3600);
});



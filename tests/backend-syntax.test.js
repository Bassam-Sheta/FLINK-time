'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appDir = path.resolve(__dirname, '../apps-script');

test('deployable Apps Script layout is exactly one backend plus three portals and manifest', () => {
  const files = fs.readdirSync(appDir).sort();
  assert.deepEqual(files, [
    'Admin.html',
    'Code.gs',
    'SuperAdmin.html',
    'User.html',
    'appsscript.json'
  ]);
});

test('the single Code.gs backend parses and loads in an Apps Script-like global namespace', () => {
  const source = fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(source, { filename: 'Code.gs' }));

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }
  });
  new vm.Script(source, { filename: 'Code.gs' }).runInContext(context);

  const coreTypes = vm.runInContext("({" +
    "CONSTANTS:typeof CONSTANTS," +
    "ERROR_CODES:typeof ERROR_CODES," +
    "AppError:typeof AppError," +
    "Validation:typeof Validation," +
    "IdentityService:typeof IdentityService," +
    "SecurityService:typeof SecurityService," +
    "MasterRepository:typeof MasterRepository," +
    "SheetRepository:typeof SheetRepository," +
    "WorkspaceRouter:typeof WorkspaceRouter," +
    "AuthorizationService:typeof AuthorizationService," +
    "SessionService:typeof SessionService," +
    "AuthService:typeof AuthService," +
    "WorkspaceService:typeof WorkspaceService," +
    "UserService:typeof UserService," +
    "TrackingPolicyService:typeof TrackingPolicyService," +
    "TimerService:typeof TimerService," +
    "TimeEntryService:typeof TimeEntryService," +
    "TimesheetService:typeof TimesheetService," +
    "ApprovalService:typeof ApprovalService," +
    "ReportService:typeof ReportService," +
    "DashboardService:typeof DashboardService," +
    "BackupService:typeof BackupService," +
    "AuditService:typeof AuditService," +
    "ExportService:typeof ExportService," +
    "MigrationService:typeof MigrationService," +
    "JobService:typeof JobService," +
    "IntegrityService:typeof IntegrityService," +
    "SetupService:typeof SetupService," +
    "TimezoneService:typeof TimezoneService," +
    "App:typeof App," +
    "dispatchAction_:typeof dispatchAction_" +
    "})", context);

  const missing = Object.entries(coreTypes)
    .filter(([, type]) => type === 'undefined')
    .map(([name]) => name);
  assert.deepEqual(missing, []);
});

test('Code.gs routes the three Google Sites embed views explicitly', () => {
  const source = fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8');
  assert.match(source, /user:\s*'User'/);
  assert.match(source, /admin:\s*'Admin'/);
  assert.match(source, /superadmin:\s*'SuperAdmin'/);
  assert.match(source, /Unknown portal view/);
});

test('legacy package tree and executable artifacts are absent from active source', () => {
  const repoRoot = path.resolve(__dirname, '..');
  assert.equal(fs.existsSync(path.join(repoRoot, 'RELEASE_PACKAGE')), false);

  function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  }

  const executables = walk(repoRoot).filter(file =>
    file.toLowerCase().endsWith('.exe')
  );
  assert.deepEqual(executables, []);
});

test('modern API has no public system.bootstrap route', () => {
  const source = fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8');
  assert.equal(source.includes("'system.bootstrap'"), false);
  assert.equal(source.includes('handleDesktopAndControllerAction'), false);
});

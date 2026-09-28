'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backendDir = path.resolve(
  __dirname,
  '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS'
);

function deployableGsFiles() {
  return fs.readdirSync(backendDir)
    .filter(name => name.endsWith('.gs'))
    .sort();
}

test('every deployable Apps Script .gs file parses as JavaScript', () => {
  const files = deployableGsFiles();

  assert.ok(files.length > 20, 'expected the modern backend service set');

  const failures = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(backendDir, file), 'utf8');
    try {
      new vm.Script(source, { filename: file });
    } catch (err) {
      failures.push(file + ': ' + err.message);
    }
  }

  assert.deepEqual(failures, []);
});

test('all deployable .gs files load together in one Apps Script-like global namespace', () => {
  const files = deployableGsFiles();
  const preferredFirst = ['Constants.gs', 'Errors.gs'];
  const preferredLast = ['App.gs'];
  const middle = files.filter(file => !preferredFirst.includes(file) && !preferredLast.includes(file));
  const loadOrder = [...preferredFirst, ...middle, ...preferredLast];

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }
  });

  const failures = [];
  for (const file of loadOrder) {
    const source = fs.readFileSync(path.join(backendDir, file), 'utf8');
    try {
      new vm.Script(source, { filename: file }).runInContext(context);
    } catch (err) {
      failures.push(file + ': ' + err.message);
      break;
    }
  }

  assert.deepEqual(failures, [], 'backend files must coexist in the shared Apps Script global namespace');

  const coreTypes = vm.runInContext("({" +
    "CONSTANTS:typeof CONSTANTS," +
    "ERROR_CODES:typeof ERROR_CODES," +
    "AppError:typeof AppError," +
    "Validation:typeof Validation," +
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
    "dispatchAction:typeof dispatchAction" +
    "})", context);

  const missing = Object.entries(coreTypes)
    .filter(([, type]) => type === 'undefined')
    .map(([name]) => name);

  assert.deepEqual(missing, [], 'all core backend globals must be defined after load');
});

test('legacy backend/controller are not present in deployable Apps Script folder', () => {
  assert.equal(fs.existsSync(path.join(backendDir, 'Code.gs')), false);
  assert.equal(fs.existsSync(path.join(backendDir, 'admin_ui.html')), false);
});

test('modern API has no public system.bootstrap route', () => {
  const source = fs.readFileSync(path.join(backendDir, 'App.gs'), 'utf8');
  assert.equal(source.includes("'system.bootstrap'"), false);
  assert.equal(source.includes('handleDesktopAndControllerAction'), false);
});

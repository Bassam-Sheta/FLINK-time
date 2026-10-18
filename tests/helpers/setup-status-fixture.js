'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../apps-script/Code.gs'), 'utf8');

/**
 * Synthetic master-sheet fixture for the public setup.status endpoint.
 *
 * It counts transferred cells per sheet read and records full-table reads so a
 * test can prove the response cost does not grow with the Accounts table, which
 * is the first request a portal makes on page load.
 */
function setupStatusFixture(options = {}) {
  const accountRows = options.accountRows ?? 10;
  const setupFlag = options.setupFlag ?? 'true';
  const superAdminStatus = options.superAdminStatus ?? 'ACTIVE';
  const workspaceStatus = options.workspaceStatus ?? 'ACTIVE';
  const includeSuperAdmin = options.includeSuperAdmin !== false;

  const transfer = { cells: 0, reads: 0, fullTableReads: [] };

  const context = vm.createContext({
    console,
    Session: { getActiveUser: () => ({ getEmail: () => 'owner@example.test' }) }
  });
  vm.runInContext(source, context);

  const accounts = Array.from({ length: accountRows }, (_, index) => ({
    UserID: 'U' + index,
    Username: 'user' + index,
    Role: index === 0 && includeSuperAdmin ? 'SUPER_ADMIN' : 'USER',
    Status: index === 0 && includeSuperAdmin ? superAdminStatus : 'ACTIVE'
  }));
  const workspaces = [{ WorkspaceID: 'W1', WorkspaceCode: 'MAIN', WorkspaceName: 'Main', Status: workspaceStatus }];
  const settings = [{ SettingKey: 'SETUP_COMPLETE', SettingValue: setupFlag }];
  const tables = { Accounts: accounts, Workspaces: workspaces, GlobalSettings: settings };

  const sheets = {};
  for (const name of Object.keys(tables)) {
    const headers = context.MASTER_SCHEMA[name];
    const records = tables[name];
    const sheet = {
      getLastRow: () => records.length + 1,
      getLastColumn: () => headers.length,
      getDataRange() { return sheet.getRange(1, 1, records.length + 1, headers.length); },
      getRange(row, column, count, width) {
        return {
          getValues() {
            transfer.reads += 1;
            transfer.cells += count * width;
            if (count > 1 && width === headers.length) transfer.fullTableReads.push(name);
            const out = [];
            for (let offset = 0; offset < count; offset++) {
              const rowIndex = row + offset;
              const keys = headers.slice(column - 1, column - 1 + width);
              if (rowIndex === 1) { out.push(keys); continue; }
              const record = records[rowIndex - 2] || {};
              out.push(keys.map((key) => (record[key] === undefined ? '' : record[key])));
            }
            return out;
          },
          createTextFinder(value) {
            let caseSensitive = true;
            const matches = () => records
              .map((record, index) => ({ record, row: index + 2 }))
              .filter(({ record }) => {
                const actual = String(record[headers[column - 1]] ?? '');
                return caseSensitive ? actual === String(value) : actual.toLowerCase() === String(value).toLowerCase();
              });
            const finder = {
              matchEntireCell: () => finder,
              matchCase(flag) { caseSensitive = flag; return finder; },
              useRegularExpression: () => finder,
              findNext: () => (matches()[0] ? { getRow: () => matches()[0].row } : null),
              findAll: () => matches().map(({ row: matchRow }) => ({ getRow: () => matchRow }))
            };
            return finder;
          }
        };
      }
    };
    sheets[name] = sheet;
  }

  const book = {
    getSheetByName(name) {
      if (!sheets[name]) throw new Error('Unexpected table ' + name);
      return sheets[name];
    }
  };
  context.SpreadsheetApp = { openById: () => book, flush: () => {} };
  context.MasterRepository.spreadsheetId = 'SYNTHETIC-MASTER';

  return {
    transfer,
    // Copy into the host realm so deepEqual compares values, not vm prototypes.
    getStatus: () => ({ ...context.SetupService.getSetupStatus() }),
    resetCounters() { transfer.cells = 0; transfer.reads = 0; transfer.fullTableReads = []; }
  };
}

module.exports = { setupStatusFixture };

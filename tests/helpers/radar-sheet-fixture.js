'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSheetCallCounter } = require('./sheet-call-counter');

function radarSheetFixture(totalRows = 10, options = {}) {
  const context = vm.createContext({ console });
  vm.runInContext(options.source || fs.readFileSync(path.join(__dirname, '../../apps-script/Code.gs'), 'utf8'), context);
  const counter = createSheetCallCounter();
  let cells = 0;
  const records = {
    ActiveTimers: { TimerID: 'T1', UserID: 'U1', ProjectID: 'P1', StartedAtUTC: '2026-10-15T10:00:00Z' },
    Members: { UserID: 'U1', DisplayName: 'Synthetic User', Status: 'ACTIVE' },
    Projects: { ProjectID: 'P1', ProjectName: 'Synthetic Project', Status: 'ACTIVE' }
  };
  // Deliberately noncontiguous physical positions, including the end of a large
  // grid. No row-order/date-order shortcut can produce the expected result.
  const positions = { ActiveTimers: totalRows, Members: 3, Projects: totalRows - 2 };
  function record(name, row) {
    if (row === positions[name] && !(name === 'ActiveTimers' && options.idle)) return records[name];
    return { UserID: 'OTHER-' + row, TimerID: 'OTHER-T-' + row, ProjectID: 'OTHER-P-' + row, Status: 'ACTIVE' };
  }
  const book = {
    getSheetByName(name) {
      const headers = context.WORKSPACE_SCHEMA[name];
      if (!headers || !records[name]) throw new Error('Unexpected radar table: ' + name);
      function range(row, column, height, width) {
        return {
          getValues() {
            cells += height * width;
            return Array.from({ length: height }, (_, offset) => {
              if (row + offset === 1) return Array.from(headers).slice(column - 1, column - 1 + width);
              const data = record(name, row + offset);
              return Array.from(headers).slice(column - 1, column - 1 + width).map(key => data[key] ?? '');
            });
          },
          createTextFinder(value) {
            const key = headers[column - 1];
            const position = positions[name];
            const found = position >= row && position < row + height && record(name, position)[key] === value;
            const finder = {
              matchEntireCell: () => finder,
              matchCase: () => finder,
              useRegularExpression: () => finder,
              findNext: () => found ? { getRow: () => position } : null
            };
            return finder;
          }
        };
      }
      return {
        getLastRow: () => totalRows + 1,
        getLastColumn: () => headers.length,
        getRange: range,
        getDataRange: () => range(1, 1, totalRows + 1, headers.length)
      };
    }
  };
  const wrapped = counter.wrap(book);
  context.WorkspaceRouter.resolveSpreadsheet = () => wrapped;
  context.WorkspaceService.listWorkspaces = () => [{ WorkspaceID: 'W1', WorkspaceName: 'Synthetic Workspace' }];
  return {
    context,
    run(role = 'USER') {
      context.SheetRepository.beginRequest();
      cells = 0;
      counter.reset();
      const result = context.DashboardService.getLiveWorkforceRadar({ userId: 'U1', role }, 'W1');
      return { result, cells, calls: counter.snapshot() };
    }
  };
}

module.exports = { radarSheetFixture };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');

function runSingleLookup(totalRows, tabName, columnName, value, rowObject) {
  const counters = {
    getRange: 0,
    getValues: 0,
    createTextFinder: 0,
    findNext: 0,
    findAll: 0,
    getDataRange: 0
  };

  delete require.cache[require.resolve(codePath)];
  const mod = require(codePath);
  const headers = mod.MASTER_SCHEMA[tabName];
  const keyIndex = headers.indexOf(columnName);
  const targetRow = Math.max(2, Math.min(totalRows, 7));

  const toValues = obj => headers.map(h => obj[h] === undefined ? '' : obj[h]);

  const sheet = {
    getLastRow() { return totalRows; },
    getRange(row, col, numRows, numCols) {
      counters.getRange++;
      return {
        createTextFinder(search) {
          counters.createTextFinder++;
          assert.equal(String(search), String(value));
          return {
            matchEntireCell() { return this; },
            matchCase() { return this; },
            findNext() {
              counters.findNext++;
              return { getRow() { return targetRow; } };
            },
            findAll() {
              counters.findAll++;
              return [{ getRow() { return targetRow; } }];
            }
          };
        },
        getValues() {
          counters.getValues++;
          if (row === targetRow && col === 1 && numRows === 1 && numCols === headers.length) {
            return [toValues(rowObject)];
          }
          throw new Error('Unexpected row read in bounded lookup test');
        }
      };
    },
    getDataRange() {
      counters.getDataRange++;
      throw new Error('getDataRange must not be used by bounded lookup');
    }
  };

  global.SpreadsheetApp = {
    openById() {
      return {
        getSheetByName(name) {
          assert.equal(name, tabName);
          return sheet;
        }
      };
    }
  };

  mod.MasterRepository.spreadsheetId = 'MASTER';
  const result = mod.MasterRepository.findRowByKey(tabName, columnName, value);
  return { counters, result, keyIndex };
}

test('single-row master lookup call count is independent of table size', () => {
  const row = {
    SessionID: 'SES-1',
    UserID: 'USR-1',
    TokenHash: 'HASH-1',
    Revoked: false
  };
  const small = runSingleLookup(10, 'Sessions', 'TokenHash', 'HASH-1', row);
  const large = runSingleLookup(50000, 'Sessions', 'TokenHash', 'HASH-1', row);

  assert.deepEqual(large.counters, small.counters);
  assert.equal(small.counters.getDataRange, 0);
  assert.equal(small.counters.getRange, 2);
  assert.equal(small.counters.getValues, 1);
  assert.equal(small.result.TokenHash, 'HASH-1');
});

function runAccessLookup(totalRows) {
  const counters = {
    getRange: 0,
    getValues: 0,
    createTextFinder: 0,
    findAll: 0,
    getDataRange: 0
  };

  delete require.cache[require.resolve(codePath)];
  const mod = require(codePath);
  const headers = mod.MASTER_SCHEMA.WorkspaceAccess;
  const targetRows = [3, 8];
  const objects = {
    3: { AccessID:'A1', UserID:'USR-1', WorkspaceID:'W1', Role:'USER', Active:true },
    8: { AccessID:'A2', UserID:'USR-1', WorkspaceID:'W2', Role:'USER', Active:true }
  };
  const toValues = obj => headers.map(h => obj[h] === undefined ? '' : obj[h]);

  const sheet = {
    getLastRow() { return totalRows; },
    getRange(row, col, numRows, numCols) {
      counters.getRange++;
      return {
        createTextFinder() {
          counters.createTextFinder++;
          return {
            matchEntireCell() { return this; },
            matchCase() { return this; },
            findAll() {
              counters.findAll++;
              return targetRows.map(r => ({ getRow() { return r; } }));
            }
          };
        },
        getValues() {
          counters.getValues++;
          if (numRows === 1 && numCols === headers.length && objects[row]) {
            return [toValues(objects[row])];
          }
          throw new Error('Unexpected row read in bounded access test');
        }
      };
    },
    getDataRange() {
      counters.getDataRange++;
      throw new Error('getDataRange must not be used by bounded access lookup');
    }
  };

  global.SpreadsheetApp = {
    openById() {
      return { getSheetByName() { return sheet; } };
    }
  };

  mod.MasterRepository.spreadsheetId = 'MASTER';
  const rows = mod.MasterRepository.getWorkspaceAccessForUser('USR-1');
  return { counters, rows };
}

test('workspace-access lookup call count is independent of table size', () => {
  const small = runAccessLookup(10);
  const large = runAccessLookup(50000);

  assert.deepEqual(large.counters, small.counters);
  assert.equal(small.counters.getDataRange, 0);
  assert.equal(small.rows.length, 2);
  assert.ok(small.counters.getRange <= 3);
});

test('MasterRepository.findRowByKey and findRowsByKey reuse in-memory _requestCache without sheet calls', () => {
  delete require.cache[require.resolve(codePath)];
  const mod = require(codePath);
  mod.MasterRepository.beginRequest();

  // Populate cache directly as getTableData would
  mod.MasterRepository._requestCache['Accounts'] = {
    headers: ['UserID', 'Email', 'Role', 'Status'],
    rows: [
      { _rowIndex: 2, UserID: 'USR-CACHED-1', Email: 'cached1@flink.test', Role: 'USER', Status: 'ACTIVE' },
      { _rowIndex: 3, UserID: 'USR-CACHED-2', Email: 'cached2@flink.test', Role: 'ADMIN', Status: 'ACTIVE' }
    ]
  };

  let getSheetCalls = 0;
  global.SpreadsheetApp = {
    openById() {
      getSheetCalls++;
      throw new Error('SpreadsheetApp should not be called when table is cached');
    }
  };

  const single = mod.MasterRepository.findRowByKey('Accounts', 'Email', 'cached2@flink.test');
  assert.ok(single);
  assert.equal(single.UserID, 'USR-CACHED-2');
  assert.equal(single._rowIndex, 3);
  assert.equal(getSheetCalls, 0);

  const multiple = mod.MasterRepository.findRowsByKey('Accounts', 'Role', 'USER');
  assert.equal(multiple.length, 1);
  assert.equal(multiple[0].UserID, 'USR-CACHED-1');
  assert.equal(getSheetCalls, 0);
});


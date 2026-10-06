'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createSheetCallCounter } = require('./sheet-call-counter');

const source = fs.readFileSync(path.resolve(__dirname, '../../apps-script/Code.gs'), 'utf8');

function sessionSheetFixture(totalRows = 10) {
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const counter = createSheetCallCounter();
  const cache = new Map();
  const controls = { failRemove: false, lockAvailable: true, onLock: null, onSessionRead: null, locked: false };
  const lock = {
    hasLock: () => controls.locked,
    tryLock: () => {
      if (!controls.lockAvailable) return false;
      controls.locked = true;
      if (controls.onLock) controls.onLock();
      return true;
    },
    waitLock: () => {
      if (!lock.tryLock()) throw new Error('Lock timeout');
    },
    releaseLock: () => { controls.locked = false; }
  };
  const context = vm.createContext({
    Date: ClockDate,
    console,
    Session: { getActiveUser: () => ({ getEmail: () => 'user@example.test' }) },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({
      get(key) {
        const entry = cache.get(key);
        if (!entry || entry.expires <= clock.now) return null;
        return entry.value;
      },
      put(key, value, seconds) { cache.set(key, { value, expires: clock.now + seconds * 1000 }); },
      remove(key) { if (!controls.failRemove) cache.delete(key); },
      removeAll(keys) { for (const key of keys) if (!controls.failRemove) cache.delete(key); }
    }) }
  });
  vm.runInContext(source, context);
  context.SecurityService.hashToken = () => 'HASH-1';
  const session = {
    SessionID: 'S1', UserID: 'U1', TokenHash: 'HASH-1', ClientType: 'WEB', ClientLabel: 'user@example.test',
    CreatedAt: new Date(clock.now - 3600000).toISOString(),
    LastSeenAt: new Date(clock.now - 60000).toISOString(),
    ExpiresAt: new Date(clock.now + 3600000).toISOString(),
    AbsoluteExpiresAt: new Date(clock.now + 7200000).toISOString(),
    Revoked: false, AccountEpoch: 1
  };
  const account = { UserID: 'U1', Username: 'user', Email: 'user@example.test', Role: 'USER', Status: 'ACTIVE', SessionEpoch: 1 };
  const tables = {
    Sessions: new Map([[7, session]]),
    Accounts: new Map([[7, account]]),
    WorkspaceAccess: new Map(),
    GlobalSettings: new Map()
  };
  const book = {
    getSheetByName(name) {
      const headers = context.MASTER_SCHEMA[name];
      if (!headers || !tables[name]) throw new Error('Unexpected table ' + name);
      const table = tables[name];
      const sheet = {
        getLastRow: () => name === 'GlobalSettings' ? 1 : totalRows,
        getLastColumn: () => headers.length,
        getRange(row, column, count, width) {
          return {
            getValues() {
              assertBounded(name, row, count);
              if (name === 'Sessions' && row > 1 && controls.onSessionRead) controls.onSessionRead();
              return Array.from({ length: count }, (_, offset) => {
                if (row + offset === 1) return Array.from(headers).slice(column - 1, column - 1 + width);
                const record = table.get(row + offset) || {};
                return Array.from(headers).slice(column - 1, column - 1 + width).map(key => record[key] ?? '');
              });
            },
            setValues(rows) {
              if (!controls.locked) throw new Error('Session writes must hold the script lock');
              for (let offset = 0; offset < rows.length; offset++) {
                const record = table.get(row + offset);
                if (!record) throw new Error('Writing missing row');
                rows[offset].forEach((value, i) => { record[headers[column - 1 + i]] = value; });
              }
            },
            createTextFinder(value) {
              let caseSensitive = true;
              let next = 0;
              const matches = () => [...table].filter(([, record]) => {
                const actual = String(record[headers[column - 1]] ?? '');
                return caseSensitive ? actual === String(value) : actual.toLowerCase() === String(value).toLowerCase();
              }).map(([index]) => index);
              const finder = {
                matchEntireCell: () => finder,
                matchCase: flag => { caseSensitive = flag; return finder; },
                useRegularExpression: () => finder,
                findNext: () => {
                  const all = matches();
                  if (!all.length) return null;
                  const index = all[next++ % all.length];
                  return { getRow: () => index };
                },
                findAll: () => matches().map(index => ({ getRow: () => index }))
              };
              return finder;
            }
          };
        },
        getDataRange() {
          if (name !== 'GlobalSettings') throw new Error('Growing-table scan: ' + name);
          return sheet.getRange(1, 1, 1, headers.length);
        }
      };
      return sheet;
    }
  };
  function assertBounded(name, row, count) {
    if (name !== 'GlobalSettings' && count !== 1) throw new Error('Unbounded row transfer: ' + name);
  }
  context.SpreadsheetApp = counter.wrap({ openById: () => book, flush: () => {} });
  context.MasterRepository.spreadsheetId = 'SYNTHETIC-MASTER';
  return {
    context, clock, controls, cache, counter, session, account, tables,
    validate() {
      context.MasterRepository.beginRequest();
      context.Flags.beginRequest();
      return context.SessionService.validateSession('SYNTHETIC-TOKEN');
    }
  };
}

module.exports = { sessionSheetFixture };

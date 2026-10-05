/**
 * PartStore — storage v2 Sheets layer (talks only to an injected Spreadsheet-like object).
 *
 * Tabs per user inside a part spreadsheet:  E_<email> (Entries, 12 cols)  L_<email> (Log, 6 cols).
 * Write order is LOG FIRST, then Entries. The Log is the source of truth: if a crash happens
 * between the two writes, verify() reports it and rebuildEntries() restores Entries from the Log.
 *
 * Spreadsheet-like contract (subset of SpreadsheetApp):
 *   ss.getSheetByName(n) / ss.insertSheet(n) / ss.getSheets()
 *   sheet.getName(), getMaxRows(), getMaxColumns(), getLastRow(), insertRowsAfter(pos,n),
 *   deleteRows(start,n), deleteColumns(start,n), getRange(r,c,nr,nc) -> {getValues,setValues,setNumberFormat}
 */
const PartStore = (function () {
  'use strict';

  const ENTRY_COLS = 12;
  const LOG_COLS = 6;
  const TEXT_ENTRY_COLS = [1, 2, 3, 5, 6, 7, 9, 10, 12];   // EntryId,Start,End,Project,Task,Tags,Description,WorkMode,Status
  const EMAIL_RE = /^[a-z0-9._%+\-]{1,64}@[a-z0-9.\-]{1,60}$/;

  function fail_(code, message) {
    const e = new Error('PartStore: ' + message);
    e.code = code;
    throw e;
  }

  function createStore(deps) {
    if (!deps || !deps.chain) fail_('BAD_DEPS', 'chain (LogChain instance) is required');
    const chain = deps.chain;
    const blockRows = deps.blockRows || 500;
    const LogChainApi = deps.LogChain;                  // static helpers (columns, canonicalJson)
    if (!LogChainApi) fail_('BAD_DEPS', 'LogChain static API is required');

    function normUser_(userId) {
      const u = String(userId || '').toLowerCase();
      if (!EMAIL_RE.test(u)) fail_('BAD_USER', 'user id must be a plain lowercase email');
      return u;
    }
    function names(userId) {
      const u = normUser_(userId);
      return { entries: 'E_' + u, log: 'L_' + u };
    }

    function ensureRows_(sheet, neededRow) {
      const max = sheet.getMaxRows();
      if (max < neededRow) sheet.insertRowsAfter(max, Math.max(blockRows, neededRow - max));
    }

    function makeTab_(ss, name, cols, headers, textCols) {
      let sheet = ss.getSheetByName(name);
      if (sheet) return sheet;
      sheet = ss.insertSheet(name);
      if (sheet.getMaxColumns() > cols) sheet.deleteColumns(cols + 1, sheet.getMaxColumns() - cols);
      const wanted = 1 + blockRows;
      if (sheet.getMaxRows() > wanted) sheet.deleteRows(wanted + 1, sheet.getMaxRows() - wanted);
      if (sheet.getMaxRows() < wanted) sheet.insertRowsAfter(sheet.getMaxRows(), wanted - sheet.getMaxRows());
      // plain text BEFORE any data so ISO timestamps are never turned into dates and '=' is never a formula
      textCols.forEach(function (c) { sheet.getRange(1, c, sheet.getMaxRows(), 1).setNumberFormat('@'); });
      sheet.getRange(1, 1, 1, cols).setValues([headers]);
      return sheet;
    }

    function ensureUserTabs(ss, userId) {
      const n = names(userId);
      const entries = makeTab_(ss, n.entries, ENTRY_COLS, LogChainApi.ENTRY_COLUMNS, TEXT_ENTRY_COLS);
      const log = makeTab_(ss, n.log, LOG_COLS, LogChainApi.LOG_COLUMNS, [1, 2, 3, 4, 5, 6]);
      return { entries: entries, log: log };
    }

    function tabs_(ss, userId) {
      const n = names(userId);
      const entries = ss.getSheetByName(n.entries);
      const log = ss.getSheetByName(n.log);
      if (!entries || !log) fail_('NO_TABS', 'user tabs are missing; call ensureUserTabs first');
      return { entries: entries, log: log };
    }

    function allocatedCells(ss) {
      return ss.getSheets().reduce(function (sum, s) { return sum + s.getMaxRows() * s.getMaxColumns(); }, 0);
    }

    function lastHash_(logSheet) {
      const last = logSheet.getLastRow();
      return last <= 1 ? null : String(logSheet.getRange(last, LOG_COLS, 1, 1).getValues()[0][0]);
    }

    /** Tail-first search (running timers are almost always among the newest rows). */
    function findEntryRow_(entriesSheet, entryId, tailOnly) {
      const last = entriesSheet.getLastRow();
      if (last <= 1) return 0;
      const tail = Math.min(200, last - 1);
      let start = last - tail + 1;
      let ids = entriesSheet.getRange(start, 1, tail, 1).getValues();
      for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] === entryId) return start + i;
      if (!tailOnly && start > 2) {
        ids = entriesSheet.getRange(2, 1, start - 2, 1).getValues();
        for (let j = ids.length - 1; j >= 0; j--) if (ids[j][0] === entryId) return 2 + j;
      }
      return 0;
    }

    function readEntry_(entriesSheet, row) {
      return LogChainApi.rowToEntry(entriesSheet.getRange(row, 1, 1, ENTRY_COLS).getValues()[0]);
    }

    /** Appends the single log row. Throws FORK_DETECTED if anything else appended meanwhile. */
    function appendLog_(logSheet, logRow) {
      logRow.forEach(function (cell) {
        if (typeof cell === 'string' && cell.length > 50000) fail_('CELL_TOO_LARGE', 'log cell exceeds the 50,000 character Sheets limit');
      });
      const row = logSheet.getLastRow() + 1;
      ensureRows_(logSheet, row);
      logSheet.getRange(row, 1, 1, LOG_COLS).setValues([logRow]);
      if (logSheet.getLastRow() !== row) fail_('FORK_DETECTED', 'concurrent append detected on the user log');
    }

    function writeEntry_(entriesSheet, row, entryRow) {
      ensureRows_(entriesSheet, row);
      entriesSheet.getRange(row, 1, 1, ENTRY_COLS).setValues([entryRow]);
    }

    /** Idempotent: an existing EntryId is returned, not duplicated. */
    function start(ss, userId, chainKey, tsUtc, actor, entryInput, kind) {
      const t = tabs_(ss, userId);
      const existing = findEntryRow_(t.entries, entryInput.EntryId, true);
      if (existing) return { duplicate: true, entry: readEntry_(t.entries, existing) };
      const prev = lastHash_(t.log) || chain.genesisHash(chainKey);
      const b = chain.buildCreate(prev, tsUtc, actor, entryInput, kind || 'START');
      appendLog_(t.log, b.logRow);
      writeEntry_(t.entries, t.entries.getLastRow() + 1, b.entryRow);
      return { duplicate: false, entry: b.entry };
    }

    /** event: STOP | EDIT | DELETE | STATUS. */
    function change(ss, userId, chainKey, tsUtc, actor, event, entryId, patch) {
      const t = tabs_(ss, userId);
      const row = findEntryRow_(t.entries, entryId);
      if (!row) fail_('NO_ENTRY', 'entry not found in this part: ' + entryId);
      const before = readEntry_(t.entries, row);
      const prev = lastHash_(t.log) || chain.genesisHash(chainKey);
      const b = chain.buildChange(prev, tsUtc, actor, event, before, patch);
      appendLog_(t.log, b.logRow);
      writeEntry_(t.entries, row, b.entryRow);
      return { entry: b.entry, changes: b.changes };
    }

    function readLog_(logSheet) {
      const last = logSheet.getLastRow();
      return last <= 1 ? [] : logSheet.getRange(2, 1, last - 1, LOG_COLS).getValues();
    }
    function readEntries_(entriesSheet) {
      const last = entriesSheet.getLastRow();
      return last <= 1 ? [] : entriesSheet.getRange(2, 1, last - 1, ENTRY_COLS).getValues();
    }

    /** Full integrity check: hash chain + replay equals the Entries tab. */
    function verify(ss, userId, chainKey) {
      const t = tabs_(ss, userId);
      const logRows = readLog_(t.log);
      const c = chain.verifyChain(chainKey, logRows);
      if (!c.ok) return { ok: false, chain: c, compare: null };
      const cmp = chain.compareToEntries(logRows, readEntries_(t.entries));
      return { ok: cmp.ok, chain: c, compare: cmp, rows: logRows.length };
    }

    /** Restores Entries from the (verified) Log, in order of first appearance. */
    function rebuildEntries(ss, userId, chainKey) {
      const t = tabs_(ss, userId);
      const logRows = readLog_(t.log);
      const c = chain.verifyChain(chainKey, logRows);
      if (!c.ok) fail_('CHAIN_BROKEN', 'refusing to rebuild from a broken log (row ' + c.index + ')');
      const map = chain.replay(logRows);
      const order = [];
      logRows.forEach(function (r) { if (order.indexOf(r[1]) === -1) order.push(r[1]); });
      const rows = order.map(function (id) { return LogChainApi.entryToRow(map[id]); });
      const old = t.entries.getLastRow();
      if (old > 1) t.entries.getRange(2, 1, old - 1, ENTRY_COLS).setValues(
        Array.from({ length: old - 1 }, function () { return new Array(ENTRY_COLS).fill(''); }));
      if (rows.length) {
        ensureRows_(t.entries, rows.length + 1);
        t.entries.getRange(2, 1, rows.length, ENTRY_COLS).setValues(rows);
      }
      return { rebuilt: rows.length };
    }

    /** Read-only lookup (full search). Returns the entry or null. */
    function getEntry(ss, userId, entryId) {
      const t = tabs_(ss, userId);
      const row = findEntryRow_(t.entries, entryId);
      return row ? readEntry_(t.entries, row) : null;
    }

    return {
      names: names, ensureUserTabs: ensureUserTabs, allocatedCells: allocatedCells,
      start: start, change: change, getEntry: getEntry, verify: verify, rebuildEntries: rebuildEntries
    };
  }

  /** "<Workspace> — Group N — Part M" (Drive/Sheets-safe). */
  function partName(workspaceName, groupNo, partNo) {
    const ws = String(workspaceName || '').replace(/[\\/:*?"<>|\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!ws) fail_('BAD_ARGS', 'workspace name is required');
    if (!(groupNo >= 1 && partNo >= 1)) fail_('BAD_ARGS', 'group and part numbers must be >= 1');
    return ws + ' \u2014 Group ' + groupNo + ' \u2014 Part ' + partNo;
  }

  return { createStore: createStore, partName: partName, EMAIL_RE: EMAIL_RE };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PartStore;
}

/**
 * LogChain — storage v2 building block (pure logic, no Sheets/Apps Script calls).
 *
 * Per user and workspace there are two tabs:
 *   Entries (12 cols): EntryId, StartUTC, EndUTC, DurationSec, ProjectId, TaskId,
 *                      Tags, Billable, Description, WorkMode, Version, Status
 *   Log     (6 cols):  TsUTC, EntryId, Event, Actor, Payload, Hash
 *
 * Every start, stop, manual add, edit, delete and status change appends exactly
 * one Log row. Payload is a single canonical-JSON cell that fully describes the
 * change, so replaying the Log reproduces the Entries tab exactly. The previous
 * hash is NOT stored: it is the previous row's Hash (genesis is bound to the
 * user), and Hash = SHA-256(prevHash|TsUTC|EntryId|Event|Actor|Payload).
 *
 * The hash function is injected so the same code runs in Node (tests) and in
 * Apps Script (Utilities.computeDigest).
 */
const LogChain = (function () {
  'use strict';

  const ENTRY_COLUMNS = [
    'EntryId', 'StartUTC', 'EndUTC', 'DurationSec', 'ProjectId', 'TaskId',
    'Tags', 'Billable', 'Description', 'WorkMode', 'Version', 'Status'
  ];
  const LOG_COLUMNS = ['TsUTC', 'EntryId', 'Event', 'Actor', 'Payload', 'Hash'];
  const EVENTS = ['START', 'MANUAL_ADD', 'STOP', 'EDIT', 'DELETE', 'STATUS'];
  const STATUSES = ['RUNNING', 'STOPPED', 'DELETED', 'SUBMITTED', 'APPROVED', 'REJECTED', 'LOCKED'];
  const WORK_MODES = ['', 'OFFICE', 'WFH'];
  const EDITABLE_FIELDS = [
    'StartUTC', 'EndUTC', 'ProjectId', 'TaskId', 'Tags', 'Billable',
    'Description', 'WorkMode', 'Status'
  ];
  const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  const SHEETS_CELL_CAP = 10000000;
  const ROLLOVER_RATIO = 0.7;

  function fail_(message) {
    throw new Error('LogChain: ' + message);
  }

  /** Deterministic JSON: sorted keys, no undefined, finite numbers only. */
  function canonicalJson(value) {
    if (value === null) return 'null';
    const type = typeof value;
    if (type === 'string' || type === 'boolean') return JSON.stringify(value);
    if (type === 'number') {
      if (!isFinite(value)) fail_('non-finite number in payload');
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
    if (type === 'object') {
      if (value instanceof Date) fail_('Date objects are not allowed in payloads');
      return '{' + Object.keys(value).sort().filter(function (k) {
        return value[k] !== undefined;
      }).map(function (k) {
        return JSON.stringify(k) + ':' + canonicalJson(value[k]);
      }).join(',') + '}';
    }
    return fail_('unsupported payload value type: ' + type);
  }

  function isIso_(value) {
    return typeof value === 'string' && ISO_UTC.test(value) && !isNaN(Date.parse(value));
  }

  function durationSec(startUtc, endUtc) {
    const ms = Date.parse(endUtc) - Date.parse(startUtc);
    if (!(ms >= 0)) fail_('EndUTC is before StartUTC');
    return Math.floor(ms / 1000);
  }

  /** Validates and returns a canonical 12-field entry object. */
  function normalizeEntry(input) {
    const e = input || {};
    const out = {
      EntryId: String(e.EntryId === undefined || e.EntryId === null ? '' : e.EntryId),
      StartUTC: e.StartUTC === undefined || e.StartUTC === null ? '' : e.StartUTC,
      EndUTC: e.EndUTC === undefined || e.EndUTC === null ? '' : e.EndUTC,
      DurationSec: e.DurationSec === undefined || e.DurationSec === null || e.DurationSec === '' ? 0 : Number(e.DurationSec),
      ProjectId: String(e.ProjectId === undefined || e.ProjectId === null ? '' : e.ProjectId),
      TaskId: String(e.TaskId === undefined || e.TaskId === null ? '' : e.TaskId),
      Tags: String(e.Tags === undefined || e.Tags === null ? '' : e.Tags),
      Billable: e.Billable === true || e.Billable === 'TRUE' || e.Billable === 'true',
      Description: String(e.Description === undefined || e.Description === null ? '' : e.Description),
      WorkMode: String(e.WorkMode === undefined || e.WorkMode === null ? '' : e.WorkMode),
      Version: e.Version === undefined || e.Version === null || e.Version === '' ? 1 : Number(e.Version),
      Status: String(e.Status === undefined || e.Status === null ? '' : e.Status)
    };
    if (!out.EntryId) fail_('EntryId is required');
    if (!isIso_(out.StartUTC)) fail_('StartUTC must be ISO UTC with milliseconds');
    if (out.EndUTC !== '' && !isIso_(out.EndUTC)) fail_('EndUTC must be empty or ISO UTC with milliseconds');
    if (STATUSES.indexOf(out.Status) === -1) fail_('invalid Status: ' + out.Status);
    if (WORK_MODES.indexOf(out.WorkMode) === -1) fail_('invalid WorkMode: ' + out.WorkMode);
    if (!(isFinite(out.Version) && out.Version >= 1 && Math.floor(out.Version) === out.Version)) fail_('invalid Version');
    if (!(isFinite(out.DurationSec) && out.DurationSec >= 0 && Math.floor(out.DurationSec) === out.DurationSec)) {
      fail_('invalid DurationSec');
    }
    if (out.Status === 'RUNNING') {
      if (out.EndUTC !== '') fail_('a RUNNING entry cannot have EndUTC');
      if (out.DurationSec !== 0) fail_('a RUNNING entry must have DurationSec 0');
    } else {
      if (out.EndUTC === '') fail_('a non-running entry requires EndUTC');
      if (out.DurationSec !== durationSec(out.StartUTC, out.EndUTC)) fail_('DurationSec does not match Start/End');
    }
    return out;
  }

  function entryToRow(entry) {
    return ENTRY_COLUMNS.map(function (c) { return entry[c]; });
  }

  function rowToEntry(row) {
    if (!row || row.length !== ENTRY_COLUMNS.length) fail_('entry row must have ' + ENTRY_COLUMNS.length + ' cells');
    const o = {};
    ENTRY_COLUMNS.forEach(function (c, i) { o[c] = row[i]; });
    return normalizeEntry(o);
  }

  function create(options) {
    const sha256Hex = options && options.sha256Hex;
    if (typeof sha256Hex !== 'function') fail_('sha256Hex function is required');

    function genesisHash(userId) {
      if (!userId) fail_('userId is required');
      return sha256Hex('FLINK-LOG-GENESIS|' + userId);
    }

    function rowHash_(prevHash, row) {
      return sha256Hex(prevHash + '|' + canonicalJson([row[0], row[1], row[2], row[3], row[4]]));
    }

    function makeLogRow_(prevHash, tsUtc, entryId, event, actor, payload) {
      if (!isIso_(tsUtc)) fail_('TsUTC must be ISO UTC with milliseconds');
      if (EVENTS.indexOf(event) === -1) fail_('invalid event: ' + event);
      if (!actor) fail_('actor is required');
      const row = [tsUtc, String(entryId), event, String(actor), canonicalJson(payload)];
      row.push(rowHash_(prevHash, row));
      return row;
    }

    /** START (open timer) or MANUAL_ADD (closed entry): one Entries row + one Log row. */
    function buildCreate(prevHash, tsUtc, actor, entryInput, event) {
      const kind = event || 'START';
      if (kind !== 'START' && kind !== 'MANUAL_ADD') fail_('buildCreate event must be START or MANUAL_ADD');
      const input = Object.assign({}, entryInput, { Version: 1 });
      if (kind === 'START') {
        input.Status = 'RUNNING'; input.EndUTC = ''; input.DurationSec = 0;
      } else {
        input.Status = 'STOPPED';
        if (input.EndUTC) input.DurationSec = durationSec(input.StartUTC, input.EndUTC);
      }
      const entry = normalizeEntry(input);
      return {
        entry: entry,
        entryRow: entryToRow(entry),
        logRow: makeLogRow_(prevHash, tsUtc, entry.EntryId, kind, actor, { after: entry })
      };
    }

    /**
     * Applies a patch to an existing entry. event: STOP | EDIT | DELETE | STATUS.
     * Returns the new entry, its row, the single Log row and the change set.
     */
    function buildChange(prevHash, tsUtc, actor, event, before, patchInput) {
      if (['STOP', 'EDIT', 'DELETE', 'STATUS'].indexOf(event) === -1) fail_('buildChange event invalid: ' + event);
      const current = normalizeEntry(before);
      const patch = Object.assign({}, patchInput);
      Object.keys(patch).forEach(function (k) {
        if (EDITABLE_FIELDS.indexOf(k) === -1) fail_('field is not editable: ' + k);
      });
      if (event === 'STOP') {
        if (current.Status !== 'RUNNING') fail_('only a RUNNING entry can be stopped');
        if (!isIso_(patch.EndUTC)) fail_('STOP requires EndUTC');
        patch.Status = 'STOPPED';
      } else if (event === 'DELETE') {
        if (current.Status === 'RUNNING') fail_('stop the entry before deleting it');
        if (current.Status === 'DELETED') fail_('entry is already deleted');
        patch.Status = 'DELETED';
      } else if (current.Status === 'RUNNING' && event === 'EDIT' && patch.EndUTC) {
        fail_('use STOP to end a running entry');
      }
      const next = Object.assign({}, current);
      Object.keys(patch).forEach(function (k) { next[k] = patch[k]; });
      if (next.Status !== 'RUNNING' && next.EndUTC !== '' && isIso_(next.StartUTC) && isIso_(next.EndUTC)) {
        next.DurationSec = durationSec(next.StartUTC, next.EndUTC);
      }
      const changes = {};
      ENTRY_COLUMNS.forEach(function (c) {
        if (c !== 'Version' && next[c] !== current[c]) changes[c] = [current[c], next[c]];
      });
      if (Object.keys(changes).length === 0) fail_('change has no effect');
      next.Version = current.Version + 1;
      changes.Version = [current.Version, next.Version];
      const entry = normalizeEntry(next);
      return {
        entry: entry,
        entryRow: entryToRow(entry),
        changes: changes,
        logRow: makeLogRow_(prevHash, tsUtc, entry.EntryId, event, actor, { changes: changes })
      };
    }

    /** Re-computes the whole chain. Returns {ok:true} or {ok:false,index,reason}. */
    function verifyChain(userId, logRows) {
      let prev = genesisHash(userId);
      for (let i = 0; i < logRows.length; i++) {
        const r = logRows[i];
        if (!r || r.length !== LOG_COLUMNS.length) return { ok: false, index: i, reason: 'bad row width' };
        if (!isIso_(r[0])) return { ok: false, index: i, reason: 'bad TsUTC' };
        if (EVENTS.indexOf(r[2]) === -1) return { ok: false, index: i, reason: 'bad event' };
        if (rowHash_(prev, r) !== r[5]) return { ok: false, index: i, reason: 'hash mismatch' };
        prev = r[5];
      }
      return { ok: true, head: prev };
    }

    /** Rebuilds all entries from the Log alone. Throws on any inconsistency. */
    function replay(logRows) {
      const map = {};
      logRows.forEach(function (r, i) {
        const id = r[1];
        const payload = JSON.parse(r[4]);
        if (r[2] === 'START' || r[2] === 'MANUAL_ADD') {
          if (map[id]) fail_('row ' + i + ': duplicate create for ' + id);
          map[id] = normalizeEntry(payload.after);
          return;
        }
        const cur = map[id];
        if (!cur) fail_('row ' + i + ': change for unknown entry ' + id);
        const next = Object.assign({}, cur);
        Object.keys(payload.changes).forEach(function (field) {
          const pair = payload.changes[field];
          if (canonicalJson(cur[field]) !== canonicalJson(pair[0])) {
            fail_('row ' + i + ': old value mismatch for ' + field);
          }
          next[field] = pair[1];
        });
        map[id] = normalizeEntry(next);
      });
      return map;
    }

    /** Compares replayed entries with the live Entries rows. */
    function compareToEntries(logRows, entryRows) {
      const replayed = replay(logRows);
      const diffs = [];
      const seen = {};
      entryRows.forEach(function (row) {
        const e = rowToEntry(row);
        seen[e.EntryId] = true;
        if (!replayed[e.EntryId]) diffs.push('entry ' + e.EntryId + ' has no log history');
        else if (canonicalJson(replayed[e.EntryId]) !== canonicalJson(e)) diffs.push('entry ' + e.EntryId + ' differs from replay');
      });
      Object.keys(replayed).forEach(function (id) {
        if (!seen[id]) diffs.push('entry ' + id + ' missing from Entries');
      });
      return { ok: diffs.length === 0, diffs: diffs };
    }

    return {
      genesisHash: genesisHash, buildCreate: buildCreate, buildChange: buildChange,
      verifyChain: verifyChain, replay: replay, compareToEntries: compareToEntries
    };
  }

  /** Cells Google counts for a tab: allocated rows x columns (empty cells included). */
  function tabCells(rows, cols) {
    if (!(rows >= 0 && cols >= 0 && Math.floor(rows) === rows && Math.floor(cols) === cols)) fail_('invalid grid size');
    return rows * cols;
  }

  /** tabs: [{rows, cols}, ...] -> total allocated cells of a part spreadsheet. */
  function partCells(tabs) {
    return tabs.reduce(function (sum, t) { return sum + tabCells(t.rows, t.cols); }, 0);
  }

  /** True once a part has reached the rollover ratio (default 70%) of the 10M-cell cap. */
  function needsRollover(allocatedCells, cap, ratio) {
    return allocatedCells >= (cap || SHEETS_CELL_CAP) * (ratio || ROLLOVER_RATIO);
  }

  const api = {
    ENTRY_COLUMNS: ENTRY_COLUMNS, LOG_COLUMNS: LOG_COLUMNS, EVENTS: EVENTS, STATUSES: STATUSES,
    SHEETS_CELL_CAP: SHEETS_CELL_CAP, ROLLOVER_RATIO: ROLLOVER_RATIO,
    canonicalJson: canonicalJson, durationSec: durationSec,
    normalizeEntry: normalizeEntry, entryToRow: entryToRow, rowToEntry: rowToEntry,
    create: create, tabCells: tabCells, partCells: partCells, needsRollover: needsRollover
  };
  return api;
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = LogChain;
}

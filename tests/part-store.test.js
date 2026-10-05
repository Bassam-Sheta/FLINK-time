'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const LogChain = require('../storage-v2/LogChain.gs');
const PartStore = require('../storage-v2/PartStore.gs');

// ---------- strict fake of the SpreadsheetApp subset (mimics real Sheets quirks) ----------
class FakeSheet {
  constructor(name) {
    this.name = name; this.rows = 1000; this.cols = 26;
    this.cells = new Map(); this.textCols = new Set(); this.hooks = {};
  }
  getName() { return this.name; }
  getMaxRows() { return this.rows; }
  getMaxColumns() { return this.cols; }
  insertRowsAfter(pos, n) { assert.ok(pos >= 0 && pos <= this.rows && n > 0); this.rows += n; }
  deleteRows(start, n) {
    assert.ok(start >= 1 && start + n - 1 <= this.rows && n < this.rows);
    for (const k of [...this.cells.keys()]) { const [r] = k.split(',').map(Number); if (r >= start && r < start + n) this.cells.delete(k); }
    this.rows -= n;
  }
  deleteColumns(start, n) {
    assert.ok(start >= 1 && start + n - 1 <= this.cols && n < this.cols);
    for (const k of [...this.cells.keys()]) { const [, c] = k.split(',').map(Number); if (c >= start && c < start + n) this.cells.delete(k); }
    this.cols -= n;
  }
  getLastRow() {
    let last = 0;
    for (const [k, v] of this.cells) { if (v.v !== '') last = Math.max(last, Number(k.split(',')[0])); }
    return last;
  }
  getRange(r, c, nr, nc) {
    assert.ok(r >= 1 && c >= 1 && nr >= 1 && nc >= 1, 'range origin/size');
    assert.ok(r + nr - 1 <= this.rows && c + nc - 1 <= this.cols, `range out of bounds on ${this.name}`);
    const sheet = this;
    return {
      setNumberFormat(fmt) { if (fmt === '@') for (let i = 0; i < nc; i++) sheet.textCols.add(c + i); },
      setValues(vals) {
        if (sheet.hooks.beforeSet) sheet.hooks.beforeSet(sheet);
        assert.equal(vals.length, nr); vals.forEach((row) => assert.equal(row.length, nc));
        vals.forEach((row, i) => row.forEach((val, j) => {
          const col = c + j; let stored = { v: val };
          if (typeof val === 'string' && !sheet.textCols.has(col)) {
            if (/^\d{4}-\d{2}-\d{2}T/.test(val)) stored = { v: new Date(val) };        // Sheets would convert
            else if (val.startsWith('=')) stored = { v: val, formula: true };          // Sheets would evaluate
          }
          sheet.cells.set(`${r + i},${col}`, stored);
        }));
        if (sheet.hooks.afterSet) sheet.hooks.afterSet(sheet);
      },
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = [];
          for (let j = 0; j < nc; j++) { const x = sheet.cells.get(`${r + i},${c + j}`); row.push(x ? x.v : ''); }
          out.push(row);
        }
        return out;
      }
    };
  }
}
class FakeSS {
  constructor() { this.sheets = [new FakeSheet('Sheet1')]; }
  getSheetByName(n) { return this.sheets.find((s) => s.name === n) || null; }
  insertSheet(n) { assert.ok(!this.getSheetByName(n)); const s = new FakeSheet(n); this.sheets.push(s); return s; }
  getSheets() { return this.sheets; }
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const chain = LogChain.create({ sha256Hex: sha });
const make = (blockRows) => PartStore.createStore({ chain, LogChain, blockRows });
const U = 'alice@flinksolutions.com';
const K = 'alice@flinksolutions.com|G1-P1';
const T = (m) => new Date(Date.UTC(2026, 9, 4, 8, m, 0)).toISOString();

function seeded(store, ss, count) {
  store.ensureUserTabs(ss, U);
  for (let i = 0; i < count; i++) {
    store.start(ss, U, K, T(i * 2), U, { EntryId: 'P1-entry' + String(i).padStart(6, '0'), StartUTC: T(i * 2), ProjectId: 'P1', Description: 'job ' + i });
    store.change(ss, U, K, T(i * 2 + 1), U, 'STOP', 'P1-entry' + String(i).padStart(6, '0'), { EndUTC: T(i * 2 + 1) });
  }
}

test('tabs: trimmed to 12 and 6 columns, 501 rows, headers set, cell count exact', () => {
  const ss = new FakeSS(); const store = make(500);
  store.ensureUserTabs(ss, U);
  const e = ss.getSheetByName('E_' + U), l = ss.getSheetByName('L_' + U);
  assert.deepEqual([e.getMaxColumns(), e.getMaxRows(), l.getMaxColumns(), l.getMaxRows()], [12, 501, 6, 501]);
  assert.deepEqual(e.getRange(1, 1, 1, 12).getValues()[0], LogChain.ENTRY_COLUMNS);
  assert.deepEqual(l.getRange(1, 1, 1, 6).getValues()[0], LogChain.LOG_COLUMNS);
  assert.equal(store.allocatedCells(ss), 26000 + 501 * 12 + 501 * 6);   // Sheet1 default grid + user tabs
  store.ensureUserTabs(ss, U);                                          // idempotent
  assert.equal(ss.getSheets().length, 3);
});

test('user ids must be plain lowercase emails (no sheet-name tricks)', () => {
  const store = make();
  for (const bad of ['', 'a', "x'y@d.com", 'a/b@d.com', 'a b@d.com', '=cmd@d.com'.replace('=', '[')]) {
    assert.throws(() => store.names(bad), (e) => e.code === 'BAD_USER');
  }
  assert.equal(store.names('Alice@FlinkSolutions.com').entries, 'E_alice@flinksolutions.com');
});

test('start/stop round trip is lossless (ISO text survives, formulas stay text)', () => {
  const ss = new FakeSS(); const store = make();
  store.ensureUserTabs(ss, U);
  const nasty = '=HYPERLINK("http://evil","x") | "q" \n end';
  const s = store.start(ss, U, K, T(0), U, { EntryId: 'P1-abcdefgh1', StartUTC: T(0), Description: nasty, Billable: true, Tags: '+a,-b' });
  assert.equal(s.duplicate, false);
  store.change(ss, U, K, T(30), U, 'STOP', 'P1-abcdefgh1', { EndUTC: T(30) });
  const v = store.verify(ss, U, K);
  assert.equal(v.ok, true); assert.equal(v.rows, 2);
  const e = ss.getSheetByName('E_' + U);
  assert.equal(e.cells.get('2,9').v, nasty);
  assert.ok(!e.cells.get('2,9').formula, 'description never becomes a formula');
  assert.equal(typeof e.cells.get('2,2').v, 'string', 'timestamps stay text');
});

test('without the text format the fake corrupts data (proves the format step matters)', () => {
  const sheet = new FakeSheet('x');
  sheet.getRange(1, 1, 1, 2).setValues([['2026-10-04T08:00:00.000Z', '=1+1']]);
  assert.ok(sheet.cells.get('1,1').v instanceof Date);
  assert.ok(sheet.cells.get('1,2').formula);
});

test('idempotent start: the same EntryId never creates a second entry or log row', () => {
  const ss = new FakeSS(); const store = make();
  store.ensureUserTabs(ss, U);
  const input = { EntryId: 'P1-abcdefgh1', StartUTC: T(0) };
  store.start(ss, U, K, T(0), U, input);
  const again = store.start(ss, U, K, T(1), U, input);
  assert.equal(again.duplicate, true);
  assert.equal(ss.getSheetByName('L_' + U).getLastRow(), 2);
  assert.equal(ss.getSheetByName('E_' + U).getLastRow(), 2);
});

test('1,200 operations: grids grow in blocks, chain verifies, replay equals Entries, stop finds old rows', () => {
  const ss = new FakeSS(); const store = make(500);
  seeded(store, ss, 600);                                  // 1,200 log rows
  const l = ss.getSheetByName('L_' + U), e = ss.getSheetByName('E_' + U);
  assert.equal(l.getLastRow(), 1201); assert.equal(e.getLastRow(), 601);
  assert.ok(l.getMaxRows() >= 1201 && l.getMaxRows() <= 1201 + 500);
  const v = store.verify(ss, U, K);
  assert.equal(v.ok, true);
  // edit a very old entry (outside the 200-row tail window)
  const r = store.change(ss, U, K, T(5000), U, 'EDIT', 'P1-entry000003', { Description: 'late fix' });
  assert.equal(r.entry.Version, 3);
  assert.equal(store.verify(ss, U, K).ok, true);
  assert.throws(() => store.change(ss, U, K, T(5001), U, 'EDIT', 'P1-nope000000', { Description: 'x' }), (er) => er.code === 'NO_ENTRY');
});

test('crash between log write and entry write is detected and repaired from the log', () => {
  const ss = new FakeSS(); const store = make();
  seeded(store, ss, 5);
  const e = ss.getSheetByName('E_' + U);
  e.hooks.beforeSet = () => { throw new Error('execution timed out'); };       // dies before the Entries write lands
  assert.throws(() => store.change(ss, U, K, T(100), U, 'EDIT', 'P1-entry000002', { Description: 'half written' }), /timed out/);
  e.hooks.beforeSet = null;
  const bad = store.verify(ss, U, K);
  assert.equal(bad.ok, false);
  assert.ok(bad.compare.diffs.length >= 1);
  store.rebuildEntries(ss, U, K);
  assert.equal(store.verify(ss, U, K).ok, true);
  assert.equal(e.cells.get('4,9').v, 'half written');
});

test('rebuild refuses a tampered log; verify flags tampering in either tab', () => {
  const ss = new FakeSS(); const store = make();
  seeded(store, ss, 4);
  const l = ss.getSheetByName('L_' + U), e = ss.getSheetByName('E_' + U);
  e.cells.set('3,9', { v: 'edited behind our back' });
  assert.equal(store.verify(ss, U, K).ok, false);                         // entries tampered
  store.rebuildEntries(ss, U, K);
  assert.equal(store.verify(ss, U, K).ok, true);                          // restored from log
  l.cells.set('4,5', { v: l.cells.get('4,5').v.replace('job', 'JOB') });
  assert.equal(store.verify(ss, U, K).ok, false);                         // log tampered
  assert.throws(() => store.rebuildEntries(ss, U, K), (er) => er.code === 'CHAIN_BROKEN');
});

test('a concurrent appender is reported as FORK_DETECTED', () => {
  const ss = new FakeSS(); const store = make();
  seeded(store, ss, 2);
  const l = ss.getSheetByName('L_' + U);
  l.hooks.afterSet = (sheet) => { sheet.hooks.afterSet = null; sheet.cells.set(`${sheet.getLastRow() + 1},1`, { v: 'x' }); };
  assert.throws(() => store.start(ss, U, K, T(60), U, { EntryId: 'P1-forkcase01', StartUTC: T(60) }), (er) => er.code === 'FORK_DETECTED');
});

test('oversize cells are rejected before any write', () => {
  const ss = new FakeSS(); const store = make();
  store.ensureUserTabs(ss, U);
  assert.throws(() => store.start(ss, U, K, T(0), U, { EntryId: 'P1-bigbigbig1', StartUTC: T(0), Description: 'x'.repeat(50001) }), (er) => er.code === 'CELL_TOO_LARGE');
  assert.equal(ss.getSheetByName('L_' + U).getLastRow(), 1);
  assert.equal(ss.getSheetByName('E_' + U).getLastRow(), 1);
});

test('missing tabs are reported, part names are Drive-safe', () => {
  assert.throws(() => make().start(new FakeSS(), U, K, T(0), U, { EntryId: 'P1-abcdefgh1', StartUTC: T(0) }), (er) => er.code === 'NO_TABS');
  assert.equal(PartStore.partName('Ops / Cairo: [A]', 2, 3), 'Ops Cairo A \u2014 Group 2 \u2014 Part 3');
  assert.throws(() => PartStore.partName('', 1, 1), (er) => er.code === 'BAD_ARGS');
  assert.throws(() => PartStore.partName('X', 0, 1), (er) => er.code === 'BAD_ARGS');
});

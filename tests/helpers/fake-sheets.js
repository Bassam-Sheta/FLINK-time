'use strict';

const assert = require('node:assert/strict');

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

module.exports = { FakeSheet, FakeSS };

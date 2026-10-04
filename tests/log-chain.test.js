'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const LogChain = require('../storage-v2/LogChain.gs');

const sha256Hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const chain = LogChain.create({ sha256Hex });

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
}
const iso = (ms) => new Date(ms).toISOString();

/** Simulates a user's two tabs through a long random sequence of operations. */
function simulate(userId, seed, ops) {
  const r = rng(seed);
  const entries = {};           // EntryId -> entry
  const entryRows = [];         // live Entries tab
  const logRows = [];           // live Log tab
  let head = chain.genesisHash(userId);
  let t = Date.UTC(2026, 9, 4, 6, 0, 0);
  let seq = 0;
  let logCountExpected = 0;

  const append = (logRow) => { logRows.push(logRow); head = logRow[5]; logCountExpected++; };
  const upsertRow = (entry, isNew) => {
    if (isNew) entryRows.push(LogChain.entryToRow(entry));
    else entryRows[entryRows.findIndex((x) => x[0] === entry.EntryId)] = LogChain.entryToRow(entry);
    entries[entry.EntryId] = entry;
  };

  for (let i = 0; i < ops; i++) {
    t += 1000 + Math.floor(r() * 600000);
    const ids = Object.keys(entries);
    const running = ids.filter((id) => entries[id].Status === 'RUNNING');
    const stopped = ids.filter((id) => entries[id].Status === 'STOPPED');
    const pick = r();
    if (pick < 0.30 && running.length === 0) {
      const b = chain.buildCreate(head, iso(t), userId, {
        EntryId: 'E' + (++seq), StartUTC: iso(t), ProjectId: 'P' + Math.floor(r() * 5),
        TaskId: 'T' + Math.floor(r() * 3), Tags: 'a,b', Billable: r() > 0.5,
        Description: 'work | "quoted" ,\n line ' + i, WorkMode: ['', 'OFFICE', 'WFH'][Math.floor(r() * 3)]
      }, 'START');
      upsertRow(b.entry, true); append(b.logRow);
    } else if (pick < 0.55 && running.length) {
      const id = running[0];
      const b = chain.buildChange(head, iso(t), userId, 'STOP', entries[id], { EndUTC: iso(t) });
      upsertRow(b.entry, false); append(b.logRow);
    } else if (pick < 0.65) {
      const start = t - 3600000;
      const b = chain.buildCreate(head, iso(t), userId, {
        EntryId: 'E' + (++seq), StartUTC: iso(start), EndUTC: iso(start + 1800000), ProjectId: 'P1'
      }, 'MANUAL_ADD');
      upsertRow(b.entry, true); append(b.logRow);
    } else if (pick < 0.88 && stopped.length) {
      const id = stopped[Math.floor(r() * stopped.length)];
      const e = entries[id];
      const patch = r() > 0.5
        ? { Description: 'edit ' + i, Billable: !e.Billable }
        : { EndUTC: iso(Date.parse(e.EndUTC) + 60000 * (1 + Math.floor(r() * 5))) };
      const b = chain.buildChange(head, iso(t), userId, 'EDIT', e, patch);
      upsertRow(b.entry, false); append(b.logRow);
    } else if (pick < 0.95 && stopped.length) {
      const id = stopped[Math.floor(r() * stopped.length)];
      const b = chain.buildChange(head, iso(t), userId, 'DELETE', entries[id], {});
      upsertRow(b.entry, false); append(b.logRow);
    } else if (stopped.length) {
      const id = stopped[Math.floor(r() * stopped.length)];
      const b = chain.buildChange(head, iso(t), userId, 'STATUS', entries[id], { Status: 'SUBMITTED' });
      upsertRow(b.entry, false); append(b.logRow);
    }
  }
  return { entries, entryRows, logRows, head, logCountExpected };
}

test('(a) replaying the Log reproduces every Entries row exactly', () => {
  for (const seed of [1, 2, 3, 42, 2026]) {
    const s = simulate('u1@flinksolutions.com', seed, 600);
    assert.ok(s.logRows.length > 200, 'simulation produced enough operations');
    assert.deepEqual(chain.verifyChain('u1@flinksolutions.com', s.logRows), { ok: true, head: s.head });
    const cmp = chain.compareToEntries(s.logRows, s.entryRows);
    assert.deepEqual(cmp, { ok: true, diffs: [] });
  }
});

test('(a2) Entries rows survive a Sheets-style round trip (row -> entry -> row)', () => {
  const s = simulate('u1@flinksolutions.com', 7, 300);
  for (const row of s.entryRows) assert.deepEqual(LogChain.entryToRow(LogChain.rowToEntry(row)), row);
});

test('(b) changing any single cell of any Log row is detected at that row', () => {
  const s = simulate('u2@flinksolutions.com', 11, 120);
  for (let i = 0; i < s.logRows.length; i++) {
    for (let c = 0; c < LogChain.LOG_COLUMNS.length; c++) {
      const tampered = s.logRows.map((r) => r.slice());
      tampered[i][c] = tampered[i][c] + 'x';
      const res = chain.verifyChain('u2@flinksolutions.com', tampered);
      assert.equal(res.ok, false, `row ${i} col ${c} tamper must fail`);
      assert.ok(res.index <= i + 1);
    }
  }
});

test('(b2) deleting, inserting, swapping rows and shifting field boundaries are detected', () => {
  const s = simulate('u3@flinksolutions.com', 5, 80);
  const L = s.logRows;
  assert.equal(chain.verifyChain('u3@flinksolutions.com', L.slice(1)).ok, false);
  assert.equal(chain.verifyChain('u3@flinksolutions.com', [...L.slice(0, 3), ...L.slice(4)]).ok, false);
  assert.equal(chain.verifyChain('u3@flinksolutions.com', [...L.slice(0, 3), L[1], ...L.slice(3)]).ok, false);
  const swapped = L.map((r) => r.slice()); [swapped[2], swapped[3]] = [swapped[3], swapped[2]];
  assert.equal(chain.verifyChain('u3@flinksolutions.com', swapped).ok, false);
  const shifted = L.map((r) => r.slice());
  shifted[0][1] = shifted[0][1] + '|'; shifted[0][3] = '|' + shifted[0][3];
  assert.equal(chain.verifyChain('u3@flinksolutions.com', shifted).ok, false);
  // truncating the tail is only detectable against a stored head: head must differ
  assert.notEqual(chain.verifyChain('u3@flinksolutions.com', L.slice(0, -1)).head, s.head);
});

test('(b3) a chain copied to another user does not verify', () => {
  const s = simulate('alice@flinksolutions.com', 9, 60);
  assert.equal(chain.verifyChain('bob@flinksolutions.com', s.logRows).ok, false);
});

test('(b4) forged-but-rehashed history is caught by replay consistency checks', () => {
  const s = simulate('u4@flinksolutions.com', 13, 100);
  const idx = s.logRows.findIndex((r) => r[2] === 'EDIT');
  assert.ok(idx > 0);
  const rows = s.logRows.map((r) => r.slice());
  const payload = JSON.parse(rows[idx][4]);
  const field = Object.keys(payload.changes).find((k) => k !== 'Version');
  payload.changes[field][0] = 'FORGED-OLD-VALUE';
  rows[idx][4] = LogChain.canonicalJson(payload);
  let prev = idx === 0 ? chain.genesisHash('u4@flinksolutions.com') : rows[idx - 1][5];
  for (let i = idx; i < rows.length; i++) {
    rows[i][5] = sha256Hex(prev + '|' + LogChain.canonicalJson([rows[i][0], rows[i][1], rows[i][2], rows[i][3], rows[i][4]]));
    prev = rows[i][5];
  }
  assert.equal(chain.verifyChain('u4@flinksolutions.com', rows).ok, true, 'hashes were consistently recomputed');
  assert.throws(() => chain.replay(rows), /old value mismatch/);
});

test('(c) every start, stop, manual add, edit, delete and status change adds exactly one Log row', () => {
  const s = simulate('u5@flinksolutions.com', 21, 500);
  assert.equal(s.logRows.length, s.logCountExpected);
  const types = new Set(s.logRows.map((r) => r[2]));
  for (const ev of ['START', 'STOP', 'MANUAL_ADD', 'EDIT', 'DELETE', 'STATUS']) assert.ok(types.has(ev), ev + ' exercised');
  // each Entries version bump corresponds to exactly one Log row
  const versions = Object.values(s.entries).reduce((n, e) => n + e.Version, 0);
  assert.equal(versions, s.logRows.length);
});

test('(c2) invalid operations are rejected and never produce a row', () => {
  const g = chain.genesisHash('u6');
  const run = chain.buildCreate(g, '2026-10-04T08:00:00.000Z', 'u6', { EntryId: 'E1', StartUTC: '2026-10-04T08:00:00.000Z' });
  const stopped = chain.buildChange(run.logRow[5], '2026-10-04T09:00:00.000Z', 'u6', 'STOP', run.entry, { EndUTC: '2026-10-04T09:00:00.000Z' });
  assert.equal(stopped.entry.DurationSec, 3600);
  const bad = (fn) => assert.throws(fn);
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'STOP', stopped.entry, { EndUTC: '2026-10-04T10:00:00.000Z' }));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'STOP', run.entry, { EndUTC: '2026-10-04T07:00:00.000Z' }));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'DELETE', run.entry, {}));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'EDIT', stopped.entry, { Version: 99 }));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'EDIT', stopped.entry, { DurationSec: 5 }));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'EDIT', stopped.entry, {}));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'EDIT', stopped.entry, { EndUTC: '' }));
  bad(() => chain.buildChange(g, '2026-10-04T09:00:00.000Z', 'u6', 'EDIT', run.entry, { EndUTC: '2026-10-04T09:00:00.000Z' }));
  bad(() => chain.buildCreate(g, '2026-10-04T09:00:00.000Z', 'u6', { EntryId: 'E2', StartUTC: 'not-a-date' }));
  bad(() => chain.buildCreate(g, '2026-10-04T09:00:00.000Z', '', { EntryId: 'E2', StartUTC: '2026-10-04T08:00:00.000Z' }));
  bad(() => LogChain.canonicalJson({ d: new Date() }));
});

test('(d) log row costs: 12 entry cells + 6 per log row = 24 cells for a start+stop entry', () => {
  assert.equal(LogChain.ENTRY_COLUMNS.length, 12);
  assert.equal(LogChain.LOG_COLUMNS.length, 6);
  const perEntry = LogChain.ENTRY_COLUMNS.length + 2 * LogChain.LOG_COLUMNS.length;
  assert.equal(perEntry, 24);
  const s = simulate('u7', 3, 600);
  const cells = s.entryRows.length * 12 + s.logRows.length * 6;
  assert.equal(cells, LogChain.partCells([{ rows: s.entryRows.length, cols: 12 }, { rows: s.logRows.length, cols: 6 }]));
});

test('(d2) allocated-cell counter and 70% rollover threshold', () => {
  assert.equal(LogChain.SHEETS_CELL_CAP, 10000000);
  assert.equal(LogChain.partCells([{ rows: 1000, cols: 12 }, { rows: 2000, cols: 6 }]), 24000);
  assert.equal(LogChain.needsRollover(6999999), false);
  assert.equal(LogChain.needsRollover(7000000), true);
  assert.equal(LogChain.needsRollover(7000001), true);
  assert.throws(() => LogChain.tabCells(-1, 5));
  assert.throws(() => LogChain.tabCells(1.5, 5));
  // cohort of 10 users, 120 entries/day, 22 days: months until 7M (estimate cross-check)
  const perMonth = 10 * 120 * 22 * (12 + 2 * 6);
  assert.equal(perMonth, 633600);
  assert.ok(7000000 / perMonth > 10 && 7000000 / perMonth < 12);
});

test('payloads are deterministic canonical JSON', () => {
  assert.equal(LogChain.canonicalJson({ b: 1, a: [2, { d: 1, c: null }], e: undefined }), '{"a":[2,{"c":null,"d":1}],"b":1}');
  assert.throws(() => LogChain.canonicalJson({ n: NaN }));
});

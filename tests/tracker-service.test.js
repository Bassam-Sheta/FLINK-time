'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const LogChain = require('../storage-v2/LogChain.gs');
const PartRouting = require('../storage-v2/PartRouting.gs');
const PartStore = require('../storage-v2/PartStore.gs');
const TrackerService = require('../storage-v2/TrackerService.gs');
const { FakeSS } = require('./helpers/fake-sheets.js');

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const chain = LogChain.create({ sha256Hex: sha });
const store = PartStore.createStore({ chain, LogChain, blockRows: 500 });

function world() {
  let clock = Date.UTC(2026, 9, 4, 8, 0, 0);
  let cacheNow = 0; const cache = new Map(); let n = 0;
  const gate = PartRouting.createUserGate({
    cache: { get: (k) => { const v = cache.get(k); return v && v.exp > cacheNow ? v.val : null; }, put: (k, val, ttl) => cache.set(k, { val, exp: cacheNow + ttl * 1000 }), remove: (k) => cache.delete(k) },
    withLock: (fn) => fn(), newToken: () => 't' + (++n), sleep: (ms) => { cacheNow += ms; }
  });
  const reg = {
    members: { 'W1:alice@x.com': { cohortId: 'G1' }, 'W1:bob@x.com': { cohortId: 'G1' }, 'W2:alice@x.com': { cohortId: 'G1' } },
    cohorts: { 'W1:G1': { CurrentPart: 1 }, 'W2:G1': { CurrentPart: 1 } },
    parts: {}, cells: {}, active: {}, projects: { 'W1:PRJ1:T1': true, 'W1:PRJ1:': true, 'W2:PRJ9:': true }, failCreate: 0, created: [],
    getMembership(u, w) { return this.members[w + ':' + u] || null; },
    getCohort(w, c) { return this.cohorts[w + ':' + c]; },
    getPartCells(w, c, p) { return this.cells[`${w}:${c}:${p}`] || 0; },
    openPart(w, c, p) { return this.parts[`${w}:${c}:${p}`] || null; },
    createPart(w, c, p) {
      if (this.failCreate-- > 0) throw new Error('drive quota');
      const ss = new FakeSS(); this.parts[`${w}:${c}:${p}`] = ss; this.cohorts[`${w}:${c}`].CurrentPart = p; this.created.push(`${w}:${c}:${p}`); return ss;
    },
    setCurrentPart(w, c, p) { this.cohorts[`${w}:${c}`].CurrentPart = p; },
    getActive(u) { return this.active[u] || null; },
    setActive(u, o) { this.active[u] = o; }, clearActive(u) { delete this.active[u]; },
    validateProjectTask(w, p, t) { return !!this.projects[`${w}:${p}:${t}`]; }
  };
  reg.parts['W1:G1:1'] = new FakeSS(); reg.parts['W2:G1:1'] = new FakeSS();
  const svc = TrackerService.create({ registry: reg, store, gate, routing: PartRouting, sha256Hex: sha, now: () => new Date(clock).toISOString() });
  return { svc, reg, gate, tick: (s) => { clock += s * 1000; }, iso: () => new Date(clock).toISOString(), cache, setCacheNow: (v) => { cacheNow = v; } };
}
const A = 'alice@x.com', B = 'bob@x.com';
const base = (o) => Object.assign({ userId: A, workspaceId: 'W1', operationId: 'op-00000001' }, o);
const ck = (u, ws, c, p) => PartRouting.chainKey(u, `${ws}-${c}-P${p}`);
const verify = (w, u, ws, part) => store.verify(w.reg.parts[`${ws}:G1:${part}`], u, ck(u, ws, 'G1', part));
const code = (c) => (e) => e.code === c;

test('start then stop: one entry, pointer set then cleared, chain and replay verify', () => {
  const w = world();
  const s = w.svc.startTimer(base({ ProjectId: 'PRJ1', TaskId: 'T1', Description: 'a' }));
  assert.equal(s.entry.Status, 'RUNNING'); assert.equal(s.duplicate, false);
  assert.equal(w.reg.getActive(A).entryId, s.entry.EntryId);
  w.tick(90);
  const e = w.svc.stopTimer({ userId: A });
  assert.equal(e.entry.DurationSec, 90); assert.equal(w.reg.getActive(A), null);
  assert.equal(verify(w, A, 'W1', 1).ok, true);
  assert.equal(verify(w, A, 'W1', 1).rows, 2);
});

test('starting while running is refused unless switching; switch stops the old one at the same instant', () => {
  const w = world();
  const first = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  w.tick(60);
  assert.throws(() => w.svc.startTimer(base({ operationId: 'op-bbbbbbbb' })), code('TIMER_RUNNING'));
  const sw = w.svc.startTimer(base({ operationId: 'op-bbbbbbbb', switchIfRunning: true, ProjectId: 'PRJ1' }));
  assert.equal(sw.stopped.entry.EntryId, first.entry.EntryId);
  assert.equal(sw.stopped.entry.EndUTC, sw.entry.StartUTC);
  assert.equal(w.reg.getActive(A).entryId, sw.entry.EntryId);
  const v = verify(w, A, 'W1', 1);
  assert.equal(v.ok, true); assert.equal(v.rows, 3);                   // START, STOP, START
});

test('retry with the same operationId never duplicates (start, and a completed switch)', () => {
  const w = world();
  const a = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  const again = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  assert.equal(again.duplicate, true); assert.equal(again.entry.EntryId, a.entry.EntryId);
  w.tick(30);
  w.svc.startTimer(base({ operationId: 'op-bbbbbbbb', switchIfRunning: true }));
  const r2 = w.svc.startTimer(base({ operationId: 'op-bbbbbbbb', switchIfRunning: true }));
  assert.equal(r2.duplicate, true);
  assert.equal(verify(w, A, 'W1', 1).rows, 3);
});

test('a switch that fails halfway completes on retry without double-stopping', () => {
  const w = world();
  w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  w.tick(30);
  w.reg.cells['W1:G1:1'] = 7000000; w.reg.failCreate = 1;               // next start needs a new part, creation fails once
  assert.throws(() => w.svc.startTimer(base({ operationId: 'op-bbbbbbbb', switchIfRunning: true })), /drive quota/);
  assert.equal(w.reg.getActive(A), null, 'old timer already stopped');
  const done = w.svc.startTimer(base({ operationId: 'op-bbbbbbbb', switchIfRunning: true }));
  assert.equal(done.entry.Status, 'RUNNING'); assert.equal(done.stopped, null);
  assert.equal(verify(w, A, 'W1', 1).ok, true); assert.equal(verify(w, A, 'W1', 1).rows, 2);   // START, STOP in part 1
  assert.equal(verify(w, A, 'W1', 2).ok, true);                                                 // START in part 2
});

test('rollover: new entries go to part 2; a timer started in part 1 stops in part 1', () => {
  const w = world();
  const s1 = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  assert.equal(PartRouting.partOfEntryId(s1.entry.EntryId), 1);
  w.reg.cells['W1:G1:1'] = 7000000;
  w.tick(10);
  const stop = w.svc.stopTimer({ userId: A });
  assert.equal(stop.entry.Status, 'STOPPED');
  assert.equal(verify(w, A, 'W1', 1).rows, 2);
  const m = w.svc.addManual(base({ operationId: 'op-cccccccc', StartUTC: new Date(Date.UTC(2026, 9, 4, 6, 0)).toISOString(), EndUTC: new Date(Date.UTC(2026, 9, 4, 7, 0)).toISOString() }));
  assert.equal(PartRouting.partOfEntryId(m.entry.EntryId), 2);
  assert.deepEqual(w.reg.created, ['W1:G1:2']);
  assert.equal(w.reg.getCohort('W1', 'G1').CurrentPart, 2);
  assert.equal(verify(w, A, 'W1', 2).ok, true);
  assert.equal(w.reg.parts['W1:G1:2'].getSheetByName('E_' + B), null, 'tabs are created lazily per user');
});

test('stop is idempotent and clamps runaway timers to 24 hours', () => {
  const w = world();
  w.svc.startTimer(base());
  w.tick(30 * 3600);
  const st = w.svc.stopTimer({ userId: A });
  assert.equal(st.clamped, true); assert.equal(st.entry.DurationSec, 86400);
  const again = w.svc.stopTimer({ userId: A, entryId: st.entry.EntryId, workspaceId: 'W1' });
  assert.equal(again.alreadyStopped, true);
  assert.equal(verify(w, A, 'W1', 1).rows, 2);
  assert.throws(() => w.svc.stopTimer({ userId: A }), code('NO_TIMER'));
});

test('edits: allowed fields only, stopped entries only, valid times and projects, all logged', () => {
  const w = world();
  const s = w.svc.startTimer(base({ ProjectId: 'PRJ1' })); const id = s.entry.EntryId;
  const patch = (p) => ({ userId: A, workspaceId: 'W1', entryId: id, actor: A, patch: p });
  assert.throws(() => w.svc.editEntry(patch({ Description: 'x' })), code('NOT_EDITABLE'));            // running
  w.tick(600); w.svc.stopTimer({ userId: A });
  const ok = w.svc.editEntry(patch({ Description: 'fixed', Billable: true }));
  assert.equal(ok.entry.Version, 3);
  assert.throws(() => w.svc.editEntry(patch({ Version: 9 })), code('BAD_INPUT'));
  assert.throws(() => w.svc.editEntry(patch({ Status: 'APPROVED' })), code('BAD_INPUT'));
  assert.throws(() => w.svc.editEntry(patch({})), code('BAD_INPUT'));
  assert.throws(() => w.svc.editEntry(patch({ ProjectId: 'NOPE' })), code('PROJECT_INVALID'));
  assert.throws(() => w.svc.editEntry(patch({ EndUTC: new Date(Date.parse(w.iso()) + 3600000).toISOString() })), code('BAD_TIME'));
  assert.throws(() => w.svc.editEntry(patch({ StartUTC: new Date(Date.parse(w.iso()) + 1000).toISOString() })), code('BAD_TIME'));
  assert.throws(() => w.svc.editEntry(patch({ Description: 'x'.repeat(2001) })), code('BAD_INPUT'));
  assert.throws(() => w.svc.editEntry({ ...patch({ Description: 'z' }), actor: '' }), code('BAD_INPUT'));
  const del = w.svc.deleteEntry({ userId: A, workspaceId: 'W1', entryId: id, actor: 'admin@x.com' });
  assert.equal(del.entry.Status, 'DELETED');
  assert.throws(() => w.svc.deleteEntry({ userId: A, workspaceId: 'W1', entryId: id, actor: A }), code('NOT_EDITABLE'));
  const v = verify(w, A, 'W1', 1);
  assert.equal(v.ok, true); assert.equal(v.rows, 4);                                                  // START, STOP, EDIT, DELETE
  const log = w.reg.parts['W1:G1:1'].getSheetByName('L_' + A);
  assert.equal(log.cells.get('5,4').v, 'admin@x.com', 'actor of the delete is recorded');
});

test('manual entries: validated, idempotent, never in the future, max 24h', () => {
  const w = world();
  const t = (h, m = 0) => new Date(Date.UTC(2026, 9, 4, h, m)).toISOString();
  const m1 = w.svc.addManual(base({ operationId: 'op-mmmmmmm1', StartUTC: t(5), EndUTC: t(6, 30), ProjectId: 'PRJ1' }));
  assert.equal(m1.entry.DurationSec, 5400);
  assert.equal(w.svc.addManual(base({ operationId: 'op-mmmmmmm1', StartUTC: t(5), EndUTC: t(6, 30), ProjectId: 'PRJ1' })).duplicate, true);
  assert.throws(() => w.svc.addManual(base({ operationId: 'op-mmmmmmm2', StartUTC: t(6), EndUTC: t(5) })), code('BAD_TIME'));
  assert.throws(() => w.svc.addManual(base({ operationId: 'op-mmmmmmm3', StartUTC: t(8), EndUTC: t(12) })), code('BAD_TIME'));
  assert.throws(() => w.svc.addManual(base({ operationId: 'op-mmmmmmm4', StartUTC: '2026-10-02T00:00:00.000Z', EndUTC: '2026-10-03T06:00:00.000Z' })), code('BAD_TIME'));
  assert.throws(() => w.svc.addManual(base({ operationId: 'op-mmmmmmm5', StartUTC: 'yesterday', EndUTC: t(6) })), code('BAD_INPUT'));
  assert.equal(verify(w, A, 'W1', 1).rows, 1);
});

test('membership, project and input checks happen before anything is written', () => {
  const w = world();
  assert.throws(() => w.svc.startTimer(base({ userId: 'eve@x.com' })), code('NOT_MEMBER'));
  assert.throws(() => w.svc.startTimer(base({ workspaceId: 'W3' })), code('NOT_MEMBER'));
  assert.throws(() => w.svc.startTimer(base({ ProjectId: 'PRJ9' })), code('PROJECT_INVALID'));      // belongs to W2
  assert.throws(() => w.svc.startTimer(base({ TaskId: 'T1' })), code('PROJECT_INVALID'));
  assert.throws(() => w.svc.startTimer(base({ operationId: 'x' })), code('BAD_INPUT'));
  assert.throws(() => w.svc.startTimer(base({ Billable: 'yes' })), code('BAD_INPUT'));
  assert.throws(() => w.svc.startTimer(base({ WorkMode: 'MARS' })), code('BAD_INPUT'));
  assert.equal(w.reg.parts['W1:G1:1'].getSheetByName('E_' + A), null, 'no tabs created by rejected requests');
});

test('a user in two workspaces has one running timer; stop routes to the right workspace', () => {
  const w = world();
  const a = w.svc.startTimer(base({ workspaceId: 'W2', ProjectId: 'PRJ9', operationId: 'op-w2000001' }));
  assert.throws(() => w.svc.startTimer(base({ workspaceId: 'W1', operationId: 'op-w1000001' })), code('TIMER_RUNNING'));
  w.tick(20);
  const sw = w.svc.startTimer(base({ workspaceId: 'W1', operationId: 'op-w1000001', switchIfRunning: true }));
  assert.equal(sw.stopped.entry.EntryId, a.entry.EntryId);
  assert.equal(verify(w, A, 'W2', 1).rows, 2);
  assert.equal(verify(w, A, 'W1', 1).rows, 1);
});

test('a busy user gate rejects the request without touching storage; other users are unaffected', () => {
  const w = world();
  assert.ok(w.gate.acquire(A));
  assert.throws(() => w.svc.startTimer(base()), code('USER_BUSY'));
  assert.equal(w.reg.parts['W1:G1:1'].getSheetByName('E_' + A), null);
  assert.equal(w.svc.startTimer({ userId: B, workspaceId: 'W1', operationId: 'op-bob00001' }).entry.Status, 'RUNNING');
});

test('stale active pointer (entry no longer running) is cleaned up and does not block a start', () => {
  const w = world();
  const s = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  w.tick(5);
  const part = w.reg.parts['W1:G1:1'];
  store.change(part, A, ck(A, 'W1', 'G1', 1), w.iso(), A, 'STOP', s.entry.EntryId, { EndUTC: w.iso() });   // stopped behind the pointer's back
  const n = w.svc.startTimer(base({ operationId: 'op-bbbbbbbb' }));
  assert.equal(n.entry.Status, 'RUNNING'); assert.equal(w.reg.getActive(A).entryId, n.entry.EntryId);
  assert.equal(verify(w, A, 'W1', 1).ok, true);
});

test('200 mixed operations across two users keep every chain valid and tabs separate', () => {
  const w = world();
  for (let i = 0; i < 100; i++) {
    for (const u of [A, B]) {
      w.tick(37);
      w.svc.startTimer({ userId: u, workspaceId: 'W1', operationId: `op-${u[0]}${String(i).padStart(7, '0')}`, switchIfRunning: true, Description: 'n' + i });
    }
  }
  for (const u of [A, B]) {
    w.svc.stopTimer({ userId: u });
    const v = verify(w, u, 'W1', 1);
    assert.equal(v.ok, true); assert.equal(v.rows, 200);          // 100 STARTs + 99 STOPs from switches + 1 final STOP
  }
});

test('missing dependencies are rejected', () => {
  assert.throws(() => TrackerService.create({}), code('BAD_DEPS'));
});

test('crash after the next part was created but before the pointer moved: reuse it, never create a duplicate sheet', () => {
  const w = world();
  w.reg.cells['W1:G1:1'] = 7000000;
  w.reg.parts['W1:G1:2'] = new FakeSS();                      // created earlier, pointer still on part 1
  const s = w.svc.startTimer(base({ operationId: 'op-aaaaaaaa' }));
  assert.equal(PartRouting.partOfEntryId(s.entry.EntryId), 2);
  assert.deepEqual(w.reg.created, []);
  assert.equal(w.reg.getCohort('W1', 'G1').CurrentPart, 2);
  assert.equal(verify(w, A, 'W1', 2).ok, true);
});

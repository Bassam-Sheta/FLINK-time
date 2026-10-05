'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const PartRouting = require('../storage-v2/PartRouting.gs');
const LogChain = require('../storage-v2/LogChain.gs');

/** Fake CacheService with TTL driven by a fake clock; fake micro-lock that can be made to fail. */
function env() {
  let now = 0;
  const store = new Map();
  let n = 0;
  const lockState = { fail: false, depth: 0, maxDepth: 0 };
  const cache = {
    get: (k) => { const v = store.get(k); return v && v.exp > now ? v.val : null; },
    put: (k, val, ttl) => store.set(k, { val, exp: now + ttl * 1000 }),
    remove: (k) => store.delete(k)
  };
  const deps = {
    cache,
    withLock: (fn) => {
      if (lockState.fail) throw new Error('lock timeout');
      lockState.depth++; lockState.maxDepth = Math.max(lockState.maxDepth, lockState.depth);
      try { return fn(); } finally { lockState.depth--; }
    },
    newToken: () => 'tok' + (++n),
    sleep: (ms) => { now += ms; },
    ttlSec: 30
  };
  return { deps, gate: PartRouting.createUserGate(deps), advance: (ms) => { now += ms; }, lockState, store };
}

test('gate: same user is serialised, different users are independent', () => {
  const { gate } = env();
  const a = gate.acquire('alice');
  assert.ok(a);
  assert.equal(gate.acquire('alice'), null);
  assert.ok(gate.acquire('bob'));
  gate.release('alice', a);
  assert.ok(gate.acquire('alice'));
});

test('gate: a wrong token cannot release someone else\'s gate', () => {
  const { gate } = env();
  const a = gate.acquire('alice');
  gate.release('alice', 'not-my-token');
  assert.equal(gate.acquire('alice'), null);
  gate.release('alice', a);
  assert.ok(gate.acquire('alice'));
});

test('gate: a crashed holder is freed by TTL, and its late release cannot free the new holder', () => {
  const { gate, advance } = env();
  const crashed = gate.acquire('alice');
  advance(31000);
  const fresh = gate.acquire('alice');
  assert.ok(fresh);
  gate.release('alice', crashed);          // late/stale release
  assert.equal(gate.acquire('alice'), null, 'new holder keeps the gate');
});

test('gate.run: runs fn once, releases on success and on error, never holds the micro-lock during fn', () => {
  const e = env();
  let inside = 0;
  const out = e.gate.run('alice', () => { inside++; assert.equal(e.lockState.depth, 0); return 42; });
  assert.equal(out, 42); assert.equal(inside, 1);
  assert.throws(() => e.gate.run('alice', () => { throw new Error('boom'); }), /boom/);
  assert.ok(e.gate.acquire('alice'), 'released after error');
  assert.equal(e.lockState.maxDepth, 1);
});

test('gate.run: waits for a holder to expire, otherwise reports USER_BUSY and does not run fn', () => {
  const e = env();
  e.gate.acquire('alice');
  let ran = false;
  assert.throws(() => e.gate.run('alice', () => { ran = true; }, { attempts: 3, waitMs: 250 }), (err) => err.code === 'USER_BUSY');
  assert.equal(ran, false);
  let ran2 = false;
  e.gate.run('alice', () => { ran2 = true; }, { attempts: 4, waitMs: 10000 });   // 3 sleeps x 10s > 30s ttl
  assert.equal(ran2, true);
});

test('gate: a micro-lock timeout is treated as busy, never as acquired', () => {
  const e = env();
  e.lockState.fail = true;
  assert.equal(e.gate.acquire('alice'), null);
  e.lockState.fail = false;
  assert.ok(e.gate.acquire('alice'));
});

test('gate: missing dependencies are rejected', () => {
  assert.throws(() => PartRouting.createUserGate({}), (e) => e.code === 'BAD_DEPS');
  assert.throws(() => env().gate.acquire(''), (e) => e.code === 'BAD_ARGS');
});

test('cohorts: fills to 10, then opens the next; assignment is stable and idempotent', () => {
  const cohorts = [];
  const place = (u) => {
    const r = PartRouting.assignUserToCohort(cohorts, u);
    if (r.created) cohorts.push({ CohortId: r.cohortId, Slots: [], CurrentPart: 1 });
    if (r.changed) cohorts.find((c) => c.CohortId === r.cohortId).Slots.push(u);
    return r;
  };
  for (let i = 1; i <= 25; i++) place('u' + i);
  assert.deepEqual(cohorts.map((c) => c.Slots.length), [10, 10, 5]);
  assert.deepEqual(cohorts.map((c) => c.CohortId), ['G1', 'G2', 'G3']);
  const again = place('u7');
  assert.deepEqual(again, { cohortId: 'G1', created: false, changed: false });
  assert.equal(cohorts[0].Slots.length, 10, 'no duplicate slot');
  assert.equal(place('u26').cohortId, 'G3');
  assert.throws(() => PartRouting.assignUserToCohort(cohorts, ''), (e) => e.code === 'BAD_ARGS');
});

test('rollover: new writes move to the next part at exactly 70% of 10M cells', () => {
  const cohort = { CohortId: 'G1', Slots: [], CurrentPart: 3 };
  assert.deepEqual(PartRouting.planNewWrite(cohort, 6999999), { part: 3, createPart: false, previousPart: null });
  assert.deepEqual(PartRouting.planNewWrite(cohort, 7000000), { part: 4, createPart: true, previousPart: 3 });
  assert.throws(() => PartRouting.planNewWrite({ CurrentPart: 0 }, 0), (e) => e.code === 'BAD_ARGS');
});

test('entry ids route to their own part, so running timers survive a rollover', () => {
  const id = PartRouting.makeEntryId(3, 'a1B2c3D4e5');
  assert.equal(id, 'P3-a1B2c3D4e5');
  assert.equal(PartRouting.partOfEntryId(id), 3);
  assert.equal(PartRouting.partOfEntryId(PartRouting.makeEntryId(12, 'abcdefgh')), 12);
  for (const bad of ['', 'E1', 'P-abc', 'P3-short', 'P3-has space1', 'P3-abcdefgh;DROP', null]) {
    assert.throws(() => PartRouting.partOfEntryId(bad), (e) => e.code === 'BAD_ENTRY_ID');
  }
  assert.throws(() => PartRouting.makeEntryId(0, 'abcdefgh'), (e) => e.code === 'BAD_ARGS');
  assert.throws(() => PartRouting.makeEntryId(1, 'x|y-z'), (e) => e.code === 'BAD_ARGS');
});

test('end to end: a timer started in part 1 is stopped in part 1 after part 2 opens; chains stay independent and valid', () => {
  const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
  const chain = LogChain.create({ sha256Hex: sha });
  const user = 'alice@flinksolutions.com';
  const k1 = PartRouting.chainKey(user, 'G1-P1');
  const k2 = PartRouting.chainKey(user, 'G1-P2');
  const id1 = PartRouting.makeEntryId(1, 'abcdefgh1');
  const s1 = chain.buildCreate(chain.genesisHash(k1), '2026-10-04T08:00:00.000Z', user, { EntryId: id1, StartUTC: '2026-10-04T08:00:00.000Z' });
  // part 1 hits 70% while the timer is running; next new entry goes to part 2
  const plan = PartRouting.planNewWrite({ CurrentPart: 1 }, 7100000);
  assert.deepEqual([plan.part, plan.createPart], [2, true]);
  const id2 = PartRouting.makeEntryId(plan.part, 'zyxwvuts2');
  const m2 = chain.buildCreate(chain.genesisHash(k2), '2026-10-04T08:30:00.000Z', user, { EntryId: id2, StartUTC: '2026-10-04T07:00:00.000Z', EndUTC: '2026-10-04T07:30:00.000Z' }, 'MANUAL_ADD');
  // stop of the old entry routes to part 1 and extends part 1's own chain
  assert.equal(PartRouting.partOfEntryId(id1), 1);
  const st = chain.buildChange(s1.logRow[5], '2026-10-04T09:00:00.000Z', user, 'STOP', s1.entry, { EndUTC: '2026-10-04T09:00:00.000Z' });
  assert.equal(chain.verifyChain(k1, [s1.logRow, st.logRow]).ok, true);
  assert.equal(chain.verifyChain(k2, [m2.logRow]).ok, true);
  assert.equal(chain.verifyChain(k1, [m2.logRow]).ok, false, 'chains are not interchangeable');
  assert.deepEqual(chain.compareToEntries([s1.logRow, st.logRow], [st.entryRow]), { ok: true, diffs: [] });
});

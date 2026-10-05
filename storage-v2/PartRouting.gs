/**
 * PartRouting — storage v2 routing logic (pure, no Sheets/Apps Script calls).
 *
 *  - UserGate:   per-user write serialisation (no global lock). Cache flag guarded by a
 *                very short lock that wraps only two cache operations.
 *  - Cohorts:    users are placed automatically, at most 10 per cohort; a user keeps
 *                their slot (and tabs) for life, so history is never orphaned.
 *  - Parts:      each cohort writes to its current part; at >= 70% of the 10M-cell cap
 *                new starts go to a fresh part. Existing entries are always edited/stopped
 *                in the part they live in (the part number is embedded in the EntryId).
 *  - Chain key:  every user's Log chain is independent per part (genesis = userId|partId).
 *
 * Honest limit: CacheService may evict early. If two writers ever overlap for one user,
 * their rows would fork the hash chain; LogChain.verifyChain detects that on the nightly check.
 */
const PartRouting = (function () {
  'use strict';

  const MAX_USERS_PER_COHORT = 10;
  const CELL_CAP = 10000000;
  const ROLLOVER_RATIO = 0.7;

  function fail_(code, message) {
    const e = new Error('PartRouting: ' + message);
    e.code = code;
    throw e;
  }

  /** deps: { cache:{get,put,remove}, withLock(fn)->fn result, newToken(), sleep(ms), ttlSec? } */
  function createUserGate(deps) {
    ['cache', 'withLock', 'newToken', 'sleep'].forEach(function (k) {
      if (!deps || !deps[k]) fail_('BAD_DEPS', 'missing dependency ' + k);
    });
    const ttlSec = deps.ttlSec || 30;
    const keyOf = function (userKey) {
      if (!userKey) fail_('BAD_ARGS', 'userKey is required');
      return 'gate:' + userKey;
    };

    function acquire(userKey) {
      const key = keyOf(userKey);
      const token = deps.newToken();
      let got;
      try {
        got = deps.withLock(function () {
          if (deps.cache.get(key)) return false;
          deps.cache.put(key, token, ttlSec);
          return true;
        });
      } catch (e) {
        return null;                       // could not even take the micro-lock: treat as busy
      }
      return got ? token : null;
    }

    function release(userKey, token) {
      const key = keyOf(userKey);
      try {
        deps.withLock(function () {
          if (deps.cache.get(key) === token) deps.cache.remove(key);
        });
      } catch (e) { /* TTL will free the flag */ }
    }

    /** Runs fn() while holding the user's gate; fn performs the sheet I/O outside any lock. */
    function run(userKey, fn, options) {
      const attempts = (options && options.attempts) || 8;
      const waitMs = (options && options.waitMs) || 250;
      let token = null;
      for (let i = 0; i < attempts && !token; i++) {
        token = acquire(userKey);
        if (!token && i < attempts - 1) deps.sleep(waitMs);
      }
      if (!token) fail_('USER_BUSY', 'could not acquire the write gate for ' + userKey);
      try {
        return fn();
      } finally {
        release(userKey, token);
      }
    }

    return { acquire: acquire, release: release, run: run };
  }

  /**
   * cohorts: [{CohortId, Slots:[userId,...], CurrentPart:Number}], ordered.
   * Returns { cohortId, created, changed } and mutates nothing; caller persists the result.
   */
  function assignUserToCohort(cohorts, userId, max) {
    const limit = max || MAX_USERS_PER_COHORT;
    if (!userId) fail_('BAD_ARGS', 'userId is required');
    const existing = cohorts.find(function (c) { return c.Slots.indexOf(userId) !== -1; });
    if (existing) return { cohortId: existing.CohortId, created: false, changed: false };
    const open = cohorts.find(function (c) { return c.Slots.length < limit; });
    if (open) return { cohortId: open.CohortId, created: false, changed: true };
    return { cohortId: 'G' + (cohorts.length + 1), created: true, changed: true };
  }

  /** Decides where a NEW start/manual entry is written. */
  function planNewWrite(cohort, partCells) {
    const part = cohort.CurrentPart;
    if (!(part >= 1)) fail_('BAD_ARGS', 'cohort has no current part');
    if (partCells >= CELL_CAP * ROLLOVER_RATIO) {
      return { part: part + 1, createPart: true, previousPart: part };
    }
    return { part: part, createPart: false, previousPart: null };
  }

  /** EntryId embeds its part so edits/stops route without an index: "P<part>-<token>". */
  function makeEntryId(part, token) {
    if (!(part >= 1) || Math.floor(part) !== part) fail_('BAD_ARGS', 'invalid part');
    if (!/^[A-Za-z0-9]{8,64}$/.test(token || '')) fail_('BAD_ARGS', 'token must be 8-64 alphanumerics');
    return 'P' + part + '-' + token;
  }

  function partOfEntryId(entryId) {
    const m = /^P(\d+)-[A-Za-z0-9]{8,64}$/.exec(entryId || '');
    if (!m) fail_('BAD_ENTRY_ID', 'unrecognised entry id');
    return Number(m[1]);
  }

  /** Key used in LogChain.genesisHash so each user's chain is independent per part. */
  function chainKey(userId, partId) {
    if (!userId || !partId) fail_('BAD_ARGS', 'userId and partId are required');
    return userId + '|' + partId;
  }

  return {
    MAX_USERS_PER_COHORT: MAX_USERS_PER_COHORT,
    createUserGate: createUserGate, assignUserToCohort: assignUserToCohort,
    planNewWrite: planNewWrite, makeEntryId: makeEntryId, partOfEntryId: partOfEntryId,
    chainKey: chainKey
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = PartRouting;
}

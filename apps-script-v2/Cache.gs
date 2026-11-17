/**
 * Cache.gs - CacheService wrapper with generation keys (BUILD_SPEC sections 2 and 5.4).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * A cache is only ever a shortcut: every method here swallows a CacheService failure and behaves as a miss, so a
 * broken cache costs speed, never correctness.
 *
 * Invalidation uses generation numbers instead of deleting keys. A key such as cat:{wsId}:{gen} contains the current
 * generation, so bumping the generation makes every older entry unreachable at once; they simply expire. A generation
 * lives 6 hours from its last bump and reads as 0 when missing, which is safe because no entry lives longer than 6
 * hours. A lost increment (two bumps racing) only leaves a stale entry reachable until its TTL, which section 5.4
 * accepts.
 */
var Cache = {

  /** Seconds each kind of entry lives (BUILD_SPEC section 5.4). */
  TTL_: { GEN: 21600, ACCT: 60, CATALOG: 300, GRANT: 60, LIVE: 60, REPORT: 300, SETTINGS: 300 },

  /** Largest value stored, in UTF-8 bytes of its JSON text. CacheService itself allows 100 KB. */
  MAX_VALUE_BYTES_: 90000,
  /** CacheService refuses longer keys, so a longer key is simply never cached. */
  MAX_KEY_LENGTH_: 250,
  /** CacheService caps every expiry at 6 hours. */
  MAX_TTL_SECONDS_: 21600,

  GEN_ACCT_: 'gen:acct',
  GEN_SETTINGS_: 'gen:settings',

  genWs_: function (wsId) { return 'gen:ws:' + wsId; },
  genRep_: function (wsId) { return 'gen:rep:' + wsId; },

  // ------------------------------------------------------------ generations

  /** The current generation of a name; 0 if missing, expired or not a number. */
  gen_: function (name) {
    try {
      var raw = CacheService.getScriptCache().get(name);
      if (raw !== null && /^\d{1,15}$/.test(String(raw))) return Number(raw);
    } catch (err) {
      // a cache failure reads as generation 0
    }
    return 0;
  },

  /** Increments a generation and returns the new value. Renews its 6 hours. */
  bump_: function (name) {
    var next = Cache.gen_(name) + 1;
    try {
      CacheService.getScriptCache().put(name, String(next), Cache.TTL_.GEN);
    } catch (err) {
      // the entries stay reachable until their own TTL
    }
    return next;
  },

  // ------------------------------------------------------------ values

  /** The cached JSON value, or null for a miss, a corrupt entry or an unusable key. */
  get_: function (key) {
    if (!Cache.usableKey_(key)) return null;
    try {
      var cache = CacheService.getScriptCache();
      var raw = cache.get(key);
      if (raw === null) return null;
      try {
        return JSON.parse(raw);
      } catch (err) {
        cache.remove(key);
        return null;
      }
    } catch (err) {
      return null;
    }
  },

  /**
   * Stores a JSON value for ttlSeconds (capped at 6 hours). Returns whether it was stored: false when the key is too
   * long, the value is not JSON or is over MAX_VALUE_BYTES_, or the cache failed. The caller never needs to care.
   */
  put_: function (key, value, ttlSeconds) {
    var usable = Cache.usableKey_(key);
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new AppError_('INTERNAL', 'An internal error occurred.', { error: 'Cache.put_ needs a ttl of whole seconds, at least 1' });
    }
    if (!usable) return false;
    var json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      return false;
    }
    if (typeof json !== 'string' || Util.utf8Length_(json) > Cache.MAX_VALUE_BYTES_) return false;
    try {
      CacheService.getScriptCache().put(key, json, Math.min(ttlSeconds, Cache.MAX_TTL_SECONDS_));
      return true;
    } catch (err) {
      return false;
    }
  },

  remove_: function (key) {
    if (!Cache.usableKey_(key)) return;
    try {
      CacheService.getScriptCache().remove(key);
    } catch (err) {
      // nothing to do
    }
  },

  /** True for a key CacheService accepts; throws for one that is not a non-empty string; false for one too long. */
  usableKey_: function (key) {
    if (typeof key !== 'string' || key === '') {
      throw new AppError_('INTERNAL', 'An internal error occurred.', { error: 'a cache key must be a non-empty string' });
    }
    return key.length <= Cache.MAX_KEY_LENGTH_;
  },

  // ------------------------------------------------------------ the keys of BUILD_SPEC section 5.4

  /** acct:{gen}:{email}, invalidated by gen:acct. The email must already be lower-cased. */
  acctKey_: function (email) {
    return 'acct:' + Cache.gen_(Cache.GEN_ACCT_) + ':' + email;
  },

  /** cat:{wsId}:{gen}, invalidated by gen:ws:{wsId}. */
  catalogKey_: function (wsId) {
    return 'cat:' + wsId + ':' + Cache.gen_(Cache.genWs_(wsId));
  },

  /**
   * rep:{wsId}:{gen}:{digest}. A report depends on both the workspace's catalog (gen:ws) and on every entry or timer
   * write in it (gen:rep), so {gen} is the two numbers joined: bumping either one changes the key.
   */
  reportKey_: function (wsId, digest) {
    return 'rep:' + wsId + ':' + Cache.gen_(Cache.genWs_(wsId)) + '.' + Cache.gen_(Cache.genRep_(wsId)) + ':' + digest;
  },

  /** settings:{gen}, invalidated by gen:settings. */
  settingsKey_: function () {
    return 'settings:' + Cache.gen_(Cache.GEN_SETTINGS_);
  },

  /** grant:{hash}: time only (and deleted on revoke or logout). */
  grantKey_: function (tokenHash) {
    return 'grant:' + tokenHash;
  },

  /** live:{wsId}: time only. */
  liveKey_: function (wsId) {
    return 'live:' + wsId;
  }
};

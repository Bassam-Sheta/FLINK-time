/**
 * Config.gs - constants, error codes, settings catalog (BUILD_SPEC sections 2, 3, 4.3 and 6.5).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 *   ERROR_CODES_ / AppError_   the one way the app reports a failure (sections 3 and 4.3)
 *   SETTINGS_CATALOG_          every setting, its type, range, default and scope (section 6.5)
 *   Config.get_(key, wsId)     a setting's value: the workspace's own row, then the GLOBAL row, then the default
 *
 * COMPANY_DOMAIN is not a setting: it is a Script Property written only by the setup page.
 */

/**
 * Every setting (BUILD_SPEC section 6.5; tests/v2/config.test.js compares this list with the spec's table). A GLOBAL
 * setting lives only at scope 'GLOBAL'; a WORKSPACE setting may also be overridden per workspace (scope = the workspace
 * id) and falls back to the GLOBAL row. Every settings.patch needs step-up, so stepUp is true throughout.
 * type is one of text, tz, int, bool; min and max are the length of a text or the range of an int, else null.
 */
var SETTINGS_CATALOG_ = [
  { key: 'COMPANY_NAME', type: 'text', default: 'FLINK Business Solutions', min: 1, max: 120, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'DEFAULT_TIMEZONE', type: 'tz', default: 'Africa/Cairo', min: null, max: null, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'AUTO_STOP_HOURS', type: 'int', default: 14, min: 1, max: 24, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'PAST_ENTRY_EDIT_DAYS', type: 'int', default: 7, min: 0, max: 90, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'REQUIRE_DESCRIPTION', type: 'bool', default: false, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'RULE_PROJECT_REQUIRED', type: 'bool', default: false, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'RULE_TASK_REQUIRED', type: 'bool', default: false, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'ALLOW_USER_DELETE_ENTRY', type: 'bool', default: true, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'ALLOW_USER_PROJECT_SWITCH', type: 'bool', default: true, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'FEATURE_TAGS', type: 'bool', default: true, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'FEATURE_LIVE_VIEW', type: 'bool', default: true, min: null, max: null, options: [], scope: 'WORKSPACE', stepUp: true },
  { key: 'ADMIN_MAX_ACTIVE_WORKSPACES', type: 'int', default: 3, min: 0, max: 50, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'ADMIN_IDLE_MINUTES', type: 'int', default: 30, min: 5, max: 240, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'ADMIN_ABSOLUTE_HOURS', type: 'int', default: 8, min: 1, max: 24, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'TIMER_CLIENT_SKEW_SECONDS', type: 'int', default: 120, min: 0, max: 600, options: [], scope: 'GLOBAL', stepUp: true },
  { key: 'RATE_LIMIT_WRITES_PER_MIN', type: 'int', default: 60, min: 10, max: 600, options: [], scope: 'GLOBAL', stepUp: true }
];

var Config = {

  SCOPE_GLOBAL_: 'GLOBAL',

  // ------------------------------------------------------------ the catalog

  /** The catalog entry for a key, or null. Never matches an inherited name such as "toString". */
  entry_: function (key) {
    if (typeof key !== 'string') return null;
    for (var i = 0; i < SETTINGS_CATALOG_.length; i++) {
      if (SETTINGS_CATALOG_[i].key === key) return SETTINGS_CATALOG_[i];
    }
    return null;
  },

  /** The Validate.js schema type that describes a setting's values, such as 'int:1:24'. */
  typeString_: function (entry) {
    switch (entry.type) {
      case 'text': return 'text:' + entry.min + ':' + entry.max;
      case 'int': return 'int:' + entry.min + ':' + entry.max;
      case 'tz': return 'tz';
      case 'bool': return 'bool';
      case 'enum': return 'enum:' + entry.options.join('|');
      default: throw new AppError_('INTERNAL', 'An internal error occurred.', { error: 'unknown setting type ' + entry.type });
    }
  },

  /** The value normalised under the setting's rules (text trimmed), or a thrown VALIDATION naming "value". */
  normalize_: function (entry, value) {
    return Validate.payload_({ value: Config.typeString_(entry) }, { value: value }).value;
  },

  /** True for a scope a settings row may have: 'GLOBAL' or a workspace id. */
  scopeOk_: function (scope) {
    return scope === Config.SCOPE_GLOBAL_ || (typeof scope === 'string' && Validate.UUID_PATTERN_.test(scope));
  },

  /**
   * Checks a setting to be saved (what settings.patch does before writing): a known key, a scope the setting allows, a
   * value inside its rules. Returns { key, scope, value, json } with the normalised value and the JSON to store in
   * settings.value_json. Throws VALIDATION with details.field 'key', 'scope' or 'value'.
   */
  checkSetting_: function (key, value, scope) {
    var entry = Config.entry_(key);
    if (!entry) throw Validate.fail_('key', 'key is not a known setting');
    if (!Config.scopeOk_(scope)) throw Validate.fail_('scope', 'scope must be GLOBAL or a workspace id');
    if (scope !== Config.SCOPE_GLOBAL_ && entry.scope !== 'WORKSPACE') {
      throw Validate.fail_('scope', key + ' can only be set globally');
    }
    var normalised = Config.normalize_(entry, value);
    return { key: entry.key, scope: scope, value: normalised, json: Util.canonicalJson_(normalised) };
  },

  // ------------------------------------------------------------ reading settings

  /** True if object has its own property key (and object is an object at all). */
  own_: function (object, key) {
    return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
  },

  /**
   * Turns the rows of the settings table into a snapshot { scope: { key: value } }. A row that is not valid (unknown
   * key, a scope that is neither GLOBAL nor a workspace id, a workspace row for a GLOBAL setting, bad JSON, a value
   * outside the setting's rules) is ignored with a warning that names the row but not its value, so a bad row can
   * never switch a rule off.
   */
  build_: function (rows) {
    var snapshot = {};
    rows.forEach(function (row) {
      var entry = Config.entry_(row.key);
      var usable = entry !== null && Config.scopeOk_(row.scope) && (row.scope === Config.SCOPE_GLOBAL_ || entry.scope === 'WORKSPACE');
      var value;
      if (usable) {
        try {
          value = Config.normalize_(entry, JSON.parse(row.value_json));
        } catch (err) {
          usable = false;
        }
      }
      if (!usable) {
        console.warn('settings row ignored: ' + String(row.scope).slice(0, 80) + ' ' + String(row.key).slice(0, 80));
        return;
      }
      if (!Config.own_(snapshot, row.scope)) snapshot[row.scope] = {};
      snapshot[row.scope][entry.key] = value;
    });
    return snapshot;
  },

  /**
   * All settings rows as a snapshot, from the cache (settings:{gen}, 5 minutes) or the database. A database that cannot be
   * read throws: guessing the defaults could silently relax a rule.
   */
  load_: function () {
    var cacheKey = Cache.settingsKey_();
    var cached = Cache.get_(cacheKey);
    if (cached !== null && typeof cached === 'object' && !Array.isArray(cached)) return cached;
    var rows = Db.read_([{ sql: 'SELECT scope, key, value_json FROM settings' }])[0];
    var snapshot = Config.build_(rows);
    Cache.put_(cacheKey, snapshot, Cache.TTL_.SETTINGS);
    return snapshot;
  },

  /**
   * The value of a setting in a snapshot: the workspace's own row (only for a WORKSPACE setting), then the GLOBAL row,
   * then the catalog default. false and 0 are values like any other.
   */
  value_: function (snapshot, key, workspaceId) {
    var entry = Config.entry_(key);
    if (!entry) throw new AppError_('INTERNAL', 'An internal error occurred.', { error: 'unknown setting ' + String(key) });
    if (entry.scope === 'WORKSPACE' && typeof workspaceId === 'string' && Config.own_(snapshot, workspaceId) &&
        Config.own_(snapshot[workspaceId], key)) {
      return snapshot[workspaceId][key];
    }
    if (Config.own_(snapshot, Config.SCOPE_GLOBAL_) && Config.own_(snapshot[Config.SCOPE_GLOBAL_], key)) {
      return snapshot[Config.SCOPE_GLOBAL_][key];
    }
    return entry.default;
  },

  /** One setting for a workspace (or globally when workspaceId is left out). */
  get_: function (key, workspaceId) {
    return Config.value_(Config.load_(), key, workspaceId);
  },

  /** Every setting's value for a workspace, from a snapshot: { KEY: value }. */
  effective_: function (snapshot, workspaceId) {
    var values = {};
    SETTINGS_CATALOG_.forEach(function (entry) {
      values[entry.key] = Config.value_(snapshot, entry.key, workspaceId);
    });
    return values;
  }
};

/**
 * Every error code the app may return, with whether the page may retry (BUILD_SPEC section 4.3). Codes are only
 * these; AppError_ refuses any other. RATE_LIMITED is retryable after retryAfterSeconds.
 */
var ERROR_CODES_ = {
  AUTH_UNAVAILABLE: { retryable: false },
  NOT_PROVISIONED: { retryable: false },
  ACCOUNT_INACTIVE: { retryable: false },
  FORBIDDEN: { retryable: false },
  CODE_REQUIRED: { retryable: false },
  STEP_UP_REQUIRED: { retryable: false },
  LOCKED_OUT: { retryable: false },
  VALIDATION: { retryable: false },
  POLICY: { retryable: false },
  NOT_FOUND: { retryable: false },
  CONFLICT: { retryable: false },
  RATE_LIMITED: { retryable: true, retryAfterSeconds: 60 },
  BUSY: { retryable: true },
  DB_UNAVAILABLE: { retryable: true },
  INTERNAL: { retryable: false }
};

/**
 * The one way the app reports a failure: throw new AppError_(code, message, details). Main turns it into the
 * response contract (BUILD_SPEC section 4.2). A class declaration only defines something, so it is allowed at the top
 * level. For INTERNAL, message must be generic: details are logged, never returned.
 */
class AppError_ extends Error {
  constructor(code, message, details) {
    super(message);
    if (!Object.prototype.hasOwnProperty.call(ERROR_CODES_, code)) {
      throw new Error('Unknown error code: ' + code);
    }
    this.name = 'AppError_';
    this.code = code;
    this.details = details === undefined ? {} : details;
    this.retryable = ERROR_CODES_[code].retryable;
  }
}

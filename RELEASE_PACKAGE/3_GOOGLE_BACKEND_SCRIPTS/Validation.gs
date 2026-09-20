/**
 * FLINK Time & Workforce Platform — Input Validation & Sanitization
 */

const Validation = {
  /**
   * Spreadsheet Formula Injection Defense
   * Neutralizes formula execution by prepending a single quote if the string starts with =, +, -, @, tab, or newline.
   */
  sanitizeCellValue(val) {
    if (val === null || val === undefined) return '';
    if (typeof val === 'number' || typeof val === 'boolean') return val;
    const str = String(val);
    if (/^[=+\-@\t\r\n]/.test(str)) {
      return "'" + str;
    }
    return str;
  },

  /**
   * Sanitizes all string values within an object or array
   */
  sanitizeRow(row) {
    if (Array.isArray(row)) {
      return row.map(v => Validation.sanitizeCellValue(v));
    }
    const clean = {};
    for (const [k, v] of Object.entries(row)) {
      clean[k] = Validation.sanitizeCellValue(v);
    }
    return clean;
  },

  validateUsername(username) {
    if (!username || typeof username !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username is required and must be a string.');
    }
    const trimmed = username.trim().toLowerCase();
    if (trimmed.length < 3 || trimmed.length > 50) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username must be between 3 and 50 characters.');
    }
    if (!/^[a-z0-9_.\-]+$/.test(trimmed)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Username may only contain letters, numbers, underscores, dashes, and periods.');
    }
    return trimmed;
  },

  validatePassword(password) {
    if (!password || typeof password !== 'string') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Password is required.');
    }
    if (password.length < CONSTANTS.LIMITS.MIN_PASSWORD_LENGTH) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Password must be at least ${CONSTANTS.LIMITS.MIN_PASSWORD_LENGTH} characters long.`);
    }
    if (password.length > CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Password cannot exceed ${CONSTANTS.LIMITS.MAX_PASSWORD_LENGTH} characters.`);
    }
    return password;
  },

  validateRole(role) {
    if (!role || !Object.values(CONSTANTS.ROLES).includes(role)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Invalid role. Allowed roles: ${Object.values(CONSTANTS.ROLES).join(', ')}`);
    }
    return role;
  },

  validateDateRange(startUtc, endUtc, allowFuture = false) {
    const s = new Date(startUtc).getTime();
    const e = new Date(endUtc).getTime();
    if (isNaN(s) || isNaN(e)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Invalid timestamp provided.');
    }
    if (e < s) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'End time cannot be earlier than start time.');
    }
    // Anti-Cheat: Reject future-dated time logs (allowing 5 min clock skew tolerance)
    const now = Date.now();
    if (!allowFuture && e > (now + 5 * 60 * 1000)) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Time entries cannot be logged with future end dates.');
    }
    const durationSeconds = Math.round((e - s) / 1000);
    const maxSeconds = CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS * 3600;
    if (durationSeconds > maxSeconds) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Time entry duration cannot exceed ${CONSTANTS.LIMITS.MAX_SINGLE_ENTRY_HOURS} hours.`);
    }
    return durationSeconds;
  },

  generateId(prefix = 'ID') {
    const randomHex = () => Math.floor((1 + Math.random()) * 0x10000).toString(16).substring(1);
    const ts = Date.now().toString(36);
    return `${prefix}-${ts}-${randomHex()}${randomHex()}`.toUpperCase();
  },

  assertRequired(obj, fields = []) {
    if (!obj || typeof obj !== 'object') {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Request payload missing or invalid.');
    }
    for (const f of fields) {
      if (obj[f] === undefined || obj[f] === null || obj[f] === '') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Missing required field: ${f}`);
      }
    }
  },

  /**
   * Optimistic Concurrency Control (Record Versioning)
   * Section 43: Prevents silent overwrites by asserting expected version equals record current version.
   */
  assertRecordVersion(record, expectedVersion) {
    if (expectedVersion === undefined || expectedVersion === null) return;
    const currentVer = parseInt(record.Version || 1, 10);
    const expVer = parseInt(expectedVersion, 10);
    if (currentVer !== expVer) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        `Record was modified by another user (expected v${expVer}, current v${currentVer}). Please refresh and try again.`,
        409
      );
    }
  },

  /**
   * Action Idempotency Cache
   * Section 49: Avoids duplicate execution on browser network retry.
   */
  _idempotencyCache: new Map(),

  getIdempotencyResult(actionId) {
    if (!actionId) return null;
    if (this._idempotencyCache.has(actionId)) {
      return this._idempotencyCache.get(actionId);
    }
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try {
        const cached = CacheService.getScriptCache().get(`IDEMP_${actionId}`);
        if (cached) return JSON.parse(cached);
      } catch (e) {}
    }
    return null;
  },

  setIdempotencyResult(actionId, result) {
    if (!actionId) return;
    this._idempotencyCache.set(actionId, result);
    if (typeof CacheService !== 'undefined' && CacheService.getScriptCache) {
      try {
        CacheService.getScriptCache().put(`IDEMP_${actionId}`, JSON.stringify(result), 3600);
      } catch (e) {}
    }
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Validation
  };
}

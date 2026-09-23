/**
 * FLINK Time & Workforce Platform — Error Definitions
 */

const ERROR_CODES = {
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_PASSIVE: 'ACCOUNT_PASSIVE',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  WORKSPACE_DENIED: 'WORKSPACE_DENIED',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  ACTIVE_TIMER_EXISTS: 'ACTIVE_TIMER_EXISTS',
  TIMER_NOT_FOUND: 'TIMER_NOT_FOUND',
  ENTRY_LOCKED: 'ENTRY_LOCKED',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  NOT_FOUND: 'NOT_FOUND',
  ADMIN_LIMIT_EXCEEDED: 'ADMIN_LIMIT_EXCEEDED',
  CRYPTO_FAILURE: 'CRYPTO_FAILURE',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
};

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
        statusCode: this.statusCode,
        details: this.details
      }
    };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ERROR_CODES,
    AppError
  };
}

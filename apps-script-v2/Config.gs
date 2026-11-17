/**
 * Config.gs - constants, error codes, settings catalog (BUILD_SPEC section 2).
 * Top-level code only defines things (BUILD_SPEC section 2.1).
 *
 * So far: the error code table (section 4.3) and AppError_ (section 3), which Db.gs needs from ticket T1.4.
 * The settings catalog and settings reads arrive with T1.7.
 */
var Config = {};

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

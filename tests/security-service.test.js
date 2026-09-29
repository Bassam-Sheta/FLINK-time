'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function unsigned(bytes) {
  return Array.from(bytes || []).map(b => b < 0 ? b + 256 : b);
}

function signed(bytes) {
  return Array.from(bytes || []).map(b => {
    const value = Number(b) & 0xff;
    return value > 127 ? value - 256 : value;
  });
}

function loadAppsScriptFallback() {
  global.AppError = AppError;
  global.ERROR_CODES = {
    CRYPTO_FAILURE: 'CRYPTO_FAILURE',
    VALIDATION_ERROR: 'VALIDATION_ERROR'
  };
  global.CONSTANTS = {
    SECURITY: {
      PBKDF2_ITERATIONS: 10000,
      PBKDF2_KEY_BYTES: 32,
      SALT_BYTES: 16,
      TOKEN_BYTES: 32,
      PEPPER_PROPERTY_KEY: 'PEPPER',
      DEFAULT_PEPPER: 'test-pepper',
      AUDIT_KEY_SUFFIX: '_AUDIT'
    }
  };
  global.Validation = {
    validatePassword(value) { return value; }
  };
  global.Utilities = {
    MacAlgorithm: { HMAC_SHA_1: 'HMAC_SHA_1' },
    computeHmacSha256Signature(value, key) {
      const digest = crypto
        .createHmac('sha256', Buffer.from(unsigned(key)))
        .update(Buffer.from(unsigned(value)))
        .digest();
      return signed(digest);
    },
    computeHmacSignature(algorithm, value, key) {
      assert.equal(algorithm, 'HMAC_SHA_1');
      const digest = crypto
        .createHmac('sha1', Buffer.from(unsigned(key)))
        .update(Buffer.from(unsigned(value)))
        .digest();
      return signed(digest);
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const { SecurityService } = require(servicePath);
  SecurityService._getCrypto = () => null;
  return SecurityService;
}

test('Apps Script PBKDF2 fallback matches RFC-compatible SHA-256 vector (1 iteration)', () => {
  const SecurityService = loadAppsScriptFallback();
  assert.equal(
    SecurityService.pbkdf2Sync('password', 'salt', 1, 32),
    '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b'
  );
});

test('Apps Script PBKDF2 fallback matches RFC-compatible SHA-256 vector (2 iterations)', () => {
  const SecurityService = loadAppsScriptFallback();
  assert.equal(
    SecurityService.pbkdf2Sync('password', 'salt', 2, 32),
    'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43'
  );
});

test('Apps Script TOTP fallback matches RFC 6238 SHA-1 vector', () => {
  const SecurityService = loadAppsScriptFallback();
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // "12345678901234567890"
  assert.equal(
    SecurityService.generateTotpCode(secret, 59000, 30, 8),
    '94287082'
  );
});

test('byte-safe HMAC preserves values above 0x7f', () => {
  const SecurityService = loadAppsScriptFallback();
  const key = [0x00, 0x7f, 0x80, 0xff, 0x10];
  const message = [0xff, 0x80, 0x01, 0x00, 0xaa];
  const expected = crypto
    .createHmac('sha256', Buffer.from(key))
    .update(Buffer.from(message))
    .digest('hex');
  const actual = SecurityService
    .hmacSha256(key, message)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  assert.equal(actual, expected);
});

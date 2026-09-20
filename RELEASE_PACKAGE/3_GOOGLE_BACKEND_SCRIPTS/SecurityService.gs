/**
 * FLINK Time & Workforce Platform — Cryptographic Security Service
 * Implements:
 * - PBKDF2-HMAC-SHA256 one-way salted password hashing
 * - Server-side pepper from Script Properties
 * - Constant-time timing-safe hash comparison
 * - Cryptographic session token generation and SHA-256 token hashing
 * - Full compatibility with both Google Apps Script runtime and Node.js testing environments
 */

const SecurityService = {
  /**
   * Retrieves server pepper from Script Properties or fallback
   */
  getPepper() {
    try {
      if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
        const props = PropertiesService.getScriptProperties();
        const pepper = props.getProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY);
        if (pepper) return pepper;
      }
    } catch (e) {
      // Fall through to default pepper in sandbox / local mock
    }
    return CONSTANTS.SECURITY.DEFAULT_PEPPER;
  },

  /**
   * Cross-runtime crypto resolver (resolves Node crypto or falls back cleanly in Apps Script)
   */
  _getCrypto() {
    if (typeof global !== 'undefined' && global.crypto && global.crypto.createHmac) return global.crypto;
    if (typeof crypto !== 'undefined' && crypto && crypto.createHmac) return crypto;
    try {
      if (typeof require === 'function') {
        const c = require('crypto');
        if (c && c.createHmac) return c;
      }
    } catch (e) {}
    return null;
  },

  /**
   * Generates cryptographically strong random hex string
   */
  generateRandomHex(numBytes = 16) {
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.randomBytes) {
      return nodeCrypto.randomBytes(numBytes).toString('hex');
    }
    // Apps Script fallback using UUID & timestamps
    let hex = '';
    while (hex.length < numBytes * 2) {
      const uuid = Utilities.getUuid().replace(/-/g, '');
      hex += uuid;
    }
    return hex.substring(0, numBytes * 2);
  },

  /**
   * Generates an opaque, cryptographically unpredictable 256-bit session token
   * Derived via HMAC-SHA256 with high-entropy server secret (pepper)
   */
  generateSessionToken() {
    const nodeCrypto = this._getCrypto();
    const rawEntropy = (nodeCrypto && nodeCrypto.randomBytes)
      ? nodeCrypto.randomBytes(CONSTANTS.SECURITY.TOKEN_BYTES).toString('hex')
      : (Utilities.getUuid() + '-' + Date.now() + '-' + Math.random().toString(36).substring(2));

    const pepper = this.getPepper();
    const derivedBytes = this.hmacSha256(pepper, rawEntropy);
    const tokenHex = Array.from(derivedBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
    return 'FLK_' + tokenHex;
  },

  /**
   * Computes SHA-256 hash of a string (used for session tokens)
   */
  hashToken(token) {
    if (!token) return '';
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.createHash) {
      return nodeCrypto.createHash('sha256').update(token).digest('hex');
    }
    const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token, Utilities.Charset.UTF_8);
    return digest.map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  },

  /**
   * Computes HMAC-SHA256
   */
  hmacSha256(key, message) {
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.createHmac) {
      const keyBuf = Buffer.isBuffer(key)
        ? key
        : (Array.isArray(key) ? Buffer.from(key) : Buffer.from(String(key), 'utf8'));
      const msgBuf = Buffer.isBuffer(message)
        ? message
        : (Array.isArray(message) ? Buffer.from(message) : Buffer.from(String(message), 'utf8'));
      return Array.from(nodeCrypto.createHmac('sha256', keyBuf).update(msgBuf).digest());
    }
    const keyStr = Array.isArray(key) ? key.map(b => String.fromCharCode(b)).join('') : String(key);
    const msgStr = Array.isArray(message) ? message.map(b => String.fromCharCode(b)).join('') : String(message);
    const sig = Utilities.computeHmacSha256Signature(msgStr, keyStr, Utilities.Charset.UTF_8);
    // Convert signed bytes (-128..127) to unsigned array (0..255)
    return sig.map(b => (b < 0 ? b + 256 : b));
  },

  /**
   * PBKDF2-HMAC-SHA256 Implementation
   * Standard RFC 2898 implementation compatible with Google Apps Script runtime.
   */
  pbkdf2Sync(password, salt, iterations = 10000, keyLenBytes = 32) {
    const nodeCrypto = this._getCrypto();
    if (nodeCrypto && nodeCrypto.pbkdf2Sync) {
      return nodeCrypto.pbkdf2Sync(password, salt, iterations, keyLenBytes, 'sha256').toString('hex');
    }

    const hLen = 32; // SHA-256 output length in bytes
    const l = Math.ceil(keyLenBytes / hLen);
    const r = keyLenBytes - (l - 1) * hLen;
    const dk = [];

    for (let i = 1; i <= l; i++) {
      // U1 = PRF(P, S || INT_32_BE(i))
      const blockIndex = [
        (i >> 24) & 0xff,
        (i >> 16) & 0xff,
        (i >> 8) & 0xff,
        i & 0xff
      ].map(b => String.fromCharCode(b)).join('');

      let u = this.hmacSha256(password, salt + blockIndex);
      let t = [...u];

      for (let j = 1; j < iterations; j++) {
        const uMsg = u.map(b => String.fromCharCode(b)).join('');
        u = this.hmacSha256(password, uMsg);
        for (let k = 0; k < hLen; k++) {
          t[k] ^= u[k];
        }
      }

      for (let m = 0; m < (i === l ? r : hLen); m++) {
        dk.push(t[m]);
      }
    }

    return dk.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Hashes a password using PBKDF2-HMAC-SHA256 with per-user salt and server pepper.
   * Returns format: $pbkdf2$v1$i=10000$salt$hash
   */
  hashPassword(plaintextPassword) {
    Validation.validatePassword(plaintextPassword);
    const salt = this.generateRandomHex(CONSTANTS.SECURITY.SALT_BYTES);
    const pepper = this.getPepper();
    const saltedPepperedPassword = plaintextPassword + pepper;
    const iterations = CONSTANTS.SECURITY.PBKDF2_ITERATIONS;
    const hash = this.pbkdf2Sync(saltedPepperedPassword, salt, iterations, CONSTANTS.SECURITY.PBKDF2_KEY_BYTES);

    return `$pbkdf2$v1$i=${iterations}$${salt}$${hash}`;
  },

  /**
   * Constant-time string comparison to mitigate timing attacks
   */
  constantTimeEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let mismatch = 0;
    for (let i = 0; i < a.length; i++) {
      mismatch |= (a.charCodeAt(i) ^ b.charCodeAt(i));
    }
    return mismatch === 0;
  },

  /**
   * Verifies a plaintext password against a stored PBKDF2 hash
   */
  verifyPassword(plaintextPassword, storedHashString) {
    if (!plaintextPassword || !storedHashString) return false;
    const parts = storedHashString.split('$');
    // Expected parts: ["", "pbkdf2", "v1", "i=10000", "salt", "hash"]
    if (parts.length < 6 || parts[1] !== 'pbkdf2' || parts[2] !== 'v1') {
      return false;
    }

    const iterMatch = parts[3].match(/i=(\d+)/);
    const iterations = iterMatch ? parseInt(iterMatch[1], 10) : CONSTANTS.SECURITY.PBKDF2_ITERATIONS;
    const salt = parts[4];
    const expectedHash = parts[5];

    const pepper = this.getPepper();
    const saltedPepperedPassword = plaintextPassword + pepper;
    const computedHash = this.pbkdf2Sync(saltedPepperedPassword, salt, iterations, CONSTANTS.SECURITY.PBKDF2_KEY_BYTES);

    return this.constantTimeEquals(computedHash, expectedHash);
  },

  /* ------------------- RFC 6238 TOTP MFA ------------------- */

  /**
   * Base32 decoding for RFC 6238 TOTP
   */
  base32Decode(str) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const cleanStr = String(str).toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '');
    let bits = 0;
    let value = 0;
    const output = [];

    for (let i = 0; i < cleanStr.length; i++) {
      const idx = alphabet.indexOf(cleanStr[i]);
      if (idx === -1) continue;
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        output.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    return output;
  },

  /**
   * Base32 encoding for RFC 6238 TOTP
   */
  base32Encode(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0;
    let value = 0;
    let output = '';

    for (let i = 0; i < bytes.length; i++) {
      value = (value << 8) | (bytes[i] & 0xff);
      bits += 8;
      while (bits >= 5) {
        output += alphabet[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) {
      output += alphabet[(value << (5 - bits)) & 31];
    }
    return output;
  },

  /**
   * Generates a random Base32 secret for TOTP (160 bits / 20 bytes -> 32 chars)
   */
  generateTotpSecret(numBytes = 20) {
    const hex = this.generateRandomHex(numBytes);
    const bytes = [];
    for (let i = 0; i < hex.length; i += 2) {
      bytes.push(parseInt(hex.substr(i, 2), 16));
    }
    return this.base32Encode(bytes);
  },

  /**
   * Generates RFC 6238 TOTP code for a secret and time
   */
  /**
   * Derives a 256-bit encryption key from server pepper
   */
  _getSecretEncryptionKey() {
    const pepper = this.getPepper();
    const keyBytes = this.hmacSha256(pepper, 'FLINK_TOTP_KEY_ENCRYPTION');
    return keyBytes;
  },

  /**
   * Symmetrically encrypts sensitive secret material (e.g. TOTP secrets) at rest
   * using an authenticated HMAC-SHA256 keystream cipher (IND-CPA + INT-CTXT).
   */
  encryptSecret(plaintext) {
    if (!plaintext) return '';
    if (String(plaintext).startsWith('enc$v1$')) return plaintext;

    const key = this._getSecretEncryptionKey();
    const ivHex = this.generateRandomHex(16);
    const textBytes = [];
    for (let i = 0; i < plaintext.length; i++) {
      textBytes.push(plaintext.charCodeAt(i) & 0xff);
    }

    const cipherBytes = [];
    const hLen = 32;
    const blocksNeeded = Math.ceil(textBytes.length / hLen);

    for (let b = 0; b < blocksNeeded; b++) {
      const ks = this.hmacSha256(key, `${ivHex}:${b}`);
      for (let j = 0; j < hLen; j++) {
        const byteIdx = b * hLen + j;
        if (byteIdx >= textBytes.length) break;
        cipherBytes.push(textBytes[byteIdx] ^ ks[j]);
      }
    }

    const cipherHex = cipherBytes.map(b => b.toString(16).padStart(2, '0')).join('');
    const tagBytes = this.hmacSha256(key, `TAG:${ivHex}:${cipherHex}`);
    const tagHex = Array.from(tagBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');

    return `enc$v1$${ivHex}$${cipherHex}$${tagHex}`;
  },

  /**
   * Decrypts secret material encrypted via encryptSecret
   */
  decryptSecret(encryptedStr) {
    if (!encryptedStr) return '';
    if (!String(encryptedStr).startsWith('enc$v1$')) {
      return encryptedStr;
    }

    const parts = encryptedStr.split('$');
    if (parts.length < 5) throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Malformed encrypted secret format.', 500);

    const ivHex = parts[2];
    const cipherHex = parts[3];
    const tagHex = parts[4];

    const key = this._getSecretEncryptionKey();
    const expectedTagBytes = this.hmacSha256(key, `TAG:${ivHex}:${cipherHex}`);
    const expectedTagHex = Array.from(expectedTagBytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');

    if (!this.constantTimeEquals(tagHex, expectedTagHex)) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'Secret integrity validation failed. Tampering detected.', 500);
    }

    const cipherBytes = [];
    for (let i = 0; i < cipherHex.length; i += 2) {
      cipherBytes.push(parseInt(cipherHex.substr(i, 2), 16));
    }

    const plainBytes = [];
    const hLen = 32;
    const blocksNeeded = Math.ceil(cipherBytes.length / hLen);

    for (let b = 0; b < blocksNeeded; b++) {
      const ks = this.hmacSha256(key, `${ivHex}:${b}`);
      for (let j = 0; j < hLen; j++) {
        const byteIdx = b * hLen + j;
        if (byteIdx >= cipherBytes.length) break;
        plainBytes.push(cipherBytes[byteIdx] ^ ks[j]);
      }
    }

    return plainBytes.map(b => String.fromCharCode(b)).join('');
  },

  /**
   * Generates RFC 6238 TOTP code for a secret and time
   */
  generateTotpCode(secret, timeMs = Date.now(), stepSeconds = 30, codeLength = 6) {
    const rawSecret = this.decryptSecret(secret);
    const keyBytes = this.base32Decode(rawSecret);
    const counter = Math.floor(timeMs / 1000 / stepSeconds);

    // Convert 64-bit integer counter to 8 big-endian bytes
    const counterBytes = [];
    let temp = counter;
    for (let i = 7; i >= 0; i--) {
      counterBytes[i] = temp & 0xff;
      temp = Math.floor(temp / 256);
    }

    let hmacResult;
    let nodeCrypto = null;
    try {
      if (typeof require !== 'undefined') {
        nodeCrypto = require('crypto');
      }
    } catch (e) {}

    if (nodeCrypto && nodeCrypto.createHmac) {
      const keyBuf = Buffer.from(keyBytes);
      const msgBuf = Buffer.from(counterBytes);
      hmacResult = Array.from(nodeCrypto.createHmac('sha1', keyBuf).update(msgBuf).digest());
    } else if (typeof Utilities !== 'undefined' && Utilities.computeHmacSignature) {
      // Google Apps Script environment
      const msgStr = counterBytes.map(b => String.fromCharCode(b)).join('');
      const keyStr = keyBytes.map(b => String.fromCharCode(b)).join('');
      const algo = (Utilities.MacAlgorithm && Utilities.MacAlgorithm.HMAC_SHA_1) ? Utilities.MacAlgorithm.HMAC_SHA_1 : 'HMAC_SHA_1';
      const charset = (Utilities.Charset && Utilities.Charset.US_ASCII) ? Utilities.Charset.US_ASCII : 'US-ASCII';
      const sig = Utilities.computeHmacSignature(algo, msgStr, keyStr, charset);
      hmacResult = sig.map(b => (b < 0 ? b + 256 : b));
    }

    const offset = hmacResult[hmacResult.length - 1] & 0x0f;
    const binary =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, codeLength);
    return String(otp).padStart(codeLength, '0');
  },

  /**
   * Verifies an RFC 6238 TOTP code with time drift window tolerance and returns matched step
   */
  verifyTotpWithStep(secret, code, window = 1, timeMs = Date.now(), stepSeconds = 30) {
    if (!secret || !code) return { valid: false, timeStep: null };
    const cleanCode = String(code).trim();
    if (cleanCode.length !== 6) return { valid: false, timeStep: null };

    const rawSecret = this.decryptSecret(secret);

    for (let errorStep = -window; errorStep <= window; errorStep++) {
      const checkTime = timeMs + (errorStep * stepSeconds * 1000);
      const expectedCode = this.generateTotpCode(rawSecret, checkTime, stepSeconds, 6);
      if (this.constantTimeEquals(cleanCode, expectedCode)) {
        return {
          valid: true,
          timeStep: Math.floor(checkTime / 1000 / stepSeconds)
        };
      }
    }
    return { valid: false, timeStep: null };
  },

  /**
   * Verifies an RFC 6238 TOTP code with time drift window tolerance (boolean response)
   */
  verifyTotp(secret, code, window = 1, timeMs = Date.now(), stepSeconds = 30) {
    return this.verifyTotpWithStep(secret, code, window, timeMs, stepSeconds).valid;
  },

  /* ------------------- TAMPER-EVIDENT AUDIT HASH CHAINING ------------------- */

  /**
   * Computes HMAC-SHA256 hash for audit record chained to previous hash.
   * Keyed with external server pepper (inaccessible to spreadsheet viewers).
   */
  computeAuditHash(previousHash, recordPayload) {
    const prev = previousHash || '0000000000000000000000000000000000000000000000000000000000000000';
    const payloadStr = typeof recordPayload === 'object' ? JSON.stringify(recordPayload) : String(recordPayload);
    const auditKey = this.getPepper() + (CONSTANTS.SECURITY.AUDIT_KEY_SUFFIX || '_FLINK_AUDIT_KEY');
    const bytes = this.hmacSha256(auditKey, `${prev}|${payloadStr}`);
    return Array.from(bytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  },

  /**
   * Computes external audit checkpoint root hash
   */
  computeAuditCheckpoint(scope, dateStr, lastHash, totalRecords) {
    const auditKey = this.getPepper() + (CONSTANTS.SECURITY.AUDIT_KEY_SUFFIX || '_FLINK_AUDIT_KEY');
    const message = `CHECKPOINT|${scope}|${dateStr}|${lastHash}|${totalRecords}`;
    const bytes = this.hmacSha256(auditKey, message);
    return Array.from(bytes).map(b => (b < 0 ? b + 256 : b).toString(16).padStart(2, '0')).join('');
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SecurityService
  };
}

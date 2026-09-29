/** FLINK Time — Consolidated identity, authentication, authorization, session, MFA, and tracking policy services. */


/* ===== IdentityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Google Workspace Identity Service
 * Binds browser sessions to the server-observed Google account identity.
 *
 * Security rule:
 * - Never trust a client-supplied email as proof of identity.
 * - WEB sessions require Session.getActiveUser().getEmail().
 * - The observed email must exactly match the FLINK account Email.
 */
var IdentityService = (typeof global !== 'undefined' && global.IdentityService) || {
  normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
  },

  getCurrentGoogleEmail(required = true) {
    let email = '';
    try {
      if (
        typeof Session !== 'undefined' &&
        Session.getActiveUser
      ) {
        const activeUser = Session.getActiveUser();
        if (activeUser && activeUser.getEmail) {
          email = this.normalizeEmail(activeUser.getEmail());
        }
      }
    } catch (err) {
      if (!required) return '';
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity could not be verified.',
        401
      );
    }

    if (!email && required) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace sign-in is required to use FLINK Time.',
        401
      );
    }
    return email;
  },

  assertAccountIdentity(account, clientType = 'WEB') {
    const normalizedClient = String(clientType || 'WEB').toUpperCase();
    if (normalizedClient !== 'WEB' && normalizedClient !== 'SETUP_WIZARD') {
      return '';
    }

    const actualEmail = this.getCurrentGoogleEmail(true);
    const expectedEmail = this.normalizeEmail(account && account.Email);

    if (!expectedEmail || actualEmail !== expectedEmail) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Google Workspace identity does not match this FLINK account.',
        401
      );
    }
    return actualEmail;
  }
};

/* ===== SecurityService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Cryptographic Security Service
 * Implements:
 * - PBKDF2-HMAC-SHA256 one-way salted password hashing
 * - Server-side pepper from Script Properties
 * - Constant-time timing-safe hash comparison
 * - Cryptographic session token generation and SHA-256 token hashing
 * - Full compatibility with both Google Apps Script runtime and Node.js testing environments
 */

var SecurityService = (typeof global !== 'undefined' && global.SecurityService) || {
  /**
   * Ensures a high-entropy server pepper exists in Script Properties.
   * Intended to be called only during owner-controlled installation/bootstrap.
   */
  ensurePepper() {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const props = PropertiesService.getScriptProperties();
      let pepper = props.getProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY);
      if (!pepper) {
        pepper = this.generateRandomHex(32);
        props.setProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY, pepper);
      }
      return pepper;
    }
    // Local/unit-test fallback only. Production Apps Script must use Script Properties.
    return CONSTANTS.SECURITY.DEFAULT_PEPPER;
  },

  /**
   * Retrieves server pepper. In Apps Script production this fails closed if the
   * installation step has not initialized the secret.
   */
  getPepper() {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      const props = PropertiesService.getScriptProperties();
      const pepper = props.getProperty(CONSTANTS.SECURITY.PEPPER_PROPERTY_KEY);
      if (pepper) return pepper;
      throw new AppError(
        ERROR_CODES.CRYPTO_FAILURE,
        'Server cryptographic secret is not initialized. Run initializeInstallation() as the deployment owner.',
        500
      );
    }
    // Local/unit-test fallback only.
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
   * Encodes a JavaScript string to UTF-8 bytes without relying on TextEncoder.
   */
  _utf8Bytes(value) {
    const str = String(value);
    const encoded = unescape(encodeURIComponent(str));
    const bytes = [];
    for (let i = 0; i < encoded.length; i++) {
      bytes.push(encoded.charCodeAt(i) & 0xff);
    }
    return bytes;
  },

  _toSignedBytes(bytes) {
    return Array.from(bytes || []).map(b => {
      const value = Number(b) & 0xff;
      return value > 127 ? value - 256 : value;
    });
  },

  /**
   * Computes HMAC-SHA256 over true bytes in both Node and Apps Script.
   */
  hmacSha256(key, message) {
    const nodeCrypto = this._getCrypto();
    const keyBytes = Array.isArray(key) ? Array.from(key) : this._utf8Bytes(String(key));
    const messageBytes = Array.isArray(message) ? Array.from(message) : this._utf8Bytes(String(message));

    if (nodeCrypto && nodeCrypto.createHmac) {
      return Array.from(
        nodeCrypto
          .createHmac('sha256', Buffer.from(keyBytes))
          .update(Buffer.from(messageBytes))
          .digest()
      );
    }

    if (typeof Utilities === 'undefined' || !Utilities.computeHmacSha256Signature) {
      throw new AppError(ERROR_CODES.CRYPTO_FAILURE, 'HMAC-SHA256 runtime is unavailable.', 500);
    }

    const sig = Utilities.computeHmacSha256Signature(
      this._toSignedBytes(messageBytes),
      this._toSignedBytes(keyBytes)
    );
    return Array.from(sig).map(b => (b < 0 ? b + 256 : b));
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

    const hLen = 32;
    const blockCount = Math.ceil(keyLenBytes / hLen);
    const finalBlockLength = keyLenBytes - (blockCount - 1) * hLen;
    const derived = [];
    const passwordBytes = this._utf8Bytes(password);
    const saltBytes = this._utf8Bytes(salt);

    for (let i = 1; i <= blockCount; i++) {
      const blockIndex = [
        (i >>> 24) & 0xff,
        (i >>> 16) & 0xff,
        (i >>> 8) & 0xff,
        i & 0xff
      ];

      let u = this.hmacSha256(passwordBytes, saltBytes.concat(blockIndex));
      const t = Array.from(u);

      for (let j = 1; j < iterations; j++) {
        u = this.hmacSha256(passwordBytes, u);
        for (let k = 0; k < hLen; k++) {
          t[k] ^= u[k];
        }
      }

      const take = i === blockCount ? finalBlockLength : hLen;
      for (let m = 0; m < take; m++) derived.push(t[m] & 0xff);
    }

    return derived.map(b => b.toString(16).padStart(2, '0')).join('');
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
    // Use the longer length to avoid leaking length information via timing
    const len = Math.max(a.length, b.length);
    let mismatch = a.length !== b.length ? 1 : 0;
    for (let i = 0; i < len; i++) {
      const charA = i < a.length ? a.charCodeAt(i) : 0;
      const charB = i < b.length ? b.charCodeAt(i) : 0;
      mismatch |= (charA ^ charB);
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
      // Google Apps Script byte[] overload. Never route binary key/counter bytes
      // through JavaScript strings/character encodings.
      const algo = (Utilities.MacAlgorithm && Utilities.MacAlgorithm.HMAC_SHA_1)
        ? Utilities.MacAlgorithm.HMAC_SHA_1
        : 'HMAC_SHA_1';
      const sig = Utilities.computeHmacSignature(
        algo,
        this._toSignedBytes(counterBytes),
        this._toSignedBytes(keyBytes)
      );
      hmacResult = Array.from(sig).map(b => (b < 0 ? b + 256 : b));
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

    // Decrypt once here — generateTotpCode will see it's already plaintext and pass through
    const rawSecret = this.decryptSecret(secret);

    for (let errorStep = -window; errorStep <= window; errorStep++) {
      const checkTime = timeMs + (errorStep * stepSeconds * 1000);
      // rawSecret is already decrypted; generateTotpCode's internal decryptSecret
      // will detect it's not prefixed with 'enc$v1$' and pass through safely
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

/* ===== AuthorizationService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Authorization & RBAC Service
 * Strictly enforces server-side role-based access control, workspace isolation,
 * record ownership, and the hard Admin 3-workspace assignment limit.
 */

var AuthorizationService = (typeof global !== 'undefined' && global.AuthorizationService) || {
  /**
   * Asserts that authenticated user possesses one of the allowed roles
   */
  assertRole(authContext, allowedRoles = []) {
    if (!authContext || !authContext.role) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!allowedRoles.includes(authContext.role)) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `Permission denied. Required roles: ${allowedRoles.join(', ')}. Current role: ${authContext.role}`,
        403
      );
    }
  },

  /**
   * Asserts that authenticated user has authorized access to requested workspace
   */
  assertWorkspaceAccess(authContext, requestedWorkspaceId) {
    if (!authContext || !authContext.userId) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication required.', 401);
    }
    if (!requestedWorkspaceId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Workspace ID is required.');
    }

    const workspace = MasterRepository.getWorkspace(requestedWorkspaceId);
    if (!workspace) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND, `Workspace '${requestedWorkspaceId}' does not exist.`, 404);
    }
    if (workspace.Status !== CONSTANTS.WORKSPACE_STATUS.ACTIVE) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        `Workspace '${requestedWorkspaceId}' is not active (${workspace.Status}).`,
        403
      );
    }

    // Super Admin has global access to active workspaces.
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }

    // Authorization is based only on active WorkspaceAccess mappings.
    // PrimaryWorkspaceID is profile/default-selection metadata, not an ACL.
    const accesses = MasterRepository.getWorkspaceAccessForUser(authContext.userId);
    const hasAccess = accesses.some(a =>
      a.WorkspaceID === requestedWorkspaceId &&
      (a.Active === true || a.Active === 'TRUE' || a.Active === 1)
    );

    if (!hasAccess) {
      throw new AppError(
        ERROR_CODES.WORKSPACE_DENIED,
        `Access to workspace '${requestedWorkspaceId}' is denied for user '${authContext.user.Username}'.`,
        403
      );
    }

    return true;
  },

  /**
   * Strictly enforces that an Admin cannot be assigned to more than 3 active workspaces
   */
  assertAdminWorkspaceLimit(targetUserId, targetWorkspaceId) {
    const existingAccesses = MasterRepository.getWorkspaceAccessForUser(targetUserId);

    // The business rule is "maximum active workspaces", not "maximum active ACL
    // rows". A stale ACL pointing at SUSPENDED/MAINTENANCE/ARCHIVED workspace
    // must not consume one of the three operational Admin slots.
    const activeAdminWorkspaces = existingAccesses.filter(access => {
      if (access.Role !== CONSTANTS.ROLES.ADMIN) return false;
      const workspace = MasterRepository.getWorkspace(access.WorkspaceID);
      return workspace && workspace.Status === CONSTANTS.WORKSPACE_STATUS.ACTIVE;
    });

    const alreadyAssigned = activeAdminWorkspaces.some(a => a.WorkspaceID === targetWorkspaceId);
    if (!alreadyAssigned && activeAdminWorkspaces.length >= CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES) {
      throw new AppError(
        ERROR_CODES.ADMIN_LIMIT_EXCEEDED,
        `Admin assignment limit exceeded. An Admin may manage at most ${CONSTANTS.LIMITS.ADMIN_MAX_ACTIVE_WORKSPACES} active workspaces.`,
        400
      );
    }
  },

  /**
   * Asserts record ownership: Users can only manipulate their own unapproved records
   */
  assertRecordOwnership(authContext, recordUserId) {
    if (authContext.role === CONSTANTS.ROLES.SUPER_ADMIN) {
      return true;
    }
    if (authContext.role === CONSTANTS.ROLES.ADMIN) {
      return true; // Admins have operational review rights within their assigned workspaces
    }
    if (authContext.userId !== recordUserId) {
      throw new AppError(ERROR_CODES.PERMISSION_DENIED, 'You do not have permission to modify another user\'s records.', 403);
    }
    return true;
  }
};

/* ===== SessionService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Session Service
 * Manages secure 256-bit token sessions with token hashing, idle & absolute timeouts,
 * and automatic revocation upon password changes or account suspension.
 */

var SessionService = (typeof global !== 'undefined' && global.SessionService) || {
  /**
   * Creates and registers a new authenticated session
   */
  createSession(userId, clientType = 'WEB', clientLabel = '') {
    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    let verifiedClientLabel = String(clientLabel || '').trim();

    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      const account = MasterRepository.findAccountById(userId);
      if (!account) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'User account could not be resolved for session creation.',
          401
        );
      }
      const verifiedEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      if (
        verifiedClientLabel &&
        IdentityService.normalizeEmail(verifiedClientLabel) !== verifiedEmail
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Verified Google Workspace identity changed before session creation.',
          401
        );
      }
      verifiedClientLabel = verifiedEmail;
    }

    const rawToken = SecurityService.generateSessionToken();
    const tokenHash = SecurityService.hashToken(rawToken);
    const now = new Date();
    const sessionId = Validation.generateId('SES');

    const idleTimeoutMs = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 3600 * 1000;
    const absoluteTimeoutMs = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000;
    const expiresAt = new Date(now.getTime() + idleTimeoutMs);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteTimeoutMs);

    const sessionRecord = {
      SessionID: sessionId,
      UserID: userId,
      TokenHash: tokenHash,
      ClientType: normalizedClientType,
      ClientLabel: verifiedClientLabel,
      CreatedAt: now.toISOString(),
      LastSeenAt: now.toISOString(),
      ExpiresAt: expiresAt.toISOString(),
      AbsoluteExpiresAt: absoluteExpiresAt.toISOString(),
      Revoked: false,
      RevokedAt: ''
    };

    MasterRepository.createSession(sessionRecord);

    return {
      sessionId,
      sessionToken: rawToken,
      expiresAt: expiresAt.toISOString()
    };
  },

  /**
   * Validates session token, checks timeouts, verifies user active status, and slides expiration
   */
  validateSession(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Authentication token required.', 401);
    }

    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHash(tokenHash);

    if (!session) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid or expired session.', 401);
    }

    const now = Date.now();
    const expiresAt = new Date(session.ExpiresAt).getTime();
    const lastSeenAt = new Date(session.LastSeenAt).getTime();
    const createdAt = new Date(session.CreatedAt).getTime();

    if ([expiresAt, lastSeenAt, createdAt].some(v => !Number.isFinite(v))) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Session record is invalid. Please sign in again.', 401);
    }

    const idleTimeoutMs = CONSTANTS.LIMITS.SESSION_IDLE_TIMEOUT_HOURS * 3600 * 1000;
    const absoluteTimeoutMs = CONSTANTS.LIMITS.SESSION_ABSOLUTE_TIMEOUT_HOURS * 3600 * 1000;
    const storedAbsoluteExpiresAt = new Date(session.AbsoluteExpiresAt || '').getTime();
    const absoluteExpiresAt = isNaN(storedAbsoluteExpiresAt)
      ? createdAt + absoluteTimeoutMs
      : storedAbsoluteExpiresAt;

    if (
      now > expiresAt ||
      (now - lastSeenAt) > idleTimeoutMs ||
      now > absoluteExpiresAt
    ) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.SESSION_EXPIRED, 'Session has expired due to timeout. Please sign in again.', 401);
    }

    // Verify User Account status
    const user = MasterRepository.findAccountById(session.UserID);
    if (!user) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User account no longer exists.', 401);
    }

    if (user.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Sign in again after it is unlocked.', 403);
    }

    if (user.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
      throw new AppError(ERROR_CODES.ACCOUNT_PASSIVE, 'Account is inactive or suspended.', 403);
    }

    const normalizedClientType = String(session.ClientType || '').toUpperCase();
    if (
      normalizedClientType === 'WEB' ||
      normalizedClientType === 'SETUP_WIZARD'
    ) {
      try {
        const currentGoogleEmail = IdentityService.assertAccountIdentity(
          user,
          normalizedClientType
        );
        const boundGoogleEmail = IdentityService.normalizeEmail(
          session.ClientLabel || ''
        );
        if (!boundGoogleEmail || boundGoogleEmail !== currentGoogleEmail) {
          throw new AppError(
            ERROR_CODES.AUTH_REQUIRED,
            'Session identity binding does not match the active Google account.',
            401
          );
        }
      } catch (identityErr) {
        MasterRepository.updateSession(session.SessionID, {
          Revoked: true,
          RevokedAt: new Date().toISOString(),
          RevokeReason: 'GOOGLE_IDENTITY_MISMATCH'
        });
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'Google Workspace identity changed. Please sign in again.',
          401
        );
      }
    }

    // Persist activity at a coarse interval instead of writing to Sheets on
    // every authenticated read/poll. Idle semantics remain unchanged because
    // the touch interval is tiny compared with the idle timeout.
    const touchIntervalMs =
      (CONSTANTS.LIMITS.SESSION_TOUCH_INTERVAL_MINUTES || 5) * 60 * 1000;
    if ((now - lastSeenAt) >= touchIntervalMs) {
      const newExpiresMs = Math.min(now + idleTimeoutMs, absoluteExpiresAt);
      MasterRepository.updateSession(session.SessionID, {
        LastSeenAt: new Date(now).toISOString(),
        ExpiresAt: new Date(newExpiresMs).toISOString(),
        AbsoluteExpiresAt: new Date(absoluteExpiresAt).toISOString()
      });
    }

    return {
      session,
      user,
      username: user.Username,
      role: user.Role,
      userId: user.UserID
    };
  },

  /**
   * Explicitly revokes a single session (e.g. on logout)
   */
  revokeSession(rawToken) {
    if (!rawToken) return;
    const tokenHash = SecurityService.hashToken(rawToken.trim());
    const session = MasterRepository.findSessionByTokenHash(tokenHash);
    if (session) {
      MasterRepository.updateSession(session.SessionID, {
        Revoked: true,
        RevokedAt: new Date().toISOString()
      });
    }
  },

  /**
   * Revokes all active sessions for a user (e.g. password change, account passive)
   */
  revokeAllUserSessions(userId) {
    MasterRepository.revokeAllUserSessions(userId);
  }
};

/* ===== AuthService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Authentication Service
 * Manages user authentication, lockout protection (5 attempts / 15 min),
 * password changes, administrative resets, and session issuance.
 */

var AuthService = (typeof global !== 'undefined' && global.AuthService) || {
  _mfaChallengeMemory: {},

  _mfaChallengePropertyKey(userId) {
    return 'FLINK_MFA_CHALLENGE_' + String(userId || '').replace(/[^A-Za-z0-9_-]/g, '');
  },

  _storeMfaChallenge(userId, challengeToken, expiresAtMs, googleEmail = '') {
    const record = JSON.stringify({
      tokenHash: SecurityService.hashToken(challengeToken),
      expiresAtMs: Number(expiresAtMs),
      googleEmail: IdentityService.normalizeEmail(googleEmail)
    });

    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .setProperty(this._mfaChallengePropertyKey(userId), record);
      return;
    }

    // Local/unit-test fallback only.
    this._mfaChallengeMemory[userId] = record;
  },

  _getMfaChallenge(userId) {
    let raw = '';
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      raw = PropertiesService
        .getScriptProperties()
        .getProperty(this._mfaChallengePropertyKey(userId)) || '';
    } else {
      raw = this._mfaChallengeMemory[userId] || '';
    }

    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  },

  _deleteMfaChallenge(userId) {
    if (typeof PropertiesService !== 'undefined' && PropertiesService.getScriptProperties) {
      PropertiesService
        .getScriptProperties()
        .deleteProperty(this._mfaChallengePropertyKey(userId));
    } else {
      delete this._mfaChallengeMemory[userId];
    }
  },

  /**
   * Authenticates user with username and password
   */
  login(username, password, clientType = 'WEB') {
    const invalidAuth = () => new AppError(
      ERROR_CODES.AUTH_REQUIRED,
      'Invalid username or password.',
      401
    );

    if (!username || !password) {
      throw invalidAuth();
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    const cleanUsername = String(username).trim().toLowerCase();

    // WEB authentication is always bound to the server-observed Google account.
    // This is deliberately resolved before FLINK credential validation so the
    // browser cannot self-assert an email in the request body.
    let googleEmail = '';
    if (normalizedClientType === 'WEB' || normalizedClientType === 'SETUP_WIZARD') {
      googleEmail = IdentityService.getCurrentGoogleEmail(true);
    }

    const account = MasterRepository.findAccountByUsername(cleanUsername);
    if (!account) {
      MasterRepository.logSecurityEvent({
        Username: cleanUsername,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'User not found',
          googleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      ) || googleEmail;
    } catch (identityErr) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity mismatch',
          observedGoogleIdentity: googleEmail || ''
        }
      });
      throw invalidAuth();
    }

    const cred = MasterRepository.getCredentials(account.UserID);
    if (!cred) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Credentials row missing' }
      });
      throw invalidAuth();
    }

    const now = Date.now();
    const lockUntilMs = cred.LockUntil
      ? new Date(cred.LockUntil).getTime()
      : NaN;

    // A timed lock can auto-expire. A LOCKED account without a valid LockUntil
    // is treated as an administrative lock and never auto-unlocks here.
    if (
      Number.isFinite(lockUntilMs) &&
      lockUntilMs <= now &&
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
    ) {
      MasterRepository.updateAccount(account.UserID, {
        Status: CONSTANTS.ACCOUNT_STATUS.ACTIVE
      });
      MasterRepository.updateCredentials(account.UserID, {
        FailedLoginCount: 0,
        LastFailedAt: '',
        LockUntil: ''
      });
      account.Status = CONSTANTS.ACCOUNT_STATUS.ACTIVE;
      cred.FailedLoginCount = 0;
      cred.LastFailedAt = '';
      cred.LockUntil = '';
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (Number.isFinite(lockUntilMs) && lockUntilMs > now)
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Attempt while account locked',
          lockUntil: cred.LockUntil || ''
        }
      });
      throw invalidAuth();
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Inactive account',
          accountStatus: account.Status
        }
      });
      throw invalidAuth();
    }

    // Graduated retry throttle after failed password attempts. No sleep is used;
    // Apps Script execution time is preserved and the caller must retry later.
    const failedCount = parseInt(cred.FailedLoginCount, 10) || 0;
    const retrySchedule = Array.isArray(CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS)
      ? CONSTANTS.LIMITS.LOGIN_RETRY_DELAYS_SECONDS
      : [0, 2, 5, 15, 30];
    const delaySeconds = retrySchedule[
      Math.min(failedCount, retrySchedule.length - 1)
    ] || 0;
    const lastFailedMs = cred.LastFailedAt
      ? new Date(cred.LastFailedAt).getTime()
      : NaN;

    if (
      failedCount > 0 &&
      delaySeconds > 0 &&
      Number.isFinite(lastFailedMs) &&
      now < lastFailedMs + delaySeconds * 1000
    ) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_THROTTLED,
        Success: false,
        metadata: {
          failedAttempts: failedCount,
          delaySeconds,
          retryAfterMs: Math.max(
            0,
            lastFailedMs + delaySeconds * 1000 - now
          )
        }
      });
      throw invalidAuth();
    }

    const isValid = SecurityService.verifyPassword(
      password,
      cred.PasswordHash
    );

    if (!isValid) {
      const newFailedCount = failedCount + 1;
      const failedAt = new Date(now).toISOString();
      const updates = {
        FailedLoginCount: newFailedCount,
        LastFailedAt: failedAt
      };

      if (newFailedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now +
          CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        updates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });

        MasterRepository.logSecurityEvent({
          UserID: account.UserID,
          Username: account.Username,
          EventType: CONSTANTS.AUDIT_EVENTS.ACCOUNT_LOCK,
          Success: false,
          metadata: {
            failedAttempts: newFailedCount,
            lockUntil
          }
        });
      }

      MasterRepository.updateCredentials(account.UserID, updates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: {
          reason: 'Invalid password',
          failedAttempts: newFailedCount
        }
      });

      throw invalidAuth();
    }

    // Password-stage failures are cleared only after a valid password.
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: ''
    });

    if (cred.MfaEnabled === true || cred.MfaEnabled === 'TRUE') {
      const timestamp = Date.now();
      const sig = SecurityService
        .hashToken(
          `${account.UserID}|${timestamp}|${SecurityService.getPepper()}`
        )
        .substring(0, 16);
      const mfaChallengeToken =
        `MFA_${account.UserID}_${timestamp}_${sig}`;
      this._storeMfaChallenge(
        account.UserID,
        mfaChallengeToken,
        timestamp + 5 * 60 * 1000,
        googleEmail
      );

      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: 'MFA_CHALLENGE_ISSUED',
        Success: true,
        metadata: {
          clientType: normalizedClientType,
          googleIdentity: googleEmail || ''
        }
      });

      return {
        mfaRequired: true,
        mfaChallengeToken,
        userId: account.UserID,
        clientType: normalizedClientType
      };
    }

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: false,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );

    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId:
          account.PrimaryWorkspaceID ||
          assignedWorkspaces[0] ||
          '',
        assignedWorkspaces,
        mustChangePassword:
          account.MustChangePassword === true ||
          account.MustChangePassword === 'TRUE'
      }
    };
  },

  /**
   * Verifies RFC 6238 TOTP code during two-factor login challenge
   */
  verifyMfa(mfaChallengeToken, code, clientType = 'WEB') {
    if (!mfaChallengeToken || !code) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token and 6-digit code are required.', 401);
    }

    const parts = mfaChallengeToken.split('_');
    if (parts.length !== 4 || parts[0] !== 'MFA') {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid MFA challenge token.', 401);
    }

    const [, userId, timestampStr, sig] = parts;
    const timestamp = parseInt(timestampStr, 10);
    const now = Date.now();

    // 5-minute expiration
    if (isNaN(timestamp) || now - timestamp > 5 * 60 * 1000 || now < timestamp - 60 * 1000) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token has expired. Please log in again.', 401);
    }

    const expectedSig = SecurityService.hashToken(`${userId}|${timestamp}|${SecurityService.getPepper()}`).substring(0, 16);
    if (!SecurityService.constantTimeEquals(sig, expectedSig)) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'MFA challenge token signature invalid.', 401);
    }

    const storedChallenge = this._getMfaChallenge(userId);
    const suppliedChallengeHash = SecurityService.hashToken(mfaChallengeToken);
    if (
      !storedChallenge ||
      !storedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(storedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(storedChallenge.expiresAtMs || 0) < now
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const mfaLock = LockService.getScriptLock();
    mfaLock.waitLock(10000);
    try {
    // Re-check the one-time challenge after entering the critical section.
    // Another concurrent request may have consumed it after our pre-lock check.
    const lockedChallenge = this._getMfaChallenge(userId);
    if (
      !lockedChallenge ||
      !lockedChallenge.tokenHash ||
      !SecurityService.constantTimeEquals(lockedChallenge.tokenHash, suppliedChallengeHash) ||
      Number(lockedChallenge.expiresAtMs || 0) < Date.now()
    ) {
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'MFA challenge is invalid, expired, replaced, or already used. Please log in again.',
        401
      );
    }

    const account = MasterRepository.findAccountById(userId);
    const cred = MasterRepository.getCredentials(userId);
    if (!account || !cred || !cred.TotpSecret) {
      throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'User credentials or MFA configuration not found.', 401);
    }

    const normalizedClientType = String(clientType || 'WEB').toUpperCase();
    let googleEmail = '';
    try {
      googleEmail = IdentityService.assertAccountIdentity(
        account,
        normalizedClientType
      );
      const challengeEmail = IdentityService.normalizeEmail(
        lockedChallenge.googleEmail || ''
      );
      if (
        (normalizedClientType === 'WEB' ||
          normalizedClientType === 'SETUP_WIZARD') &&
        (!challengeEmail || challengeEmail !== googleEmail)
      ) {
        throw new AppError(
          ERROR_CODES.AUTH_REQUIRED,
          'MFA challenge identity mismatch.',
          401
        );
      }
    } catch (identityErr) {
      this._deleteMfaChallenge(userId);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.IDENTITY_MISMATCH,
        Success: false,
        metadata: {
          reason: 'Google Workspace identity changed during MFA'
        }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Invalid authentication challenge. Please log in again.',
        401
      );
    }

    if (
      account.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED ||
      (cred.LockUntil && new Date(cred.LockUntil).getTime() > now)
    ) {
      this._deleteMfaChallenge(userId);
      throw new AppError(ERROR_CODES.ACCOUNT_LOCKED, 'Account is temporarily locked. Try again later.', 403);
    }

    if (account.Status !== CONSTANTS.ACCOUNT_STATUS.ACTIVE) {
      this._deleteMfaChallenge(userId);
      throw new AppError(
        ERROR_CODES.ACCOUNT_PASSIVE,
        'This account is inactive or has been deactivated.',
        403
      );
    }

    const verification = SecurityService.verifyTotpWithStep(cred.TotpSecret, code);
    if (!verification.valid) {
      const failedCount = (parseInt(cred.FailedLoginCount, 10) || 0) + 1;
      const credUpdates = {
        FailedLoginCount: failedCount,
        LastFailedAt: new Date(now).toISOString()
      };

      if (failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS) {
        const lockUntil = new Date(
          now + CONSTANTS.LIMITS.LOCKOUT_DURATION_MINUTES * 60 * 1000
        ).toISOString();
        credUpdates.LockUntil = lockUntil;
        MasterRepository.updateAccount(account.UserID, {
          Status: CONSTANTS.ACCOUNT_STATUS.LOCKED
        });
      }

      MasterRepository.updateCredentials(account.UserID, credUpdates);
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Invalid MFA TOTP code', failedAttempts: failedCount }
      });
      throw new AppError(
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? ERROR_CODES.ACCOUNT_LOCKED : ERROR_CODES.AUTH_REQUIRED,
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS
          ? 'Account locked after repeated invalid two-factor codes.'
          : 'Invalid two-factor authentication code.',
        failedCount >= CONSTANTS.LIMITS.MAX_FAILED_LOGIN_ATTEMPTS ? 403 : 401
      );
    }

    // RFC 6238 §5.2 Replay Protection: reject previously validated timestep
    const currentStep = verification.timeStep;
    const lastStep = parseInt(cred.LastSuccessfulTotpStep, 10);
    if (!isNaN(lastStep) && currentStep <= lastStep) {
      MasterRepository.logSecurityEvent({
        UserID: account.UserID,
        Username: account.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_FAIL,
        Success: false,
        metadata: { reason: 'Replayed MFA TOTP code detected', step: currentStep, lastStep }
      });
      throw new AppError(
        ERROR_CODES.AUTH_REQUIRED,
        'Two-factor authentication code has already been used. Please wait for the next 30-second token.',
        401
      );
    }

    // Reset failure counter on success & advance replay protection step
    MasterRepository.updateCredentials(account.UserID, {
      FailedLoginCount: 0,
      LastFailedAt: '',
      LockUntil: '',
      LastSuccessfulTotpStep: currentStep
    });

    // Consume the server-side challenge before minting a session. A later TOTP
    // cannot reuse the same 5-minute challenge to create another session.
    this._deleteMfaChallenge(userId);

    MasterRepository.updateAccount(account.UserID, {
      LastLoginAt: new Date().toISOString()
    });

    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.MFA_VERIFIED,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        step: currentStep,
        googleIdentity: googleEmail || ''
      }
    });
    MasterRepository.logSecurityEvent({
      UserID: account.UserID,
      Username: account.Username,
      EventType: CONSTANTS.AUDIT_EVENTS.LOGIN_SUCCESS,
      Success: true,
      metadata: {
        clientType: normalizedClientType,
        mfa: true,
        googleIdentity: googleEmail || ''
      }
    });

    const sessionData = SessionService.createSession(
      account.UserID,
      normalizedClientType,
      googleEmail
    );
    const accesses = MasterRepository.getWorkspaceAccessForUser(account.UserID);
    const assignedWorkspaces = accesses.map(a => a.WorkspaceID);

    return {
      sessionToken: sessionData.sessionToken,
      expiresAt: sessionData.expiresAt,
      user: {
        userId: account.UserID,
        username: account.Username,
        displayName: account.DisplayName,
        role: account.Role,
        status: account.Status,
        email: account.Email || '',
        primaryWorkspaceId: account.PrimaryWorkspaceID || assignedWorkspaces[0] || '',
        assignedWorkspaces: assignedWorkspaces,
        mustChangePassword: account.MustChangePassword === true || account.MustChangePassword === 'TRUE'
      }
    };
    } finally {
      mfaLock.releaseLock();
    }
  },

  /**
   * Enrolls authenticated user in TOTP MFA
   */
  enrollMfa(authContext) {
    const rawSecret = SecurityService.generateTotpSecret();
    const encryptedSecret = SecurityService.encryptSecret(rawSecret);

    MasterRepository.updateCredentials(authContext.userId, {
      PendingTotpSecret: encryptedSecret
    });

    const uri = `otpauth://totp/FLINK:${authContext.user.username}?secret=${rawSecret}&issuer=FLINK`;
    return {
      secret: rawSecret,
      qrUri: uri,
      message: 'Scan the QR code or enter the secret in your authenticator app, then confirm with a 6-digit code.'
    };
  },

  /**
   * Confirms TOTP MFA enrollment
   */
  confirmMfa(authContext, code) {
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred || !cred.PendingTotpSecret) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'No pending MFA enrollment found. Call enrollMfa first.');
      }

      const verification = SecurityService.verifyTotpWithStep(cred.PendingTotpSecret, code);
      if (!verification.valid) {
        throw new AppError(ERROR_CODES.AUTH_REQUIRED, 'Invalid verification code. Could not verify authenticator app.');
      }

      MasterRepository.updateCredentials(authContext.userId, {
        TotpSecret: cred.PendingTotpSecret,
        MfaEnabled: true,
        PendingTotpSecret: '',
        // Treat the enrollment code as consumed so it cannot immediately be
        // replayed as the first login MFA code in the same 30-second step.
        LastSuccessfulTotpStep: verification.timeStep
      });

      MasterRepository.logGlobalAudit({
        ActorUserID: authContext.userId,
        ActorRole: authContext.role,
        EntityType: 'USER_SECURITY',
        EntityID: authContext.userId,
        Action: CONSTANTS.AUDIT_EVENTS.MFA_ENROLLED,
        Reason: 'TOTP Multi-factor authentication successfully enabled'
      });

      return { ok: true, message: 'Two-factor authentication successfully enabled.' };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Disables MFA for a user (Super Admin only or user password confirmation)
   */
  disableMfa(superAdminContext, targetUserId) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    const targetAccount = MasterRepository.findAccountById(targetUserId);
    if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, `User ${targetUserId} not found.`);

    MasterRepository.updateCredentials(targetUserId, {
      TotpSecret: '',
      MfaEnabled: false,
      PendingTotpSecret: '',
      LastSuccessfulTotpStep: ''
    });

    MasterRepository.logGlobalAudit({
      ActorUserID: superAdminContext.userId,
      ActorRole: superAdminContext.role,
      EntityType: 'USER_SECURITY',
      EntityID: targetUserId,
      Action: CONSTANTS.AUDIT_EVENTS.MFA_DISABLED,
      Reason: 'Two-factor authentication disabled by Super Admin'
    });

    return { ok: true, message: `MFA disabled for user ${targetAccount.Username}.` };
  },

  /**
   * Changes authenticated user's password
   */
  changePassword(sessionToken, oldPassword, newPassword) {
    const authContext = SessionService.validateSession(sessionToken);
    Validation.validatePassword(newPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const cred = MasterRepository.getCredentials(authContext.userId);
      if (!cred) throw new AppError(ERROR_CODES.NOT_FOUND, 'Credentials record not found.');

      const isOldValid = SecurityService.verifyPassword(oldPassword, cred.PasswordHash);
      if (!isOldValid) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'Current password is incorrect.');
      }
      if (SecurityService.verifyPassword(newPassword, cred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'New password must be different from the current password.',
          400
        );
      }

      const newHash = SecurityService.hashPassword(newPassword);
      MasterRepository.updateCredentials(authContext.userId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(cred.PasswordVersion, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString()
      });

      MasterRepository.updateAccount(authContext.userId, {
        MustChangePassword: false,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: authContext.userId
      });

      // Invalidate all active sessions and any outstanding MFA login challenge.
      SessionService.revokeAllUserSessions(authContext.userId);
      this._deleteMfaChallenge(authContext.userId);
      const replacementClientType =
        authContext.session && authContext.session.ClientType
          ? authContext.session.ClientType
          : 'WEB';
      const newSession = SessionService.createSession(
        authContext.userId,
        replacementClientType
      );

      MasterRepository.logSecurityEvent({
        UserID: authContext.userId,
        Username: authContext.user.Username,
        EventType: CONSTANTS.AUDIT_EVENTS.PASSWORD_CHANGED,
        Success: true
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        sessionToken: newSession.sessionToken,
        expiresAt: newSession.expiresAt
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Super Admin resets a user's password
   */
  resetPasswordByAdmin(superAdminContext, targetUserId, temporaryPassword) {
    AuthorizationService.assertRole(superAdminContext, [CONSTANTS.ROLES.SUPER_ADMIN]);
    Validation.validatePassword(temporaryPassword);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const targetAccount = MasterRepository.findAccountById(targetUserId);
      if (!targetAccount) throw new AppError(ERROR_CODES.NOT_FOUND, 'Target account not found.');
      if (
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.ARCHIVED ||
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.DELETED
      ) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          'Archived or deleted accounts cannot receive a password reset.',
          409
        );
      }

      const targetCred = MasterRepository.getCredentials(targetUserId);
      if (!targetCred) {
        throw new AppError(ERROR_CODES.NOT_FOUND, 'Target credentials record not found.');
      }
      if (SecurityService.verifyPassword(temporaryPassword, targetCred.PasswordHash)) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          'Temporary password must be different from the user\'s current password.',
          400
        );
      }
      const newHash = SecurityService.hashPassword(temporaryPassword);
      const nextStatus =
        targetAccount.Status === CONSTANTS.ACCOUNT_STATUS.LOCKED
          ? CONSTANTS.ACCOUNT_STATUS.ACTIVE
          : targetAccount.Status;

      MasterRepository.updateCredentials(targetUserId, {
        PasswordHash: newHash,
        PasswordVersion: (parseInt(targetCred ? targetCred.PasswordVersion : 0, 10) || 1) + 1,
        PasswordChangedAt: new Date().toISOString(),
        FailedLoginCount: 0,
        LockUntil: ''
      });

      MasterRepository.updateAccount(targetUserId, {
        MustChangePassword: true,
        Status: nextStatus,
        UpdatedAt: new Date().toISOString(),
        UpdatedBy: superAdminContext.userId
      });

      // Password reset never serves as a PASSIVE-account activation path.
      // It also invalidates sessions and any outstanding MFA challenge.
      SessionService.revokeAllUserSessions(targetUserId);
      this._deleteMfaChallenge(targetUserId);

      MasterRepository.logGlobalAudit({
        ActorUserID: superAdminContext.userId,
        ActorRole: superAdminContext.role,
        EntityType: 'USER',
        EntityID: targetUserId,
        Action: CONSTANTS.AUDIT_EVENTS.PASSWORD_RESET,
        Reason: 'Administrative password reset'
      });

      if (typeof SpreadsheetApp !== 'undefined' && SpreadsheetApp.flush) {
        try { SpreadsheetApp.flush(); } catch (fErr) {}
      }

      return {
        ok: true,
        message: `Password reset successfully for user ${targetAccount.Username}. User will be forced to change password on next login.`
      };
    } finally {
      lock.releaseLock();
    }
  },

  /**
   * Logout user and revoke session
   */
  logout(sessionToken) {
    SessionService.revokeSession(sessionToken);
    return { ok: true };
  }
};

/* ===== TrackingPolicyService.gs ===== */
/**
 * FLINK Time & Workforce Platform — Tracking Policy Service
 * Centralizes time-tracking policy and referential-integrity checks.
 */

var TrackingPolicyService = (typeof global !== 'undefined' && global.TrackingPolicyService) || {
  _toBoolean(value, defaultValue = false) {
    if (value === true || value === 1 || value === 'TRUE' || value === 'true' || value === '1') return true;
    if (value === false || value === 0 || value === 'FALSE' || value === 'false' || value === '0') return false;
    return defaultValue;
  },

  _getBooleanSetting(key, defaultValue) {
    const raw = MasterRepository.getGlobalSetting(key, '');
    if (raw === '' || raw === null || raw === undefined) return defaultValue;
    return this._toBoolean(raw, defaultValue);
  },

  getPolicy(workspaceId) {
    const workspaceManual = MasterRepository.getGlobalSetting(`WS_${workspaceId}_ALLOW_MANUAL`, '');
    const globalManual = this._getBooleanSetting('RULE_ALLOW_MANUAL', true);

    return {
      projectRequired: this._getBooleanSetting('RULE_PROJECT_REQUIRED', false),
      taskRequired: this._getBooleanSetting('RULE_TASK_REQUIRED', false),
      descriptionRequired: this._getBooleanSetting('RULE_DESC_REQUIRED', false),
      tagsRequired: this._getBooleanSetting('RULE_TAGS_REQUIRED', false),
      allowManual: workspaceManual === '' ? globalManual : this._toBoolean(workspaceManual, globalManual),
      pastEntryEditDays: Math.max(
        0,
        parseInt(MasterRepository.getGlobalSetting('PAST_ENTRY_EDIT_DAYS', '7'), 10) || 0
      )
    };
  },

  normalizeTagIds(rawTags) {
    if (rawTags === null || rawTags === undefined || rawTags === '') return [];
    const values = Array.isArray(rawTags) ? rawTags : String(rawTags).split(',');
    return [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
  },

  getProjectAccessState(authContext, workspaceId) {
    if (authContext.role !== CONSTANTS.ROLES.USER) {
      return { aclEnabled: false, allowedProjectIds: null };
    }

    const allAssignments = SheetRepository.listAllUserProjectAccess(workspaceId);
    if (allAssignments.length === 0) {
      return { aclEnabled: false, allowedProjectIds: null };
    }

    const allowedProjectIds = new Set(
      allAssignments
        .filter(row =>
          row.UserID === authContext.userId &&
          this._toBoolean(row.CanTrack, false)
        )
        .map(row => row.ProjectID)
    );

    return { aclEnabled: true, allowedProjectIds };
  },

  assertProjectAccess(authContext, workspaceId, projectId) {
    if (!projectId || authContext.role !== CONSTANTS.ROLES.USER) return true;

    const state = this.getProjectAccessState(authContext, workspaceId);
    if (!state.aclEnabled) return true;

    if (!state.allowedProjectIds.has(projectId)) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'You are not authorized to track time against the selected project.',
        403
      );
    }
    return true;
  },

  validateTrackingContext(authContext, workspaceId, payload = {}, options = {}) {
    AuthorizationService.assertWorkspaceAccess(authContext, workspaceId);

    const policy = this.getPolicy(workspaceId);
    const isManual = options.manual === true;
    const enforceRequired = options.enforceRequired !== false;

    if (isManual && !policy.allowManual) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        'Manual time entry is disabled for this workspace.',
        403
      );
    }

    const projectId = payload.projectId ? String(payload.projectId).trim() : '';
    const taskId = payload.taskId ? String(payload.taskId).trim() : '';
    const description = payload.description
      ? Validation.sanitizeCellValue(String(payload.description).trim())
      : '';
    const tagIds = this.normalizeTagIds(
      payload.tagIds !== undefined ? payload.tagIds : payload.tags
    );

    if (enforceRequired && policy.projectRequired && !projectId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A project is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.taskRequired && !taskId) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.descriptionRequired && !description) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A description is required by the tracking policy.', 400);
    }
    if (enforceRequired && policy.tagsRequired && tagIds.length === 0) {
      throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'At least one tag is required by the tracking policy.', 400);
    }

    let project = null;
    if (projectId) {
      project = SheetRepository.getProject(workspaceId, projectId);
      if (!project) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Project ${projectId} was not found.`, 404);
      }
      if (String(project.Status || '').toUpperCase() !== 'ACTIVE') {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected project is not active.', 400);
      }
      this.assertProjectAccess(authContext, workspaceId, projectId);
    }

    let task = null;
    if (taskId) {
      if (!projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'A task cannot be selected without its project.', 400);
      }
      task = SheetRepository.getTask(workspaceId, taskId);
      if (!task) {
        throw new AppError(ERROR_CODES.NOT_FOUND, `Task ${taskId} was not found.`, 404);
      }
      if (task.ProjectID !== projectId) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task does not belong to the selected project.', 400);
      }
      const taskStatus = String(task.Status || '').toUpperCase();
      if (!['OPEN', 'ACTIVE'].includes(taskStatus)) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, 'The selected task is not open for time tracking.', 400);
      }
    }

    if (tagIds.length > 0) {
      const tags = SheetRepository.listTags(workspaceId);
      const tagMap = new Map(tags.map(tag => [tag.TagID, tag]));
      for (const tagId of tagIds) {
        const tag = tagMap.get(tagId);
        if (!tag) {
          throw new AppError(ERROR_CODES.NOT_FOUND, `Tag ${tagId} was not found.`, 404);
        }
        if (String(tag.Status || '').toUpperCase() !== 'ACTIVE') {
          throw new AppError(ERROR_CODES.VALIDATION_ERROR, `Tag ${tagId} is not active.`, 400);
        }
      }
    }

    let billable;
    if (payload.billable !== undefined) {
      billable = this._toBoolean(payload.billable, false);
    } else if (project) {
      billable = this._toBoolean(project.BillableDefault, true);
    } else {
      billable = true;
    }

    return {
      policy,
      project,
      task,
      projectId,
      taskId,
      description,
      tagIds,
      tagIdsCsv: tagIds.join(','),
      billable
    };
  },

  assertEntryEditableByAge(workspaceId, entry) {
    const policy = this.getPolicy(workspaceId);
    if (!policy.pastEntryEditDays) return true;

    const entryTime = new Date(entry.EndUTC || entry.StartUTC).getTime();
    if (isNaN(entryTime)) return true;

    const cutoff = Date.now() - policy.pastEntryEditDays * 24 * 3600 * 1000;
    if (entryTime < cutoff) {
      throw new AppError(
        ERROR_CODES.PERMISSION_DENIED,
        `This entry is older than the ${policy.pastEntryEditDays}-day edit window.`,
        403
      );
    }
    return true;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { IdentityService, SecurityService, AuthorizationService, SessionService, AuthService, TrackingPolicyService };
}

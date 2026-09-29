'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const identityPath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);
const sessionPath = path.resolve(
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

test('IdentityService reads and normalizes the server-observed Google account email', () => {
  global.AppError = AppError;
  global.ERROR_CODES = { AUTH_REQUIRED:'AUTH_REQUIRED' };
  global.Session = {
    getActiveUser() {
      return { getEmail() { return ' Worker@Example.COM '; } };
    }
  };
  delete require.cache[require.resolve(identityPath)];
  const { IdentityService } = require(identityPath);
  assert.equal(
    IdentityService.getCurrentGoogleEmail(true),
    'worker@example.com'
  );
});

test('WEB session creation stores verified Google email in existing ClientLabel field', () => {
  const created = [];
  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    SESSION_EXPIRED:'SESSION_EXPIRED',
    ACCOUNT_LOCKED:'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE:'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    LIMITS:{
      SESSION_IDLE_TIMEOUT_HOURS:8,
      SESSION_ABSOLUTE_TIMEOUT_HOURS:24,
      SESSION_TOUCH_INTERVAL_MINUTES:5
    },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', LOCKED:'LOCKED' }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    assertAccountIdentity() { return 'worker@example.com'; }
  };
  global.SecurityService = {
    generateSessionToken() { return 'TOKEN'; },
    hashToken() { return 'TOKEN-HASH'; }
  };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findAccountById() {
      return {
        UserID:'U1', Email:'worker@example.com',
        Status:'ACTIVE', Username:'worker', Role:'USER'
      };
    },
    createSession(row) { created.push({ ...row }); }
  };
  delete require.cache[require.resolve(sessionPath)];
  const { SessionService } = require(sessionPath);
  SessionService.createSession(
    'U1', 'WEB', 'worker@example.com'
  );

  assert.equal(created.length, 1);
  assert.equal(created[0].ClientType, 'WEB');
  assert.equal(created[0].ClientLabel, 'worker@example.com');
});

test('WEB session is revoked when active Google account no longer matches bound identity', () => {
  const writes = [];
  const now = Date.now();
  const session = {
    SessionID:'S1',
    UserID:'U1',
    TokenHash:'HASH',
    ClientType:'WEB',
    ClientLabel:'worker@example.com',
    CreatedAt:new Date(now-60000).toISOString(),
    LastSeenAt:new Date(now-1000).toISOString(),
    ExpiresAt:new Date(now+3600000).toISOString(),
    AbsoluteExpiresAt:new Date(now+7200000).toISOString(),
    Revoked:false
  };

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    SESSION_EXPIRED:'SESSION_EXPIRED',
    ACCOUNT_LOCKED:'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE:'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    LIMITS:{
      SESSION_IDLE_TIMEOUT_HOURS:8,
      SESSION_ABSOLUTE_TIMEOUT_HOURS:24,
      SESSION_TOUCH_INTERVAL_MINUTES:5
    },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', LOCKED:'LOCKED' }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    assertAccountIdentity() {
      throw new AppError(
        'AUTH_REQUIRED',
        'Google Workspace identity does not match',
        401
      );
    }
  };
  global.SecurityService = { hashToken() { return 'HASH'; } };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findSessionByTokenHash() { return session; },
    findAccountById() {
      return {
        UserID:'U1', Username:'worker',
        Email:'worker@example.com',
        Role:'USER', Status:'ACTIVE'
      };
    },
    updateSession(_id,patch) { writes.push({ ...patch }); }
  };

  delete require.cache[require.resolve(sessionPath)];
  const { SessionService } = require(sessionPath);

  assert.throws(
    () => SessionService.validateSession('TOKEN'),
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED'
  );
  assert.equal(writes.at(-1).Revoked, true);
  assert.equal(
    writes.at(-1).RevokeReason,
    'GOOGLE_IDENTITY_MISMATCH'
  );
});

test('legacy WEB session without bound ClientLabel fails closed', () => {
  const writes = [];
  const now = Date.now();
  const session = {
    SessionID:'S1',
    UserID:'U1',
    ClientType:'WEB',
    ClientLabel:'',
    CreatedAt:new Date(now-60000).toISOString(),
    LastSeenAt:new Date(now-1000).toISOString(),
    ExpiresAt:new Date(now+3600000).toISOString(),
    AbsoluteExpiresAt:new Date(now+7200000).toISOString()
  };
  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    SESSION_EXPIRED:'SESSION_EXPIRED',
    ACCOUNT_LOCKED:'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE:'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    LIMITS:{
      SESSION_IDLE_TIMEOUT_HOURS:8,
      SESSION_ABSOLUTE_TIMEOUT_HOURS:24,
      SESSION_TOUCH_INTERVAL_MINUTES:5
    },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', LOCKED:'LOCKED' }
  };
  global.IdentityService = {
    normalizeEmail(v) { return String(v || '').trim().toLowerCase(); },
    assertAccountIdentity() { return 'worker@example.com'; }
  };
  global.SecurityService = { hashToken() { return 'HASH'; } };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findSessionByTokenHash() { return session; },
    findAccountById() {
      return {
        UserID:'U1', Username:'worker',
        Email:'worker@example.com',
        Role:'USER', Status:'ACTIVE'
      };
    },
    updateSession(_id,patch) { writes.push({ ...patch }); }
  };
  delete require.cache[require.resolve(sessionPath)];
  const { SessionService } = require(sessionPath);
  assert.throws(
    () => SessionService.validateSession('TOKEN'),
    /Google Workspace identity changed/
  );
  assert.equal(writes.at(-1).Revoked, true);
});

test('IdentityService rejects unsupported caller-supplied authentication channels', () => {
  global.AppError = AppError;
  global.ERROR_CODES = { AUTH_REQUIRED:'AUTH_REQUIRED' };
  global.Session = {
    getActiveUser() {
      return { getEmail() { return 'worker@example.com'; } };
    }
  };
  delete require.cache[require.resolve(identityPath)];
  const { IdentityService } = require(identityPath);

  assert.throws(
    () => IdentityService.assertAccountIdentity(
      { Email:'worker@example.com' },
      'DESKTOP'
    ),
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED'
  );
  assert.throws(
    () => IdentityService.assertAccountIdentity(
      { Email:'worker@example.com' },
      'anything'
    ),
    err => err instanceof AppError &&
      err.code === 'AUTH_REQUIRED'
  );
});

test('legacy session with unsupported client type is revoked', () => {
  const writes = [];
  const now = Date.now();
  const session = {
    SessionID:'S-OLD',
    UserID:'U1',
    ClientType:'DESKTOP',
    ClientLabel:'',
    CreatedAt:new Date(now-60000).toISOString(),
    LastSeenAt:new Date(now-1000).toISOString(),
    ExpiresAt:new Date(now+3600000).toISOString(),
    AbsoluteExpiresAt:new Date(now+7200000).toISOString()
  };

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED:'AUTH_REQUIRED',
    SESSION_EXPIRED:'SESSION_EXPIRED',
    ACCOUNT_LOCKED:'ACCOUNT_LOCKED',
    ACCOUNT_PASSIVE:'ACCOUNT_PASSIVE'
  };
  global.CONSTANTS = {
    LIMITS:{
      SESSION_IDLE_TIMEOUT_HOURS:8,
      SESSION_ABSOLUTE_TIMEOUT_HOURS:24,
      SESSION_TOUCH_INTERVAL_MINUTES:5
    },
    ACCOUNT_STATUS:{ ACTIVE:'ACTIVE', LOCKED:'LOCKED' }
  };
  global.SecurityService = { hashToken() { return 'HASH'; } };
  global.Validation = { generateId() { return 'S1'; } };
  global.MasterRepository = {
    findSessionByTokenHash() { return session; },
    findAccountById() {
      return {
        UserID:'U1', Username:'worker',
        Email:'worker@example.com',
        Role:'USER', Status:'ACTIVE'
      };
    },
    updateSession(_id,patch) { writes.push({ ...patch }); }
  };
  delete require.cache[require.resolve(sessionPath)];
  const { SessionService } = require(sessionPath);

  assert.throws(
    () => SessionService.validateSession('TOKEN'),
    err => err instanceof AppError && err.code === 'AUTH_REQUIRED'
  );
  assert.equal(writes.at(-1).Revoked, true);
  assert.equal(writes.at(-1).RevokeReason, 'UNSUPPORTED_CLIENT_TYPE');
});

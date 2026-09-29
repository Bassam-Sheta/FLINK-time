'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(
  __dirname,
  '../apps-script/Admin.gs'
);

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture({ lockThrows = false } = {}) {
  const accounts = [];
  const props = new Map([
    ['FLINK_SETUP_KEY_HASH', 'SETUP-HASH'],
    ['FLINK_SETUP_KEY_CREATED_AT', '2026-09-28T00:00:00.000Z']
  ]);
  let lockAcquireCalls = 0;
  let createAccountCalls = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    CONFLICT: 'CONFLICT'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN' },
    ACCOUNT_STATUS: { ACTIVE: 'ACTIVE', DELETED: 'DELETED' },
    MASTER_TABS: { ACCOUNTS: 'Accounts' },
    AUDIT_EVENTS: { USER_CREATED: 'USER_CREATED' }
  };
  global.Validation = {
    assertRequired(obj, names) {
      for (const name of names) {
        if (!obj[name]) throw new AppError('VALIDATION_ERROR', name + ' required');
      }
    },
    validatePassword(value) { return value; },
    generateId() { return 'USR-ROOT'; }
  };
  global.IdentityService = {
    getCurrentGoogleEmail() { return 'root@example.com'; }
  };
  global.SecurityService = {
    hashToken(value) {
      return value === 'one-time-key' ? 'SETUP-HASH' : 'BAD-HASH';
    },
    constantTimeEquals(a, b) { return a === b; },
    hashPassword() { return 'PASSWORD-HASH'; }
  };
  global.MigrationService = { bootstrapMasterSheet() {} };
  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) { return props.get(key) || ''; },
        deleteProperty(key) { props.delete(key); }
      };
    }
  };
  global.MasterRepository = {
    getTableData(tab) {
      assert.equal(tab, 'Accounts');
      return { rows: accounts };
    },
    createAccount(account) {
      createAccountCalls += 1;
      accounts.push({ ...account });
    },
    logGlobalAudit() {}
  };
  global.SessionService = {
    createSession() { return { sessionToken: 'SESSION' }; }
  };
  global.LockService = {
    getScriptLock() {
      return {
        waitLock() {
          lockAcquireCalls += 1;
          if (lockThrows) throw new Error('LOCK_BUSY');
        },
        releaseLock() {}
      };
    }
  };

  delete require.cache[require.resolve(servicePath)];
  return {
    SetupService: require(servicePath).SetupService,
    accounts,
    props,
    getLockAcquireCalls: () => lockAcquireCalls,
    getCreateAccountCalls: () => createAccountCalls
  };
}

const payload = {
  setupKey: 'one-time-key',
  fullName: 'Root Admin',
  username: 'root',
  password: 'StrongPass123!',
  confirmPassword: 'StrongPass123!'
};

test('first-run root creation acquires exactly one script lock', () => {
  const fx = fixture();
  const result = fx.SetupService.processStep(1, payload, null);

  assert.equal(result.ok, true);
  assert.equal(fx.getLockAcquireCalls(), 1);
  assert.equal(fx.getCreateAccountCalls(), 1);
  assert.equal(fx.accounts.length, 1);
});

test('second root creation cannot succeed after the first consumes setup state', () => {
  const fx = fixture();
  fx.SetupService.processStep(1, payload, null);

  assert.throws(
    () => fx.SetupService.processStep(1, payload, null),
    err => err instanceof AppError &&
      ['AUTH_REQUIRED', 'CONFLICT'].includes(err.code)
  );

  assert.equal(fx.getCreateAccountCalls(), 1);
  assert.equal(fx.accounts.length, 1);
});

test('root account is not created when installation lock cannot be acquired', () => {
  const fx = fixture({ lockThrows: true });

  assert.throws(
    () => fx.SetupService.processStep(1, payload, null),
    /LOCK_BUSY/
  );
  assert.equal(fx.getCreateAccountCalls(), 0);
  assert.equal(fx.accounts.length, 0);
});

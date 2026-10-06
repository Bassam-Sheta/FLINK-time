'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
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

function fixture({ lockThrows = false, ownerThrows = false } = {}) {
  const accounts = [];
  const props = new Map();
  let lockAcquireCalls = 0;
  let createAccountCalls = 0;
  let bootstrapCalls = 0;
  let ownerChecks = 0;

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    UNAUTHORIZED: 'UNAUTHORIZED',
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
    assertInstallationOwner() {
      ownerChecks += 1;
      if (ownerThrows) throw new AppError('UNAUTHORIZED', 'OWNER_MISMATCH', 403);
      return 'root@example.com';
    }
  };
  global.SecurityService = {
    hashPassword() { return 'PASSWORD-HASH'; }
  };
  global.MigrationService = {
    bootstrapMasterSheet() { bootstrapCalls += 1; }
  };
  global.PropertiesService = {
    getScriptProperties() {
      return {
        getProperty(key) { return props.get(key) || ''; },
        deleteProperty(key) { props.delete(key); }
      };
    }
  };
  global.MasterRepository = {
    getGlobalSetting() { return 'false'; },
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
    getCreateAccountCalls: () => createAccountCalls,
    getBootstrapCalls: () => bootstrapCalls,
    getOwnerChecks: () => ownerChecks
  };
}

const payload = {
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
  assert.equal(fx.getOwnerChecks(), 1);
  assert.equal(fx.getBootstrapCalls(), 1);
  assert.equal(fx.getCreateAccountCalls(), 1);
  assert.equal(fx.accounts.length, 1);
});

test('second root creation cannot succeed after the first root exists', () => {
  const fx = fixture();
  fx.SetupService.processStep(1, payload, null);

  assert.throws(
    () => fx.SetupService.processStep(1, payload, null),
    err => err instanceof AppError && err.code === 'CONFLICT'
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
  assert.equal(fx.getOwnerChecks(), 0);
  assert.equal(fx.getBootstrapCalls(), 0);
  assert.equal(fx.getCreateAccountCalls(), 0);
});

test('owner mismatch fails before schema or account mutation', () => {
  const fx = fixture({ ownerThrows: true });

  assert.throws(
    () => fx.SetupService.processStep(1, payload, null),
    /OWNER_MISMATCH/
  );
  assert.equal(fx.getOwnerChecks(), 1);
  assert.equal(fx.getBootstrapCalls(), 0);
  assert.equal(fx.getCreateAccountCalls(), 0);
});

test('root creation rejects invalid username length or characters', () => {
  const fx = fixture();

  assert.throws(
    () => fx.SetupService.processStep(1, { ...payload, username: 'ab' }, null),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR' && /Username must be between 3 and 50/.test(err.message)
  );

  assert.throws(
    () => fx.SetupService.processStep(1, { ...payload, username: 'invalid user!' }, null),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );
  assert.equal(fx.getCreateAccountCalls(), 0);
});

test('root creation rejects invalid full name bounds', () => {
  const fx = fixture();

  assert.throws(
    () => fx.SetupService.processStep(1, { ...payload, fullName: '   ' }, null),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR' && /Full name must be between 1 and 100/.test(err.message)
  );

  assert.throws(
    () => fx.SetupService.processStep(1, { ...payload, fullName: 'x'.repeat(105) }, null),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR' && /Full name must be between 1 and 100/.test(err.message)
  );
  assert.equal(fx.getCreateAccountCalls(), 0);
});

test('root creation rejects duplicate email if account already exists', () => {
  const fx = fixture();
  global.MasterRepository.findAccountByEmail = email => {
    if (email === 'root@example.com') return { UserID: 'USR-OLD', Email: 'root@example.com' };
    return null;
  };

  assert.throws(
    () => fx.SetupService.processStep(1, payload, null),
    err => err instanceof AppError && err.code === 'CONFLICT' && /account with this email already exists/.test(err.message)
  );
  assert.equal(fx.getCreateAccountCalls(), 0);
});

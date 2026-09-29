'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appPath = path.resolve(__dirname, '../apps-script/Code.gs');

class AppError extends Error {
  constructor(code, message, statusCode = 400, details = null) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
  toJSON() {
    return { ok: false, error: { code: this.code, message: this.message, statusCode: this.statusCode, details: this.details } };
  }
}

function baseGlobals() {
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' }
  };
  global.ERROR_CODES = {
    NOT_FOUND: 'NOT_FOUND',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    INTERNAL_ERROR: 'INTERNAL_ERROR',
    PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
    UNAUTHORIZED: 'UNAUTHORIZED'
  };
  global.AppError = AppError;
}

function loadFresh(extra = {}) {
  baseGlobals();
  delete global.SessionService;
  delete global.AuthService;
  delete global.SetupService;
  Object.assign(global, extra);
  delete require.cache[require.resolve(appPath)];
  return require(appPath);
}

const base = loadFresh();
const {
  ACTION_PERMISSIONS,
  PUBLIC_ACTIONS,
  GET_SAFE_ACTIONS,
  isHttpMethodAllowed
} = base;

test('permission matrix and dispatcher action inventory stay in exact parity', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const start = source.indexOf('function dispatchAction_(');
  const end = source.indexOf('\n/**\n * Builds ContentService JSON HTTP response', start);
  assert.ok(start >= 0 && end > start, 'dispatchAction source boundaries must exist');
  const dispatcherSource = source.slice(start, end);

  const caseActions = [...dispatcherSource.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1]);
  const handled = new Set([...caseActions, ...PUBLIC_ACTIONS]);
  const declared = Object.keys(ACTION_PERMISSIONS);

  const declaredButUnhandled = declared.filter(action => !handled.has(action));
  const handledButUndeclared = [...new Set(caseActions)].filter(action => !ACTION_PERMISSIONS[action]);

  assert.deepEqual(declaredButUnhandled, [], 'every declared action must have a dispatcher/public handler');
  assert.deepEqual(handledButUndeclared, [], 'every dispatcher case must be declared in ACTION_PERMISSIONS');
  assert.equal(new Set(caseActions).size, caseActions.length, 'dispatcher action cases must be unique');
});

test('Apps Script browser RPC surface is explicit and cannot bypass session authorization', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const topLevelFunctions = [...source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)]
    .map(match => match[1]);
  const browserCallable = topLevelFunctions.filter(name => !name.endsWith('_'));

  assert.deepEqual(
    browserCallable,
    ['doGet', 'doPost', 'handleClientRequest'],
    'only the required web entrypoints and authenticated client bridge may be browser-callable'
  );

  assert.match(source, /function dispatchAction_\(action, data\)/);
  assert.doesNotMatch(source, /authContextOverride/);
  assert.match(source, /const authContext = SessionService\.validateSession\(token\);/);

  assert.match(source, /function initializeInstallation_\(\)/);
  assert.equal(source.includes('function initializeInstallation()'), false);

  for (const removed of [
    'saveScreenshotToMasterVault',
    'runMasterVaultRetention',
    'getOrCreateMasterVault',
    'getOrCreateSubFolder'
  ]) {
    assert.equal(source.includes(removed), false, removed + ' must not be present');
  }

  assert.match(source, /handler: 'scheduledHousekeeping_'/);
  assert.match(source, /handler: 'scheduledRollups_'/);
});

test('every action has explicit security/mutation metadata', () => {
  for (const [action, perm] of Object.entries(ACTION_PERMISSIONS)) {
    assert.equal(typeof perm.authRequired, 'boolean', action + ' must declare authRequired');
    assert.equal(typeof perm.isWrite, 'boolean', action + ' must declare isWrite');
    if (perm.authRequired) {
      assert.ok(Array.isArray(perm.roles) && perm.roles.length > 0, action + ' must declare roles');
    }
    if (perm.requiresWorkspace !== undefined) {
      assert.equal(typeof perm.requiresWorkspace, 'boolean', action + ' requiresWorkspace must be boolean');
    }
  }
});

test('API GET allowlist is explicit and keeps authenticated tokens out of URLs', () => {
  assert.deepEqual([...GET_SAFE_ACTIONS].sort(), ['setup.status']);

  for (const action of Object.keys(ACTION_PERMISSIONS)) {
    assert.equal(isHttpMethodAllowed(action, 'POST'), true, action + ' must accept POST');
    assert.equal(
      isHttpMethodAllowed(action, 'GET'),
      action === 'setup.status',
      action + ' GET policy mismatch'
    );
    assert.equal(isHttpMethodAllowed(action, 'PUT'), false, action + ' must reject PUT');
    assert.equal(isHttpMethodAllowed(action, 'DELETE'), false, action + ' must reject DELETE');
  }
  assert.equal(isHttpMethodAllowed('unknown.action', 'POST'), false);
});

test('endpoints with hidden writes are classified as mutations', () => {
  assert.equal(ACTION_PERMISSIONS['reports.exportCsv'].isWrite, true);
  assert.equal(ACTION_PERMISSIONS['system.health'].isWrite, true);
  assert.equal(ACTION_PERMISSIONS['integrity.audit'].isWrite, true);
});

test('public action allowlist exactly matches authRequired:false declarations', () => {
  const declaredPublic = Object.entries(ACTION_PERMISSIONS)
    .filter(([, perm]) => perm.authRequired === false)
    .map(([action]) => action)
    .sort();

  assert.deepEqual([...PUBLIC_ACTIONS].sort(), declaredPublic);
  assert.deepEqual(declaredPublic, ['auth.login', 'auth.verifyMfa', 'setup.status']);
});

test('only setup.completeStep may use the controlled unauthenticated step-1 exception', () => {
  const exceptions = Object.entries(ACTION_PERMISSIONS)
    .filter(([, perm]) => perm.allowUnauthStep1 === true)
    .map(([action]) => action);
  assert.deepEqual(exceptions, ['setup.completeStep']);
});

test('public actions bypass session validation, while every other action fails closed without a session', () => {
  let sessionCalls = 0;
  const mod = loadFresh({
    SessionService: {
      validateSession() {
        sessionCalls += 1;
        throw new Error('NO_SESSION');
      }
    },
    AuthService: {
      login() { return { route: 'login' }; },
      verifyMfa() { return { route: 'mfa' }; }
    },
    SetupService: {
      getSetupStatus() { return { route: 'setup-status' }; },
      processStep() { return { route: 'setup-step' }; }
    }
  });

  assert.deepEqual(mod.dispatchAction('auth.login', { username: 'u', password: 'p' }), { route: 'login' });
  assert.deepEqual(mod.dispatchAction('auth.verifyMfa', { mfaChallengeToken: 'c', code: '123456' }), { route: 'mfa' });
  assert.deepEqual(mod.dispatchAction('setup.status', {}), { route: 'setup-status' });
  assert.equal(sessionCalls, 0);

  for (const [action, perm] of Object.entries(mod.ACTION_PERMISSIONS)) {
    if (!perm.authRequired) continue;
    assert.throws(() => mod.dispatchAction(action, {}), /NO_SESSION/, action);
  }
});

test('unauthenticated setup step 1 is controlled by permission metadata, not a hard-coded bypass', () => {
  let sessionCalls = 0;
  let setupCalls = 0;
  const mod = loadFresh({
    SessionService: {
      validateSession() {
        sessionCalls += 1;
        throw new Error('NO_SESSION');
      }
    },
    SetupService: {
      processStep(step, payload, authContext) {
        setupCalls += 1;
        assert.equal(step, 1);
        assert.equal(authContext, null);
        return { ok: true, bootstrap: true };
      },
      getSetupStatus() { return {}; }
    },
    AuthService: {
      login() { return {}; },
      verifyMfa() { return {}; }
    }
  });

  assert.deepEqual(
    mod.dispatchAction('setup.completeStep', { step: 1, setupKey: 'one-time-key' }),
    { ok: true, bootstrap: true }
  );
  assert.equal(setupCalls, 1);
  assert.equal(sessionCalls, 0);

  const original = mod.ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1;
  mod.ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1 = false;
  try {
    assert.throws(
      () => mod.dispatchAction('setup.completeStep', { step: 1, setupKey: 'one-time-key' }),
      /NO_SESSION/
    );
    assert.equal(sessionCalls, 1);
  } finally {
    mod.ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1 = original;
  }
});

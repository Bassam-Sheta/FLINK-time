'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appPath = path.resolve(__dirname, '../RELEASE_PACKAGE/3_GOOGLE_BACKEND_SCRIPTS/App.gs');

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

delete require.cache[require.resolve(appPath)];
const {
  ACTION_PERMISSIONS,
  PUBLIC_ACTIONS,
  GET_SAFE_ACTIONS,
  isHttpMethodAllowed,
  dispatchAction
} = require(appPath);

test('permission matrix and dispatcher action inventory stay in exact parity', () => {
  const source = fs.readFileSync(appPath, 'utf8');
  const caseActions = [...source.matchAll(/case\s+'([^']+)'\s*:/g)].map(m => m[1]);
  const handled = new Set([...caseActions, ...PUBLIC_ACTIONS]);
  const declared = Object.keys(ACTION_PERMISSIONS);

  const declaredButUnhandled = declared.filter(action => !handled.has(action));
  const handledButUndeclared = [...new Set(caseActions)].filter(action => !ACTION_PERMISSIONS[action]);

  assert.deepEqual(declaredButUnhandled, [], 'every declared action must have a dispatcher/public handler');
  assert.deepEqual(handledButUndeclared, [], 'every dispatcher case must be declared in ACTION_PERMISSIONS');
  assert.equal(new Set(caseActions).size, caseActions.length, 'dispatcher action cases must be unique');
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
  assert.equal(ACTION_PERMISSIONS['reports.exportCsv'].isWrite, true, 'CSV export writes an audit event');
  assert.equal(ACTION_PERMISSIONS['system.health'].isWrite, true, 'health step may create backup/setup state');
  assert.equal(ACTION_PERMISSIONS['integrity.audit'].isWrite, true, 'integrity audit writes health history');
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
  global.SessionService = {
    validateSession() {
      sessionCalls += 1;
      throw new Error('NO_SESSION');
    }
  };
  global.AuthService = {
    login() { return { route: 'login' }; },
    verifyMfa() { return { route: 'mfa' }; }
  };
  global.SetupService = {
    getSetupStatus() { return { route: 'setup-status' }; },
    processStep() { return { route: 'setup-step' }; }
  };

  assert.deepEqual(dispatchAction('auth.login', { username: 'u', password: 'p' }), { route: 'login' });
  assert.deepEqual(dispatchAction('auth.verifyMfa', { mfaChallengeToken: 'c', code: '123456' }), { route: 'mfa' });
  assert.deepEqual(dispatchAction('setup.status', {}), { route: 'setup-status' });
  assert.equal(sessionCalls, 0, 'public actions must not touch SessionService');

  for (const [action, perm] of Object.entries(ACTION_PERMISSIONS)) {
    if (!perm.authRequired) continue;
    assert.throws(
      () => dispatchAction(action, {}),
      /NO_SESSION/,
      action + ' must require a valid session when no explicit bootstrap exception applies'
    );
  }
});

test('unauthenticated setup step 1 is controlled by permission metadata, not a hard-coded bypass', () => {
  let sessionCalls = 0;
  let setupCalls = 0;
  global.SessionService = {
    validateSession() {
      sessionCalls += 1;
      throw new Error('NO_SESSION');
    }
  };
  global.SetupService = {
    processStep(step, payload, authContext) {
      setupCalls += 1;
      assert.equal(step, 1);
      assert.equal(authContext, null);
      return { ok: true, bootstrap: true };
    }
  };

  assert.deepEqual(
    dispatchAction('setup.completeStep', { step: 1, setupKey: 'one-time-key' }),
    { ok: true, bootstrap: true }
  );
  assert.equal(setupCalls, 1);
  assert.equal(sessionCalls, 0);

  const original = ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1;
  ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1 = false;
  try {
    assert.throws(
      () => dispatchAction('setup.completeStep', { step: 1, setupKey: 'one-time-key' }),
      /NO_SESSION/
    );
    assert.equal(sessionCalls, 1);
  } finally {
    ACTION_PERMISSIONS['setup.completeStep'].allowUnauthStep1 = original;
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const App = require(path.resolve(__dirname, '../apps-script/Code.gs'));

test('inherited property names are never treated as API actions', () => {
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'isPrototypeOf']) {
    assert.equal(App.getActionPermission(name), null, name);
    assert.equal(App.isHttpMethodAllowed(name, 'POST'), false, name);
    const res = App.executeApiRequest(name, { sessionToken: 'x' }, 'POST');
    assert.equal(res.ok, false, name);
    assert.equal(res.error.statusCode, 404, name);
  }
});

test('non-string actions are rejected as unknown', () => {
  for (const bad of [undefined, null, 0, {}, [], ['auth.login']]) {
    assert.equal(App.getActionPermission(bad), null);
    assert.equal(App.executeApiRequest(bad, {}, 'POST').error.statusCode, 404);
  }
});

test('every real action still resolves to its own permission entry', () => {
  const actions = Object.keys(App.ACTION_PERMISSIONS);
  assert.ok(actions.length > 50);
  for (const action of actions) {
    assert.equal(App.getActionPermission(action), App.ACTION_PERMISSIONS[action], action);
  }
});

test('a malformed request body is a 400 client error, not an internal 500', () => {
  for (const bad of ['text', 42, true, ['a']]) {
    const res = App.executeApiRequest('auth.validateSession', bad, 'POST');
    assert.equal(res.ok, false);
    assert.equal(res.error.statusCode, 400);
    assert.equal(res.error.code, 'VALIDATION_ERROR');
  }
});

test('null or missing body is treated as an empty object and still needs a session', () => {
  for (const empty of [null, undefined]) {
    const res = App.executeApiRequest('auth.validateSession', empty, 'POST');
    assert.equal(res.ok, false);
    assert.notEqual(res.error.statusCode, 500);
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const appPath = path.resolve(
  __dirname,
  '../apps-script/Code.gs'
);

test('report action permissions expose only safe USER report endpoints', () => {
  global.CONSTANTS = {
    ROLES:{ USER:'USER', ADMIN:'ADMIN', SUPER_ADMIN:'SUPER_ADMIN' }
  };
  delete require.cache[require.resolve(appPath)];
  const { ACTION_PERMISSIONS } = require(appPath);

  const user = 'USER';
  assert.equal(
    ACTION_PERMISSIONS['reports.summary'].roles.includes(user),
    true
  );
  assert.equal(
    ACTION_PERMISSIONS['reports.detailed'].roles.includes(user),
    true
  );
  assert.equal(
    ACTION_PERMISSIONS['reports.attendance'].roles.includes(user),
    false
  );
  assert.equal(
    ACTION_PERMISSIONS['reports.exceptions'].roles.includes(user),
    false
  );
  assert.equal(
    ACTION_PERMISSIONS['reports.exportCsv'].roles.includes(user),
    false
  );

  for (const action of [
    'reports.summary',
    'reports.detailed',
    'reports.attendance',
    'reports.exceptions',
    'reports.exportCsv'
  ]) {
    assert.equal(
      ACTION_PERMISSIONS[action].requiresWorkspace,
      true,
      action + ' must always be workspace-bound'
    );
  }
});

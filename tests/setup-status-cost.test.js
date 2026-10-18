'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setupStatusFixture } = require('./helpers/setup-status-fixture');

// setup.status is the first unauthenticated call a portal makes on page load, so
// its cost must not grow with master tables it does not need to answer with.

test('completed setup status transfers a bounded, table-size-independent payload', () => {
  const small = setupStatusFixture({ accountRows: 10 });
  const large = setupStatusFixture({ accountRows: 5000 });

  const smallStatus = small.getStatus();
  const largeStatus = large.getStatus();

  assert.deepEqual(smallStatus, { initialized: true, setupComplete: true });
  assert.deepEqual(largeStatus, smallStatus);

  assert.equal(
    large.transfer.cells,
    small.transfer.cells,
    'transferred cells must not grow with the Accounts table'
  );
  assert.ok(small.transfer.cells <= 200, `expected a bounded transfer, got ${small.transfer.cells} cells`);
});

test('incomplete setup status never scans the growing Accounts table', () => {
  const fx = setupStatusFixture({ accountRows: 5000, setupFlag: 'false' });

  assert.deepEqual(fx.getStatus(), {
    initialized: false,
    setupComplete: false,
    setupRequired: true
  });
  assert.ok(!fx.transfer.fullTableReads.includes('Accounts'), 'Accounts must not be scanned');
  assert.ok(!fx.transfer.fullTableReads.includes('Workspaces'), 'Workspaces must not be scanned');
});

test('completed flag still requires a live super admin and a non-archived workspace', () => {
  assert.deepEqual(setupStatusFixture({ superAdminStatus: 'DELETED' }).getStatus(), {
    initialized: false,
    setupComplete: false,
    setupRequired: true
  });
  assert.deepEqual(setupStatusFixture({ includeSuperAdmin: false }).getStatus(), {
    initialized: false,
    setupComplete: false,
    setupRequired: true
  });
  assert.deepEqual(setupStatusFixture({ workspaceStatus: 'ARCHIVED' }).getStatus(), {
    initialized: false,
    setupComplete: false,
    setupRequired: true
  });
});

test('completed setup status never exposes account, workspace or company metadata', () => {
  const status = setupStatusFixture({ accountRows: 5000 }).getStatus();

  assert.deepEqual(Object.keys(status).sort(), ['initialized', 'setupComplete']);
});

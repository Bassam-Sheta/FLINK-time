'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { renderPortal } = require('./helpers/portal-template');
const { mfaFixture } = require('./helpers/mfa-fixture');
const release = require('./fixtures/installer-pinned-release.json');
const root = path.resolve(__dirname, '..');
const portal = fs.readFileSync(path.join(root, 'apps-script/Portal.html'), 'utf8');

test('installer loads the approved pinned release without requesting nonexistent files', () => {
  const fetched = [];
  const context = vm.createContext({ UrlFetchApp: { fetch(url) {
    const prefix = 'https://raw.githubusercontent.com/Bassam-Sheta/FLINK-time/' + release.commit + '/';
    assert.ok(url.startsWith(prefix), 'the approved pin must not advance');
    const file = release.files.find(item => item.path === url.slice(prefix.length));
    fetched.push(url.slice(prefix.length));
    return {
      getResponseCode: () => file ? 200 : 404,
      getContentText: () => file?.name === 'Code'
        ? "const book = '__FLINK_INSTALLER_MASTER_SPREADSHEET_ID__'; const owner = '__FLINK_INSTALLER_OWNER_EMAIL__';"
        : '<html>synthetic pinned release</html>'
    };
  } } });
  vm.runInContext(fs.readFileSync(path.join(root, 'installer/Code.gs'), 'utf8'), context);
  const files = context.loadReleaseFiles_('SYNTHETIC_MASTER', 'owner@example.test');
  assert.deepEqual(fetched, release.files.map(file => file.path));
  assert.deepEqual(Array.from(files, file => file.name), release.files.map(file => file.name));
  assert.match(files[0].source, /SYNTHETIC_MASTER/);
  assert.doesNotMatch(files[0].source, /__FLINK_INSTALLER_/);
});

for (const view of ['user', 'admin', 'superadmin']) {
  test(view + ' clock starts, advances and replaces an existing interval', () => {
    const html = renderPortal(portal, { portalView: view });
    const from = html.indexOf('function startLocalClock(');
    const to = html.indexOf('function applyTimerCooldown(', from);
    const clock = { innerText: '', classList: { add() {} } };
    const state = {};
    let now = Date.parse('2026-10-20T12:00:00Z');
    class ClockDate extends Date { static now() { return now; } }
    const callbacks = [];
    const cleared = [];
    const context = vm.createContext({ state, Date: ClockDate,
      document: { getElementById: () => clock, addEventListener() {} },
      window: { addEventListener() {} },
      setInterval(fn) { callbacks.push(fn); return callbacks.length; },
      clearInterval: id => cleared.push(id)
    });
    vm.runInContext(html.slice(from, to), context);
    assert.doesNotThrow(() => context.startLocalClock('2026-10-20T10:58:59Z'));
    assert.equal(clock.innerText, '01:01:01');
    now += 2000;
    callbacks[0]();
    assert.equal(clock.innerText, '01:01:03');
    context.startLocalClock('2026-10-20T12:00:00Z');
    assert.deepEqual(cleared, [1]);
    assert.equal(clock.innerText, '00:00:02');
  });
}

function entryFixture() {
  const fx = mfaFixture();
  const entries = {
    E1: { EntryID: 'E1', UserID: 'U1', Version: 3, Status: 'ACTIVE', ApprovalStatus: 'OPEN', Locked: false },
    E2: { EntryID: 'E2', UserID: 'U2', Version: 7, Status: 'ACTIVE', ApprovalStatus: 'OPEN', Locked: false }
  };
  fx.context.AuthorizationService.assertWorkspaceAccess = (_auth, id) => {
    if (id !== 'W1') throw new Error('Denied workspace');
  };
  fx.context.SheetRepository.getEntry = (_ws, id) => entries[id] || null;
  fx.context.SheetRepository.getTableData = () => { throw new Error('Unbounded entry scan'); };
  fx.context.SheetRepository.updateTimeEntry = (_ws, id, updates) => Object.assign(entries[id], updates);
  fx.context.SheetRepository.logWorkspaceAudit = () => true;
  fx.context.RollupService.rebuildRollups = () => {};
  return { ...fx, entries };
}

test('bounded ID entry lookup retains ownership and workspace checks without scanning', () => {
  const fx = entryFixture();
  const result = fx.context.TimeEntryService.listEntries({ userId: 'U1', role: 'USER' }, 'W1', { entryIds: ['E1', 'E2'] });
  assert.deepEqual(Array.from(result, row => row.entryId), ['E1']);
  assert.equal(result[0].version, 3);
  assert.throws(() => fx.context.TimeEntryService.listEntries({ role: 'SUPER_ADMIN' }, 'W2', { entryIds: ['E1'] }), /Denied workspace/);
});

test('ID entry lookup rejects malformed, duplicate and oversized requests before reading', () => {
  for (const entryIds of [null, 'E1', [], ['E1', 'E1'], [''], [1], Array.from({ length: 101 }, (_, i) => 'E' + i)]) {
    const fx = entryFixture();
    assert.throws(() => fx.context.TimeEntryService.listEntries({ role: 'SUPER_ADMIN' }, 'W1', { entryIds }), error => error.code === 'VALIDATION_ERROR');
  }
});

function bulkGui(fx, { ids = 'E1, E2', rawParams = '', confirm = () => true } = {}) {
  const html = renderPortal(portal, { portalView: 'superadmin' });
  const from = html.indexOf('async function runBulkEntryAction()');
  const to = html.indexOf('/* Fallback subtab handlers */', from);
  const fields = { bulkEntryIds: ids, bulkEntryAction: 'LOCK', bulkEntryParams: rawParams };
  const calls = [];
  const alerts = [];
  const admin = { userId: 'SA1', role: 'SUPER_ADMIN' };
  const context = vm.createContext({
    state: { currentWorkspace: 'W1' },
    document: { getElementById: id => ({ value: fields[id] }) },
    confirm: () => confirm(context), alert: text => alerts.push(text),
    apiCall: async (action, payload, workspaceId) => {
      calls.push({ action, payload, workspaceId });
      assert.equal(action, 'entries.list');
      return fx.context.TimeEntryService.listEntries(admin, workspaceId, payload.filters);
    },
    runDiagnosticsAction: async (action, _elementId, payload, workspaceId = 'W1') => {
      calls.push({ action, payload, workspaceId });
      assert.equal(action, 'entries.bulkAction');
      return fx.context.TimeEntryService.bulkAction(admin, workspaceId, payload.entryIds, payload.actionType, payload.params);
    }
  });
  vm.runInContext(html.slice(from, to), context);
  return { run: () => context.runBulkEntryAction(), calls, alerts };
}

test('bulk GUI obtains current versions and executes against the real service contract', async () => {
  const fx = entryFixture();
  const gui = bulkGui(fx);
  await gui.run();
  assert.deepEqual(gui.alerts, []);
  assert.deepEqual(gui.calls.map(call => call.action), ['entries.list', 'entries.bulkAction']);
  assert.equal(gui.calls[1].payload.params.expectedVersions.E1, 3);
  assert.equal(gui.calls[1].payload.params.expectedVersions.E2, 7);
  assert.equal(fx.entries.E1.Locked, true);
  assert.equal(fx.entries.E2.Locked, true);
});

test('bulk GUI does not mutate when a requested entry is missing', async () => {
  const fx = entryFixture();
  const gui = bulkGui(fx, { ids: 'E1, MISSING' });
  await gui.run();
  assert.equal(gui.calls.some(call => call.action === 'entries.bulkAction'), false);
  assert.equal(fx.entries.E1.Locked, false);
  assert.ok(gui.alerts.length);
});

test('bulk GUI preserves stale-version protection between preview and mutation', async () => {
  const fx = entryFixture();
  const gui = bulkGui(fx, { confirm() { fx.entries.E2.Version++; return true; } });
  await gui.run();
  assert.equal(fx.entries.E1.Locked, false);
  assert.equal(fx.entries.E2.Locked, false);
  assert.ok(gui.alerts.some(text => /version|modified|conflict/i.test(text)));
});

test('bulk GUI rejects invalid parameter shapes and duplicate IDs without RPC', async () => {
  for (const options of [{ rawParams: 'null' }, { rawParams: '[]' }, { ids: 'E1, E1' }]) {
    const gui = bulkGui(entryFixture(), options);
    await gui.run();
    assert.deepEqual(gui.calls, []);
    assert.ok(gui.alerts.length);
  }
});

test('bulk GUI keeps its original workspace even if selection changes after preview', async () => {
  const fx = entryFixture();
  const gui = bulkGui(fx, { confirm(context) { context.state.currentWorkspace = 'W2'; return true; } });
  await gui.run();
  assert.ok(gui.calls.every(call => call.workspaceId === 'W1'));
});

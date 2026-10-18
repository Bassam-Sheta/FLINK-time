'use strict';

/**
 * The GUI must control everything the server can do.
 *
 * Two defects motivated these tests:
 *   1. Fourteen declared actions had no control anywhere in the page, so real
 *      capabilities (timesheet reopen, audit chain tools, jobs, master data)
 *      were unreachable for the Super Admin.
 *   2. The page's own privileged-action list had drifted from the server's, so
 *      `settings.patch`, `backups.prune` and `jobs.dispatchBackups` were called
 *      without the step-up token the server demands and were rejected with 403.
 *
 * The only action allowed to stay uncontrollable is `auth.disableMfa`, because
 * mandatory MFA can never be switched off from the UI.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appDir = path.resolve(__dirname, '../apps-script');
const codePath = path.join(appDir, 'Code.gs');
const portalPath = path.join(appDir, 'Portal.html');

const NO_CONTROL_BY_DESIGN = ['auth.disableMfa'];

function readCode() {
  return fs.readFileSync(codePath, 'utf8').replace(/\r\n?/g, '\n');
}

function readPortal() {
  return fs.readFileSync(portalPath, 'utf8').replace(/\r\n?/g, '\n');
}

function declaredActions(code) {
  const start = code.indexOf('const ACTION_PERMISSIONS = {');
  assert.ok(start > 0, 'ACTION_PERMISSIONS must exist');
  const end = code.indexOf('\n};', start);
  assert.ok(end > start, 'ACTION_PERMISSIONS must be terminated');
  return [...code.slice(start, end).matchAll(/^  '([^']+)':\s*\{/gm)].map(match => match[1]);
}

function readActionSet(source, name) {
  const start = source.indexOf('const ' + name + ' = new Set([');
  assert.ok(start > 0, name + ' must exist');
  const end = source.indexOf(']);', start);
  assert.ok(end > start, name + ' must be terminated');
  return [...source.slice(start, end).matchAll(/'([^']+)'/g)].map(match => match[1]);
}

// The shipped page minus its own privileged-action list. Whatever action names
// remain are the ones a Super Admin can actually click.
function guiBody(portal) {
  const start = portal.indexOf('const PRIVILEGED_STEP_UP_ACTIONS = new Set([');
  assert.ok(start > 0, 'the portal must declare its privileged action list');
  const end = portal.indexOf(']);', start) + 3;
  return portal.slice(0, start) + portal.slice(end);
}

test('every server action the app declares has a control in the shipped page', () => {
  const actions = declaredActions(readCode());
  assert.ok(actions.length > 80, 'expected the full action inventory, found ' + actions.length);

  const body = guiBody(readPortal());
  const missing = actions.filter(
    action => !NO_CONTROL_BY_DESIGN.includes(action) && !body.includes("'" + action + "'")
  );

  assert.deepEqual(missing, [], 'declared server-side but unreachable from the GUI');
});

test('the no-control list stays deliberate and small', () => {
  const body = guiBody(readPortal());
  for (const action of NO_CONTROL_BY_DESIGN) {
    assert.ok(!body.includes("'" + action + "'"), action + ' must not have a GUI control');
  }
  assert.deepEqual(
    NO_CONTROL_BY_DESIGN,
    ['auth.disableMfa'],
    'only disabling mandatory MFA may be kept out of the GUI'
  );
});

test('disabling MFA is still refused server-side rather than merely hidden', () => {
  const code = readCode();
  assert.match(code, /'MFA is mandatory and cannot be disabled\.[^']*'/);
  assert.match(code, /MFA is mandatory and cannot be disabled[\s\S]{0,140}403/);
});

test('the page requests step-up on exactly the actions the server requires it for', () => {
  const server = readActionSet(readCode(), 'PRIVILEGED_STEP_UP_ACTIONS').sort();
  const portal = readActionSet(readPortal(), 'PRIVILEGED_STEP_UP_ACTIONS').sort();

  assert.deepEqual(
    portal,
    server,
    'a mismatch means the GUI either skips a required step-up prompt or sends a useless one'
  );
});

test('every privileged action is a real declared action', () => {
  const declared = new Set(declaredActions(readCode()));
  const unknown = readActionSet(readCode(), 'PRIVILEGED_STEP_UP_ACTIONS')
    .filter(action => !declared.has(action));

  assert.deepEqual(unknown, [], 'the step-up list may not reference renamed or removed actions');
});

test('the previously unreachable capabilities now have controls', () => {
  const body = guiBody(readPortal());
  const required = [
    'users.resetMfa',
    'users.unlock',
    'users.update',
    'users.assignWorkspace',
    'timesheet.reopen',
    'audit.verifyChain',
    'audit.listCheckpoints',
    'audit.exportCheckpointsCsv',
    'integrity.audit',
    'jobs.capacity',
    'jobs.dispatchHousekeeping',
    'jobs.dispatchRollups',
    'jobs.dispatchBackups',
    'backups.prune',
    'rollups.rebuild',
    'setup.finalize',
    'entries.bulkAction',
    'clients.create',
    'projects.update',
    'tasks.create',
    'tags.create'
  ];
  const absent = required.filter(action => !body.includes("'" + action + "'"));
  assert.deepEqual(absent, []);
});

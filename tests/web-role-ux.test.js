'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../apps-script');
const code = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const user = fs.readFileSync(path.join(root, 'User.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'Admin.html'), 'utf8');
const superAdmin = fs.readFileSync(path.join(root, 'SuperAdmin.html'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8')
);
const spec = fs.readFileSync(
  path.resolve(__dirname, '../docs/SYSTEM_SPEC.md'), 'utf8'
);

test('production manifest is domain-restricted while retaining deployer execution', () => {
  assert.equal(manifest.webapp.access, 'DOMAIN');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.ok(
    manifest.oauthScopes.includes(
      'https://www.googleapis.com/auth/userinfo.email'
    )
  );
  assert.match(spec, /server-observed Google Workspace email/i);
});

test('three portal files are bound to distinct embed modes', () => {
  assert.match(user, /const EMBED_MODE = 'USER'/);
  assert.match(admin, /const EMBED_MODE = 'ADMIN'/);
  assert.match(superAdmin, /const EMBED_MODE = 'SUPER_ADMIN'/);

  assert.match(code, /user:\s*'User'/);
  assert.match(code, /admin:\s*'Admin'/);
  assert.match(code, /superadmin:\s*'SuperAdmin'/);
});

test('all browser portals support password + MFA challenge login', () => {
  for (const portal of [user, admin, superAdmin]) {
    assert.match(portal, /id="passwordLoginForm"/);
    assert.match(portal, /id="mfaLoginForm"/);
    assert.match(portal, /id="mfaCode"/);
    assert.match(portal, /function handleMfaVerification/);
    assert.match(portal, /auth\.verifyMfa/);
    assert.match(portal, /mfaChallengeToken/);
  }
});

test('USER portal exposes Timer, My Time, Reports, Account and timer safeguards', () => {
  for (const label of ['Timer','My Time','Reports','Account']) {
    assert.match(user, new RegExp("label: '" + label + "'"));
  }
  assert.match(user, /timerCooldownUntil/);
  assert.match(user, /5000/);
  assert.match(user, /timerRequestInFlight/);
  assert.match(user, /Today's Time Entries/);
  assert.match(user, /dashboard\.overview/);
  assert.match(user, /currentBusinessDate/);
  assert.match(user, /function loadMyTimeHistory/);
  assert.match(user, /entries\.update/);
  assert.match(user, /entries\.delete/);
  assert.match(user, /function openPasswordChangeModal/);
  assert.match(user, /id="userWorkspaceSelect"/);
  assert.match(user, /function changeUserWorkspace/);
  assert.match(user, /dashboard\.radar/);
  assert.match(user, /id="appNotice"/);
  assert.match(user, /function showAppNotice/);
});

test('ADMIN portal retains Timer/My Time plus Manager, Reports, Account', () => {
  for (const label of ['Timer','My Time','Manager','Reports','Account']) {
    assert.match(admin, new RegExp("label: '" + label + "'"));
  }
  for (const label of [
    'Overview','My Workspaces','Live Activity','Timesheets',
    'Approvals','Reports','Users','Requests','Alerts'
  ]) {
    assert.match(admin, new RegExp('>' + label + '<'));
  }
  assert.match(admin, /timesheet\.listForReview/);
  assert.match(admin, /timesheet\.approve/);
  assert.match(admin, /timesheet\.reject/);
  assert.match(admin, /requests\.submit/);
});

test('SUPER_ADMIN portal retains Timer/My Time plus Admin Console', () => {
  for (const label of ['Timer','My Time','Admin Console','Manager','Reports','Account']) {
    assert.match(superAdmin, new RegExp("label: '" + label + "'"));
  }
  assert.match(superAdmin, /Guided 9-Step Setup/);
  assert.match(superAdmin, /id="wzAdminEmail"/);
  assert.match(superAdmin, /id="wzEmpEmail"/);
  assert.match(superAdmin, /id="newUserEmail"/);
});

test('all portals await server logout before clearing the browser session', () => {
  for (const portal of [user, admin, superAdmin]) {
    assert.match(portal, /async function logout\(\)/);
    assert.match(portal, /await apiCall\('auth\.logout'\)/);
    assert.match(portal, /(safeStorage|sessionStorage)\.removeItem\('flink_session_token'\)/);
  }
});

test('portal role gates are explicit while server-side RBAC remains in Code.gs', () => {
  assert.match(user, /embedRoleAllowed/);
  assert.match(admin, /\['ADMIN', 'SUPER_ADMIN'\]/);
  assert.match(admin, /new Set\(\['timer', 'mytime', 'admin', 'reports', 'account'\]\)/);
  assert.match(superAdmin, /normalized === 'SUPER_ADMIN'/);
  assert.match(superAdmin, /new Set\(\['timer', 'mytime', 'superadmin', 'admin', 'reports', 'account'\]\)/);
  assert.match(code, /const ACTION_PERMISSIONS =/);
  assert.match(code, /AuthorizationService/);
});

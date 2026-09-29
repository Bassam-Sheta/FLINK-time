'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(
  __dirname,
  '../apps-script'
);
const html = fs.readFileSync(path.join(root,'App.html'),'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(root,'appsscript.json'),'utf8')
);
const setup = fs.readFileSync(
  path.resolve(__dirname,'../SYSTEM_SPEC.md'),'utf8'
);

test('production manifest is domain-restricted while retaining deployer execution', () => {
  assert.equal(manifest.webapp.access, 'DOMAIN');
  assert.equal(manifest.webapp.executeAs, 'USER_DEPLOYING');
  assert.ok(
    manifest.oauthScopes.includes(
      'https://www.googleapis.com/auth/userinfo.email'
    )
  );
  assert.match(setup, /IDENTITY-BINDING REQUIREMENT/i);
  assert.match(setup, /server-observed Google Workspace email/i);
});

test('timer UX has five-second cooldown, Today entries, and live KPI refresh', () => {
  assert.match(html, /timerCooldownUntil/);
  assert.match(html, /5000/);
  assert.match(html, /timerRequestInFlight/);
  assert.match(html, /Today's Time Entries/);
  assert.match(html, /dashboard\.overview/);
  assert.match(html, /currentBusinessDate/);
  assert.match(html, /reports\.detailed/);
});

test('USER navigation exposes Timer, My Time, Reports, and Account', () => {
  assert.match(html, /label: 'Timer'/);
  assert.match(html, /label: 'My Time'/);
  assert.match(html, /label: 'Reports'/);
  assert.match(html, /label: 'Account'/);
  assert.match(html, /function loadMyTimeHistory/);
  assert.match(html, /entries\.update/);
  assert.match(html, /expectedVersion/);
  assert.match(html, /entries\.delete/);
  assert.match(html, /function openPasswordChangeModal/);
  assert.match(html, /auth\.changePassword/);
});

test('manager GUI exposes exactly the planned operational tab labels and all-workspace selector', () => {
  for (const label of [
    'Overview','My Workspaces','Live Activity','Timesheets',
    'Approvals','Reports','Users','Requests','Alerts'
  ]) {
    assert.match(html, new RegExp('>' + label + '<'));
  }
  assert.match(html, /All My Workspaces/);
  assert.match(html, /timesheet\.listForReview/);
  assert.match(html, /timesheet\.approve/);
  assert.match(html, /timesheet\.reject/);
  assert.match(html, /reports\.exceptions/);
  assert.match(html, /requests\.submit/);
});

test('account provisioning forms require Google Workspace emails', () => {
  assert.match(html, /id="wzAdminEmail"/);
  assert.match(html, /id="wzEmpEmail"/);
  assert.match(html, /id="newUserEmail"/);
  assert.match(html, /Google Workspace Email/);
});

test('USER reports controls are rendered conditionally rather than exposing manager export by default', () => {
  assert.match(html, /reportsManagerActions/);
  assert.match(html, /state\.user\.role !== 'USER'/);
  assert.match(html, /function loadReportsView/);
});

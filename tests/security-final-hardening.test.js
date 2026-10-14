'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const userPath = path.resolve(__dirname, '../apps-script/User.html');
const adminPath = path.resolve(__dirname, '../apps-script/Admin.html');
const superAdminPath = path.resolve(__dirname, '../apps-script/SuperAdmin.html');

function source() {
  return fs.readFileSync(codePath, 'utf8');
}

test('high-risk Super Admin actions require short-lived server-bound step-up authentication', () => {
  const src = source();
  assert.match(src, /'auth\.stepUp':\s*\{[^\n]*SUPER_ADMIN/);
  assert.match(src, /STEP_UP_TTL_MINUTES:\s*5/);
  assert.match(src, /const PRIVILEGED_STEP_UP_ACTIONS = new Set\(\[/);
  assert.match(src, /AuthService\.assertStepUp\(authContext, payload\.stepUpToken \|\| ''\)/);
  assert.match(src, /requirePrivilegedActionAudit\(authContext, action, wsId \|\| ''\)/);
  assert.match(src, /'users\.assignWorkspace'/);
  assert.match(src, /_deleteStepUp\(authContext\.session\.SessionID\)/);
  assert.match(src, /SessionService\.revokeSession\(rawSessionToken\)/);
  assert.match(src, /Super Admin MFA must be enabled before high-risk administrative actions/);
});

test('Super Admin-only mutations are step-up protected except bootstrap and MFA-recovery flows', () => {
  const src = source();
  const permissionsStart = src.indexOf('const ACTION_PERMISSIONS = {');
  const permissionsEnd = src.indexOf('/**\n * Explicit unauthenticated boundary', permissionsStart);
  const permissions = src.slice(permissionsStart, permissionsEnd);
  const stepStart = src.indexOf('const PRIVILEGED_STEP_UP_ACTIONS = new Set([');
  const stepEnd = src.indexOf(']);', stepStart);
  const stepBlock = src.slice(stepStart, stepEnd);
  const protectedActions = new Set(
    [...stepBlock.matchAll(/'([^']+)'/g)].map(match => match[1])
  );

  const superAdminOnlyWrites = [];
  for (const match of permissions.matchAll(/'([^']+)':\s*\{([^}]+)\}/g)) {
    const [, action, body] = match;
    if (
      /authRequired:\s*true/.test(body) &&
      /isWrite:\s*true/.test(body) &&
      /roles:\s*\[CONSTANTS\.ROLES\.SUPER_ADMIN\]/.test(body)
    ) {
      superAdminOnlyWrites.push(action);
    }
  }

  const explicitExemptions = new Set([
    'auth.stepUp',
    'auth.disableMfa',
    'setup.completeStep',
    'setup.finalize'
  ]);
  const missing = superAdminOnlyWrites.filter(
    action => !explicitExemptions.has(action) && !protectedActions.has(action)
  );
  assert.deepEqual(missing, []);
});

test('all browser portals obtain and attach privileged step-up grants', () => {
  for (const file of [userPath, adminPath, superAdminPath]) {
    const html = fs.readFileSync(file, 'utf8');
    assert.match(html, /async function ensurePrivilegedStepUp\(\)/);
    assert.match(html, /rawApiCall\('auth\.stepUp'/);
    assert.match(html, /(safeStorage|sessionStorage)\.setItem\('flink_session_token', state\.token\)/);
    assert.match(html, /stepUpToken:\s*await ensurePrivilegedStepUp\(\)/);
  }
});

test('root Super Admin trust anchor cannot be demoted, deactivated, re-bound, or stripped of MFA', () => {
  const src = source();
  assert.match(src, /root Super Admin role cannot be demoted through generic user CRUD/);
  assert.match(src, /root Super Admin account cannot be deactivated/);
  assert.match(src, /root Super Admin Google Workspace identity cannot be changed/);
  assert.match(src, /MFA is mandatory and cannot be disabled/);
});

test('destructive workspace confirmation is enforced server-side', () => {
  const src = source();
  const start = src.indexOf("case 'workspaces.deletePermanent':");
  const end = src.indexOf('/* ---------------- BACKUP & RESTORE', start);
  const block = src.slice(start, end);
  assert.match(block, /MasterRepository\.getWorkspace\(payload\.workspaceId\)/);
  assert.match(block, /workspaceName[\s\S]*WorkspaceName/);
  assert.match(block, /Workspace name confirmation does not match the server record/);
});

test('Admin settings reads are workspace-filtered and policy reads use strict storage access', () => {
  const src = source();
  const start = src.indexOf("case 'settings.get':");
  const end = src.indexOf("case 'settings.save':", start);
  const block = src.slice(start, end);
  assert.match(block, /getAllGlobalSettingsStrict\(\)/);
  assert.match(block, /getWorkspaceAccessForUser\(authContext\.userId\)/);
  assert.match(block, /startsWith\(\`WS_\$\{id\}_\`\)/);
  assert.match(src, /getGlobalSettingStrict\(\`WS_\$\{workspaceId\}_ALLOW_MANUAL\`, ''\)/);
  assert.match(src, /getGlobalSettingStrict\('PAST_ENTRY_EDIT_DAYS', '7'\)/);
});

test('setup configuration writers close after installation', () => {
  const src = source();
  const start = src.indexOf('processStep(stepNumber, payload, authContext = null)');
  const end = src.indexOf('switch (step)', start);
  const block = src.slice(start, end);
  assert.match(block, /step >= 2 && step <= 8/);
  assert.match(block, /SETUP_COMPLETE/);
  assert.match(block, /Setup wizard configuration steps are closed after installation/);
});

test('existing installations reconcile new security triggers through system repair', () => {
  const src = source();
  const repairStart = src.indexOf('  repairSystem(authContext) {');
  const diagnosticsStart = src.indexOf('  getAdvancedDiagnostics(authContext) {', repairStart);
  const repair = src.slice(repairStart, diagnosticsStart);
  assert.match(repair, /JobService\.ensureScheduledTriggers\(\)/);
  assert.match(src, /legacyHandlers = new Set\(\['scheduledHousekeeping', 'scheduledRollups'\]\)/);
  assert.match(src, /removedLegacy/);
});

test('audit records are canonicalized before hashing and checkpoints are scheduled', () => {
  const src = source();
  const globalAuditStart = src.indexOf('logGlobalAudit(auditData)');
  const settingsStart = src.indexOf('/* ------------------- GLOBAL SETTINGS', globalAuditStart);
  const globalAudit = src.slice(globalAuditStart, settingsStart);
  assert.match(globalAudit, /const record = Validation\.sanitizeRow\(\{/);
  assert.ok(
    globalAudit.indexOf('Validation.sanitizeRow') <
      globalAudit.indexOf('computeAuditRecordHashV2'),
    'audit canonicalization must happen before HMAC computation'
  );

  assert.match(src, /handler:\s*'scheduledAuditCheckpoints_'/);
  assert.match(src, /function scheduledAuditCheckpoints_\(\)/);
  assert.match(src, /dispatchAuditCheckpoints\(\)/);
});

test('audit checkpoints seal the full historical prefix including legacy fields', () => {
  const src = source();
  assert.match(src, /_computeSnapshotHash\(rows, count = null\)/);
  assert.match(src, /snapshotHash/);
  assert.match(src, /detected mutation within the sealed audit prefix/);
});

test('housekeeping removes stale MFA enrollments and expired step-up grants', () => {
  const src = source();
  assert.match(src, /FLINK_MFA_ENROLLMENT_/);
  assert.match(src, /PendingTotpSecret:\s*''/);
  assert.match(src, /FLINK_STEP_UP_/);
  assert.match(src, /purgedMfaEnrollmentsCount/);
  assert.match(src, /purgedStepUpsCount/);
});

test('single caller is rejected before consuming the global login circuit breaker', () => {
  const src = source();
  const start = src.indexOf('const updateCounters = () => {');
  const end = src.indexOf('// CacheService has no atomic increment', start);
  const block = src.slice(start, end);
  assert.ok(
    block.indexOf('callerCount >') < block.indexOf('globalCount ='),
    'caller limit must be checked before the global counter is incremented'
  );
  assert.match(src, /LOGIN_GLOBAL_ATTEMPTS_PER_MINUTE:\s*1000/);
});

test('server-side 5xx AppErrors are sanitized at the API boundary', () => {
  const src = source();
  assert.match(src, /err instanceof AppError && Number\(err\.statusCode \|\| 400\) < 500/);
  assert.match(src, /An unexpected internal error occurred\. Reference:/);
});

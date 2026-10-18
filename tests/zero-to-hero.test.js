'use strict';

// Zero-to-hero mock journey.
//
// One continuous install is driven through the REAL production front door
// (`handleClientRequest` -> `dispatchAction_`) and the REAL AuthService,
// SessionService and TimerService. Only the Google I/O boundaries are mocked:
// Sheets storage, Drive/KMS, cache and the TOTP primitive. So this asserts the
// application's own policy, not a re-implementation of it.
//
// Not covered here (covered by the dedicated suites and by real Google runs):
// the wizard's step handlers run under `installer-first-run`/browser tests, the
// TOTP maths under `auth-mfa`/`mandatory-mfa`, and Google latency nowhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SOURCE = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/Code.gs'),
  'utf8'
);

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

function boot() {
  const clock = { now: Date.parse('2026-07-06T07:00:00.000Z') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }

  const properties = new Map();
  const cache = new Map();
  const store = { timers: [], entries: [], timesheets: [], audits: [], approvals: [], securityEvents: [] };
  let seq = 0;

  // Re-entrant script lock: production code nests waitLock/tryLock in one call.
  const lockState = { depth: 0 };
  const lock = {
    hasLock: () => lockState.depth > 0,
    tryLock: () => { lockState.depth += 1; return true; },
    waitLock: () => { lockState.depth += 1; },
    releaseLock: () => { lockState.depth = Math.max(0, lockState.depth - 1); }
  };

  const context = vm.createContext({
    Date: ClockDate,
    console,
    Logger: { log() {} },
    LockService: { getScriptLock: () => lock },
    Session: { getActiveUser: () => ({ getEmail: () => 'worker@example.test' }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (properties.has(key) ? properties.get(key) : null),
        setProperty: (key, value) => { properties.set(key, String(value)); },
        deleteProperty: (key) => { properties.delete(key); }
      })
    },
    CacheService: {
      getScriptCache: () => ({
        get: (key) => (cache.has(key) ? cache.get(key) : null),
        put: (key, value) => { cache.set(key, String(value)); },
        remove: (key) => { cache.delete(key); },
        removeAll: (keys) => { keys.forEach((key) => cache.delete(key)); }
      })
    },
    SpreadsheetApp: { flush() {}, openById() { throw new Error('no live spreadsheet'); } },
    DriveApp: { getFileById() { throw new Error('no live drive'); } },
    Utilities: {
      getUuid: () => crypto.randomUUID(),
      base64Encode: (value) => Buffer.from(value).toString('base64'),
      base64Decode: (value) => Array.from(Buffer.from(value, 'base64')).map((b) => (b > 127 ? b - 256 : b)),
      computeDigest(_algorithm, value) {
        const bytes = typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.map((b) => b & 255));
        return Array.from(crypto.createHash('sha256').update(bytes).digest()).map((b) => (b > 127 ? b - 256 : b));
      },
      newBlob: (value) => ({ getDataAsString: () => String(value) }),
      sleep: () => {},
      computeHmacSha256Signature(message, key) {
        return Array.from(
          crypto.createHmac('sha256', Buffer.from(key.map((b) => b & 255)))
            .update(Buffer.from(message.map((b) => b & 255)))
            .digest()
        ).map((b) => (b > 127 ? b - 256 : b));
      },
      formatDate(date, timezone) {
        return new Date(date).toISOString().slice(0, 19).replace('T', ' ') + ' ' + timezone;
      }
    }
  });

  vm.runInContext(SOURCE, context);

  // ---- deterministic identity / crypto boundary (real algorithm bodies kept) ----
  context.Validation.generateId = (prefix) => prefix + '-' + (++seq);
  Object.assign(context.SecurityService, {
    hashToken: sha256,
    getPepper: () => 'SYNTHETIC-PEPPER',
    generateRandomHex: (bytes = 16) => String(++seq).padStart(bytes * 2, '0'),
    generateTotpSecret: () => 'JBSWY3DPEHPK3PXP',
    verifyPassword: (password) => password === 'HeroPassword1!',
    needsPasswordHashUpgrade: () => false,
    verifyTotpWithStep: (secret, code) => ({
      valid: code === '123456',
      timeStep: Math.floor(clock.now / 30000)
    })
  });
  context.KmsSecretService.encryptTotpSecret = () => 'kms$v1$SYNTHETIC';
  context.KmsSecretService.decryptTotpSecret = () => 'JBSWY3DPEHPK3PXP';
  Object.assign(context.IdentityService, {
    getCurrentGoogleEmail: () => 'worker@example.test',
    assertAccountIdentity: (account) => account.Email,
    assertInstallationOwner: () => 'owner@example.test'
  });
  context.Flags.getNumber = () => 0;
  context.Flags.getValue = () => '';
  context.MigrationService.bootstrapMasterSheet = () => {};

  // ---- master storage boundary ----
  const account = {
    UserID: 'U1', Username: 'worker', DisplayName: 'Worker', Email: 'worker@example.test',
    Role: 'USER', Status: 'ACTIVE', SessionEpoch: 1, MustChangePassword: false
  };
  const cred = {
    UserID: 'U1', PasswordHash: 'synthetic', PasswordVersion: 1, FailedLoginCount: 0,
    MfaEnabled: true, TotpSecret: 'JBSWY3DPEHPK3PXP', PendingTotpSecret: '',
    LastSuccessfulTotpStep: '', RecoveryJSON: '', LockUntil: '', ResetExpiresAt: ''
  };
  const admin = {
    UserID: 'U0', Username: 'owner', DisplayName: 'Owner', Email: 'owner@example.test',
    Role: 'SUPER_ADMIN', Status: 'ACTIVE', SessionEpoch: 1, MustChangePassword: false
  };
  const workspace = { WorkspaceID: 'W1', WorkspaceName: 'Cairo Operations', Timezone: 'Africa/Cairo', Status: 'ACTIVE' };
  // A second, real workspace the employee has NO access mapping for.
  const otherWorkspace = { WorkspaceID: 'W2', WorkspaceName: 'Cairo Support', Timezone: 'Africa/Cairo', Status: 'ACTIVE' };
  const sessions = [];

  Object.assign(context.MasterRepository, {
    spreadsheetId: 'SYNTHETIC-MASTER',
    beginRequest() {},
    assertRecoverySchema() {},
    getGlobalSetting: (key, fallback) => (properties.has(key) ? properties.get(key) : fallback),
    setGlobalSetting: (key, value) => { properties.set(key, String(value)); },
    getAllGlobalSettingsStrict: () => Object.fromEntries(properties),
    getTableData: (tab) => ({ headers: context.MASTER_SCHEMA[tab] || [], rows: [] }),
    findRowsByKey: (tab, key) => {
      if (tab === context.CONSTANTS.MASTER_TABS.ACCOUNTS && key === 'Role') {
        return properties.get('SETUP_COMPLETE') === 'true'
          ? [{ UserID: 'U0', Role: 'SUPER_ADMIN', Status: 'ACTIVE' }] : [];
      }
      if (tab === context.CONSTANTS.MASTER_TABS.WORKSPACES && key === 'Status') {
        return properties.get('SETUP_COMPLETE') === 'true' ? [workspace] : [];
      }
      return [];
    },
    findAccountByUsername: (username) => {
      if (username === 'worker') return { ...account };
      if (username === 'owner') return { ...admin };
      return null;
    },
    findAccountById: (id) => (id === 'U0' ? { ...admin } : id === 'U1' ? { ...account } : null),
    getCredentials: (id) => (id === 'U1' ? { ...cred } : null),
    updateCredentials: (_id, patch) => { Object.assign(cred, patch); },
    updateAccount: (_id, patch) => { Object.assign(account, patch); },
    getUserAuthBundle: (id) => ({
      account: id === 'U0' ? { ...admin } : { ...account },
      accesses: [{ WorkspaceID: 'W1', Active: true, Role: id === 'U0' ? 'SUPER_ADMIN' : 'USER' }]
    }),
    getWorkspaceAccessForUser: () => [{ WorkspaceID: 'W1', Active: true }],
    getWorkspace: (id) => (id === 'W1' ? { ...workspace } : id === 'W2' ? { ...otherWorkspace } : null),
    listWorkspaces: () => [{ ...workspace }, { ...otherWorkspace }],
    createSession: (row) => { sessions.push({ ...row }); },
    findSessionByTokenHashFast: (hash) => sessions.find((row) => row.TokenHash === hash && !row.Revoked) || null,
    findSessionByTokenHash: (hash) => sessions.find((row) => row.TokenHash === hash) || null,
    updateSession: (id, patch) => {
      const row = sessions.find((entry) => entry.SessionID === id);
      if (row) Object.assign(row, patch);
      return row ? { ...row } : null;
    },
    revokeAllUserSessions: (id) => { if (id === 'U1') account.SessionEpoch += 1; else admin.SessionEpoch += 1; },
    logGlobalAudit: (data) => { store.audits.push({ global: true, ...data }); return true; },
    logSecurityEvent: (data) => { store.securityEvents.push({ ...data }); return true; }
  });

  // ---- workspace storage boundary ----
  context.SheetRepository = {
    beginRequest() {},
    getActiveTimer: (ws, userId) => {
      const timer = store.timers.find((t) => t.WorkspaceID === ws && t.UserID === userId);
      return timer ? { ...timer } : null;
    },
    createActiveTimer: (ws, record) => { store.timers.push({ ...record, WorkspaceID: ws }); },
    updateActiveTimer: (ws, userId, patch) => {
      const timer = store.timers.find((t) => t.WorkspaceID === ws && t.UserID === userId);
      if (!timer) return false;
      Object.assign(timer, patch);
      return true;
    },
    deleteActiveTimer: (ws, userId) => {
      const index = store.timers.findIndex((t) => t.WorkspaceID === ws && t.UserID === userId);
      if (index < 0) return false;
      store.timers.splice(index, 1);
      return true;
    },
    getEntryAnyStatus: (_ws, id) => store.entries.find((e) => e.EntryID === id) || null,
    getEntry: (_ws, id) => store.entries.find((e) => e.EntryID === id && e.Status !== 'DELETED') || null,
    createTimeEntry: (ws, entry) => { store.entries.push({ ...entry, WorkspaceID: ws }); },
    updateTimeEntry: (_ws, id, patch) => {
      const entry = store.entries.find((e) => e.EntryID === id);
      if (!entry) return null;
      Object.assign(entry, patch);
      return { ...entry };
    },
    listTimeEntries: () => store.entries.filter((e) => e.Status !== 'DELETED').map((e) => ({ ...e })),
    createTimesheet: (ws, row) => { store.timesheets.push({ ...row, WorkspaceID: ws }); },
    getTimesheet: (_ws, id) => store.timesheets.find((t) => t.TimesheetID === id) || null,
    updateTimesheet: (_ws, id, patch) => {
      const row = store.timesheets.find((t) => t.TimesheetID === id);
      if (!row) return null;
      Object.assign(row, patch);
      return { ...row };
    },
    listTimesheets: () => store.timesheets.map((t) => ({ ...t })),
    deleteTimesheet: (_ws, id) => { store.timesheets = store.timesheets.filter((t) => t.TimesheetID !== id); },
    logWorkspaceAudit: (ws, data) => { store.audits.push({ workspaceId: ws, ...data }); return true; },
    logApproval: (ws, data) => { store.approvals.push({ workspaceId: ws, ...data }); return true; },
    getWorkspaceSettings: () => ({}),
    setWorkspaceSetting() {}
  };

  // ---- policy/storage boundaries that are not the subject of this journey ----
  context.TrackingPolicyService.validateTrackingContext = (_ctx, _ws, payload) => {
    const projectId = payload.projectId || 'P1';
    return {
      projectId,
      taskId: payload.taskId || '',
      description: payload.description || '',
      tagIdsCsv: payload.tags || '',
      billable: payload.billable !== false,
      project: { ProjectID: projectId, HourlyRate: 100, CostRate: 40 }
    };
  };
  context.TrackingPolicyService.assertEntryEditableByAge = () => {};
  context.RollupService.recordTimeEntry = () => {};
  context.RollupService.reconcileMutation = () => {};
  context.RollupService.rebuildRollups = () => {};
  // Yearly file routing is a storage boundary here.
  context.YearlyEntryStorage = new Proxy({}, { get: () => () => undefined });

  const api = (action, body = {}) => context.handleClientRequest(action, body);

  return { api, context, store, clock, properties, account, cred, sessions, lockState };
}

test('zero to hero: an empty install becomes an attributable, save-without-approval time entry', () => {
  const world = boot();
  const { api, store, clock } = world;

  // ---- Stage 1: ZERO ------------------------------------------------------
  const zero = api('setup.status', {});
  assert.equal(zero.ok, true, 'setup.status must answer on a fresh install');
  assert.equal(zero.data.initialized, false);
  assert.equal(zero.data.setupRequired, true);
  assert.equal(store.entries.length, 0, 'nothing is written before setup');
  assert.equal(store.timers.length, 0);

  // ---- Stage 2: the owner finishes setup ----------------------------------
  world.properties.set('SETUP_COMPLETE', 'true');
  const ready = api('setup.status', {});
  assert.equal(ready.ok, true);
  assert.equal(ready.data.initialized, true, 'completed install is answered from the flag');

  // ---- Stage 3: a wrong password never authenticates ----------------------
  const bad = api('auth.login', { payload: { username: 'worker', password: 'wrong', clientType: 'WEB' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'AUTH_REQUIRED');
  assert.equal(bad.data, undefined, 'no payload leaks on a rejected sign-in');
  assert.equal(world.sessions.length, 0, 'no session exists before MFA');

  // The failed attempt above starts the server's graduated retry throttle, so
  // the very next attempt is refused even with the right password.
  const throttled = api('auth.login', { payload: { username: 'worker', password: 'HeroPassword1!', clientType: 'WEB' } });
  assert.equal(throttled.ok, false, 'a retry inside the throttle window is refused');
  assert.equal(throttled.error.code, 'AUTH_REQUIRED');

  clock.now += 5000;

  // ---- Stage 4: a correct password only yields an MFA challenge -----------
  const challenge = api('auth.login', { payload: { username: 'worker', password: 'HeroPassword1!', clientType: 'WEB' } });
  assert.equal(challenge.ok, true, 'correct password accepted after the throttle window');
  assert.equal(challenge.data.mfaRequired, true);
  assert.equal(typeof challenge.data.mfaChallengeToken, 'string');
  assert.equal(challenge.data.sessionToken, undefined, 'password alone must not mint a session');
  assert.equal(world.sessions.length, 0);

  // ---- Stage 5: MFA is mandatory and the wrong code is refused ------------
  const wrongCode = api('auth.verifyMfa', {
    payload: { mfaChallengeToken: challenge.data.mfaChallengeToken, code: '000000', clientType: 'WEB' }
  });
  assert.equal(wrongCode.ok, false);
  assert.equal(world.sessions.length, 0, 'a bad second factor mints no session');

  const verified = api('auth.verifyMfa', {
    payload: { mfaChallengeToken: challenge.data.mfaChallengeToken, code: '123456', clientType: 'WEB' }
  });
  assert.equal(verified.ok, true);
  const token = verified.data.sessionToken;
  assert.equal(typeof token, 'string');
  assert.equal(verified.data.user.role, 'USER');
  assert.equal(world.sessions.length, 1, 'exactly one session was minted');
  assert.equal(world.sessions[0].AuthLevel, 'MFA', 'the session is MFA-strength');

  // ---- Stage 6: the session works, and roles still deny by default --------
  const whoami = api('auth.validateSession', { sessionToken: token });
  assert.equal(whoami.ok, true);
  assert.equal(whoami.data.role, 'USER');

  const escalation = api('users.create', {
    sessionToken: token,
    workspaceId: 'W1',
    payload: { username: 'sneaky', fullName: 'Sneaky', role: 'SUPER_ADMIN' }
  });
  assert.equal(escalation.ok, false, 'a USER cannot create users');
  assert.equal(escalation.error.statusCode, 403);

  const crossWorkspace = api('timer.start', {
    sessionToken: token, workspaceId: 'W2', payload: { projectId: 'P1' }
  });
  assert.equal(crossWorkspace.ok, false, 'a workspace the user has no access to is refused');
  assert.equal(crossWorkspace.error.code, 'WORKSPACE_DENIED');
  assert.equal(crossWorkspace.error.statusCode, 403);
  assert.equal(store.timers.length, 0, 'the denied start wrote nothing');

  // ---- Stage 7: the workday ----------------------------------------------
  const started = api('timer.start', {
    sessionToken: token,
    workspaceId: 'W1',
    payload: { projectId: 'P1', taskId: 'T1', description: 'Hero journey', operationId: 'op-hero-0001' }
  });
  assert.equal(started.ok, true, JSON.stringify(started.error || {}));
  assert.equal(started.data.projectId, 'P1');
  assert.equal(started.data.startedAtUTC, new Date(clock.now).toISOString());
  const timerId = started.data.timerId;
  const startedAt = started.data.startedAtUTC;

  // One timer may exist. A second start is refused.
  const second = api('timer.start', {
    sessionToken: token, workspaceId: 'W1', payload: { projectId: 'P1', operationId: 'op-hero-0001' }
  });
  assert.equal(second.ok, true);
  assert.equal(second.data.replayed, true, 'the same operationId replays instead of double-starting');
  assert.equal(store.timers.length, 1, 'still exactly one running timer');

  clock.now += 30 * 60 * 1000;

  // Changing the project moves the whole interval: the start is untouched.
  const moved = api('timer.changeProject', {
    sessionToken: token, workspaceId: 'W1',
    payload: { timerId, projectId: 'P2', expectedProjectId: 'P1' }
  });
  assert.equal(moved.ok, true, JSON.stringify(moved.error || {}));
  assert.equal(moved.data.projectId, 'P2');
  assert.equal(moved.data.startedAtUTC, startedAt, 'the running interval keeps its original start');

  // ---- Stage 8: stopping saves completed time with no approval ------------
  const stopped = api('timer.stop', { sessionToken: token, workspaceId: 'W1', payload: { timerId } });
  assert.equal(stopped.ok, true, JSON.stringify(stopped.error || {}));
  assert.equal(stopped.data.approvalStatus, 'OPEN', 'a stopped entry is saved unapproved, not blocked');
  assert.equal(stopped.data.durationSeconds, 30 * 60);
  assert.equal(stopped.data.projectId, 'P2', 'the moved project is what got recorded');
  assert.equal(store.timers.length, 0, 'the run is over');
  assert.equal(store.entries.length, 1);

  // A stopped entry is not touched by any later timer work.
  const noTimer = api('timer.getActive', { sessionToken: token, workspaceId: 'W1' });
  assert.equal(noTimer.ok, true);
  assert.equal(noTimer.data, null);

  // ---- Stage 9: the change is attributable ---------------------------------
  const changeAudit = store.audits.filter((row) => String(row.EntityType) === 'ACTIVE_TIMER');
  assert.deepEqual(
    changeAudit.map((row) => row.Action),
    ['TIMER_PROJECT_CHANGE_INTENT', 'TIMER_PROJECT_CHANGED'],
    'the intent is written before the change'
  );
  for (const row of changeAudit) {
    assert.equal(row.ActorUserID, 'U1', 'mutations are attributable to a real actor');
    assert.equal(row.BeforeJSON.ProjectID, 'P1');
    assert.equal(row.AfterJSON.ProjectID, 'P2');
  }
  const startAudit = store.audits.find((row) => String(row.EntityType) === 'TIMER');
  assert.equal(startAudit.ActorUserID, 'U1');
  assert.equal(startAudit.Action, 'TIMER_STARTED');

  // ---- Stage 10: leaving ends access --------------------------------------
  const out = api('auth.logout', { sessionToken: token });
  assert.equal(out.ok, true);
  const afterLogout = api('auth.validateSession', { sessionToken: token });
  assert.equal(afterLogout.ok, false, 'a signed-out session cannot be reused');
  assert.equal(afterLogout.error.statusCode, 401);
});

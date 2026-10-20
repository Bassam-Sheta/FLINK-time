'use strict';

/**
 * User deletion (`users.delete`).
 *
 * The guarantee under test is the one that was asked for: a Super Admin can
 * easily delete a user, but the time logs and the other logs stay. The account
 * loses its ability to sign in and all of its sign-in material, while every
 * historical record it produced survives and still resolves to that user.
 *
 * Deletion therefore reuses the proven deactivation core — running timers are
 * preserved as completed entries and memberships are closed with rollback — and
 * then only adds the terminal DELETED status and clears the sign-in secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../apps-script/Code.gs');

const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';
const PENDING_SECRET = 'KRSXG5CTMVRXEZLU';
const RECOVERY_JSON = JSON.stringify({ codes: ['aaaa-bbbb-cccc'] });

class AppError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function fixture(overrides = {}) {
  const state = {
    account: Object.assign({
      UserID: 'U1',
      Username: 'worker',
      DisplayName: 'Worker One',
      Email: 'worker@example.test',
      Role: 'USER',
      Status: 'ACTIVE',
      SessionEpoch: 1
    }, overrides.account || {}),
    cred: Object.assign({
      UserID: 'U1',
      PasswordHash: 'HASH',
      PasswordVersion: 3,
      MfaEnabled: true,
      TotpSecret: TOTP_SECRET,
      PendingTotpSecret: PENDING_SECRET,
      LastSuccessfulTotpStep: '12345',
      RecoveryJSON: RECOVERY_JSON
    }, overrides.cred || {}),
    audits: [],
    accountUpdates: [],
    credentialUpdates: [],
    memberWrites: [],
    finalized: [],
    order: [],
    revoked: 0,
    challengeCleared: 0,
    exemptionCleared: 0,
    destructiveCalls: [],
    auditOk: true
  };

  global.AppError = AppError;
  global.ERROR_CODES = {
    AUTH_REQUIRED: 'AUTH_REQUIRED',
    VALIDATION_ERROR: 'VALIDATION_ERROR',
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    CRYPTO_FAILURE: 'CRYPTO_FAILURE',
    PERMISSION_DENIED: 'PERMISSION_DENIED'
  };
  global.CONSTANTS = {
    ROLES: { SUPER_ADMIN: 'SUPER_ADMIN', ADMIN: 'ADMIN', USER: 'USER' },
    ACCOUNT_STATUS: {
      ACTIVE: 'ACTIVE', LOCKED: 'LOCKED', PASSIVE: 'PASSIVE',
      ARCHIVED: 'ARCHIVED', DELETED: 'DELETED'
    },
    WORKSPACE_STATUS: { ACTIVE: 'ACTIVE' },
    AUDIT_EVENTS: {
      USER_PASSIVE: 'USER_PASSIVE',
      USER_DELETE_INTENT: 'USER_DELETE_INTENT',
      USER_DELETE_COMPLETED: 'USER_DELETE_COMPLETED'
    }
  };
  global.Validation = {};
  global.SecurityService = {};
  global.LockService = {
    getScriptLock() { return { waitLock() {}, releaseLock() {} }; }
  };
  global.SpreadsheetApp = { flush() {} };
  global.SessionService = {
    revokeAllUserSessions() { state.revoked += 1; state.order.push('sessions-revoked'); }
  };
  // Any hard delete of the person, their time or their history is a regression:
  // make it fail loudly instead of silently passing.
  const forbidden = name => () => {
    state.destructiveCalls.push(name);
    throw new Error(`deletion must never call ${name}`);
  };

  global.MasterRepository = Object.assign({
    findAccountById(id) { return id === state.account.UserID ? state.account : null; },
    deleteAccount: forbidden('deleteAccount'),
    deleteRows: forbidden('deleteRows'),
    deleteEntryRows: forbidden('deleteEntryRows'),
    deleteAuditRows: forbidden('deleteAuditRows'),
    getCredentials(id) { return id === state.cred.UserID ? state.cred : null; },
    getWorkspaceAccessForUser() { return [{ WorkspaceID: 'W1' }]; },
    getWorkspace() { return { WorkspaceID: 'W1', Status: 'ACTIVE' }; },
    updateAccount(_id, updates) {
      state.accountUpdates.push({ ...updates });
      state.order.push('account:' + updates.Status);
      Object.assign(state.account, updates);
      return { ...state.account };
    },
    updateCredentials(_id, updates) {
      state.credentialUpdates.push({ ...updates });
      Object.assign(state.cred, updates);
      return { ...state.cred };
    },
    logGlobalAudit(payload) {
      state.order.push('audit:' + payload.Action);
      if (!state.auditOk) return false;
      state.audits.push(payload);
      return true;
    }
  }, overrides.MasterRepository || {});
  global.SheetRepository = Object.assign({
    getActiveTimer() {
      return { TimerID: 'TMR-1', UserID: 'U1', StartedAtUTC: '2026-09-27T10:00:00.000Z' };
    },
    getMember() { return { UserID: 'U1', Status: 'ACTIVE', LeftAt: '' }; },
    updateMember(_ws, _id, updates) {
      state.memberWrites.push({ ...updates });
      state.order.push('member:' + updates.Status);
    }
  }, overrides.SheetRepository || {});
  global.TimerService = {
    _finalizeActiveTimerLocked(ownerContext, ws, timer) {
      state.order.push('timer-finalized');
      assert.equal(ownerContext.userId, 'U1');
      assert.equal(ws, 'W1');
      assert.equal(timer.TimerID, 'TMR-1');
      const entry = { EntryID: 'ENT-1', DurationSeconds: 1800 };
      state.finalized.push(entry);
      return entry;
    }
  };

  delete require.cache[require.resolve(servicePath)];
  const moduleExports = require(servicePath);
  const UserService = moduleExports.UserService;

  // Sign-in material clearing is delegated to the auth service: count the calls
  // instead of exercising the property store here.
  moduleExports.AuthService._deleteMfaChallenge = () => { state.challengeCleared += 1; };
  moduleExports.MfaPolicyService.clearExemption = () => {
    state.exemptionCleared += 1;
    return true;
  };

  return { state, UserService };
}

const SUPER_ADMIN = { userId: 'SA1', role: 'SUPER_ADMIN' };

test('deletion blocks sign-in but keeps the time logs and the other logs', () => {
  const { state, UserService } = fixture();

  const result = UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver');

  assert.equal(result.ok, true);
  assert.equal(result.userId, 'U1');
  assert.equal(result.status, 'DELETED');
  assert.equal(result.timeLogsPreserved, true);
  assert.equal(result.auditLogsPreserved, true);

  // The running interval was not thrown away: it became a completed entry.
  assert.equal(state.finalized.length, 1);
  assert.equal(result.finalizedTimers.length, 1);
  assert.equal(result.finalizedTimers[0].entryId, 'ENT-1');

  // The account row is retained (soft delete), so historical rows still resolve.
  assert.equal(state.account.Status, 'DELETED');
  assert.ok(
    global.MasterRepository.findAccountById('U1'),
    'the account row must still exist so past time and audit rows resolve'
  );
  assert.equal(
    state.destructiveCalls.length,
    0,
    'deletion must not call any destructive repository method'
  );
});

test('deletion clears authenticator/recovery secrets and revokes access', () => {
  const { state, UserService } = fixture();

  UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver');

  assert.equal(state.cred.MfaEnabled, false);
  assert.equal(state.cred.TotpSecret, '');
  assert.equal(state.cred.PendingTotpSecret, '');
  assert.equal(state.cred.LastSuccessfulTotpStep, '');
  assert.equal(state.cred.RecoveryJSON, '');
  assert.equal(state.revoked, 1, 'existing sessions must be revoked');
  assert.equal(state.challengeCleared, 1, 'a stale MFA challenge must be cleared');
  assert.equal(state.exemptionCleared, 1, 'an MFA exemption must not outlive the account');
});

test('deletion preserves time before terminating the account', () => {
  const { state, UserService } = fixture();

  UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver');

  const ordered = state.order.filter(step => step !== 'audit:USER_DELETE_INTENT');
  assert.deepEqual(ordered.slice(0, 4), [
    'sessions-revoked',
    'timer-finalized',
    'member:PASSIVE',
    'account:DELETED'
  ]);
});

test('deletion is attributable with recoverable before/after state and no secrets', () => {
  const { state, UserService } = fixture();

  UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver');

  assert.equal(state.audits.length, 2, 'intent and completion must both be recorded');
  assert.equal(state.audits[0].Action, 'USER_DELETE_INTENT');
  assert.equal(state.audits[1].Action, 'USER_DELETE_COMPLETED');
  assert.equal(state.audits[0].ActorUserID, 'SA1');
  assert.equal(state.audits[0].EntityID, 'U1');
  assert.equal(state.audits[0].EntityType, 'USER');

  const before = state.audits[0].BeforeJSON;
  const after = state.audits[0].AfterJSON;
  assert.equal(before.status, 'ACTIVE');
  assert.equal(before.role, 'USER');
  assert.equal(before.authenticatorBound, true);
  assert.equal(after.status, 'DELETED');
  assert.equal(after.signInAllowed, false);
  assert.equal(after.timeLogsPreserved, true);
  assert.equal(after.auditLogsPreserved, true);
  assert.equal(after.reason, 'Leaver');

  const serialized = JSON.stringify(state.audits);
  assert.ok(!serialized.includes(TOTP_SECRET), 'the TOTP secret must never be audited');
  assert.ok(!serialized.includes(PENDING_SECRET), 'a pending secret must never be audited');
  assert.ok(!serialized.includes('aaaa-bbbb-cccc'), 'recovery codes must never be audited');
});

test('deletion fails closed when the audit trail is unavailable', () => {
  const { state, UserService } = fixture();
  state.auditOk = false;

  assert.throws(
    () => UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver'),
    err => err instanceof AppError && err.code === 'CRYPTO_FAILURE'
  );

  assert.equal(state.accountUpdates.length, 0, 'no mutation may happen without an audit record');
  assert.equal(state.revoked, 0);
  assert.equal(state.finalized.length, 0);
  assert.equal(state.account.Status, 'ACTIVE');
  assert.equal(state.cred.TotpSecret, TOTP_SECRET);
});

test('the root Super Admin account cannot be deleted', () => {
  const { state, UserService } = fixture({ account: { UserID: 'ROOT1', Role: 'SUPER_ADMIN' } });

  assert.throws(
    () => UserService.deleteUser(SUPER_ADMIN, 'ROOT1', ''),
    err => err instanceof AppError && err.statusCode === 403
  );

  assert.equal(state.accountUpdates.length, 0);
  assert.equal(state.revoked, 0);
});

test('a Super Admin cannot delete the account they are signed in with', () => {
  const { state, UserService } = fixture({ account: { UserID: 'SA1', Role: 'ADMIN' } });

  assert.throws(
    () => UserService.deleteUser(SUPER_ADMIN, 'SA1', ''),
    err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
  );

  assert.equal(state.accountUpdates.length, 0);
});

test('unknown targets are refused and deleted targets resume only cleanup', () => {
  const missing = fixture();
  assert.throws(
    () => missing.UserService.deleteUser(SUPER_ADMIN, 'U404', ''),
    err => err instanceof AppError && err.code === 'NOT_FOUND'
  );

  const already = fixture({ account: { Status: 'DELETED' } });
  assert.equal(already.UserService.deleteUser(SUPER_ADMIN, 'U1', '').ok, true);
  assert.equal(already.state.revoked, 0);
  assert.equal(already.state.finalized.length, 0);
  assert.equal(already.state.memberWrites.length, 0);
  assert.equal(already.state.cred.TotpSecret, '');
});

test('only a Super Admin may delete an account', () => {
  const { state, UserService } = fixture();

  for (const role of ['ADMIN', 'USER']) {
    assert.throws(
      () => UserService.deleteUser({ userId: 'A1', role }, 'U1', ''),
      err => err instanceof AppError && err.statusCode === 403,
      role
    );
  }

  assert.equal(state.accountUpdates.length, 0);
  assert.equal(state.revoked, 0);
});

test('a blank target id is refused before any lock or mutation', () => {
  const { state, UserService } = fixture();

  for (const blank of ['', '   ', null, undefined]) {
    assert.throws(
      () => UserService.deleteUser(SUPER_ADMIN, blank, ''),
      err => err instanceof AppError && err.code === 'VALIDATION_ERROR'
    );
  }

  assert.equal(state.revoked, 0);
});

test('reactivating an account clears any leftover sign-in MFA exemption', () => {
  const { state, UserService } = fixture();

  const result = UserService.activateUser(SUPER_ADMIN, 'U1');

  assert.equal(result.status, 'ACTIVE');
  assert.equal(state.account.Status, 'ACTIVE');
  assert.equal(
    state.exemptionCleared,
    1,
    'a revived account must not inherit a stale exemption from before'
  );
});

test('deletion rolls membership back when a later workspace write fails', () => {
  const { state, UserService } = fixture({
    MasterRepository: {
      getWorkspaceAccessForUser() {
        return [{ WorkspaceID: 'W1' }, { WorkspaceID: 'W2' }];
      },
      getWorkspace() { return { Status: 'ACTIVE' }; }
    },
    SheetRepository: {
      getActiveTimer() { return null; },
      getMember() { return { UserID: 'U1', Status: 'ACTIVE', LeftAt: '' }; },
      updateMember(ws, _id, updates) {
        state.memberWrites.push({ ws, ...updates });
        if (ws === 'W2' && updates.Status === 'PASSIVE') {
          throw new Error('member write failed');
        }
      }
    }
  });

  assert.throws(
    () => UserService.deleteUser(SUPER_ADMIN, 'U1', ''),
    /member write failed/
  );

  assert.equal(
    state.accountUpdates.some(patch => patch.Status === 'DELETED'),
    false,
    'the account must not be deleted when a membership transition fails'
  );
  assert.equal(
    state.memberWrites.some(w => w.ws === 'W1' && w.Status === 'ACTIVE'),
    true,
    'the earlier membership transition must be rolled back'
  );
});

for (const phase of ['credentials-before', 'credentials-after', 'challenge', 'exemption', 'completion']) {
  test('deletion resumes cleanup after interruption at ' + phase + ' without duplicating time', () => {
    const { state, UserService } = fixture();
    const auth = require(servicePath).AuthService;
    const policy = require(servicePath).MfaPolicyService;
    let restore;
    if (phase.startsWith('credentials')) {
      const update = global.MasterRepository.updateCredentials;
      global.MasterRepository.updateCredentials = (...args) => {
        if (phase === 'credentials-after') update(...args);
        throw new Error('Synthetic cleanup interruption');
      };
      restore = () => { global.MasterRepository.updateCredentials = update; };
    } else if (phase === 'completion') {
      const audit = global.MasterRepository.logGlobalAudit;
      global.MasterRepository.logGlobalAudit = data => data.Action === 'USER_DELETE_COMPLETED' ? false : audit(data);
      restore = () => { global.MasterRepository.logGlobalAudit = audit; };
    } else {
      const service = phase === 'challenge' ? auth : policy;
      const method = phase === 'challenge' ? '_deleteMfaChallenge' : 'clearExemption';
      const original = service[method];
      service[method] = () => { throw new Error('Synthetic cleanup interruption'); };
      restore = () => { service[method] = original; };
    }
    assert.throws(() => UserService.deleteUser(SUPER_ADMIN, 'U1', 'Leaver'));
    assert.equal(state.account.Status, 'DELETED');
    restore();
    const result = UserService.deleteUser(SUPER_ADMIN, 'U1', 'Retry cleanup');
    assert.equal(result.ok, true);
    assert.equal(state.cred.TotpSecret, '');
    assert.equal(state.cred.RecoveryJSON, '');
    assert.equal(state.finalized.length, 1);
    assert.equal(state.memberWrites.length, 1);
    assert.equal(state.audits[0].BeforeJSON.status, 'ACTIVE');
    assert.equal(state.audits.at(-1).Action, 'USER_DELETE_COMPLETED');
    assert.equal(state.destructiveCalls.length, 0);
  });
}

test('a deleted account cannot be resurrected through activation or passive status', () => {
  const { state, UserService } = fixture({ account: { Status: 'DELETED' } });
  for (const method of ['activateUser', 'makeUserPassive']) {
    assert.throws(() => UserService[method](SUPER_ADMIN, 'U1'), error => error.code === 'CONFLICT');
  }
  assert.equal(state.account.Status, 'DELETED');
  assert.equal(state.accountUpdates.length, 0);
});

test('deletion does not mutate without a durably flushed intent', () => {
  const { state, UserService } = fixture();
  global.SpreadsheetApp.flush = () => { throw new Error('Synthetic flush uncertainty'); };
  assert.throws(() => UserService.deleteUser(SUPER_ADMIN, 'U1'), /Synthetic flush uncertainty/);
  assert.equal(state.account.Status, 'ACTIVE');
  assert.equal(state.finalized.length, 0);
});

test('failed deletion completion flush is reported and cleanup retry preserves time', () => {
  const { state, UserService } = fixture();
  let flushes = 0;
  global.SpreadsheetApp.flush = () => {
    if (++flushes === 3) throw new Error('Synthetic completion flush uncertainty');
  };
  assert.throws(() => UserService.deleteUser(SUPER_ADMIN, 'U1'), /Synthetic completion flush uncertainty/);
  assert.equal(state.account.Status, 'DELETED');
  assert.equal(UserService.deleteUser(SUPER_ADMIN, 'U1').ok, true);
  assert.equal(state.finalized.length, 1);
  assert.equal(state.audits.at(-1).Action, 'USER_DELETE_COMPLETED');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../apps-script/Code.gs'), 'utf8');

function fixture() {
  const clock = { now: Date.parse('2026-10-06T12:00:00Z') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const controls = { held: false, onAcquire: null, lockFails: false, flushFails: false, failAtFlush: 0,
    auditOk: true, completionAuditOk: true, creates: 0, flushes: 0 };
  const lock = {
    hasLock: () => controls.held,
    waitLock() { if (controls.lockFails) throw new Error('synthetic lock timeout'); controls.held = true; if (controls.onAcquire) controls.onAcquire(); },
    releaseLock() { controls.held = false; }
  };
  const context = vm.createContext({ Date: ClockDate, console,
    LockService: { getScriptLock: () => lock },
    SpreadsheetApp: { flush() {
      assert.equal(controls.held, true);
      controls.flushes++;
      if (controls.flushFails || controls.flushes === controls.failAtFlush) throw new Error('synthetic flush failure');
    } }
  });
  vm.runInContext(source, context);
  const account = { UserID: 'ROOT', Username: 'root', Role: 'SUPER_ADMIN', Status: 'ACTIVE', Email: 'root@example.test', SessionEpoch: 3 };
  const cred = { UserID: 'ROOT', PasswordHash: 'HASH', PasswordVersion: 2, MfaEnabled: true, TotpSecret: 'CIPHER', LastSuccessfulTotpStep: 1 };
  const session = { SessionID: 'OLD', UserID: 'ROOT', TokenHash: 'TOKEN-HASH', AccountEpoch: 3, ClientType: 'WEB', ClientLabel: account.Email,
    ExpiresAt: new Date(clock.now + 3600000).toISOString(), AbsoluteExpiresAt: new Date(clock.now + 7200000).toISOString(), Revoked: false };
  const auth = { userId: account.UserID, role: account.Role, user: { ...account }, session: { ...session } };
  const audits = [];
  const revoked = [];
  Object.assign(context.MasterRepository, {
    getCredentials: () => ({ ...cred }),
    findAccountById: () => ({ ...account }),
    findSessionByTokenHashFast: () => session.Revoked ? null : { ...session },
    updateCredentials(_id, patch) { Object.assign(cred, patch); },
    invalidateUserCache() {},
    logSecurityEvent() {},
    logGlobalAudit(record) {
      assert.equal(controls.held, true);
      audits.push(record);
      return controls.auditOk && (record.Action !== 'STEP_UP_AUTHENTICATED' || controls.completionAuditOk);
    }
  });
  Object.assign(context.SecurityService, {
    verifyPassword() { assert.equal(controls.held, false, 'KDF must run outside the mutation lock'); return true; },
    verifyTotpWithStep() { assert.equal(controls.held, false); return { valid: true, timeStep: Math.floor(clock.now / 30000) }; },
    hashToken: () => 'TOKEN-HASH',
    generateRandomHex: () => 'SYNTHETIC-NONCE'
  });
  context.IdentityService.assertAccountIdentity = () => account.Email;
  Object.assign(context.SessionService, {
    createSession() { controls.creates++; return { sessionId: 'NEW', sessionToken: 'NEW-TOKEN', expiresAt: session.ExpiresAt }; },
    revokeSession(token) { revoked.push(token); }
  });
  return { context, controls, account, cred, session, clock, auth, audits, revoked,
    run: () => context.AuthService.stepUp(auth, 'OLD-TOKEN', 'SYNTHETIC-PASSWORD', '123456') };
}

test('step-up rejects a TOTP consumed by another request before the mutation lock', () => {
  const fx = fixture();
  fx.controls.onAcquire = () => { fx.cred.LastSuccessfulTotpStep = Math.floor(fx.clock.now / 30000); };
  assert.throws(fx.run, error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.controls.creates, 0);
});

test('step-up rechecks credentials, account role/status/epoch and session under the lock', () => {
  const mutations = [
    fx => { fx.cred.PasswordHash = 'CHANGED'; },
    fx => { fx.cred.PasswordVersion++; },
    fx => { fx.cred.TotpSecret = 'REPLACED'; },
    fx => { fx.cred.MfaEnabled = false; },
    fx => { fx.account.Status = 'LOCKED'; },
    fx => { fx.account.Role = 'USER'; },
    fx => { fx.account.Email = 'changed@example.test'; },
    fx => { fx.account.SessionEpoch++; },
    fx => { fx.session.Revoked = true; },
    fx => { fx.session.ExpiresAt = new Date(fx.clock.now).toISOString(); }
  ];
  for (const mutate of mutations) {
    const fx = fixture();
    fx.controls.onAcquire = () => mutate(fx);
    assert.throws(fx.run, error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.controls.creates, 0);
    assert.equal(fx.controls.held, false);
  }
});

test('step-up cannot accept a verification that aged out while waiting for the lock', () => {
  const fx = fixture();
  fx.controls.onAcquire = () => { fx.clock.now += 90000; };
  assert.throws(fx.run, error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.controls.creates, 0);
});

test('successful step-up flushes writes under lock and records redacted before/after', () => {
  const fx = fixture();
  const result = fx.run();
  assert.equal(result.sessionToken, 'NEW-TOKEN');
  assert.equal(fx.controls.held, false);
  assert.ok(fx.controls.flushes > 0);
  const audit = fx.audits.find(row => row.Action === 'STEP_UP_AUTHENTICATED');
  assert.equal(audit.BeforeJSON.stepUpGranted, false);
  assert.equal(audit.AfterJSON.stepUpGranted, true);
  assert.doesNotMatch(JSON.stringify(audit), /SYNTHETIC-PASSWORD|CIPHER|NEW-TOKEN|123456/);
});

test('step-up flush failure releases the lock and does not return a usable grant', () => {
  const fx = fixture();
  fx.controls.flushFails = true;
  assert.throws(fx.run, /synthetic flush failure/);
  assert.equal(fx.controls.held, false);
  assert.equal(fx.context.AuthService._getStepUp('NEW'), null);
});

test('step-up audit failure does not activate a grant', () => {
  const fx = fixture();
  fx.controls.auditOk = false;
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.context.AuthService._getStepUp('NEW'), null);
  assert.equal(fx.controls.creates, 0);
});

test('step-up rejects malformed durable security state instead of defaulting to a valid generation', () => {
  const mutations = [
    fx => { fx.account.UserID = 'OTHER'; },
    fx => { fx.cred.UserID = 'OTHER'; },
    ...[0, false, ' ', 'garbage', -1, 1.5].map(value => fx => {
      fx.account.SessionEpoch = fx.session.AccountEpoch = fx.auth.session.AccountEpoch = value;
    }),
    ...['oops', '1junk', -1, 1.5].map(value => fx => { fx.cred.LastSuccessfulTotpStep = value; }),
    fx => { fx.cred.LockUntil = 'invalid'; },
    fx => { fx.session.ExpiresAt = 'invalid'; },
    fx => { fx.session.AbsoluteExpiresAt = 'invalid'; }
  ];
  for (const mutate of mutations) {
    const fx = fixture();
    fx.controls.onAcquire = () => mutate(fx);
    assert.throws(fx.run, error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.controls.creates, 0);
    assert.equal(fx.controls.held, false);
  }
});

test('step-up refreshes pre-lock repository table snapshots before checking revocation', () => {
  const fx = fixture();
  const repository = fx.context.MasterRepository;
  const tabs = fx.context.CONSTANTS.MASTER_TABS;
  const records = { [tabs.ACCOUNTS]: fx.account, [tabs.CREDENTIALS]: fx.cred, [tabs.SESSIONS]: fx.session };
  // Exercise real getCredentials/findAccountById/findSessionByTokenHashFast and
  // findRowByKey, including its request-cache fast path.
  const original = vm.createContext({ console });
  vm.runInContext(source, original);
  for (const key of ['getCredentials', 'findAccountById', 'findSessionByTokenHashFast']) {
    repository[key] = original.MasterRepository[key];
  }
  repository.getMasterSpreadsheet = () => ({ getSheetByName: tab => ({
    getLastRow: () => 2,
    getRange: () => ({
      createTextFinder: () => {
        const finder = { matchEntireCell: () => finder, matchCase: () => finder, findNext: () => ({ getRow: () => 2 }) };
        return finder;
      },
      getValues: () => [fx.context.MASTER_SCHEMA[tab].map(key => records[tab][key] ?? '')]
    })
  }) });
  for (const [tab, record] of Object.entries(records)) repository._requestCache[tab] = { rows: [{ ...record }] };
  fx.controls.onAcquire = () => { fx.session.Revoked = true; };
  assert.throws(fx.run, error => error.code === 'AUTH_REQUIRED');
  assert.equal(fx.controls.creates, 0);
});

test('step-up lock timeout performs no security mutations', () => {
  const fx = fixture();
  fx.controls.lockFails = true;
  assert.throws(fx.run, /synthetic lock timeout/);
  assert.equal(fx.controls.creates, 0);
  assert.equal(fx.audits.length, 0);
  assert.equal(fx.cred.LastSuccessfulTotpStep, 1);
});

test('step-up completion audit failure revokes the replacement and removes its grant', () => {
  const fx = fixture();
  fx.controls.completionAuditOk = false;
  assert.throws(fx.run, error => error.code === 'CRYPTO_FAILURE');
  assert.equal(fx.controls.creates, 1);
  assert.ok(fx.revoked.includes('NEW-TOKEN'));
  assert.equal(fx.context.AuthService._getStepUp('NEW'), null);
  assert.equal(fx.controls.held, false);
});

test('step-up completion flush failure removes the grant and flushes replacement revocation under lock', () => {
  const fx = fixture();
  fx.controls.failAtFlush = 2;
  assert.throws(fx.run, /synthetic flush failure/);
  assert.equal(fx.context.AuthService._getStepUp('NEW'), null);
  assert.ok(fx.revoked.includes('NEW-TOKEN'));
  assert.ok(fx.controls.flushes >= 3);
  assert.equal(fx.controls.held, false);
});

test('step-up grants expire at the exact deadline and reject corrupt expiry values', () => {
  for (const expiry of [undefined, null, '', 'garbage', 'Infinity', false, {}, 0, Date.parse('2026-10-06T12:00:00Z')]) {
    const fx = fixture();
    fx.context.AuthService._storeStepUp('OLD', { userId: 'ROOT', sessionId: 'OLD', tokenHash: 'TOKEN-HASH', expiresAtMs: expiry });
    assert.throws(() => fx.context.AuthService.assertStepUp(fx.auth, 'SYNTHETIC-GRANT'), error => error.code === 'AUTH_REQUIRED');
    assert.equal(fx.context.AuthService._getStepUp('OLD'), null);
  }
});

test('step-up grants work before expiry and remain bound to their session and token', () => {
  const fx = fixture();
  const result = fx.run();
  const replacementAuth = { ...fx.auth, session: { ...fx.session, SessionID: 'NEW' } };
  assert.equal(fx.context.AuthService.assertStepUp(replacementAuth, result.stepUpToken), true);
  fx.context.SecurityService.hashToken = () => 'WRONG-HASH';
  assert.throws(() => fx.context.AuthService.assertStepUp(replacementAuth, 'WRONG-GRANT'), error => error.code === 'AUTH_REQUIRED');
  assert.throws(() => fx.context.AuthService.assertStepUp(fx.auth, result.stepUpToken), error => error.code === 'AUTH_REQUIRED');
});

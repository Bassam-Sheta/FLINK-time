'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const source = fs.readFileSync(path.resolve(__dirname, '../../apps-script/Code.gs'), 'utf8');

function mfaFixture() {
  const clock = { now: Date.parse('2026-10-01T12:00:00Z') };
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const account = { UserID: 'U1', Username: 'worker', DisplayName: 'Worker', Email: 'worker@example.test',
    Role: 'USER', Status: 'ACTIVE', SessionEpoch: 1, MustChangePassword: false };
  const cred = { UserID: 'U1', PasswordHash: 'synthetic-hash', PasswordVersion: 1, FailedLoginCount: 0,
    MfaEnabled: false, TotpSecret: '', PendingTotpSecret: '', LastSuccessfulTotpStep: '', RecoveryJSON: '' };
  const sessions = [];
  const events = [];
  const audits = [];
  const properties = new Map();
  const controls = { locked: false, auditOk: true, email: account.Email, validCode: true, onLock: null };
  const lock = {
    hasLock: () => controls.locked,
    waitLock() { controls.locked = true; if (controls.onLock) controls.onLock(); },
    tryLock() { lock.waitLock(); return true; },
    releaseLock() { controls.locked = false; }
  };
  const context = vm.createContext({ Date: ClockDate, console,
    LockService: { getScriptLock: () => lock },
    Session: { getActiveUser: () => ({ getEmail: () => controls.email }) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => properties.get(key) || null,
      setProperty: (key, value) => properties.set(key, value),
      deleteProperty: key => properties.delete(key)
    }) },
    SpreadsheetApp: { flush() {} }
  });
  vm.runInContext(source, context);
  let next = 0;
  Object.assign(context.SecurityService, {
    hashToken: value => crypto.createHash('sha256').update(String(value)).digest('hex'),
    generateSessionToken: () => 'SYNTHETIC-TOKEN-' + (++next),
    generateRandomHex: (bytes = 16) => String(++next).padStart(bytes * 2, '0'),
    generateTotpSecret: () => 'SYNTHETIC-SECRET',
    getPepper: () => 'SYNTHETIC-PEPPER',
    verifyPassword: password => password === 'SyntheticPassword1!',
    needsPasswordHashUpgrade: () => false,
    verifyTotpWithStep: () => ({ valid: controls.validCode, timeStep: Math.floor(clock.now / 30000) })
  });
  context.KmsSecretService.encryptTotpSecret = () => 'kms$v1$SYNTHETIC';
  context.Validation.generateId = prefix => prefix + '-' + (++next);
  context.Flags.getNumber = () => 0;
  Object.assign(context.MasterRepository, {
    assertRecoverySchema() {},
    findAccountByUsername: () => ({ ...account }),
    findAccountById: () => ({ ...account }),
    getUserAuthBundle: () => ({ account: { ...account }, accesses: [] }),
    getCredentials: () => ({ ...cred }),
    updateCredentials(_id, updates) { Object.assign(cred, updates); },
    updateAccount(_id, updates) { Object.assign(account, updates); },
    getWorkspaceAccessForUser: () => [],
    createSession: row => { sessions.push({ ...row }); },
    findSessionByTokenHashFast: hash => sessions.find(row => row.TokenHash === hash && !row.Revoked) || null,
    updateSession(id, updates) { const row = sessions.find(row => row.SessionID === id); Object.assign(row, updates); return { ...row }; },
    revokeAllUserSessions() { account.SessionEpoch++; },
    logGlobalAudit: data => { audits.push(data); return controls.auditOk; },
    logSecurityEvent: data => { events.push(data); }
  });
  function login() { return context.AuthService.login('worker', 'SyntheticPassword1!', 'WEB'); }
  return { context, account, cred, sessions, events, audits, properties, controls, clock, login };
}

module.exports = { mfaFixture };

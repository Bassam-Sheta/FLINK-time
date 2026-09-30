'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const codePath = path.resolve(__dirname, '../apps-script/Code.gs');
const source = () => fs.readFileSync(codePath, 'utf8');

test('request-time master lookups use bounded TextFinder reads', () => {
  const src = source();
  assert.match(src, /findRowByKey\(tabName, columnName, value/);
  assert.match(src, /createTextFinder\(String\(value\)\)/);
  assert.match(src, /findSessionByTokenHashFast\(tokenHash\)/);

  const repoStart = src.indexOf('var MasterRepository');
  const a0 = src.indexOf('findAccountById(userId)', repoStart);
  const a = src.slice(a0, src.indexOf('createAccount(accountData', a0));
  assert.match(a, /findRowByKey/);
  assert.doesNotMatch(a, /getTableData/);

  const s0 = src.indexOf('findSessionByTokenHashFast(tokenHash)', repoStart);
  const s1 = src.indexOf('revokeAllUserSessions(userId)', s0);
  const s = src.slice(s0, s1);
  assert.match(s, /findRowByKey/);
  assert.doesNotMatch(s, /getTableData/);
});

test('session validation uses a bounded five-minute ScriptCache entry', () => {
  const src = source();
  assert.match(src, /_sessionCacheKey\(tokenHash\)/);
  assert.match(src, /CacheService\.getScriptCache\(\)\.put\(key, raw, 300\)/);
  assert.match(src, /let session = this\._getCachedSession\(tokenHash\)/);
  assert.match(src, /this\._putCachedSession\(tokenHash, session\)/);
  assert.match(src, /this\._deleteCachedSession\(tokenHash\)/);
});

test('all-session revocation evicts cached token hashes', () => {
  const src = source();
  const start = src.indexOf('revokeAllUserSessions(userId) {', src.indexOf('var MasterRepository'));
  const end = src.indexOf('/* ------------------- REQUESTS', start);
  const block = src.slice(start, end);
  assert.match(block, /SessionService\._deleteCachedSession\(s\.TokenHash\)/);
});


test('workspace access hot path is bounded and U cache is short-lived', () => {
  const src = source();
  const repoStart = src.indexOf('var MasterRepository');
  const accessStart = src.indexOf('getWorkspaceAccessForUser(userId)', repoStart);
  const accessEnd = src.indexOf('getWorkspaceAccessForWorkspace', accessStart);
  const accessBlock = src.slice(accessStart, accessEnd);

  assert.match(src, /findRowsByKey\(tabName, columnName, value/);
  assert.match(accessBlock, /findRowsByKey/);
  assert.doesNotMatch(accessBlock, /getTableData/);
  assert.match(src, /return 'U:' \+ String\(userId \|\| ''\)/);
  assert.match(src, /CacheService\.getScriptCache\(\)\.put\(key, raw, 60\)/);
  assert.match(src, /invalidateUserCache\(userId\)/);
});

test('revoke-all rotates account session epoch without scanning Sessions', () => {
  const src = source();
  const repoStart = src.indexOf('var MasterRepository');
  const start = src.indexOf('revokeAllUserSessions(userId) {', repoStart);
  const end = src.indexOf('/* ------------------- REQUESTS', start);
  const block = src.slice(start, end);

  assert.match(block, /return this\.bumpSessionEpoch\(userId\)/);
  assert.doesNotMatch(block, /getTableData/);
  assert.match(src, /AccountEpoch/);
  assert.match(src, /SessionEpoch/);
  assert.match(src, /sessionEpoch !== currentEpoch/);
});

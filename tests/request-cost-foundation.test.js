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


test('workspace access hot path is bounded and U cache is short-lived', () => {
  const src = source();
  const repoStart = src.indexOf('var MasterRepository');
  const accessStart = src.indexOf('  getWorkspaceAccessForUser(userId) {', repoStart);
  const accessEnd = src.indexOf('  getWorkspaceAccessForWorkspace(workspaceId) {', accessStart);
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


test('housekeeping retains invalid sessions for seven days then batch deletes contiguous rows', () => {
  const src = source();
  assert.match(src, /SESSION_RETENTION_DAYS:\s*7/);
  assert.match(src, /deleteRows\(tabName, startRow, howMany\)/);
  const start = src.indexOf('const purgeRows = refreshedSessions');
  const end = src.indexOf('// MFA challenges are one-per-user', start);
  const block = src.slice(start, end);
  assert.match(block, /MasterRepository\.deleteRows/);
  assert.doesNotMatch(block, /MasterRepository\.deleteRow\(/);
  assert.match(block, /purgeRows\[j\]\._rowIndex === low - 1/);
});


test('schema repair trims only unused sheet capacity and never populated extra columns', () => {
  const src = source();
  assert.match(src, /function trimSheetToSchema_\(sheet, columnCount, minimumRows = 1000\)/);
  assert.match(src, /lastColumn <= columnCount/);
  assert.match(src, /sheet\.deleteColumns\(columnCount \+ 1, columnsTrimmed\)/);
  assert.match(src, /const targetRows = Math\.max\(Number\(minimumRows\) \|\| 1000, lastRow\)/);
  assert.match(src, /trimSheetToSchema_\(sheet, columns\.length, 1000\)/);
});

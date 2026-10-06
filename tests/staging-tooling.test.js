'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { validateConfig, createBundle, validateReport, prepare, checkBundle } = require('../scripts/staging');

const config = {
  environment: 'STAGING',
  scriptId: 'staging-script-1234567890',
  productionScriptId: 'production-script-1234567890',
  projectId: 'flink-staging-123',
  account: 'flink-staging'
};

test('staging configuration rejects production, malformed IDs and unknown fields', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const changed of [
    { environment: 'PRODUCTION' },
    { scriptId: config.productionScriptId },
    { scriptId: '../escape' },
    { projectId: '--malicious' },
    { account: '../../credentials' },
    { extra: 'unexpected' }
  ]) {
    assert.throws(() => validateConfig({ ...config, ...changed }));
  }
});

test('staging bundle contains only runtime source plus private isolated diagnostics', () => {
  const bundle = createBundle(config);
  assert.deepEqual(Object.keys(bundle).sort(), [
    'Admin.html', 'Code.gs', 'RuntimeChecks.gs', 'SuperAdmin.html', 'User.html', 'appsscript.json'
  ]);
  const manifest = JSON.parse(bundle['appsscript.json']);
  assert.deepEqual(manifest.executionApi, { access: 'MYSELF' });
  assert.equal(manifest.oauthScopes.some(scope => scope.endsWith('/auth/script.projects')), false);
  assert.match(bundle['RuntimeChecks.gs'], /staging-script-1234567890/);
  const functions = [...bundle['RuntimeChecks.gs'].matchAll(/^function\s+(\w+)\(/gm)].map(m => m[1]);
  assert.ok(functions.length > 0);
  assert.ok(functions.every(name => name.endsWith('_')));
  assert.equal(bundle['Code.gs'], fs.readFileSync(path.resolve(__dirname, '../apps-script/Code.gs'), 'utf8'));
});

test('runtime diagnostics reject wrong script or existing application storage before work', () => {
  const source = createBundle(config)['RuntimeChecks.gs'];
  for (const state of [
    { scriptId: config.productionScriptId, property: null },
    { scriptId: config.scriptId, property: 'existing-master-book' }
  ]) {
    const context = vm.createContext({
      ScriptApp: { getScriptId: () => state.scriptId },
      PropertiesService: { getScriptProperties: () => ({ getProperty: () => state.property }) },
      SpreadsheetApp: { create: () => assert.fail('must not create a book') },
      SecurityService: { pbkdf2Sync: () => assert.fail('must not run crypto') }
    });
    vm.runInContext(source, context);
    assert.throws(() => vm.runInContext('runStagingChecks_()', context), /Staging target mismatch|Application storage must be absent/);
  }
});

test('live result validation rejects incomplete, failed and malformed measurements', () => {
  const valid = {
    environment: 'STAGING', suite: 'runtime-primitives',
    cryptoVectorPassed: true, cleanedUp: true,
    sheetLookups: [{ rows: 10, elapsedMs: 1, matched: true }, { rows: 5000, elapsedMs: 3, matched: true }],
    kdf: { results: [{ iterations: 10000, elapsedMs: 100 }] }
  };
  assert.deepEqual(validateReport(valid), valid);
  const withSecrets = { ...valid, token: 'DO-NOT-LOG', kdf: { ...valid.kdf, password: 'DO-NOT-LOG' } };
  assert.deepEqual(validateReport(withSecrets), valid);
  for (const changed of [
    { cryptoVectorPassed: false }, { cleanedUp: false }, { sheetLookups: [] },
    { kdf: { results: [{ iterations: 10000, elapsedMs: -1 }] } },
    { suite: 'all-application-tests' }
  ]) assert.throws(() => validateReport({ ...valid, ...changed }));
});

test('prepared bundle refuses overwrite, changed upload files and changed target', t => {
  const local = { ...config, scriptId: 'offline-staging-' + crypto.randomUUID() };
  const directory = prepare(local);
  t.after(() => fs.rmSync(directory, { recursive: true })); // exact directory created by this test
  assert.equal(checkBundle(local), directory);
  assert.throws(() => prepare(local), /EEXIST/);
  const sourceFile = path.join(directory, 'source', 'RuntimeChecks.gs');
  fs.appendFileSync(sourceFile, '\n// changed\n');
  assert.throws(() => checkBundle(local), /changed staging source/);
  fs.writeFileSync(sourceFile, createBundle(local)['RuntimeChecks.gs']);
  const settingsFile = path.join(directory, '.clasp.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  settings.scriptId = config.productionScriptId;
  fs.writeFileSync(settingsFile, JSON.stringify(settings));
  assert.throws(() => checkBundle(local), /target changed/);
});

test('runtime primitive checks measure both sizes and clean up only their own book', () => {
  const counts = [];
  const writes = [];
  let cleaned = false;
  const finder = {
    matchEntireCell: () => finder, matchCase: () => finder,
    useRegularExpression: () => finder, findNext: () => ({ getRow: () => writes.at(-1).length })
  };
  let rowCapacity = 1000;
  const sheet = {
    getMaxColumns: () => 26, deleteColumns: (start, count) => assert.deepEqual([start, count], [3, 24]),
    getMaxRows: () => rowCapacity, insertRowsAfter: (_, count) => { rowCapacity += count; },
    getRange: (row, col, count) => ({
      setValues: rows => writes.push(rows),
      createTextFinder: () => { counts.push(count); return finder; },
      getValues: () => [writes.at(-1)[row - 1]]
    })
  };
  const context = vm.createContext({
    ScriptApp: { getScriptId: () => config.scriptId },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    Utilities: { getUuid: () => 'synthetic-owned-book' },
    SpreadsheetApp: {
      create: name => { assert.equal(name, 'FLINK-STAGING-DIAGNOSTIC-synthetic-owned-book');
        return { getSheets: () => [sheet], getId: () => 'owned-book-id' }; },
      flush: () => {}
    },
    DriveApp: { getFileById: id => {
      assert.equal(id, 'owned-book-id');
      return { getName: () => 'FLINK-STAGING-DIAGNOSTIC-synthetic-owned-book',
        setTrashed: value => { assert.equal(value, true); cleaned = true; } };
    } },
    SecurityService: { pbkdf2Sync: () => 'ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43' },
    benchmarkPasswordKdf_: () => ({ results: [{ iterations: 10000, elapsedMs: 100 }] })
  });
  vm.runInContext(createBundle(config)['RuntimeChecks.gs'], context);
  const result = JSON.parse(JSON.stringify(vm.runInContext('runStagingChecks_()', context)));
  assert.equal(cleaned, true);
  assert.deepEqual(counts, [10, 5000]);
  assert.equal(validateReport(result).cleanedUp, true);
});

test('staging refuses altered ignore patterns before starting clasp', t => {
  const local = { ...config, scriptId: 'offline-staging-' + crypto.randomUUID() };
  const directory = prepare(local);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(directory, '.claspignore'), '{{untrusted-pattern}}');
  assert.throws(() => checkBundle(local), /ignore rules/);
});

test('clasp invocation pins project and ignore paths despite environment overrides', () => {
  let invocation;
  const source = fs.readFileSync(path.resolve(__dirname, '../scripts/staging.js'), 'utf8');
  const directory = path.resolve(__dirname, '../.staging/synthetic-target');
  const context = vm.createContext({
    __dirname: path.resolve(__dirname, '../scripts'),
    module: { exports: {} }, console,
    process: { execPath: process.execPath, env: { clasp_config_project: 'OTHER', clasp_config_ignore: 'UNTRUSTED' } },
    require(name) {
      if (name === 'node:child_process') return { spawnSync(_program, args, options) {
        invocation = { args: Array.from(args), cwd: options.cwd, shell: options.shell };
        return { status: 0 };
      } };
      return require(name);
    },
    directory, config
  });
  vm.runInContext(source, context);
  vm.runInContext("clasp(directory, config, ['show-file-status'])", context);
  const valueOf = flag => invocation.args[invocation.args.indexOf(flag) + 1];
  assert.equal(valueOf('--project'), path.join(directory, '.clasp.json'));
  assert.equal(valueOf('--ignore'), path.join(directory, '.claspignore'));
  assert.equal(invocation.cwd, directory);
  assert.equal(invocation.shell, false);
});

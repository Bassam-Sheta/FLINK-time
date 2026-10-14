'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { validateConfig, createBundle, validateReport, prepare, checkBundle, executeOperation } = require('../scripts/staging');

const config = {
  environment: 'STAGING',
  scriptId: 'staging-script-1234567890',
  productionScriptId: 'production-script-1234567890',
  projectId: 'flink-staging-123',
  accountEmail: 'owner@example.test',
  oauthClientId: '123456-synthetic.apps.googleusercontent.com'
};

test('staging configuration rejects production, malformed IDs and unknown fields', () => {
  assert.deepEqual(validateConfig(config), config);
  for (const changed of [
    { environment: 'PRODUCTION' },
    { scriptId: config.productionScriptId },
    { scriptId: '../escape' },
    { projectId: '--malicious' },
    { accountEmail: 'invalid' },
    { oauthClientId: 'https://attacker.example' },
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
  const settingsFile = path.join(directory, 'target.json');
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

test('staging ignores obsolete clasp settings and uploads only the checked allowlist', async t => {
  const local = { ...config, scriptId: 'offline-staging-' + crypto.randomUUID() };
  const directory = prepare(local);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.writeFileSync(path.join(directory, '.claspignore'), '{'.repeat(20000));
  fs.writeFileSync(path.join(directory, '.clasp.json'), JSON.stringify({ scriptId: config.productionScriptId }));
  const calls = [];
  const clientFactory = () => ({ async request(options) {
    calls.push(options);
    if (options.method === 'GET') return { data: { email: config.accountEmail, verified_email: true } };
    return { data: { scriptId: local.scriptId, files: options.data.files } };
  } });
  const result = await executeOperation('push', local, { confirmed: true, clientFactory,
    env: { clasp_config_project: 'PRODUCTION', clasp_config_ignore: 'UNTRUSTED' } });
  assert.equal(result, 'Staging upload verified.');
  assert.equal(calls[1].url, `https://script.googleapis.com/v1/projects/${local.scriptId}/content`);
  const files = calls[1].data.files;
  assert.equal(files.length, 6);
  assert.deepEqual(files.map(file => file.type), ['SERVER_JS', 'HTML', 'HTML', 'HTML', 'JSON', 'SERVER_JS']);
  assert.equal(files.find(file => file.name === 'Code').source, createBundle(local)['Code.gs']);
  assert.equal(files.find(file => file.name === 'appsscript').source, createBundle(local)['appsscript.json']);
});

test('unconfirmed mutations and changed bundles never load credentials or call Google', async t => {
  const local = { ...config, scriptId: 'offline-staging-' + crypto.randomUUID() };
  const directory = prepare(local);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const clientFactory = () => assert.fail('must not load credentials');
  for (const operation of ['push', 'run']) {
    await assert.rejects(executeOperation(operation, local, { clientFactory }), /confirm-staging/);
  }
  const check = await executeOperation('check', local, { clientFactory });
  assert.equal(check.files.length, 6);
  const scopes = await executeOperation('scopes', local, { clientFactory });
  assert.ok(scopes.split(',').includes('https://www.googleapis.com/auth/script.projects'));
  fs.appendFileSync(path.join(directory, 'source', 'Code.gs'), '\n// unverified change');
  await assert.rejects(executeOperation('push', local, { confirmed: true, clientFactory }), /changed staging source/);
});

test('only complete valid runtime reports create new sanitized evidence files', async t => {
  const local = { ...config, scriptId: 'offline-staging-' + crypto.randomUUID() };
  const directory = prepare(local);
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const deploymentId = 'synthetic-api-deployment-12345';
  const report = { environment: 'STAGING', suite: 'runtime-primitives', cryptoVectorPassed: true, cleanedUp: true,
    sheetLookups: [{ rows: 10, elapsedMs: 1, matched: true }, { rows: 5000, elapsedMs: 2, matched: true }],
    kdf: { results: [{ iterations: 10000, elapsedMs: 100 }] } };
  let response = { done: true, error: { message: 'PRIVATE' } };
  const clientFactory = () => ({ async request(options) {
    if (options.url.endsWith('/userinfo')) return { data: { email: local.accountEmail, verified_email: true } };
    if (options.method === 'GET') return { data: { deploymentId, deploymentConfig: { scriptId: local.scriptId },
      entryPoints: [{ entryPointType: 'EXECUTION_API', executionApi: { entryPointConfig: { access: 'MYSELF' } } }] } };
    return { data: response };
  } });
  const options = { confirmed: true, clientFactory, env: { FLINK_STAGING_DEPLOYMENT_ID: deploymentId } };
  await assert.rejects(executeOperation('run', local, options), /Google runtime/);
  assert.equal(fs.readdirSync(directory).some(file => file.startsWith('runtime-results-')), false);
  response = { done: true, response: { result: { ...report, cleanedUp: false } } };
  await assert.rejects(executeOperation('run', local, options), /Incomplete or failed/);
  response = { done: true, response: { result: { ...report, token: 'PRIVATE' } } };
  await executeOperation('run', local, options);
  await executeOperation('run', local, options);
  const evidence = fs.readdirSync(directory).filter(file => file.startsWith('runtime-results-'));
  assert.equal(evidence.length, 2);
  for (const file of evidence) assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, file))), report);
});

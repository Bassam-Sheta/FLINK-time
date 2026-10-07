'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['Code.gs', 'User.html', 'Admin.html', 'SuperAdmin.html', 'appsscript.json'];

function validateConfig(config) {
  const keys = ['environment', 'scriptId', 'productionScriptId', 'projectId', 'accountEmail', 'oauthClientId'];
  if (!config || Object.keys(config).some(key => !keys.includes(key)) ||
      keys.some(key => typeof config[key] !== 'string')) throw new Error('Invalid staging configuration');
  if (config.environment !== 'STAGING') throw new Error('Only STAGING is permitted');
  for (const key of ['scriptId', 'productionScriptId']) {
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(config[key]) || /REPLACE|YOUR_|PLACEHOLDER/i.test(config[key])) {
      throw new Error('Invalid ' + key);
    }
  }
  if (config.scriptId === config.productionScriptId) throw new Error('Production target refused');
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(config.projectId)) throw new Error('Invalid projectId');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.accountEmail)) throw new Error('Invalid accountEmail');
  if (!/^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(config.oauthClientId) ||
      /REPLACE|YOUR_|PLACEHOLDER/i.test(config.oauthClientId)) throw new Error('Invalid oauthClientId');
  return config;
}

function createBundle(config) {
  validateConfig(config);
  const bundle = {};
  for (const file of runtimeFiles) {
    const target = path.join(root, 'apps-script', file);
    if (!fs.lstatSync(target).isFile()) throw new Error('Runtime source must be a regular file');
    bundle[file] = fs.readFileSync(target, 'utf8');
  }
  const manifest = JSON.parse(bundle['appsscript.json']);
  manifest.executionApi = { access: 'MYSELF' };
  bundle['appsscript.json'] = JSON.stringify(manifest, null, 2) + '\n';
  bundle['RuntimeChecks.gs'] = fs.readFileSync(path.join(__dirname, 'staging', 'RuntimeChecks.gs'), 'utf8')
    .replace('__STAGING_SCRIPT_ID__', config.scriptId);
  return bundle;
}

function validateReport(report) {
  if (!report || report.environment !== 'STAGING' || report.suite !== 'runtime-primitives' ||
      report.cryptoVectorPassed !== true || report.cleanedUp !== true ||
      !Array.isArray(report.sheetLookups) || report.sheetLookups.length !== 2 ||
      report.sheetLookups.some((row, i) => row.rows !== [10, 5000][i] || row.matched !== true ||
        !Number.isFinite(row.elapsedMs) || row.elapsedMs < 0) ||
      !report.kdf || !Array.isArray(report.kdf.results) || !report.kdf.results.length ||
      report.kdf.results.some(row => !Number.isInteger(row.iterations) || row.iterations < 10000 ||
        !Number.isFinite(row.elapsedMs) || row.elapsedMs <= 0)) {
    throw new Error('Incomplete or failed runtime measurements');
  }
  // Explicit response projection: an unexpected runtime field must not leak
  // identities, tokens or arbitrary debug data into local evidence/logs.
  const safe = {
    environment: 'STAGING', suite: 'runtime-primitives',
    cryptoVectorPassed: true, cleanedUp: true,
    sheetLookups: report.sheetLookups.map(row => ({
      rows: row.rows, elapsedMs: row.elapsedMs, matched: true
    })),
    kdf: { results: report.kdf.results.map(row => ({
      iterations: row.iterations, elapsedMs: row.elapsedMs
    })) }
  };
  for (const key of ['targetMs', 'currentIterations', 'recommendedIterations']) {
    if (Number.isFinite(report.kdf[key])) safe.kdf[key] = report.kdf[key];
  }
  if (typeof report.measuredAtUTC === 'string' &&
      /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(report.measuredAtUTC)) safe.measuredAtUTC = report.measuredAtUTC;
  return safe;
}

function digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function assertDirectory(directory) {
  if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Staging directory must not be a link');
  }
}

function prepare(config) {
  validateConfig(config);
  const bundle = createBundle(config);
  const staging = path.join(root, '.staging');
  if (!fs.existsSync(staging)) fs.mkdirSync(staging);
  assertDirectory(staging);
  const directory = path.join(staging, config.scriptId);
  // Refuse to overwrite a previous bundle or unrelated files.
  fs.mkdirSync(directory);
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const hashes = {};
  for (const [file, text] of Object.entries(bundle)) {
    fs.writeFileSync(path.join(source, file), text, { flag: 'wx' });
    hashes[file] = digest(text);
  }
  fs.writeFileSync(path.join(directory, 'target.json'), JSON.stringify({
    scriptId: config.scriptId, projectId: config.projectId, environment: 'STAGING'
  }, null, 2), { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify({
    config, hashes, createdAt: new Date().toISOString()
  }, null, 2), { flag: 'wx' });
  return directory;
}

function checkedBundle(config) {
  validateConfig(config);
  const directory = path.join(root, '.staging', config.scriptId);
  for (const dir of [path.join(root, '.staging'), directory, path.join(directory, 'source')]) {
    assertDirectory(dir);
  }
  const readFile = file => {
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Staging files must be regular files');
    return fs.readFileSync(file, 'utf8');
  };
  const readJson = file => {
    const text = readFile(path.join(directory, file));
    try { return JSON.parse(text); }
    catch (_) { throw new Error('Invalid staging bundle metadata'); }
  };
  const record = readJson('bundle.json');
  if (JSON.stringify(record.config) !== JSON.stringify(config)) throw new Error('Staging config changed; prepare a new bundle');
  const settings = readJson('target.json');
  if (settings.scriptId !== config.scriptId || settings.projectId !== config.projectId || settings.environment !== 'STAGING') {
    throw new Error('Staging target changed');
  }
  const bundle = createBundle(config);
  const actualFiles = fs.readdirSync(path.join(directory, 'source')).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(bundle).sort())) throw new Error('Unexpected upload files');
  for (const [file, text] of Object.entries(bundle)) {
    const target = path.join(directory, 'source', file);
    if (digest(readFile(target)) !== record.hashes[file] ||
        digest(text) !== record.hashes[file]) throw new Error('Stale or changed staging source');
  }
  return { directory, bundle };
}

function checkBundle(config) {
  return checkedBundle(config).directory;
}

async function executeOperation(operation, config, { confirmed = false, env = process.env, clientFactory } = {}) {
  validateConfig(config);
  if (!['prepare', 'check', 'scopes', 'push', 'run'].includes(operation)) {
    throw new Error('Usage: npm run staging -- prepare|check|scopes|push|run [--confirm-staging]');
  }
  if (operation === 'scopes') {
    return [...new Set([...JSON.parse(createBundle(config)['appsscript.json']).oauthScopes,
      'https://www.googleapis.com/auth/script.projects', 'https://www.googleapis.com/auth/script.deployments.readonly'])].join(',');
  }
  if (operation === 'prepare') {
    prepare(config);
    return 'Local staging bundle prepared. Nothing uploaded.';
  }
  const { directory, bundle } = checkedBundle(config);
  if (operation === 'check') {
    return { environment: 'STAGING', scriptId: config.scriptId, files: Object.keys(bundle) };
  }
  if (!confirmed) throw new Error('Explicit --confirm-staging required');
  const { loadCredentials, makeClient, createGoogleStaging } = require('./staging-google');
  const client = clientFactory ? clientFactory() : makeClient(loadCredentials(env.FLINK_STAGING_CREDENTIALS, config));
  const api = createGoogleStaging(config, client);
  if (operation === 'push') {
    const files = Object.entries(bundle).map(([file, source]) => ({
      name: file.slice(0, file.lastIndexOf('.')), source,
      type: file.endsWith('.gs') ? 'SERVER_JS' : file.endsWith('.html') ? 'HTML' : 'JSON'
    }));
    await api.push(files);
    return 'Staging upload verified.';
  }
  const report = validateReport(await api.run(env.FLINK_STAGING_DEPLOYMENT_ID));
  // Each success owns a new evidence file; never follow/overwrite an existing link.
  const evidence = path.join(directory, 'runtime-results-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(evidence, JSON.stringify(report, null, 2), { flag: 'wx' });
  return report;
}

async function main() {
  const file = path.join(root, '.staging.config.json');
  if (!fs.existsSync(file)) throw new Error('Staging is not configured. See docs/STAGING_TESTS.md; no Google calls made.');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { throw new Error('Invalid staging configuration JSON'); }
  const result = await executeOperation(process.argv[2], config, { confirmed: process.argv.includes('--confirm-staging') });
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
}

module.exports = { validateConfig, createBundle, validateReport, prepare, checkBundle, executeOperation };
if (require.main === module) {
  main().catch(err => { console.error(err.message); process.exitCode = 1; });
}

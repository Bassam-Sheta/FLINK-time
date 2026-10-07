'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const runtimeFiles = ['Code.gs', 'User.html', 'Admin.html', 'SuperAdmin.html', 'appsscript.json'];

function validateConfig(config) {
  const keys = ['environment', 'scriptId', 'productionScriptId', 'projectId', 'account'];
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
  if (!/^[a-z][a-z0-9-]{0,50}$/.test(config.account)) throw new Error('Invalid account');
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
  const staging = path.join(root, '.staging');
  if (!fs.existsSync(staging)) fs.mkdirSync(staging);
  assertDirectory(staging);
  const directory = path.join(staging, config.scriptId);
  // Refuse to overwrite a previous bundle or unrelated files.
  fs.mkdirSync(directory);
  const source = path.join(directory, 'source');
  fs.mkdirSync(source);
  const bundle = createBundle(config);
  const hashes = {};
  for (const [file, text] of Object.entries(bundle)) {
    fs.writeFileSync(path.join(source, file), text, { flag: 'wx' });
    hashes[file] = digest(text);
  }
  fs.writeFileSync(path.join(directory, '.clasp.json'), JSON.stringify({
    scriptId: config.scriptId, projectId: config.projectId, rootDir: './source'
  }, null, 2), { flag: 'wx' });
  // The source directory already has an exact file allowlist. No glob patterns
  // are needed, and untrusted patterns must never reach clasp's matcher.
  fs.writeFileSync(path.join(directory, '.claspignore'), '', { flag: 'wx' });
  fs.writeFileSync(path.join(directory, 'bundle.json'), JSON.stringify({
    config, hashes, createdAt: new Date().toISOString()
  }, null, 2), { flag: 'wx' });
  return directory;
}

function checkBundle(config) {
  const directory = path.join(root, '.staging', config.scriptId);
  for (const dir of [path.join(root, '.staging'), directory, path.join(directory, 'source')]) {
    assertDirectory(dir);
  }
  const record = JSON.parse(fs.readFileSync(path.join(directory, 'bundle.json'), 'utf8'));
  if (JSON.stringify(record.config) !== JSON.stringify(config)) throw new Error('Staging config changed; prepare a new bundle');
  const ignoreFile = path.join(directory, '.claspignore');
  if (!fs.existsSync(ignoreFile) || !fs.lstatSync(ignoreFile).isFile() ||
      fs.lstatSync(ignoreFile).isSymbolicLink() || fs.readFileSync(ignoreFile, 'utf8') !== '') {
    throw new Error('Staging ignore rules must be the generated empty file');
  }
  const settings = JSON.parse(fs.readFileSync(path.join(directory, '.clasp.json'), 'utf8'));
  if (settings.scriptId !== config.scriptId || settings.projectId !== config.projectId || settings.rootDir !== './source') {
    throw new Error('Clasp target changed');
  }
  const bundle = createBundle(config);
  const actualFiles = fs.readdirSync(path.join(directory, 'source')).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(Object.keys(bundle).sort())) throw new Error('Unexpected upload files');
  for (const [file, text] of Object.entries(bundle)) {
    const target = path.join(directory, 'source', file);
    if (!fs.lstatSync(target).isFile() || digest(fs.readFileSync(target)) !== record.hashes[file] ||
        digest(text) !== record.hashes[file]) throw new Error('Stale or changed staging source');
  }
  return directory;
}

function clasp(directory, config, args, capture = false) {
  const cli = path.join(root, 'node_modules', '@google', 'clasp', 'build', 'src', 'index.js');
  const result = spawnSync(process.execPath, [cli, '--user', config.account,
    '--project', path.join(directory, '.clasp.json'),
    '--ignore', path.join(directory, '.claspignore'), ...args], {
    cwd: directory, shell: false, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', timeout: 420000
  });
  if (result.error || result.status !== 0) throw new Error('Clasp failed; inspect authorization and staging setup');
  return capture ? JSON.parse(result.stdout) : undefined;
}

function main() {
  const operation = process.argv[2];
  if (!['prepare', 'check', 'push', 'run'].includes(operation)) {
    throw new Error('Usage: npm run staging -- prepare|check|push|run [--confirm-staging]');
  }
  const file = path.join(root, '.clasp-staging.json');
  if (!fs.existsSync(file)) throw new Error('Staging is not configured. See docs/STAGING_TESTS.md; no Google calls made.');
  const config = validateConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (operation === 'prepare') {
    prepare(config);
    console.log('Local staging bundle prepared. Nothing uploaded.');
    return;
  }
  const directory = checkBundle(config);
  if (operation === 'check') {
    clasp(directory, config, ['show-file-status']);
    return;
  }
  if (!process.argv.includes('--confirm-staging')) throw new Error('Explicit --confirm-staging required');
  if (operation === 'push') {
    clasp(directory, config, ['push']);
  } else {
    const result = clasp(directory, config, ['--json', 'run-function', 'runStagingChecks_'], true);
    // Clasp can return HTTP success/exit 0 with an Apps Script execution error.
    if (result.error) throw new Error('Google runtime reported a test error; no passing report recorded');
    const report = validateReport(result.response);
    fs.writeFileSync(path.join(directory, 'runtime-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

module.exports = { validateConfig, createBundle, validateReport, prepare, checkBundle };
if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exitCode = 1; }
}

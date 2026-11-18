'use strict';

// T1.12 — `scripts/staging.js --app v2`: the upload bundle for apps-script-v2 (files.json order, the manifest rendered
// with the staging database's origin) and the same safety rules as the old path: only a STAGING target, never the
// production script, nothing uploaded without --confirm-staging, a prepared bundle that must still match its sources.
// The old path's own tests (tests/staging-*.test.js) stay as they are and must stay green.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  validateConfig, validateConfigV2, createBundle, createBundleV2, parseArgs, prepare, checkBundle, executeOperation, readiness,
} = require('../../scripts/staging');

const ROOT = path.resolve(__dirname, '..', '..');
const APP = path.join(ROOT, 'apps-script-v2');

// Made-up values (BUILD_SPEC section 0, rule 6).
const config = {
  environment: 'STAGING',
  scriptId: 'staging-script-1234567890',
  productionScriptId: 'production-script-1234567890',
  projectId: 'flink-staging-123',
  accountEmail: 'owner@example.test',
  oauthClientId: '123456-synthetic.apps.googleusercontent.com',
  tursoOrigin: 'https://example-db.turso.io',
};
const filesJson = () => JSON.parse(fs.readFileSync(path.join(APP, 'files.json'), 'utf8'));

// ---------------------------------------------------------------- arguments

test('parseArgs: --app v2 or --app=v2 anywhere, one operation, --confirm-staging', () => {
  assert.deepEqual(parseArgs(['--app', 'v2', 'prepare']), { app: 'v2', operation: 'prepare', confirmed: false });
  assert.deepEqual(parseArgs(['push', '--app=v2', '--confirm-staging']), { app: 'v2', operation: 'push', confirmed: true });
  assert.deepEqual(parseArgs(['check']), { app: 'v1', operation: 'check', confirmed: false }, 'the old path is the default');
  assert.deepEqual(parseArgs(['--app', 'v1', 'doctor']), { app: 'v1', operation: 'doctor', confirmed: false });
  assert.deepEqual(parseArgs([]), { app: 'v1', operation: undefined, confirmed: false });
});

test('parseArgs refuses an unknown app, a missing value, an unknown option and a second operation', () => {
  for (const argv of [['--app', 'v3', 'check'], ['--app'], ['--app=', 'check'], ['--app=V2', 'check'], ['--wat', 'check'], ['check', 'push']]) {
    assert.throws(() => parseArgs(argv), undefined, JSON.stringify(argv));
  }
});

// ---------------------------------------------------------------- configuration

test('validateConfigV2 accepts the v1 fields plus a tursoOrigin', () => {
  assert.equal(validateConfigV2(config), config);
  assert.doesNotThrow(() => validateConfigV2({ ...config, tursoOrigin: 'https://db-org.turso.io:8443' }));
});

test('validateConfigV2 refuses a bad or placeholder origin, production, and unknown fields', () => {
  const origins = [undefined, null, 5, '', 'example-db.turso.io', 'http://example-db.turso.io', 'libsql://example-db.turso.io',
    'https://example-db.turso.io/', 'https://example-db.turso.io/path', 'https://example-db.turso.io?x=1', 'https://user@example-db.turso.io',
    'https://EXAMPLE-db.turso.io', 'https://localhost', 'https://-bad.turso.io', 'https://example-db.turso.io:99999',
    'https://REPLACE-with-staging-database.turso.io', 'https://replace-with-db.turso.io', 'https://placeholder.turso.io', 'https://your_db.turso.io', 'https://x y.turso.io'];
  for (const tursoOrigin of origins) assert.throws(() => validateConfigV2({ ...config, tursoOrigin }), /tursoOrigin/, String(tursoOrigin));
  for (const changed of [{ environment: 'PRODUCTION' }, { scriptId: config.productionScriptId }, { scriptId: '../escape' },
    { projectId: '--malicious' }, { accountEmail: 'invalid' }, { oauthClientId: 'https://attacker.example' }, { extra: 'x' }]) {
    assert.throws(() => validateConfigV2({ ...config, ...changed }), undefined, JSON.stringify(changed));
  }
  for (const bad of [null, undefined, 'text', [], 5]) assert.throws(() => validateConfigV2(bad));
});

test('the old path still refuses a configuration with a tursoOrigin: the two configurations are separate files', () => {
  assert.throws(() => validateConfig(config));
  const { tursoOrigin, ...v1 } = config;
  assert.equal(tursoOrigin, 'https://example-db.turso.io');
  assert.doesNotThrow(() => validateConfig(v1));
});

test('the example configuration is all placeholders, so it can never be used as it stands', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'staging.v2.config.example.json'), 'utf8'));
  assert.deepEqual(Object.keys(example).sort(), Object.keys(config).sort());
  assert.throws(() => validateConfigV2(example));
  assert.ok(fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).includes('.staging.v2.config.json'));
});

// ---------------------------------------------------------------- the bundle

test('the bundle is the manifest first, then every file of files.json in its order', () => {
  const bundle = createBundleV2(config);
  assert.deepEqual(Object.keys(bundle), ['appsscript.json', ...filesJson()]);
  for (const name of filesJson()) assert.equal(bundle[name], fs.readFileSync(path.join(APP, name), 'utf8'), name);
  assert.equal(Object.keys(bundle).length, 22);
});

test('createBundle(config, "v2") is the same bundle, and the default is still the old app', () => {
  assert.deepEqual(createBundle(config, 'v2'), createBundleV2(config));
  const { tursoOrigin, ...v1 } = config;
  assert.ok(tursoOrigin);
  assert.deepEqual(Object.keys(createBundle(v1)).sort(), ['Code.gs', 'Portal.html', 'RuntimeChecks.gs', 'appsscript.json']);
});

test('the manifest is the template with the origin as the only URL fetch may reach, and nothing else changed', () => {
  const manifest = JSON.parse(createBundleV2(config)['appsscript.json']);
  assert.deepEqual(manifest.urlFetchWhitelist, ['https://example-db.turso.io/']);
  const template = JSON.parse(fs.readFileSync(path.join(APP, 'appsscript.template.json'), 'utf8'));
  template.urlFetchWhitelist = ['https://example-db.turso.io/'];
  assert.deepEqual(manifest, template);
  assert.equal('executionApi' in manifest, false, 'no remote execution is added: the owner runs runMigrations in the editor');
  assert.deepEqual(manifest.webapp, { access: 'DOMAIN', executeAs: 'USER_DEPLOYING' });
  assert.ok(createBundleV2(config)['appsscript.json'].endsWith('\n'));
});

test('the origin appears only in the manifest, and no placeholder is left anywhere', () => {
  const bundle = createBundleV2(config);
  for (const [name, text] of Object.entries(bundle)) {
    assert.ok(!text.includes('{{'), `${name} still holds a placeholder`);
    if (name !== 'appsscript.json') assert.ok(!text.includes(config.tursoOrigin), `${name} holds the staging origin`);
  }
});

test('the bundle changes with the origin and with nothing else', () => {
  const other = createBundleV2({ ...config, tursoOrigin: 'https://another-db.turso.io' });
  const base = createBundleV2(config);
  for (const name of Object.keys(base)) {
    if (name === 'appsscript.json') assert.notEqual(other[name], base[name]);
    else assert.equal(other[name], base[name], name);
  }
});

// A copy of apps-script-v2 in a temporary directory, to be damaged on purpose.
function layout(t, edit) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'flink-v2-layout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of [...filesJson(), 'files.json', 'appsscript.template.json']) fs.copyFileSync(path.join(APP, name), path.join(directory, name));
  if (edit) edit(directory);
  return directory;
}
const bundleOf = directory => createBundleV2(config, { appDirectory: directory });

test('a layout copy with nothing changed bundles like the real one', t => {
  assert.deepEqual(bundleOf(layout(t)), createBundleV2(config));
});

test('files.json must be a non-empty list of distinct .gs or .html names with no path', t => {
  const write = (directory, value) => fs.writeFileSync(path.join(directory, 'files.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const bad = [[], {}, 'not json', 5, null, ['Config.gs', 'Config.gs'], ['../Config.gs'], ['sub/Config.gs'], ['Config.txt'], ['.gs'], ['Config.js'],
    ['Config.gs', 7], ['appsscript.json'], ['Config.gs\n']];
  for (const value of bad) {
    const directory = layout(t, d => write(d, value));
    assert.throws(() => bundleOf(directory), /Invalid files\.json/, JSON.stringify(value));
  }
  assert.throws(() => bundleOf(layout(t, d => fs.rmSync(path.join(d, 'files.json')))), /Invalid files\.json/);
});

test('a listed file that is missing stops the bundle, and a file that is not listed is not uploaded', t => {
  assert.throws(() => bundleOf(layout(t, d => fs.rmSync(path.join(d, 'Util.gs')))), /ENOENT/);
  const extra = layout(t, d => fs.writeFileSync(path.join(d, 'Stray.gs'), 'function stray_() {}'));
  assert.ok(!('Stray.gs' in bundleOf(extra)));
});

test('the manifest template must hold {{TURSO_ORIGIN}} exactly once and render to valid JSON', t => {
  const write = (directory, text) => fs.writeFileSync(path.join(directory, 'appsscript.template.json'), text);
  assert.throws(() => bundleOf(layout(t, d => write(d, '{"urlFetchWhitelist": []}'))), /exactly once/);
  assert.throws(() => bundleOf(layout(t, d => write(d, '{"a": ["{{TURSO_ORIGIN}}/", "{{TURSO_ORIGIN}}/"]}'))), /exactly once/);
  assert.throws(() => bundleOf(layout(t, d => write(d, '{"a": {{TURSO_ORIGIN}}'))), /not valid JSON/);
  assert.throws(() => bundleOf(layout(t, d => fs.rmSync(path.join(d, 'appsscript.template.json')))), /ENOENT/);
});

test('a listed file that is a link is refused (simulated, so it holds on every system)', t => {
  const directory = layout(t);
  const real = fs.lstatSync;
  fs.lstatSync = (file, ...rest) => {
    const stat = real(file, ...rest);
    return String(file).endsWith('Util.gs') ? { isFile: () => true, isSymbolicLink: () => true, size: stat.size } : stat;
  };
  t.after(() => { fs.lstatSync = real; });
  assert.throws(() => bundleOf(directory), /regular file/);
  fs.lstatSync = real;
});

test('a listed file that is a real link is refused (where the system lets the test make one)', t => {
  let linked = false;
  const directory = layout(t, d => {
    fs.rmSync(path.join(d, 'Util.gs'));
    try {
      fs.symlinkSync(path.join(APP, 'Util.gs'), path.join(d, 'Util.gs'));
      linked = true;
    } catch (err) {
      // creating a link needs a privilege on some systems
    }
  });
  if (!linked) { t.skip('this system does not let the test make a link'); return; }
  assert.throws(() => bundleOf(directory), /regular file/);
});

// ---------------------------------------------------------------- prepare and check

test('a prepared v2 bundle sits next to, not inside, a v1 one, refuses overwrite, and notices any change', t => {
  const local = { ...config, scriptId: 'offline-v2-staging-' + crypto.randomUUID() };
  const directory = prepare(local, 'v2');
  t.after(() => fs.rmSync(directory, { recursive: true }));
  assert.equal(path.basename(directory), 'v2-' + local.scriptId);
  assert.equal(fs.existsSync(path.join(ROOT, '.staging', local.scriptId)), false, 'no v1 directory was made');
  assert.equal(checkBundle(local, 'v2'), directory);
  assert.deepEqual(fs.readdirSync(path.join(directory, 'source')).sort(), Object.keys(createBundleV2(local)).sort());
  assert.throws(() => prepare(local, 'v2'), /EEXIST/);

  const util = path.join(directory, 'source', 'Util.gs');
  const original = fs.readFileSync(util, 'utf8');
  fs.appendFileSync(util, '\n// changed\n');
  assert.throws(() => checkBundle(local, 'v2'), /changed staging source/);
  fs.writeFileSync(util, original);
  assert.equal(checkBundle(local, 'v2'), directory);

  assert.throws(() => checkBundle({ ...local, tursoOrigin: 'https://another-db.turso.io' }, 'v2'), /config changed/);

  const settingsFile = path.join(directory, 'target.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  fs.writeFileSync(settingsFile, JSON.stringify({ ...settings, scriptId: config.productionScriptId }));
  assert.throws(() => checkBundle(local, 'v2'), /target changed/);
  fs.writeFileSync(settingsFile, JSON.stringify(settings));

  fs.writeFileSync(path.join(directory, 'source', 'Extra.gs'), 'function extra_() {}');
  assert.throws(() => checkBundle(local, 'v2'), /Unexpected upload files/);
});

// ---------------------------------------------------------------- operations

test('scopes for v2 are the manifest scopes plus the two the tool itself needs', async () => {
  const scopes = (await executeOperation('scopes', config, { app: 'v2' })).split(',');
  const manifest = JSON.parse(createBundleV2(config)['appsscript.json']);
  assert.deepEqual(scopes, [...manifest.oauthScopes, 'https://www.googleapis.com/auth/script.projects',
    'https://www.googleapis.com/auth/script.deployments.readonly']);
});

test('the remote run is v1 only: v2 has no runtime check and says what to do instead', async () => {
  await assert.rejects(executeOperation('run', config, { app: 'v2', confirmed: true }), /runMigrations/);
});

test('v2 refuses an unknown operation, a production target and a v1 configuration', async () => {
  await assert.rejects(executeOperation('deploy', config, { app: 'v2' }), /Usage/);
  await assert.rejects(executeOperation('check', { ...config, scriptId: config.productionScriptId }, { app: 'v2' }));
  const { tursoOrigin, ...v1 } = config;
  assert.ok(tursoOrigin);
  await assert.rejects(executeOperation('scopes', v1, { app: 'v2' }), /tursoOrigin/);
});

test('push for v2 needs --confirm-staging, then sends the files in order with the manifest first, and verifies them', async t => {
  const local = { ...config, scriptId: 'offline-v2-push-' + crypto.randomUUID() };
  const directory = prepare(local, 'v2');
  t.after(() => fs.rmSync(directory, { recursive: true }));

  await assert.rejects(executeOperation('push', local, { app: 'v2' }), /--confirm-staging/);

  const calls = [];
  const client = {
    async request(options) {
      calls.push(options);
      if (options.url === 'https://www.googleapis.com/oauth2/v2/userinfo') return { data: { email: local.accountEmail, verified_email: true } };
      assert.equal(options.method, 'PUT');
      assert.equal(options.url, `https://script.googleapis.com/v1/projects/${local.scriptId}/content`);
      return { data: { scriptId: local.scriptId, files: options.data.files } };
    },
  };
  const result = await executeOperation('push', local, { app: 'v2', confirmed: true, clientFactory: () => client });
  assert.equal(result, 'Staging upload verified.');

  const put = calls.find(call => call.method === 'PUT');
  const bundle = createBundleV2(local);
  assert.deepEqual(put.data.files.map(file => file.name), ['appsscript', ...filesJson().map(name => name.replace(/\.[^.]+$/, ''))]);
  assert.deepEqual(put.data.files.map(file => file.type), ['JSON', ...filesJson().map(name => (name.endsWith('.html') ? 'HTML' : 'SERVER_JS'))]);
  put.data.files.forEach((file, index) => assert.equal(file.source, Object.values(bundle)[index]));
  assert.ok(put.data.files[0].source.includes(local.tursoOrigin + '/'));
  assert.ok(!JSON.stringify(put.data).includes('test-rw'));
});

test('a push is refused when the prepared bundle is stale, and nothing is sent', async t => {
  const local = { ...config, scriptId: 'offline-v2-stale-' + crypto.randomUUID() };
  const directory = prepare(local, 'v2');
  t.after(() => fs.rmSync(directory, { recursive: true }));
  fs.appendFileSync(path.join(directory, 'source', 'Main.gs'), '\n// changed\n');
  const client = { async request() { assert.fail('nothing may be sent'); } };
  await assert.rejects(executeOperation('push', local, { app: 'v2', confirmed: true, clientFactory: () => client }), /changed staging source/);
});

test('check for v2 lists the files in upload order', async t => {
  const local = { ...config, scriptId: 'offline-v2-check-' + crypto.randomUUID() };
  const directory = prepare(local, 'v2');
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const checked = await executeOperation('check', local, { app: 'v2' });
  assert.deepEqual(checked, { environment: 'STAGING', scriptId: local.scriptId, files: ['appsscript.json', ...filesJson()] });
});

// ---------------------------------------------------------------- readiness and the command line

test('readiness for v2 names the v2 configuration file, makes no Google call, and offers no runtime check', () => {
  const missing = readiness(null, {}, 'v2');
  assert.equal(missing.config, 'MISSING');
  assert.equal(missing.googleContacted, false);
  const { tursoOrigin, ...v1 } = config;
  assert.ok(tursoOrigin);
  const invalid = readiness(v1, { FLINK_STAGING_CREDENTIALS: 'DO-NOT-PRINT' }, 'v2');
  assert.equal(invalid.config, 'INVALID');
  assert.match(invalid.next.join(' '), /staging\.v2\.config\.json/);
  assert.ok(!JSON.stringify(invalid).includes('DO-NOT-PRINT'));
  const valid = readiness(config, {}, 'v2');
  assert.equal(valid.config, 'VALID');
  assert.equal(valid.readyForRuntimeCheck, false);
  assert.match(valid.next.join(' '), /runMigrations/);
  assert.equal(valid.liveVerified, false);
});

test('readiness for v2 is ready to upload but never ready for a runtime check, even with every v1 requirement met', t => {
  const local = { ...config, scriptId: 'offline-v2-ready-' + crypto.randomUUID() };
  const directory = prepare(local, 'v2');
  const credentials = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flink-v2-cred-')), 'credentials.json');
  fs.writeFileSync(credentials, JSON.stringify({ type: 'authorized_user', client_id: local.oauthClientId, client_secret: 'made-up', refresh_token: 'made-up' }));
  t.after(() => { fs.rmSync(directory, { recursive: true }); fs.rmSync(path.dirname(credentials), { recursive: true }); });
  const env = { FLINK_STAGING_CREDENTIALS: credentials, FLINK_STAGING_DEPLOYMENT_ID: 'a'.repeat(30) };
  const report = readiness(local, env, 'v2');
  assert.equal(report.bundle, 'CURRENT');
  assert.equal(report.credentials, 'VALID_LOCAL_FILE');
  assert.equal(report.readyForUpload, true);
  assert.equal(report.readyForRuntimeCheck, false);
  assert.ok(!JSON.stringify(report).includes('made-up'));
});

test('the command line: doctor for v2 prints a report and fails while nothing is configured; a bad --app fails at once', t => {
  if (fs.existsSync(path.join(ROOT, '.staging.v2.config.json'))) { t.skip('a local v2 staging configuration exists'); return; }
  const doctor = spawnSync(process.execPath, ['scripts/staging.js', '--app', 'v2', 'doctor'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(doctor.status, 1);
  const report = JSON.parse(doctor.stdout);
  assert.equal(report.config, 'MISSING');
  assert.equal(report.googleContacted, false);
  const bad = spawnSync(process.execPath, ['scripts/staging.js', '--app', 'v3', 'check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--app v1\|v2/);
  // an old-style configuration file next to it must not be mistaken for the v2 one
  const v1File = path.join(ROOT, '.staging.config.json');
  const hadV1 = fs.existsSync(v1File);
  if (!hadV1) fs.writeFileSync(v1File, '{}');
  try {
    const unconfigured = spawnSync(process.execPath, ['scripts/staging.js', '--app', 'v2', 'check'], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(unconfigured.status, 1);
    assert.match(unconfigured.stderr, /staging\.v2\.config\.example\.json/);
  } finally {
    if (!hadV1) fs.rmSync(v1File);
  }
});

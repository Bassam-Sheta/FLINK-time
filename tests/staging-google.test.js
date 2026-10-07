'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { makeClient, parseCredentials, loadCredentials, createGoogleStaging } = require('../scripts/staging-google');

const config = {
  scriptId: 'synthetic-staging-script-12345', productionScriptId: 'synthetic-production-script-12345',
  accountEmail: 'owner@example.test', oauthClientId: '123456-synthetic.apps.googleusercontent.com'
};
const credentials = { type: 'authorized_user', client_id: config.oauthClientId,
  client_secret: 'SYNTHETIC-CLIENT-SECRET', refresh_token: 'SYNTHETIC-REFRESH-TOKEN' };
const files = [{ name: 'Code', type: 'SERVER_JS', source: 'function synthetic_() {}' },
  { name: 'appsscript', type: 'JSON', source: '{}' }];
const deploymentId = 'synthetic-api-deployment-12345';
const executionApi = { entryPointType: 'EXECUTION_API', executionApi: { entryPointConfig: { access: 'MYSELF' } } };

function fixture(respond = () => ({})) {
  const calls = [];
  const client = { async request(options) {
    calls.push(options);
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.retry, false);
    assert.ok(options.timeout > 0 && options.timeout <= 420000);
    if (options.url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
      return { data: { email: config.accountEmail, verified_email: true } };
    }
    return { data: await respond(options) };
  } };
  return { calls, client, api: createGoogleStaging(config, client) };
}

test('authorized-user credentials are allowlisted and bound to the configured OAuth client', () => {
  assert.deepEqual(parseCredentials(JSON.stringify(credentials), config), credentials);
  for (const patch of [{ type: 'service_account' }, { type: 'external_account' },
    { client_id: 'another-client' }, { client_secret: '' }, { refresh_token: {} },
    { token_uri: 'https://attacker.example' }, { universe_domain: 'attacker.example' }]) {
    assert.throws(() => parseCredentials(JSON.stringify({ ...credentials, ...patch }), config), /Invalid staging credentials/);
  }
  assert.throws(() => parseCredentials('{"secret":"DO-NOT-LOG', config), error => !error.message.includes('DO-NOT-LOG'));
  const projected = parseCredentials(JSON.stringify({ ...credentials, quota_project_id: 'synthetic-project',
    universe_domain: 'googleapis.com', account: config.accountEmail }), config);
  assert.deepEqual(projected, credentials);
});

test('real official client uses only the projected user credential and fixed Google token endpoint', () => {
  const client = makeClient(credentials);
  assert.equal(client.constructor.name, 'UserRefreshClient');
  assert.equal(client.endpoints.oauth2TokenUrl, 'https://oauth2.googleapis.com/token');
  assert.equal(client.credentials.refresh_token, credentials.refresh_token);
  assert.equal(client.transporter.defaults.maxRedirects, 0);
  assert.equal(client.transporter.defaults.timeout, 30000);
});

test('credentials require an explicit regular file outside the repository and errors redact its content', t => {
  const base = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  const directory = fs.mkdtempSync(path.join(base, 'flink-staging-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, 'synthetic.json');
  fs.writeFileSync(file, JSON.stringify(credentials));
  assert.deepEqual(loadCredentials(file, config), credentials);
  for (const invalid of [undefined, 'relative.json', directory, path.resolve(__dirname, '../package.json')]) {
    assert.throws(() => loadCredentials(invalid, config), /Invalid staging credentials/);
  }
  fs.writeFileSync(file, '{"refresh_token":"PRIVATE-DO-NOT-LOG');
  assert.throws(() => loadCredentials(file, config), error => !error.message.includes('PRIVATE'));
});

test('upload verifies Google identity and sends only explicit files to the staging project', async () => {
  const fx = fixture(options => ({ scriptId: config.scriptId, files: options.data.files }));
  await fx.api.push(files);
  assert.equal(fx.calls.length, 2);
  const request = fx.calls[1];
  assert.equal(request.url, `https://script.googleapis.com/v1/projects/${config.scriptId}/content`);
  assert.equal(request.method, 'PUT');
  assert.deepEqual(request.data, { files });
});

test('wrong Google identity prevents upload and execution', async () => {
  for (const identity of [{ email: 'other@example.test', verified_email: true },
    { email: config.accountEmail, verified_email: false }]) {
    const fx = fixture();
    let calls = 0;
    fx.client.request = async () => { calls++; return { data: identity }; };
    await assert.rejects(fx.api.push(files), /Staging Google identity mismatch/);
    await assert.rejects(fx.api.run(deploymentId), /Staging Google identity mismatch/);
    assert.equal(calls, 2);
  }
});

test('execution uses the deployment belonging to the configured script and unwraps response.result', async () => {
  const report = { environment: 'STAGING' };
  const fx = fixture(options => options.method === 'GET'
    ? { deploymentId, deploymentConfig: { scriptId: config.scriptId }, entryPoints: [executionApi] }
    : { done: true, response: { result: report } });
  assert.deepEqual(await fx.api.run(deploymentId), report);
  assert.equal(fx.calls[1].url, `https://script.googleapis.com/v1/projects/${config.scriptId}/deployments/${deploymentId}`);
  assert.equal(fx.calls[2].url, `https://script.googleapis.com/v1/scripts/${deploymentId}:run`);
  assert.deepEqual(fx.calls[2].data, { function: 'runStagingChecks_', parameters: [], devMode: true });
});

test('wrong-project, shared and non-executable deployments cannot run', async () => {
  for (const data of [{ deploymentId, deploymentConfig: { scriptId: config.productionScriptId }, entryPoints: [executionApi] },
    { deploymentId, deploymentConfig: { scriptId: config.scriptId }, entryPoints: [{ entryPointType: 'WEB_APP' }] },
    { deploymentId, deploymentConfig: { scriptId: config.scriptId }, entryPoints: [
      { entryPointType: 'EXECUTION_API', executionApi: { entryPointConfig: { access: 'ANYONE' } } }] }]) {
    const fx = fixture(() => data);
    await assert.rejects(fx.api.run(deploymentId), /Staging API deployment mismatch/);
    assert.equal(fx.calls.some(call => call.method === 'POST'), false);
  }
});

test('execution failures and unfinished responses never become a passing result', async () => {
  for (const response of [{ done: true, error: { message: 'PRIVATE-RUNTIME-ERROR' } },
    { done: false }, { done: true, response: {} }]) {
    const fx = fixture(options => options.method === 'GET'
      ? { deploymentId, deploymentConfig: { scriptId: config.scriptId }, entryPoints: [executionApi] }
      : response);
    await assert.rejects(fx.api.run(deploymentId), error => /Google runtime/.test(error.message) && !error.message.includes('PRIVATE'));
  }
});

test('HTTP failures are sanitized and mutation requests are never retried by the staging client', async () => {
  const fx = fixture(() => { throw Object.assign(new Error('PRIVATE-TOKEN'), { response: { status: 503 } }); });
  await assert.rejects(fx.api.push(files), error => /HTTP 503/.test(error.message) && !error.message.includes('PRIVATE'));
  assert.equal(fx.calls.length, 2);
});

test('malformed targets fail before any Google request and upload responses must verify the exact content', async () => {
  const fx = fixture(() => ({ scriptId: config.productionScriptId, files }));
  await assert.rejects(fx.api.run('../escape'), /Invalid staging deployment/);
  assert.equal(fx.calls.length, 0);
  assert.throws(() => createGoogleStaging({ ...config, scriptId: config.productionScriptId }, fx.client), /Invalid staging target/);
  await assert.rejects(fx.api.push(files), /Upload verification failed/);
});

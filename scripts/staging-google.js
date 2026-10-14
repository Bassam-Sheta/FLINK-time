'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { UserRefreshClient } = require('google-auth-library');

const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(value);

function parseCredentials(text, config) {
  try {
    const value = JSON.parse(text);
    const allowed = ['type', 'client_id', 'client_secret', 'refresh_token', 'quota_project_id', 'universe_domain', 'account'];
    if (!value || value.type !== 'authorized_user' || Object.keys(value).some(key => !allowed.includes(key)) ||
        value.client_id !== config.oauthClientId ||
        ['client_id', 'client_secret', 'refresh_token'].some(key => typeof value[key] !== 'string' || !value[key].trim()) ||
        (value.universe_domain && value.universe_domain !== 'googleapis.com')) throw new Error();
    return { type: 'authorized_user', client_id: value.client_id,
      client_secret: value.client_secret, refresh_token: value.refresh_token };
  } catch (_) {
    // JSON parser and Google errors can contain credential contents. Never echo them.
    throw new Error('Invalid staging credentials; use an authorized-user file for the configured OAuth client');
  }
}

function loadCredentials(file, config) {
  try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error();
    const stat = fs.lstatSync(file);
    const relative = path.relative(path.resolve(__dirname, '..'), fs.realpathSync(file));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 ||
        !(relative.startsWith('..' + path.sep) || path.isAbsolute(relative))) throw new Error();
    return parseCredentials(fs.readFileSync(file, 'utf8'), config);
  } catch (_) {
    throw new Error('Invalid staging credentials; set FLINK_STAGING_CREDENTIALS to an authorized-user file outside the repository');
  }
}

function makeClient(credentials) {
  return new UserRefreshClient({ clientId: credentials.client_id, clientSecret: credentials.client_secret,
    refreshToken: credentials.refresh_token,
    transporterOptions: { timeout: 30000, retry: false, maxRedirects: 0 } });
}

function createGoogleStaging(config, client) {
  if (!validId(config.scriptId) || !validId(config.productionScriptId) || config.scriptId === config.productionScriptId) {
    throw new Error('Invalid staging target');
  }
  const project = `https://script.googleapis.com/v1/projects/${config.scriptId}`;
  async function request(method, url, data, timeout = 30000) {
    try {
      const response = await client.request({ method, url, data, timeout, retry: false, maxRedirects: 0 });
      return response.data;
    } catch (error) {
      const status = error.response && error.response.status;
      const code = Number.isInteger(status) && status >= 100 && status <= 599 ? ` (HTTP ${status})` : '';
      throw new Error(`Google staging request failed${code}; verify authorization and target. Remote changes may have completed; inspect before retrying.`);
    }
  }
  async function assertIdentity() {
    const identity = await request('GET', 'https://www.googleapis.com/oauth2/v2/userinfo');
    if (!identity || identity.verified_email !== true ||
        String(identity.email || '').toLowerCase() !== config.accountEmail.toLowerCase()) {
      throw new Error('Staging Google identity mismatch');
    }
  }
  return {
    async push(files) {
      await assertIdentity();
      const result = await request('PUT', project + '/content', { files });
      if (!result || result.scriptId !== config.scriptId || !Array.isArray(result.files) ||
          result.files.length !== files.length || files.some(file =>
            result.files.filter(remote => remote.name === file.name && remote.type === file.type && remote.source === file.source).length !== 1)) {
        throw new Error('Upload verification failed; inspect the remote project before retrying');
      }
    },
    async run(deploymentId) {
      if (!validId(deploymentId)) throw new Error('Invalid staging deployment; set FLINK_STAGING_DEPLOYMENT_ID');
      await assertIdentity();
      const deployment = await request('GET', `${project}/deployments/${deploymentId}`);
      if (!deployment || deployment.deploymentId !== deploymentId ||
          !deployment.deploymentConfig || deployment.deploymentConfig.scriptId !== config.scriptId ||
          !Array.isArray(deployment.entryPoints) || !deployment.entryPoints.some(entry =>
            entry && entry.entryPointType === 'EXECUTION_API' && entry.executionApi &&
            entry.executionApi.entryPointConfig && entry.executionApi.entryPointConfig.access === 'MYSELF')) {
        throw new Error('Staging API deployment mismatch');
      }
      const result = await request('POST', `https://script.googleapis.com/v1/scripts/${deploymentId}:run`,
        { function: 'runStagingChecks_', parameters: [], devMode: true }, 420000);
      if (!result || result.done !== true || result.error || !result.response || result.response.result === undefined) {
        throw new Error('Google runtime reported an error or incomplete execution; no passing report recorded');
      }
      return result.response.result;
    }
  };
}

module.exports = { parseCredentials, loadCredentials, makeClient, createGoogleStaging };

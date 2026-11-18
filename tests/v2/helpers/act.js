'use strict';

/**
 * A seeded world and a way to call real actions through handleClientRequest, the way the page does: the right
 * envelope, a fresh request id for a write, a grant for the caller. Grants belong to T3.3, so Grants.check_ is the stub
 * of the pipeline tests: any token is a valid grant, and ActProbe.stepupAt says how fresh its step-up is.
 *
 *   const t = createActEnv();
 *   t.call('admin1', 'members.list', {}, { ws: t.world.ids.w1 })     // a plain JSON response
 *   t.rows('SELECT ... FROM ...')                                  // plain rows from the database
 *   t.staleStepUp()                                                // later calls need a new step-up
 */

const crypto = require('node:crypto');
const { createEnv } = require('./env');
const { seedWorld, signIn, insert } = require('./seed');

const TOKEN = 'cd'.repeat(64);

function createActEnv(options = {}) {
  const env = createEnv();
  const world = seedWorld(env, options);
  env.run(`var ActProbe = { stepupAt: ${env.fakes.clock.now()} }; Grants.check_ = function () { return { kind: 'ADMIN', stepupAt: ActProbe.stepupAt }; };`);

  // ws: the workspace id; requestId: to repeat a request; grant: false to send none; envelope: extra envelope fields
  function call(persona, action, payload = {}, opts = {}) {
    signIn(env, persona.includes('@') ? persona : world.emails[persona]);
    const entry = env.ctx.ACTIONS[action];
    if (!entry) throw new Error(`no such action ${action}`);
    const envelope = { v: 1, payload, ...(opts.envelope || {}) };
    if (opts.ws !== undefined) envelope.workspaceId = opts.ws;
    if (opts.grant !== false) envelope.grant = TOKEN;
    if (entry.write) envelope.requestId = opts.requestId || crypto.randomUUID();
    return env.ctx.__plain(env.ctx.handleClientRequest(action, envelope));
  }

  return {
    env, world, call,
    ids: world.ids,
    rows: sql => env.turso.db.prepare(sql).all().map(row => ({ ...row })),
    one: sql => env.turso.db.prepare(sql).all().map(row => ({ ...row }))[0],
    insert: (table, row) => insert(env.turso.db, table, row),
    staleStepUp: () => env.run('ActProbe.stepupAt = 0'),
    freshStepUp: () => env.run(`ActProbe.stepupAt = ${env.fakes.clock.now()}`),
    tursoCalls: () => env.fakes.fetch.calls.length,
    resetCalls: () => { env.fakes.fetch.calls.length = 0; },
    bumpAccounts: () => env.run('Cache.bump_(Cache.GEN_ACCT_)'),
    setSetting: (scope, key, value) => {
      insert(env.turso.db, 'settings', { scope, key, value_json: JSON.stringify(value), updated_at: 1, updated_by: 'test', version: 1 });
      env.run('Cache.bump_(Cache.GEN_SETTINGS_)');
    },
  };
}

function ok(response, label = '') {
  if (response.ok !== true) throw new Error(`${label} expected success, got ${response.code}: ${response.message} ${JSON.stringify(response.details)}`);
  return response.data;
}
function failed(response, code, label = '') {
  if (response.ok !== false) throw new Error(`${label} expected ${code}, the request succeeded: ${JSON.stringify(response.data)}`);
  if (response.code !== code) throw new Error(`${label} expected ${code}, got ${response.code}: ${response.message}`);
  return response;
}

module.exports = { createActEnv, ok, failed, TOKEN };

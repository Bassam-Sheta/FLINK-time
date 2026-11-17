'use strict';

// T1.8 — doGet (BUILD_SPEC section 9): one template for three views, the frame mode that goes with each view, and
// no database call: the page draws its layout at once and then calls app.bootstrap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createEnv } = require('./helpers/env');

function serve(parameter) {
  const env = createEnv();
  const event = parameter === undefined ? undefined : { parameter };
  const output = env.ctx.doGet(event);
  return { env, output, record: env.fakes.html.last() };
}

test('doGet is a public function that renders the Portal template', () => {
  const { record, output } = serve({ view: 'user' });
  assert.equal(record.template, 'Portal');
  assert.equal(typeof output.getContent, 'function');
});

test('the user view may be framed (Google Sites), the admin views may not', () => {
  assert.equal(serve({ view: 'user' }).record.frameMode, 'ALLOWALL');
  assert.equal(serve({ view: 'admin' }).record.frameMode, 'DEFAULT');
  assert.equal(serve({ view: 'superadmin' }).record.frameMode, 'DEFAULT');
});

test('the template is told which view to include', () => {
  for (const view of ['user', 'admin', 'superadmin']) {
    assert.equal(serve({ view }).record.props.view, view);
  }
});

test('no view, or one we do not know, gives the user view with the user frame mode, consistently', () => {
  const cases = [undefined, {}, { view: '' }, { view: 'Admin' }, { view: 'ADMIN' }, { view: ' admin' }, { view: 'admin\n' },
    { view: 'root' }, { view: ['admin'] }, { view: { toString: 'admin' } }, { view: 5 }, { view: null }];
  for (const parameter of cases) {
    const { record } = serve(parameter);
    assert.equal(record.props.view, 'user', JSON.stringify(parameter));
    assert.equal(record.frameMode, 'ALLOWALL', JSON.stringify(parameter));
  }
});

test('doGet copes with a missing or odd event', () => {
  const env = createEnv();
  for (const event of [undefined, null, {}, { parameter: null }, { parameter: 'view=admin' }, 5, 'admin']) {
    env.fakes.html.reset();
    env.ctx.doGet(event);
    assert.equal(env.fakes.html.last().props.view, 'user');
  }
});

test('the page has a title and a mobile viewport', () => {
  const { record } = serve({ view: 'user' });
  assert.equal(record.title, 'FLINK Time');
  assert.deepEqual(record.meta, [['viewport', 'width=device-width, initial-scale=1']]);
});

test('doGet makes no database call, and uses no other service than HtmlService', () => {
  const env = createEnv();
  env.fakes.fetch.failNext();                           // would surface as an error if doGet fetched anything
  for (const view of ['user', 'admin', 'superadmin']) env.ctx.doGet({ parameter: { view } });
  assert.equal(env.fakes.fetch.calls.length, 0);
  assert.deepEqual(env.fakes.cache.keys(), []);
  assert.deepEqual(env.fakes.properties.all(), { TURSO_URL: env.origin, TURSO_RW_TOKEN: 'test-rw', TURSO_RO_TOKEN: 'test-ro' },
    'nothing was written to the Script Properties');
  assert.equal(env.fakes.mail.sent.length, 0);
});

test('doGet works while the database is down', () => {
  const env = createEnv();
  env.fakes.fetch.route(() => true, () => ({ status: 503, body: 'down' }), { first: true });
  assert.equal(env.ctx.doGet({ parameter: { view: 'admin' } }).getContent().length > 0, true);
});

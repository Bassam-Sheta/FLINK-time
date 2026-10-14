'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { portalRenderer } = require('./helpers/portal-renderer');
const baseline = {
  User: '50b68e02760e37c3cae1b5664aec647f10074967a4925ff178ee944840066024',
  Admin: '8ff219aa96f8776725c13fdbb855eb834f01d93788b6ac62b4821b10973a7574',
  SuperAdmin: 'afc9e3ef23335dacb47702f630e1dbb8eb60ffc75bf68add49388012e36fc8a7'
};

test('sharing preserves every rendered portal byte, role-specific code and browser syntax', () => {
  for (const [name, expectedHash] of Object.entries(baseline)) {
    const html = portalRenderer().render(name).replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(html).digest('hex'), expectedHash, name);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => new vm.Script(script[1]), name + ' rendered script must parse');
    }
  }
});

test('shared source cuts portal duplication without adding production files or unbounded file reads', () => {
  const root = path.resolve(__dirname, '../apps-script');
  const lines = ['User', 'Admin', 'SuperAdmin'].reduce((sum, name) => sum +
    fs.readFileSync(path.join(root, name + '.html'), 'utf8').trimEnd().split(/\r?\n/).length, 0);
  assert.ok(lines < 15028 * 0.60, 'portal source must shrink by at least 40%, not just move duplicate files');
  for (const name of ['User', 'Admin', 'SuperAdmin']) {
    const renderer = portalRenderer();
    assert.equal(typeof renderer.context.renderPortalHtml_, 'function');
    renderer.render(name);
    assert.equal(renderer.reads, name === 'User' ? 1 : 2);
    assert.throws(() => renderer.context.renderPortalHtml_('../Credentials'));
    assert.equal(renderer.reads, name === 'User' ? 1 : 2, 'invalid paths cannot access files');
  }
});

test('dispatcher serves expanded pages with unchanged framing and fails closed on invalid shared sections', () => {
  for (const [view, name, mode] of [
    ['user', 'User', 'ALLOWALL'], ['admin', 'Admin', 'DEFAULT'], ['superadmin', 'SuperAdmin', 'DEFAULT']
  ]) {
    const renderer = portalRenderer();
    const output = renderer.context.doGet({ parameter: { view } });
    assert.equal(crypto.createHash('sha256').update(output.html).digest('hex'), baseline[name]);
    assert.equal(output.frameMode, mode);
    assert.equal(output.metaTag.name, 'viewport');
  }
  for (const overrides of [
    { Admin: '/* FLINK_SHARED:unknown */' },
    { Admin: '/* FLINK_SHARED:__proto__ */' },
    { User: '<html>Shared sections removed</html>' },
    { User: '<style></style><script>\n    function duplicate() {}\n    function duplicate() {}</script>' }
  ]) {
    assert.throws(() => portalRenderer(overrides).render('Admin'));
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { portalPath, source, view, VIEWS } = require('./helpers/portal-fixture');
const appDir = path.resolve(__dirname, '../apps-script');
const code = fs.readFileSync(path.join(appDir, 'Code.gs'), 'utf8');

test('the deployable portal is one gated template, not three files', () => {
  assert.deepEqual(fs.readdirSync(appDir).sort(), ['Code.gs', 'Portal.html', 'appsscript.json']);
  assert.ok(source().includes('<? if (portalView ==='), 'Portal.html must gate role regions server-side');
});

test('every scriptlet is a simple portalView region gate', () => {
  const scriptlets = [...source().matchAll(/<\?([\s\S]*?)\?>/g)].map(match => match[1].trim());
  assert.ok(scriptlets.length > 20, 'expected the merged template to contain role gates');
  const allowed = /^(?:if \(portalView === '(?:user|admin|superadmin)'(?: \|\| portalView === '(?:user|admin|superadmin)')*\) \{|\} else if \(portalView === '(?:user|admin|superadmin)'(?: \|\| portalView === '(?:user|admin|superadmin)')*\) \{|\})$/
  for (const scriptlet of scriptlets) {
    assert.match(scriptlet, allowed, 'unexpected scriptlet: ' + JSON.stringify(scriptlet));
  }
});

test('role surfaces keep their own view deltas and never inherit another view delta', () => {
  const user = view('user');
  const admin = view('admin');
  const superadmin = view('superadmin');

  // Employee-only workspace switcher and notice banner.
  for (const marker of ['id="userWorkspaceSelect"', 'function changeUserWorkspace', 'id="appNotice"']) {
    assert.ok(user.includes(marker), 'user view must keep ' + marker);
    assert.ok(!admin.includes(marker), 'admin view must not carry ' + marker);
    assert.ok(!superadmin.includes(marker), 'superadmin view must not carry ' + marker);
  }

  // Manager/employee setup wizard key field; the newer Super Admin flow dropped it.
  assert.ok(user.includes('wzSetupKey'));
  assert.ok(admin.includes('wzSetupKey'));
  assert.ok(!superadmin.includes('wzSetupKey'));

  // Super-Admin-only catalog settings, KDF calibration and base-URL helper.
  for (const marker of ['settings.getCatalog', 'createCatalogSettingControl', 'security.calibrateKdf', 'currentWebAppBaseUrl']) {
    assert.ok(superadmin.includes(marker), 'superadmin view must keep ' + marker);
    assert.ok(!admin.includes(marker), 'admin view must not carry ' + marker);
    assert.ok(!user.includes(marker), 'user view must not carry ' + marker);
  }
});

test('the shared portal core is byte-identical across all three views', () => {
  const blocks = VIEWS.map(name => {
    const html = view(name);
    const from = html.indexOf('    function escapeHtml(value) {');
    const to = html.indexOf('    const PRIVILEGED_STEP_UP_ACTIONS = new Set([', from);
    assert.ok(from > 0 && to > from, name);
    return html.slice(from, to);
  });
  assert.equal(blocks[0], blocks[1]);
  assert.equal(blocks[0], blocks[2]);
});

test('doGet injects the requested view and keeps frame protection for privileged views', () => {
  assert.match(code, /createTemplateFromFile\('Portal'\)/);
  assert.match(code, /template\.portalView = view;/);
  assert.match(code, /view === 'user'\s*\n?\s*\?\s*HtmlService\.XFrameOptionsMode\.ALLOWALL\s*\n?\s*:\s*HtmlService\.XFrameOptionsMode\.DEFAULT/);
  assert.ok(
    !/createTemplateFromFile\('(User|Admin|SuperAdmin)'\)/.test(code),
    'doGet must not reference separate portal files'
  );
});

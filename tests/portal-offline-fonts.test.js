'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderPortal } = require('./helpers/portal-renderer');

test('all portals have zero external Google Fonts or CDN references', () => {
  const portals = [
    { name: 'User.html', content: renderPortal('User') },
    { name: 'Admin.html', content: renderPortal('Admin') },
    { name: 'SuperAdmin.html', content: renderPortal('SuperAdmin') }
  ];

  for (const portal of portals) {
    assert.equal(
      /fonts\.googleapis\.com/.test(portal.content),
      false,
      `${portal.name} must not contain fonts.googleapis.com`
    );
    assert.equal(
      /fonts\.gstatic\.com/.test(portal.content),
      false,
      `${portal.name} must not contain fonts.gstatic.com`
    );
    assert.equal(
      /Plus Jakarta Sans/.test(portal.content),
      false,
      `${portal.name} must not reference Plus Jakarta Sans`
    );
    assert.equal(
      /JetBrains Mono/.test(portal.content),
      false,
      `${portal.name} must not reference JetBrains Mono`
    );
  }
});

test('all portals declare native system font stacks in CSS variables', () => {
  const portals = [
    { name: 'User.html', content: renderPortal('User') },
    { name: 'Admin.html', content: renderPortal('Admin') },
    { name: 'SuperAdmin.html', content: renderPortal('SuperAdmin') }
  ];

  for (const portal of portals) {
    assert.match(
      portal.content,
      /--font-main:\s*system-ui,\s*-apple-system,\s*BlinkMacSystemFont,\s*"Segoe UI",\s*Roboto,\s*Helvetica,\s*Arial,\s*sans-serif;/
    );
    assert.match(
      portal.content,
      /--font-mono:\s*ui-monospace,\s*SFMono-Regular,\s*Menlo,\s*Monaco,\s*Consolas,\s*"Liberation Mono",\s*"Courier New",\s*monospace;/
    );
  }
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const userPath = path.resolve(__dirname, '../apps-script/User.html');
const adminPath = path.resolve(__dirname, '../apps-script/Admin.html');
const superAdminPath = path.resolve(__dirname, '../apps-script/SuperAdmin.html');

test('all portals have zero external Google Fonts or CDN references', () => {
  const portals = [
    { name: 'User.html', content: fs.readFileSync(userPath, 'utf8') },
    { name: 'Admin.html', content: fs.readFileSync(adminPath, 'utf8') },
    { name: 'SuperAdmin.html', content: fs.readFileSync(superAdminPath, 'utf8') }
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
    { name: 'User.html', content: fs.readFileSync(userPath, 'utf8') },
    { name: 'Admin.html', content: fs.readFileSync(adminPath, 'utf8') },
    { name: 'SuperAdmin.html', content: fs.readFileSync(superAdminPath, 'utf8') }
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

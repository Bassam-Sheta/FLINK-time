'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sync } = require('../scripts/embed-local-libraries');

test('deployable files contain the exact reviewed local library sources', () => {
  assert.doesNotThrow(() => sync(true));
});

test('vendored subsets contain no networking, dynamic execution or runtime loaders', () => {
  for (const name of ['sjcl-password-kdf.js', 'nayuki-qr.js']) {
    const source = fs.readFileSync(path.join(__dirname, '../vendor', name), 'utf8');
    assert.doesNotMatch(source, /\b(?:fetch|eval|require|importScripts)\s*\(|new\s+(?:Function|XMLHttpRequest|WebSocket)\b/);
    assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|document|navigator)\s*[.[]/);
  }
});

test('QR implementation is the exact pinned TypeScript compiler output', () => {
  const source = fs.readFileSync(path.join(__dirname, '../vendor/nayuki-qr.js'), 'utf8');
  const body = source.slice(source.indexOf('"use strict";'), source.indexOf('var qrcodegen;') + 'var qrcodegen;'.length);
  assert.equal(crypto.createHash('sha256').update(body).digest('hex'), 'eed4a1cc7f7d6a5bd52b60539afe7a4ad786a7f7bd71559b780c9a7d59981244');
});

test('QR enrollment handling stays identical across all three portals', () => {
  const blocks = ['User', 'Admin', 'SuperAdmin'].map(name => {
    const html = fs.readFileSync(path.join(__dirname, `../apps-script/${name}.html`), 'utf8');
    const from = html.indexOf('    let enrollmentScreenVersion = 0;');
    const to = html.indexOf('    function showRecoveryMessage(', from);
    assert.ok(from > 0 && to > from, name);
    return html.slice(from, to);
  });
  assert.equal(blocks[0], blocks[1]);
  assert.equal(blocks[0], blocks[2]);
});

test('late-response authentication guard stays identical across all three portals', () => {
  const blocks = ['User', 'Admin', 'SuperAdmin'].map(name => {
    const html = fs.readFileSync(path.join(__dirname, `../apps-script/${name}.html`), 'utf8');
    const from = html.indexOf('    async function apiCall(');
    const to = html.indexOf('    // App Initialization', from);
    assert.ok(from > 0 && to > from, name);
    return html.slice(from, to);
  });
  assert.equal(blocks[0], blocks[1]);
  assert.equal(blocks[0], blocks[2]);
});

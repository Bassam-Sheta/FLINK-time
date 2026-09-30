'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const code = fs.readFileSync(
  path.resolve(__dirname, '../apps-script/Code.gs'),
  'utf8'
);
const manifest = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../apps-script/appsscript.json'),
    'utf8'
  )
);

test('PBKDF2 benchmark helper is private and does not expose a browser RPC', () => {
  assert.match(code, /function benchmarkPasswordKdf_\(\)/);

  const topLevelFunctions = [
    ...code.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)
  ].map(match => match[1]);
  const browserCallable = topLevelFunctions.filter(name => !name.endsWith('_'));

  assert.deepEqual(
    browserCallable.sort(),
    ['doGet', 'doPost', 'handleClientRequest', 'onOpen'].sort()
  );
});

test('preparation does not change the production password work factor before runtime benchmarking', () => {
  assert.match(code, /PBKDF2_ITERATIONS:\s*10000/);
  assert.match(code, /owaspReferenceIterations\s*=\s*600000/);
  assert.match(code, /Diagnostic only\. Do not change PBKDF2_ITERATIONS/);
});

test('KMS scopes are intentionally not activated by the preparation branch', () => {
  const scopes = new Set(manifest.oauthScopes || []);
  assert.equal(
    scopes.has('https://www.googleapis.com/auth/cloudkms'),
    false
  );
  assert.equal(
    scopes.has('https://www.googleapis.com/auth/script.external_request'),
    false
  );
});

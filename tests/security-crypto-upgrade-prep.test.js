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

test('production password work factor remains backward compatible and is runtime-calibratable', () => {
  assert.match(code, /PBKDF2_ITERATIONS:\s*10000/);
  assert.match(code, /calibratePasswordKdf\(targetMs = 700\)/);
  assert.match(code, /recommendedIterations/);
  assert.match(code, /getConfiguredPasswordIterations\(\)/);
  assert.match(code, /needsPasswordHashUpgrade\(storedHashString\)/);
});

test('Cloud KMS runtime scopes and fetch allowlist are activated', () => {
  const scopes = new Set(manifest.oauthScopes || []);
  assert.equal(scopes.has('https://www.googleapis.com/auth/cloudkms'), true);
  assert.equal(scopes.has('https://www.googleapis.com/auth/script.external_request'), true);
  assert.deepEqual(manifest.urlFetchWhitelist, ['https://cloudkms.googleapis.com/']);
});

test('KMS TOTP service binds ciphertext to UserID and round-trips through mocked KMS', () => {
  const mod = require(path.resolve(__dirname, '../apps-script/Code.gs'));
  const service = mod.KmsSecretService;
  const originalMode = service.getMode;
  const originalRequest = service._requestKms;
  const calls = [];

  try {
    service.getMode = () => service.MODES.DUAL_READ;
    service._requestKms = (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'encrypt') return { ciphertext: 'ciphertext-blob' };
      return { plaintext: Buffer.from('JBSWY3DPEHPK3PXP', 'utf8').toString('base64') };
    };

    const stored = service.encryptTotpSecret('USER-1', 'JBSWY3DPEHPK3PXP');
    assert.equal(stored, 'kms$v1$ciphertext-blob');
    assert.equal(
      Buffer.from(calls[0].payload.additionalAuthenticatedData, 'base64').toString('utf8'),
      'FLINK_TOTP_V1|USER-1'
    );
    assert.equal(
      service.decryptTotpSecret('USER-1', stored),
      'JBSWY3DPEHPK3PXP'
    );
  } finally {
    service.getMode = originalMode;
    service._requestKms = originalRequest;
  }
});

test('KMS_REQUIRED rejects legacy MFA ciphertext and KMS records never fall back', () => {
  const mod = require(path.resolve(__dirname, '../apps-script/Code.gs'));
  const service = mod.KmsSecretService;
  const originalMode = service.getMode;
  const originalDecrypt = service._decryptWithKms;

  try {
    service.getMode = () => service.MODES.KMS_REQUIRED;
    assert.throws(
      () => service.decryptTotpSecret('USER-1', 'enc$v1$aa$bb$cc'),
      err => err.code === mod.ERROR_CODES.CRYPTO_FAILURE
    );

    service._decryptWithKms = () => {
      throw new mod.AppError(mod.ERROR_CODES.CRYPTO_FAILURE, 'simulated KMS failure', 503);
    };
    assert.throws(
      () => service.decryptTotpSecret('USER-1', 'kms$v1$ciphertext'),
      /simulated KMS failure/
    );
  } finally {
    service.getMode = originalMode;
    service._decryptWithKms = originalDecrypt;
  }
});

test('KMS migration helper is private, bounded, resumable, and does not expose secrets in logs', () => {
  assert.match(code, /function migrateTotpSecretsToKms_\(\)/);
  assert.match(code, /const batchSize = 25/);
  assert.match(code, /FLINK_KMS_MIGRATION_CURSOR/);
  assert.match(code, /KmsSecretService\.migrateTotpSecret\(userId, current\)/);
  assert.match(code, /TOTP_KMS_MIGRATED/);
  assert.doesNotMatch(code, /console\.log\([^\n]*(plaintext|ciphertext)/i);

  const topLevelFunctions = [
    ...code.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)
  ].map(match => match[1]);
  const browserCallable = topLevelFunctions.filter(name => !name.endsWith('_'));
  assert.deepEqual(
    browserCallable.sort(),
    ['doGet', 'doPost', 'handleClientRequest', 'onOpen'].sort()
  );
});

test('KMS transport is bounded and only retries transient failures', () => {
  assert.match(code, /for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  assert.match(code, /const transient = status === 429 \|\| status >= 500/);
  assert.match(code, /ScriptApp\.getOAuthToken\(\)/);
  assert.match(code, /https:\/\/cloudkms\.googleapis\.com\/v1\//);
});

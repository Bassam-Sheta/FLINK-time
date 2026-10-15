'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fallback() {
  let calls = 0;
  const context = vm.createContext({
    console,
    Utilities: {
      computeHmacSha256Signature(message, key) {
        calls++;
        return Array.from(crypto.createHmac('sha256', Buffer.from(key.map(b => b & 255)))
          .update(Buffer.from(message.map(b => b & 255))).digest());
      }
    }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), context);
  return { service: context.SecurityService, context, calls: () => calls };
}

test('Apps Script password KDF avoids per-iteration Utilities calls without reducing cost', () => {
  const fx = fallback();
  const expected = crypto.pbkdf2Sync('SyntheticPassword1!pepper', '00112233445566778899aabbccddeeff', 10000, 32, 'sha256').toString('hex');
  assert.equal(fx.service.pbkdf2Sync('SyntheticPassword1!pepper', '00112233445566778899aabbccddeeff', 10000, 32), expected);
  assert.equal(fx.calls(), 0, 'PBKDF2 must not cross the Utilities boundary for each iteration');
});

for (const [name, password, salt, iterations, length] of [
  ['RFC-compatible one iteration', 'password', 'salt', 1, 32],
  ['RFC-compatible two iterations', 'password', 'salt', 2, 32],
  ['empty UTF-8 inputs', '', '', 17, 32],
  ['Unicode and NUL', 'päss\u0000🔒كلمة', 'sâlt\u0000雪', 103, 32],
  ['long HMAC key and salt', '🔒'.repeat(40), 'salt'.repeat(40), 101, 65],
  ['partial output word', 'password', 'salt', 31, 17],
  ['multiple output blocks', 'password', 'salt', 51, 96],
  ['configured higher cost', 'SyntheticPassword1!', 'synthetic-salt', 25000, 32]
]) {
  test(`Apps Script KDF matches independent Node crypto: ${name}`, () => {
    const fx = fallback();
    assert.equal(fx.service.pbkdf2Sync(password, salt, iterations, length),
      crypto.pbkdf2Sync(password, salt, iterations, length, 'sha256').toString('hex'));
  });
}

test('existing v1/v2 password verifiers remain readable and reject the wrong password', () => {
  const fx = fallback();
  fx.service.getPepper = () => 'synthetic-pepper';
  const password = 'SyntheticPassword1!';
  const salt = '00112233445566778899aabbccddeeff';
  const digest = crypto.pbkdf2Sync(password + 'synthetic-pepper', salt, 10000, 32, 'sha256').toString('hex');
  for (const version of ['v1', 'v2']) {
    const stored = `$pbkdf2$${version}$i=10000$${salt}$${digest}`;
    assert.equal(fx.service.verifyPassword(password, stored), true);
    assert.equal(fx.service.verifyPassword('WrongPassword1!', stored), false);
  }
});

test('password KDF rejects invalid costs/lengths rather than silently weakening them', () => {
  const fx = fallback();
  for (const count of [0, -1, 1.5, NaN, Infinity, 1000001, '10000']) {
    assert.throws(() => fx.service.pbkdf2Sync('password', 'salt', count, 32), undefined, String(count));
  }
  for (const length of [0, -1, 1.5, NaN, Infinity, 1025, '32']) {
    assert.throws(() => fx.service.pbkdf2Sync('password', 'salt', 1, length), undefined, String(length));
  }
});

test('SHA/HMAC padding boundaries and consecutive passwords do not reuse keyed state', () => {
  const fx = fallback();
  for (const length of [0,1,3,4,31,32,51,52,55,56,63,64,65,95,96,119,120,127,128,129]) {
    for (const saltLength of [0,3,4,51,52,55,56,63,64,65,119,120,128]) {
      const password = 'p'.repeat(length) + String.fromCharCode(0, 127) + '雪';
      const salt = 's'.repeat(saltLength);
      assert.equal(fx.service.pbkdf2Sync(password, salt, 3, 33),
        crypto.pbkdf2Sync(password, salt, 3, 33, 'sha256').toString('hex'), `${length}/${saltLength}`);
    }
  }
  assert.throws(() => fx.service.pbkdf2Sync('\ud800', 'salt', 1, 32));
});

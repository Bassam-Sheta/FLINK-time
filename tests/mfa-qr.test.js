'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { decodeMatrix } = require('./helpers/qr-matrix-decoder');
const { mfaFixture } = require('./helpers/mfa-fixture');
const root = path.resolve(__dirname, '..');
const uri = 'otpauth://totp/FLINK%3Asynthetic?secret=JBSWY3DPEHPK3PXP&issuer=FLINK&algorithm=SHA1&digits=6&period=30';

function encoder() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(root, 'vendor/nayuki-qr.js'), 'utf8'), context);
  return context.MfaQr_;
}

const { view, VIEWS } = require('./helpers/portal-fixture');

for (const name of VIEWS) {
  test(name + ' renders the QR URI from the real enrollment service response', async () => {
    const fx = mfaFixture();
    fx.context.SecurityService.generateTotpSecret = () => 'JBSWY3DPEHPK3PXP';
    const login = fx.login();
    const auth = fx.context.SessionService.validateSession(login.sessionToken);
    const response = fx.context.AuthService.enrollMfa(auth, 'SyntheticPassword1!');
    assert.equal(typeof response.qrUri, 'string');
    assert.equal(response.otpauthUri, undefined, 'exercise the actual established server contract');
    const elements = {};
    for (const id of ['enrollmentPassword', 'enrollmentSecret', 'enrollmentExpiry',
      'mfaEnrollmentForm', 'mfaEnrollmentConfirmForm', 'enrollmentCode', 'loginAlert']) {
      elements[id] = { value: id === 'enrollmentPassword' ? 'SyntheticPassword1!' : '',
        textContent: '', classList: { add() {}, remove() {} }, focus() {} };
    }
    let renderedUri;
    const context = vm.createContext({
      Date: fx.context.Date, state: { token: login.sessionToken }, enrollmentScreenVersion: 0,
      document: { getElementById: id => elements[id] },
      apiCall: async action => { assert.equal(action, 'auth.enrollMfa'); return response; },
      renderEnrollmentQr: value => { renderedUri = value; }, setTimeout: () => 1
    });
    const html = view(name);
    vm.runInContext(html.slice(html.indexOf('async function beginAuthenticatorEnrollment('),
      html.indexOf('async function confirmAuthenticatorEnrollment(')), context);
    await context.beginAuthenticatorEnrollment({ preventDefault() {}, submitter: { disabled: false } });
    assert.equal(renderedUri, response.qrUri, 'the portal must use the URI the server actually returns');
    const qr = encoder().encode(renderedUri);
    const matrix = Array.from({ length: qr.size }, (_, y) =>
      Array.from({ length: qr.size }, (_, x) => qr.getModule(x, y)));
    assert.equal(decodeMatrix(matrix), response.qrUri);
    assert.equal(elements.enrollmentPassword.value, '');
  });
}

test('all portals display a local enrollment QR and explain the confirmation code', () => {
  for (const name of VIEWS) {
    const html = view(name);
    assert.match(html, /id="enrollmentQr"/, name);
    assert.match(html, /Scan.*QR code/, name);
    assert.match(html, /six-digit code.*confirm/i, name);
    assert.match(html, /renderEnrollmentQr\(res\.qrUri\)/, name);
  }
});

for (const [name, text] of [
  ['normal otpauth URI', uri],
  ['encoded labels', uri.replace('synthetic', encodeURIComponent('synthetic & <test> / 雪'))],
  ['large QR and version information', uri + '&label=' + 'x'.repeat(500)],
  ['maximum bounded ASCII payload', uri + 'x'.repeat(1024-uri.length)]
]) {
  test(`local QR independently decodes with valid error correction: ${name}`, () => {
    const qr = encoder().encode(text);
    const matrix = Array.from({length: qr.size}, (_,y) => Array.from({length: qr.size}, (_,x) => qr.getModule(x,y)));
    assert.equal(decodeMatrix(matrix), text);
  });
}

test('independent decoder rejects a damaged data/error-correction module', () => {
  const qr = encoder().encode(uri);
  const matrix = Array.from({length: qr.size}, (_,y) => Array.from({length: qr.size}, (_,x) => qr.getModule(x,y)));
  matrix[qr.size-1][qr.size-1] = !matrix[qr.size-1][qr.size-1];
  assert.throws(() => decodeMatrix(matrix), /Reed-Solomon syndrome/);
});

test('QR rejects empty and oversized inputs without external services', () => {
  const qr = encoder();
  for (const text of ['', null, 'x'.repeat(1025)]) assert.throws(() => qr.encode(text));
});

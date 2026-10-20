'use strict';

const { test, expect } = require('@playwright/test');
const { decodeMatrix } = require('../helpers/qr-matrix-decoder');
const { mfaFixture } = require('../helpers/mfa-fixture');

for (const route of ['/user', '/admin', '/superadmin']) {
  test(`${route} enrolls before loading application data`, async ({ page }) => {
    const external = [];
    page.on('request', request => {
      if (new URL(request.url()).hostname !== '127.0.0.1') external.push(request.url());
    });
    const fx = mfaFixture();
    fx.context.SecurityService.generateTotpSecret = () => 'JBSWY3DPEHPK3PXP';
    const login = fx.login();
    const auth = fx.context.SessionService.validateSession(login.sessionToken);
    const enrollment = fx.context.AuthService.enrollMfa(auth, 'SyntheticPassword1!');
    expect(enrollment.otpauthUri).toBeUndefined();
    await page.clock.install({ time: new Date(fx.clock.now) });
    await page.addInitScript(response => {
      window.__TEST_ENROLLMENT = true;
      window.__TEST_ENROLLMENT_RESPONSE = response;
    }, JSON.parse(JSON.stringify(enrollment)));
    await page.goto(route);
    await page.getByLabel('Username', { exact: true }).fill('employee');
    await page.getByLabel('Password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    await expect(page.locator('#appHeader')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
    expect(await page.evaluate(() => window.__mockState.calls.map(call => call.action))).not.toContain('workspaces.list');
    await page.getByLabel('Current password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
    await expect(page.locator('#enrollmentSecret')).toHaveText('JBSWY3DPEHPK3PXP');
    const svg = page.getByRole('img', { name: 'Authenticator setup QR code' });
    await expect(svg).toBeVisible();
    const geometry = await svg.evaluate(element => ({
      edge: Number(element.getAttribute('viewBox').split(' ')[2]),
      path: element.querySelector('path').getAttribute('d'),
      background: element.querySelector('rect').getAttribute('fill')
    }));
    expect(geometry.background).toBe('#fff');
    const size = geometry.edge - 8;
    const matrix = Array.from({ length: size }, () => Array(size).fill(false));
    for (const match of geometry.path.matchAll(/M(\d+),(\d+)h1v1h-1z/g)) {
      const x = Number(match[1]) - 4, y = Number(match[2]) - 4;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(size);
      expect(y).toBeLessThan(size);
      matrix[y][x] = true;
    }
    expect(decodeMatrix(matrix)).toBe(enrollment.qrUri);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('JBSWY3DPEHPK3PXP');
    expect(await page.evaluate(() => window.__mockState.calls.map(call => call.action))).not.toContain('workspaces.list');
    await page.getByLabel('New authenticator code').fill('000000');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await expect(page.locator('#loginAlert')).toContainText('Invalid authenticator');
    await expect(page.locator('#appHeader')).toBeHidden();
    await page.getByLabel('New authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
    await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
    await expect(page.locator('#appHeader')).toBeVisible();
    await expect(page.locator('#enrollmentSecret')).toHaveText('');
    await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
    expect(external).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBe('MFA-VERIFIED');
  });
}

test('owner setup pauses for MFA before company configuration', async ({ page }) => {
  await page.goto('/superadmin-setup');
  await page.getByRole('button', { name: 'START SETUP', exact: true }).click();
  await page.locator('#wzOwnerName').fill('Synthetic Owner');
  await page.locator('#wzOwnerUser').fill('rootadmin');
  await page.locator('#wzOwnerPass').fill('demo-pass');
  await page.locator('#wzOwnerPassConfirm').fill('demo-pass');
  await page.locator('#setupWizardContainer').getByRole('button', { name: /NEXT/ }).click();
  await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
  await expect(page.locator('#setupWizardContainer')).toBeHidden();
  await page.getByLabel('Current password', { exact: true }).fill('demo-pass');
  await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
  await page.getByLabel('New authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
  await expect(page.locator('#wzCompanyName')).toBeVisible();
  await expect(page.locator('#appHeader')).toBeHidden();
});

async function openEnrollment(page) {
  await page.addInitScript(() => { window.__TEST_ENROLLMENT = true; });
  await page.goto('/user');
  await page.getByLabel('Username', { exact: true }).fill('employee');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill('demo-pass');
}

test('QR remains usable at mobile width and clears when enrollment expires', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.clock.install();
  await openEnrollment(page);
  await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
  const qr = page.getByRole('img', { name: 'Authenticator setup QR code' });
  await expect(qr).toBeVisible();
  const box = await qr.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(box.width).toBeGreaterThan(150);
  await page.clock.fastForward(600001);
  await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
  await expect(page.locator('#enrollmentSecret')).toBeEmpty();
  await expect(page.locator('#enrollmentCode')).toHaveValue('');
  await expect(page.locator('#loginAlert')).toContainText('Enrollment expired');
  await expect(page.locator('#mfaEnrollmentForm')).toBeVisible();
});

test('encoder failure keeps manual enrollment available without loading application data', async ({ page }) => {
  await openEnrollment(page);
  await page.evaluate(() => { MfaQr_ = { encode() { throw new Error('Synthetic encoder failure'); } }; });
  await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
  await expect(page.locator('#enrollmentQrFallback')).toBeVisible();
  await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
  await expect(page.locator('#enrollmentSecret')).toHaveText('JBSWY3DPEHPK3PXP');
  await expect(page.locator('#appHeader')).toBeHidden();
  await page.getByLabel('New authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.locator('#savedRecoveryCodes')).toBeVisible();
});

test('sign-out clears the enrollment QR/key immediately even while the server is pending', async ({ page }) => {
  await openEnrollment(page);
  await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
  await expect(page.getByRole('img', { name: 'Authenticator setup QR code' })).toBeVisible();
  await page.evaluate(() => {
    window.rawApiCall = () => new Promise(() => {});
    void logout();
  });
  await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
  await expect(page.locator('#enrollmentSecret')).toBeEmpty();
  await expect(page.locator('#enrollmentCode')).toHaveValue('');
});

test('page exit clears enrollment before it can enter the back-forward cache', async ({ page }) => {
  await openEnrollment(page);
  await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
  await expect(page.getByRole('img', { name: 'Authenticator setup QR code' })).toBeVisible();
  await page.getByLabel('New authenticator code').fill('123456');
  // Deterministically exercise the browser lifecycle boundary. This is not a
  // claim that the mocked server/browser configuration activates real bfcache.
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
  await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
  await expect(page.locator('#enrollmentSecret')).toBeEmpty();
  await expect(page.locator('#enrollmentCode')).toHaveValue('');
  await expect(page.locator('#passwordLoginForm')).toBeVisible();
  await expect(page.locator('#appHeader')).toBeHidden();
  expect(await page.evaluate(() => state.token)).toBe('');
});

for (const action of ['auth.enrollMfa', 'auth.confirmMfa']) {
  test(`discard a late ${action} response after leaving enrollment`, async ({ page }) => {
    await page.addInitScript(value => { window.__TEST_DEFER_ENROLLMENT_ACTION = value; }, action);
    await openEnrollment(page);
    await page.evaluate(value => {
      const name = value === 'auth.enrollMfa' ? 'beginAuthenticatorEnrollment' : 'confirmAuthenticatorEnrollment';
      const original = window[name];
      window[name] = event => {
        window.__enrollmentHandlerFinished = original(event);
        return window.__enrollmentHandlerFinished;
      };
    }, action);
    await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
    if (action === 'auth.confirmMfa') {
      await page.getByLabel('New authenticator code').fill('123456');
      await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    }
    const submit = page.locator(action === 'auth.enrollMfa' ? '#mfaEnrollmentForm button[type=submit]' : '#mfaEnrollmentConfirmForm button[type=submit]');
    await expect(submit).toBeDisabled();
    await page.evaluate(() => showLogin());
    await expect.poll(() => page.evaluate(() => typeof window.__resolveEnrollmentAction)).toBe('function');
    await page.evaluate(() => window.__resolveEnrollmentAction());
    await page.evaluate(() => window.__enrollmentHandlerFinished);
    await expect(submit).toBeEnabled();
    await expect(page.locator('#enrollmentQr > *')).toHaveCount(0);
    await expect(page.locator('#enrollmentSecret')).toBeEmpty();
    await expect(page.locator('#savedRecoveryCodes')).toHaveCount(0);
    await expect(page.locator('#appHeader')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
  });
}

for (const code of ['AUTH_REQUIRED', 'SERVER_BUSY']) {
  test(`late enrollment validation ${code} cannot replace a newer sign-in`, async ({ page }) => {
    await openEnrollment(page);
    await page.evaluate(() => {
      const originalRaw = rawApiCall;
      window.rawApiCall = (action, ...args) => {
        if (action !== 'auth.validateSession') return originalRaw(action, ...args);
        return new Promise((_resolve, reject) => { window.__rejectOldValidation = reject; });
      };
      const originalDisplay = showRecoveryCodes;
      window.showRecoveryCodes = (codes, afterSave) => originalDisplay(codes, () => {
        window.__oldEnrollmentFinished = afterSave();
      });
    });
    await page.getByRole('button', { name: 'Show authenticator QR code' }).click();
    await page.getByLabel('New authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
    await expect.poll(() => page.evaluate(() => typeof window.__rejectOldValidation)).toBe('function');
    await page.evaluate(() => {
      const user = state.user;
      showLogin();
      completeBrowserLogin({ sessionToken: 'NEWER-SYNTHETIC-SESSION', user });
    });
    await expect(page.locator('#appHeader')).toBeVisible();
    await page.evaluate(async value => {
      window.__rejectOldValidation({ code: value, message: 'Synthetic old validation failure' });
      await window.__oldEnrollmentFinished;
    }, code);
    await expect(page.locator('#appHeader')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBe('NEWER-SYNTHETIC-SESSION');
  });
}

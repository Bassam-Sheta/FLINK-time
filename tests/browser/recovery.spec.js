'use strict';

const { test, expect } = require('@playwright/test');
const code = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-0000-0001';

for (const route of ['/user', '/admin', '/superadmin']) {
  test(`${route} recovers into enrollment and shows backup codes only in memory`, async ({ page }) => {
    await page.goto(route);
    await page.getByLabel('Username', { exact: true }).fill('employee');
    await page.getByLabel('Password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await page.getByRole('button', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery password', { exact: true }).fill('demo-pass');
    await page.getByLabel('Recovery code', { exact: true }).fill(code);
    await page.getByRole('button', { name: 'Continue recovery' }).click();
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    await expect(page.locator('#appHeader')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
    await page.getByLabel('Current password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Generate setup key' }).click();
    await page.getByLabel('New authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await expect(page.locator('#savedRecoveryCodes')).toContainText(code);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(code);
    await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
    await expect(page.locator('#savedRecoveryCodes')).toHaveCount(0);
    await expect(page.locator('#appHeader')).toBeVisible();
    await expect(page.locator('#recoveryCode')).toHaveValue('');
  });
}

test('email reset returns to password sign-in and still enters the MFA challenge', async ({ page }) => {
  await page.goto('/user');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByLabel('Recovery username').fill('employee');
  await page.getByRole('button', { name: 'Email a reset code' }).click();
  await expect(page.locator('#loginAlert')).toContainText('If recovery is available');
  await page.getByLabel('Recovery code', { exact: true }).fill(code);
  await page.getByLabel('New recovery password').fill('SyntheticNewPassword2!');
  await page.getByRole('button', { name: 'Continue recovery' }).click();
  await expect(page.locator('#loginAlert')).toContainText('Sign in and complete MFA');
  expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
  await expect(page.locator('#recoveryNewPassword')).toHaveValue('');
  await page.getByLabel('Username', { exact: true }).fill('employee');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.locator('#mfaLoginForm')).toBeVisible();
  await expect(page.locator('#appHeader')).toBeHidden();
});

test('account recovery-code regeneration clears sensitive fields and the one-time display', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING'));
  await page.goto('/user');
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Generate recovery codes', exact: true }).click();
  await page.getByLabel('Current recovery password').fill('demo-pass');
  await page.getByLabel('Current authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Generate new codes' }).click();
  await expect(page.locator('#savedRecoveryCodes')).toContainText(code);
  await expect(page.locator('#recoveryCurrentPassword')).toHaveCount(0);
  await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
  await expect(page.locator('#modalContainer')).toBeEmpty();
});

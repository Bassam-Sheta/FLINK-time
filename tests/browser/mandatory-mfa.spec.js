'use strict';

const { test, expect } = require('@playwright/test');

for (const route of ['/user', '/admin']) {
  test(`${route} enrolls before loading application data`, async ({ page }) => {
    await page.addInitScript(() => { window.__TEST_ENROLLMENT = true; });
    await page.goto(route);
    await page.getByLabel('Username', { exact: true }).fill('employee');
    await page.getByLabel('Password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    await expect(page.locator('#appHeader')).toBeHidden();
    expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
    expect(await page.evaluate(() => window.__mockState.calls.map(call => call.action))).not.toContain('workspaces.list');
    await page.getByLabel('Current password', { exact: true }).fill('demo-pass');
    await page.getByRole('button', { name: 'Generate setup key' }).click();
    await expect(page.locator('#enrollmentSecret')).toHaveText('SYNTHETIC-SETUP-KEY');
    await page.getByLabel('New authenticator code').fill('000000');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await expect(page.locator('#loginAlert')).toContainText('Invalid authenticator');
    await expect(page.locator('#appHeader')).toBeHidden();
    await page.getByLabel('New authenticator code').fill('123456');
    await page.getByRole('button', { name: 'Confirm authenticator' }).click();
    await expect(page.locator('#appHeader')).toBeVisible();
    await expect(page.locator('#enrollmentSecret')).toHaveText('');
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
  await page.getByRole('button', { name: 'Generate setup key' }).click();
  await page.getByLabel('New authenticator code').fill('123456');
  await page.getByRole('button', { name: 'Confirm authenticator' }).click();
  await expect(page.locator('#wzCompanyName')).toBeVisible();
  await expect(page.locator('#appHeader')).toBeHidden();
});

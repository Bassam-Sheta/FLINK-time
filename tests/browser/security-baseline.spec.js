'use strict';

const { test, expect } = require('@playwright/test');

test('password-only and rejected MFA responses never create browser access', async ({ page }) => {
  await page.goto('/user');
  await expect(page.locator('#passwordLoginForm')).toBeVisible();
  await page.getByLabel('Username', { exact: true }).fill('employee');
  await page.getByLabel('Password', { exact: true }).fill('demo-pass');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByText('Two-Factor Verification', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();
  await expect(page.locator('#appHeader')).toBeHidden();

  await page.getByLabel('Authenticator Code', { exact: true }).fill('000000');
  await page.getByRole('button', { name: 'Verify & Sign In', exact: true }).click();
  await expect(page.locator('#loginAlert')).toContainText('Invalid two-factor authentication code');
  expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBeNull();

  await page.getByLabel('Authenticator Code', { exact: true }).fill('123456');
  await page.getByRole('button', { name: 'Verify & Sign In', exact: true }).click();
  await expect(page.locator('#appHeader')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('flink_session_token'))).toBe('SESSION-1');
});

test('untrusted entry descriptions render as text, not executable HTML', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING'));
  await page.goto('/user');
  await expect(page.locator('#appHeader')).toBeVisible();
  const payload = '<img src=x onerror="window.__xssExecuted=true">';
  await page.evaluate(value => {
    window.__mockState.entries[0].description = value;
  }, payload);
  await page.getByRole('button', { name: 'My Time', exact: true }).click();
  await expect(page.locator('#myTimeHistoryBody')).toContainText(payload);
  await expect(page.locator('#myTimeHistoryBody img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__xssExecuted)).toBeUndefined();
});

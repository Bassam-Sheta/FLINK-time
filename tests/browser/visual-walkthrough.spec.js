'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const screenshotDir = path.resolve(__dirname, '../../artifacts/screenshots');

function ensureOutputDir() {
  fs.mkdirSync(screenshotDir, { recursive: true });
}

async function seedSession(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING');
  });
}

async function capture(page, fileName) {
  ensureOutputDir();
  await page.screenshot({
    path: path.join(screenshotDir, fileName),
    fullPage: true
  });
}

test('capture employee portal walkthrough', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedSession(page);
  await page.goto('/user');

  await expect(page.locator('#appHeader')).toBeVisible();
  await expect(page.locator('#userDisplayName')).toHaveText('Normal Employee');
  await expect(page.locator('#userActiveWsName')).toHaveText('Cairo Operations');
  await capture(page, '01-employee-timer.png');

  await page.getByRole('button', { name: 'My Time' }).click();
  await expect(page.getByText('Weekly Timesheet', { exact: true })).toBeVisible();
  await capture(page, '02-employee-my-time.png');

  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByText('Tracked Hours', { exact: true })).toBeVisible();
  await capture(page, '03-employee-reports.png');

  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.locator('#accountDetails')).toContainText('employee@example.test');
  await capture(page, '04-employee-account.png');
});

test('capture Admin manager overview', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await seedSession(page);
  await page.goto('/admin');

  await expect(page.locator('#appHeader')).toBeVisible();
  await expect(page.locator('#userDisplayName')).toHaveText('Operations Manager');
  await expect(page.locator('#userRoleBadge')).toHaveText('ADMIN');
  await expect(page.getByText('Working Now', { exact: true })).toBeVisible();
  await capture(page, '05-admin-manager-overview.png');
});

test('capture Super Admin first-run experience', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/superadmin-setup');

  await expect(page.locator('#setupWizardContainer')).toBeVisible();
  await expect(page.getByText('Guided 9-Step Setup', { exact: true })).toBeVisible();
  await capture(page, '06-superadmin-install-welcome.png');

  await page.getByRole('button', { name: 'START SETUP' }).click();
  await expect(page.getByText('Step 1 — Create the System Owner', { exact: true })).toBeVisible();
  await capture(page, '07-superadmin-setup-step1.png');
});

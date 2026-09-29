'use strict';

const { test, expect } = require('@playwright/test');

test('returning employee completes a real browser workday flow', async ({ page }) => {
  const dialogs = [];
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    await dialog.accept();
  });

  await page.addInitScript(() => {
    sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING');
  });

  await page.goto('/');

  await expect(page.locator('#appHeader')).toBeVisible();
  await expect(page.locator('#userDisplayName')).toHaveText('Normal Employee');
  await expect(page.locator('#userRoleBadge')).toHaveText('USER');

  await expect(page.locator('#userWorkspaceSelect')).toBeVisible();
  await expect(page.locator('#userWorkspaceSelect option')).toHaveCount(2);
  await expect(page.locator('#userActiveWsName')).toHaveText('Cairo Operations');

  await page.locator('#timerProjectSelect').selectOption('P1');
  await page.locator('#timerTaskSelect').selectOption('T1');
  await page.locator('#timerDescriptionInput').fill('Human browser acceptance task');
  await page.locator('#timerToggleBtn').click();
  await expect(page.locator('#timerToggleBtn')).toHaveText('STOP');

  await page.waitForTimeout(5200);
  await page.locator('#timerToggleBtn').click();
  await expect(page.locator('#timerToggleBtn')).toHaveText('START');
  await expect(page.locator('#userRecentEntriesBody')).toContainText('Human browser acceptance task');

  await page.locator('#userWorkspaceSelect').selectOption('W2');
  await expect(page.locator('#userActiveWsName')).toHaveText('Cairo Support');
  await expect(page.locator('#timerProjectSelect')).toContainText('Support Queue');

  await page.getByRole('button', { name: 'My Time' }).click();
  await expect(page.getByText('Weekly Timesheet', { exact: true })).toBeVisible();
  await expect(page.locator('#myTimeHistoryBody')).toContainText('Morning operations');

  const firstEdit = page.locator('#myTimeHistoryBody button', { hasText: 'Edit' }).first();
  await firstEdit.click();
  await page.locator('#editTimeDescription').fill('Edited by normal human');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#myTimeHistoryBody')).toContainText('Edited by normal human');

  await page.locator('#submitTimesheetBtn').click();
  await expect(page.locator('#timesheetStatusBadge')).toHaveText('SUBMITTED');

  await page.getByRole('button', { name: 'Reports' }).click();
  await expect(page.getByText('Tracked Hours', { exact: true })).toBeVisible();
  await expect(page.locator('#reportsContent')).toContainText('Edited by normal human');

  await page.getByRole('button', { name: 'Account' }).click();
  await expect(page.locator('#accountDetails')).toContainText('employee@example.test');

  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect.poll(async () =>
    page.evaluate(() => window.__mockState.loggedOut)
  ).toBe(true);

  const called = await page.evaluate(() =>
    window.__mockState.calls.map(call => call.action)
  );

  for (const action of [
    'auth.validateSession',
    'timer.start',
    'timer.stop',
    'entries.list',
    'reports.summary',
    'reports.detailed',
    'auth.logout'
  ]) {
    expect(called).toContain(action);
  }

  expect(dialogs.some(message =>
    /Timesheet submitted successfully/i.test(message)
  )).toBe(true);
});

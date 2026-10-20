'use strict';

const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING'));
});

for (const role of ['user', 'admin', 'superadmin']) {
  test(role + ' can start, advance and stop its timer clock', async ({ page }) => {
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { errors.push(dialog.message()); await dialog.accept(); });
    await page.clock.install({ time: new Date('2026-10-20T12:00:00Z') });
    await page.goto('/' + role);
    await page.getByRole('button', { name: 'Timer', exact: true }).click();
    await page.locator('#timerProjectSelect').selectOption('P1');
    await page.locator('#timerTaskSelect').selectOption('T1');
    await page.locator('#timerDescriptionInput').fill('Role clock regression');
    await page.locator('#timerToggleBtn').click();
    await expect(page.locator('#timerToggleBtn')).toHaveText('STOP');
    await expect(page.locator('#timerClockDisplay')).toHaveText('00:00:02');
    await page.clock.runFor(6000);
    await expect(page.locator('#timerClockDisplay')).toHaveText('00:00:08');
    await expect(page.locator('#timerToggleBtn')).toBeEnabled();
    await page.locator('#timerToggleBtn').click();
    await expect(page.locator('#timerToggleBtn')).toHaveText('START');
    await expect(page.locator('#timerClockDisplay')).toHaveText('00:00:00');
    await expect(page.locator('#userRecentEntriesBody')).toContainText('Role clock regression');
    expect(errors).toEqual([]);
  });
}

test('bulk GUI looks up versions before sending a workspace-bound mutation', async ({ page }) => {
  page.on('dialog', async dialog => { await dialog.accept(); });
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Advanced Diagnostics' }).click();
  await page.locator('#bulkEntryIds').fill('E-100');
  await page.locator('#bulkEntryAction').selectOption('LOCK');
  await page.getByRole('button', { name: 'Apply To Entries' }).click();
  await expect(page.locator('#diagnosticsOutputBulk')).toContainText('1');
  const calls = await page.evaluate(() => window.__mockState.calls.filter(call =>
    call.action === 'entries.bulkAction' || (call.action === 'entries.list' && call.body.payload.filters?.entryIds)
  ));
  expect(calls.map(call => call.action)).toEqual(['entries.list', 'entries.bulkAction']);
  expect(calls[0].body.workspaceId).toBe('W1');
  expect(calls[1].body.workspaceId).toBe('W1');
  expect(calls[1].body.payload.params.expectedVersions).toEqual({ 'E-100': 1 });
  expect(await page.evaluate(() => window.__mockState.entries[0].locked)).toBe(true);
});

test('bulk GUI refuses missing entries without issuing a write', async ({ page }) => {
  const alerts = [];
  page.on('dialog', async dialog => { alerts.push(dialog.message()); await dialog.accept(); });
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Advanced Diagnostics' }).click();
  await page.locator('#bulkEntryIds').fill('E-404');
  await page.getByRole('button', { name: 'Apply To Entries' }).click();
  await expect.poll(() => alerts.length).toBe(1);
  expect(alerts[0]).toMatch(/missing or unavailable/i);
  expect(await page.evaluate(() => window.__mockState.calls.filter(call => call.action === 'entries.bulkAction'))).toEqual([]);
});

test('deleted accounts expose cleanup retry but cannot be reactivated', async ({ page }) => {
  page.on('dialog', async dialog => { await dialog.accept(dialog.type() === 'prompt' ? 'demo-pass' : undefined); });
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Users & RBAC' }).click();
  const row = page.locator('tr', { hasText: 'deleted.user' });
  await expect(row.getByRole('button', { name: 'Activate', exact: true })).toHaveCount(0);
  await row.getByRole('button', { name: 'Retry Cleanup' }).click();
  const modal = page.locator('#modalContainer');
  await modal.locator('#deleteUserConfirm').fill('deleted.user');
  await modal.getByRole('button', { name: 'Delete User', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => window.__mockState.calls.filter(call => call.action === 'users.delete').length)).toBe(1);
  const call = await page.evaluate(() => window.__mockState.calls.find(call => call.action === 'users.delete'));
  expect(call.body.payload.targetUserId).toBe('U-DELETED');
  expect(call.body.payload.stepUpToken).toBe('STEPUP-TOKEN');
});

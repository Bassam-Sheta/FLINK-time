'use strict';

const { test, expect } = require('@playwright/test');

async function seedSession(page) {
  await page.addInitScript(() => {
    sessionStorage.setItem('flink_session_token', 'SESSION-EXISTING');
  });
}

function mockCalls(page, action) {
  return page.evaluate(
    name => (window.__mockState.calls || []).filter(call => call.action === name),
    action
  );
}

test.beforeEach(async ({ page }) => {
  await seedSession(page);
  // The Super Admin console re-verifies identity with two prompts before a
  // privileged mutation; the mock step-up ignores the values.
  page.on('dialog', async dialog => {
    if (dialog.type() === 'prompt') await dialog.accept('demo-pass');
    else await dialog.accept();
  });
});

test('Super Admin reauthenticates before replacing another user authenticator', async ({ page }) => {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Users & RBAC' }).click();
  await expect(page.getByText('User Accounts & RBAC')).toBeVisible();

  const row = page.locator('tr', { hasText: 'locked.user' });
  await row.getByRole('button', { name: 'Reset MFA' }).click();

  const modal = page.locator('#modalContainer');
  await expect(modal.getByRole('heading', { name: 'Replace Authenticator' })).toBeVisible();
  await expect(modal).toContainText('MFA stays mandatory and cannot be switched off');

  await modal.locator('#mfaResetReason').fill('User replaced their phone');
  await modal.getByRole('button', { name: 'Replace Authenticator' }).click();

  await expect
    .poll(async () => (await mockCalls(page, 'users.resetMfa')).length)
    .toBe(1);

  const stepUps = await mockCalls(page, 'auth.stepUp');
  expect(stepUps.length, 'the privileged action must first obtain a step-up grant').toBe(1);

  const [call] = await mockCalls(page, 'users.resetMfa');
  expect(call.body.payload.targetUserId).toBe('U-LOCKED');
  expect(call.body.payload.reason).toBe('User replaced their phone');
  expect(call.body.payload.stepUpToken).toBe('STEPUP-TOKEN');
});

test('a locked account exposes an Unlock control that calls users.unlock', async ({ page }) => {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Users & RBAC' }).click();

  const row = page.locator('tr', { hasText: 'locked.user' });
  await expect(row.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await row.getByRole('button', { name: 'Unlock' }).click();

  await expect.poll(async () => (await mockCalls(page, 'users.unlock')).length).toBe(1);
  const [call] = await mockCalls(page, 'users.unlock');
  expect(call.body.payload.targetUserId).toBe('U-LOCKED');
});

test('the active-account row does not offer an Unlock control', async ({ page }) => {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Users & RBAC' }).click();

  const activeRow = page.locator('tr', { hasText: 'rootadmin' });
  await expect(activeRow.getByRole('button', { name: 'Reset MFA' })).toBeVisible();
  await expect(activeRow.getByRole('button', { name: 'Unlock' })).toHaveCount(0);
});

test('Advanced Diagnostics exposes the audit and job controls and runs them', async ({ page }) => {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Advanced Diagnostics' }).click();

  const panel = page.locator('#saSubtabContent');
  await expect(panel.getByRole('button', { name: 'Verify Audit Chain' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'List Checkpoints' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Export Checkpoints CSV' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Capacity Report' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Run Housekeeping' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Apply To Entries' })).toBeVisible();

  await panel.getByRole('button', { name: 'Verify Audit Chain' }).click();

  await expect.poll(async () => (await mockCalls(page, 'audit.verifyChain')).length).toBe(1);
  await expect(page.locator('#diagnosticsOutputIntegrity')).toContainText('entriesChecked');
});

test('Projects & Clients exposes the master-data creation controls', async ({ page }) => {
  await page.goto('/superadmin');
  await page.getByRole('button', { name: 'Projects & Clients' }).click();

  const panel = page.locator('#saSubtabContent');
  await panel.getByRole('button', { name: '+ New Client' }).click();

  const modal = page.locator('#modalContainer');
  await modal.locator('#newClientName').fill('Acme Industries');
  await modal.getByRole('button', { name: 'Create Client' }).click();

  await expect.poll(async () => (await mockCalls(page, 'clients.create')).length).toBe(1);
  const [call] = await mockCalls(page, 'clients.create');
  expect(call.body.payload.clientName).toBe('Acme Industries');
});

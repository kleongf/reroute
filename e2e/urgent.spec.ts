import { expect, test } from '@playwright/test';

test.describe('Urgent Job form', () => {
  test('adds an Urgent Job that appears with no Driver', async ({ page }) => {
    const label = `Urgent e2e ${String(Date.now())}`;
    await page.goto('/');
    await expect(page.getByTestId('sse-status')).toHaveText('connected');
    await page.getByTestId('urgent-toggle').click();

    const form = page.getByTestId('urgent-form');
    await form.getByLabel('Label').fill(label);
    await form.getByLabel('Pickup').fill('SF General Lab');
    await form.getByLabel('Drop-off').fill('Mission Bay Clinic');
    await form.getByLabel('Parcels').fill('1');
    await form.getByLabel('Due in (min)').fill('45');
    await form.getByLabel('Tier').selectOption('high');

    const posted = page.waitForResponse('/api/jobs');
    await form.getByRole('button', { name: 'Add Urgent Job' }).click();
    expect((await posted).status()).toBe(201);

    await expect(form).toBeHidden();
    await page.getByTestId('drawer-toggle').click();
    const row = page.getByTestId('jobs-table').locator('tbody tr', { hasText: label });
    await expect(row).toBeVisible();
    await expect(page.getByTestId('placement-queue')).toBeVisible();
  });

  test('shows the server message for invalid input', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('sse-status')).toHaveText('connected');
    await page.getByTestId('urgent-toggle').click();
    // Bypass native validation so the server's zod message is what the Dispatcher sees.
    await page.evaluate("document.getElementById('urgent-form').noValidate = true");
    const posted = page.waitForResponse('/api/jobs');
    await page.getByRole('button', { name: 'Add Urgent Job' }).click();
    expect((await posted).status()).toBe(400);
    await expect(page.getByTestId('urgent-error')).toContainText('label');
  });
});

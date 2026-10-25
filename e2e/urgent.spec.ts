import { expect, test, type Page } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';

const open = async (page: Page) => {
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveText('connected');
};

test.describe('Urgent Job form', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/reset')).ok()).toBe(true);
  });

  test('opens prefilled with the stage Urgent Job from docs/plan.md', async ({ page }) => {
    await open(page);
    await page.getByTestId('urgent-toggle').click();
    const form = page.getByTestId('urgent-form');
    await expect(form.getByLabel('Label')).toHaveValue('Hospital samples');
    await expect(form.getByLabel('Pickup')).toHaveValue('SF General Lab');
    await expect(form.getByLabel('Drop-off')).toHaveValue('Mission Bay Clinic');
    await expect(form.getByLabel('Parcels')).toHaveValue('2');
    await expect(form.getByLabel('Due in (min)')).toHaveValue('90');
    await expect(form.getByLabel('Tier')).toHaveText('High');
    await page.screenshot({ path: 'artifacts/screenshots/urgent-dialog.png' });
  });

  test('adds an Urgent Job that appears with no Driver', async ({ page }) => {
    const label = `Urgent e2e ${String(Date.now())}`;
    await open(page);
    await page.getByTestId('urgent-toggle').click();

    const form = page.getByTestId('urgent-form');
    await form.getByLabel('Label').fill(label);
    await form.getByLabel('Pickup').fill('SF General Lab');
    await form.getByLabel('Drop-off').fill('Mission Bay Clinic');
    await form.getByLabel('Parcels').fill('1');
    await form.getByLabel('Due in (min)').fill('45');
    await form.getByLabel('Tier').click();
    await page.getByRole('option', { name: 'High' }).click();

    const posted = page.waitForResponse('/api/jobs');
    await form.getByRole('button', { name: 'Add Urgent Job' }).click();
    const res = await posted;
    expect(res.status()).toBe(201);
    const { jobId, state } = (await res.json()) as { jobId: string; state: StateSnapshot };
    expect(state.jobs.find((j) => j.id === jobId)).toMatchObject({
      label,
      parcels: 1,
      pickup: { name: 'SF General Lab', lat: 37.7557, lng: -122.4048 },
      dropoff: { name: 'Mission Bay Clinic', lat: 37.7684, lng: -122.3912 },
    });
    expect(state.placements.some((p) => p.jobId === jobId)).toBe(true);

    await expect(form).toBeHidden();
    await page.getByTestId('drawer-toggle').click();
    const row = page.getByTestId('jobs-table').locator('tbody tr', { hasText: label });
    await expect(row).toBeVisible();
    await expect(row).toContainText(jobId);
    await expect(page.getByTestId('drivers-table').locator('tbody tr')).not.toHaveCount(0);
    await expect(page.getByTestId('placement-queue')).toBeVisible();
    await page.screenshot({ path: 'artifacts/screenshots/sheet.png' });
  });

  test('validates with the backend schema and blocks the POST', async ({ page }) => {
    await open(page);
    let posts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/jobs')) posts += 1;
    });
    await page.getByTestId('urgent-toggle').click();
    await page.getByTestId('urgent-form').getByLabel('Label').fill('');
    await page.getByRole('button', { name: 'Add Urgent Job' }).click();
    await expect(page.getByTestId('urgent-error')).toContainText('label');
    await expect(page.getByTestId('urgent-error')).toContainText('label: label is required');
    expect(posts).toBe(0);
  });

  test('shows the server message for invalid input', async ({ page }) => {
    await open(page);
    // Client validation mirrors the server's schema, so fake a server-only rejection.
    await page.route('**/api/jobs', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_body', message: 'label: no Driver can take it' }),
      }),
    );
    await page.getByTestId('urgent-toggle').click();
    const posted = page.waitForResponse('**/api/jobs');
    await page.getByRole('button', { name: 'Add Urgent Job' }).click();
    expect((await posted).status()).toBe(400);
    await expect(page.getByTestId('urgent-error')).toContainText('label');
    await expect(page.getByTestId('urgent-error')).toHaveText('label: no Driver can take it');
    await expect(page.getByTestId('urgent-form')).toBeVisible();
  });
});

test.describe('traffic menu', () => {
  test('lists the traffic events and disables one once active', async ({ page, request }) => {
    expect((await request.post('/api/reset')).ok()).toBe(true);
    await open(page);
    await page.evaluate("window.dispatchEvent(new CustomEvent('reroute:open-traffic-menu'))");

    const menu = page.getByTestId('traffic-buttons');
    await expect(menu).toBeVisible();
    const item = menu.getByTestId('inject-traffic-us101');
    await expect(item).toBeEnabled();

    const posted = page.waitForResponse('**/api/traffic/us101');
    await item.click();
    expect((await posted).ok()).toBe(true);

    // Await selection's close transition before reopening the controlled menu.
    await expect(menu).toBeHidden();
    await page.getByTestId('traffic-menu-trigger').click();
    await expect(page.getByTestId('inject-traffic-us101')).toHaveAttribute('data-disabled', '');
  });
});

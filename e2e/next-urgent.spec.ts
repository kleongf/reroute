import { expect, test, type Page } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';

const openNext = async (page: Page) => {
  await page.goto('/next');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-state', 'connected');
};

const openUrgentJob = (page: Page) =>
  page.evaluate("window.dispatchEvent(new CustomEvent('reroute:open-urgent-job'))");

test.describe('/next Urgent Job dialog', () => {
  test.beforeEach(async ({ request }) => {
    expect((await request.post('/api/reset')).ok()).toBe(true);
  });

  test('the stage Urgent Job queues its Placement and shows in the Jobs table', async ({
    page,
  }) => {
    await openNext(page);
    await openUrgentJob(page);

    const form = page.getByTestId('urgent-form');
    await expect(form).toBeVisible();
    await form.getByLabel('Label').fill('Hospital samples');
    await form.getByLabel('Pickup').fill('SF General Lab');
    await form.getByLabel('Drop-off').fill('Mission Bay Clinic');
    await form.getByLabel('Parcels').fill('2');
    await form.getByLabel('Due in (min)').fill('90');
    await form.getByLabel('Tier').click();
    await page.getByRole('option', { name: 'High' }).click();
    await page.screenshot({ path: 'artifacts/screenshots/next-urgent-dialog.png' });

    const posted = page.waitForResponse('**/api/jobs');
    await form.getByRole('button', { name: 'Add Urgent Job' }).click();
    const res = await posted;
    expect(res.status()).toBe(201);
    const { jobId, state } = (await res.json()) as { jobId: string; state: StateSnapshot };
    expect(state.jobs.find((j) => j.id === jobId)).toMatchObject({
      label: 'Hospital samples',
      parcels: 2,
      pickup: { name: 'SF General Lab', lat: 37.7557, lng: -122.4048 },
      dropoff: { name: 'Mission Bay Clinic', lat: 37.7684, lng: -122.3912 },
    });
    expect(state.placements.some((p) => p.jobId === jobId)).toBe(true);
    await expect(form).toBeHidden();

    await page.getByTestId('drawer-toggle').click();
    const row = page.getByTestId('jobs-table').locator('tbody tr', { hasText: 'Hospital samples' });
    await expect(row).toBeVisible();
    await expect(row).toContainText(jobId);
    await expect(page.getByTestId('drivers-table').locator('tbody tr')).not.toHaveCount(0);
    await page.screenshot({ path: 'artifacts/screenshots/next-sheet.png' });
  });

  test('client validation uses the backend schema and blocks the POST', async ({ page }) => {
    await openNext(page);
    let posts = 0;
    page.on('request', (r) => {
      if (r.url().endsWith('/api/jobs')) posts += 1;
    });
    await page.getByTestId('urgent-toggle').click();
    await page.getByRole('button', { name: 'Add Urgent Job' }).click();
    await expect(page.getByTestId('urgent-error')).toContainText('label: label is required');
    expect(posts).toBe(0);
  });

  test('shows the server message when the server rejects the Job', async ({ page }) => {
    await openNext(page);
    await page.route('**/api/jobs', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'invalid_body', message: 'no Driver can take this Job' }),
      }),
    );
    await openUrgentJob(page);
    const form = page.getByTestId('urgent-form');
    await form.getByLabel('Label').fill('Rejected');
    await form.getByLabel('Pickup').fill('A');
    await form.getByLabel('Drop-off').fill('B');
    await form.getByRole('button', { name: 'Add Urgent Job' }).click();
    await expect(page.getByTestId('urgent-error')).toHaveText('no Driver can take this Job');
    await expect(form).toBeVisible();
  });
});

test.describe('/next traffic menu', () => {
  test('lists the traffic events and disables one once active', async ({ page, request }) => {
    expect((await request.post('/api/reset')).ok()).toBe(true);
    await openNext(page);
    await page.evaluate("window.dispatchEvent(new CustomEvent('reroute:open-traffic-menu'))");

    const menu = page.getByTestId('traffic-buttons');
    await expect(menu).toBeVisible();
    const item = menu.getByTestId('inject-traffic-i280');
    await expect(item).toBeEnabled();

    const posted = page.waitForResponse('**/api/traffic/i280');
    await item.click();
    expect((await posted).ok()).toBe(true);

    // The HTTP response can arrive before the menu finishes closing after selection.
    // Reopen only after that transition, otherwise this click can close it again.
    await expect(menu).toBeHidden();
    await page.getByTestId('traffic-menu-trigger').click();
    await expect(page.getByTestId('inject-traffic-i280')).toHaveAttribute('data-disabled', '');
  });
});

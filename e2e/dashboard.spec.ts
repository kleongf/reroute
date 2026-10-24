import { expect, test } from '@playwright/test';

test.describe('dashboard smoke', () => {
  test('health endpoint responds', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.ok()).toBe(true);
    expect(await res.json()).toMatchObject({ status: 'ok', db: true });
  });

  test('renders, connects to SSE, and logs no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'Reroute' })).toBeVisible();
    await expect(page.getByTestId('dashboard')).toBeVisible();

    // SSE: the EventSource opened and at least one heartbeat arrived.
    await expect(page.getByTestId('sse-status')).toHaveText('connected');
    await expect(page.getByTestId('sse-heartbeats')).not.toHaveText('0');

    await page.screenshot({ path: 'artifacts/screenshots/dashboard.png', fullPage: true });
    expect(errors).toEqual([]);
  });

  test('/events is a text/event-stream', async ({ page }) => {
    await page.goto('/');
    const contentType = await page.evaluate(async () => {
      const controller = new AbortController();
      const res = await fetch('/events', { signal: controller.signal });
      const type = res.headers.get('content-type');
      controller.abort();
      return type;
    });
    expect(contentType).toContain('text/event-stream');
  });
});

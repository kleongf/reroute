import { expect, test } from '@playwright/test';

test.describe('/next (shadcn dashboard)', () => {
  test('renders, connects to SSE, shows the Job count, and logs no console errors', async ({
    page,
    request,
  }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    expect((await request.post('/api/reset')).ok()).toBe(true);
    await page.goto('/next');
    await expect(page.getByRole('heading', { level: 1, name: 'Reroute' })).toBeVisible();
    await expect(page.getByTestId('sse-status')).toHaveAttribute('data-state', 'connected');
    await expect(page.getByTestId('job-count')).toHaveText('3');

    await page.screenshot({ path: 'artifacts/screenshots/next.png', fullPage: true });
    expect(errors).toEqual([]);
  });
});

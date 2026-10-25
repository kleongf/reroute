import { expect, test, type APIRequestContext } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';
import { TEST_SERVER_ENV } from '../scripts/lib/app-process.ts';

const tool = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({
  name,
  call: { call_id: `e2e-placement-${name}`, ...call },
  args,
});

async function state(request: APIRequestContext): Promise<StateSnapshot> {
  return (await (await request.get('/api/state')).json()) as StateSnapshot;
}

test('Placement card, queue and call card: placing → placed', async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await request.post('/api/reset')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-state', 'connected');

  const panel = page.getByTestId('placement-panel');
  await expect(panel).toContainText('No Placement yet.');
  await expect(page.getByTestId('placement-queue')).toHaveText('Queue empty');
  await expect(page.getByTestId('call-card')).toContainText('No call in progress');

  // Alex reports a Disruption: Blair's simulated Offer declines itself, then Casey is called.
  const reported = await request.post('/tools/report_disruption', {
    data: tool(
      'report_disruption',
      { job_id: 'J17', reason: 'stuck behind the US-101 closure', collected: false },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_ALEX },
    ),
  });
  expect(reported.ok()).toBe(true);

  await expect(page.getByTestId('placement-status')).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('call-title')).toHaveText('Offer to Casey');
  await expect(panel).toContainText('my van’s full');
  await expect(panel).toContainText('simulated Offer');
  await expect(page.getByTestId('eligible-list')).toContainText('Offer: calling…');
  await expect(page.getByTestId('eligible-list')).toContainText(/\d+ min to Pickup · \w+/);
  await expect(
    page.getByTestId('ineligible-list').locator('.line-through', { hasText: 'Alex' }),
  ).toBeVisible();
  await expect(page.getByTestId('transcript')).toContainText('Calling…');
  await page.screenshot({ path: 'artifacts/screenshots/placing.png' });

  const offer = (await state(request)).placements
    .at(-1)
    ?.offers.find((o) => o.driverId === 'casey' && o.status === 'pending');
  expect(offer).toBeDefined();
  expect(
    (
      await request.post('/tools/accept_offer', {
        data: tool('accept_offer', { offer_id: offer?.id }),
      })
    ).ok(),
  ).toBe(true);

  await expect(page.getByTestId('placement-status')).toHaveAttribute('data-status', 'placed');
  await expect(page.getByTestId('placement-status')).toHaveText('Placed');
  await expect(page.getByTestId('eligible-list')).toContainText('Accepted');
  await page.screenshot({ path: 'artifacts/screenshots/placed.png' });

  // Collapsible: the toggle hides and restores the body.
  const toggle = page.getByTestId('placement-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('placement-queue')).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId('placement-queue')).toBeVisible();
});

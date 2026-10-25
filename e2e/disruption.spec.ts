import { expect, test, type APIRequestContext } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';
import { TEST_SERVER_ENV } from '../scripts/lib/app-process.ts';

const tool = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({
  name,
  call: { call_id: `e2e-${name}`, ...call },
  args,
});

async function state(request: APIRequestContext): Promise<StateSnapshot> {
  return (await (await request.get('/api/state')).json()) as StateSnapshot;
}

test('a Disruption is shown, then shown fixed with before → after and the tally', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await request.post('/api/reset')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveText('connected');
  await expect(page.getByTestId('banner')).toHaveText('All Jobs on track');
  await expect(page.getByTestId('tally')).toContainText('Disruptions fixed: 0');
  await expect(page.getByTestId('fix-timer')).toHaveText('–:––');

  // Traffic check: J17 At Risk with Alex, pulsing on the map.
  await page.getByTestId('traffic-menu-trigger').click();
  await page.getByTestId('inject-traffic-i280').click();
  const card = page.getByTestId('disruption-card').filter({ hasText: 'J17' });
  await expect(card).toHaveAttribute('data-status', 'at_risk');
  await expect(card.getByTestId('disruption-before')).toHaveText(/Late by \d+ min with Alex/);
  await expect(card.getByTestId('disruption-reason')).toContainText('I-280 closed');
  await expect(page.getByTestId('banner')).toHaveAttribute('data-tone', 'risk');
  await expect(page.locator('.map-marker--pickup[data-health=trouble]')).toHaveCount(1);
  await page.waitForTimeout(600); // banner colour transition
  await page.screenshot({ path: 'artifacts/screenshots/disruption-at-risk.png' });

  // Alex reports the Disruption on the check call.
  const reported = await request.post('/tools/report_disruption', {
    data: tool(
      'report_disruption',
      { job_id: 'J17', reason: 'stuck behind the I-280 closure', collected: false },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_ALEX },
    ),
  });
  expect(reported.ok()).toBe(true);
  await expect(card).toHaveAttribute('data-status', 'running');
  await expect(card.getByTestId('disruption-reason')).toContainText(
    'Alex: “stuck behind the I-280 closure”',
  );
  await expect(page.getByTestId('banner')).toHaveAttribute('data-tone', 'late');

  // Blair's simulated Offer declines itself; then the Offer goes to Casey.
  await expect(page.getByTestId('call-title')).toHaveText('Offer to Casey');
  await expect(page.getByTestId('placement-panel')).toContainText('only room for one');
  await page.waitForTimeout(600); // banner colour transition
  await page.screenshot({ path: 'artifacts/screenshots/disruption-placing.png' });

  const offer = (await state(request)).placements
    .at(-1)
    ?.offers.find((o) => o.driverId === 'casey' && o.status === 'pending');
  expect(offer).toBeDefined();
  const accepted = await request.post('/tools/accept_offer', {
    data: tool('accept_offer', { offer_id: offer?.id }),
  });
  expect(accepted.ok()).toBe(true);

  // Fixed: before → after, time to fix, banner, tally, green Job on the map.
  await expect(card).toHaveAttribute('data-status', 'placed');
  await expect(card.getByTestId('disruption-before')).toHaveText(/Late by \d+ min with Alex/);
  await expect(card.getByTestId('disruption-after')).toHaveText(
    /On time with Casey, \d+ min to spare/,
  );
  await expect(card.getByTestId('disruption-time')).toHaveText(/Fixed in \d+:\d\d/);
  await expect(page.getByTestId('banner')).toHaveAttribute('data-tone', 'fixed');
  await expect(page.getByTestId('banner')).toContainText('J17 fixed · Casey has it, on time');
  await expect(page.getByTestId('tally-fixed')).toHaveText('1');
  await expect(page.getByTestId('tally-avg')).toHaveText(/\d+:\d\d/);
  await expect(page.locator('.map-marker--pickup[data-health=fixed]')).toHaveCount(1);
  await expect(page.getByTestId('placement-status')).toHaveAttribute('data-status', 'placed');
  await expect(page.getByTestId('fix-timer')).toHaveAttribute('data-state', 'placed');
  await expect(page.getByText(/^J17 fixed in \d+:\d\d$/)).toHaveCount(1);
  await page.waitForTimeout(600); // banner colour transition
  await page.screenshot({ path: 'artifacts/screenshots/disruption-placed.png' });

  // A reload is a fresh load, not a new fix: no toast.
  await page.reload();
  await expect(page.getByTestId('tally-fixed')).toHaveText('1');
  await page.waitForTimeout(500);
  await expect(page.getByText(/^J17 fixed in \d+:\d\d$/)).toHaveCount(0);
});

test('an Escalated Disruption is shown as not fixed', async ({ page, request }) => {
  expect((await request.post('/api/reset')).ok()).toBe(true);
  // Casey reports no free slots, so after Blair declines nobody else is Eligible.
  await request.post('/tools/report_status', {
    data: tool(
      'report_status',
      { capacity: 0 },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_CASEY },
    ),
  });
  await page.goto('/');
  await expect(page.getByTestId('sse-status')).toHaveText('connected');
  await request.post('/tools/report_disruption', {
    data: tool(
      'report_disruption',
      { job_id: 'J17', reason: 'flat tire', collected: false },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_ALEX },
    ),
  });
  const card = page.getByTestId('disruption-card').filter({ hasText: 'J17' });
  await expect(card).toHaveAttribute('data-status', 'escalated');
  await expect(card.getByTestId('disruption-after')).toContainText('Escalated');
  await expect(page.getByTestId('banner')).toHaveAttribute('data-tone', 'esc');
  await expect(page.getByTestId('tally')).toContainText('1 Escalated');
  await expect(page.getByTestId('tally-fixed')).toHaveText('0');
});

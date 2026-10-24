import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { StateSnapshot } from '../src/domain/types.ts';
import { TEST_SERVER_ENV } from '../scripts/lib/app-process.ts';

const tool = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({
  name,
  call: { call_id: `e2e-next-map-${name}`, ...call },
  args,
});

async function state(request: APIRequestContext): Promise<StateSnapshot> {
  return (await (await request.get('/api/state')).json()) as StateSnapshot;
}

/** Every Driver, Pickup and drop-off exactly once: re-renders replace layers, never stack them. */
async function expectNoDuplicates(page: Page, s: StateSnapshot) {
  const map = page.getByTestId('map');
  const open = s.jobs.filter((j) => j.status !== 'done').length;
  await expect(map.locator('[data-kind=driver]')).toHaveCount(s.drivers.length);
  await expect(map.locator('[data-kind=pickup]')).toHaveCount(open);
  await expect(map.locator('[data-kind=dropoff]')).toHaveCount(open);
}

test('/next map follows a Disruption through at risk, placing and placed', async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1280, height: 800 });
  expect((await request.post('/api/reset')).ok()).toBe(true);
  await page.goto('/next');
  await expect(page.getByTestId('sse-status')).toHaveAttribute('data-state', 'connected');
  const map = page.getByTestId('map');
  const initial = await state(request);
  await expectNoDuplicates(page, initial);
  await expect(map.getByTestId('map-provenance')).toContainText('simulated positions');
  await expect(map.locator('.map-marker--pickup[data-health=trouble]')).toHaveCount(0);

  // At risk: I-280 closure pulses J17 red and draws the traffic path.
  expect((await request.post('/api/traffic/i280')).ok()).toBe(true);
  await expect(map.locator('.map-marker--pickup[data-health=trouble]')).toHaveCount(1);
  await expect(map.locator('.map-traffic')).toHaveCount(1);
  await expect(map.getByTestId('map-provenance')).toContainText('simulated traffic');
  await expectNoDuplicates(page, initial);

  // Placing: Alex reports it; the Offer to Casey shows as a pending line.
  const reported = await request.post('/tools/report_disruption', {
    data: tool(
      'report_disruption',
      { job_id: 'J17', reason: 'stuck behind the I-280 closure', collected: false },
      { from_number: TEST_SERVER_ENV.DRIVER_PHONE_ALEX },
    ),
  });
  expect(reported.ok()).toBe(true);
  await expect(map.locator('[data-driver-id=casey][data-health=calling]')).toHaveCount(1);
  await expect(map.locator('.map-line--pending')).toHaveCount(1);
  await expect(map.getByText('awaiting acceptance')).toBeVisible();
  await expectNoDuplicates(page, initial);

  // Placed: Casey accepts; J17 turns green and the pending line goes.
  const offer = (await state(request)).placements
    .at(-1)
    ?.offers.find((o) => o.driverId === 'casey' && o.status === 'pending');
  expect(offer).toBeDefined();
  const accepted = await request.post('/tools/accept_offer', {
    data: tool('accept_offer', { offer_id: offer?.id }),
  });
  expect(accepted.ok()).toBe(true);
  await expect(map.locator('.map-marker--pickup[data-health=fixed]')).toHaveCount(1);
  await expect(map.locator('.map-line--fixed')).toHaveCount(1);
  await expect(map.locator('.map-line--pending')).toHaveCount(0);
  await expectNoDuplicates(page, await state(request));
  await page.screenshot({ path: 'artifacts/screenshots/next-map-placed.png' });
  expect(errors).toEqual([]);
});

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  const name =
    reducedMotion === 'reduce' ? 'stays put with reduced motion' : 'moves toward its Pickup';
  test(`/next: assigned Driver marker ${name}`, async ({ page, request }) => {
    await page.emulateMedia({ reducedMotion });
    expect((await request.post('/api/reset')).ok()).toBe(true);
    await page.goto('/next');
    const map = page.getByTestId('map');
    const casey = map.locator('[data-driver-id=casey]'); // holds J18
    const blair = map.locator('[data-driver-id=blair]'); // no Job
    await expect(casey).toHaveCount(1);
    const before = { casey: await casey.boundingBox(), blair: await blair.boundingBox() };
    await page.waitForTimeout(1000);
    const after = { casey: await casey.boundingBox(), blair: await blair.boundingBox() };

    expect(after.blair).toEqual(before.blair);
    const provenance = map.getByTestId('map-provenance');
    if (reducedMotion === 'reduce') {
      expect(after.casey).toEqual(before.casey);
      await expect(provenance).not.toContainText('simulated movement');
      await expect(map).toHaveAttribute('data-moving', 'false');
    } else {
      expect(after.casey).not.toEqual(before.casey);
      await expect(provenance).toContainText('simulated movement');
      await expect(map).toHaveAttribute('data-moving', 'true');
    }
  });
}

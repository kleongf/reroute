import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const ALEX_PHONE = HARNESS_PHONES['DRIVER_PHONE_ALEX'];

const tool = (name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) => ({
  name,
  call: { call_id: `call-${name}`, ...call },
  args,
});

const disruption = tool(
  'report_disruption',
  { job_id: 'J17', reason: 'stuck behind the I-280 closure', collected: false },
  { from_number: ALEX_PHONE },
);

describe('snapshot: Disruption before → after, tally, forecasts', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  function bench(...ids: string[]) {
    h.store.update((w) => {
      for (const d of w.drivers) if (ids.includes(d.id)) d.capacity = 0;
    });
  }

  it('forecasts each held Job, including traffic', async () => {
    expect((await h.state()).forecasts).toContainEqual({
      jobId: 'J17',
      driverId: 'alex',
      arrivalAt: '2026-10-24T14:28:00.000Z',
      minutesLate: -32,
    });
    await h.post('/api/traffic/i280');
    expect((await h.state()).forecasts).toContainEqual({
      jobId: 'J17',
      driverId: 'alex',
      arrivalAt: '2026-10-24T15:08:00.000Z',
      minutesLate: 8,
    });
  });

  it('a Placed Disruption shows before, after, time to fix, and counts in the tally', async () => {
    bench('blair');
    await h.post('/api/traffic/i280');
    h.clock.advance(60_000);
    await h.post('/tools/report_disruption', disruption);

    let s = await h.state();
    expect(s.disruptions).toEqual([
      {
        placementId: 'P1',
        jobId: 'J17',
        driverId: 'alex',
        reason: 'stuck behind the I-280 closure',
        reportedAt: '2026-10-24T14:01:00.000Z',
        status: 'running',
        before: { driverId: 'alex', arrivalAt: '2026-10-24T15:09:00.000Z', minutesLate: 9 },
        after: null,
        endedAt: null,
        secondsToFix: null,
      },
    ]);
    expect(s.disruptionTally).toEqual({
      fixed: 0,
      escalated: 0,
      open: 1,
      averageSecondsToFix: null,
    });

    const offerId = s.placements[0]?.offers[0]?.id;
    h.clock.advance(60_000);
    await h.post('/tools/accept_offer', tool('accept_offer', { offer_id: offerId }));

    s = await h.state();
    expect(s.disruptions[0]).toMatchObject({
      status: 'placed',
      reason: 'stuck behind the I-280 closure',
      after: { driverId: 'casey', arrivalAt: '2026-10-24T14:29:00.000Z', minutesLate: -31 },
      endedAt: '2026-10-24T14:02:00.000Z',
      secondsToFix: 60,
    });
    expect(s.disruptionTally).toEqual({
      fixed: 1,
      escalated: 0,
      open: 0,
      averageSecondsToFix: 60,
    });
  });

  it('an Escalated Disruption is counted as not fixed', async () => {
    bench('blair', 'casey');
    await h.post('/tools/report_disruption', disruption);
    const s = await h.state();
    expect(s.disruptions[0]).toMatchObject({
      status: 'escalated',
      after: null,
      secondsToFix: null,
    });
    expect(s.disruptionTally).toEqual({
      fixed: 0,
      escalated: 1,
      open: 0,
      averageSecondsToFix: null,
    });
  });
});

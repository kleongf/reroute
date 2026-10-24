import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateSnapshot } from '../domain/types.ts';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const ALEX_PHONE = HARNESS_PHONES['DRIVER_PHONE_ALEX'];
const CASEY_PHONE = HARNESS_PHONES['DRIVER_PHONE_CASEY'];

function tool(name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) {
  return { name, call: { call_id: `call-${name}`, ...call }, args };
}

const disruption = tool(
  'report_disruption',
  { job_id: 'J17', reason: 'flat tire', collected: false },
  { from_number: ALEX_PHONE },
);

const placementOf = (s: StateSnapshot) => {
  const p = s.placements.at(-1);
  if (!p) throw new Error('no Placement');
  return p;
};

describe('Disruption → Placement → Accept', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  /** Blair (simulated, nearest) resolves Offers in #5; take her out to reach a real call. */
  function benchBlair() {
    h.store.update((w) => {
      const blair = w.drivers.find((d) => d.id === 'blair');
      if (blair) blair.capacity = 0;
    });
  }

  it('Disruption makes the Job Late, held by Alex, with a running High Placement', async () => {
    const res = await h.post('/tools/report_disruption', disruption);
    expect(res).toEqual({
      status: 200,
      body: { result: "Keep going; I'll call you if someone takes it over." },
    });
    const s = await h.state();
    expect(s.jobs.find((j) => j.id === 'J17')).toMatchObject({
      status: 'late',
      driverId: 'alex',
      note: 'flat tire',
    });
    expect(placementOf(s)).toMatchObject({
      jobId: 'J17',
      tier: 'high',
      trigger: 'disruption',
      status: 'running',
      previousDriverId: 'alex',
    });
  });

  it('snapshot carries ranked Eligible Drivers and a reason for every ineligible one', async () => {
    await h.post('/tools/report_disruption', disruption);
    const evaluation = placementOf(await h.state()).evaluation;
    expect(evaluation?.eligible).toEqual([
      { driverId: 'blair', etaToPickupMinutes: 5 },
      { driverId: 'casey', etaToPickupMinutes: 9 },
    ]);
    expect(evaluation?.ineligible).toEqual([
      { driverId: 'alex', reason: { kind: 'current_driver', text: 'current Driver' } },
      { driverId: 'dana', reason: { kind: 'unavailable', text: 'off at 7:20 AM' } },
      { driverId: 'eli', reason: { kind: 'capacity', text: '0 slots < 2 parcels' } },
      { driverId: 'fran', reason: { kind: 'too_far', text: 'arrives 8:06 AM > 8:00 AM' } },
    ]);
  });

  it('a simulated top Driver gets an Offer without a phone call', async () => {
    await h.post('/tools/report_disruption', disruption);
    const p = placementOf(await h.state());
    expect(p.offers).toMatchObject([{ driverId: 'blair', simulated: true, status: 'pending' }]);
    expect(h.voice.calls).toEqual([]);
  });

  it('places an offer call to the top-ranked Driver with Job, Pickup, deadline, parcels', async () => {
    benchBlair();
    await h.post('/tools/report_disruption', disruption);
    const p = placementOf(await h.state());
    expect(p.evaluation?.eligible[0]?.driverId).toBe('casey');
    expect(p.offers).toMatchObject([
      { driverId: 'casey', status: 'pending', callId: 'fake-call-1' },
    ]);
    expect(h.voice.calls).toEqual([
      {
        kind: 'offer',
        to: CASEY_PHONE,
        callId: 'fake-call-1',
        vars: {
          call_kind: 'offer',
          driver_id: 'casey',
          offer_id: p.offers[0]?.id,
          job_id: 'J17',
          job_label: 'Oak Street pickup',
          pickup_name: 'Oak Street Florist',
          deadline_spoken: '8:00 AM',
          parcels: '2',
        },
      },
    ]);
  });

  it('accept commits the assignment, places the Job, and calls Alex to release him', async () => {
    benchBlair();
    await h.post('/tools/report_disruption', disruption);
    const offerId = placementOf(await h.state()).offers[0]?.id;
    h.clock.advance(90_000);

    const res = await h.post(
      '/tools/accept_offer',
      tool('accept_offer', {}, { retell_llm_dynamic_variables: { offer_id: offerId } }),
    );
    expect(res.status).toBe(200);
    expect((res.body as { result: string }).result).toContain('Oak Street pickup is yours');

    const s = await h.state();
    expect(s.jobs.find((j) => j.id === 'J17')).toMatchObject({
      status: 'assigned',
      driverId: 'casey',
      version: 3,
    });
    expect(s.drivers.find((d) => d.id === 'casey')).toMatchObject({ capacity: 1, version: 2 });
    const p = placementOf(s);
    expect(p).toMatchObject({ status: 'placed', endedAt: '2026-10-24T14:01:30.000Z' });
    expect(p.offers[0]?.status).toBe('accepted');
    expect(h.voice.calls.map((c) => [c.kind, c.to])).toEqual([
      ['offer', CASEY_PHONE],
      ['release', ALEX_PHONE],
    ]);
    expect(h.voice.calls[1]?.vars).toMatchObject({
      call_kind: 'release',
      driver_id: 'alex',
      driver_name: 'Casey',
      job_id: 'J17',
    });
  });

  it('replaying accept_offer returns the same state with no duplicate assignment or calls', async () => {
    benchBlair();
    await h.post('/tools/report_disruption', disruption);
    const offerId = placementOf(await h.state()).offers[0]?.id;
    const accept = tool('accept_offer', { offer_id: offerId });
    await h.post('/tools/accept_offer', accept);
    const before = await h.state();

    const replay = await h.post('/tools/accept_offer', accept);
    expect(replay.status).toBe(200);
    const after = await h.state();
    expect(after.jobs).toEqual(before.jobs);
    expect(after.drivers).toEqual(before.drivers);
    expect(after.placements).toEqual(before.placements);
    expect(h.voice.calls).toHaveLength(2);
  });

  it('replaying report_disruption does not queue a second Placement', async () => {
    await h.post('/tools/report_disruption', disruption);
    await h.post('/tools/report_disruption', disruption);
    expect((await h.state()).placements).toHaveLength(1);
  });

  it('rejects an accept for an Offer that is not current or no longer eligible', async () => {
    benchBlair();
    await h.post('/tools/report_disruption', disruption);
    const offerId = placementOf(await h.state()).offers[0]?.id;

    const unknown = await h.post('/tools/accept_offer', tool('accept_offer', { offer_id: 'O99' }));
    expect(unknown.status).toBe(400);

    // Casey's capacity drops below the parcel count after the Offer was made.
    h.store.update((w) => {
      const casey = w.drivers.find((d) => d.id === 'casey');
      if (casey) casey.capacity = 1;
    });
    const stale = await h.post('/tools/accept_offer', tool('accept_offer', { offer_id: offerId }));
    expect(stale.status).toBe(400);
    expect((stale.body as { result: string }).result).toContain('1 slot < 2 parcels');

    const s = await h.state();
    expect(s.jobs.find((j) => j.id === 'J17')).toMatchObject({ status: 'late', driverId: 'alex' });
    expect(placementOf(s).status).toBe('running');
    expect(h.voice.calls).toHaveLength(1);
  });

  it('rejects an accept once its Placement is no longer running', async () => {
    benchBlair();
    await h.post('/tools/report_disruption', disruption);
    const offerId = placementOf(await h.state()).offers[0]?.id;
    h.store.update((w) => {
      const p = w.placements[0];
      if (p) p.status = 'escalated';
    });
    const res = await h.post('/tools/accept_offer', tool('accept_offer', { offer_id: offerId }));
    expect(res).toEqual({ status: 400, body: { result: 'Sorry, that offer is no longer open.' } });
  });

  it('answers invalid tool input with a speakable 400', async () => {
    const res = await h.post(
      '/tools/report_disruption',
      tool('report_disruption', { job_id: 'J17' }, { from_number: ALEX_PHONE }),
    );
    expect(res.status).toBe(400);
    expect(typeof (res.body as { result: unknown }).result).toBe('string');
    const unknownCaller = await h.post(
      '/tools/report_disruption',
      tool('report_disruption', { job_id: 'J17', reason: 'x', collected: false }),
    );
    expect(unknownCaller.status).toBe(400);
  });
});

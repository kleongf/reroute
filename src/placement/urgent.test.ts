import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateSnapshot } from '../domain/types.ts';
import { createHarness, HARNESS_START, type Harness } from '../testing/harness.ts';

interface UrgentBody {
  label?: unknown;
  pickup?: unknown;
  dropoff?: unknown;
  parcels?: unknown;
  deadlineOffsetMin?: unknown;
  tier?: unknown;
}

const urgent = (over: UrgentBody = {}) => ({
  label: 'Hospital samples',
  pickup: { name: 'SF General Lab' },
  dropoff: { name: 'Mission Bay Clinic' },
  parcels: 1,
  deadlineOffsetMin: 60,
  tier: 'normal',
  ...over,
});

const placementFor = (s: StateSnapshot, jobId: string) => {
  const p = s.placements.find((x) => x.jobId === jobId);
  if (!p) throw new Error(`no Placement for ${jobId}`);
  return p;
};

describe('Urgent Jobs and the Placement Queue', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  it('rejects invalid input with a message', async () => {
    const res = await h.post('/api/jobs', urgent({ label: '', parcels: 0, tier: 'urgent' }));
    expect(res.status).toBe(400);
    const message = (res.body as { message: string }).message;
    expect(message).toContain('label');
    expect(message).toContain('parcels');
    expect(message).toContain('tier');
    expect((await h.state()).jobs.map((j) => j.id)).toEqual(['J17', 'J18', 'J19']);
  });

  it('creates an unassigned Job with no Driver, a deadline from now, and a running Placement', async () => {
    h.clock.advance(5 * 60_000);
    const res = await h.post('/api/jobs', urgent({ tier: 'high' }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ok: true, jobId: 'U1' });

    const s = await h.state();
    const job = s.jobs.find((j) => j.id === 'U1');
    expect(job).toMatchObject({
      label: 'Hospital samples',
      status: 'unassigned',
      driverId: null,
      parcels: 1,
      deadline: new Date(HARNESS_START.getTime() + 65 * 60_000).toISOString(),
      pickup: { name: 'SF General Lab', lat: 37.7749, lng: -122.4194 },
    });
    const placement = placementFor(s, 'U1');
    expect(placement).toMatchObject({
      trigger: 'urgent_job',
      tier: 'high',
      status: 'running',
      previousDriverId: null,
    });
    // Straight-line ETAs at city speed make every Driver evaluable, ranked nearest first.
    const eligible = placement.evaluation?.eligible ?? [];
    expect(eligible[0]).toEqual({ driverId: 'casey', etaToPickupMinutes: 2 });
    expect(placement.offers).toMatchObject([{ driverId: 'casey', status: 'pending' }]);
  });

  it('uses given Pickup coordinates for ETAs', async () => {
    // Out at Stonestown: Blair is nearest Eligible, since Alex is now near Cesar Chavez.
    await h.post(
      '/api/jobs',
      urgent({ pickup: { name: 'Stonestown dock', lat: 37.7281, lng: -122.4769 } }),
    );
    const eligible = placementFor(await h.state(), 'U1').evaluation?.eligible ?? [];
    expect(eligible[0]).toEqual({ driverId: 'blair', etaToPickupMinutes: 20 });
  });

  it('queues by tier, then deadline, then queued time; arrivals never touch the running Offer', async () => {
    await h.post('/api/jobs', urgent({ label: 'first', deadlineOffsetMin: 120 }));
    const running = placementFor(await h.state(), 'U1');
    expect(running.status).toBe('running');

    h.clock.advance(60_000);
    await h.post('/api/jobs', urgent({ label: 'normal late', deadlineOffsetMin: 90 }));
    await h.post('/api/jobs', urgent({ label: 'high a', deadlineOffsetMin: 120, tier: 'high' }));
    h.clock.advance(60_000);
    await h.post('/api/jobs', urgent({ label: 'normal soon', deadlineOffsetMin: 30 }));
    // Same deadline as 'high a', queued a minute later.
    await h.post('/api/jobs', urgent({ label: 'high b', deadlineOffsetMin: 119, tier: 'high' }));
    h.clock.advance(60_000);
    await h.post('/api/jobs', urgent({ label: 'high soon', deadlineOffsetMin: 30, tier: 'high' }));

    const s = await h.state();
    const labelOf = (pid: string) => {
      const p = s.placements.find((x) => x.id === pid);
      return s.jobs.find((j) => j.id === p?.jobId)?.label;
    };
    expect(s.queue.map(labelOf)).toEqual([
      'high soon',
      'high a',
      'high b',
      'normal soon',
      'normal late',
    ]);
    expect(s.placements.filter((p) => p.status === 'running').map((p) => p.id)).toEqual([
      running.id,
    ]);
    expect(placementFor(s, 'U1').offers).toEqual(running.offers);
  });

  it('when the running Placement ends, the next by Priority starts', async () => {
    await h.post('/api/jobs', urgent({ label: 'first' }));
    await h.post('/api/jobs', urgent({ label: 'normal', deadlineOffsetMin: 30 }));
    await h.post('/api/jobs', urgent({ label: 'high', deadlineOffsetMin: 90, tier: 'high' }));
    const offerId = placementFor(await h.state(), 'U1').offers[0]?.id;

    const res = await h.post('/tools/accept_offer', {
      name: 'accept_offer',
      call: { call_id: 'c1' },
      args: { offer_id: offerId },
    });
    expect(res.status).toBe(200);

    const s = await h.state();
    expect(s.jobs.find((j) => j.id === 'U1')).toMatchObject({
      driverId: 'casey',
      status: 'assigned',
    });
    expect(placementFor(s, 'U1').status).toBe('placed');
    expect(placementFor(s, 'U3').status).toBe('running');
    expect(s.queue).toEqual([placementFor(s, 'U2').id]);
  });
});

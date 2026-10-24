import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateSnapshot } from '../domain/types.ts';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const ALEX_PHONE = HARNESS_PHONES['DRIVER_PHONE_ALEX'];
const CASEY_PHONE = HARNESS_PHONES['DRIVER_PHONE_CASEY'];
const DISPATCHER_PHONE = HARNESS_PHONES['DISPATCHER_PHONE'];

/** The Urgent Job the Dispatcher types on stage (docs/plan.md, Demo run order). */
const STAGE_URGENT_JOB = {
  label: 'Hospital samples',
  pickup: { name: 'SF General Lab', lat: 37.7557, lng: -122.4048 },
  dropoff: { name: 'Mission Bay Clinic', lat: 37.7684, lng: -122.3912 },
  parcels: 2,
  deadlineOffsetMin: 90,
  tier: 'high',
};

function tool(name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) {
  return { name, call: { call_id: `call-${name}`, ...call }, args };
}

const placementFor = (s: StateSnapshot, jobId: string) => {
  const p = s.placements.find((x) => x.jobId === jobId);
  if (!p) throw new Error(`no Placement for ${jobId}`);
  return p;
};
const job = (s: StateSnapshot, id: string) => s.jobs.find((j) => j.id === id);
const minutes = (n: number) => n * 60_000;

describe('Demo story, end to end', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  it('plays the run order: traffic → Alex out → Blair simulated → Casey → release → Urgent Job → Alex', async () => {
    expect((await h.post('/api/reset')).status).toBe(200);

    // 0:30 Inject I-280 closed: check call to Alex.
    h.clock.advance(minutes(0.5));
    expect((await h.post('/api/traffic/i280')).status).toBe(200);
    expect(job(await h.state(), 'J17')?.status).toBe('at_risk');

    // Alex can't make it.
    h.clock.advance(minutes(0.5));
    const disrupt = await h.post(
      '/tools/report_disruption',
      tool(
        'report_disruption',
        { job_id: 'J17', reason: 'stuck behind the I-280 closure', collected: false },
        { from_number: ALEX_PHONE },
      ),
    );
    expect(disrupt.status).toBe(200);
    let s = await h.state();
    expect(job(s, 'J17')?.status).toBe('late');

    // Blair's simulated Offer declines itself; Casey is called.
    expect(placementFor(s, 'J17').offers).toMatchObject([{ driverId: 'blair', simulated: true }]);
    expect(await h.runScheduled()).toBe(1);
    s = await h.state();
    const j17 = placementFor(s, 'J17');
    expect(j17.offers).toMatchObject([
      { driverId: 'blair', status: 'declined', declineReason: 'only room for one' },
      { driverId: 'casey', status: 'pending' },
    ]);

    // Casey accepts: J17 Placed with Casey, release call to Alex.
    h.clock.advance(minutes(1));
    const accept = await h.post(
      '/tools/accept_offer',
      tool('accept_offer', { offer_id: j17.offers[1]?.id }),
    );
    expect(accept.status).toBe(200);
    s = await h.state();
    expect(placementFor(s, 'J17').status).toBe('placed');
    expect(job(s, 'J17')).toMatchObject({ driverId: 'casey', status: 'assigned' });

    // 3:00 Dispatcher adds the Urgent Job: Alex ranks first; every other Driver is out.
    h.clock.advance(minutes(1));
    const add = await h.post('/api/jobs', STAGE_URGENT_JOB);
    expect(add.status).toBe(201);
    const jobId = (add.body as { jobId: string }).jobId;
    s = await h.state();
    const urgent = placementFor(s, jobId);
    expect(urgent.evaluation?.eligible.map((e) => e.driverId)).toEqual(['alex']);
    expect(
      Object.fromEntries(
        (urgent.evaluation?.ineligible ?? []).map((i) => [i.driverId, i.reason.kind]),
      ),
    ).toEqual({
      blair: 'capacity',
      casey: 'capacity',
      dana: 'unavailable',
      eli: 'capacity',
      fran: 'unreachable',
    });
    expect(urgent.offers).toMatchObject([{ driverId: 'alex', status: 'pending' }]);

    // Alex accepts: Placed.
    h.clock.advance(minutes(0.5));
    const accept2 = await h.post(
      '/tools/accept_offer',
      tool('accept_offer', { offer_id: urgent.offers[0]?.id }),
    );
    expect(accept2.status).toBe(200);
    s = await h.state();
    expect(placementFor(s, jobId).status).toBe('placed');
    expect(job(s, jobId)).toMatchObject({ driverId: 'alex', status: 'assigned' });

    expect(h.voice.calls.map((c) => [c.kind, c.to])).toEqual([
      ['at_risk_check', ALEX_PHONE],
      ['offer', CASEY_PHONE],
      ['release', ALEX_PHONE],
      ['offer', ALEX_PHONE],
    ]);
    const allowed = [ALEX_PHONE, CASEY_PHONE, DISPATCHER_PHONE];
    for (const call of h.voice.calls) expect(allowed).toContain(call.to);
  });
});

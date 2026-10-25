import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateSnapshot } from '../domain/types.ts';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const ALEX_PHONE = HARNESS_PHONES['DRIVER_PHONE_ALEX'];
const CASEY_PHONE = HARNESS_PHONES['DRIVER_PHONE_CASEY'];
const DISPATCHER_PHONE = HARNESS_PHONES['DISPATCHER_PHONE'];

function tool(name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) {
  return { name, call: { call_id: `call-${name}`, ...call }, args };
}

const disruption = (collected = false) =>
  tool(
    'report_disruption',
    { job_id: 'J17', reason: 'flat tire', collected },
    { from_number: ALEX_PHONE },
  );

const placementOf = (s: StateSnapshot) => {
  const p = s.placements.at(-1);
  if (!p) throw new Error('no Placement');
  return p;
};
const driver = (s: StateSnapshot, id: string) => s.drivers.find((d) => d.id === id);
const job = (s: StateSnapshot, id: string) => s.jobs.find((j) => j.id === id);
const result = (res: { body: unknown }) => (res.body as { result: string }).result;

describe('Declines, Unanswered, Escalation', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  /** Disruption, then Blair's simulated Offer declines itself; Casey's Offer is pending. */
  async function reachCasey() {
    await h.post('/tools/report_disruption', disruption());
    expect(await h.runScheduled()).toBe(1);
    const offer = placementOf(await h.state()).offers[1];
    if (!offer) throw new Error('no Offer to Casey');
    return offer;
  }

  it("Blair's simulated Offer declines itself with no call, sets her capacity to 1, then Casey is offered", async () => {
    await h.post('/tools/report_disruption', disruption());
    expect(placementOf(await h.state()).offers).toMatchObject([
      { driverId: 'blair', simulated: true, status: 'pending' },
    ]);

    await h.runScheduled();
    const s = await h.state();
    expect(driver(s, 'blair')).toMatchObject({ capacity: 1, version: 2 });
    const p = placementOf(s);
    expect(p.offers).toMatchObject([
      {
        driverId: 'blair',
        simulated: true,
        status: 'declined',
        declineReason: 'only room for one',
      },
      { driverId: 'casey', simulated: false, status: 'pending', callId: 'fake-call-1' },
    ]);
    expect(h.voice.calls.map((c) => [c.kind, c.to])).toEqual([['offer', CASEY_PHONE]]);
    expect(p.evaluation?.ineligible.map((i) => i.driverId)).toContain('blair');
  });

  it('a decline with a status update changes the Driver first, then escalates when nobody is left', async () => {
    const offer = await reachCasey();
    const res = await h.post(
      '/tools/decline_offer',
      tool(
        'decline_offer',
        { reason: "I'm off at 7:30", available_until: '7:30' },
        { retell_llm_dynamic_variables: { offer_id: offer.id, driver_id: 'casey' } },
      ),
    );
    expect(res.status).toBe(200);

    const s = await h.state();
    expect(driver(s, 'casey')).toMatchObject({
      availableUntil: '2026-10-24T14:30:00.000Z',
      version: 2,
    });
    const p = placementOf(s);
    expect(p.status).toBe('escalated');
    expect(p.offers.map((o) => [o.driverId, o.status])).toEqual([
      ['blair', 'declined'],
      ['casey', 'declined'],
    ]);
    // A Late Job keeps its current Driver.
    expect(job(s, 'J17')).toMatchObject({ status: 'escalated', driverId: 'alex' });
    const escalation = h.voice.calls.at(-1);
    expect(escalation).toMatchObject({
      kind: 'escalation',
      to: DISPATCHER_PHONE,
      vars: { call_kind: 'escalation', job_id: 'J17' },
    });
    expect(escalation?.vars['reason']).toMatch(/^No Driver could take the Oak Street pickup/);
  });

  it('replaying decline_offer changes nothing and places no extra calls', async () => {
    const offer = await reachCasey();
    const decline = tool('decline_offer', { offer_id: offer.id, reason: 'busy' });
    await h.post('/tools/decline_offer', decline);
    const before = await h.state();
    const callCount = h.voice.calls.length;

    const replay = await h.post('/tools/decline_offer', decline);
    expect(replay.status).toBe(200);
    const after = await h.state();
    expect(after.placements).toEqual(before.placements);
    expect(after.drivers).toEqual(before.drivers);
    expect(h.voice.calls).toHaveLength(callCount);
  });

  it('never offers a Driver the same Placement twice', async () => {
    const offer = await reachCasey();
    // Restore Blair; she was already offered this Placement, so she stays out.
    h.store.update((w) => {
      const blair = w.drivers.find((d) => d.id === 'blair');
      if (blair) blair.capacity = 5;
    });
    await h.post('/tools/decline_offer', tool('decline_offer', { offer_id: offer.id }));
    const p = placementOf(await h.state());
    expect(p.offers.map((o) => o.driverId)).toEqual(['blair', 'casey']);
    expect(p.status).toBe('escalated');
    expect(p.evaluation?.ineligible).toContainEqual({
      driverId: 'blair',
      reason: expect.objectContaining({ kind: 'already_offered' }) as unknown,
    });
  });

  it('an Unanswered Offer is retried once after a delay, then the Placement moves on', async () => {
    const offer = await reachCasey();
    const res = await h.post('/webhooks/retell', {
      event: 'call_ended',
      call: { call_id: offer.callId },
    });
    expect(res.status).toBe(204);
    let p = placementOf(await h.state());
    expect(p.offers[1]).toMatchObject({ status: 'unanswered', declineReason: null });
    // No immediate retry and no Escalation: the retry waits for its delay.
    expect(p.status).toBe('running');
    expect(h.voice.calls.map((c) => c.kind)).toEqual(['offer']);

    expect(await h.runScheduled()).toBe(1);
    p = placementOf(await h.state());
    expect(p.offers.map((o) => [o.driverId, o.status])).toEqual([
      ['blair', 'declined'],
      ['casey', 'unanswered'],
      ['casey', 'pending'],
    ]);
    expect(h.voice.calls.map((c) => [c.kind, c.vars['driver_id']])).toEqual([
      ['offer', 'casey'],
      ['offer', 'casey'],
    ]);

    // A second Unanswered is final for Casey: nobody else is Eligible, so Escalate.
    const retry = p.offers[2];
    await h.post('/webhooks/retell', { event: 'call_ended', call: { call_id: retry?.callId } });
    p = placementOf(await h.state());
    expect(p.status).toBe('escalated');
    expect(h.voice.calls.map((c) => c.kind)).toEqual(['offer', 'offer', 'escalation']);
  });

  it('a retry scheduled before a demo reset does nothing after it', async () => {
    const offer = await reachCasey();
    await h.post('/webhooks/retell', { event: 'call_ended', call: { call_id: offer.callId } });
    await h.post('/api/reset');
    await h.runScheduled();
    expect((await h.state()).placements).toEqual([]);
    expect(h.voice.calls.map((c) => c.kind)).toEqual(['offer']);
  });

  it('call_ended after accept or decline changes nothing', async () => {
    const offer = await reachCasey();
    await h.post('/tools/accept_offer', tool('accept_offer', { offer_id: offer.id }));
    const before = await h.state();
    await h.post('/webhooks/retell', { event: 'call_ended', call: { call_id: offer.callId } });
    await h.post('/webhooks/retell', { event: 'call_ended', call: { call_id: 'unknown' } });
    const after = await h.state();
    expect(after.placements).toEqual(before.placements);
    expect(job(after, 'J17')).toMatchObject({ status: 'assigned', driverId: 'casey' });
  });

  it('collected parcels escalate straight to the Dispatcher with no Offers', async () => {
    const res = await h.post('/tools/report_disruption', disruption(true));
    expect(res.status).toBe(200);
    const s = await h.state();
    expect(s.placements).toEqual([]);
    expect(job(s, 'J17')).toMatchObject({
      status: 'escalated',
      driverId: 'alex',
      collected: true,
    });
    expect(h.voice.calls).toHaveLength(1);
    expect(h.voice.calls[0]).toMatchObject({ kind: 'escalation', to: DISPATCHER_PHONE });
    expect(h.voice.calls[0]?.vars['reason']).toContain('physical handoff');

    await h.post('/tools/report_disruption', disruption(true));
    expect(h.voice.calls).toHaveLength(1);
  });
});

describe('Driver status calls', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  it('get_my_jobs lists the caller’s Jobs by caller number', async () => {
    const res = await h.post(
      '/tools/get_my_jobs',
      tool('get_my_jobs', {}, { from_number: ALEX_PHONE }),
    );
    expect(res).toEqual({
      status: 200,
      body: {
        result: 'You have one job: job J17, the Oak Street pickup, 2 parcels, due by 8:00 AM.',
      },
    });
  });

  it('report_status updates capacity and availability and shows in the snapshot', async () => {
    const res = await h.post(
      '/tools/report_status',
      tool(
        'report_status',
        { capacity: 1, available_until: '11 AM' },
        { from_number: CASEY_PHONE },
      ),
    );
    expect(res.status).toBe(200);
    expect(result(res)).toBe("Got it, I've noted 1 free slot and off at 11:00 AM.");
    const s = await h.state();
    expect(driver(s, 'casey')).toMatchObject({
      capacity: 1,
      availableUntil: '2026-10-24T18:00:00.000Z',
      version: 2,
    });
    expect(s.log.at(-1)?.text).toBe('Casey status: 1 free slot, off at 11:00 AM');
  });

  it('unknown numbers get a polite refusal', async () => {
    for (const name of ['get_my_jobs', 'report_status']) {
      const res = await h.post(
        `/tools/${name}`,
        tool(name, { capacity: 1 }, { from_number: '+15559999999' }),
      );
      expect(res.status).toBe(400);
      expect(result(res)).toMatch(/^Sorry, I don't recognise this phone number/);
    }
    expect(driver(await h.state(), 'casey')?.version).toBe(1);
  });
});

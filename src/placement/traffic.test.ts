import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const ALEX_PHONE = HARNESS_PHONES['DRIVER_PHONE_ALEX'];

function tool(name: string, args: Record<string, unknown>, call: Record<string, unknown> = {}) {
  return { name, call: { call_id: `call-${name}`, ...call }, args };
}

describe('Traffic event → At Risk check call', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  it('marks only deadline-missing Jobs At Risk and calls their Driver once', async () => {
    const res = await h.post('/api/traffic/i280');
    expect(res.status).toBe(200);
    const s = await h.state();
    expect(s.activeTraffic.map((t) => t.id)).toEqual(['i280']);
    expect(s.jobs.map((j) => [j.id, j.status])).toEqual([
      ['J17', 'at_risk'],
      ['J18', 'assigned'],
      ['J19', 'assigned'],
    ]);
    expect(h.voice.calls).toEqual([
      {
        kind: 'at_risk_check',
        to: ALEX_PHONE,
        callId: 'fake-call-1',
        vars: {
          call_kind: 'at_risk_check',
          driver_id: 'alex',
          driver_name: 'Alex',
          job_id: 'J17',
          job_label: 'Oak Street pickup',
          pickup_name: 'Oak Street Florist',
          deadline_spoken: '8:00 AM',
          parcels: '2',
          reason: 'I-280 closed',
          eta_spoken: '8:08 AM',
          delay_minutes: '40',
        },
      },
    ]);
  });

  it('injecting the same traffic event twice changes nothing and places no second call', async () => {
    await h.post('/api/traffic/i280');
    const before = await h.state();
    const again = await h.post('/api/traffic/i280');
    expect(again.status).toBe(200);
    const after = await h.state();
    expect(after.jobs).toEqual(before.jobs);
    expect(after.activeTraffic).toHaveLength(1);
    expect(h.voice.calls).toHaveLength(1);
  });

  it('answers an unknown traffic event with 404', async () => {
    const res = await h.post('/api/traffic/nope');
    expect(res.status).toBe(404);
    expect(h.voice.calls).toEqual([]);
  });

  it('confirm_on_track returns the Job to assigned with "Driver confirmed"', async () => {
    await h.post('/api/traffic/i280');
    const res = await h.post(
      '/tools/confirm_on_track',
      tool(
        'confirm_on_track',
        {},
        { retell_llm_dynamic_variables: { driver_id: 'alex', job_id: 'J17' } },
      ),
    );
    expect(res.status).toBe(200);
    const replay = await h.post(
      '/tools/confirm_on_track',
      tool('confirm_on_track', { job_id: 'J17' }, { from_number: ALEX_PHONE }),
    );
    expect(replay.status).toBe(200);
    expect((await h.state()).jobs.find((j) => j.id === 'J17')).toMatchObject({
      status: 'assigned',
      driverId: 'alex',
      note: 'Driver confirmed',
    });
  });

  it('confirm_on_track rejects a Driver who does not hold the Job', async () => {
    await h.post('/api/traffic/i280');
    const res = await h.post(
      '/tools/confirm_on_track',
      tool('confirm_on_track', { driver_id: 'casey', job_id: 'J17' }),
    );
    expect(res.status).toBe(400);
    expect((await h.state()).jobs.find((j) => j.id === 'J17')?.status).toBe('at_risk');
  });

  it('"I can\'t make it" via report_disruption starts the same Placement as a Disruption', async () => {
    await h.post('/api/traffic/i280');
    const res = await h.post(
      '/tools/report_disruption',
      tool(
        'report_disruption',
        { job_id: 'J17', reason: 'stuck in I-280 traffic', collected: false },
        { retell_llm_dynamic_variables: { driver_id: 'alex', call_kind: 'at_risk_check' } },
      ),
    );
    expect(res.status).toBe(200);
    const s = await h.state();
    expect(s.jobs.find((j) => j.id === 'J17')).toMatchObject({ status: 'late', driverId: 'alex' });
    expect(s.placements).toHaveLength(1);
    expect(s.placements[0]).toMatchObject({
      jobId: 'J17',
      trigger: 'disruption',
      tier: 'high',
      status: 'running',
      previousDriverId: 'alex',
    });
    // Alex is ranked out by traffic as well as being the current Driver.
    expect(s.placements[0]?.evaluation?.eligible.map((e) => e.driverId)).toEqual([
      'blair',
      'casey',
    ]);
  });
});

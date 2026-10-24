import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { createEngine } from '../placement/engine.ts';
import { readScenarioFile } from '../store/scenario.ts';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';

const key = 'test-webhook-key-not-a-secret';
function signature(raw: string, time: number) {
  return `v=${String(time)},d=${createHmac('sha256', key)
    .update(raw + String(time))
    .digest('hex')}`;
}

describe('authenticated Retell HTTP boundary', () => {
  let h: Harness;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    h = createHarness();
    app = createApp({
      db: h.db,
      clock: h.clock,
      store: h.store,
      voice: h.voice,
      engine: createEngine({
        store: h.store,
        clock: h.clock,
        voice: h.voice,
        dispatcherPhone: HARNESS_PHONES['DISPATCHER_PHONE'] ?? null,
      }),
      scenario: readScenarioFile(
        fileURLToPath(new URL('../../fixtures/demo.json', import.meta.url)),
      ),
      phones: HARNESS_PHONES,
      publicDir: '.',
      heartbeatMs: 1000,
      retellApiKey: key,
    });
    h.store.update((w) => {
      const blair = w.drivers.find((d) => d.id === 'blair');
      if (blair) blair.capacity = 0;
    });
  });
  afterEach(() => {
    h.close();
  });
  function post(path: string, body: unknown, signed = true, time = h.clock.now().getTime()) {
    const raw = JSON.stringify(body, null, 2);
    return app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signed ? { 'x-retell-signature': signature(raw, time) } : {}),
      },
      body: raw,
    });
  }
  const disruption = {
    name: 'report_disruption',
    call: {
      call_id: 'call-inbound-alex',
      direction: 'inbound',
      from_number: HARNESS_PHONES['DRIVER_PHONE_ALEX'],
    },
    args: { job_id: 'J17', reason: 'pneu crevé — cannot continue', collected: false },
  };

  it('rejects unsigned, tampered, malformed signatures, and old requests before mutation', async () => {
    expect((await post('/tools/report_disruption', disruption, false)).status).toBe(401);
    expect(
      (await post('/webhooks/retell', { event: 'call_ended', call: { call_id: 'c1' } }, false))
        .status,
    ).toBe(401);
    expect(
      (await post('/tools/report_disruption', disruption, true, h.clock.now().getTime() - 300_001))
        .status,
    ).toBe(401);
    const raw = JSON.stringify(disruption);
    for (const sig of [signature(raw, h.clock.now().getTime()), 'v=1,d=bad']) {
      const res = await app.request('/tools/report_disruption', {
        method: 'POST',
        headers: { 'x-retell-signature': sig },
        body: raw + ' ',
      });
      expect(res.status).toBe(401);
    }
    expect((await h.state()).placements).toHaveLength(0);
  });

  it('validates consumed fields even on correctly signed deliveries', async () => {
    expect(
      (await post('/tools/report_disruption', { ...disruption, call: { call_id: 12 } })).status,
    ).toBe(400);
    expect(
      (
        await post('/webhooks/retell', {
          event: 'transcript_updated',
          call: { call_id: 'c1', transcript_object: [{ role: 'user', content: 12 }] },
        })
      ).status,
    ).toBe(400);
  });

  it('identifies inbound callers, rejects an LLM Driver override, and binds acceptance to the actual Offer call', async () => {
    expect(
      (
        await post('/tools/report_disruption', {
          ...disruption,
          args: { ...disruption.args, driver_id: 'casey' },
        })
      ).status,
    ).toBe(403);
    const first = await post('/tools/report_disruption', disruption);
    expect(first.status).toBe(200);
    const call = h.voice.calls[0];
    expect(call?.kind).toBe('offer');
    const accept = {
      name: 'accept_offer',
      call: {
        call_id: call?.callId,
        direction: 'outbound',
        to_number: HARNESS_PHONES['DRIVER_PHONE_CASEY'],
        retell_llm_dynamic_variables: call?.vars,
      },
      args: {},
    };
    expect(
      (await post('/tools/accept_offer', { ...accept, args: { offer_id: 'O99' } })).status,
    ).toBe(403);
    expect(
      (
        await post('/tools/accept_offer', {
          ...accept,
          call: { ...accept.call, call_id: 'different-call' },
        })
      ).status,
    ).toBe(403);
    expect((await post('/tools/accept_offer', accept)).status).toBe(200);
    const beforeReplay = await h.state();
    const acceptedBody = await (await post('/tools/accept_offer', accept)).json();
    expect(acceptedBody).toHaveProperty('result');
    expect(await h.state()).toEqual(beforeReplay);
    expect(h.voice.calls).toHaveLength(2);
    expect((await h.state()).jobs.find((j) => j.id === 'J17')?.driverId).toBe('casey');
    // A delayed retry of the original inbound Disruption must not undo Placement.
    expect(await (await post('/tools/report_disruption', disruption)).json()).toEqual(
      await first.json(),
    );
    expect(h.voice.calls).toHaveLength(2);
  });

  it('rejects old-reset calls and preserves the current assignment', async () => {
    await post('/tools/report_disruption', disruption);
    const call = h.voice.calls[0];
    const resetAt = (await h.state()).resetAt;
    h.clock.advance(1000);
    await h.post('/api/reset');
    const result = await post('/tools/accept_offer', {
      name: 'accept_offer',
      call: {
        call_id: call?.callId,
        to_number: HARNESS_PHONES['DRIVER_PHONE_CASEY'],
        retell_llm_dynamic_variables: { ...call?.vars, demo_reset_at: resetAt },
      },
      args: {},
    });
    expect(result.status).toBe(409);
    expect((await h.state()).jobs.find((j) => j.id === 'J17')?.driverId).toBe('alex');
  });
});

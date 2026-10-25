import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  /** This file's engine schedules Offer retries here instead of on a real timer. */
  let scheduled: (() => Promise<void>)[] = [];
  beforeEach(() => {
    h = createHarness();
    scheduled = [];
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
        offerRetryMs: 0,
        schedule: (fn) => scheduled.push(fn),
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

  it('replays the four real redacted captures through authenticated HTTP and streams root-level speech', async () => {
    const before = await h.state();
    for (const file of [
      'call_started.json',
      'transcript_updated.json',
      'call_ended.json',
      'tool-call.json',
    ]) {
      const body = JSON.parse(
        readFileSync(new URL(`../../fixtures/retell/tracer-call/${file}`, import.meta.url), 'utf8'),
      ) as unknown;
      const path = file === 'tool-call.json' ? '/tools/tracer_ping' : '/webhooks/retell';
      expect((await post(path, body, false)).status).toBe(401);
      const response = await post(path, body);
      expect(response.status).toBe(file === 'tool-call.json' ? 200 : 204);
      if (file === 'tool-call.json') {
        expect(await response.json()).toEqual({
          result: 'Tracer received. The backend connection is working.',
        });
        expect((await post(path, body)).status).toBe(200);
      }
    }
    expect(await h.state()).toEqual(before);
    expect(h.voice.calls).toHaveLength(0);
    const stream = await app.request('/events');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('Missing SSE body');
    let text = '';
    for (
      let index = 0;
      index < 30 && !text.includes('The backend acknowledged the tracer test.');
      index++
    ) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error('Invalid SSE bytes');
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(text).toContain('event: transcript');
    expect(text).toContain('The backend acknowledged the tracer test.');
  });

  it.each([
    { file: 'call_started.json', path: '/webhooks/retell', status: 204 },
    { file: 'transcript_updated.json', path: '/webhooks/retell', status: 204 },
    { file: 'call_ended.json', path: '/webhooks/retell', status: 204 },
    { file: 'tool-call.json', path: '/tools/tracer_ping', status: 200 },
  ])(
    'replays signed live $file captures without fleet changes or lost fields',
    async ({ file, path, status }) => {
      const body: unknown = JSON.parse(
        readFileSync(new URL(`../../fixtures/retell/tracer-call/${file}`, import.meta.url), 'utf8'),
      );
      const before = await h.state();
      expect((await post(path, body, false)).status).toBe(401);
      expect(h.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
      const response = await post(path, body);
      expect(response.status).toBe(status);
      const row = h.db.prepare('SELECT payload FROM webhook_events').get();
      expect(JSON.parse(String(row?.['payload'])) as unknown).toEqual(body);
      if (path === '/tools/tracer_ping') {
        const replay = await post(path, body);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual(await response.json());
        expect(h.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(1);
      }
      expect(await h.state()).toEqual(before);
      expect(h.voice.calls).toHaveLength(0);
    },
  );

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
  it('call-ended delivery marks a pending Offer Unanswered once and never accepts silence', async () => {
    await post('/tools/report_disruption', disruption);
    const call = h.voice.calls[0];
    const ended = {
      event: 'call_ended',
      call: { call_id: call?.callId, retell_llm_dynamic_variables: call?.vars },
    };
    expect((await post('/webhooks/retell', ended)).status).toBe(204);
    expect((await h.state()).placements[0]?.offers[0]?.status).toBe('unanswered');
    // One retry of the same Driver after a delay; its call-ended is final.
    expect(scheduled).toHaveLength(1);
    for (const fn of scheduled.splice(0)) await fn();
    const retry = h.voice.calls[1];
    expect(retry?.kind).toBe('offer');
    const retryEnded = {
      event: 'call_ended',
      call: { call_id: retry?.callId, retell_llm_dynamic_variables: retry?.vars },
    };
    expect((await post('/webhooks/retell', retryEnded)).status).toBe(204);
    const state = await h.state();
    expect(state.placements[0]?.offers.map((o) => o.status)).toEqual(['unanswered', 'unanswered']);
    expect(state.placements[0]?.status).toBe('escalated');
    expect(state.jobs.find((job) => job.id === 'J17')?.driverId).toBe('alex');
    expect(h.voice.calls.map((placed) => placed.kind)).toEqual(['offer', 'offer', 'escalation']);
    await post('/webhooks/retell', ended);
    await post('/webhooks/retell', retryEnded);
    expect(await h.state()).toEqual(state);
    expect(h.voice.calls).toHaveLength(3);
  });

  it('decline status and inbound status retries preserve capacity and do not bump versions twice', async () => {
    await post('/tools/report_disruption', disruption);
    const call = h.voice.calls[0];
    const decline = {
      name: 'decline_offer',
      call: {
        call_id: call?.callId,
        direction: 'outbound',
        to_number: HARNESS_PHONES['DRIVER_PHONE_CASEY'],
        retell_llm_dynamic_variables: call?.vars,
      },
      args: { reason: 'only room for one', capacity: 1 },
    };
    expect((await post('/tools/decline_offer', decline)).status).toBe(200);
    const state = await h.state();
    expect(state.drivers.find((driver) => driver.id === 'casey')?.capacity).toBe(1);
    await post('/tools/decline_offer', decline);
    expect(await h.state()).toEqual(state);
    const status = {
      name: 'report_status',
      call: { call_id: 'call-status-casey', from_number: HARNESS_PHONES['DRIVER_PHONE_CASEY'] },
      args: { capacity: 3, available_until: '2026-10-24T20:00:00.000Z' },
    };
    const results = await Promise.all([
      post('/tools/report_status', status),
      post('/tools/report_status', status),
    ]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await results[0].json()).toEqual(await results[1].json());
    const driver = (await h.state()).drivers.find((current) => current.id === 'casey');
    expect(driver).toMatchObject({ capacity: 3, availableUntil: '2026-10-24T20:00:00.000Z' });
    const before = await h.state();
    await post('/tools/report_status', status);
    expect(await h.state()).toEqual(before);
  });

  it('streams signed transcript updates over SSE, replays them on reconnect, and clears on Reset demo', async () => {
    const update = {
      event: 'transcript_updated',
      call: {
        call_id: 'call-transcript',
        from_number: HARNESS_PHONES['DRIVER_PHONE_ALEX'],
        transcript_object: [{ role: 'user', content: 'I cannot make it.' }],
      },
    };
    expect((await post('/webhooks/retell', update)).status).toBe(204);
    const controller = new AbortController();
    const response = await app.request('/events', { signal: controller.signal });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Missing SSE body');
    let text = '';
    try {
      while (!text.includes('I cannot make it.')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid SSE bytes');
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain('event: transcript');
      expect(text).toContain('"utteranceId":"call-transcript:0"');
      expect(text).toContain('"driverId":"alex"');
    } finally {
      controller.abort();
      await reader.cancel();
    }
    await h.post('/api/reset');
    // The secure app owns the transcript buffer, so use its reset action as the dashboard does.
    await app.request('/api/reset', { method: 'POST' });
    const nextController = new AbortController();
    const next = await app.request('/events', { signal: nextController.signal });
    const nextReader = next.body?.getReader();
    if (!nextReader) throw new Error('Missing SSE body');
    let fresh = '';
    try {
      while (!fresh.includes('event: heartbeat')) {
        const chunk = await nextReader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error('Invalid SSE bytes');
        fresh += new TextDecoder().decode(value);
      }
      expect(fresh).not.toContain('call-transcript');
    } finally {
      nextController.abort();
      await nextReader.cancel();
    }
  });
});

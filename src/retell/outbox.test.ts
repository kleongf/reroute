import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine } from '../placement/engine.ts';
import { createHarness, type Harness } from '../testing/harness.ts';
import { createVoiceOutbox, type VoiceOutbox } from './outbox.ts';
import type { CallRequest } from '../voice/port.ts';

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolve?.(value);
    },
  };
}

describe('outbound voice outbox', () => {
  let h: Harness;
  let outbox: VoiceOutbox | undefined;
  beforeEach(() => {
    h = createHarness();
    h.store.update((w) => {
      const blair = w.drivers.find((d) => d.id === 'blair');
      if (blair) blair.capacity = 0;
    });
  });
  afterEach(() => {
    outbox?.close();
    h.close();
  });

  it('acknowledges a Disruption before a slow Retell call finishes, then binds the actual call ID', async () => {
    const sent: CallRequest[] = [];
    const response = deferred<{ callId: string }>();
    outbox = createVoiceOutbox({
      db: h.db,
      store: h.store,
      clock: h.clock,
      transport: {
        placeCall(call) {
          sent.push(call);
          return response.promise;
        },
      },
    });
    const engine = createEngine({
      store: h.store,
      clock: h.clock,
      voice: outbox,
      dispatcherPhone: null,
    });
    const started = performance.now();
    expect((await engine.reportDisruption('alex', 'J17', 'flat tire', false)).ok).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
    const localCallId = (await h.state()).placements[0]?.offers[0]?.callId;
    expect(localCallId).toMatch(/^reroute_/);
    const sending = outbox.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.vars).toMatchObject({
      driver_id: 'casey',
      offer_id: 'O1',
      job_id: 'J17',
      reroute_call_id: localCallId,
      demo_reset_at: (await h.state()).resetAt,
    });
    response.resolve({ callId: 'call-real-1' });
    await sending;
    expect((await h.state()).placements[0]?.offers[0]?.callId).toBe('call-real-1');
    await outbox.flush();
    expect(sent).toHaveLength(1);
  });

  it('retries with the same provider idempotency key and stops after three failures', async () => {
    const ids: (string | undefined)[] = [];
    outbox = createVoiceOutbox({
      db: h.db,
      store: h.store,
      clock: h.clock,
      transport: {
        placeCall(call) {
          ids.push(call.vars['reroute_call_id']);
          return Promise.reject(new Error('provider unavailable'));
        },
      },
    });
    const engine = createEngine({
      store: h.store,
      clock: h.clock,
      voice: outbox,
      dispatcherPhone: null,
    });
    await engine.reportDisruption('alex', 'J17', 'flat tire', false);
    for (let attempt = 0; attempt < 4; attempt++) await outbox.flush();
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    expect((await h.state()).log.at(-1)?.text).toContain('Dispatcher action required');
    expect((await h.state()).jobs.find((j) => j.id === 'J17')?.driverId).toBe('alex');
  });

  it('cancels queued calls from an earlier demo instead of calling a phone after Reset demo', async () => {
    outbox = createVoiceOutbox({ db: h.db, store: h.store, clock: h.clock, transport: h.voice });
    const engine = createEngine({
      store: h.store,
      clock: h.clock,
      voice: outbox,
      dispatcherPhone: null,
    });
    await engine.reportDisruption('alex', 'J17', 'flat tire', false);
    h.clock.advance(1000);
    await h.post('/api/reset');
    await outbox.flush();
    expect(h.voice.calls).toHaveLength(0);
  });
  it('hands a failed outbound Offer back to the engine as Unanswered so Placement can progress', async () => {
    const calls: CallRequest[] = [];
    const scheduled: (() => Promise<void>)[] = [];
    const engine = createEngine({
      store: h.store,
      clock: h.clock,
      dispatcherPhone: null,
      offerRetryMs: 0,
      schedule: (fn) => scheduled.push(fn),
      voice: {
        placeCall(call) {
          if (!outbox) throw new Error('Missing outbox');
          return outbox.placeCall(call);
        },
      },
    });
    outbox = createVoiceOutbox({
      db: h.db,
      store: h.store,
      clock: h.clock,
      onUnanswered: (offerId) => engine.markUnanswered(offerId),
      transport: {
        placeCall(call) {
          calls.push(call);
          return Promise.reject(new Error('provider unavailable'));
        },
      },
    });
    await engine.reportDisruption('alex', 'J17', 'flat tire', false);
    for (let attempt = 0; attempt < 3; attempt++) await outbox.flush();
    // Undeliverable is Unanswered: one retried Offer, delivered three more times, then final.
    for (const fn of scheduled.splice(0)) await fn();
    for (let attempt = 0; attempt < 3; attempt++) await outbox.flush();
    const state = await h.state();
    expect(calls).toHaveLength(6);
    expect(state.placements[0]?.status).toBe('escalated');
    expect(state.placements[0]?.offers[0]?.status).toBe('unanswered');
    expect(state.jobs.find((job) => job.id === 'J17')?.driverId).toBe('alex');
  });
});

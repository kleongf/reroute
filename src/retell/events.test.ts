import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTranscriptBus } from '../events/transcripts.ts';
import { createHarness, HARNESS_PHONES, type Harness } from '../testing/harness.ts';
import { handleRetellEvent } from './events.ts';
import { retellWebhookSchema } from './schemas.ts';

describe('Retell call events', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    h.close();
  });

  it('publishes incremental transcript revisions without duplicate utterances', async () => {
    const transcripts = createTranscriptBus();
    const observed: string[] = [];
    const unsubscribe = transcripts.subscribe((entry) => {
      observed.push(entry.text);
    });
    const deps = {
      store: h.store,
      clock: h.clock,
      engine: { markUnanswered: () => Promise.resolve() },
      transcripts,
    };
    const raw = {
      event: 'transcript_updated',
      call: {
        call_id: 'call-1',
        from_number: HARNESS_PHONES['DRIVER_PHONE_ALEX'],
        transcript_object: [{ role: 'user', content: 'I cannot' }],
      },
    };
    await handleRetellEvent(retellWebhookSchema.parse(raw), deps);
    await handleRetellEvent(retellWebhookSchema.parse(raw), deps);
    await handleRetellEvent(
      retellWebhookSchema.parse({
        ...raw,
        call: {
          ...raw.call,
          transcript_object: [
            { role: 'user', content: 'I cannot make it.' },
            { role: 'agent', content: 'Have you collected the parcels?' },
          ],
        },
      }),
      deps,
    );
    expect(observed).toEqual(['I cannot', 'I cannot make it.', 'Have you collected the parcels?']);
    expect(transcripts.entries()).toMatchObject([
      { utteranceId: 'call-1:0', driverId: 'alex', role: 'user', text: 'I cannot make it.' },
      { utteranceId: 'call-1:1', role: 'agent' },
    ]);
    unsubscribe();
    transcripts.clear();
    expect(transcripts.entries()).toHaveLength(0);
  });

  it('maps call_ended only to the matching pending Offer, never an Accepted or unrelated Offer', async () => {
    h.store.update((w) => {
      const blair = w.drivers.find((d) => d.id === 'blair');
      if (blair) blair.capacity = 0;
    });
    await h.post('/tools/report_disruption', {
      call: { call_id: 'inbound', from_number: HARNESS_PHONES['DRIVER_PHONE_ALEX'] },
      args: { job_id: 'J17', reason: 'flat tire', collected: false },
    });
    const marked: string[] = [];
    const engine = {
      markUnanswered(offerId: string) {
        marked.push(offerId);
        return Promise.resolve();
      },
    };
    const deps = { store: h.store, clock: h.clock, engine, transcripts: createTranscriptBus() };
    const callId = h.voice.calls[0]?.callId ?? '';
    await handleRetellEvent({ event: 'call_ended', call: { call_id: 'unrelated' } }, deps);
    expect(marked).toEqual([]);
    await handleRetellEvent({ event: 'call_ended', call: { call_id: callId } }, deps);
    expect(marked).toEqual(['O1']);
    await h.post('/tools/accept_offer', { call: { call_id: callId }, args: { offer_id: 'O1' } });
    await handleRetellEvent({ event: 'call_ended', call: { call_id: callId } }, deps);
    expect(marked).toHaveLength(1);
    expect((await h.state()).jobs.find((j) => j.id === 'J17')?.driverId).toBe('casey');
  });
});

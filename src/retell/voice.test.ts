import { describe, expect, it } from 'vitest';
import { createRetellVoice } from './voice.ts';
import type { CallKind } from '../voice/port.ts';

const kinds: CallKind[] = ['offer', 'at_risk_check', 'release', 'escalation'];
const agentIds = {
  offer: 'agent-offer',
  at_risk_check: 'agent-check',
  release: 'agent-release',
  escalation: 'agent-escalation',
};

describe('Retell HTTP transport', () => {
  it.each(kinds)('sends %s to its agent with only string dynamic variables', async (kind) => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const voice = createRetellVoice({
      apiKey: 'test-only',
      fromNumber: '+15550000000',
      agentIds,
      allowedNumbers: new Set(['+15550000002']),
      fetch: (url, init) => {
        requests.push({
          url: url instanceof Request ? url.url : url instanceof URL ? url.href : url,
          init,
        });
        return Promise.resolve(Response.json({ call_id: 'call-retell-1' }));
      },
    });
    expect(
      await voice.placeCall({
        kind,
        to: '+15550000002',
        vars: {
          job_id: 'J17',
          driver_id: 'casey',
          offer_id: 'O1',
          reroute_call_id: 'reroute_unique',
        },
      }),
    ).toEqual({ callId: 'call-retell-1' });
    expect(requests[0]?.url).toBe('https://api.retellai.com/v2/create-phone-call');
    expect(
      JSON.parse(typeof requests[0]?.init?.body === 'string' ? requests[0].init.body : '{}'),
    ).toEqual({
      from_number: '+15550000000',
      to_number: '+15550000002',
      override_agent_id: agentIds[kind],
      idempotency_key: 'reroute_unique',
      retell_llm_dynamic_variables: {
        call_kind: kind,
        job_id: 'J17',
        driver_id: 'casey',
        offer_id: 'O1',
        reroute_call_id: 'reroute_unique',
      },
    });
  });

  it('never calls numbers outside the demo fleet and keeps provider error bodies private', async () => {
    let requested = 0;
    const voice = createRetellVoice({
      apiKey: 'test-only',
      fromNumber: '+15550000000',
      agentIds,
      allowedNumbers: new Set(['+15550000002']),
      fetch: () => {
        requested++;
        return Promise.resolve(new Response('sensitive provider payload', { status: 429 }));
      },
    });
    await expect(voice.placeCall({ kind: 'offer', to: '+15550000099', vars: {} })).rejects.toThrow(
      'outside the demo fleet',
    );
    expect(requested).toBe(0);
    await expect(voice.placeCall({ kind: 'offer', to: '+15550000002', vars: {} })).rejects.toThrow(
      'HTTP 429',
    );
  });
});

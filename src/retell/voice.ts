import { z } from 'zod';
import type { CallKind, CallRequest, VoicePort } from '../voice/port.ts';

export interface RetellVoiceOptions {
  apiKey: string;
  fromNumber: string;
  agentIds: Record<CallKind, string>;
  allowedNumbers: ReadonlySet<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const phone = z.string().regex(/^\+[1-9]\d{7,14}$/);
const responseSchema = z.object({ call_id: z.string().min(1) });

/** HTTP transport only. The outbox wraps this port so tool calls never wait on Retell. */
export function createRetellVoice(options: RetellVoiceOptions): VoicePort {
  const request = options.fetch ?? fetch;
  phone.parse(options.fromNumber);
  return {
    async placeCall(call: CallRequest) {
      phone.parse(call.to);
      if (!options.allowedNumbers.has(call.to))
        throw new Error('Phone number is outside the demo fleet.');
      if (!options.agentIds[call.kind])
        throw new Error('No Retell agent configured for this call kind.');
      const vars = z.record(z.string(), z.string()).parse(call.vars);
      const res = await request('https://api.retellai.com/v2/create-phone-call', {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from_number: options.fromNumber,
          to_number: call.to,
          override_agent_id: options.agentIds[call.kind],
          override_agent_version: 'latest_published',
          retell_llm_dynamic_variables: { ...vars, call_kind: call.kind },
          ...(vars['reroute_call_id'] ? { idempotency_key: vars['reroute_call_id'] } : {}),
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
      });
      if (!res.ok) throw new Error(`Retell call request failed (HTTP ${String(res.status)}).`);
      const parsed = responseSchema.safeParse(await res.json());
      if (!parsed.success) throw new Error('Retell returned an invalid call response.');
      return { callId: parsed.data.call_id };
    },
  };
}

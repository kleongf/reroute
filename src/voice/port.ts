export type CallKind = 'offer' | 'at_risk_check' | 'release' | 'escalation';

export interface CallRequest {
  kind: CallKind;
  to: string;
  /** Retell dynamic variables: strings only. */
  vars: Record<string, string>;
}

/** The only way Reroute places phone calls. */
export interface VoicePort {
  placeCall(req: CallRequest): Promise<{ callId: string }>;
}

export interface FakeVoice extends VoicePort {
  readonly calls: readonly (CallRequest & { callId: string })[];
}

/** Records calls instead of placing them. For tests and offline development. */
export function createFakeVoice(): FakeVoice {
  const calls: (CallRequest & { callId: string })[] = [];
  return {
    calls,
    placeCall(req) {
      const callId = `fake-call-${String(calls.length + 1)}`;
      calls.push({ ...req, callId });
      return Promise.resolve({ callId });
    },
  };
}

import type { Clock } from '../domain/clock.ts';
import type { TranscriptBus } from '../events/transcripts.ts';
import type { Store } from '../store/store.ts';
import type { CallKind } from '../voice/port.ts';
import type { RetellWebhook } from './schemas.ts';

export interface CallEventEngine {
  markUnanswered?: (offerId: string) => Promise<unknown>;
}
const kinds: readonly string[] = ['offer', 'at_risk_check', 'release', 'escalation'];

/** Called only after signature and zod validation at the HTTP boundary. */
export async function handleRetellEvent(
  event: RetellWebhook,
  deps: { store: Store; clock: Clock; engine: CallEventEngine; transcripts: TranscriptBus },
): Promise<void> {
  const { call } = event;
  const vars = call.retell_llm_dynamic_variables ?? {};
  const w = deps.store.get();
  if (vars['demo_reset_at'] && vars['demo_reset_at'] !== w.resetAt) return;
  if (event.event === 'call_ended') {
    const offer = w.offers.find(
      (o) =>
        o.status === 'pending' &&
        (o.callId === call.call_id ||
          (vars['reroute_call_id'] && o.callId === vars['reroute_call_id'])),
    );
    if (offer && (!vars['offer_id'] || vars['offer_id'] === offer.id))
      await deps.engine.markUnanswered?.(offer.id);
  }
  if (event.event !== 'transcript_updated') return;
  const entries =
    call.transcript_object ??
    call.transcript_with_tool_calls ??
    event.transcript_with_tool_calls ??
    [];
  const kind = kinds.includes(vars['call_kind'] ?? '')
    ? (vars['call_kind'] as CallKind)
    : 'inbound';
  const driverId =
    vars['driver_id'] ?? w.drivers.find((d) => d.phone && d.phone === call.from_number)?.id ?? null;
  let utteranceIndex = 0;
  for (const entry of entries) {
    if (entry.role !== 'agent' && entry.role !== 'user') continue;
    deps.transcripts.publish({
      callId: call.call_id,
      kind,
      driverId,
      role: entry.role,
      text: entry.content,
      at: deps.clock.now().toISOString(),
      utteranceId: `${call.call_id}:${String(utteranceIndex++)}`,
    });
  }
}

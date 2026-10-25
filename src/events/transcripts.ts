import type { CallKind } from '../voice/port.ts';

export interface Transcript {
  callId: string;
  kind: CallKind | 'inbound';
  driverId: string | null;
  role: 'agent' | 'user';
  text: string;
  at: string;
  utteranceId: string;
}

/** Small replay buffer so a reconnecting dashboard can restore the current conversation. */
export function createTranscriptBus() {
  const utterances = new Map<string, Transcript>();
  const listeners = new Set<(entry: Transcript) => void>();
  return {
    publish(entry: Transcript) {
      if (utterances.get(entry.utteranceId)?.text === entry.text) return;
      utterances.set(entry.utteranceId, entry);
      if (utterances.size > 200) {
        const oldest = utterances.keys().next().value;
        if (oldest) utterances.delete(oldest);
      }
      for (const listener of listeners) listener(entry);
    },
    subscribe(listener: (entry: Transcript) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    entries: () => [...utterances.values()],
    clear: () => {
      utterances.clear();
    },
  };
}
export type TranscriptBus = ReturnType<typeof createTranscriptBus>;

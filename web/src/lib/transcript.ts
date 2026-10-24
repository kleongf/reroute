import type { DriverId } from '@backend/domain/types.ts';
import type { CallKind } from '@backend/voice/port.ts';

/** One `transcript` SSE event (docs/specs/contracts.md). */
export interface TranscriptLine {
  callId: string;
  kind: CallKind | 'inbound';
  driverId: DriverId;
  role: 'agent' | 'user';
  text: string;
  at: string;
  /** Retell revises a line as speech continues; absent = always a new line. */
  utteranceId?: string;
}

/** callId → lines, in arrival order. */
export type Transcripts = ReadonlyMap<string, readonly TranscriptLine[]>;

export const emptyTranscripts: Transcripts = new Map();

/**
 * Pure reducer: upserts by `utteranceId` within the line's call, appends when it is absent
 * or unseen. Returns a new Map (React state friendly); the input is never mutated.
 */
export function addTranscriptLine(state: Transcripts, line: TranscriptLine): Transcripts {
  const lines = state.get(line.callId) ?? [];
  const index =
    line.utteranceId === undefined
      ? -1
      : lines.findIndex((l) => l.utteranceId === line.utteranceId);
  const next = index === -1 ? [...lines, line] : lines.map((l, i) => (i === index ? line : l));
  return new Map(state).set(line.callId, next);
}

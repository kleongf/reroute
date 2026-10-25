import { describe, expect, it } from 'vitest';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { addTranscriptLine, emptyTranscripts, type TranscriptLine } from '@/lib/transcript.ts';
import { currentCall, linesFor } from './model.ts';

const line = (over: Partial<TranscriptLine>): TranscriptLine => ({
  callId: 'c1',
  kind: 'offer',
  driverId: 'casey',
  role: 'agent',
  text: 'Hi',
  at: '2026-10-24T12:00:00.000Z',
  ...over,
});

const snapshot = {
  drivers: [{ id: 'casey', name: 'Casey' }],
  jobs: [],
  placements: [],
} as unknown as StateSnapshot;

describe('call card transcript', () => {
  it('shows a repeated utteranceId as one revised line, not a duplicate', () => {
    let t = addTranscriptLine(emptyTranscripts, line({ utteranceId: 'u1', text: 'Can you' }));
    t = addTranscriptLine(t, line({ utteranceId: 'u1', text: 'Can you take J17?' }));
    t = addTranscriptLine(t, line({ utteranceId: 'u2', role: 'user', text: 'Sure' }));
    t = addTranscriptLine(t, line({ utteranceId: 'u2', role: 'user', text: 'Sure, on my way' }));
    expect(linesFor(t, 'c1', 'casey').map((l) => l.text)).toEqual([
      'Can you take J17?',
      'Sure, on my way',
    ]);
  });

  it('falls back to the Driver’s latest call when the call ID is unknown', () => {
    let t = addTranscriptLine(emptyTranscripts, line({ callId: 'old', text: 'old' }));
    t = addTranscriptLine(t, line({ callId: 'new', text: 'new' }));
    expect(linesFor(t, null, 'casey').map((l) => l.text)).toEqual(['new']);
  });

  it('shows the last call once nothing is live', () => {
    const t = addTranscriptLine(emptyTranscripts, line({ kind: 'at_risk_check' }));
    expect(currentCall(snapshot, t)).toMatchObject({ live: false, title: 'Last call: Casey' });
    expect(currentCall(snapshot, emptyTranscripts)).toBeNull();
  });
});

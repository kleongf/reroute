import { describe, expect, it } from 'vitest';
import { addTranscriptLine, emptyTranscripts, type TranscriptLine } from './transcript.ts';

const line = (over: Partial<TranscriptLine>): TranscriptLine => ({
  callId: 'c1',
  kind: 'offer',
  driverId: 'casey',
  role: 'agent',
  text: 'Hi',
  at: '2026-10-24T12:00:00.000Z',
  ...over,
});

describe('addTranscriptLine', () => {
  it('appends lines without an utteranceId', () => {
    let s = addTranscriptLine(emptyTranscripts, line({ text: 'a' }));
    s = addTranscriptLine(s, line({ text: 'a' }));
    expect(s.get('c1')?.map((l) => l.text)).toEqual(['a', 'a']);
  });

  it('upserts by utteranceId, keeping position', () => {
    let s = addTranscriptLine(emptyTranscripts, line({ utteranceId: 'u1', text: 'Can you' }));
    s = addTranscriptLine(s, line({ utteranceId: 'u2', role: 'user', text: 'Yes' }));
    s = addTranscriptLine(s, line({ utteranceId: 'u1', text: 'Can you take J17?' }));
    expect(s.get('c1')?.map((l) => l.text)).toEqual(['Can you take J17?', 'Yes']);
  });

  it('keeps calls separate and does not mutate the previous state', () => {
    const a = addTranscriptLine(emptyTranscripts, line({ utteranceId: 'u1' }));
    const b = addTranscriptLine(a, line({ callId: 'c2', utteranceId: 'u1', text: 'Other' }));
    expect(a.has('c2')).toBe(false);
    expect(b.get('c1')?.[0]?.text).toBe('Hi');
    expect(b.get('c2')?.[0]?.text).toBe('Other');
  });
});

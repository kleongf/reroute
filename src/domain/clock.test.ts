import { describe, expect, it } from 'vitest';
import { createManualClock, systemClock } from './clock.ts';

describe('createManualClock', () => {
  const start = new Date('2026-10-24T14:00:00.000Z');

  it('starts at the given instant and returns fresh Date objects', () => {
    const clock = createManualClock(start);
    const a = clock.now();
    expect(a.toISOString()).toBe('2026-10-24T14:00:00.000Z');
    a.setFullYear(1999);
    expect(clock.now().toISOString()).toBe('2026-10-24T14:00:00.000Z');
  });

  it('advances and jumps', () => {
    const clock = createManualClock(start);
    clock.advance(15 * 60_000);
    expect(clock.now().toISOString()).toBe('2026-10-24T14:15:00.000Z');
    clock.set(new Date('2026-10-24T15:00:00.000Z'));
    expect(clock.now().toISOString()).toBe('2026-10-24T15:00:00.000Z');
  });

  it('rejects negative or non-finite advances and invalid dates', () => {
    const clock = createManualClock(start);
    expect(() => {
      clock.advance(-1);
    }).toThrow(RangeError);
    expect(() => {
      clock.advance(Number.NaN);
    }).toThrow(RangeError);
    expect(() => createManualClock(new Date('nope'))).toThrow(RangeError);
  });
});

describe('systemClock', () => {
  it('tracks real time', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});

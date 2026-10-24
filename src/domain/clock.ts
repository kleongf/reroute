/**
 * Time source abstraction. Domain code takes a `Clock` instead of calling `new Date()`
 * so scenarios (e.g. "simulated 2:00 p.m.") are deterministic in tests and demos.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export interface ManualClock extends Clock {
  /** Move time forward by `ms` milliseconds. */
  advance(ms: number): void;
  /** Jump to an absolute instant. */
  set(instant: Date): void;
}

export function createManualClock(start: Date): ManualClock {
  let current = toEpochMs(start);
  return {
    now: () => new Date(current),
    advance(ms) {
      if (!Number.isFinite(ms) || ms < 0) {
        throw new RangeError(`advance() needs a finite, non-negative ms value, got ${String(ms)}`);
      }
      current += ms;
    },
    set(instant) {
      current = toEpochMs(instant);
    },
  };
}

function toEpochMs(instant: Date): number {
  const ms = instant.getTime();
  if (Number.isNaN(ms)) {
    throw new RangeError('Invalid Date');
  }
  return ms;
}

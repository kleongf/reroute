import { describe, expect, it } from 'vitest';
import type { StateSnapshot } from '@backend/domain/types.ts';
import fixture from '../../../e2e/fixtures/snapshot.json' with { type: 'json' };
import * as port from './vehicle-motion.ts';

// The original lives in public/ (checked there by vehicle-motion.test.js); a variable path keeps
// the web tsconfig from resolving plain JS outside src.
const ORIGINAL = '../../../public/vehicle-motion.js';
const original = (await import(/* @vite-ignore */ ORIGINAL)) as typeof port;

const load = () => structuredClone(fixture) as unknown as StateSnapshot;

/** Snapshots a Placement walks through: fresh, Casey takes J17, reset. */
function script(): StateSnapshot[] {
  const fresh = load();
  const placed = load();
  const j17 = placed.jobs.find((j) => j.id === 'J17');
  if (j17) Object.assign(j17, { driverId: 'casey', status: 'assigned' });
  placed.placements.push({
    ...placed.placements[0],
    id: 'P-parity',
    jobId: 'J17',
    status: 'placed',
    endedAt: '2026-10-24T12:30:00.000Z',
    offers: [],
  } as StateSnapshot['placements'][number]);
  const reset = { ...load(), resetAt: '2099-01-01T00:00:00.000Z' };
  return [fresh, placed, reset];
}

describe('vehicle-motion TS port', () => {
  it('matches public/vehicle-motion.js frame by frame', () => {
    const a = port.createVehicleMotion();
    const b = original.createVehicleMotion();
    let now = 0;
    for (const snapshot of script()) {
      a.update(snapshot, now);
      b.update(snapshot, now);
      for (let i = 0; i < 12; i++) {
        now += 2500;
        expect([...a.positionsAt(now)]).toEqual([...b.positionsAt(now)]);
        expect(a.isMoving(now)).toBe(b.isMoving(now));
      }
      for (const d of snapshot.drivers) {
        expect(port.chooseTarget(snapshot, d.id)).toEqual(original.chooseTarget(snapshot, d.id));
      }
    }
    expect(port.legDurationMs(3)).toBe(original.legDurationMs(3));
    expect(port.legDurationMs(99)).toBe(original.legDurationMs(99));
  });
});

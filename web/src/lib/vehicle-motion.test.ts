import { describe, expect, it } from 'vitest';
import {
  MAX_LEG_MS,
  MIN_LEG_MS,
  chooseTarget,
  createVehicleMotion,
  legDurationMs,
  lerp,
} from './vehicle-motion.ts';
import fixture from '../../../e2e/fixtures/snapshot.json' with { type: 'json' };
import type { StateSnapshot } from '@backend/domain/types.ts';

function load(): StateSnapshot {
  return structuredClone(fixture) as unknown as StateSnapshot;
}

function driver(s: StateSnapshot, id: string) {
  const d = s.drivers.find((x) => x.id === id);
  if (!d) throw new Error(id);
  return d;
}

function job(s: StateSnapshot, id: string) {
  const j = s.jobs.find((x) => x.id === id);
  if (!j) throw new Error(id);
  return j;
}

function pickupOf(s: StateSnapshot, id: string) {
  const p = job(s, id).pickup;
  return { lat: p.lat, lng: p.lng };
}

/** J18 done, J17 now held by Casey: an assignment change. */
function caseyTakesJ17() {
  const s = load();
  job(s, 'J18').status = 'done';
  const j17 = job(s, 'J17');
  j17.driverId = 'casey';
  j17.status = 'assigned';
  return s;
}

describe('lerp and legDurationMs', () => {
  it('interpolates and clamps', () => {
    const a = { lat: 0, lng: 0 };
    const b = { lat: 10, lng: 20 };
    expect(lerp(a, b, 0.5)).toEqual({ lat: 5, lng: 10 });
    expect(lerp(a, b, 2)).toEqual(b);
    expect(lerp(a, b, -1)).toEqual(a);
  });

  it('derives a demo-friendly duration from the ETA', () => {
    expect(legDurationMs(0)).toBe(MIN_LEG_MS);
    expect(legDurationMs(12)).toBe(12000);
    expect(legDurationMs(600)).toBe(MAX_LEG_MS);
  });
});

describe('chooseTarget', () => {
  it('heads to an assigned Job; Late and idle Drivers stay put', () => {
    const s = load();
    expect(chooseTarget(s, 'casey')?.jobId).toBe('J18');
    expect(chooseTarget(s, 'alex')).toBeNull(); // J17 is Late
    expect(chooseTarget(s, 'blair')).toBeNull(); // no Job
  });

  it('prefers the most recently Placed Job', () => {
    const s = load();
    const j17 = job(s, 'J17');
    j17.driverId = 'casey';
    j17.status = 'assigned';
    s.etas.minutes['casey'] = { J17: 20, J18: 5 };
    expect(chooseTarget(s, 'casey')?.jobId).toBe('J18'); // shorter ETA, nothing Placed yet
    for (const p of s.placements) {
      if (p.jobId !== 'J17') continue;
      p.status = 'placed';
      p.endedAt = s.now;
    }
    expect(chooseTarget(s, 'casey')?.jobId).toBe('J17');
  });
});

describe('createVehicleMotion', () => {
  it('moves an assigned Driver toward the Pickup and leaves idle Drivers put', () => {
    const s = load();
    const motion = createVehicleMotion();
    motion.update(s, 0);
    const start = motion.positionsAt(0).get('casey');
    const mid = motion.positionsAt(3000).get('casey');
    expect(start?.position).toEqual(driver(s, 'casey').position);
    expect(mid?.moving).toBe(true);
    expect(mid?.position).not.toEqual(start?.position);
    expect(motion.positionsAt(MAX_LEG_MS + 1).get('casey')).toEqual({
      position: pickupOf(s, 'J18'),
      moving: false,
    });
    expect(motion.positionsAt(3000).get('blair')).toEqual({
      position: driver(s, 'blair').position,
      moving: false,
    });
    expect(motion.isMoving(3000)).toBe(true);
    expect(motion.isMoving(MAX_LEG_MS + 1)).toBe(false);
  });

  it('never changes the snapshot', () => {
    const s = load();
    const before = JSON.stringify(s);
    const motion = createVehicleMotion();
    motion.update(s, 0);
    motion.positionsAt(5000);
    expect(JSON.stringify(s)).toBe(before);
  });

  it('restarts from where the marker is when the assignment changes', () => {
    const motion = createVehicleMotion();
    motion.update(load(), 0);
    const here = motion.positionsAt(3000).get('casey')?.position;
    const next = caseyTakesJ17();
    motion.update(next, 3000);
    expect(motion.positionsAt(3000).get('casey')?.position).toEqual(here);
    expect(motion.positionsAt(3000 + MAX_LEG_MS).get('casey')?.position).toEqual(
      pickupOf(next, 'J17'),
    );
  });

  it('holds a Driver where they stopped, and restarts from fixture positions on reset', () => {
    const motion = createVehicleMotion();
    motion.update(load(), 0);
    const here = motion.positionsAt(3000).get('casey')?.position;
    const late = load();
    job(late, 'J18').status = 'late';
    motion.update(late, 3000);
    expect(motion.positionsAt(9000).get('casey')).toEqual({ position: here, moving: false });

    const reset = load();
    reset.resetAt = '2026-10-24T13:00:00.000Z';
    motion.update(reset, 9000);
    expect(motion.positionsAt(9000).get('casey')?.position).toEqual(
      driver(reset, 'casey').position,
    );
    expect(motion.isMoving(9001)).toBe(true);
  });
});

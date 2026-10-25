// Simulated vehicle movement for the map: visual only, never changes snapshot state or ETAs.
// Framework-, DOM- and Leaflet-free: call `update` with each snapshot and
// `positionsAt` once per animation frame, passing a monotonic clock in ms.

import type { DriverId, JobId, LatLng, StateSnapshot } from '@backend/domain/types.ts';

/** Demo pace: one ETA minute plays in this many ms of real time. */
export const MS_PER_ETA_MINUTE = 1000;
export const MIN_LEG_MS = 6000;
export const MAX_LEG_MS = 30000;
/** Used when the snapshot has no ETA for a Driver and Job. */
export const DEFAULT_ETA_MINUTES = 15;

/** Job statuses whose Driver is still heading to the Pickup. A Late Job's Driver stops. */
const HEADING = new Set<string>(['assigned', 'at_risk']);

/** @param t 0..1 (clamped) */
export function lerp(from: LatLng, to: LatLng, t: number): LatLng {
  const k = Math.min(1, Math.max(0, t));
  return { lat: from.lat + (to.lat - from.lat) * k, lng: from.lng + (to.lng - from.lng) * k };
}

export function legDurationMs(etaMinutes: number): number {
  return Math.min(MAX_LEG_MS, Math.max(MIN_LEG_MS, etaMinutes * MS_PER_ETA_MINUTE));
}

export interface Target {
  jobId: JobId;
  pickup: LatLng;
  etaMinutes: number;
}

/**
 * The Job whose Pickup a Driver is heading to, or null if the Driver stays put.
 * Among held, uncollected, assigned/At Risk Jobs: the most recently Placed one first
 * (so a freshly accepted Offer takes over), then the shortest ETA, then Job ID.
 */
export function chooseTarget(snapshot: StateSnapshot, driverId: DriverId): Target | null {
  const placedAt = new Map<JobId, string>();
  for (const p of snapshot.placements) {
    if (p.status === 'placed' && p.endedAt !== null) placedAt.set(p.jobId, p.endedAt);
  }
  const etas: Partial<Record<JobId, number>> = snapshot.etas.minutes[driverId] ?? {};
  const candidates = snapshot.jobs
    .filter((j) => j.driverId === driverId && !j.collected && HEADING.has(j.status))
    .map((j) => ({
      jobId: j.id,
      pickup: { lat: j.pickup.lat, lng: j.pickup.lng },
      etaMinutes: etas[j.id] ?? DEFAULT_ETA_MINUTES,
      placedAt: placedAt.get(j.id) ?? '',
    }))
    .sort(
      (a, b) =>
        b.placedAt.localeCompare(a.placedAt) ||
        a.etaMinutes - b.etaMinutes ||
        a.jobId.localeCompare(b.jobId),
    );
  const best = candidates[0];
  return best ? { jobId: best.jobId, pickup: best.pickup, etaMinutes: best.etaMinutes } : null;
}

interface Leg {
  jobId: JobId;
  from: LatLng;
  to: LatLng;
  startMs: number;
  durationMs: number;
}

export interface DisplayPosition {
  position: LatLng;
  moving: boolean;
}

export interface VehicleMotion {
  update(snapshot: StateSnapshot, nowMs: number): void;
  /** Display position of every Driver in the latest snapshot. */
  positionsAt(nowMs: number): Map<DriverId, DisplayPosition>;
  isMoving(nowMs: number): boolean;
}

/**
 * Tracks one straight-line leg per Driver. A leg restarts when the Driver's target Job
 * changes (from where the marker is now) and everything restarts from fixture positions
 * when the demo is reset. A Driver with no target holds where the marker stopped.
 */
export function createVehicleMotion(): VehicleMotion {
  let resetAt: string | null = null;
  /** fixture positions from the latest snapshot */
  let fixture = new Map<DriverId, LatLng>();
  let legs = new Map<DriverId, Leg>();
  /** where Drivers without a leg are held */
  let held = new Map<DriverId, LatLng>();

  function positionOf(id: DriverId, nowMs: number): DisplayPosition | null {
    const leg = legs.get(id);
    if (leg) {
      const t = (nowMs - leg.startMs) / leg.durationMs;
      return { position: lerp(leg.from, leg.to, t), moving: t < 1 };
    }
    const at = held.get(id) ?? fixture.get(id);
    return at ? { position: at, moving: false } : null;
  }

  const motion: VehicleMotion = {
    update(snapshot, nowMs) {
      if (snapshot.resetAt !== resetAt) {
        resetAt = snapshot.resetAt;
        legs = new Map();
        held = new Map();
      }
      fixture = new Map(snapshot.drivers.map((d) => [d.id, d.position]));
      const nextLegs = new Map<DriverId, Leg>();
      for (const driver of snapshot.drivers) {
        const target = chooseTarget(snapshot, driver.id);
        const current = legs.get(driver.id);
        if (target && current?.jobId === target.jobId) {
          nextLegs.set(driver.id, current);
          continue;
        }
        const here = positionOf(driver.id, nowMs)?.position ?? driver.position;
        if (target) {
          nextLegs.set(driver.id, {
            jobId: target.jobId,
            from: here,
            to: target.pickup,
            startMs: nowMs,
            durationMs: legDurationMs(target.etaMinutes),
          });
          held.delete(driver.id);
        } else if (current) {
          held.set(driver.id, here);
        }
      }
      legs = nextLegs;
    },

    positionsAt(nowMs) {
      const out = new Map<DriverId, DisplayPosition>();
      for (const id of fixture.keys()) {
        const p = positionOf(id, nowMs);
        if (p) out.set(id, p);
      }
      return out;
    },

    isMoving(nowMs) {
      for (const p of motion.positionsAt(nowMs).values()) if (p.moving) return true;
      return false;
    },
  };
  return motion;
}

import type { DatabaseSync } from 'node:sqlite';
import { comparePriority } from '../domain/priority.ts';
import { addMinutes } from '../domain/time.ts';
import type {
  DeliveryEstimate,
  DisruptionSummary,
  DriverId,
  Job,
  JobForecast,
  StateSnapshot,
  World,
} from '../domain/types.ts';

/**
 * Holds the World. Commands run synchronously on Node's single thread, so each `update` is
 * atomic; the result is persisted to SQLite as one row so a restart keeps the demo state.
 */
export interface Store {
  get(): World;
  /** Applies `fn` to a copy of the World and commits it only if `fn` returns without throwing. */
  update<T>(fn: (draft: World) => T): T;
  replace(world: World): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(db: DatabaseSync, initial: World): Store {
  db.exec('CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT)');
  const persist = db.prepare('INSERT OR REPLACE INTO world (id, json) VALUES (1, ?)');
  const listeners = new Set<() => void>();
  let world = initial;

  const commit = (next: World) => {
    persist.run(JSON.stringify(next));
    world = next;
    for (const listener of listeners) listener();
  };
  commit(initial);

  return {
    get: () => world,
    update(fn) {
      const draft = structuredClone(world);
      const result = fn(draft);
      commit(draft);
      return result;
    },
    replace: commit,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function toSnapshot(world: World, now: Date): StateSnapshot {
  const queue = world.placements
    .filter((p) => p.status === 'queued')
    .sort((a, b) => comparePriority(a, b, world.jobs))
    .map((p) => p.id);
  return {
    now: now.toISOString(),
    resetAt: world.resetAt,
    drivers: world.drivers,
    jobs: world.jobs,
    placements: world.placements.map((p) => ({
      ...p,
      offers: world.offers.filter((o) => o.placementId === p.id),
      evaluation: world.evaluations[p.id] ?? null,
    })),
    queue,
    activeTraffic: world.trafficEvents.filter((t) => world.activeTrafficIds.includes(t.id)),
    trafficEvents: world.trafficEvents.map((t) => ({ id: t.id, label: t.label })),
    log: world.log,
    ...deriveDisruptions(world),
    forecasts: forecasts(world, now),
  };
}

const MINUTE_MS = 60_000;

/** Estimated delivery if `driverId` heads for `job` at `fromIso`: ETA + traffic + service + trip. */
function estimate(world: World, driverId: DriverId, job: Job, fromIso: string): DeliveryEstimate {
  const eta = world.etaMinutes[driverId]?.[job.id];
  if (eta === undefined) return { driverId, arrivalAt: null, minutesLate: null };
  let traffic = 0;
  for (const t of world.trafficEvents) {
    if (world.activeTrafficIds.includes(t.id)) traffic += t.addedMinutes[driverId] ?? 0;
  }
  const arrivalAt = addMinutes(fromIso, eta + traffic + job.serviceMinutes + job.tripMinutes);
  const minutesLate = Math.round((Date.parse(arrivalAt) - Date.parse(job.deadline)) / MINUTE_MS);
  return { driverId, arrivalAt, minutesLate };
}

/** Held, uncollected Jobs: when their current Driver should deliver, as of `now`. */
function forecasts(world: World, now: Date): JobForecast[] {
  const out: JobForecast[] = [];
  for (const job of world.jobs) {
    if (!job.driverId || job.collected || job.status === 'done') continue;
    const e = estimate(world, job.driverId, job, now.toISOString());
    if (e.arrivalAt === null || e.minutesLate === null) continue;
    out.push({
      jobId: job.id,
      driverId: job.driverId,
      arrivalAt: e.arrivalAt,
      minutesLate: e.minutesLate,
    });
  }
  return out;
}

/** One summary per Disruption Placement: before (reporting Driver) → after (accepting Driver). */
function deriveDisruptions(world: World): Pick<StateSnapshot, 'disruptions' | 'disruptionTally'> {
  const disruptions: DisruptionSummary[] = [];
  for (const p of world.placements) {
    const job = world.jobs.find((j) => j.id === p.jobId);
    if (p.trigger !== 'disruption' || !p.previousDriverId || !job) continue;
    const accepted = world.offers.find((o) => o.placementId === p.id && o.status === 'accepted');
    const placed = p.status === 'placed' && accepted && p.endedAt;
    disruptions.push({
      placementId: p.id,
      jobId: p.jobId,
      driverId: p.previousDriverId,
      reason: p.reason ?? null,
      reportedAt: p.queuedAt,
      status: p.status,
      before: estimate(world, p.previousDriverId, job, p.queuedAt),
      after: placed ? estimate(world, accepted.driverId, job, p.endedAt ?? p.queuedAt) : null,
      endedAt: p.endedAt,
      secondsToFix: placed
        ? Math.round((Date.parse(p.endedAt ?? p.queuedAt) - Date.parse(p.queuedAt)) / 1000)
        : null,
    });
  }
  const fixedTimes = disruptions.flatMap((d) => (d.secondsToFix === null ? [] : [d.secondsToFix]));
  return {
    disruptions,
    disruptionTally: {
      fixed: fixedTimes.length,
      escalated: disruptions.filter((d) => d.status === 'escalated').length,
      open: disruptions.filter((d) => d.status === 'queued' || d.status === 'running').length,
      averageSecondsToFix:
        fixedTimes.length === 0
          ? null
          : Math.round(fixedTimes.reduce((a, b) => a + b, 0) / fixedTimes.length),
    },
  };
}

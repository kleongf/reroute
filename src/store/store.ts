import type { DatabaseSync } from 'node:sqlite';
import type { StateSnapshot, World } from '../domain/types.ts';

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

const tierRank = { high: 0, normal: 1 } as const;

export function toSnapshot(world: World, now: Date): StateSnapshot {
  const deadlineOf = (jobId: string) => world.jobs.find((j) => j.id === jobId)?.deadline ?? '';
  const queue = world.placements
    .filter((p) => p.status === 'queued')
    .sort(
      (a, b) =>
        tierRank[a.tier] - tierRank[b.tier] ||
        deadlineOf(a.jobId).localeCompare(deadlineOf(b.jobId)) ||
        a.queuedAt.localeCompare(b.queuedAt),
    )
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
  };
}

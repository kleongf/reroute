import type { Driver, Job, World } from '../domain/types.ts';
import { log } from '../log.ts';
import type { Store } from '../store/store.ts';
import type { RoutingPort } from './port.ts';

export interface RoutedEtas {
  /** Resolves once every routing request started so far has been applied or abandoned. */
  settled(): Promise<void>;
  detach(): void;
}

/**
 * Keeps the ETA table routed: whenever the World gains a Driver × Job pair not yet routed since
 * the last reset (a reset, an Urgent Job), asks `routing` for those pairs in the background and
 * writes the answers into the ETA table with source `routing.source` ('routed' by default). Never blocks a command; on any
 * error or timeout the fixture / straight-line value stays (source 'fixture').
 */
export function attachRoutedEtas(store: Store, routing: RoutingPort): RoutedEtas {
  const attempted = new Set<string>();
  let pending: Promise<void> = Promise.resolve();

  const check = () => {
    const w = store.get();
    const drivers = new Set<Driver>();
    const jobs = new Set<Job>();
    for (const job of w.jobs) {
      for (const d of w.drivers) {
        const k = `${w.resetAt}|${d.id}|${job.id}`;
        if (attempted.has(k)) continue;
        attempted.add(k);
        drivers.add(d);
        jobs.add(job);
      }
    }
    if (jobs.size === 0) return;
    const run = route(w, [...drivers], [...jobs]).catch((err: unknown) => {
      log('warn', 'routed ETAs failed; keeping fixture ETAs', { error: String(err) });
    });
    pending = Promise.all([pending, run]).then(() => undefined);
  };

  const route = async (w: World, drivers: Driver[], jobs: Job[]) => {
    const grid: (number | null)[][] = routing.table
      ? await routing.table(
          drivers.map((d) => d.position),
          jobs.map((j) => j.pickup),
        )
      : await Promise.all(
          drivers.map((d) =>
            Promise.all(jobs.map((j) => routing.minutes(d.position, j.pickup).catch(() => null))),
          ),
        );
    let routed = 0;
    store.update((draft) => {
      // A reset since the request started makes these answers stale.
      if (draft.resetAt !== w.resetAt) return;
      drivers.forEach((d, i) => {
        jobs.forEach((j, k) => {
          const minutes = grid[i]?.[k];
          if (typeof minutes !== 'number' || !draft.jobs.some((x) => x.id === j.id)) return;
          (draft.etaMinutes[d.id] ??= {})[j.id] = minutes;
          ((draft.etaSource ??= {})[d.id] ??= {})[j.id] = routing.source ?? 'routed';
          routed += 1;
        });
      });
    });
    log('info', 'routed ETAs applied', { routed, requested: drivers.length * jobs.length });
  };

  const detach = store.subscribe(check);
  check();
  return { settled: () => pending, detach };
}

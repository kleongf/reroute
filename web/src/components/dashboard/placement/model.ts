import type { DriverId, JobId, Offer, StateSnapshot } from '@backend/domain/types.ts';

export type PlacementView = StateSnapshot['placements'][number];

const DEMO_TIME_ZONE = 'America/Los_Angeles';

export const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DEMO_TIME_ZONE,
  });

export const driverName = (s: StateSnapshot, id: DriverId | null | undefined) =>
  s.drivers.find((d) => d.id === id)?.name ?? '—';

export const jobOf = (s: StateSnapshot, id: JobId) => s.jobs.find((j) => j.id === id);

/** The running Placement. */
export const runningPlacement = (s: StateSnapshot) =>
  s.placements.find((p) => p.status === 'running') ?? null;

/** The Placement the card shows: the running one, else the last one that started. */
export function shownPlacement(s: StateSnapshot): PlacementView | null {
  return runningPlacement(s) ?? s.placements.filter((p) => p.status !== 'queued').at(-1) ?? null;
}

/** The current Offer: the pending Offer of the running Placement. */
export const currentOffer = (s: StateSnapshot): Offer | null =>
  runningPlacement(s)?.offers.find((o) => o.status === 'pending') ?? null;

/** "live traffic ETA", "routed ETA" or "fixture ETA" (fixture table, or straight line). */
export function etaLabel(s: StateSnapshot, driverId: DriverId, jobId: JobId): string {
  const source = s.etas.source[driverId]?.[jobId];
  if (source === 'traffic') return 'live traffic ETA';
  if (source === 'routed') return 'routed ETA';
  return 'fixture ETA';
}

/** Badge text for an Offer, including the simulated Offer label. */
export function offerText(o: Offer): string {
  const sim = o.simulated ? ' · simulated Offer' : '';
  if (o.status === 'pending') return `Offer: calling…${sim}`;
  if (o.status === 'accepted') return 'Accepted';
  if (o.status === 'declined') {
    const why = o.declineReason ? `: “${o.declineReason}”` : '';
    return `Declined${why}${sim}`;
  }
  return `Unanswered${sim}`;
}

export const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Running',
  placed: 'Placed',
  escalated: 'Escalated',
} as const satisfies Record<PlacementView['status'], string>;

import type { Job, StateSnapshot } from '@backend/domain/types.ts';
import { clockTime, driverName, etaLabel } from '../placement/model.ts';
import { driverTraffic } from './traffic.ts';

/** Compare estimates against the same deadline; never invent a fixed “3 o’clock”. */
export function JobTiming({ snapshot: s, job }: { snapshot: StateSnapshot; job: Job }) {
  const disruption = s.disruptions.findLast((entry) => entry.jobId === job.id);
  const forecast = s.forecasts.find((entry) => entry.jobId === job.id);
  const delay = driverTraffic(s, job.driverId);
  const placed = disruption?.status === 'placed' && disruption.after?.arrivalAt;
  const arrival = placed ? disruption.after?.arrivalAt : forecast?.arrivalAt;
  const previous = placed
    ? disruption.before.arrivalAt
    : delay.minutes > 0 && arrival
      ? new Date(Date.parse(arrival) - delay.minutes * 60_000).toISOString()
      : null;
  return (
    <div
      data-testid="job-timing"
      className="rounded-md bg-white/70 px-2 py-1.5 text-xs text-slate-700"
    >
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
        <span>ETA</span>
        {previous && (
          <>
            <s data-testid="eta-before">{clockTime(previous)}</s>
            <span aria-hidden>→</span>
          </>
        )}
        <b data-testid="eta-after">{arrival ? clockTime(arrival) : 'Unavailable'}</b>
        <span>
          · due <b data-testid="job-deadline">{clockTime(job.deadline)}</b>
        </span>
      </div>
      <div className="mt-1 text-muted-foreground">
        {previous && !placed
          ? 'Without closure → with closure'
          : placed
            ? `${driverName(s, disruption.driverId)} → ${driverName(s, job.driverId)}`
            : `${driverName(s, job.driverId)} · ${String(job.parcels)} parcels`}
        {' · '}
        {job.driverId ? etaLabel(s, job.driverId, job.id) : 'fixture ETA'}
      </div>
      <div className="mt-1">
        {job.pickup.name} → {job.dropoff.name}
        {!job.collected && ' · parcels at Pickup'}
      </div>
    </div>
  );
}

export function DriverTraffic({
  snapshot: s,
  driverId,
}: {
  snapshot: StateSnapshot;
  driverId: string | null;
}) {
  if (s.activeTraffic.length === 0) return null;
  const traffic = driverTraffic(s, driverId);
  return (
    <div data-testid="driver-traffic" className="text-xs text-amber-900">
      {driverName(s, driverId)}{' '}
      {traffic.minutes > 0
        ? `+${String(traffic.minutes)} min before Pickup · ${traffic.labels}`
        : '· unaffected by this simulated traffic'}
    </div>
  );
}

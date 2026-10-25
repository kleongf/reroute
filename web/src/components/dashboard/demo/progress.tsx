import type { DashboardProps } from '../types.ts';
import { cn } from '@/lib/utils.ts';
import { driverTraffic } from './traffic.ts';

/** Placement is confirmed by backend state; release acknowledgement needs a reply. */
export function DemoProgress({ snapshot: s, transcripts }: DashboardProps) {
  const d = s.disruptions.findLast((entry) => driverTraffic(s, entry.driverId).minutes > 0);
  const risk = s.jobs.find((job) => job.status === 'at_risk');
  const driverId = d?.driverId ?? risk?.driverId;
  if (!driverId || driverTraffic(s, driverId).minutes === 0) return null;
  const placement = d && s.placements.find((entry) => entry.id === d.placementId);
  const accepted = placement?.offers.some((offer) => offer.status === 'accepted') ?? false;
  const notified =
    accepted &&
    [...transcripts.values()].some((lines) =>
      lines.some(
        (line) =>
          line.kind === 'release' &&
          line.driverId === driverId &&
          line.role === 'user' &&
          Date.parse(line.at) >= Date.parse(d?.endedAt ?? s.now),
      ),
    );
  const steps = [
    { label: 'Traffic detected', complete: true },
    { label: 'Driver checked', complete: Boolean(d) },
    { label: 'Capacity checked', complete: Boolean(placement?.evaluation) },
    { label: 'Offer Accepted', complete: accepted },
    { label: 'Previous Driver notified', complete: notified },
  ];
  return (
    <div
      data-testid="demo-progress"
      data-complete={String(notified)}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-xs"
    >
      {steps.map((step, index) => (
        <span key={step.label} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden className="text-muted-foreground">
              →
            </span>
          )}
          <span
            data-step={index + 1}
            data-complete={String(step.complete)}
            className={cn('text-muted-foreground', step.complete && 'font-semibold text-green-800')}
          >
            {step.complete ? '✓ ' : ''}
            {step.label}
          </span>
        </span>
      ))}
      {accepted && !notified && (
        <span className="text-muted-foreground">· awaiting release reply</span>
      )}
    </div>
  );
}

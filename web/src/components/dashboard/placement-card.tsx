import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils.ts';
import { OfferBadge } from './placement/offer-badge.tsx';
import {
  clockTime,
  driverName,
  etaLabel,
  jobOf,
  shownPlacement,
  STATUS_LABEL,
  type PlacementView,
} from './placement/model.ts';
import type { DashboardProps } from './types.ts';
import { DriverTraffic } from './demo/job-timing.tsx';

const STATUS_TONE = {
  queued: 'bg-secondary text-secondary-foreground',
  running: 'bg-amber-100 text-amber-900',
  placed: 'bg-emerald-100 text-emerald-900',
  escalated: 'bg-red-100 text-red-900',
} as const satisfies Record<PlacementView['status'], string>;

/** Ranked Eligible Drivers, crossed-out ineligible Drivers, Offer statuses, and the queue. */
export function PlacementCard({ snapshot }: DashboardProps) {
  const [open, setOpen] = useState(true);
  return (
    <Card size="sm" data-testid="placement-panel" aria-label="Placement" role="region">
      <Collapsible open={open} onOpenChange={setOpen}>
        <CardHeader>
          <CardTitle>
            <h2>
              <CollapsibleTrigger
                data-testid="placement-toggle"
                className="flex w-full items-center justify-between gap-2 text-left font-semibold"
              >
                Placement
                <ChevronDown
                  className={cn('size-4 transition-transform', !open && '-rotate-90')}
                  aria-hidden
                />
              </CollapsibleTrigger>
            </h2>
          </CardTitle>
        </CardHeader>
        <CollapsibleContent>
          <CardContent className="flex flex-col gap-3 pt-2">
            <PlacementBody snapshot={snapshot} />
            <PlacementQueue snapshot={snapshot} />
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function PlacementBody({ snapshot: s }: { snapshot: StateSnapshot }) {
  const p = shownPlacement(s);
  if (!p) {
    const atRisk = s.jobs.some((j) => j.status === 'at_risk');
    return (
      <p className="text-muted-foreground">
        {atRisk ? 'Only a Disruption starts a Placement.' : 'No Placement yet.'}
      </p>
    );
  }
  const job = jobOf(s, p.jobId);
  const offerFor = (driverId: string) => p.offers.findLast((o) => o.driverId === driverId);
  const eligible = p.evaluation?.eligible ?? [];
  const ineligible = p.evaluation?.ineligible ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <b>
          {p.jobId} {job?.label ?? ''}
        </b>
        <span className="text-muted-foreground">{p.tier === 'high' ? 'High' : 'Normal'}</span>
        <Badge
          variant="secondary"
          data-testid="placement-status"
          data-status={p.status}
          className={cn('ml-auto', STATUS_TONE[p.status])}
        >
          {STATUS_LABEL[p.status]}
        </Badge>
      </div>
      <ol className="flex flex-col gap-1" data-testid="eligible-list">
        {eligible.length === 0 && <li className="text-muted-foreground">No Eligible Driver</li>}
        {eligible.map((e, i) => {
          const o = offerFor(e.driverId);
          return (
            <li
              key={e.driverId}
              data-driver-id={e.driverId}
              data-offer-status={o?.status}
              className="grid grid-cols-[1.25rem_1fr] gap-x-2 gap-y-1 rounded-md bg-muted/50 px-2 py-1.5"
            >
              <span className="font-mono text-muted-foreground">{i + 1}</span>
              <div className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{driverName(s, e.driverId)}</span>
                  <span className="text-xs text-muted-foreground" data-testid="eligible-eta">
                    {e.etaToPickupMinutes} min to Pickup · {etaLabel(s, e.driverId, p.jobId)}
                  </span>
                </div>
                {o && <OfferBadge offer={o} />}
                <DriverTraffic snapshot={s} driverId={e.driverId} />
              </div>
            </li>
          );
        })}
      </ol>
      <ul className="flex flex-col gap-1" data-testid="ineligible-list">
        {ineligible.map((i) => {
          const o = offerFor(i.driverId);
          return (
            <li
              key={i.driverId}
              data-driver-id={i.driverId}
              className="grid grid-cols-[1.25rem_1fr] gap-x-2 px-2 py-1 text-muted-foreground"
            >
              <span aria-hidden>✕</span>
              <div className="flex flex-col gap-1">
                <span className="line-through">{driverName(s, i.driverId)}</span>
                <DriverTraffic snapshot={s} driverId={i.driverId} />
                {o && <OfferBadge offer={o} />}
                <span className="text-xs" data-testid="ineligible-reason">
                  {i.reason.text}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PlacementQueue({ snapshot: s }: { snapshot: StateSnapshot }) {
  return (
    <div className="flex flex-col gap-1 border-t pt-2">
      <h3 className="text-xs font-semibold text-muted-foreground uppercase">Placement Queue</h3>
      <ol data-testid="placement-queue" className="flex flex-col gap-0.5">
        {s.queue.length === 0 && <li className="text-muted-foreground">Queue empty</li>}
        {s.queue.map((id, i) => {
          const queued = s.placements.find((x) => x.id === id);
          const job = queued ? jobOf(s, queued.jobId) : undefined;
          const name = job ? `${job.id} ${job.label}` : id;
          const tier = queued?.tier === 'high' ? 'High' : 'Normal';
          const due = job ? clockTime(job.deadline) : '—';
          return (
            <li key={id} data-placement-id={id}>
              {`${String(i + 1)}. ${name} · ${tier} · due ${due}`}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

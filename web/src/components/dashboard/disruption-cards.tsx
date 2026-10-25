import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import type { DisruptionSummary, Job } from '@backend/domain/types.ts';
import { useNewlyFixed, useServerNow } from './disruptions/hooks.ts';
import { deliveryText, disruptionModel, mmss, type DisruptionModel } from './disruptions/model.ts';
import type { DashboardProps } from './types.ts';
import './disruptions/disruptions.css';
import { DriverTraffic, JobTiming } from './demo/job-timing.tsx';

type CardStatus = DisruptionSummary['status'] | 'at_risk';

const CARD_CLASS: Record<CardStatus, string> = {
  at_risk: 'border-amber-700 bg-amber-50',
  queued: 'border-red-600 bg-red-50',
  running: 'border-red-600 bg-red-50',
  placed: 'border-green-700 bg-green-50',
  escalated: 'border-violet-600 bg-violet-50',
};

const TAG_CLASS: Record<CardStatus, string> = {
  at_risk: 'bg-amber-700',
  queued: 'bg-red-600',
  running: 'bg-red-600',
  placed: 'bg-green-700',
  escalated: 'bg-violet-600',
};

const AFTER_CLASS = {
  ok: 'text-green-700',
  bad: 'text-violet-700',
  working: 'text-blue-600',
} as const;

function DisruptionCard(props: {
  status: CardStatus;
  jobId: string;
  tag: string;
  title: string;
  reason: string;
  before?: string;
  after: string;
  afterTone: keyof typeof AFTER_CLASS;
  time?: ReactNode;
  timeTestId?: boolean;
  celebrate?: boolean;
  details?: ReactNode;
}) {
  return (
    <Card
      data-testid="disruption-card"
      data-status={props.status}
      data-job-id={props.jobId}
      className={cn(
        'gap-1 rounded-lg border-2 border-l-8 px-3 py-2 shadow-none ring-0',
        CARD_CLASS[props.status],
        props.celebrate && 'reroute-celebrate',
      )}
    >
      <div className="flex items-baseline gap-2 text-base">
        <Badge
          className={cn(
            'rounded px-1.5 text-[11px] font-extrabold tracking-wider text-white uppercase',
            TAG_CLASS[props.status],
          )}
        >
          {props.tag}
        </Badge>
        <b>{props.title}</b>
      </div>
      <div data-testid="disruption-reason" className="text-sm text-muted-foreground">
        {props.reason}
      </div>
      {props.details}
      <div className="grid grid-cols-[auto_1fr] items-baseline gap-x-2 font-semibold">
        {props.before !== undefined && (
          <>
            <div data-testid="disruption-before" className="col-span-2 text-red-600">
              {props.before}
            </div>
            <span className="font-extrabold text-muted-foreground">→</span>
          </>
        )}
        <div
          data-testid="disruption-after"
          className={cn(AFTER_CLASS[props.afterTone], props.before === undefined && 'col-span-2')}
        >
          {props.after}
        </div>
      </div>
      {props.time !== undefined && (
        <div
          data-testid={props.timeTestId ? 'disruption-time' : undefined}
          className="text-xs text-muted-foreground tabular-nums"
        >
          {props.time}
        </div>
      )}
    </Card>
  );
}

function reportedCard(
  m: DisruptionModel,
  d: DisruptionSummary,
  serverNow: number,
  celebrate: boolean,
) {
  const who = m.driverName(d.driverId);
  const job = m.job(d.jobId);
  const before =
    d.before.minutesLate !== null && d.before.minutesLate > 0
      ? deliveryText(d.before.minutesLate, who)
      : `${who} can't complete it`;
  const common = {
    status: d.status,
    jobId: d.jobId,
    title: `${d.jobId} ${m.job(d.jobId)?.label ?? ''}`,
    reason: `${who}: ${d.reason ? `“${d.reason}”` : 'reported a Disruption'}`,
    before,
    timeTestId: true,
    celebrate,
    details: (
      <>
        <DriverTraffic snapshot={m.s} driverId={d.driverId} />
        {job && <JobTiming snapshot={m.s} job={job} />}
      </>
    ),
  };
  if (d.status === 'placed' && d.after) {
    return (
      <DisruptionCard
        key={d.placementId}
        {...common}
        tag="Fixed"
        after={deliveryText(d.after.minutesLate, m.driverName(d.after.driverId))}
        afterTone="ok"
        time={`Fixed in ${mmss(d.secondsToFix ?? 0)}`}
      />
    );
  }
  if (d.status === 'escalated') {
    const took = (Date.parse(d.endedAt ?? d.reportedAt) - Date.parse(d.reportedAt)) / 1000;
    return (
      <DisruptionCard
        key={d.placementId}
        {...common}
        tag="Not fixed"
        after="No Driver accepted · Escalated to Dispatcher"
        afterTone="bad"
        time={`Escalated after ${mmss(took)}`}
      />
    );
  }
  const offeringTo = m.offeringTo(d);
  return (
    <DisruptionCard
      key={d.placementId}
      {...common}
      tag="Late"
      after={offeringTo ? `Offering to ${offeringTo}…` : 'Finding a Driver…'}
      afterTone="working"
      time={`${mmss((serverNow - Date.parse(d.reportedAt)) / 1000)} so far`}
    />
  );
}

/** At Risk is not yet a Disruption: only the Driver's answer turns it into one. */
function atRiskCard(m: DisruptionModel, job: Job) {
  const f = m.forecast(job.id);
  const who = m.driverName(job.driverId);
  return (
    <DisruptionCard
      key={`risk-${job.id}`}
      status="at_risk"
      jobId={job.id}
      tag="At Risk"
      title={`${job.id} ${job.label}`}
      reason={job.note ?? 'traffic check'}
      details={
        <>
          <DriverTraffic snapshot={m.s} driverId={job.driverId} />
          <JobTiming snapshot={m.s} job={job} />
        </>
      }
      before={f ? deliveryText(f.minutesLate, who) : `with ${who}`}
      after={`Checking with ${who}…`}
      afterTone="working"
      time="estimate · simulated traffic"
    />
  );
}

/** Escalated straight away (Parcels collected): no Placement, so no before → after. */
function handoffCard(m: DisruptionModel, job: Job) {
  return (
    <DisruptionCard
      key={`handoff-${job.id}`}
      status="escalated"
      jobId={job.id}
      tag="Not fixed"
      title={`${job.id} ${job.label}`}
      reason={`${m.driverName(job.driverId)}: “${job.note ?? 'Disruption'}”`}
      after="Parcels collected · needs a physical handoff"
      afterTone="bad"
    />
  );
}

/** At Risk Jobs, then Disruptions newest first, then physical handoffs. */
export function DisruptionCards({ snapshot }: DashboardProps) {
  const serverNow = useServerNow(snapshot);
  const isCelebrating = useNewlyFixed(snapshot, serverNow);
  const m = disruptionModel(snapshot);
  const cards = [
    ...m.atRisk.map((j) => atRiskCard(m, j)),
    ...[...snapshot.disruptions]
      .reverse()
      .map((d) => reportedCard(m, d, serverNow, isCelebrating(d.placementId))),
    ...m.handoffs.map((j) => handoffCard(m, j)),
  ];
  return (
    <section
      data-testid="disruption-cards"
      aria-label="Disruptions"
      className="flex max-h-[calc(100vh-8rem)] flex-col gap-2 overflow-y-auto"
    >
      {cards.length === 0 ? (
        <Card className="px-3 py-2 text-sm text-muted-foreground shadow-lg">
          No Disruptions. Every Job is on track.
          {snapshot.jobs
            .filter((job) => job.status === 'assigned')
            .sort((a, b) => a.deadline.localeCompare(b.deadline))
            .slice(0, 1)
            .map((job) => (
              <div key={job.id} className="mt-2 space-y-1">
                <b>
                  {job.id} {job.label}
                </b>
                <JobTiming snapshot={snapshot} job={job} />
              </div>
            ))}
        </Card>
      ) : (
        cards
      )}
    </section>
  );
}

import type { DisruptionSummary, Job, StateSnapshot } from '@backend/domain/types.ts';

/** "m:ss" from seconds, clamped at zero. */
export function mmss(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
}

export const minutes = (n: number) => `${String(n)} min`;

/** "Late by 9 min with Alex" / "On time with Casey, 31 min to spare". */
export function deliveryText(minutesLate: number | null, name: string): string {
  if (minutesLate === null) return `with ${name} (no fixture ETA)`;
  if (minutesLate > 0) return `Late by ${minutes(minutesLate)} with ${name}`;
  return `On time with ${name}, ${minutes(-minutesLate)} to spare`;
}

/** What the top bar and Disruption cards derive from one snapshot. */
export function disruptionModel(s: StateSnapshot) {
  const driverName = (id: string | null | undefined) =>
    s.drivers.find((d) => d.id === id)?.name ?? '—';
  const job = (id: string) => s.jobs.find((j) => j.id === id);
  const running = s.placements.find((p) => p.status === 'running') ?? null;
  const pending = running?.offers.find((o) => o.status === 'pending') ?? null;
  const open = s.disruptions.filter((d) => d.status === 'running' || d.status === 'queued');
  const ended = s.disruptions
    .filter((d) => d.endedAt !== null)
    .sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''));
  const atRisk: Job[] = s.jobs.filter((j) => j.status === 'at_risk');
  const placementJobIds = new Set(s.disruptions.map((d) => d.jobId));
  /** Escalated straight away (Pickup already done): no Placement to show. */
  const handoffs: Job[] = s.jobs.filter(
    (j) => j.status === 'escalated' && !placementJobIds.has(j.id),
  );
  const forecast = (jobId: string) => s.forecasts.find((f) => f.jobId === jobId) ?? null;
  /** Urgent Job Placements: not Disruptions, but the banner should still follow them. */
  const urgent = s.placements.filter((p) => p.trigger === 'urgent_job');
  /** The pending Offer's Driver name if this Disruption's Placement is the running one. */
  const offeringTo = (d: DisruptionSummary) =>
    running?.id === d.placementId && pending ? driverName(pending.driverId) : null;
  return {
    s,
    driverName,
    job,
    running,
    pending,
    open,
    ended,
    atRisk,
    handoffs,
    forecast,
    offeringTo,
    urgent,
  };
}

export type DisruptionModel = ReturnType<typeof disruptionModel>;

export type BannerTone = 'ok' | 'risk' | 'late' | 'fixed' | 'esc';

export interface Banner {
  tone: BannerTone;
  text: string;
  /** Placement whose fix this banner announces (for the celebration). */
  placementId: string | null;
}

export function banner(m: DisruptionModel): Banner {
  const first = m.open[0];
  if (first) {
    const offer = m.running?.jobId === first.jobId ? m.pending : null;
    const doing = offer ? `offering to ${m.driverName(offer.driverId)}` : 'finding a Driver';
    return { tone: 'late', text: `${first.jobId} Late · ${doing}`, placementId: null };
  }
  const risk = m.atRisk[0];
  if (risk) {
    return {
      tone: 'risk',
      text: `${risk.id} At Risk · checking with ${m.driverName(risk.driverId)}`,
      placementId: null,
    };
  }
  const urgentRunning = m.urgent.find((p) => p.status === 'running');
  if (urgentRunning) {
    const offer = urgentRunning.offers.find((o) => o.status === 'pending');
    const label = m.job(urgentRunning.jobId)?.label ?? '';
    const doing = offer ? `offering to ${m.driverName(offer.driverId)}` : 'finding a Driver';
    return {
      tone: 'risk',
      text: `${urgentRunning.jobId} ${label} · ${doing}`,
      placementId: null,
    };
  }
  // The latest ending wins, whether it was a Disruption or an Urgent Job.
  const lastUrgent = m.urgent
    .filter((p) => p.endedAt !== null)
    .sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''))[0];
  const last = m.ended[0];
  if (
    lastUrgent &&
    Date.parse(lastUrgent.endedAt ?? '') >= Date.parse(last?.endedAt ?? '1970-01-01')
  ) {
    const label = m.job(lastUrgent.jobId)?.label ?? '';
    if (lastUrgent.status === 'placed') {
      const accepted = lastUrgent.offers.find((o) => o.status === 'accepted');
      return {
        tone: 'fixed',
        text: `${lastUrgent.jobId} ${label} · ${m.driverName(accepted?.driverId)} has it`,
        placementId: lastUrgent.id,
      };
    }
    return {
      tone: 'esc',
      text: `${lastUrgent.jobId} ${label} · Escalated to Dispatcher`,
      placementId: null,
    };
  }
  if (last?.status === 'placed' && last.after) {
    const late = last.after.minutesLate;
    const how = late !== null && late > 0 ? `late by ${minutes(late)}` : 'on time';
    return {
      tone: 'fixed',
      text: `${last.jobId} fixed · ${m.driverName(last.after.driverId)} has it, ${how}`,
      placementId: last.placementId,
    };
  }
  if (last?.status === 'escalated') {
    return {
      tone: 'esc',
      text: `${last.jobId} not fixed · Escalated to Dispatcher`,
      placementId: null,
    };
  }
  const handoff = m.handoffs[0];
  if (handoff) {
    return {
      tone: 'esc',
      text: `${handoff.id} not fixed · needs a physical handoff`,
      placementId: null,
    };
  }
  return { tone: 'ok', text: 'All Jobs on track', placementId: null };
}

/** The Disruption the Disruption → Placed timer measures: the open one, else the most recent. */
export function timerDisruption(m: DisruptionModel): DisruptionSummary | null {
  return m.open[0] ?? m.s.disruptions.at(-1) ?? null;
}

import type { Clock } from '../domain/clock.ts';
import { evaluate } from '../domain/eligibility.ts';
import { etaMinutesBetween } from '../domain/eta.ts';
import { comparePriority } from '../domain/priority.ts';
import { addMinutes, spokenTime } from '../domain/time.ts';
import type {
  Driver,
  DriverId,
  Evaluation,
  Job,
  JobId,
  OfferId,
  Place,
  Placement,
  Tier,
  World,
} from '../domain/types.ts';
import type { Store } from '../store/store.ts';
import type { VoicePort } from '../voice/port.ts';

/** What a command tells its caller; `message` is a sentence the voice agent can speak. */
export interface CommandResult {
  ok: boolean;
  message: string;
}

export interface Engine {
  reportDisruption(
    driverId: DriverId,
    jobId: JobId,
    reason: string,
    collected: boolean,
  ): Promise<CommandResult>;
  acceptOffer(offerId: OfferId): Promise<CommandResult>;
  injectTraffic(trafficEventId: string): Promise<CommandResult>;
  confirmOnTrack(driverId: DriverId, jobId: JobId): Promise<CommandResult>;
  addUrgentJob(input: UrgentJobInput, tier: Tier): Promise<CommandResult & { jobId?: JobId }>;
  declineOffer(
    offerId: OfferId,
    reason?: string | null,
    statusUpdate?: StatusUpdate,
  ): Promise<CommandResult>;
  markUnanswered(offerId: OfferId): Promise<CommandResult>;
  reportStatus(driverId: DriverId, update: StatusUpdate): Promise<CommandResult>;
}

/** What the Dispatcher's Urgent Job form provides. */
export interface UrgentJobInput {
  label: string;
  pickup: Place;
  dropoff: Place;
  parcels: number;
  deadlineOffsetMin: number;
}

/** A Driver's own update to their record; times are ISO. */
export interface StatusUpdate {
  capacity?: number;
  availableFrom?: string;
  availableUntil?: string;
}

/** Calls per Driver per Placement: the first Offer plus one retry after Unanswered. */
export const MAX_OFFER_ATTEMPTS = 2;

/** Simulated Offers (Blair) always get this scripted reply. */
export const SIMULATED_DECLINE = { reason: 'only room for one', update: { capacity: 1 } };

export interface EngineDeps {
  store: Store;
  clock: Clock;
  voice: VoicePort;
  dispatcherPhone: string | null;
  /** Delay before a simulated Offer resolves itself (SIMULATED_OFFER_MS, default 4000). */
  simulatedOfferMs?: number;
  /** Delay before an Unanswered Offer's Driver is called once more (OFFER_RETRY_MS, default 20000). */
  offerRetryMs?: number;
  /** Runs `fn` after `ms`; injectable so tests can resolve simulated Offers on demand. */
  schedule?: (fn: () => Promise<void>, ms: number) => void;
}

const defaultSchedule = (fn: () => Promise<void>, ms: number) => {
  setTimeout(() => void fn(), ms);
};

/** The Placement lifecycle: the only writer of Offers, Placements, and assignments. */
export function createEngine({
  store,
  clock,
  voice,
  dispatcherPhone,
  simulatedOfferMs = 4000,
  offerRetryMs = 20_000,
  schedule = defaultSchedule,
}: EngineDeps): Engine {
  const nowIso = () => clock.now().toISOString();
  const log = (w: World, text: string) => w.log.push({ at: nowIso(), text });

  /** `recheckOfferId`: the Offer being accepted, so its own Driver is not counted against it. */
  function evaluateFor(
    w: World,
    placement: Placement,
    job: Job,
    recheckOfferId?: OfferId,
  ): Evaluation {
    const offers = w.offers.filter((o) => o.status === 'pending');
    const trafficMinutes: Record<DriverId, number> = {};
    for (const t of w.trafficEvents.filter((e) => w.activeTrafficIds.includes(e.id))) {
      for (const [driverId, minutes] of Object.entries(t.addedMinutes)) {
        trafficMinutes[driverId] = (trafficMinutes[driverId] ?? 0) + minutes;
      }
    }
    return evaluate(job, w.drivers, w.etaMinutes, clock.now(), {
      pendingOfferDriverIds: offers
        .filter((o) => o.placementId !== placement.id)
        .map((o) => o.driverId),
      // A Driver whose only Offer so far went Unanswered gets one more try (a missed ring
      // on stage shouldn't end the Placement); a decline or a second Unanswered is final.
      alreadyOfferedDriverIds: w.offers
        .filter((o) => o.placementId === placement.id && o.id !== recheckOfferId)
        .filter(
          (o, _, mine) =>
            o.status !== 'unanswered' ||
            mine.filter((m) => m.driverId === o.driverId).length >= MAX_OFFER_ATTEMPTS,
        )
        .map((o) => o.driverId),
      trafficMinutes,
    });
  }

  function jobVars(job: Job): Record<string, string> {
    return {
      job_id: job.id,
      job_label: job.label,
      pickup_name: job.pickup.name,
      deadline_spoken: spokenTime(job.deadline),
      parcels: String(job.parcels),
    };
  }

  /** Starts the highest-Priority queued Placement if none is running. */
  async function startNext(): Promise<void> {
    const started = store.update((w) => {
      if (w.placements.some((p) => p.status === 'running')) return null;
      const next = w.placements
        .filter((p) => p.status === 'queued')
        .sort((a, b) => comparePriority(a, b, w.jobs))[0];
      if (!next) return null;
      next.status = 'running';
      next.startedAt = nowIso();
      log(w, `Placement ${next.id} started for ${next.jobId}`);
      return next.id;
    });
    if (started) {
      await makeOffer(started);
      // A Placement that ended inside makeOffer (Escalated) hands over to the next by Priority.
      await startNext();
    }
  }

  /** Evaluates the running Placement and offers its Job to the top Eligible Driver. */
  async function makeOffer(placementId: string): Promise<void> {
    const call = store.update((w): OfferStep => {
      const placement = w.placements.find((p) => p.id === placementId);
      const job = placement && w.jobs.find((j) => j.id === placement.jobId);
      if (placement?.status !== 'running' || !job) return null;
      const evaluation = evaluateFor(w, placement, job);
      w.evaluations[placement.id] = evaluation;
      const top = evaluation.eligible[0];
      const driver = top && w.drivers.find((d) => d.id === top.driverId);
      if (!driver) {
        placement.status = 'escalated';
        placement.endedAt = nowIso();
        // A Late Job keeps its current Driver; only the status changes.
        job.status = 'escalated';
        job.version += 1;
        log(w, `No Eligible Driver for ${job.id}; Placement ${placement.id} Escalated`);
        const tried = w.offers.filter((o) => o.placementId === placement.id).length;
        return escalate(
          w,
          job,
          `No Driver could take the ${job.label} due by ${spokenTime(job.deadline)}: ${String(tried)} ${tried === 1 ? 'Offer was' : 'Offers were'} declined or unanswered and nobody else is eligible.`,
        );
      }
      const offerId = `O${String(w.offers.length + 1)}`;
      w.offers.push({
        id: offerId,
        placementId: placement.id,
        driverId: driver.id,
        status: 'pending',
        declineReason: null,
        simulated: driver.simulated,
        createdAt: nowIso(),
        resolvedAt: null,
        callId: null,
      });
      log(
        w,
        `Offer ${offerId}: ${job.id} to ${driver.name}${driver.simulated ? ' (simulated)' : ''}`,
      );
      if (driver.simulated) return { simulatedOfferId: offerId, resetAt: w.resetAt };
      if (driver.phone === null) return null;
      return {
        kind: 'offer',
        offerId,
        to: driver.phone,
        vars: { call_kind: 'offer', driver_id: driver.id, offer_id: offerId, ...jobVars(job) },
      };
    });
    if (!call) return;
    if ('simulatedOfferId' in call) {
      scheduleSimulatedReply(call.simulatedOfferId, call.resetAt);
      return;
    }
    if (call.kind === 'escalation') {
      await voice.placeCall(call);
      await startNext();
      return;
    }
    const { callId } = await voice.placeCall({ kind: 'offer', to: call.to, vars: call.vars });
    store.update((w) => {
      const offer = w.offers.find((o) => o.id === call.offerId);
      if (offer) offer.callId = callId;
    });
  }

  interface EscalationCall {
    kind: 'escalation';
    to: string;
    vars: Record<string, string>;
  }
  /** What `makeOffer` does after its transaction. */
  type OfferStep =
    | null
    | EscalationCall
    | { simulatedOfferId: OfferId; resetAt: string }
    | { kind: 'offer'; offerId: OfferId; to: string; vars: Record<string, string> };
  type DisruptionOutcome = CommandResult & {
    queued?: boolean;
    escalation?: EscalationCall | null;
  };

  /** Records an Escalation; returns the Dispatcher call to place, or null with no number. */
  function escalate(w: World, job: Job, reason: string): EscalationCall | null {
    log(w, `Escalation: ${reason}`);
    if (!dispatcherPhone) return null;
    return {
      kind: 'escalation',
      to: dispatcherPhone,
      vars: { call_kind: 'escalation', reason, ...jobVars(job) },
    };
  }

  /** Re-runs the Offer step for a Placement after an Unanswered Offer, unless the demo moved on. */
  function scheduleRetry(placementId: string, resetAt: string): void {
    schedule(async () => {
      const w = store.get();
      if (w.resetAt !== resetAt) return;
      if (w.placements.find((p) => p.id === placementId)?.status !== 'running') return;
      // Another Offer may already be out (e.g. a decline arrived meanwhile); don't stack calls.
      if (w.offers.some((o) => o.placementId === placementId && o.status === 'pending')) return;
      await makeOffer(placementId);
      await startNext();
    }, offerRetryMs);
  }

  /** Blair's Offer never reaches VoicePort: it declines itself with the scripted reply. */
  function scheduleSimulatedReply(offerId: OfferId, resetAt: string): void {
    schedule(async () => {
      // A demo reset in between reuses Offer IDs; leave the new World alone.
      if (store.get().resetAt !== resetAt) return;
      await engine.declineOffer(offerId, SIMULATED_DECLINE.reason, SIMULATED_DECLINE.update);
    }, simulatedOfferMs);
  }

  function applyStatus(driver: Driver, update: StatusUpdate): string[] {
    const changes: string[] = [];
    if (update.capacity !== undefined) {
      driver.capacity = update.capacity;
      changes.push(`${String(update.capacity)} free ${update.capacity === 1 ? 'slot' : 'slots'}`);
    }
    if (update.availableFrom !== undefined) {
      driver.availableFrom = update.availableFrom;
      changes.push(`available from ${spokenTime(update.availableFrom)}`);
    }
    if (update.availableUntil !== undefined) {
      driver.availableUntil = update.availableUntil;
      changes.push(`off at ${spokenTime(update.availableUntil)}`);
    }
    if (changes.length > 0) driver.version += 1;
    return changes;
  }

  /** Ends a pending Offer as declined or unanswered, then makes the next Offer. */
  async function resolveOffer(
    offerId: OfferId,
    status: 'declined' | 'unanswered',
    reason: string | null,
    update: StatusUpdate,
  ): Promise<CommandResult> {
    const outcome = store.update((w): CommandResult & { next?: string; retry?: string } => {
      const offer = w.offers.find((o) => o.id === offerId);
      if (!offer) return { ok: false, message: "I can't find that offer." };
      if (offer.status !== 'pending') {
        return {
          ok: true,
          message:
            offer.status === 'accepted'
              ? "You're already confirmed for this job."
              : 'No problem, that offer is closed.',
        };
      }
      const driver = w.drivers.find((d) => d.id === offer.driverId);
      offer.status = status;
      offer.declineReason = reason;
      offer.resolvedAt = nowIso();
      const changes = driver ? applyStatus(driver, update) : [];
      const name = driver?.name ?? offer.driverId;
      const detail = [reason, ...changes].filter(Boolean).join('; ');
      log(
        w,
        status === 'declined'
          ? `${name} declined Offer ${offer.id}${detail ? ` (${detail})` : ''}`
          : `Offer ${offer.id} to ${name} Unanswered`,
      );
      const attempts = w.offers.filter(
        (o) => o.placementId === offer.placementId && o.driverId === offer.driverId,
      ).length;
      if (status === 'unanswered' && attempts < MAX_OFFER_ATTEMPTS) {
        log(w, `Calling ${name} again in ${String(Math.round(offerRetryMs / 1000))}s`);
        return { ok: true, retry: offer.placementId, message: 'Offer Unanswered; retrying.' };
      }
      return {
        ok: true,
        next: offer.placementId,
        message: "No problem, thanks for letting me know. I'll ask someone else.",
      };
    });
    if (outcome.next) await makeOffer(outcome.next);
    if (outcome.retry) scheduleRetry(outcome.retry, store.get().resetAt);
    return { ok: outcome.ok, message: outcome.message };
  }

  const engine: Engine = {
    declineOffer(offerId, reason, statusUpdate) {
      return resolveOffer(offerId, 'declined', reason ?? null, statusUpdate ?? {});
    },

    markUnanswered(offerId) {
      return resolveOffer(offerId, 'unanswered', null, {});
    },

    reportStatus(driverId, update) {
      return Promise.resolve(
        store.update((w): CommandResult => {
          const driver = w.drivers.find((d) => d.id === driverId);
          if (!driver) return { ok: false, message: "Sorry, I can't find your driver record." };
          const changes = applyStatus(driver, update);
          if (changes.length === 0) {
            return { ok: false, message: "Sorry, I didn't catch what changed." };
          }
          log(w, `${driver.name} status: ${changes.join(', ')}`);
          return { ok: true, message: `Got it, I've noted ${changes.join(' and ')}.` };
        }),
      );
    },

    async reportDisruption(driverId, jobId, reason, collected) {
      const outcome = store.update((w): DisruptionOutcome => {
        const job = w.jobs.find((j) => j.id === jobId);
        if (!job) return { ok: false, message: `I can't find job ${jobId}.` };
        const active = w.placements.find(
          (p) => p.jobId === job.id && (p.status === 'queued' || p.status === 'running'),
        );
        if (active) {
          return { ok: true, message: "Got it, I'm already finding someone to take it over." };
        }
        if (job.driverId !== driverId) {
          return { ok: false, message: `Job ${jobId} isn't one of your jobs.` };
        }
        if (job.status === 'escalated') {
          return { ok: true, message: "Thanks. I've already asked the Dispatcher to sort it out." };
        }
        if (collected) {
          job.status = 'escalated';
          job.collected = true;
          job.note = reason;
          job.version += 1;
          log(w, `Disruption on ${job.id} after Pickup; needs a physical handoff`);
          const name = w.drivers.find((d) => d.id === driverId)?.name ?? driverId;
          return {
            ok: true,
            escalation: escalate(
              w,
              job,
              `${name} can't finish the ${job.label} (${reason}) and already has the parcels, so it needs a physical handoff.`,
            ),
            message: "Thanks. I'll get the Dispatcher to arrange a handoff.",
          };
        }
        job.status = 'late';
        job.note = reason;
        job.version += 1;
        const placementId = `P${String(w.placements.length + 1)}`;
        w.placements.push({
          id: placementId,
          jobId: job.id,
          trigger: 'disruption',
          tier: 'high',
          queuedAt: nowIso(),
          status: 'queued',
          previousDriverId: driverId,
          startedAt: null,
          endedAt: null,
          reason,
        });
        const driverName = w.drivers.find((d) => d.id === driverId)?.name ?? driverId;
        log(w, `Disruption: ${driverName} on ${job.id} (${reason}); Job Late`);
        return {
          ok: true,
          queued: true,
          message: "Keep going; I'll call you if someone takes it over.",
        };
      });
      if (outcome.escalation) await voice.placeCall(outcome.escalation);
      if (outcome.queued) await startNext();
      return { ok: outcome.ok, message: outcome.message };
    },

    async acceptOffer(offerId) {
      const outcome = store.update(
        (
          w,
        ): CommandResult & {
          placed?: boolean;
          release?: { to: string; vars: Record<string, string> } | null;
        } => {
          const offer = w.offers.find((o) => o.id === offerId);
          if (!offer) return { ok: false, message: "I can't find that offer." };
          if (offer.status === 'accepted') {
            return { ok: true, message: "You're already confirmed for this job." };
          }
          const placement = w.placements.find((p) => p.id === offer.placementId);
          const job = placement && w.jobs.find((j) => j.id === placement.jobId);
          const driver = w.drivers.find((d) => d.id === offer.driverId);
          const current = w.offers.filter((o) => o.placementId === offer.placementId).at(-1);
          if (
            offer.status !== 'pending' ||
            placement?.status !== 'running' ||
            current?.id !== offer.id ||
            !job ||
            !driver
          ) {
            log(w, `Rejected stale accept for Offer ${offerId}`);
            return { ok: false, message: 'Sorry, that offer is no longer open.' };
          }
          const recheck = evaluateFor(w, placement, job, offer.id);
          const stillEligible = recheck.eligible.some((e) => e.driverId === driver.id);
          if (!stillEligible) {
            const reason = recheck.ineligible.find((i) => i.driverId === driver.id)?.reason.text;
            log(
              w,
              `Rejected accept for Offer ${offerId}: ${driver.name} ${reason ?? 'ineligible'}`,
            );
            return {
              ok: false,
              message: `Sorry, I can't give you this job any more: ${reason ?? 'you are no longer eligible'}.`,
            };
          }
          const at = nowIso();
          offer.status = 'accepted';
          offer.resolvedAt = at;
          job.driverId = driver.id;
          job.status = 'assigned';
          job.note = null;
          job.version += 1;
          driver.capacity -= job.parcels;
          driver.version += 1;
          placement.status = 'placed';
          placement.endedAt = at;
          w.evaluations[placement.id] = recheck;
          log(w, `${driver.name} accepted ${job.id}; Placement ${placement.id} Placed`);
          const previous: Driver | undefined = w.drivers.find(
            (d) => d.id === placement.previousDriverId,
          );
          return {
            ok: true,
            placed: true,
            message: `Great, ${job.label} is yours. Head to ${job.pickup.name}; it's due by ${spokenTime(job.deadline)}.`,
            release: previous?.phone
              ? {
                  to: previous.phone,
                  vars: {
                    call_kind: 'release',
                    driver_id: previous.id,
                    driver_name: driver.name,
                    ...jobVars(job),
                  },
                }
              : null,
          };
        },
      );
      if (outcome.placed) {
        if (outcome.release) await voice.placeCall({ kind: 'release', ...outcome.release });
        await startNext();
      }
      return { ok: outcome.ok, message: outcome.message };
    },

    async injectTraffic(trafficEventId) {
      const calls = store.update((w): { to: string; vars: Record<string, string> }[] | null => {
        const event = w.trafficEvents.find((t) => t.id === trafficEventId);
        if (!event) return null;
        if (w.activeTrafficIds.includes(event.id)) return [];
        w.activeTrafficIds.push(event.id);
        log(w, `Traffic: ${event.label} (simulated traffic)`);
        const now = nowIso();
        const out: { to: string; vars: Record<string, string> }[] = [];
        for (const job of w.jobs) {
          const delay = job.driverId ? (event.addedMinutes[job.driverId] ?? 0) : 0;
          if (!job.driverId || job.collected || delay === 0) continue;
          if (job.status !== 'assigned' && job.status !== 'at_risk') continue;
          const driverId = job.driverId;
          const baseEta = w.etaMinutes[driverId]?.[job.id];
          if (baseEta === undefined) continue;
          let traffic = 0;
          for (const t of w.trafficEvents.filter((e) => w.activeTrafficIds.includes(e.id))) {
            traffic += t.addedMinutes[driverId] ?? 0;
          }
          const arrival = addMinutes(now, baseEta + traffic + job.serviceMinutes + job.tripMinutes);
          if (arrival <= job.deadline) continue;
          job.status = 'at_risk';
          job.note = `${event.label}; arrives ${spokenTime(arrival)}`;
          job.version += 1;
          const driver = w.drivers.find((d) => d.id === driverId);
          log(w, `${job.id} At Risk: ${driver?.name ?? driverId} arrives ${spokenTime(arrival)}`);
          if (!driver?.phone || driver.simulated) continue;
          out.push({
            to: driver.phone,
            vars: {
              call_kind: 'at_risk_check',
              driver_id: driver.id,
              driver_name: driver.name,
              ...jobVars(job),
              reason: event.label,
              eta_spoken: spokenTime(arrival),
              delay_minutes: String(delay),
            },
          });
        }
        return out;
      });
      if (!calls) return { ok: false, message: `Unknown traffic event ${trafficEventId}.` };
      for (const call of calls) await voice.placeCall({ kind: 'at_risk_check', ...call });
      return { ok: true, message: `${String(calls.length)} check call(s) placed.` };
    },

    confirmOnTrack(driverId, jobId) {
      return Promise.resolve(
        store.update((w): CommandResult => {
          const job = w.jobs.find((j) => j.id === jobId);
          if (!job) return { ok: false, message: `I can't find job ${jobId}.` };
          if (job.driverId !== driverId) {
            return { ok: false, message: `Job ${jobId} isn't one of your jobs.` };
          }
          if (job.status === 'at_risk') {
            job.status = 'assigned';
            job.note = 'Driver confirmed';
            job.version += 1;
            const name = w.drivers.find((d) => d.id === driverId)?.name ?? driverId;
            log(w, `${name} confirmed on track for ${job.id}`);
          } else if (job.status !== 'assigned') {
            return { ok: false, message: `Job ${jobId} is ${job.status.replace('_', ' ')} now.` };
          }
          return { ok: true, message: `Thanks, I've noted you're on track for ${job.label}.` };
        }),
      );
    },

    async addUrgentJob(input, tier) {
      const jobId = store.update((w) => {
        const id = `U${String(w.jobs.filter((j) => j.id.startsWith('U')).length + 1)}`;
        const at = nowIso();
        w.jobs.push({
          id,
          label: input.label,
          pickup: input.pickup,
          dropoff: input.dropoff,
          parcels: input.parcels,
          deadline: new Date(
            clock.now().getTime() + input.deadlineOffsetMin * 60_000,
          ).toISOString(),
          serviceMinutes: 3,
          tripMinutes: etaMinutesBetween(input.pickup, input.dropoff),
          driverId: null,
          collected: false,
          status: 'unassigned',
          note: null,
          version: 0,
        });
        // Urgent Jobs are not in the fixture ETA table: straight line at city speed.
        for (const d of w.drivers) {
          (w.etaMinutes[d.id] ??= {})[id] = etaMinutesBetween(d.position, input.pickup);
        }
        const placementId = `P${String(w.placements.length + 1)}`;
        w.placements.push({
          id: placementId,
          jobId: id,
          trigger: 'urgent_job',
          tier,
          queuedAt: at,
          status: 'queued',
          previousDriverId: null,
          startedAt: null,
          endedAt: null,
        });
        log(w, `Urgent Job ${id} (${input.label}) added; ${tier} Placement ${placementId} queued`);
        return id;
      });
      await startNext();
      return { ok: true, message: `Urgent Job ${jobId} queued.`, jobId };
    },
  };
  return engine;
}

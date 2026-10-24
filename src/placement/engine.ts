import type { Clock } from '../domain/clock.ts';
import { evaluate } from '../domain/eligibility.ts';
import { etaMinutesBetween } from '../domain/eta.ts';
import { comparePriority } from '../domain/priority.ts';
import { spokenTime } from '../domain/time.ts';
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
  addUrgentJob(input: UrgentJobInput, tier: Tier): Promise<CommandResult & { jobId?: JobId }>;
}

/** What the Dispatcher's Urgent Job form provides. */
export interface UrgentJobInput {
  label: string;
  pickup: Place;
  dropoff: Place;
  parcels: number;
  deadlineOffsetMin: number;
}

export interface EngineDeps {
  store: Store;
  clock: Clock;
  voice: VoicePort;
  dispatcherPhone: string | null;
}

/** The Placement lifecycle: the only writer of Offers, Placements, and assignments. */
export function createEngine({ store, clock, voice }: EngineDeps): Engine {
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
      alreadyOfferedDriverIds: w.offers
        .filter((o) => o.placementId === placement.id && o.id !== recheckOfferId)
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
    const call = store.update((w) => {
      const placement = w.placements.find((p) => p.id === placementId);
      const job = placement && w.jobs.find((j) => j.id === placement.jobId);
      if (placement?.status !== 'running' || !job) return null;
      const evaluation = evaluateFor(w, placement, job);
      w.evaluations[placement.id] = evaluation;
      const top = evaluation.eligible[0];
      const driver = top && w.drivers.find((d) => d.id === top.driverId);
      if (!driver) {
        // TODO(#5): call the Dispatcher with a one-sentence explanation.
        placement.status = 'escalated';
        placement.endedAt = nowIso();
        log(w, `No Eligible Driver for ${job.id}; Placement ${placement.id} Escalated`);
        return null;
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
      // TODO(#5): simulated Offers resolve themselves after SIMULATED_OFFER_MS.
      if (driver.simulated || driver.phone === null) return null;
      return {
        offerId,
        to: driver.phone,
        vars: { call_kind: 'offer', driver_id: driver.id, offer_id: offerId, ...jobVars(job) },
      };
    });
    if (!call) return;
    const { callId } = await voice.placeCall({ kind: 'offer', to: call.to, vars: call.vars });
    store.update((w) => {
      const offer = w.offers.find((o) => o.id === call.offerId);
      if (offer) offer.callId = callId;
    });
  }

  return {
    async reportDisruption(driverId, jobId, reason, collected) {
      const outcome = store.update((w): CommandResult & { queued?: boolean } => {
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
        if (collected) {
          // TODO(#5): escalate to the Dispatcher ("needs a physical handoff").
          job.status = 'escalated';
          job.note = reason;
          job.version += 1;
          log(w, `Disruption on ${job.id} after Pickup; needs a physical handoff`);
          return { ok: true, message: "Thanks. I'll get the Dispatcher to arrange a handoff." };
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
        });
        const driverName = w.drivers.find((d) => d.id === driverId)?.name ?? driverId;
        log(w, `Disruption: ${driverName} on ${job.id} (${reason}); Job Late`);
        return {
          ok: true,
          queued: true,
          message: "Keep going; I'll call you if someone takes it over.",
        };
      });
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
}

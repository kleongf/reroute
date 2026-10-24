import { addMinutes, spokenTime } from './time.ts';
import type { Driver, DriverId, EtaTable, Evaluation, Ineligibility, Job } from './types.ts';

export interface EvaluationContext {
  /** Drivers holding a pending Offer for any other Placement. */
  pendingOfferDriverIds: readonly DriverId[];
  /** Drivers already offered this Job in the current Placement. */
  alreadyOfferedDriverIds: readonly DriverId[];
  /** Minutes added to each Driver's ETAs by active traffic. */
  trafficMinutes: Readonly<Record<DriverId, number>>;
}

/**
 * Pure eligibility check for one Job against every Driver. Eligible Drivers are ranked by ETA
 * to Pickup, then Driver ID; every other Driver gets a one-line reason.
 */
export function evaluate(
  job: Job,
  drivers: readonly Driver[],
  etaTable: EtaTable,
  now: Date,
  context: EvaluationContext,
): Evaluation {
  const nowIso = now.toISOString();
  const eligible: Evaluation['eligible'] = [];
  const ineligible: Evaluation['ineligible'] = [];

  for (const driver of drivers) {
    const baseEta = etaTable[driver.id]?.[job.id];
    const eta =
      baseEta === undefined ? undefined : baseEta + (context.trafficMinutes[driver.id] ?? 0);
    const reason = reasonFor(job, driver, eta, nowIso, context);
    if (reason) ineligible.push({ driverId: driver.id, reason });
    else if (eta !== undefined) eligible.push({ driverId: driver.id, etaToPickupMinutes: eta });
  }

  eligible.sort(
    (a, b) => a.etaToPickupMinutes - b.etaToPickupMinutes || a.driverId.localeCompare(b.driverId),
  );
  return { jobId: job.id, at: nowIso, eligible, ineligible };
}

function reasonFor(
  job: Job,
  driver: Driver,
  eta: number | undefined,
  nowIso: string,
  context: EvaluationContext,
): Ineligibility | null {
  if (driver.id === job.driverId) return { kind: 'current_driver', text: 'current Driver' };
  if (context.alreadyOfferedDriverIds.includes(driver.id)) {
    return { kind: 'already_offered', text: 'already offered this Job' };
  }
  if (context.pendingOfferDriverIds.includes(driver.id)) {
    return { kind: 'pending_offer', text: 'has a pending Offer' };
  }
  if (eta === undefined) return { kind: 'too_far', text: 'no route to Pickup' };
  const arrival = addMinutes(nowIso, eta + job.serviceMinutes + job.tripMinutes);
  if (driver.availableFrom > nowIso) {
    return { kind: 'unavailable', text: `on from ${spokenTime(driver.availableFrom)}` };
  }
  if (driver.availableUntil < arrival) {
    return { kind: 'unavailable', text: `off at ${spokenTime(driver.availableUntil)}` };
  }
  if (driver.capacity < job.parcels) {
    const slots = `${String(driver.capacity)} slot${driver.capacity === 1 ? '' : 's'}`;
    return { kind: 'capacity', text: `${slots} < ${String(job.parcels)} parcels` };
  }
  if (arrival > job.deadline) {
    return {
      kind: 'too_far',
      text: `arrives ${spokenTime(arrival)} > ${spokenTime(job.deadline)}`,
    };
  }
  if (driver.phone === null && !driver.simulated) {
    return { kind: 'unreachable', text: 'no phone number' };
  }
  return null;
}

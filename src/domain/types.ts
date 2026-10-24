// Domain types. Vocabulary: GLOSSARY.md. Shape: docs/specs/contracts.md.

export type DriverId = string;
export type JobId = string;
export type OfferId = string;
export type PlacementId = string;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place extends LatLng {
  name: string;
}

export interface Driver {
  id: DriverId;
  name: string;
  /** E.164; null = never callable (fixture-only Driver). */
  phone: string | null;
  /** True = Offers resolve without a call (labelled "simulated Offer"). */
  simulated: boolean;
  position: LatLng;
  /** Free parcel slots. */
  capacity: number;
  availableFrom: string;
  availableUntil: string;
  version: number;
}

export type JobStatus = 'assigned' | 'at_risk' | 'late' | 'unassigned' | 'escalated' | 'done';

export interface Job {
  id: JobId;
  label: string;
  pickup: Place;
  dropoff: Place;
  parcels: number;
  deadline: string;
  serviceMinutes: number;
  tripMinutes: number;
  driverId: DriverId | null;
  collected: boolean;
  status: JobStatus;
  note: string | null;
  version: number;
}

export type Tier = 'high' | 'normal';
export type PlacementStatus = 'queued' | 'running' | 'placed' | 'escalated';
export type PlacementTrigger = 'disruption' | 'urgent_job';

export interface Placement {
  id: PlacementId;
  jobId: JobId;
  trigger: PlacementTrigger;
  tier: Tier;
  queuedAt: string;
  status: PlacementStatus;
  previousDriverId: DriverId | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Disruption Placements: the Driver's stated reason, kept after the Job note is cleared. */
  reason?: string;
}

export type OfferStatus = 'pending' | 'accepted' | 'declined' | 'unanswered';

export interface Offer {
  id: OfferId;
  placementId: PlacementId;
  driverId: DriverId;
  status: OfferStatus;
  declineReason: string | null;
  simulated: boolean;
  createdAt: string;
  resolvedAt: string | null;
  callId: string | null;
}

export type IneligibilityKind =
  | 'unavailable'
  | 'capacity'
  | 'too_far'
  | 'pending_offer'
  | 'already_offered'
  | 'unreachable'
  | 'current_driver';

export interface Ineligibility {
  kind: IneligibilityKind;
  text: string;
}

export interface Evaluation {
  jobId: JobId;
  at: string;
  eligible: { driverId: DriverId; etaToPickupMinutes: number }[];
  ineligible: { driverId: DriverId; reason: Ineligibility }[];
}

export interface TrafficEvent {
  id: string;
  label: string;
  path: [number, number][];
  /** Extra minutes added to each listed Driver's ETAs. */
  addedMinutes: Record<DriverId, number>;
}

/** Minutes from each Driver's position to each Job's Pickup. */
export type EtaTable = Record<DriverId, Record<JobId, number>>;

/**
 * Where an ETA came from: a routing service ('routed'), a live-traffic routing service
 * ('traffic'), or the fixture table / straight-line estimate ('fixture').
 */
export type EtaSource = 'routed' | 'traffic' | 'fixture';

/** Provenance of each ETA table entry; a missing entry means 'fixture'. */
export type EtaSourceTable = Record<DriverId, Record<JobId, EtaSource>>;

export interface LogEntry {
  at: string;
  text: string;
}

/** The whole mutable state of Reroute. */
export interface World {
  resetAt: string;
  drivers: Driver[];
  jobs: Job[];
  placements: Placement[];
  offers: Offer[];
  evaluations: Record<PlacementId, Evaluation>;
  etaMinutes: EtaTable;
  /** Set by routed-ETA refresh (#11); absent in fixture-only Worlds. */
  etaSource?: EtaSourceTable;
  trafficEvents: TrafficEvent[];
  activeTrafficIds: string[];
  log: LogEntry[];
}

/** Estimated delivery of a held Job by its current Driver, from fixture ETAs + active traffic. */
export interface JobForecast {
  jobId: JobId;
  driverId: DriverId;
  arrivalAt: string;
  /** Positive = minutes past the deadline; negative = minutes to spare. */
  minutesLate: number;
}

/** One Driver's estimated delivery of a Job, derived at a given moment. */
export interface DeliveryEstimate {
  driverId: DriverId;
  /** null when the fixture has no ETA for this Driver and Job. */
  arrivalAt: string | null;
  /** Positive = minutes past the deadline; negative = minutes to spare. */
  minutesLate: number | null;
}

/** A Disruption and how Reroute resolved it; derived from its Placement. */
export interface DisruptionSummary {
  placementId: PlacementId;
  jobId: JobId;
  /** The Driver who reported it. */
  driverId: DriverId;
  reason: string | null;
  reportedAt: string;
  status: PlacementStatus;
  /** The reporting Driver's estimate, as of the report. */
  before: DeliveryEstimate;
  /** The accepting Driver's estimate, as of the Placement; null until Placed. */
  after: DeliveryEstimate | null;
  /** Placed or Escalated time. */
  endedAt: string | null;
  /** Seconds from the report to Placed; null unless Placed. */
  secondsToFix: number | null;
}

export interface DisruptionTally {
  fixed: number;
  escalated: number;
  open: number;
  /** Mean seconds from Disruption to Placed over fixed ones; null if none. */
  averageSecondsToFix: number | null;
}

/** What the dashboard receives as the `state` SSE event. */
export interface StateSnapshot {
  now: string;
  resetAt: string;
  drivers: Driver[];
  jobs: Job[];
  placements: (Placement & { offers: Offer[]; evaluation: Evaluation | null })[];
  queue: PlacementId[];
  activeTraffic: TrafficEvent[];
  trafficEvents: { id: string; label: string }[];
  log: LogEntry[];
  forecasts: JobForecast[];
  disruptions: DisruptionSummary[];
  disruptionTally: DisruptionTally;
  /** Base ETA to Pickup (before traffic) and its provenance, per Driver per Job. */
  etas: { minutes: EtaTable; source: EtaSourceTable };
}

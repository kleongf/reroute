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
  trafficEvents: TrafficEvent[];
  activeTrafficIds: string[];
  log: LogEntry[];
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
}

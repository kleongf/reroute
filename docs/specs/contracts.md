# Contracts

The seams between tickets. Each ticket owns one side of a seam; change a contract here first, in its own commit, and tell whoever owns the other side. Behaviour lives in [`../plan.md`](../plan.md); vocabulary in [`../../GLOSSARY.md`](../../GLOSSARY.md).

## Module layout

| Path | Owns | Depends on |
|---|---|---|
| `src/domain/types.ts` | Domain types below | nothing |
| `src/domain/eligibility.ts` | `evaluate()`: pure eligibility + ranking | types |
| `src/domain/priority.ts` | `comparePriority()`: Placement Queue order | types |
| `src/store/` | SQLite schema, repository, transactions, fixture load/reset | types |
| `src/placement/engine.ts` | Placement lifecycle; the only writer of Offers, Placements, assignments | store, eligibility, priority, `VoicePort` |
| `src/voice/port.ts` | `VoicePort` interface + `FakeVoice` for tests | types |
| `src/retell/` | `RetellVoice implements VoicePort`, tool + event webhooks | engine, store |
| `src/events/` | In-process bus; `/events` SSE emits `state` and `transcript` | store |
| `public/` | Dashboard: renders `state` snapshots, posts to `/api/*` | HTTP only |

## Domain types

```ts
type DriverId = string; type JobId = string; type OfferId = string; type PlacementId = string;

interface LatLng { lat: number; lng: number }

interface Driver {
  id: DriverId; name: string;
  phone: string | null;          // E.164; null = never callable (fixture-only)
  simulated: boolean;            // true = Offers resolve via SimulatedVoice (Blair)
  position: LatLng;              // "simulated positions"
  capacity: number;              // free parcel slots
  availableFrom: string;         // ISO time
  availableUntil: string;        // ISO time
  version: number;
}

type JobStatus = 'assigned' | 'at_risk' | 'late' | 'unassigned' | 'escalated' | 'done';

interface Job {
  id: JobId; label: string;      // "Oak Street pickup"
  pickup: LatLng & { name: string };
  dropoff: LatLng & { name: string };
  parcels: number;
  deadline: string;              // ISO time
  serviceMinutes: number; tripMinutes: number;
  driverId: DriverId | null;
  collected: boolean;
  status: JobStatus;
  version: number;
}

type Tier = 'high' | 'normal';
type PlacementStatus = 'queued' | 'running' | 'placed' | 'escalated';
type PlacementTrigger = 'disruption' | 'urgent_job';

interface Placement {
  id: PlacementId; jobId: JobId; trigger: PlacementTrigger;
  tier: Tier; queuedAt: string;  // Priority = tier, job.deadline, queuedAt (fixed at queue time)
  status: PlacementStatus;
  previousDriverId: DriverId | null;
  startedAt: string | null; endedAt: string | null;
}

type OfferStatus = 'pending' | 'accepted' | 'declined' | 'unanswered';

interface Offer {
  id: OfferId; placementId: PlacementId; driverId: DriverId;
  status: OfferStatus; declineReason: string | null;
  simulated: boolean; createdAt: string; resolvedAt: string | null;
  callId: string | null;         // Retell call_id
}

type Ineligibility =
  | { kind: 'unavailable'; text: string }      // "off at 3:00"
  | { kind: 'capacity'; text: string }         // "1 slot < 2 parcels"
  | { kind: 'too_far'; text: string }          // "arrives 3:12 > 3:00"
  | { kind: 'pending_offer'; text: string }
  | { kind: 'already_offered'; text: string }
  | { kind: 'unreachable'; text: string }      // phone null and not simulated
  | { kind: 'current_driver'; text: string };

interface Evaluation {
  jobId: JobId; at: string;
  eligible: { driverId: DriverId; etaToPickupMinutes: number }[];   // ranked
  ineligible: { driverId: DriverId; reason: Ineligibility }[];
}
```

`evaluate(job, drivers, etaTable, now, context)` is pure: `context` carries Drivers with pending Offers (`pendingOfferDriverIds`), Drivers already offered this Placement (`alreadyOfferedDriverIds`), and per-Driver minutes added by active traffic (`trafficMinutes`). Ranking: ETA to Pickup ascending, then Driver ID.

## Fixtures

`fixtures/demo.json`. Every time is minutes relative to reset (`"deadlineOffsetMin": 60`); the loader converts with the real clock.

```jsonc
{
  "drivers": [{ "id": "alex", "name": "Alex", "phone": "+1…", "simulated": false,
                "position": {…}, "capacity": 2, "availableFromOffsetMin": -120, "availableUntilOffsetMin": 240 }],
  "jobs": [{ "id": "J17", "label": "Oak Street pickup", "pickup": {…}, "dropoff": {…}, "parcels": 2,
             "deadlineOffsetMin": 60, "serviceMinutes": 3, "tripMinutes": 15, "driverId": "alex" }],
  "etaMinutes": { "alex": { "J17": 50 }, "casey": { "J17": 9 } },   // driver → job → minutes to Pickup
  "trafficEvents": [{ "id": "i280", "label": "I-280 closed", "path": [[lat, lng], …],
                      "addedMinutes": { "alex": 40 } }]
}
```

Real phone numbers come from env (`DRIVER_PHONE_ALEX`, `DRIVER_PHONE_CASEY`, `DISPATCHER_PHONE`), never from the committed fixture.

## VoicePort

```ts
type CallKind = 'offer' | 'at_risk_check' | 'release' | 'escalation';

interface VoicePort {
  placeCall(req: {
    kind: CallKind; to: string;
    vars: Record<string, string>;   // Retell dynamic variables: strings only
  }): Promise<{ callId: string }>;
}
```

Vars always include `call_kind`, plus `job_id`, `job_label`, `pickup_name`, `deadline_spoken` ("3:00 PM"), `parcels`, and as relevant `offer_id`, `driver_id`, `driver_name`, `reason`. `at_risk_check` calls also carry `eta_spoken` (estimated arrival with traffic, "3:08 PM") and `delay_minutes`; `reason` is the traffic event label. Simulated Drivers never reach `VoicePort`; the engine resolves their Offer itself after a short delay (`SIMULATED_OFFER_MS`, default 4000) using the fixture's scripted reply.

## Engine commands

All are idempotent: re-sending one whose effect already happened returns the current state and changes nothing.

| Command | From | Effect |
|---|---|---|
| `reportDisruption(driverId, jobId, reason, collected)` | tool | collected → escalate; else Job `late`, queue High Placement |
| `confirmOnTrack(driverId, jobId)` | tool | `at_risk` → `assigned`, note "Driver confirmed" |
| `reportStatus(driverId, {capacity?, availableFrom?, availableUntil?})` | tool | update Driver, bump version |
| `acceptOffer(offerId)` | tool | recheck eligibility + versions; commit in one transaction → `placed`; release call to previous Driver |
| `declineOffer(offerId, reason?, statusUpdate?)` | tool | apply status update, mark declined, next Offer |
| `markUnanswered(offerId)` | call-ended event | if still pending → unanswered, next Offer |
| `injectTraffic(trafficEventId)` | dashboard | recompute ETAs; deadline-missing Jobs → `at_risk` + one check call each |
| `addUrgentJob(input, tier)` | dashboard | create Job `unassigned`, queue Placement |
| `reset()` | dashboard | reload fixtures relative to now |

## HTTP

| Route | Body | Notes |
|---|---|---|
| `POST /tools/:name` | Retell custom-function payload `{ name, call, args }` | Responds `{ result: string }` the agent can speak; < 1 s |
| `POST /webhooks/retell` | Retell call events | `call_ended` → `markUnanswered`; `transcript_updated` → `transcript` SSE |
| `POST /api/reset` | — | |
| `POST /api/traffic/:id` | — | `injectTraffic`; returns the snapshot; unknown id → 404 |
| `POST /api/jobs` | `{ label, pickup, dropoff, parcels, deadlineOffsetMin, tier }` | `pickup`/`dropoff` are `{ name, lat?, lng? }` (default: central SF). 201 `{ ok, message, jobId, state }`; 400 `{ error, message }`. Urgent Job ETAs: straight line at 20 km/h, rounded up, stored in the ETA table |
| `GET /events` | — | SSE |

Tool names: `get_my_jobs`, `report_disruption`, `confirm_on_track`, `report_status`, `accept_offer`, `decline_offer`. Inbound callers are identified by `call.from_number`; outbound calls carry `driver_id` in vars.

Status fields, shared by `report_status` and `decline_offer`: `capacity?` (int ≥ 0), `available_from?`, `available_until?` (ISO, or spoken "4 PM" / "16:30" / bare "4" = next 4 o'clock, demo time zone). `decline_offer` also takes `offer_id?` (else vars) and `reason?`. Escalation calls carry `reason` (one sentence) plus the Job vars.

## SSE

- `state`: the full snapshot, sent on connect and after every engine command. The dashboard re-renders from it; no client-side state merging.
  `{ now, drivers: Driver[], jobs: Job[], placements: (Placement & { offers: Offer[]; evaluation: Evaluation | null })[], queue: PlacementId[], activeTraffic: TrafficEvent[], log: { at, text }[] }`
- `transcript`: `{ callId, kind: CallKind | 'inbound', driverId, role: 'agent' | 'user', text, at }`.
- `heartbeat`: unchanged.

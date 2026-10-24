// @ts-nocheck
// PROTOTYPE (throwaway): stub StateSnapshots + call transcripts for each demo scene.
// Shapes follow src/domain/types.ts StateSnapshot; data follows fixtures/demo.json.

export const SCENES = ['live', 'at-risk', 'placing', 'placed'];

const min = (n) => n * 60_000;
const sec = (n) => n * 1000;

function iso(base, offsetMs) {
  return new Date(base + offsetMs).toISOString();
}

function baseSnapshot(now) {
  const resetAt = now - min(2);
  const drv = (id, name, lat, lng, capacity, from, until, phone, simulated = false) => ({
    id,
    name,
    phone,
    simulated,
    position: { lat, lng },
    capacity,
    availableFrom: iso(resetAt, min(from)),
    availableUntil: iso(resetAt, min(until)),
    version: 1,
  });
  const job = (id, label, pickup, dropoff, parcels, deadlineMin, driverId) => ({
    id,
    label,
    pickup,
    dropoff,
    parcels,
    deadline: iso(resetAt, min(deadlineMin)),
    serviceMinutes: 3,
    tripMinutes: 12,
    driverId,
    collected: false,
    status: 'assigned',
    note: null,
    version: 1,
  });
  return {
    now: new Date(now).toISOString(),
    resetAt: new Date(resetAt).toISOString(),
    drivers: [
      drv('alex', 'Alex', 37.7599, -122.4148, 2, -180, 300, '+1 555 0101'),
      drv('blair', 'Blair', 37.7726, -122.4312, 2, -180, 300, null, true),
      drv('casey', 'Casey', 37.7793, -122.4192, 3, -180, 300, '+1 555 0103'),
      drv('dana', 'Dana', 37.7648, -122.4632, 4, -240, 20, null),
      drv('eli', 'Eli', 37.7935, -122.3965, 0, -180, 300, null),
      drv('fran', 'Fran', 37.7281, -122.4769, 3, -180, 300, null),
    ],
    jobs: [
      job(
        'J17',
        'Oak Street pickup',
        { name: 'Oak Street Florist', lat: 37.7745, lng: -122.4264 },
        { name: 'Mission Bay Clinic', lat: 37.7684, lng: -122.3912 },
        2,
        60,
        'alex',
      ),
      job(
        'J18',
        'Valencia Street pickup',
        { name: 'Valencia Books', lat: 37.7635, lng: -122.4216 },
        { name: 'Potrero Hill Office', lat: 37.7587, lng: -122.4009 },
        1,
        90,
        'casey',
      ),
      job(
        'J19',
        'Embarcadero pickup',
        { name: 'Ferry Building Market', lat: 37.7955, lng: -122.3937 },
        { name: 'North Beach Cafe', lat: 37.8003, lng: -122.4101 },
        3,
        75,
        'eli',
      ),
    ],
    placements: [],
    queue: [],
    activeTraffic: [],
    trafficEvents: [{ id: 'i280', label: 'I-280 closed' }],
    log: [{ at: new Date(resetAt).toISOString(), text: 'Demo reset' }],
  };
}

const I280 = {
  id: 'i280',
  label: 'I-280 closed',
  path: [
    [37.7334, -122.4062],
    [37.7489, -122.4031],
    [37.7612, -122.4058],
    [37.7699, -122.4011],
  ],
  addedMinutes: { alex: 40 },
};

function evaluation(at) {
  return {
    jobId: 'J17',
    at,
    eligible: [
      { driverId: 'blair', etaToPickupMinutes: 5 },
      { driverId: 'casey', etaToPickupMinutes: 9 },
    ],
    ineligible: [
      { driverId: 'alex', reason: { kind: 'current_driver', text: 'Current Driver; reported a Disruption' } },
      { driverId: 'dana', reason: { kind: 'unavailable', text: 'Off shift in 18 min, before the deadline' } },
      { driverId: 'eli', reason: { kind: 'capacity', text: 'No free slots (needs 2, has 0)' } },
      { driverId: 'fran', reason: { kind: 'too_far', text: '48 min to Pickup (fixture ETA); misses deadline' } },
    ],
  };
}

const T = (who, text, t) => ({ who, text, t });

const CALL_ALEX_CHECK = {
  driverId: 'alex',
  purpose: 'At Risk check · J17',
  status: 'ended',
  outcome: 'Disruption reported',
  lines: [
    T('Reroute', "Hi Alex, it's Reroute. I-280 is closed and J17 at Oak Street looks at risk. Can you still make its deadline?", 0),
    T('Alex', "No way, I'm stuck behind the closure. I can't do it.", 7),
    T('Reroute', "Understood. I'll find someone else. Keep J17 for now; I'll call you back once it's placed.", 11),
  ],
};

const CALL_BLAIR = {
  driverId: 'blair',
  purpose: 'Offer · J17',
  status: 'ended',
  simulated: true,
  outcome: 'Declined: "only room for one"',
  lines: [T('Blair', 'Sorry, only room for one.', 1)],
};

const CALL_CASEY_MID = {
  driverId: 'casey',
  purpose: 'Offer · J17',
  status: 'live',
  lines: [
    T('Reroute', "Hi Casey, it's Reroute. Can you take J17: two parcels from Oak Street Florist to Mission Bay Clinic within the hour?", 0),
    T('Casey', "Oak Street... that's close. How far is Mission Bay from there?", 6),
    T('Reroute', 'About fifteen minutes. You have room for both parcels.', 9),
  ],
};

const CALL_CASEY_DONE = {
  ...CALL_CASEY_MID,
  status: 'ended',
  outcome: 'Accepted',
  lines: [...CALL_CASEY_MID.lines, T('Casey', "Yeah, I'll take it.", 13), T('Reroute', "Great, J17 is yours. Pickup at Oak Street Florist.", 15)],
};

const CALL_ALEX_RELEASE = {
  driverId: 'alex',
  purpose: 'Release · J17',
  status: 'live',
  lines: [
    T('Reroute', "Alex, it's Reroute again. Casey has taken J17, so you're released from it.", 0),
    T('Alex', 'Perfect, thanks.', 4),
  ],
};

/** Returns { snapshot, calls, disruptionAt, placedAt } for a stub scene. */
export function stubScene(name) {
  const now = Date.now();
  const s = baseSnapshot(now);
  const j17 = s.jobs[0];
  if (name === 'at-risk') {
    s.activeTraffic = [I280];
    j17.status = 'at_risk';
    j17.note = 'I-280 closed: Alex +40 min (simulated traffic)';
    s.log.push({ at: iso(now, -sec(20)), text: 'Traffic: I-280 closed (simulated traffic)' });
    s.log.push({ at: iso(now, -sec(18)), text: 'J17 At Risk; calling Alex' });
    return {
      snapshot: s,
      calls: [{ ...CALL_ALEX_CHECK, status: 'live', outcome: null, lines: CALL_ALEX_CHECK.lines.slice(0, 2) }],
      disruptionAt: null,
      placedAt: null,
    };
  }
  const queuedAt = iso(now, name === 'placed' ? -sec(130) : -sec(71));
  const placement = {
    id: 'P1',
    jobId: 'J17',
    trigger: 'disruption',
    tier: 'high',
    queuedAt,
    status: 'running',
    previousDriverId: 'alex',
    startedAt: queuedAt,
    endedAt: null,
    offers: [
      {
        id: 'O1',
        placementId: 'P1',
        driverId: 'blair',
        status: 'declined',
        declineReason: 'only room for one',
        simulated: true,
        createdAt: iso(Date.parse(queuedAt), sec(4)),
        resolvedAt: iso(Date.parse(queuedAt), sec(6)),
        callId: null,
      },
      {
        id: 'O2',
        placementId: 'P1',
        driverId: 'casey',
        status: 'pending',
        declineReason: null,
        simulated: false,
        createdAt: iso(Date.parse(queuedAt), sec(8)),
        resolvedAt: null,
        callId: 'call_casey',
      },
    ],
    evaluation: evaluation(queuedAt),
  };
  s.activeTraffic = [I280];
  s.placements = [placement];
  s.log.push({ at: iso(Date.parse(queuedAt), -sec(30)), text: 'Traffic: I-280 closed (simulated traffic)' });
  s.log.push({ at: queuedAt, text: 'Alex reported a Disruption on J17; Placement started (High)' });
  s.log.push({ at: iso(Date.parse(queuedAt), sec(6)), text: 'Blair declined (simulated Offer): only room for one' });
  s.log.push({ at: iso(Date.parse(queuedAt), sec(8)), text: 'Offer J17 to Casey: calling' });

  if (name === 'placed') {
    const placedAt = iso(Date.parse(queuedAt), sec(108));
    placement.status = 'placed';
    placement.endedAt = placedAt;
    placement.offers[1].status = 'accepted';
    placement.offers[1].resolvedAt = placedAt;
    j17.status = 'assigned';
    j17.driverId = 'casey';
    j17.note = 'Placed with Casey (was Alex)';
    s.drivers[2].capacity = 1;
    s.log.push({ at: placedAt, text: 'Casey accepted; J17 Placed with Casey' });
    s.log.push({ at: iso(Date.parse(placedAt), sec(5)), text: 'Release call to Alex' });
    return {
      snapshot: s,
      calls: [CALL_ALEX_CHECK, CALL_BLAIR, CALL_CASEY_DONE, CALL_ALEX_RELEASE],
      disruptionAt: queuedAt,
      placedAt,
    };
  }
  // placing (default)
  j17.status = 'late';
  j17.note = 'Alex reported a Disruption; Alex keeps J17 until Placed';
  // An Urgent Job waiting in the Placement Queue, to show the queue.
  s.jobs.push({
    ...s.jobs[1],
    id: 'J20',
    label: 'Urgent: Castro pharmacy',
    pickup: { name: 'Castro Pharmacy', lat: 37.7609, lng: -122.435 },
    dropoff: { name: 'Noe Valley Home', lat: 37.7502, lng: -122.4337 },
    driverId: null,
    status: 'unassigned',
    deadline: iso(now, min(50)),
  });
  s.placements.push({
    id: 'P2',
    jobId: 'J20',
    trigger: 'urgent_job',
    tier: 'normal',
    queuedAt: iso(now, -sec(10)),
    status: 'queued',
    previousDriverId: null,
    startedAt: null,
    endedAt: null,
    offers: [],
    evaluation: null,
  });
  s.queue = ['P2'];
  return {
    snapshot: s,
    calls: [CALL_ALEX_CHECK, CALL_BLAIR, CALL_CASEY_MID],
    disruptionAt: queuedAt,
    placedAt: null,
  };
}

/** Wraps a real snapshot from SSE into the same scene shape. Calls come from the log only. */
export function liveScene(snapshot) {
  const running = snapshot.placements.find((p) => p.status === 'running') ?? snapshot.placements.at(-1);
  return {
    snapshot,
    calls: [],
    disruptionAt: running?.queuedAt ?? null,
    placedAt: running?.status === 'placed' ? running.endedAt : null,
  };
}

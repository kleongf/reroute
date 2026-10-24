// @ts-check
// Mission control dashboard: the map is the stage; cards float over it. Renders every `state`
// snapshot from scratch (no client-side merging) and appends `transcript` SSE events.
import { initMap } from './map.js';

/** @typedef {import('../src/domain/types.ts').StateSnapshot} StateSnapshot */
/** @typedef {import('../src/domain/types.ts').DisruptionSummary} DisruptionSummary */
/** @typedef {StateSnapshot['placements'][number]} PlacementView */
/** @typedef {import('../src/domain/types.ts').Offer} Offer */
/** @typedef {import('../src/domain/types.ts').Job} Job */
/**
 * @typedef {{ callId: string, kind: string, driverId: string | null, role: 'agent' | 'user',
 *   text: string, at: string, utteranceId?: string }} TranscriptLine
 */

const DEMO_TIME_ZONE = 'America/Los_Angeles';
/** How long the "fixed" celebration stays on screen after a Placement is Placed. */
const CELEBRATE_MS = 6000;

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

/**
 * Tiny element builder. `attrs` keys starting with `data-` become data attributes.
 * @param {string} tag
 * @param {Record<string, string | undefined>} [attrs]
 * @param {(Node | string | null | undefined | false)[]} kids
 * @returns {HTMLElement}
 */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value);
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

/** @param {string} iso */
const clockTime = (iso) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DEMO_TIME_ZONE,
  });

/** @param {number} seconds */
const mmss = (seconds) => {
  const s = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(s / 60))}:${String(s % 60).padStart(2, '0')}`;
};

/** @param {number} n */
const minutes = (n) => `${String(n)} min`;

const STATUS_LABEL = /** @type {Record<string, string>} */ ({
  assigned: 'Assigned',
  at_risk: 'At Risk',
  late: 'Late',
  unassigned: 'Unassigned',
  escalated: 'Escalated',
  done: 'Done',
});

// ---- Live feed ----

const statusEl = requireElement('sse-status');
const heartbeatsEl = requireElement('sse-heartbeats');
let heartbeats = 0;

/** @param {'connecting' | 'connected' | 'reconnecting'} state */
function setStatus(state) {
  statusEl.textContent = state;
  statusEl.dataset['state'] = state;
}

const source = new EventSource('/events');
source.addEventListener('open', () => {
  setStatus('connected');
});
source.addEventListener('heartbeat', () => {
  heartbeats += 1;
  heartbeatsEl.textContent = String(heartbeats);
});
source.addEventListener('error', () => {
  setStatus('reconnecting');
});
window.addEventListener('beforeunload', () => {
  source.close();
});

// ---- Client state: only what the snapshot cannot carry ----

/** @type {StateSnapshot | null} */
let latest = null;
/** Client clock minus server clock, so live timers tick on the server's time. */
let skewMs = 0;
/** @type {Map<string, TranscriptLine[]>} callId → lines, in arrival order. */
const transcripts = new Map();
/** Placement IDs already seen as Placed; null until the first snapshot after load/reset. */
let seenPlaced = /** @type {Set<string> | null} */ (null);
let seenResetAt = '';
/** @type {Map<string, number>} placementId → client time the celebration ends. */
const celebrating = new Map();

const serverNow = () => Date.now() - skewMs;

/** @param {StateSnapshot} s */
function trackCelebrations(s) {
  if (s.resetAt !== seenResetAt) {
    seenResetAt = s.resetAt;
    seenPlaced = null;
    celebrating.clear();
    transcripts.clear();
  }
  const placed = s.disruptions.filter((d) => d.status === 'placed').map((d) => d.placementId);
  if (seenPlaced === null) {
    seenPlaced = new Set(placed);
    return;
  }
  for (const id of placed) {
    if (seenPlaced.has(id)) continue;
    seenPlaced.add(id);
    celebrating.set(id, Date.now() + CELEBRATE_MS);
    setTimeout(() => {
      if (latest) render(latest);
    }, CELEBRATE_MS + 50);
  }
}

/** @param {string} placementId */
const isCelebrating = (placementId) => (celebrating.get(placementId) ?? 0) > Date.now();

// ---- View model ----

/** @param {StateSnapshot} s */
function model(s) {
  /** @param {string | null | undefined} id */
  const driverName = (id) => s.drivers.find((d) => d.id === id)?.name ?? '—';
  /** @param {string} id */
  const job = (id) => s.jobs.find((j) => j.id === id);
  const running = s.placements.find((p) => p.status === 'running') ?? null;
  const started = s.placements.filter((p) => p.status !== 'queued');
  const placement = running ?? started.at(-1) ?? null;
  const pending = running?.offers.find((o) => o.status === 'pending') ?? null;
  const open = s.disruptions.filter((d) => d.status === 'running' || d.status === 'queued');
  const ended = s.disruptions
    .filter((d) => d.endedAt !== null)
    .sort((a, b) => Date.parse(b.endedAt ?? '') - Date.parse(a.endedAt ?? ''));
  const atRisk = s.jobs.filter((j) => j.status === 'at_risk');
  const placementJobIds = new Set(s.disruptions.map((d) => d.jobId));
  /** Escalated straight away (Pickup already done): no Placement to show. */
  const handoffs = s.jobs.filter((j) => j.status === 'escalated' && !placementJobIds.has(j.id));
  /** @param {string} jobId */
  const forecast = (jobId) => s.forecasts.find((f) => f.jobId === jobId) ?? null;
  return {
    s,
    driverName,
    job,
    running,
    placement,
    pending,
    open,
    ended,
    atRisk,
    handoffs,
    forecast,
  };
}

/** @typedef {ReturnType<typeof model>} Model */

/**
 * "Late by 9 min with Alex" / "On time with Casey, 31 min to spare".
 * @param {number | null} minutesLate
 * @param {string} name
 */
function deliveryText(minutesLate, name) {
  if (minutesLate === null) return `with ${name} (no fixture ETA)`;
  if (minutesLate > 0) return `Late by ${minutes(minutesLate)} with ${name}`;
  return `On time with ${name}, ${minutes(-minutesLate)} to spare`;
}

// ---- Top bar: banner, timer, tally ----

const bannerEl = requireElement('banner');
const timerEl = requireElement('fix-timer');
const tallyEl = requireElement('tally');

/** @param {Model} m @returns {{ tone: string, text: string, celebrate: boolean }} */
function banner(m) {
  const first = m.open[0];
  if (first) {
    const offer = m.running?.jobId === first.jobId ? m.pending : null;
    const doing = offer ? `offering to ${m.driverName(offer.driverId)}` : 'finding a Driver';
    return { tone: 'late', text: `${first.jobId} Late · ${doing}`, celebrate: false };
  }
  const risk = m.atRisk[0];
  if (risk) {
    return {
      tone: 'risk',
      text: `${risk.id} At Risk · checking with ${m.driverName(risk.driverId)}`,
      celebrate: false,
    };
  }
  const last = m.ended[0];
  if (last?.status === 'placed' && last.after) {
    const name = m.driverName(last.after.driverId);
    const late = last.after.minutesLate;
    const how = late !== null && late > 0 ? `late by ${minutes(late)}` : 'on time';
    return {
      tone: 'fixed',
      text: `${last.jobId} fixed · ${name} has it, ${how}`,
      celebrate: isCelebrating(last.placementId),
    };
  }
  if (last?.status === 'escalated') {
    return {
      tone: 'esc',
      text: `${last.jobId} not fixed · Escalated to Dispatcher`,
      celebrate: false,
    };
  }
  const handoff = m.handoffs[0];
  if (handoff) {
    return {
      tone: 'esc',
      text: `${handoff.id} not fixed · needs a physical handoff`,
      celebrate: false,
    };
  }
  return { tone: 'ok', text: 'All Jobs on track', celebrate: false };
}

/** The Disruption the timer measures: the open one, else the most recent. */
function timerDisruption(/** @type {Model} */ m) {
  return m.open[0] ?? m.s.disruptions.at(-1) ?? null;
}

function tickTimer() {
  if (!latest) return;
  const d = timerDisruption(model(latest));
  if (!d) {
    timerEl.textContent = '–:––';
    timerEl.dataset['state'] = 'idle';
    return;
  }
  const end = d.endedAt ? Date.parse(d.endedAt) : serverNow();
  timerEl.textContent = mmss((end - Date.parse(d.reportedAt)) / 1000);
  timerEl.dataset['state'] = d.status;
}
setInterval(tickTimer, 1000);

/** @param {Model} m */
function renderTopBar(m) {
  const b = banner(m);
  bannerEl.textContent = b.text;
  bannerEl.dataset['tone'] = b.tone;
  bannerEl.classList.toggle('celebrate', b.celebrate);
  tickTimer();

  const t = m.s.disruptionTally;
  const avg = t.averageSecondsToFix === null ? '–' : mmss(t.averageSecondsToFix);
  tallyEl.replaceChildren(
    'Disruptions fixed: ',
    h('b', { 'data-testid': 'tally-fixed' }, String(t.fixed)),
    ' · avg time to fix ',
    h('b', { 'data-testid': 'tally-avg' }, avg),
    t.escalated > 0 ? h('span', { class: 'tally-esc' }, ` · ${String(t.escalated)} Escalated`) : '',
  );
}

// ---- Disruption cards ----

const disruptionsEl = requireElement('disruption-cards');

/**
 * @param {Model} m
 * @param {DisruptionSummary} d
 */
function disruptionCard(m, d) {
  const job = m.job(d.jobId);
  const who = m.driverName(d.driverId);
  const before =
    d.before.minutesLate !== null && d.before.minutesLate > 0
      ? deliveryText(d.before.minutesLate, who)
      : `${who} can't complete it`;
  /** @type {HTMLElement} */
  let after;
  let time;
  let tag;
  if (d.status === 'placed' && d.after) {
    tag = 'Fixed';
    after = h(
      'div',
      { class: 'after ok', 'data-testid': 'disruption-after' },
      deliveryText(d.after.minutesLate, m.driverName(d.after.driverId)),
    );
    time = `Fixed in ${mmss(d.secondsToFix ?? 0)}`;
  } else if (d.status === 'escalated') {
    tag = 'Not fixed';
    after = h(
      'div',
      { class: 'after bad', 'data-testid': 'disruption-after' },
      'No Driver accepted · Escalated to Dispatcher',
    );
    time = `Escalated after ${mmss((Date.parse(d.endedAt ?? d.reportedAt) - Date.parse(d.reportedAt)) / 1000)}`;
  } else {
    tag = 'Late';
    const offer = m.running?.id === d.placementId ? m.pending : null;
    after = h(
      'div',
      { class: 'after working', 'data-testid': 'disruption-after' },
      offer ? `Offering to ${m.driverName(offer.driverId)}…` : 'Finding a Driver…',
    );
    time = `${mmss((serverNow() - Date.parse(d.reportedAt)) / 1000)} so far`;
  }
  return h(
    'article',
    {
      class: `dcard s-${d.status}${isCelebrating(d.placementId) ? ' celebrate' : ''}`,
      'data-testid': 'disruption-card',
      'data-status': d.status,
      'data-job-id': d.jobId,
    },
    h(
      'div',
      { class: 'dcard-head' },
      h('span', { class: 'tag' }, tag),
      h('b', {}, `${d.jobId} ${job?.label ?? ''}`),
    ),
    h(
      'div',
      { class: 'why', 'data-testid': 'disruption-reason' },
      `${who}: ${d.reason ? `“${d.reason}”` : 'reported a Disruption'}`,
    ),
    h(
      'div',
      { class: 'fix' },
      h('div', { class: 'before', 'data-testid': 'disruption-before' }, before),
      h('span', { class: 'arrow' }, '→'),
      after,
    ),
    h('div', { class: 'time', 'data-testid': 'disruption-time' }, time),
  );
}

/**
 * At Risk is not yet a Disruption: only the Driver's answer turns it into one.
 * @param {Model} m
 * @param {Job} job
 */
function atRiskCard(m, job) {
  const f = m.forecast(job.id);
  const who = m.driverName(job.driverId);
  return h(
    'article',
    {
      class: 'dcard s-at_risk',
      'data-testid': 'disruption-card',
      'data-status': 'at_risk',
      'data-job-id': job.id,
    },
    h(
      'div',
      { class: 'dcard-head' },
      h('span', { class: 'tag' }, 'At Risk'),
      h('b', {}, `${job.id} ${job.label}`),
    ),
    h('div', { class: 'why', 'data-testid': 'disruption-reason' }, job.note ?? 'traffic check'),
    h(
      'div',
      { class: 'fix' },
      h(
        'div',
        { class: 'before', 'data-testid': 'disruption-before' },
        f ? deliveryText(f.minutesLate, who) : `with ${who}`,
      ),
      h('span', { class: 'arrow' }, '→'),
      h(
        'div',
        { class: 'after working', 'data-testid': 'disruption-after' },
        `Checking with ${who}…`,
      ),
    ),
    h('div', { class: 'time' }, 'estimate · simulated traffic'),
  );
}

/**
 * @param {Model} m
 * @param {Job} job
 */
function handoffCard(m, job) {
  return h(
    'article',
    {
      class: 'dcard s-escalated',
      'data-testid': 'disruption-card',
      'data-status': 'escalated',
      'data-job-id': job.id,
    },
    h(
      'div',
      { class: 'dcard-head' },
      h('span', { class: 'tag' }, 'Not fixed'),
      h('b', {}, `${job.id} ${job.label}`),
    ),
    h('div', { class: 'why' }, `${m.driverName(job.driverId)}: “${job.note ?? 'Disruption'}”`),
    h(
      'div',
      { class: 'after bad', 'data-testid': 'disruption-after' },
      'Parcels collected · needs a physical handoff',
    ),
  );
}

/** @param {Model} m */
function renderDisruptions(m) {
  const cards = [
    ...m.atRisk.map((j) => atRiskCard(m, j)),
    ...[...m.s.disruptions].reverse().map((d) => disruptionCard(m, d)),
    ...m.handoffs.map((j) => handoffCard(m, j)),
  ];
  if (cards.length === 0) {
    cards.push(h('p', { class: 'muted' }, 'No Disruptions. Every Job is on track.'));
  }
  disruptionsEl.replaceChildren(...cards);
}

// ---- Live call card ----

const callEl = requireElement('call');

/** @param {Model} m */
function currentCall(m) {
  if (m.pending && m.running) {
    const j = m.job(m.running.jobId);
    return {
      live: true,
      title: `Offer to ${m.driverName(m.pending.driverId)}`,
      sub: `${m.running.jobId} ${j?.label ?? ''}`,
      driverId: m.pending.driverId,
      callId: m.pending.callId,
      simulated: m.pending.simulated,
    };
  }
  const risk = m.atRisk[0];
  if (risk) {
    return {
      live: true,
      title: `Check call with ${m.driverName(risk.driverId)}`,
      sub: `${risk.id} At Risk`,
      driverId: risk.driverId,
      callId: null,
      simulated: false,
    };
  }
  const lastId = [...transcripts.keys()].at(-1);
  const lastLine = lastId ? transcripts.get(lastId)?.[0] : undefined;
  if (lastId && lastLine) {
    return {
      live: false,
      title: `Last call: ${m.driverName(lastLine.driverId)}`,
      sub: lastLine.kind.replace('_', ' '),
      driverId: lastLine.driverId,
      callId: lastId,
      simulated: false,
    };
  }
  return null;
}

/**
 * Lines for the call: by Retell call ID when known, else the Driver's latest call.
 * @param {string | null} callId
 * @param {string | null} driverId
 */
function linesFor(callId, driverId) {
  if (callId && transcripts.has(callId)) return transcripts.get(callId) ?? [];
  const ids = [...transcripts.keys()].reverse();
  const id = ids.find((k) => transcripts.get(k)?.[0]?.driverId === driverId);
  return id ? (transcripts.get(id) ?? []) : [];
}

/** @param {Model} m */
function renderCall(m) {
  const c = currentCall(m);
  if (!c) {
    callEl.replaceChildren(h('p', { class: 'muted' }, 'No call in progress'));
    return;
  }
  const lines = c.simulated ? [] : linesFor(c.callId, c.driverId);
  callEl.replaceChildren(
    h(
      'div',
      { class: 'call-head' },
      h('span', { class: `dot${c.live ? ' live' : ''}` }),
      h('b', { 'data-testid': 'call-title' }, c.title),
      h('span', { class: 'muted' }, c.sub),
      c.simulated ? h('span', { class: 'chip warn' }, 'simulated Offer') : null,
    ),
    h(
      'div',
      { class: 'lines', 'data-testid': 'transcript' },
      ...(c.simulated
        ? [h('p', { class: 'muted' }, 'No phone call: the simulated Driver replies by script.')]
        : lines.length === 0
          ? [h('p', { class: 'muted' }, c.live ? 'Calling…' : 'No transcript')]
          : lines.map((l) =>
              h(
                'p',
                {},
                h(
                  'b',
                  { class: l.role === 'agent' ? 'who-agent' : 'who-driver' },
                  l.role === 'agent' ? 'Reroute: ' : `${m.driverName(l.driverId)}: `,
                ),
                l.text,
              ),
            )),
    ),
  );
  const box = callEl.querySelector('.lines');
  if (box) box.scrollTop = box.scrollHeight;
}

source.addEventListener('transcript', (event) => {
  /** @type {unknown} */
  const raw = JSON.parse(/** @type {MessageEvent<string>} */ (event).data);
  const line = /** @type {TranscriptLine} */ (raw);
  const list = transcripts.get(line.callId) ?? [];
  // Retell revises a line as speech continues: upsert by utteranceId, else append.
  const at = line.utteranceId ? list.findIndex((l) => l.utteranceId === line.utteranceId) : -1;
  if (at >= 0) list[at] = line;
  else list.push(line);
  transcripts.set(line.callId, list);
  if (latest) renderCall(model(latest));
});

// ---- Placement card ----

const placementEl = requireElement('placement');
const queueEl = requireElement('placement-queue');

/** @param {Offer | undefined} o */
function offerBadge(o) {
  if (!o) return null;
  const sim = o.simulated ? ' · simulated Offer' : '';
  if (o.status === 'pending') return h('span', { class: 'badge live' }, `Offer: calling…${sim}`);
  if (o.status === 'accepted') return h('span', { class: 'badge ok' }, 'Accepted');
  if (o.status === 'declined') {
    const why = o.declineReason ? `: “${o.declineReason}”` : '';
    return h('span', { class: 'badge bad' }, `Declined${why}${sim}`);
  }
  return h('span', { class: 'badge bad' }, `Unanswered${sim}`);
}

/**
 * "routed ETA" or "fixture ETA" (fixture table, or straight line for Urgent Jobs).
 * @param {StateSnapshot} s
 * @param {string} driverId
 * @param {string} jobId
 */
const etaLabel = (s, driverId, jobId) =>
  s.etas.source[driverId]?.[jobId] === 'routed' ? 'routed ETA' : 'fixture ETA';

/** @param {Model} m */
function renderPlacement(m) {
  const p = m.placement;
  if (!p) {
    placementEl.replaceChildren(
      h(
        'p',
        { class: 'muted' },
        m.atRisk.length > 0 ? 'Only a Disruption starts a Placement.' : 'No Placement yet.',
      ),
    );
  } else {
    const job = m.job(p.jobId);
    /** @param {string} driverId */
    const offerFor = (driverId) => p.offers.findLast((o) => o.driverId === driverId);
    const eligible = h('ol', { class: 'rungs', 'data-testid': 'eligible-list' });
    (p.evaluation?.eligible ?? []).forEach((e, i) => {
      const o = offerFor(e.driverId);
      eligible.append(
        h(
          'li',
          { class: `rung elig ${o?.status ?? ''}` },
          h('span', { class: 'rank' }, String(i + 1)),
          h('span', { class: 'name' }, m.driverName(e.driverId)),
          h(
            'span',
            { class: 'eta' },
            `${minutes(e.etaToPickupMinutes)} to Pickup · ${etaLabel(m.s, e.driverId, p.jobId)}`,
          ),
          offerBadge(o),
        ),
      );
    });
    if (eligible.children.length === 0)
      eligible.append(h('li', { class: 'muted' }, 'No Eligible Driver'));
    const ineligible = h('ul', { class: 'rungs', 'data-testid': 'ineligible-list' });
    for (const i of p.evaluation?.ineligible ?? []) {
      const o = offerFor(i.driverId);
      ineligible.append(
        h(
          'li',
          { class: `rung inelig${o ? ' offered' : ''}` },
          h('span', { class: 'rank' }, '✕'),
          h('span', { class: 'name' }, m.driverName(i.driverId)),
          o ? offerBadge(o) : h('span', { class: 'reason' }, i.reason.text),
        ),
      );
    }
    placementEl.replaceChildren(
      h(
        'div',
        { class: 'placement-head' },
        h('b', {}, `${p.jobId} ${job?.label ?? ''}`),
        h('span', { class: 'muted' }, p.tier === 'high' ? 'High' : 'Normal'),
        h(
          'span',
          {
            class: `pill s-${p.status}`,
            'data-testid': 'placement-status',
            'data-status': p.status,
          },
          p.status === 'placed'
            ? 'Placed'
            : p.status === 'escalated'
              ? 'Escalated'
              : p.status === 'running'
                ? 'Running'
                : 'Queued',
        ),
      ),
      eligible,
      ineligible,
    );
  }

  const items = m.s.queue.map((id, i) => {
    const queued = m.s.placements.find((x) => x.id === id);
    const job = queued ? m.job(queued.jobId) : undefined;
    const name = job ? `${job.id} ${job.label}` : id;
    const tier = queued?.tier === 'high' ? 'High' : 'Normal';
    const due = job ? clockTime(job.deadline) : '—';
    return h('li', { 'data-placement-id': id }, `${String(i + 1)}. ${name} · ${tier} · due ${due}`);
  });
  if (items.length === 0) items.push(h('li', { class: 'muted' }, 'Queue empty'));
  queueEl.replaceChildren(...items);
}

const placementToggle = requireElement('placement-toggle');
placementToggle.addEventListener('click', () => {
  const card = placementToggle.closest('.placement');
  const collapsed = card?.classList.toggle('collapsed') ?? false;
  placementToggle.setAttribute('aria-expanded', String(!collapsed));
});

// ---- Jobs / Drivers drawer ----

/**
 * @param {string} testId
 * @param {HTMLElement[]} rows
 */
function fillTable(testId, rows) {
  document.querySelector(`[data-testid="${testId}"] tbody`)?.replaceChildren(...rows);
}

/** @param {Model} m */
function renderTables(m) {
  fillTable(
    'jobs-table',
    m.s.jobs.map((j) =>
      h(
        'tr',
        { class: `status-${j.status}` },
        h('td', {}, `${j.id} ${j.label}`),
        h(
          'td',
          {},
          h('span', { class: `pill s-${j.status}` }, STATUS_LABEL[j.status] ?? j.status),
          j.note ? ` ${j.note}` : '',
        ),
        h('td', {}, m.driverName(j.driverId)),
        h('td', {}, String(j.parcels)),
        h('td', {}, clockTime(j.deadline)),
      ),
    ),
  );
  fillTable(
    'drivers-table',
    m.s.drivers.map((d) =>
      h(
        'tr',
        {},
        h('td', {}, d.name),
        h('td', {}, d.simulated ? 'simulated' : d.phone ? 'real phone' : 'none'),
        h('td', {}, String(d.capacity)),
        h('td', {}, `${clockTime(d.availableFrom)}–${clockTime(d.availableUntil)}`),
      ),
    ),
  );
}

const drawer = requireElement('drawer');
const drawerToggle = requireElement('drawer-toggle');
drawerToggle.addEventListener('click', () => {
  const open = drawer.classList.toggle('open');
  drawerToggle.setAttribute('aria-expanded', String(open));
});

// ---- Dispatcher actions ----

requireElement('reset').addEventListener('click', () => {
  void fetch('/api/reset', { method: 'POST' });
});

const trafficButtonsEl = requireElement('traffic-buttons');

/** @param {StateSnapshot} s */
function renderTrafficButtons(s) {
  trafficButtonsEl.replaceChildren(
    // Active traffic is drawn on the map, so its button steps aside for the banner.
    ...s.trafficEvents.map((t) => {
      const active = s.activeTraffic.some((a) => a.id === t.id);
      const button = h(
        'button',
        { type: 'button', 'data-testid': `inject-traffic-${t.id}`, title: 'simulated traffic' },
        `Inject traffic: ${t.label}`,
      );
      if (button instanceof HTMLButtonElement) {
        button.disabled = active;
        button.hidden = active;
      }
      button.addEventListener('click', () => {
        void fetch(`/api/traffic/${encodeURIComponent(t.id)}`, { method: 'POST' });
      });
      return button;
    }),
  );
}

const urgentForm = /** @type {HTMLFormElement} */ (requireElement('urgent-form'));
const urgentToggle = requireElement('urgent-toggle');
const urgentError = requireElement('urgent-error');

urgentToggle.addEventListener('click', () => {
  urgentForm.hidden = !urgentForm.hidden;
  urgentToggle.setAttribute('aria-expanded', String(!urgentForm.hidden));
});

urgentForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = new FormData(urgentForm);
  const field = (/** @type {string} */ name) => {
    const value = data.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };
  const body = {
    label: field('label'),
    pickup: { name: field('pickup') },
    dropoff: { name: field('dropoff') },
    parcels: Number(field('parcels')),
    deadlineOffsetMin: Number(field('deadlineOffsetMin')),
    tier: field('tier'),
  };
  urgentError.textContent = '';
  void fetch('/api/jobs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (res) => {
    if (res.ok) {
      urgentForm.reset();
      urgentForm.hidden = true;
      urgentToggle.setAttribute('aria-expanded', 'false');
      return;
    }
    /** @type {unknown} */
    const raw = await res.json().catch(() => ({}));
    const payload = /** @type {{ message?: string }} */ (raw);
    urgentError.textContent = payload.message ?? `Could not add Urgent Job (${String(res.status)})`;
  });
});

// ---- Provenance + render loop ----

const provenanceEl = requireElement('provenance');

/** @param {StateSnapshot} s */
function renderProvenance(s) {
  const sources = new Set(Object.values(s.etas.source).flatMap((row) => Object.values(row)));
  const labels = ['simulated positions'];
  if (sources.has('routed')) labels.push('routed ETA');
  if (sources.has('fixture') || sources.size === 0) labels.push('fixture ETA');
  if (s.activeTraffic.length > 0) labels.push('simulated traffic');
  if (s.placements.some((p) => p.offers.some((o) => o.simulated))) labels.push('simulated Offer');
  provenanceEl.textContent = labels.join(' · ');
}

const map = initMap(requireElement('map'), {
  paddingTopLeft: [400, 90],
  paddingBottomRight: [380, 50],
});

/** @param {StateSnapshot} s */
function render(s) {
  const m = model(s);
  renderTopBar(m);
  renderDisruptions(m);
  renderCall(m);
  renderPlacement(m);
  renderTables(m);
  renderTrafficButtons(s);
  renderProvenance(s);
  map.render(s);
}

source.addEventListener('state', (event) => {
  /** @type {unknown} */
  const parsed = JSON.parse(/** @type {MessageEvent<string>} */ (event).data);
  const s = /** @type {StateSnapshot} */ (parsed);
  latest = s;
  skewMs = Date.now() - Date.parse(s.now);
  trackCelebrations(s);
  render(s);
});

// Live "so far" times on open Disruption cards.
setInterval(() => {
  if (latest?.disruptions.some((d) => d.status === 'running' || d.status === 'queued')) {
    renderDisruptions(model(latest));
  }
}, 1000);

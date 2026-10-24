// @ts-check
// Framework-free dashboard client. Type-checked via public/tsconfig.json (checkJs).
import { initMap } from './map.js';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

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

/**
 * @typedef {{ id: string, name: string, phone: string | null, simulated: boolean,
 *   capacity: number, availableFrom: string, availableUntil: string }} SnapshotDriver
 * @typedef {{ id: string, label: string, status: string, driverId: string | null,
 *   parcels: number, deadline: string, note: string | null }} SnapshotJob
 * @typedef {{ drivers: SnapshotDriver[], jobs: SnapshotJob[] }} Snapshot
 */

/** @param {string} iso */
function clockTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * @param {string} testId
 * @param {string[][]} rows
 * @param {(string | null)[]} [rowClasses]
 */
function fillTable(testId, rows, rowClasses = []) {
  const body = document.querySelector(`[data-testid="${testId}"] tbody`);
  if (!body) return;
  body.replaceChildren(
    ...rows.map((cells, i) => {
      const tr = document.createElement('tr');
      const cls = rowClasses[i];
      if (cls) tr.className = cls;
      for (const text of cells) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.append(td);
      }
      return tr;
    }),
  );
}

/** @param {Snapshot} snapshot */
function renderTables(snapshot) {
  const nameOf = (/** @type {string | null} */ id) =>
    snapshot.drivers.find((d) => d.id === id)?.name ?? '—';
  fillTable(
    'drivers-table',
    snapshot.drivers.map((d) => [
      d.name,
      d.simulated ? 'simulated' : d.phone ? 'real phone' : 'none',
      String(d.capacity),
      `${clockTime(d.availableFrom)}–${clockTime(d.availableUntil)}`,
    ]),
  );
  fillTable(
    'jobs-table',
    snapshot.jobs.map((j) => [
      `${j.id} ${j.label}`,
      j.note ? `${j.status.replace('_', ' ')} (${j.note})` : j.status.replace('_', ' '),
      nameOf(j.driverId),
      String(j.parcels),
      clockTime(j.deadline),
    ]),
    snapshot.jobs.map((j) => `status-${j.status}`),
  );
}

/** @type {((snapshot: Snapshot) => void)[]} */
export const snapshotListeners = [renderTables];

const map = initMap(requireElement('map'));
snapshotListeners.push((snapshot) => {
  map.render(
    /** @type {import('../src/domain/types.ts').StateSnapshot} */ (
      /** @type {unknown} */ (snapshot)
    ),
  );
});

source.addEventListener('state', (event) => {
  /** @type {unknown} */
  const parsed = JSON.parse(/** @type {MessageEvent<string>} */ (event).data);
  const snapshot = /** @type {Snapshot} */ (parsed);
  for (const listener of snapshotListeners) listener(snapshot);
});

requireElement('reset').addEventListener('click', () => {
  void fetch('/api/reset', { method: 'POST' });
});

// ---- Placement panel (#4): self-contained; renders the latest Placement from `state`. ----

/**
 * @typedef {{ id: string; driverId: string; status: string; simulated: boolean }} OfferView
 * @typedef {{ driverId: string; etaToPickupMinutes: number }} EligibleView
 * @typedef {{ driverId: string; reason: { kind: string; text: string } }} IneligibleView
 * @typedef {{
 *   id: string; jobId: string; tier: string; status: string;
 *   queuedAt: string; endedAt: string | null; offers: OfferView[];
 *   evaluation: { eligible: EligibleView[]; ineligible: IneligibleView[] } | null;
 * }} PlacementView
 * @typedef {{ now: string; drivers: { id: string; name: string }[]; placements: PlacementView[] }} PlacementSnapshot
 */

const placementEl = requireElement('placement');

/**
 * @param {string} tag
 * @param {string} text
 * @param {Record<string, string>} [data]
 */
function placementNode(tag, text, data = {}) {
  const node = document.createElement(tag);
  node.textContent = text;
  for (const [key, value] of Object.entries(data)) node.dataset[key] = value;
  return node;
}

/** @param {PlacementSnapshot} snapshot */
function renderPlacement(snapshot) {
  const el = placementNode;
  const placement = snapshot.placements.at(-1);
  if (!placement) {
    placementEl.replaceChildren(el('p', 'No Placement yet.'));
    return;
  }
  /** @param {string} id */
  const nameOf = (id) => snapshot.drivers.find((d) => d.id === id)?.name ?? id;
  const end = placement.endedAt ?? snapshot.now;
  const seconds = Math.max(
    0,
    Math.round((Date.parse(end) - Date.parse(placement.queuedAt)) / 1000),
  );
  const elapsed = `${String(Math.floor(seconds / 60))}m ${String(seconds % 60).padStart(2, '0')}s`;
  const label = placement.endedAt
    ? `${placement.status} ${elapsed} after Disruption`
    : `${placement.status}, ${elapsed} so far`;

  const header = el('p', `${placement.jobId} · ${placement.tier} · `);
  header.append(el('strong', label, { testid: 'placement-status', status: placement.status }));

  const ranked = el('ol', '', { testid: 'eligible-list' });
  for (const e of placement.evaluation?.eligible ?? []) {
    ranked.append(
      el('li', `${nameOf(e.driverId)} · ${String(e.etaToPickupMinutes)} min to Pickup`),
    );
  }
  if (ranked.children.length === 0) ranked.append(el('li', 'No Eligible Driver'));

  const ineligible = el('ul', '', { testid: 'ineligible-list' });
  for (const i of placement.evaluation?.ineligible ?? []) {
    ineligible.append(el('li', `${nameOf(i.driverId)}: ${i.reason.text}`));
  }

  const offers = el('ul', '', { testid: 'offer-list' });
  for (const o of placement.offers) {
    const sim = o.simulated ? ' (simulated Offer)' : '';
    offers.append(
      el('li', `Offer to ${nameOf(o.driverId)}${sim}: ${o.status}`, { status: o.status }),
    );
  }
  if (offers.children.length === 0) offers.append(el('li', 'No Offers yet'));

  placementEl.replaceChildren(
    header,
    el('h3', 'Eligible'),
    ranked,
    el('h3', 'Ineligible'),
    ineligible,
    el('h3', 'Offers'),
    offers,
  );
}

source.addEventListener('state', (event) => {
  /** @type {unknown} */
  const snapshot = JSON.parse(String(event.data));
  renderPlacement(/** @type {PlacementSnapshot} */ (snapshot));
});

// ---- Traffic (#8): one "Inject traffic" button per fixture traffic event. ----

/**
 * @typedef {{ trafficEvents: { id: string; label: string }[]; activeTraffic: { id: string }[] }} TrafficSnapshot
 */

const trafficButtonsEl = requireElement('traffic-buttons');

/** @param {TrafficSnapshot} snapshot */
function renderTrafficButtons(snapshot) {
  trafficButtonsEl.replaceChildren(
    ...snapshot.trafficEvents.map((t) => {
      const active = snapshot.activeTraffic.some((a) => a.id === t.id);
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset['testid'] = `inject-traffic-${t.id}`;
      button.textContent = active
        ? `${t.label} (simulated traffic, active)`
        : `Inject traffic: ${t.label} (simulated traffic)`;
      button.disabled = active;
      button.addEventListener('click', () => {
        void fetch(`/api/traffic/${encodeURIComponent(t.id)}`, { method: 'POST' });
      });
      return button;
    }),
  );
}

// ---- Urgent Job form + Placement Queue (#9): self-contained; posts to /api/jobs. ----

/**
 * @typedef {{
 *   jobs: { id: string; label: string; deadline: string }[];
 *   placements: { id: string; jobId: string; tier: string }[];
 *   queue: string[];
 * }} QueueSnapshot
 */

const urgentForm = /** @type {HTMLFormElement} */ (requireElement('urgent-form'));
const urgentError = requireElement('urgent-error');
const queueEl = requireElement('placement-queue');

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
      return;
    }
    /** @type {unknown} */
    const raw = await res.json().catch(() => ({}));
    const payload = /** @type {{ message?: string }} */ (raw);
    urgentError.textContent = payload.message ?? `Could not add Urgent Job (${String(res.status)})`;
  });
});

/** @param {QueueSnapshot} snapshot */
function renderQueue(snapshot) {
  const items = snapshot.queue.map((placementId, i) => {
    const placement = snapshot.placements.find((p) => p.id === placementId);
    const job = snapshot.jobs.find((j) => j.id === placement?.jobId);
    const li = document.createElement('li');
    li.dataset['placementId'] = placementId;
    const name = job ? `${job.id} ${job.label}` : placementId;
    const due = job ? clockTime(job.deadline) : '—';
    li.textContent = `${String(i + 1)}. ${name} · ${placement?.tier ?? ''} · due ${due}`;
    return li;
  });
  if (items.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Queue empty';
    items.push(li);
  }
  queueEl.replaceChildren(...items);
}

source.addEventListener('state', (event) => {
  /** @type {unknown} */
  const snapshot = JSON.parse(String(event.data));
  renderTrafficButtons(/** @type {TrafficSnapshot} */ (snapshot));
  renderQueue(/** @type {QueueSnapshot} */ (snapshot));
});

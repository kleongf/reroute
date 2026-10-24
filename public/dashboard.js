// @ts-check
// Framework-free dashboard client. Type-checked via public/tsconfig.json (checkJs).

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

source.addEventListener('state', (event) => {
  /** @type {unknown} */
  const parsed = JSON.parse(/** @type {MessageEvent<string>} */ (event).data);
  const snapshot = /** @type {Snapshot} */ (parsed);
  for (const listener of snapshotListeners) listener(snapshot);
});

requireElement('reset').addEventListener('click', () => {
  void fetch('/api/reset', { method: 'POST' });
});

// PROTOTYPE hook (throwaway, branch prototype/dashboard-ui): `?variant=A|B|C` swaps in a
// prototype layout from /prototype/ that consumes the same snapshot stream.
if (new URLSearchParams(location.search).has('variant')) {
  requireElement('dashboard').hidden = true;
  const prototypeUrl = '/prototype/variants.js';
  /** @type {Promise<{ start: (deps: { onSnapshot: (fn: (s: Snapshot) => void) => void }) => void }>} */
  const prototype = import(prototypeUrl);
  void prototype.then((mod) => {
    mod.start({ onSnapshot: (fn) => snapshotListeners.push(fn) });
  });
}

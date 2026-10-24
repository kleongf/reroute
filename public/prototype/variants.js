// @ts-nocheck
// PROTOTYPE (throwaway): three structurally different dashboard layouts, selected by ?variant=A|B|C.
import { SCENES, stubScene, liveScene } from './scenes.js';
import { mountSwitcher } from './switcher.js';

export const VARIANTS = { A: 'Mission control', B: 'Story / pipeline', C: 'Ops board' };

// ---------- tiny DOM helper ----------
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

const clock = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtElapsed = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const STATUS_LABEL = {
  assigned: 'Assigned',
  at_risk: 'At Risk',
  late: 'Late',
  unassigned: 'Unassigned',
  escalated: 'Escalated',
  done: 'Done',
  placed: 'Placed',
};
const stub = (what) => () => console.log(`[prototype] stub: ${what}`);

// ---------- scene -> view model (shared data, not shared layout) ----------
function derive(scene) {
  const s = scene.snapshot;
  const driver = (id) => s.drivers.find((d) => d.id === id);
  const job = (id) => s.jobs.find((j) => j.id === id);
  const started = s.placements.filter((p) => p.status !== 'queued');
  const placement = started.find((p) => p.status === 'running') ?? started.at(-1) ?? null;
  const focusJob = placement ? job(placement.jobId) : (s.jobs.find((j) => j.status === 'at_risk') ?? null);
  const queued = s.queue.map((id) => s.placements.find((p) => p.id === id)).filter(Boolean);
  const offerFor = (id) => placement?.offers.find((o) => o.driverId === id) ?? null;
  const ev = placement?.evaluation ?? null;
  const ladder = ev
    ? [
        ...ev.eligible.map((e, i) => ({ rank: i + 1, d: driver(e.driverId), eta: e.etaToPickupMinutes, offer: offerFor(e.driverId) })),
        ...ev.ineligible.map((e) => ({ rank: null, d: driver(e.driverId), reason: e.reason.text })),
      ]
    : [];
  let step = -1;
  if (focusJob?.status === 'at_risk') step = 0;
  if (placement) {
    step = ev ? 2 : 1;
    if (placement.offers.some((o) => o.status === 'accepted')) step = 3;
    if (placement.status === 'placed') step = 4;
    if (placement.status === 'escalated') step = 4;
  }
  const liveCall = scene.calls.find((c) => c.status === 'live') ?? scene.calls.at(-1) ?? null;
  const pending = placement?.offers.find((o) => o.status === 'pending') ?? null;
  const placedWith = placement?.status === 'placed' ? driver(placement.offers.find((o) => o.status === 'accepted')?.driverId) : null;
  const provenance = ['simulated positions', 'fixture ETA'];
  if (s.activeTraffic.length) provenance.push('simulated traffic');
  if (placement?.offers.some((o) => o.simulated)) provenance.push('simulated Offer');
  return { s, driver, job, placement, focusJob, queued, ladder, step, liveCall, pending, placedWith, provenance, scene };
}

function headline(m) {
  const j = m.focusJob;
  if (!j) return 'All Jobs on track';
  if (m.placedWith) return `${j.id} Placed with ${m.placedWith.name}`;
  if (j.status === 'at_risk') return `${j.id} At Risk: checking with ${m.driver(j.driverId)?.name}`;
  if (m.pending) return `${j.id} Late: Offer to ${m.driver(m.pending.driverId)?.name}`;
  return `${j.id} ${STATUS_LABEL[j.status]}`;
}

function elapsedEl(m, cls) {
  const { disruptionAt, placedAt } = m.scene;
  const el = h('span', { class: cls, 'data-elapsed': '' });
  if (!disruptionAt) {
    el.textContent = '–:––';
    return el;
  }
  const tick = () => (el.textContent = fmtElapsed((placedAt ? Date.parse(placedAt) : Date.now()) - Date.parse(disruptionAt)));
  tick();
  if (!placedAt) timers.push(setInterval(tick, 1000));
  return el;
}

function provenanceChips(m, cls = 'prov') {
  return h('span', { class: cls }, m.provenance.map((p) => h('span', { class: 'chip' }, p)));
}

function controls(cls = 'ctrls') {
  return h(
    'span',
    { class: cls },
    h('button', { onclick: stub('Reset demo') }, 'Reset demo'),
    h('button', { onclick: stub('Inject traffic: I-280 closed') }, 'Inject traffic'),
  );
}

function urgentJobForm() {
  return h(
    'form',
    {
      class: 'urgent-form',
      onsubmit: (e) => {
        e.preventDefault();
        console.log('[prototype] stub: add Urgent Job', Object.fromEntries(new FormData(e.target)));
      },
    },
    h('label', {}, 'Pickup', h('input', { name: 'pickup', placeholder: 'Castro Pharmacy' })),
    h('label', {}, 'Drop-off', h('input', { name: 'dropoff', placeholder: 'Noe Valley Home' })),
    h('label', {}, 'Parcels', h('input', { name: 'parcels', type: 'number', value: '1', min: '1' })),
    h('label', {}, 'Due in (min)', h('input', { name: 'due', type: 'number', value: '45' })),
    h('label', {}, 'Tier', h('select', { name: 'tier' }, h('option', {}, 'Normal'), h('option', {}, 'High'))),
    h('button', { type: 'submit', class: 'primary' }, 'Add Urgent Job'),
  );
}

function offerBadge(row) {
  const o = row.offer;
  if (!o) return h('span', { class: 'badge todo' }, 'not offered');
  if (o.status === 'declined') return h('span', { class: 'badge bad' }, `Declined${o.declineReason ? `: “${o.declineReason}”` : ''}`);
  if (o.status === 'pending') return h('span', { class: 'badge live' }, 'Offer: calling…');
  if (o.status === 'accepted') return h('span', { class: 'badge ok' }, 'Accepted');
  return h('span', { class: 'badge bad' }, 'Unanswered');
}

// ---------- Leaflet map ----------
let leafletReady;
function loadLeaflet() {
  leafletReady ??= new Promise((resolve, reject) => {
    document.head.append(h('link', { rel: 'stylesheet', href: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css' }));
    const sc = h('script', { src: 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js' });
    sc.onload = () => resolve(window.L);
    sc.onerror = reject;
    document.head.append(sc);
  });
  return leafletReady;
}

const maps = [];
async function drawMap(el, m, { compact = false, zoomControl = !compact, padTL = null, padBR = null } = {}) {
  const L = await loadLeaflet();
  if (!el.isConnected) return;
  const map = L.map(el, { zoomControl, attributionControl: !compact, dragging: !compact, scrollWheelZoom: !compact });
  maps.push(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '© OpenStreetMap' }).addTo(map);
  const pts = [];
  for (const t of m.s.activeTraffic) {
    L.polyline(t.path, { color: '#d1242f', weight: compact ? 5 : 9, opacity: 0.85 })
      .bindTooltip(`${t.label} (simulated traffic)`, { permanent: !compact, direction: 'right', className: 'map-tip traffic' })
      .addTo(map);
  }
  for (const j of m.s.jobs) {
    const p = [j.pickup.lat, j.pickup.lng];
    pts.push(p);
    const focus = j.id === m.focusJob?.id;
    L.marker(p, {
      icon: L.divIcon({ className: '', html: `<div class="mk-job s-${j.status}${focus ? ' focus' : ''}">${j.id}</div>`, iconSize: [0, 0] }),
    }).addTo(map);
    if (j.driverId) {
      const d = m.driver(j.driverId);
      L.polyline([[d.position.lat, d.position.lng], p], {
        color: focus ? (m.placedWith ? '#1a7f37' : '#bf3989') : '#57606a',
        weight: focus ? 5 : 3,
        dashArray: focus && !m.placedWith ? '8 8' : null,
      }).addTo(map);
    }
  }
  if (m.pending && m.focusJob) {
    const d = m.driver(m.pending.driverId);
    L.polyline([[d.position.lat, d.position.lng], [m.focusJob.pickup.lat, m.focusJob.pickup.lng]], {
      color: '#0969da',
      weight: 4,
      dashArray: '2 8',
    }).addTo(map);
  }
  for (const d of m.s.drivers) {
    const p = [d.position.lat, d.position.lng];
    pts.push(p);
    const cls = m.pending?.driverId === d.id ? 'calling' : m.liveCall?.driverId === d.id && m.liveCall.status === 'live' ? 'calling' : '';
    L.marker(p, {
      icon: L.divIcon({ className: '', html: `<div class="mk-driver ${cls}"><b>${d.name[0]}</b><span>${d.name}</span></div>`, iconSize: [0, 0] }),
    }).addTo(map);
  }
  const fit = () => {
    map.invalidateSize();
    map.fitBounds(pts, padTL ? { paddingTopLeft: padTL, paddingBottomRight: padBR } : { padding: compact ? [14, 14] : [60, 60] });
  };
  fit();
  setTimeout(fit, 80);
  return map;
}

function mapProvenance() {
  return h('div', { class: 'map-prov' }, 'simulated positions · fixture ETA · OpenStreetMap');
}

// ---------- transcript renderers ----------
function bubbles(m, { all = true } = {}) {
  const calls = all ? m.scene.calls : m.liveCall ? [m.liveCall] : [];
  if (!calls.length) return h('p', { class: 'muted' }, 'No calls yet (live scene: transcript comes from Retell later).');
  return calls.map((c) => {
    const d = m.driver(c.driverId);
    return h(
      'div',
      { class: `call ${c.status}` },
      h(
        'div',
        { class: 'call-head' },
        h('b', {}, `${c.status === 'live' ? '● LIVE  ' : ''}${d.name}`),
        ` · ${c.purpose}`,
        c.simulated ? h('span', { class: 'chip warn' }, 'simulated Offer') : null,
        c.outcome ? h('span', { class: 'outcome' }, c.outcome) : null,
      ),
      c.lines.map((l) => h('div', { class: `bubble ${l.who === 'Reroute' ? 'me' : 'them'}` }, h('small', {}, l.who), l.text)),
      c.status === 'live' ? h('div', { class: 'bubble them typing' }, '…') : null,
    );
  });
}

// ===================================================================
// Variant A: Mission control. Map is the stage; everything floats.
// ===================================================================
function renderA(root, m) {
  const mapEl = h('div', { class: 'a-map' });
  root.append(mapEl, mapProvenance());
  drawMap(mapEl, m, { zoomControl: false, padTL: [20, 70], padBR: [410, 20] });

  root.append(
    h(
      'div',
      { class: 'a-top card' },
      h('b', { class: 'brand' }, 'Reroute'),
      h('span', { class: `a-head s-${m.placedWith ? 'placed' : m.focusJob?.status ?? 'assigned'}` }, headline(m)),
      h('span', { class: 'a-elapsed' }, 'Disruption → Placed ', elapsedEl(m, 'big-num')),
      controls(),
      h('details', { class: 'a-urgent' }, h('summary', {}, '+ Urgent Job'), urgentJobForm()),
    ),
  );

  const c = m.liveCall;
  root.append(
    h(
      'div',
      { class: 'a-call card' },
      c
        ? [
            h(
              'div',
              { class: 'a-call-head' },
              h('span', { class: `dot ${c.status}` }),
              h('b', {}, `${c.status === 'live' ? 'On call with' : 'Last call:'} ${m.driver(c.driverId).name}`),
              h('span', { class: 'muted' }, c.purpose),
            ),
            h(
              'div',
              { class: 'a-lines' },
              c.lines.map((l) => h('p', {}, h('b', { class: l.who === 'Reroute' ? 'who-me' : 'who-them' }, `${l.who}: `), l.text)),
            ),
          ]
        : h('p', { class: 'muted' }, 'No call in progress'),
    ),
  );

  const ladder = h('div', { class: 'a-ladder card' }, h('h3', {}, m.focusJob ? `Placement · ${m.focusJob.id}` : 'Placement'));
  if (!m.ladder.length) ladder.append(h('p', { class: 'muted' }, m.focusJob?.status === 'at_risk' ? 'Waiting for Alex’s answer. Only a Disruption starts a Placement.' : 'No Placement running.'));
  for (const r of m.ladder) {
    ladder.append(
      h(
        'div',
        { class: `a-rung ${r.rank ? 'elig' : 'inelig'} ${r.offer?.status ?? ''}` },
        h('span', { class: 'rank' }, r.rank ?? '✕'),
        h('span', { class: 'name' }, r.d.name, r.d.simulated ? h('small', { class: 'chip warn' }, 'simulated') : null),
        r.rank ? h('span', { class: 'eta' }, `${r.eta} min`) : null,
        h('span', { class: 'why' }, r.rank ? offerBadge(r) : r.reason),
      ),
    );
  }
  if (m.queued.length) {
    ladder.append(h('h4', {}, 'Placement Queue'), ...m.queued.map((p, i) => h('div', { class: 'q' }, `${i + 1}. ${p.jobId} ${m.job(p.jobId)?.label} · ${p.tier === 'high' ? 'High' : 'Normal'}`)));
  }
  root.append(ladder);

  const drawer = h('div', { class: 'a-drawer' });
  const handle = h(
    'button',
    { class: 'a-handle', onclick: () => drawer.classList.toggle('open') },
    `▲ Jobs (${m.s.jobs.length}) · Drivers (${m.s.drivers.length})`,
  );
  drawer.append(
    handle,
    h(
      'div',
      { class: 'a-drawer-body' },
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'Job'), h('th', {}, 'Status'), h('th', {}, 'Driver'), h('th', {}, 'Due')),
        m.s.jobs.map((j) => h('tr', {}, h('td', {}, `${j.id} ${j.label}`), h('td', {}, h('span', { class: `pill s-${j.status}` }, STATUS_LABEL[j.status])), h('td', {}, m.driver(j.driverId)?.name ?? '—'), h('td', {}, clock(j.deadline)))),
      ),
      h(
        'table',
        {},
        h('tr', {}, h('th', {}, 'Driver'), h('th', {}, 'Free slots'), h('th', {}, 'Available')),
        m.s.drivers.map((d) => h('tr', {}, h('td', {}, d.name, d.simulated ? ' (simulated)' : ''), h('td', {}, d.capacity), h('td', {}, `${clock(d.availableFrom)}–${clock(d.availableUntil)}`))),
      ),
    ),
  );
  root.append(drawer);
}

// ===================================================================
// Variant B: Story / pipeline. The Placement is the headline.
// ===================================================================
function renderB(root, m) {
  const thumb = h('div', { class: 'b-thumb' });
  root.append(
    h(
      'header',
      { class: 'b-head' },
      h('div', {}, h('b', { class: 'brand' }, 'Reroute'), h('div', { class: 'b-title' }, headline(m)), provenanceChips(m)),
      h('div', { class: 'b-clock' }, h('small', {}, 'Disruption → Placed'), elapsedEl(m, 'b-elapsed')),
      thumb,
    ),
  );
  drawMap(thumb, m, { compact: true });

  const pend = m.pending ? m.driver(m.pending.driverId).name : null;
  const declined = m.placement?.offers.filter((o) => o.status !== 'pending' && o.status !== 'accepted') ?? [];
  const accepted = m.placement?.offers.find((o) => o.status === 'accepted');
  const prevName = m.driver(m.placement?.previousDriverId ?? m.focusJob?.driverId)?.name;
  const steps = [
    ['Disruption', m.step === 0 ? `${m.focusJob.id} At Risk · calling ${prevName}` : m.placement ? `${prevName} can’t make ${m.focusJob.id}` : 'none'],
    ['Evaluate', m.placement?.evaluation ? `${m.placement.evaluation.eligible.length} Eligible · ${m.placement.evaluation.ineligible.length} ineligible` : '—'],
    ['Offer', [...declined.map((o) => `${m.driver(o.driverId).name} ✕`), pend ? `${pend}: calling…` : null, accepted ? m.driver(accepted.driverId).name : null].filter(Boolean).join(' → ') || '—'],
    ['Accept', accepted ? `${m.driver(accepted.driverId).name} said yes` : pend ? `waiting for ${pend}` : '—'],
    ['Placed', m.placedWith ? `${prevName} → ${m.placedWith.name}` : '—'],
  ];
  root.append(
    h(
      'ol',
      { class: 'b-steps' },
      steps.map(([label, sub], i) =>
        h(
          'li',
          { class: i < m.step || m.step === 4 ? 'done' : i === m.step ? 'now' : 'todo' },
          h('span', { class: 'n' }, i < m.step || m.step === 4 ? '✓' : i + 1),
          h('b', {}, label),
          h('small', {}, sub),
        ),
      ),
    ),
  );

  const ladder = h('section', { class: 'b-ladder' }, h('h3', {}, 'Who can take ', m.focusJob ? `${m.focusJob.id} (${m.focusJob.parcels} parcels, due ${clock(m.focusJob.deadline)})` : 'it'));
  if (!m.ladder.length) ladder.append(h('p', { class: 'muted big' }, 'Ranking appears once the Driver reports a Disruption.'));
  for (const r of m.ladder) {
    ladder.append(
      h(
        'div',
        { class: `b-row ${r.rank ? 'elig' : 'inelig'} ${r.offer?.status ?? ''}` },
        h('span', { class: 'rank' }, r.rank ? `#${r.rank}` : ''),
        h('span', { class: 'name' }, r.d.name),
        r.rank ? h('span', { class: 'eta' }, `${r.eta} min`, h('small', { class: 'muted' }, ' to Pickup')) : h('span', { class: 'why' }, r.reason),
        r.rank ? offerBadge(r) : null,
        r.d.simulated ? h('span', { class: 'chip warn' }, 'simulated Offer') : null,
      ),
    );
  }
  ladder.append(
    h(
      'div',
      { class: 'b-foot' },
      h('span', {}, h('b', {}, 'Placement Queue: '), m.queued.length ? m.queued.map((p) => `${p.jobId} (${p.tier === 'high' ? 'High' : 'Normal'})`).join(', ') : 'empty'),
      h('details', {}, h('summary', {}, '+ Urgent Job'), urgentJobForm()),
      controls(),
    ),
  );
  root.append(h('div', { class: 'b-body' }, ladder, h('section', { class: 'b-chat' }, h('h3', {}, 'Calls'), bubbles(m))));
  const chat = root.querySelector('.b-chat');
  requestAnimationFrame(() => (chat.scrollTop = chat.scrollHeight));
}

// ===================================================================
// Variant C: Ops board. Jobs by status; Drivers as a roster.
// ===================================================================
function renderC(root, m) {
  root.append(
    h(
      'header',
      { class: 'c-head' },
      h('b', { class: 'brand' }, 'Reroute'),
      provenanceChips(m),
      h('span', { class: 'c-elapsed' }, 'Disruption → Placed ', elapsedEl(m, 'mono')),
      h('button', { onclick: () => openMapModal(m) }, '🗺 Map'),
      h('details', { class: 'c-urgent' }, h('summary', {}, '+ Urgent Job'), urgentJobForm()),
      controls(),
    ),
  );
  const placedJobIds = new Set(m.s.placements.filter((p) => p.status === 'placed').map((p) => p.jobId));
  const col = (j) => {
    if (placedJobIds.has(j.id)) return 'placed';
    if (j.status === 'late' || j.status === 'unassigned') return 'late';
    return j.status;
  };
  const cols = [
    ['assigned', 'Assigned'],
    ['at_risk', 'At Risk'],
    ['late', 'Late / Placing'],
    ['placed', 'Placed'],
    ['escalated', 'Escalated'],
  ];
  const board = h('div', { class: 'c-board' });
  for (const [key, label] of cols) {
    const jobs = m.s.jobs.filter((j) => col(j) === key);
    board.append(h('section', { class: `c-col k-${key}` }, h('h3', {}, label, h('span', { class: 'count' }, jobs.length)), jobs.map((j) => jobCard(j, m))));
  }
  root.append(
    h('div', { class: 'c-main' }, board, h('aside', { class: 'c-side' }, h('h3', {}, 'Calls'), m.scene.calls.length ? [...m.scene.calls].reverse().map((c) => sideCall(c, m)) : h('p', { class: 'muted' }, 'No calls yet'))),
  );
  root.append(
    h(
      'footer',
      { class: 'c-roster' },
      m.s.drivers.map((d) => {
        const held = m.s.jobs.filter((j) => j.driverId === d.id);
        const used = held.reduce((n, j) => n + j.parcels, 0);
        const total = used + d.capacity;
        const inelig = m.placement?.status !== 'running' ? null : m.placement?.evaluation?.ineligible.find((x) => x.driverId === d.id);
        const offer = m.placement?.offers.find((o) => o.driverId === d.id);
        return h(
          'div',
          { class: `c-driver ${offer?.status === 'pending' ? 'calling' : ''}` },
          h('div', { class: 'top' }, h('b', {}, d.name), d.simulated ? h('span', { class: 'chip warn' }, 'simulated') : d.phone ? h('span', { class: 'chip' }, '📞') : null),
          h('div', { class: 'bar' }, h('span', { style: `width:${total ? (used / total) * 100 : 100}%` })),
          h('small', {}, `${used}/${total} slots · ${held.map((j) => j.id).join(' ') || 'idle'}`),
          h('small', { class: 'avail' }, `until ${clock(d.availableUntil)}`),
          offer ? h('small', { class: `st ${offer.status}` }, `Offer ${offer.status}`) : inelig ? h('small', { class: 'st inelig' }, inelig.reason.text) : null,
        );
      }),
    ),
  );
}

function jobCard(j, m) {
  const d = m.driver(j.driverId);
  const p = m.s.placements.find((x) => x.jobId === j.id && x.status !== 'queued') ?? m.s.placements.find((x) => x.jobId === j.id);
  const prev = p?.status === 'placed' ? m.driver(p.previousDriverId) : null;
  const qi = m.s.queue.indexOf(p?.id);
  return h(
    'article',
    { class: `c-card s-${j.status}` },
    h('div', { class: 'c-card-top' }, h('b', {}, j.id), h('span', { class: 'due' }, `due ${clock(j.deadline)}`)),
    h('div', { class: 'label' }, j.label, ` · ${j.parcels} parcel${j.parcels > 1 ? 's' : ''}`),
    h('div', { class: 'chips' }, prev ? h('span', { class: 'drv was' }, prev.name) : null, d ? h('span', { class: 'drv' }, d.name) : h('span', { class: 'drv none' }, 'no Driver')),
    j.note ? h('div', { class: 'note' }, j.note) : null,
    qi >= 0 ? h('div', { class: 'note' }, `Placement Queue #${qi + 1} · ${p.tier === 'high' ? 'High' : 'Normal'}`) : null,
    p?.status === 'running'
      ? h(
          'div',
          { class: 'mini' },
          m.ladder.filter((r) => r.rank).map((r) => h('div', {}, `#${r.rank} ${r.d.name} ${r.eta}m `, offerBadge(r))),
          h('div', { class: 'muted' }, `${m.ladder.filter((r) => !r.rank).length} ineligible (see roster)`),
        )
      : null,
  );
}

function sideCall(c, m) {
  return h(
    'div',
    { class: `c-call ${c.status}` },
    h('div', { class: 'hd' }, h('b', {}, `${c.status === 'live' ? '● ' : ''}${m.driver(c.driverId).name}`), ` ${c.purpose}`, c.simulated ? h('span', { class: 'chip warn' }, 'simulated Offer') : null),
    c.status === 'live' ? c.lines.map((l) => h('p', {}, h('b', {}, `${l.who}: `), l.text)) : h('p', { class: 'muted' }, c.outcome ?? ''),
  );
}

function openMapModal(m) {
  const box = h('div', { class: 'c-map' });
  const modal = h(
    'div',
    { class: 'c-modal', onclick: (e) => e.target === modal && modal.remove() },
    h('div', { class: 'c-modal-in' }, h('button', { class: 'close', onclick: () => modal.remove() }, '✕ Close'), box, mapProvenance()),
  );
  document.body.append(modal);
  drawMap(box, m);
}

// ---------- mount ----------
const RENDER = { A: renderA, B: renderB, C: renderC };
let timers = [];
let latestLive = null;

function readParams() {
  const q = new URLSearchParams(location.search);
  const v = (q.get('variant') ?? 'A').toUpperCase();
  const sc = q.get('scene') ?? 'placing';
  return { variant: RENDER[v] ? v : 'A', scene: SCENES.includes(sc) ? sc : 'placing' };
}

function render() {
  for (const t of timers) clearInterval(t);
  timers = [];
  while (maps.length) maps.pop().remove();
  document.querySelectorAll('.c-modal').forEach((x) => x.remove());
  const { variant, scene } = readParams();
  const root = document.getElementById('proto-root');
  root.replaceChildren();
  root.className = `proto v${variant}`;
  const data = scene === 'live' ? (latestLive ? liveScene(latestLive) : null) : stubScene(scene);
  if (!data) {
    root.append(h('p', { class: 'muted big', style: 'padding:40px' }, 'Waiting for live snapshot…'));
    return;
  }
  RENDER[variant](root, derive(data));
}

export function start({ onSnapshot }) {
  document.head.append(h('link', { rel: 'stylesheet', href: '/prototype/variants.css' }));
  document.body.classList.add('prototype-on');
  document.body.append(h('div', { id: 'proto-root' }));
  onSnapshot((snap) => {
    latestLive = snap;
    if (readParams().scene === 'live') render();
  });
  mountSwitcher({ variants: VARIANTS, scenes: SCENES, read: readParams, onChange: render });
  render();
}

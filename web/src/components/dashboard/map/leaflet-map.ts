// Leaflet glue for MapStage: Drivers, Pickups, drop-offs, assignment and pending-Offer lines,
// active traffic. React owns the provenance label, this owns the map.
// Positions are simulated; movement comes from lib/vehicle-motion.ts.

import L from 'leaflet';
import type { LatLng, StateSnapshot } from '@backend/domain/types.ts';
import { createVehicleMotion } from '@/lib/vehicle-motion.ts';
import { driverTraffic } from '../demo/traffic.ts';

/** San Francisco, matching fixtures/demo.json. */
const SF_CENTER: [number, number] = [37.7649, -122.4294];

/** Jobs in trouble pulse red; Jobs whose Disruption was fixed turn green. */
const TROUBLE = new Set<string>(['at_risk', 'late', 'escalated', 'unassigned']);

type Health = 'trouble' | 'fixed' | 'ok' | 'calling';

const ll = (p: LatLng): [number, number] => [p.lat, p.lng];

function labelIcon(kind: string) {
  return L.divIcon({
    className: `map-marker map-marker--${kind}`,
    html: `<span class="map-marker__dot"></span><span class="map-marker__label"></span>`,
    iconSize: [0, 0],
  });
}

function decorate(marker: L.Marker, kind: string, text: string) {
  const el = marker.getElement();
  if (!el) return;
  el.dataset['kind'] = kind;
  const label = el.querySelector('.map-marker__label');
  if (label) label.textContent = text;
}

/** Where a label may go, tried in order: beside its dot, then below, then above. */
const LABEL_SLOTS = [
  '',
  'map-label--below',
  'map-label--above',
  'map-label--below-2',
  'map-label--above-2',
] as const;
const DECLUTTER_EVERY_MS = 200;

/** Jobs in trouble or just fixed keep their spot first, then Drivers, then the rest. */
function labelRank(label: HTMLElement): number {
  const marker = label.parentElement;
  if (marker?.dataset['health'] === 'trouble' || marker?.dataset['health'] === 'fixed') return 2;
  return marker?.dataset['kind'] === 'driver' ? 1 : 0;
}

/**
 * Moves marker labels that overlap another label or dot (a Driver sitting on a Pickup, two
 * drop-offs side by side) one or two lines below or above their dot; a label with no free slot
 * is hidden until it has one.
 */
function declutter(container: HTMLElement) {
  const labels = [...container.querySelectorAll<HTMLElement>('.map-marker__label')];
  for (const l of labels) l.classList.remove(...LABEL_SLOTS.filter(Boolean), 'map-label--hidden');
  labels.sort((a, b) => labelRank(b) - labelRank(a));
  // Dots, the "awaiting acceptance" tooltip and traffic labels are obstacles too.
  const placed = [
    ...container.querySelectorAll('.map-marker__dot, .map-pending-label, .map-traffic-label'),
  ].map((d) => d.getBoundingClientRect());
  const free = (r: DOMRect) =>
    placed.every(
      (p) => r.right <= p.left || r.left >= p.right || r.bottom <= p.top || r.top >= p.bottom,
    );
  for (const label of labels) {
    const slot = LABEL_SLOTS.find((s) => {
      if (s) label.classList.add(s);
      const rect = label.getBoundingClientRect();
      if (free(rect)) {
        placed.push(rect);
        return true;
      }
      if (s) label.classList.remove(s);
      return false;
    });
    if (slot === undefined) label.classList.add('map-label--hidden');
  }
}

function prefersReducedMotion() {
  return globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export interface MapOptions {
  /** Fit padding, so floating cards do not hide the points. */
  paddingTopLeft?: [number, number];
  paddingBottomRight?: [number, number];
  /** Fires when simulated movement starts or stops. */
  onMotionChange?: (moving: boolean) => void;
}

export interface LeafletMap {
  render(snapshot: StateSnapshot): void;
  destroy(): void;
}

export function createLeafletMap(canvas: HTMLElement, options: MapOptions = {}): LeafletMap {
  const map = L.map(canvas, { center: SF_CENTER, zoom: 13, fadeAnimation: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  let fitted = false;

  const motion = createVehicleMotion();
  let driverMarkers = new Map<string, L.Marker>();
  let driverLines: { driverId: string; line: L.Polyline; to: [number, number] }[] = [];
  let frame = 0;
  let moving = false;
  let decluttered = 0;
  map.on('zoomend moveend', () => {
    declutter(canvas);
  });

  const setMoving = (next: boolean) => {
    if (next === moving) return;
    moving = next;
    options.onMotionChange?.(moving);
  };

  const shown = (id: string, fallback: LatLng): [number, number] => {
    if (prefersReducedMotion()) return ll(fallback);
    const p = motion.positionsAt(performance.now()).get(id);
    return ll(p?.position ?? fallback);
  };

  const animate = () => {
    frame = 0;
    if (prefersReducedMotion()) {
      setMoving(false);
      return;
    }
    const positions = motion.positionsAt(performance.now());
    for (const [id, marker] of driverMarkers) {
      const p = positions.get(id);
      if (p) marker.setLatLng(ll(p.position));
    }
    for (const { driverId, line, to } of driverLines) {
      const p = positions.get(driverId);
      if (p) line.setLatLngs([ll(p.position), to]);
    }
    if (performance.now() - decluttered > DECLUTTER_EVERY_MS) {
      declutter(canvas);
      decluttered = performance.now();
    }
    const anyMoving = [...positions.values()].some((p) => p.moving);
    setMoving(anyMoving);
    if (anyMoving) frame = requestAnimationFrame(animate);
  };

  return {
    render(snapshot) {
      layer.clearLayers();
      motion.update(snapshot, performance.now());
      driverMarkers = new Map();
      driverLines = [];
      if (!fitted) {
        const points = [
          ...snapshot.drivers.map((d) => ll(d.position)),
          ...snapshot.jobs.flatMap((j) => [ll(j.pickup), ll(j.dropoff)]),
        ];
        if (points.length > 0) {
          map.fitBounds(L.latLngBounds(points), {
            paddingTopLeft: options.paddingTopLeft ?? [24, 24],
            paddingBottomRight: options.paddingBottomRight ?? [24, 24],
            animate: false,
          });
          fitted = true;
        }
      }
      const driverById = new Map(snapshot.drivers.map((d) => [d.id, d]));
      const jobById = new Map(snapshot.jobs.map((j) => [j.id, j]));

      const fixedJobIds = new Set(
        snapshot.disruptions
          .filter((d) => d.status === 'placed')
          .map((d) => d.jobId)
          .filter((id) => jobById.get(id)?.status === 'assigned'),
      );
      const focusJobId = snapshot.jobs
        .filter((job) => job.status !== 'done')
        .sort((a, b) => a.deadline.localeCompare(b.deadline))[0]?.id;

      const addMarker = (at: LatLng, kind: string, text: string, health?: Health) => {
        const icon = labelIcon(health ? `${kind} map-marker--${health}` : kind);
        const m = L.marker(ll(at), { icon, title: text }).addTo(layer);
        decorate(m, kind, text);
        const el = m.getElement();
        if (el && health) el.dataset['health'] = health;
        return m;
      };

      for (const t of snapshot.activeTraffic) {
        L.polyline(t.path, { color: '#d62828', weight: 6, opacity: 0.8, className: 'map-traffic' })
          .bindTooltip(`${t.label} (simulated traffic)`, {
            permanent: true,
            direction: 'right',
            className: 'map-traffic-label',
          })
          .addTo(layer);
      }

      for (const job of snapshot.jobs) {
        if (job.status === 'done') continue;
        const driver = job.driverId === null ? undefined : driverById.get(job.driverId);
        const health: Health = TROUBLE.has(job.status)
          ? 'trouble'
          : fixedJobIds.has(job.id)
            ? 'fixed'
            : 'ok';
        if (job.id === focusJobId || health === 'trouble' || health === 'fixed') {
          const trip = L.polyline([ll(job.pickup), ll(job.dropoff)], {
            color: health === 'fixed' ? '#1a7f37' : '#64748b',
            weight: 3,
            opacity: 0.7,
            className: 'map-line map-line--trip',
          })
            .bindTooltip(`${job.id} Pickup → drop-off · illustrative connection`)
            .addTo(layer);
          trip.getElement()?.setAttribute('data-job-id', job.id);
        }
        if (driver) {
          const line = L.polyline([shown(driver.id, driver.position), ll(job.pickup)], {
            color: health === 'trouble' ? '#cf222e' : health === 'fixed' ? '#1a7f37' : '#1d3557',
            weight: health === 'ok' ? 3 : 5,
            ...(health === 'trouble' && { dashArray: '10 8' }),
            className: `map-line map-line--assigned map-line--${health}`,
          }).addTo(layer);
          driverLines.push({ driverId: driver.id, line, to: ll(job.pickup) });
        }
        addMarker(job.pickup, 'pickup', `${job.id} pickup`, health);
        addMarker(job.dropoff, 'dropoff', `${job.id} drop-off`);
      }

      for (const placement of snapshot.placements) {
        const job = jobById.get(placement.jobId);
        if (!job) continue;
        for (const offer of placement.offers) {
          if (offer.status !== 'pending') continue;
          const driver = driverById.get(offer.driverId);
          if (!driver) continue;
          const line = L.polyline([shown(driver.id, driver.position), ll(job.pickup)], {
            color: '#0969da',
            weight: 3,
            dashArray: '8 8',
            className: 'map-line map-line--pending',
          }).addTo(layer);
          driverLines.push({ driverId: driver.id, line, to: ll(job.pickup) });
          // fadeAnimation: false above makes removed tooltips disappear at once, not after 200 ms.
          L.tooltip({ permanent: true, direction: 'top', className: 'map-pending-label' })
            .setLatLng(line.getCenter())
            .setContent('awaiting acceptance')
            .addTo(layer);
        }
      }

      const calling = new Set(
        snapshot.placements.flatMap((p) =>
          p.offers.filter((o) => o.status === 'pending').map((o) => o.driverId),
        ),
      );
      for (const driver of snapshot.drivers) {
        const traffic = driverTraffic(snapshot, driver.id);
        const marker = addMarker(
          driver.position,
          'driver',
          `${driver.name}${traffic.minutes > 0 ? ` +${String(traffic.minutes)} min` : ''}`,
          calling.has(driver.id) ? 'calling' : undefined,
        );
        marker.getElement()?.setAttribute('data-driver-id', driver.id);
        if (traffic.minutes > 0)
          marker.bindTooltip(`${traffic.labels} · delay before Pickup · simulated traffic`);
        driverMarkers.set(driver.id, marker);
      }
      if (frame !== 0) cancelAnimationFrame(frame);
      animate();
      declutter(canvas);
      decluttered = performance.now();
    },

    destroy() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      map.remove();
    },
  };
}

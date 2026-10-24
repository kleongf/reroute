// Leaflet glue for MapStage: Drivers, Pickups, drop-offs, assignment and pending-Offer lines,
// active traffic. A port of public/map.js; React owns the provenance label, this owns the map.
// Positions are simulated; movement comes from lib/vehicle-motion.ts.

import L from 'leaflet';
import type { LatLng, StateSnapshot } from '@backend/domain/types.ts';
import { createVehicleMotion } from '@/lib/vehicle-motion.ts';

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
        const marker = addMarker(
          driver.position,
          'driver',
          driver.name,
          calling.has(driver.id) ? 'calling' : undefined,
        );
        marker.getElement()?.setAttribute('data-driver-id', driver.id);
        driverMarkers.set(driver.id, marker);
      }
      if (frame !== 0) cancelAnimationFrame(frame);
      animate();
    },

    destroy() {
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
      map.remove();
    },
  };
}

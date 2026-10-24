// @ts-check
// Map panel: Drivers, Pickups, drop-offs, assignment and pending-Offer lines, active traffic.
// Leaflet is loaded globally (window.L) from unpkg by index.html. Positions are simulated.

/** @typedef {import('../src/domain/types.ts').StateSnapshot} StateSnapshot */
/** @typedef {import('../src/domain/types.ts').LatLng} LatLng */

/** @type {typeof import('leaflet')} */
const L = /** @type {{ L: typeof import('leaflet') }} */ (/** @type {unknown} */ (globalThis)).L;

/** San Francisco, matching fixtures/demo.json. */
const SF_CENTER = /** @type {[number, number]} */ ([37.7649, -122.4294]);

/** @param {string} kind */
function labelIcon(kind) {
  return L.divIcon({
    className: `map-marker map-marker--${kind}`,
    html: `<span class="map-marker__dot"></span><span class="map-marker__label"></span>`,
    iconSize: [0, 0],
  });
}

/**
 * @param {L.Marker} marker
 * @param {string} kind
 * @param {string} text
 */
function decorate(marker, kind, text) {
  const el = marker.getElement();
  if (!el) return;
  el.dataset['kind'] = kind;
  const label = el.querySelector('.map-marker__label');
  if (label) label.textContent = text;
}

/** @param {LatLng} p @returns {[number, number]} */
const ll = (p) => [p.lat, p.lng];

/** Jobs in trouble pulse red; Jobs whose Disruption was fixed turn green. */
const TROUBLE = new Set(['at_risk', 'late', 'escalated', 'unassigned']);

/**
 * @param {HTMLElement} container
 * @param {{ paddingTopLeft?: [number, number], paddingBottomRight?: [number, number] }} [options]
 *   Fit padding, so floating cards do not hide the points.
 * @returns {{ render(snapshot: StateSnapshot): void }}
 */
export function initMap(container, options = {}) {
  container.classList.add('map-root');
  container.textContent = '';

  const canvas = document.createElement('div');
  canvas.className = 'map-canvas';
  container.append(canvas);

  const provenance = document.createElement('div');
  provenance.className = 'map-provenance';
  provenance.dataset['testid'] = 'map-provenance';
  provenance.textContent = 'simulated positions · fixture ETA';
  container.append(provenance);

  const expand = document.createElement('button');
  expand.type = 'button';
  expand.className = 'map-expand';
  expand.dataset['testid'] = 'map-expand';
  expand.textContent = 'Expand';
  expand.setAttribute('aria-pressed', 'false');
  container.append(expand);

  const map = L.map(canvas, { center: SF_CENTER, zoom: 13, fadeAnimation: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors',
  }).addTo(map);

  const layer = L.layerGroup().addTo(map);
  let fitted = false;

  expand.addEventListener('click', () => {
    const expanded = container.classList.toggle('map-root--expanded');
    expand.textContent = expanded ? 'Collapse' : 'Expand';
    expand.setAttribute('aria-pressed', String(expanded));
    map.invalidateSize();
  });

  return {
    render(snapshot) {
      layer.clearLayers();
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

      /**
       * @param {LatLng} at
       * @param {string} kind
       * @param {string} text
       * @param {string} [health] 'trouble' | 'fixed' | 'ok'
       */
      const addMarker = (at, kind, text, health) => {
        const icon = labelIcon(health ? `${kind} map-marker--${health}` : kind);
        const m = L.marker(ll(at), { icon, title: text }).addTo(layer);
        decorate(m, kind, text);
        const el = m.getElement();
        if (el && health) el.dataset['health'] = health;
      };

      for (const t of snapshot.activeTraffic) {
        L.polyline(t.path, {
          color: '#d62828',
          weight: 6,
          opacity: 0.8,
          className: 'map-traffic',
        })
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
        const health = TROUBLE.has(job.status)
          ? 'trouble'
          : fixedJobIds.has(job.id)
            ? 'fixed'
            : 'ok';
        if (driver) {
          L.polyline([ll(driver.position), ll(job.pickup)], {
            color: health === 'trouble' ? '#cf222e' : health === 'fixed' ? '#1a7f37' : '#1d3557',
            weight: health === 'ok' ? 3 : 5,
            ...(health === 'trouble' && { dashArray: '10 8' }),
            className: `map-line map-line--assigned map-line--${health}`,
          }).addTo(layer);
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
          const line = L.polyline([ll(driver.position), ll(job.pickup)], {
            color: '#0969da',
            weight: 3,
            dashArray: '8 8',
            className: 'map-line map-line--pending',
          }).addTo(layer);
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
        addMarker(
          driver.position,
          'driver',
          driver.name,
          calling.has(driver.id) ? 'calling' : undefined,
        );
      }
    },
  };
}

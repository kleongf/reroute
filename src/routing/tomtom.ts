import type { LatLng } from '../domain/types.ts';
import type { RoutingPort } from './port.ts';

export interface TomTomOptions {
  apiKey: string;
  /** Default: TomTom's global API host. */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const toMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
const point = (p: LatLng) => ({ point: { latitude: p.lat, longitude: p.lng } });

interface MatrixCell {
  originIndex?: unknown;
  destinationIndex?: unknown;
  routeSummary?: { travelTimeInSeconds?: unknown };
}

/**
 * TomTom Matrix Routing v2 (synchronous): car durations departing now with live traffic,
 * rounded up to whole minutes (at least 1). One POST per batch; cells that fail are null.
 * Billing: origins × destinations transactions (or 5 × the larger side when both exceed 5).
 */
export function createTomTomRouting(opts: TomTomOptions): RoutingPort {
  const baseUrl = opts.baseUrl ?? 'https://api.tomtom.com';
  const timeoutMs = opts.timeoutMs ?? 2_000;
  const doFetch = opts.fetch ?? fetch;

  const table = async (sources: LatLng[], destinations: LatLng[]) => {
    const res = await doFetch(
      `${baseUrl}/routing/matrix/2?key=${encodeURIComponent(opts.apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          origins: sources.map(point),
          destinations: destinations.map(point),
          options: { departAt: 'now', traffic: 'live', routeType: 'fastest', travelMode: 'car' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!res.ok) throw new Error(`TomTom HTTP ${String(res.status)}`);
    const body = (await res.json()) as { data?: unknown };
    if (!Array.isArray(body.data)) throw new Error('TomTom: no data');
    const grid: (number | null)[][] = sources.map(() => destinations.map(() => null));
    for (const cell of body.data as MatrixCell[]) {
      const i = cell.originIndex;
      const j = cell.destinationIndex;
      const s = cell.routeSummary?.travelTimeInSeconds;
      if (typeof i !== 'number' || typeof j !== 'number' || typeof s !== 'number') continue;
      const row = grid[i];
      if (row && j < row.length) row[j] = toMinutes(s);
    }
    return grid;
  };

  return {
    source: 'traffic',
    table,
    async minutes(from, to) {
      const m = (await table([from], [to]))[0]?.[0];
      if (typeof m !== 'number') throw new Error('TomTom: no route');
      return m;
    },
  };
}

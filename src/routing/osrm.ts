import type { LatLng } from '../domain/types.ts';
import type { RoutingPort } from './port.ts';

export interface OsrmOptions {
  /** Default: the public demo server (driving profile only, rate limited). */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const toMinutes = (seconds: number) => Math.max(1, Math.ceil(seconds / 60));
const coord = (p: LatLng) => `${String(p.lng)},${String(p.lat)}`;

/** OSRM driving durations, rounded up to whole minutes (at least 1). */
export function createOsrmRouting(opts: OsrmOptions = {}): RoutingPort {
  const baseUrl = opts.baseUrl ?? 'https://router.project-osrm.org';
  const timeoutMs = opts.timeoutMs ?? 1_500;
  const doFetch = opts.fetch ?? fetch;

  const get = async (path: string): Promise<Record<string, unknown>> => {
    const res = await doFetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`OSRM HTTP ${String(res.status)}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body['code'] !== 'Ok') throw new Error(`OSRM ${String(body['code'])}`);
    return body;
  };

  return {
    async minutes(from, to) {
      const body = await get(`/route/v1/driving/${coord(from)};${coord(to)}?overview=false`);
      const routes = body['routes'] as { duration?: unknown }[] | undefined;
      const seconds = routes?.[0]?.duration;
      if (typeof seconds !== 'number') throw new Error('OSRM: no route');
      return toMinutes(seconds);
    },
    async table(sources, destinations) {
      const all = [...sources, ...destinations];
      const src = sources.map((_, i) => i).join(';');
      const dst = destinations.map((_, i) => i + sources.length).join(';');
      const body = await get(
        `/table/v1/driving/${all.map(coord).join(';')}?sources=${src}&destinations=${dst}`,
      );
      const durations = body['durations'] as unknown[][] | undefined;
      if (!Array.isArray(durations)) throw new Error('OSRM: no durations');
      return sources.map((_, i) =>
        destinations.map((_, j) => {
          const s = durations[i]?.[j];
          return typeof s === 'number' ? toMinutes(s) : null;
        }),
      );
    },
  };
}

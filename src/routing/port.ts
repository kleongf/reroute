import type { LatLng } from '../domain/types.ts';

/** Travel time between points from a routing service. Rejects on any failure or timeout. */
export interface RoutingPort {
  /** Driving minutes from `from` to `to`. */
  minutes(from: LatLng, to: LatLng): Promise<number>;
  /**
   * Optional batch form: minutes from each source to each destination, null where no route.
   * Lets one request replace many against rate-limited services.
   */
  table?(sources: LatLng[], destinations: LatLng[]): Promise<(number | null)[][]>;
}

/** Test double: answers from `fn`; throw from it to simulate an outage. Records every call. */
export interface FakeRouting extends RoutingPort {
  readonly calls: { from: LatLng; to: LatLng }[];
}

export function createFakeRouting(fn: (from: LatLng, to: LatLng) => number): FakeRouting {
  const calls: { from: LatLng; to: LatLng }[] = [];
  return {
    calls,
    minutes(from, to) {
      calls.push({ from, to });
      try {
        return Promise.resolve(fn(from, to));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },
  };
}

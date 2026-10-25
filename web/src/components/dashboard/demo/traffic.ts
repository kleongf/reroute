import type { StateSnapshot } from '@backend/domain/types.ts';

/** This fixture's added delay is on a Driver's approach, not the shared Job trip. */
export function driverTraffic(snapshot: StateSnapshot, driverId: string | null) {
  const events = snapshot.activeTraffic.filter(
    (event) => driverId && (event.addedMinutes[driverId] ?? 0) > 0,
  );
  const minutes = events.reduce(
    (total, event) => total + (driverId ? (event.addedMinutes[driverId] ?? 0) : 0),
    0,
  );
  return { minutes, labels: events.map((event) => event.label).join('; ') };
}

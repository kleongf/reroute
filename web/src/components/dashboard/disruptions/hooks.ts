import { useEffect, useRef, useState } from 'react';
import type { DisruptionSummary, StateSnapshot } from '@backend/domain/types.ts';

/** How long the "fixed" celebration stays on screen after a Placement is Placed. */
export const CELEBRATE_MS = 6000;

/** Server clock, ticking every second (client clock corrected by the latest snapshot's `now`). */
export function useServerNow(snapshot: StateSnapshot): number {
  const [serverNow, setServerNow] = useState(() => Date.parse(snapshot.now));
  const skew = useRef(0);
  useEffect(() => {
    skew.current = Date.now() - Date.parse(snapshot.now);
  }, [snapshot.now]);
  useEffect(() => {
    const id = setInterval(() => {
      setServerNow(Date.now() - skew.current);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  return Math.max(serverNow, Date.parse(snapshot.now));
}

interface FixTracking {
  snapshot: StateSnapshot | null;
  resetAt: string;
  /** Placement IDs already seen Placed; null until the first snapshot after load/reset. */
  seen: Set<string> | null;
  /** Disruptions that became Placed in the latest snapshot (not on load, reconnect or reset). */
  fresh: DisruptionSummary[];
  /** placementId → server time its celebration ends. */
  celebrateUntil: Record<string, number>;
}

/**
 * Notices Disruptions that become Placed while the dashboard is watching. The first snapshot
 * after load or reset only seeds what was already fixed, so reconnects never re-announce.
 * Calls `onFixed` once per newly fixed Disruption; returns whether a Placement is celebrating.
 */
export function useNewlyFixed(
  snapshot: StateSnapshot,
  serverNow: number,
  onFixed?: (d: DisruptionSummary) => void,
): (placementId: string) => boolean {
  const [track, setTrack] = useState<FixTracking>({
    snapshot: null,
    resetAt: '',
    seen: null,
    fresh: [],
    celebrateUntil: {},
  });

  if (track.snapshot !== snapshot) {
    const placed = snapshot.disruptions.filter((d) => d.status === 'placed');
    const reset = track.resetAt !== snapshot.resetAt;
    const seen = reset ? null : track.seen;
    if (seen === null) {
      setTrack({
        snapshot,
        resetAt: snapshot.resetAt,
        seen: new Set(placed.map((d) => d.placementId)),
        fresh: [],
        celebrateUntil: {},
      });
    } else {
      const fresh = placed.filter((d) => !seen.has(d.placementId));
      const until = Date.parse(snapshot.now) + CELEBRATE_MS;
      setTrack({
        snapshot,
        resetAt: snapshot.resetAt,
        seen: fresh.length === 0 ? seen : new Set([...seen, ...fresh.map((d) => d.placementId)]),
        fresh,
        celebrateUntil:
          fresh.length === 0
            ? track.celebrateUntil
            : {
                ...track.celebrateUntil,
                ...Object.fromEntries(fresh.map((d) => [d.placementId, until])),
              },
      });
    }
  }

  const { fresh } = track;
  useEffect(() => {
    if (onFixed) for (const d of fresh) onFixed(d);
    // onFixed is read only when a new batch arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fresh]);

  return (placementId) => (track.celebrateUntil[placementId] ?? 0) > serverNow;
}

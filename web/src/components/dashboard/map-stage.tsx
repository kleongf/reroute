import 'leaflet/dist/leaflet.css';
import './map/map.css';
import { useEffect, useRef, useState } from 'react';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { createLeafletMap, type LeafletMap } from './map/leaflet-map.ts';
import type { DashboardProps } from './types.ts';

/** Same fit padding as `/`: keeps points clear of the left and right card columns. */
const PADDING_TOP_LEFT: [number, number] = [400, 90];
const PADDING_BOTTOM_RIGHT: [number, number] = [380, 50];

/** "simulated positions · live traffic ETA · …": what on screen is not real. */
export function provenanceLabel(s: StateSnapshot, moving: boolean): string {
  const sources = new Set(Object.values(s.etas.source).flatMap((row) => Object.values(row)));
  const labels = ['simulated positions'];
  if (sources.has('traffic')) labels.push('live traffic ETA');
  if (sources.has('routed')) labels.push('routed ETA');
  if (sources.has('fixture') || sources.size === 0) labels.push('fixture ETA');
  if (s.activeTraffic.length > 0) labels.push('simulated traffic');
  if (s.placements.some((p) => p.offers.some((o) => o.simulated))) labels.push('simulated Offer');
  if (moving) labels.push('simulated movement');
  return labels.join(' · ');
}

/** Full-bleed Leaflet map. Leaflet is driven imperatively; React only feeds it snapshots. */
export function MapStage({ snapshot }: DashboardProps) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const [moving, setMoving] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const map = createLeafletMap(canvas, {
      paddingTopLeft: PADDING_TOP_LEFT,
      paddingBottomRight: PADDING_BOTTOM_RIGHT,
      onMotionChange: setMoving,
    });
    mapRef.current = map;
    return () => {
      map.destroy();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    mapRef.current?.render(snapshot);
  }, [snapshot]);

  return (
    // isolate: Leaflet panes use z-index 400+; keep them under the floating cards.
    <div className="map-root isolate h-full w-full" data-testid="map" data-moving={String(moving)}>
      <div ref={canvasRef} className="map-canvas" />
      <div className="map-provenance" data-testid="map-provenance">
        {provenanceLabel(snapshot, moving)}
      </div>
    </div>
  );
}

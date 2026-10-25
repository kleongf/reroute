import 'leaflet/dist/leaflet.css';
import './map/map.css';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { createLeafletMap, type LeafletMap } from './map/leaflet-map.ts';
import type { DashboardProps } from './types.ts';

/** Fit padding: keeps points clear of the left and right card columns. */
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
  // Expanded hides the floating cards (see map.css) so the map has the whole screen.
  const [expanded, setExpanded] = useState(false);

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
    <div
      className={cn('map-root isolate h-full w-full', expanded && 'map-root--expanded')}
      data-testid="map"
      data-moving={String(moving)}
    >
      <div ref={canvasRef} className="map-canvas" />
      <Button
        data-testid="map-expand"
        variant="outline"
        size="sm"
        className="map-expand shadow"
        aria-pressed={expanded}
        onClick={() => {
          setExpanded((e) => !e);
        }}
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
        {expanded ? 'Show panels' : 'Full map'}
      </Button>
      <div className="map-provenance" data-testid="map-provenance">
        {provenanceLabel(snapshot, moving)}
      </div>
    </div>
  );
}

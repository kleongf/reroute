import { Badge } from '@/components/ui/badge';
import { CallCard } from '@/components/dashboard/call-card.tsx';
import { DisruptionCards } from '@/components/dashboard/disruption-cards.tsx';
import { JobsDriversSheet } from '@/components/dashboard/jobs-drivers-sheet.tsx';
import { MapStage } from '@/components/dashboard/map-stage.tsx';
import { PlacementCard } from '@/components/dashboard/placement-card.tsx';
import { TopBar } from '@/components/dashboard/top-bar.tsx';
import { useSnapshot, type FeedStatus } from '@/hooks/use-snapshot.ts';

const STATUS_VARIANT = {
  connecting: 'secondary',
  connected: 'default',
  reconnecting: 'destructive',
} as const satisfies Record<FeedStatus, 'default' | 'secondary' | 'destructive'>;

/**
 * Mission control layout: the map is the stage; every other region floats over it.
 * Each region is its own component (one ticket each); this file only places them.
 */
export function App() {
  const { snapshot, status, heartbeats, transcripts } = useSnapshot();

  return (
    <main className="relative h-screen w-screen overflow-hidden" data-testid="dashboard">
      <h1 className="sr-only">Reroute</h1>
      {snapshot && (
        <>
          <div className="absolute inset-0">
            <MapStage snapshot={snapshot} transcripts={transcripts} />
          </div>
          <div className="stage-overlay absolute inset-x-3 top-3 z-10">
            <TopBar snapshot={snapshot} transcripts={transcripts} />
          </div>
          <div className="stage-overlay absolute top-24 left-3 z-10 w-96 max-w-[calc(100vw-1.5rem)]">
            <DisruptionCards snapshot={snapshot} transcripts={transcripts} />
          </div>
          <div className="stage-overlay absolute top-24 right-3 z-10 w-80 max-w-[calc(100vw-1.5rem)]">
            <PlacementCard snapshot={snapshot} transcripts={transcripts} />
          </div>
          <div className="stage-overlay absolute bottom-3 left-3 z-10 w-96 max-w-[calc(100vw-1.5rem)]">
            <CallCard snapshot={snapshot} transcripts={transcripts} />
          </div>
          <JobsDriversSheet snapshot={snapshot} transcripts={transcripts} />
        </>
      )}
      <div className="absolute right-3 bottom-3 z-10 flex items-center gap-2 rounded-md bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow">
        <span>Live feed</span>
        <Badge data-testid="sse-status" data-state={status} variant={STATUS_VARIANT[status]}>
          {status}
        </Badge>
        <span data-testid="sse-heartbeats">{heartbeats}</span>
        <span>
          · Jobs{' '}
          <span data-testid="job-count">{snapshot === null ? '—' : snapshot.jobs.length}</span>
        </span>
      </div>
    </main>
  );
}

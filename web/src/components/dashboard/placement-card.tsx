import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #18 Placement card and queue. */
export function PlacementCard(props: DashboardProps) {
  return <div hidden data-placeholder="PlacementCard" data-jobs={props.snapshot.jobs.length} />;
}

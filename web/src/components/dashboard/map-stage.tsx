import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #16 MapStage. */
export function MapStage(props: DashboardProps) {
  return <div hidden data-placeholder="MapStage" data-jobs={props.snapshot.jobs.length} />;
}

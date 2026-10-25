import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #17 Disruption cards. */
export function DisruptionCards(props: DashboardProps) {
  return <div hidden data-placeholder="DisruptionCards" data-jobs={props.snapshot.jobs.length} />;
}

import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #18 live call card. */
export function CallCard(props: DashboardProps) {
  return <div hidden data-placeholder="CallCard" data-jobs={props.snapshot.jobs.length} />;
}

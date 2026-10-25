import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #17 top bar. */
export function TopBar(props: DashboardProps) {
  return <div hidden data-placeholder="TopBar" data-jobs={props.snapshot.jobs.length} />;
}

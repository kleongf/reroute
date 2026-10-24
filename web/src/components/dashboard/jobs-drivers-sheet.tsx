import type { DashboardProps } from './types.ts';

/** Placeholder: implemented in #19 Jobs/Drivers sheet. */
export function JobsDriversSheet(props: DashboardProps) {
  return <div hidden data-placeholder="JobsDriversSheet" data-jobs={props.snapshot.jobs.length} />;
}

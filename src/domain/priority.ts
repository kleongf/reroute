import type { Job, Placement } from './types.ts';

const tierRank = { high: 0, normal: 1 } as const;

/** Placement Queue order: tier, then the Job's deadline, then queued time. */
export function comparePriority(
  a: Placement,
  b: Placement,
  jobs: readonly Pick<Job, 'id' | 'deadline'>[],
): number {
  const deadlineOf = (jobId: string) => jobs.find((j) => j.id === jobId)?.deadline ?? '';
  return (
    tierRank[a.tier] - tierRank[b.tier] ||
    deadlineOf(a.jobId).localeCompare(deadlineOf(b.jobId)) ||
    a.queuedAt.localeCompare(b.queuedAt)
  );
}

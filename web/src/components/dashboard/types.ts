import type { StateSnapshot } from '@backend/domain/types.ts';
import type { Transcripts } from '@/lib/transcript.ts';

/** What every dashboard region receives from the root. */
export interface DashboardProps {
  snapshot: StateSnapshot;
  transcripts: Transcripts;
}

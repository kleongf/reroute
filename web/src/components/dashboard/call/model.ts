import type { DriverId, StateSnapshot } from '@backend/domain/types.ts';
import type { TranscriptLine, Transcripts } from '@/lib/transcript.ts';
import { currentOffer, driverName, jobOf, runningPlacement } from '../placement/model.ts';

export interface CallView {
  /** true = an Offer or check call in progress; false = the last call that ended. */
  live: boolean;
  title: string;
  sub: string;
  driverId: DriverId | null;
  callId: string | null;
  simulated: boolean;
}

/** The call the card shows: the current Offer, else a check call, else the last call. */
export function currentCall(s: StateSnapshot, transcripts: Transcripts): CallView | null {
  const running = runningPlacement(s);
  const pending = currentOffer(s);
  if (running && pending) {
    return {
      live: true,
      title: `Offer to ${driverName(s, pending.driverId)}`,
      sub: `${running.jobId} ${jobOf(s, running.jobId)?.label ?? ''}`,
      driverId: pending.driverId,
      callId: pending.callId,
      simulated: pending.simulated,
    };
  }
  const risk = s.jobs.find((j) => j.status === 'at_risk');
  if (risk) {
    return {
      live: true,
      title: `Check call with ${driverName(s, risk.driverId)}`,
      sub: `${risk.id} At Risk`,
      driverId: risk.driverId,
      callId: null,
      simulated: false,
    };
  }
  const lastId = [...transcripts.keys()].at(-1);
  const lastLine = lastId === undefined ? undefined : transcripts.get(lastId)?.[0];
  if (lastId !== undefined && lastLine) {
    return {
      live: false,
      title: `Last call: ${driverName(s, lastLine.driverId)}`,
      sub: lastLine.kind.replace('_', ' '),
      driverId: lastLine.driverId,
      callId: lastId,
      simulated: false,
    };
  }
  return null;
}

/** Lines for the call: by Retell call ID when known, else the Driver's latest call. */
export function linesFor(
  transcripts: Transcripts,
  callId: string | null,
  driverId: DriverId | null,
): readonly TranscriptLine[] {
  if (callId !== null) {
    const byId = transcripts.get(callId);
    if (byId) return byId;
  }
  const id = [...transcripts.keys()]
    .reverse()
    .find((k) => transcripts.get(k)?.[0]?.driverId === driverId);
  return id === undefined ? [] : (transcripts.get(id) ?? []);
}

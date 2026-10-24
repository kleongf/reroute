import { useEffect, useState } from 'react';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { addTranscriptLine, emptyTranscripts, type Transcripts } from '@/lib/transcript.ts';

export type FeedStatus = 'connecting' | 'connected' | 'reconnecting';

export interface LiveFeed {
  /** Latest `state` event; null until the first one arrives. */
  snapshot: StateSnapshot | null;
  status: FeedStatus;
  heartbeats: number;
  /** callId → lines, from `transcript` events. */
  transcripts: Transcripts;
}

/** One EventSource on /events for the whole app; call it once near the root. */
export function useSnapshot(): LiveFeed {
  const [feed, setFeed] = useState<LiveFeed>({
    snapshot: null,
    status: 'connecting',
    heartbeats: 0,
    transcripts: emptyTranscripts,
  });

  useEffect(() => {
    const source = new EventSource('/events');
    const on = (event: string, handle: (data: unknown) => (f: LiveFeed) => LiveFeed) => {
      source.addEventListener(event, (e: MessageEvent<string>) => {
        setFeed(handle(JSON.parse(e.data) as unknown));
      });
    };
    source.addEventListener('open', () => {
      setFeed((f) => ({ ...f, status: 'connected' }));
    });
    source.addEventListener('error', () => {
      setFeed((f) => ({ ...f, status: 'reconnecting' }));
    });
    on('state', (data) => (f) => ({ ...f, snapshot: data as StateSnapshot }));
    on('heartbeat', () => (f) => ({ ...f, heartbeats: f.heartbeats + 1 }));
    on('transcript', (data) => (f) => ({
      ...f,
      transcripts: addTranscriptLine(
        f.transcripts,
        data as Parameters<typeof addTranscriptLine>[1],
      ),
    }));
    return () => {
      source.close();
    };
  }, []);

  return feed;
}

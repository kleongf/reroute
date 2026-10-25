import { useEffect, useRef } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils.ts';
import { currentCall, linesFor } from './call/model.ts';
import { driverName } from './placement/model.ts';
import type { DashboardProps } from './types.ts';

/** The current Offer or check call, with its live transcript (auto-scrolls to the newest line). */
export function CallCard({ snapshot: s, transcripts }: DashboardProps) {
  const call = currentCall(s, transcripts);
  const lines = call && !call.simulated ? linesFor(transcripts, call.callId, call.driverId) : [];
  const scrollRef = useRef<HTMLDivElement>(null);
  const newest = lines.at(-1);

  useEffect(() => {
    const viewport = scrollRef.current?.querySelector('[data-slot=scroll-area-viewport]');
    if (viewport) viewport.scrollTop = viewport.scrollHeight;
  }, [lines.length, newest?.text]);

  return (
    <Card size="sm" data-testid="call-card" aria-label="Live call" role="region">
      {!call ? (
        <CardContent>
          <p className="text-muted-foreground">No call in progress</p>
        </CardContent>
      ) : (
        <>
          <CardHeader className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className={cn(
                'size-2.5 rounded-full',
                call.live ? 'animate-pulse bg-red-500' : 'bg-muted-foreground/40',
              )}
            />
            <b data-testid="call-title">{call.title}</b>
            <span className="text-muted-foreground">{call.sub}</span>
            {call.simulated && (
              <Badge variant="secondary" className="bg-amber-100 text-amber-900">
                simulated Offer
              </Badge>
            )}
          </CardHeader>
          <CardContent>
            <ScrollArea ref={scrollRef} className="h-36" data-testid="transcript">
              <div className="flex flex-col gap-1 pr-3">
                {call.simulated ? (
                  <p className="text-muted-foreground">
                    No phone call: the simulated Driver replies by script.
                  </p>
                ) : lines.length === 0 ? (
                  <p className="text-muted-foreground">
                    {call.live ? 'Calling…' : 'No transcript'}
                  </p>
                ) : (
                  lines.map((l, i) => (
                    <p key={l.utteranceId ?? `${String(i)}-${l.at}`} data-role={l.role}>
                      <b className={l.role === 'agent' ? 'text-sky-700' : 'text-emerald-700'}>
                        {l.role === 'agent' ? 'Reroute: ' : `${driverName(s, l.driverId)}: `}
                      </b>
                      {l.text}
                    </p>
                  ))
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </>
      )}
    </Card>
  );
}

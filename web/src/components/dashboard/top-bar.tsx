import { useCallback, type MouseEvent } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Toaster } from '@/components/ui/sonner';
import type { DisruptionSummary } from '@backend/domain/types.ts';
import { useNewlyFixed, useServerNow } from './disruptions/hooks.ts';
import {
  banner,
  disruptionModel,
  mmss,
  timerDisruption,
  type BannerTone,
} from './disruptions/model.ts';
import { TrafficMenu } from './traffic-menu.tsx';
import type { DashboardProps } from './types.ts';
import { OPEN_URGENT_JOB_EVENT } from './urgent-job-dialog.tsx';
import './disruptions/disruptions.css';

/**
 * Window events the top bar dispatches to open dialogs it does not own (#19 listens):
 * the Urgent Job Dialog and the Inject traffic DropdownMenu. `detail.anchor` is the
 * trigger button, so a popover can position against it.
 */

export interface OpenEventDetail {
  anchor: HTMLElement;
}

function dispatchOpen(name: string) {
  return (e: MouseEvent<HTMLButtonElement>) => {
    window.dispatchEvent(
      new CustomEvent<OpenEventDetail>(name, { detail: { anchor: e.currentTarget } }),
    );
  };
}

const TONE_CLASS: Record<BannerTone, string> = {
  ok: 'bg-slate-600',
  risk: 'bg-amber-700',
  late: 'bg-red-600 reroute-pulse',
  fixed: 'bg-green-700',
  esc: 'bg-violet-600',
};

/** Banner (risk → late → fixed), Disruption → Placed timer, tally, and demo actions. */
export function TopBar({ snapshot }: DashboardProps) {
  const serverNow = useServerNow(snapshot);
  const onFixed = useCallback((d: DisruptionSummary) => {
    toast.success(`${d.jobId} fixed in ${mmss(d.secondsToFix ?? 0)}`, {
      id: `fixed-${d.placementId}`,
    });
  }, []);
  const isCelebrating = useNewlyFixed(snapshot, serverNow, onFixed);

  const m = disruptionModel(snapshot);
  const b = banner(m);
  const timed = timerDisruption(m);
  const timerEnd = timed?.endedAt ? Date.parse(timed.endedAt) : serverNow;
  const t = snapshot.disruptionTally;

  return (
    <Card className="flex flex-row items-center gap-4 px-3 py-2 shadow-lg">
      <Toaster position="top-center" offset={{ top: 84 }} richColors />
      <span className="text-xl font-semibold tracking-wide" aria-hidden>
        Reroute
      </span>
      <div
        data-testid="banner"
        data-tone={b.tone}
        className={cn(
          'min-w-0 flex-1 truncate rounded-md px-3 py-1.5 text-xl font-extrabold text-white transition-colors duration-400',
          TONE_CLASS[b.tone],
          b.placementId !== null && isCelebrating(b.placementId) && 'reroute-celebrate',
        )}
      >
        {b.text}
      </div>
      <div className="grid text-right leading-tight">
        <small className="text-xs text-muted-foreground">Disruption → Placed</small>
        <span
          data-testid="fix-timer"
          data-state={timed?.status ?? 'idle'}
          className="text-xl font-bold tabular-nums"
        >
          {timed ? mmss((timerEnd - Date.parse(timed.reportedAt)) / 1000) : '–:––'}
        </span>
      </div>
      <div data-testid="tally" className="text-sm whitespace-nowrap">
        Disruptions fixed: <b data-testid="tally-fixed">{t.fixed}</b> · avg time to fix{' '}
        <b data-testid="tally-avg">
          {t.averageSecondsToFix === null ? '–' : mmss(t.averageSecondsToFix)}
        </b>
        {t.escalated > 0 && <span className="text-violet-700"> · {t.escalated} Escalated</span>}
      </div>
      <div className="flex items-center gap-2">
        <Button
          data-testid="reset"
          variant="outline"
          onClick={() => {
            void fetch('/api/reset', { method: 'POST' });
          }}
        >
          Reset demo
        </Button>
        <TrafficMenu snapshot={snapshot} />
        <Button data-testid="urgent-toggle" onClick={dispatchOpen(OPEN_URGENT_JOB_EVENT)}>
          + Urgent Job
        </Button>
      </div>
    </Card>
  );
}

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useSnapshot, type FeedStatus } from '@/hooks/use-snapshot.ts';

const STATUS_VARIANT = {
  connecting: 'secondary',
  connected: 'default',
  reconnecting: 'destructive',
} as const satisfies Record<FeedStatus, 'default' | 'secondary' | 'destructive'>;

export function App() {
  const { snapshot, status, heartbeats } = useSnapshot();
  const [resetting, setResetting] = useState(false);

  const reset = async () => {
    setResetting(true);
    try {
      await fetch('/api/reset', { method: 'POST' });
    } finally {
      setResetting(false);
    }
  };

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6" data-testid="dashboard">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Reroute</h1>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <span>Live feed</span>
          <Badge data-testid="sse-status" data-state={status} variant={STATUS_VARIANT[status]}>
            {status}
          </Badge>
          <span data-testid="sse-heartbeats">{heartbeats}</span>
        </div>
      </header>
      <Card className="max-w-xs">
        <CardHeader>
          <CardTitle>Jobs</CardTitle>
          <CardDescription>From the live snapshot</CardDescription>
        </CardHeader>
        <CardContent className="flex items-end justify-between">
          <span className="text-4xl font-semibold tabular-nums" data-testid="job-count">
            {snapshot === null ? '—' : snapshot.jobs.length}
          </span>
          <Button
            variant="outline"
            data-testid="reset"
            disabled={resetting}
            onClick={() => void reset()}
          >
            Reset demo
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

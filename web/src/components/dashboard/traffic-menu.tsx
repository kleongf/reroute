import { useEffect, useState } from 'react';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/** Window event (no detail) the top bar dispatches to open this menu. */
export const OPEN_TRAFFIC_MENU_EVENT = 'reroute:open-traffic-menu';

/** Inject a simulated traffic event; an active one stays listed but disabled. */
export function TrafficMenu({ snapshot }: { snapshot: StateSnapshot }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
    };
    window.addEventListener(OPEN_TRAFFIC_MENU_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_TRAFFIC_MENU_EVENT, onOpen);
    };
  }, []);

  const active = new Set(snapshot.activeTraffic.map((t) => t.id));

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" data-testid="traffic-menu-trigger">
          Inject traffic
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent data-testid="traffic-buttons" align="center" className="w-64">
        <DropdownMenuLabel>Inject traffic · simulated traffic</DropdownMenuLabel>
        {snapshot.trafficEvents.length === 0 && (
          <DropdownMenuItem disabled>No traffic events</DropdownMenuItem>
        )}
        {snapshot.trafficEvents.map((t) => (
          <DropdownMenuItem
            key={t.id}
            data-testid={`inject-traffic-${t.id}`}
            disabled={active.has(t.id)}
            onSelect={() => {
              void fetch(`/api/traffic/${encodeURIComponent(t.id)}`, { method: 'POST' });
            }}
          >
            {t.label}
            {active.has(t.id) && <span className="ml-auto text-xs">active</span>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

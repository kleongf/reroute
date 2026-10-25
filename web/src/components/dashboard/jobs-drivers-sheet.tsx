import { useState } from 'react';
import type { Driver, JobStatus } from '@backend/domain/types.ts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { DashboardProps } from './types.ts';
import { UrgentJobDialog } from './urgent-job-dialog.tsx';

const DEMO_TIME_ZONE = 'America/Los_Angeles';

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: DEMO_TIME_ZONE,
  });

const STATUS_LABEL: Record<JobStatus, string> = {
  assigned: 'Assigned',
  at_risk: 'At Risk',
  late: 'Late',
  unassigned: 'Unassigned',
  escalated: 'Escalated',
  done: 'Done',
};

const STATUS_VARIANT: Record<JobStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  assigned: 'secondary',
  at_risk: 'outline',
  late: 'destructive',
  unassigned: 'outline',
  escalated: 'destructive',
  done: 'secondary',
};

/** How Reroute reaches a Driver, with the provenance spelled out on hover. */
function PhoneCell({ driver }: { driver: Driver }) {
  const [label, why] = driver.simulated
    ? ['simulated', 'simulated Offer: resolves without a call']
    : driver.phone
      ? ['real phone', 'Reroute calls this Driver through Retell']
      : ['none', 'No phone: never offered a Job by call'];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{why}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Jobs/Drivers drawer as a bottom Sheet, plus the Dispatcher actions that live with it:
 * the Urgent Job dialog and the traffic menu (opened from the top bar via window events).
 */
export function JobsDriversSheet({ snapshot }: DashboardProps) {
  const [open, setOpen] = useState(false);
  const driverName = (id: string | null) =>
    id === null ? '—' : (snapshot.drivers.find((d) => d.id === id)?.name ?? id);

  return (
    <TooltipProvider>
      <div className="absolute bottom-12 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-background/90 p-1 shadow">
        <Button
          variant="outline"
          size="sm"
          data-testid="drawer-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          Jobs · Drivers
        </Button>
      </div>
      <UrgentJobDialog />
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="bottom" className="max-h-[60vh] overflow-y-auto" data-testid="drawer">
          <SheetHeader>
            <SheetTitle>Jobs · Drivers</SheetTitle>
            <SheetDescription>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help underline decoration-dotted underline-offset-2">
                    simulated positions
                  </span>
                </TooltipTrigger>
                <TooltipContent>Driver positions are simulated, not live GPS</TooltipContent>
              </Tooltip>
              {' · times in Pacific'}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-6 px-4 pb-4 lg:grid-cols-[3fr_2fr]">
            <Table data-testid="jobs-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Job</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Parcels</TableHead>
                  <TableHead>Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.jobs.map((j) => (
                  <TableRow key={j.id} data-status={j.status}>
                    <TableCell>
                      <span className="font-medium">{j.id}</span> {j.label}
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge variant={STATUS_VARIANT[j.status]}>{STATUS_LABEL[j.status]}</Badge>
                      {j.note ? ` ${j.note}` : ''}
                    </TableCell>
                    <TableCell>{driverName(j.driverId)}</TableCell>
                    <TableCell>{j.parcels}</TableCell>
                    <TableCell>{clockTime(j.deadline)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <Table data-testid="drivers-table">
              <TableHeader>
                <TableRow>
                  <TableHead>Driver</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Free slots</TableHead>
                  <TableHead>Available</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.drivers.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.name}</TableCell>
                    <TableCell>
                      <PhoneCell driver={d} />
                    </TableCell>
                    <TableCell>{d.capacity}</TableCell>
                    <TableCell>
                      {clockTime(d.availableFrom)}–{clockTime(d.availableUntil)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </SheetContent>
      </Sheet>
    </TooltipProvider>
  );
}

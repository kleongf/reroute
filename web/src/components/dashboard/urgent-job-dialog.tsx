import { useEffect, useState, type SyntheticEvent } from 'react';
import {
  formatUrgentJobIssues,
  urgentJobSchema,
  type UrgentJobBody,
} from '@backend/placement/urgent-job-schema.ts';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** Window event (no detail) the top bar dispatches to open this dialog. */
export const OPEN_URGENT_JOB_EVENT = 'reroute:open-urgent-job';

/** Stage places (docs/plan.md) get their real coordinates; other names use the server default. */
const KNOWN_PLACES: Record<string, { lat: number; lng: number }> = {
  'sf general lab': { lat: 37.7557, lng: -122.4048 },
  'mission bay clinic': { lat: 37.7684, lng: -122.3912 },
};

const placeFor = (name: string): UrgentJobBody['pickup'] => {
  const trimmed = name.trim();
  return { name: trimmed, ...KNOWN_PLACES[trimmed.toLowerCase()] };
};

type Tier = UrgentJobBody['tier'];

interface Fields {
  label: string;
  pickup: string;
  dropoff: string;
  parcels: string;
  deadlineOffsetMin: string;
  tier: Tier;
}

/** Prefilled with the stage Urgent Job from docs/plan.md, so the presenter only confirms it. */
const STAGE_JOB: Fields = {
  label: 'Hospital samples',
  pickup: 'SF General Lab',
  dropoff: 'Mission Bay Clinic',
  parcels: '2',
  deadlineOffsetMin: '90',
  tier: 'high',
};

const toBody = (f: Fields): UrgentJobBody => ({
  label: f.label.trim(),
  pickup: placeFor(f.pickup),
  dropoff: placeFor(f.dropoff),
  parcels: Number(f.parcels),
  deadlineOffsetMin: Number(f.deadlineOffsetMin),
  tier: f.tier,
});

/** The Dispatcher's Urgent Job form: validated with the backend's schema, then `POST /api/jobs`. */
export function UrgentJobDialog() {
  const [open, setOpen] = useState(false);
  const [fields, setFields] = useState<Fields>(STAGE_JOB);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
    };
    window.addEventListener(OPEN_URGENT_JOB_EVENT, onOpen);
    return () => {
      window.removeEventListener(OPEN_URGENT_JOB_EVENT, onOpen);
    };
  }, []);

  const set = (key: keyof Fields) => (value: string) => {
    setFields((f) => ({ ...f, [key]: value }));
  };

  const onSubmit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = toBody(fields);
    const parsed = urgentJobSchema.safeParse(body);
    if (!parsed.success) {
      setError(formatUrgentJobIssues(parsed.error));
      return;
    }
    setError('');
    setSubmitting(true);
    void fetch('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        if (res.ok) {
          setFields(STAGE_JOB);
          setOpen(false);
          return;
        }
        const raw: unknown = await res.json().catch(() => ({}));
        const message = (raw as { message?: unknown }).message;
        setError(
          typeof message === 'string'
            ? message
            : `Could not add Urgent Job (${String(res.status)})`,
        );
      })
      .catch(() => {
        setError('Could not reach the server');
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const text = (key: Exclude<keyof Fields, 'tier'>, label: string, placeholder?: string) => (
    <div className="grid gap-1.5">
      <Label htmlFor={`urgent-${key}`}>{label}</Label>
      <Input
        id={`urgent-${key}`}
        name={key}
        value={fields[key]}
        placeholder={placeholder}
        inputMode={placeholder === undefined ? 'numeric' : undefined}
        type={placeholder === undefined ? 'number' : 'text'}
        onChange={(e) => {
          set(key)(e.target.value);
        }}
      />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError('');
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Urgent Job</DialogTitle>
          <DialogDescription>Reroute queues a Placement for it.</DialogDescription>
        </DialogHeader>
        <form
          id="urgent-form"
          data-testid="urgent-form"
          noValidate
          className="grid gap-3"
          onSubmit={onSubmit}
        >
          {text('label', 'Label', 'Hospital samples')}
          <div className="grid grid-cols-2 gap-3">
            {text('pickup', 'Pickup', 'SF General Lab')}
            {text('dropoff', 'Drop-off', 'Mission Bay Clinic')}
          </div>
          <div className="grid grid-cols-3 gap-3">
            {text('parcels', 'Parcels')}
            {text('deadlineOffsetMin', 'Due in (min)')}
            <div className="grid gap-1.5">
              <Label htmlFor="urgent-tier">Tier</Label>
              <Select
                value={fields.tier}
                onValueChange={(v) => {
                  set('tier')(v);
                }}
              >
                <SelectTrigger id="urgent-tier" className="w-full" data-testid="urgent-tier">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p
            id="urgent-error"
            data-testid="urgent-error"
            role="alert"
            className="min-h-5 text-sm text-destructive"
          >
            {error}
          </p>
          <DialogFooter className="items-center sm:justify-between">
            <p className="text-xs text-muted-foreground">
              Urgent Job ETAs: fixture ETA (straight line at city speed)
            </p>
            <Button type="submit" disabled={submitting}>
              Add Urgent Job
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import type { Hono } from 'hono';
import { z } from 'zod';
import type { Clock } from '../domain/clock.ts';
import { parseSpokenTime, spokenTime } from '../domain/time.ts';
import type { Engine, StatusUpdate } from '../placement/engine.ts';
import type { Store } from '../store/store.ts';

/** Retell custom-function payload. Loose for now; the real schema lands in #6. */
const toolCallSchema = z.looseObject({
  name: z.string().optional(),
  call: z.looseObject({
    call_id: z.string().min(1),
    from_number: z.string().optional(),
    retell_llm_dynamic_variables: z.record(z.string(), z.string()).optional(),
  }),
  args: z.looseObject({}).default({}),
});

const reportDisruptionArgs = z.object({
  driver_id: z.string().min(1).optional(),
  job_id: z.string().min(1),
  reason: z.string().min(1),
  collected: z.boolean(),
});

const acceptOfferArgs = z.object({ offer_id: z.string().min(1).optional() });

/** Optional status fields a Driver can give in `report_status` or alongside a decline. */
const statusArgs = {
  capacity: z.number().int().min(0).optional(),
  available_from: z.string().min(1).optional(),
  available_until: z.string().min(1).optional(),
};
const declineOfferArgs = z.object({
  offer_id: z.string().min(1).optional(),
  reason: z.string().optional(),
  ...statusArgs,
});
const reportStatusArgs = z.object(statusArgs);

type ToolCall = z.infer<typeof toolCallSchema>;
interface ToolOutcome {
  status: 200 | 400;
  result: string;
}

const invalid = (result: string): ToolOutcome => ({ status: 400, result });

const UNKNOWN_CALLER =
  "Sorry, I don't recognise this phone number. Please call from the phone the Dispatcher has on file.";

/** Status fields → StatusUpdate; null if a time can't be understood. */
function toStatusUpdate(
  args: {
    capacity?: number | undefined;
    available_from?: string | undefined;
    available_until?: string | undefined;
  },
  now: Date,
): StatusUpdate | null {
  const update: StatusUpdate = {};
  if (args.capacity !== undefined) update.capacity = args.capacity;
  for (const [key, field] of [
    ['available_from', 'availableFrom'],
    ['available_until', 'availableUntil'],
  ] as const) {
    const text = args[key];
    if (text === undefined) continue;
    const iso = parseSpokenTime(text, now);
    if (!iso) return null;
    update[field] = iso;
  }
  return update;
}

/** Registers `POST /tools/:name`: Retell tool calls answered with a speakable `result`. */
export function registerTools(
  app: Hono,
  deps: { engine: Engine; store: Store; clock: Clock },
): void {
  /** Inbound callers by `call.from_number`; outbound calls carry `driver_id` in vars. */
  const callerId = (body: ToolCall): string | undefined =>
    deps.store.get().drivers.find((d) => d.phone && d.phone === body.call.from_number)?.id ??
    body.call.retell_llm_dynamic_variables?.['driver_id'];

  const handlers: Record<string, (call: ToolCall) => Promise<ToolOutcome>> = {
    async report_disruption(body) {
      const args = reportDisruptionArgs.safeParse(body.args);
      if (!args.success) {
        return invalid("Sorry, I need the job, the reason, and whether you've collected it.");
      }
      const driverId =
        args.data.driver_id ??
        body.call.retell_llm_dynamic_variables?.['driver_id'] ??
        deps.store.get().drivers.find((d) => d.phone && d.phone === body.call.from_number)?.id;
      if (!driverId) return invalid("Sorry, I don't recognise this phone number.");
      const r = await deps.engine.reportDisruption(
        driverId,
        args.data.job_id,
        args.data.reason,
        args.data.collected,
      );
      return { status: r.ok ? 200 : 400, result: r.message };
    },

    async accept_offer(body) {
      const args = acceptOfferArgs.safeParse(body.args);
      const offerId =
        (args.success ? args.data.offer_id : undefined) ??
        body.call.retell_llm_dynamic_variables?.['offer_id'];
      if (!offerId) return invalid("Sorry, I can't tell which offer you're accepting.");
      const r = await deps.engine.acceptOffer(offerId);
      return { status: r.ok ? 200 : 400, result: r.message };
    },

    async decline_offer(body) {
      const args = declineOfferArgs.safeParse(body.args);
      if (!args.success) return invalid("Sorry, I didn't catch that. Can you say it again?");
      const offerId = args.data.offer_id ?? body.call.retell_llm_dynamic_variables?.['offer_id'];
      if (!offerId) return invalid("Sorry, I can't tell which offer you're declining.");
      const update = toStatusUpdate(args.data, deps.clock.now());
      if (!update) return invalid("Sorry, what time was that? Say it like 'four PM'.");
      const r = await deps.engine.declineOffer(offerId, args.data.reason ?? null, update);
      return { status: r.ok ? 200 : 400, result: r.message };
    },

    async report_status(body) {
      const driverId = callerId(body);
      if (!driverId) return invalid(UNKNOWN_CALLER);
      const args = reportStatusArgs.safeParse(body.args);
      if (!args.success) return invalid("Sorry, I didn't catch what changed.");
      const update = toStatusUpdate(args.data, deps.clock.now());
      if (!update) return invalid("Sorry, what time was that? Say it like 'four PM'.");
      const r = await deps.engine.reportStatus(driverId, update);
      return { status: r.ok ? 200 : 400, result: r.message };
    },

    get_my_jobs(body) {
      const driverId = callerId(body);
      if (!driverId) return Promise.resolve(invalid(UNKNOWN_CALLER));
      const jobs = deps.store
        .get()
        .jobs.filter((j) => j.driverId === driverId && j.status !== 'done');
      if (jobs.length === 0) {
        return Promise.resolve({ status: 200, result: "You don't have any jobs right now." });
      }
      const list = jobs
        .map(
          (j) =>
            `job ${j.id}, the ${j.label}, ${String(j.parcels)} ${j.parcels === 1 ? 'parcel' : 'parcels'}, due by ${spokenTime(j.deadline)}`,
        )
        .join('; ');
      const count = jobs.length === 1 ? 'one job' : `${String(jobs.length)} jobs`;
      return Promise.resolve({ status: 200, result: `You have ${count}: ${list}.` });
    },
  };

  app.post('/tools/:name', async (c) => {
    const handler = handlers[c.req.param('name')];
    if (!handler) return c.json({ result: "Sorry, I can't do that." }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ result: 'Sorry, something went wrong on my side.' }, 400);
    }
    const parsed = toolCallSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ result: 'Sorry, something went wrong on my side.' }, 400);
    }
    const { status, result } = await handler(parsed.data);
    return c.json({ result }, status);
  });
}

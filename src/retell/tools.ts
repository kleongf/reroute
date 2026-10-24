import type { Hono } from 'hono';
import { z } from 'zod';
import type { Engine } from '../placement/engine.ts';
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

const confirmOnTrackArgs = z.object({
  driver_id: z.string().min(1).optional(),
  job_id: z.string().min(1).optional(),
});

const acceptOfferArgs = z.object({ offer_id: z.string().min(1).optional() });

type ToolCall = z.infer<typeof toolCallSchema>;
interface ToolOutcome {
  status: 200 | 400;
  result: string;
}

const invalid = (result: string): ToolOutcome => ({ status: 400, result });

/** Registers `POST /tools/:name`: Retell tool calls answered with a speakable `result`. */
export function registerTools(app: Hono, deps: { engine: Engine; store: Store }): void {
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

    async confirm_on_track(body) {
      const args = confirmOnTrackArgs.safeParse(body.args);
      const vars = body.call.retell_llm_dynamic_variables;
      const driverId =
        (args.success ? args.data.driver_id : undefined) ??
        vars?.['driver_id'] ??
        deps.store.get().drivers.find((d) => d.phone && d.phone === body.call.from_number)?.id;
      if (!driverId) return invalid("Sorry, I don't recognise this phone number.");
      const jobId = (args.success ? args.data.job_id : undefined) ?? vars?.['job_id'];
      if (!jobId) return invalid('Sorry, which job are you on track for?');
      const r = await deps.engine.confirmOnTrack(driverId, jobId);
      return { status: r.ok ? 200 : 400, result: r.message };
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

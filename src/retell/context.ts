import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import type { Store } from '../store/store.ts';
import { retellToolSchema } from './schemas.ts';

const contextArgs = z.looseObject({
  driver_id: z.string().optional(),
  job_id: z.string().optional(),
  offer_id: z.string().optional(),
});

/** The LLM's arguments can never override the signed call's Driver/Job/Offer identity. */
export function retellCallContext(store: Store): MiddlewareHandler {
  return async (c, next) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ result: 'Invalid call payload.' }, 400);
    }
    const parsed = retellToolSchema.safeParse(raw);
    if (!parsed.success) return c.json({ result: 'Invalid call payload.' }, 400);
    const { call, args, name } = parsed.data;
    const toolName = c.req.param('name');
    if (name && name !== toolName) return c.json({ result: 'Call tool does not match.' }, 400);
    const identifiers = contextArgs.safeParse(args);
    if (!identifiers.success) return c.json({ result: 'Invalid call context.' }, 400);
    const vars = call.retell_llm_dynamic_variables ?? {};
    const w = store.get();
    if (vars['demo_reset_at'] && vars['demo_reset_at'] !== w.resetAt)
      return c.json({ result: 'This call belongs to a previous demo.' }, 409);
    const outbound = call.direction === 'outbound' || Boolean(vars['driver_id']);
    const driver = outbound
      ? w.drivers.find(
          (d) =>
            d.id === vars['driver_id'] && !d.simulated && d.phone && d.phone === call.to_number,
        )
      : w.drivers.find((d) => d.phone && d.phone === call.from_number);
    if (!driver || (identifiers.data.driver_id && identifiers.data.driver_id !== driver.id))
      return c.json({ result: "Sorry, I don't recognise this Driver's call." }, 403);
    if (
      outbound &&
      vars['job_id'] &&
      identifiers.data.job_id &&
      identifiers.data.job_id !== vars['job_id']
    )
      return c.json({ result: 'The Job does not match this call.' }, 403);
    if (toolName === 'accept_offer' || toolName === 'decline_offer') {
      const offerId = vars['offer_id'];
      const offer = w.offers.find((o) => o.id === offerId);
      const placement = offer && w.placements.find((p) => p.id === offer.placementId);
      // The local outbox ID is sent as a signed dynamic variable before Retell assigns call_id.
      const matchesCall =
        offer?.callId === call.call_id ||
        (vars['reroute_call_id'] && offer?.callId === vars['reroute_call_id']);
      if (
        !offer ||
        !placement ||
        offer.driverId !== driver.id ||
        placement.jobId !== vars['job_id'] ||
        !matchesCall ||
        (identifiers.data.offer_id && identifiers.data.offer_id !== offer.id)
      )
        return c.json({ result: 'This Offer does not belong to this call.' }, 403);
    }
    await next();
    return undefined;
  };
}

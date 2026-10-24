import { z } from 'zod';

/**
 * Minimal envelopes for tracer capture, per Retell's custom-function and webhook docs.
 * Unknown fields are kept at every level for actual payload discovery.
 * These schemas validate shape, not origin: signature verification is still required
 * before these requests can authorize any Placement or Offer changes.
 */
const retellCallSchema = z.looseObject({
  call_id: z.string().min(1),
});

export const retellWebhookSchema = z.looseObject({
  event: z.string().min(1),
  call: retellCallSchema,
});

export const tracerPingSchema = z.looseObject({
  name: z.literal('tracer_ping'),
  call: retellCallSchema,
  args: z.looseObject({
    message: z.string(),
  }),
});

export type RetellWebhook = z.infer<typeof retellWebhookSchema>;

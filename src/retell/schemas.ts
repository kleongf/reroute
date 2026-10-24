import { z } from 'zod';

/**
 * Minimal envelope for Retell webhook deliveries. Placeholder: confirm field names against
 * the Retell docs before relying on anything beyond `event` and `call.call_id`.
 * Unknown fields are kept (looseObject) so the raw payload can be logged for inspection.
 * TODO: verify the Retell signature header before trusting the body.
 */
export const retellWebhookSchema = z.object({
  event: z.string().min(1),
  call: z.looseObject({
    call_id: z.string().min(1),
  }),
});

export type RetellWebhook = z.infer<typeof retellWebhookSchema>;

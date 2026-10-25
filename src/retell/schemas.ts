import { z } from 'zod';

const utteranceSchema = z.looseObject({
  role: z.enum(['agent', 'user']),
  content: z.string(),
  words: z
    .array(z.looseObject({ start: z.number(), end: z.number(), word: z.string() }))
    .optional(),
});
const transcriptEntrySchema = z.union([
  utteranceSchema,
  z.looseObject({
    role: z.enum(['tool_call_invocation', 'tool_call_result']),
    tool_call_id: z.string().optional(),
  }),
]);

/** Extra Retell metadata is retained; every consumed field is validated. */
export const retellCallSchema = z.looseObject({
  call_id: z.string().min(1),
  from_number: z.string().optional(),
  to_number: z.string().optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  retell_llm_dynamic_variables: z.record(z.string(), z.string()).optional(),
  transcript_object: z.array(utteranceSchema).optional(),
  transcript_with_tool_calls: z.array(transcriptEntrySchema).optional(),
});

export const retellWebhookSchema = z.looseObject({
  event: z.string().min(1),
  call: retellCallSchema,
  transcript_with_tool_calls: z.array(transcriptEntrySchema).optional(),
});
export const retellToolSchema = z.looseObject({
  name: z.string().min(1).optional(),
  call: retellCallSchema,
  args: z.record(z.string(), z.unknown()).default({}),
});
/** Capture-only tool: no fleet Driver, Job, or Offer context is required. */
export const tracerPingSchema = z.looseObject({
  name: z.literal('tracer_ping'),
  call: z.looseObject({ call_id: z.string().min(1) }),
  args: z.looseObject({ message: z.string() }),
});
export type RetellCall = z.infer<typeof retellCallSchema>;
export type RetellWebhook = z.infer<typeof retellWebhookSchema>;

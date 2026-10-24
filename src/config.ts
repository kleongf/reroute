import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_PATH: z.string().min(1).default('reroute.db'),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
  VOICE_MODE: z.enum(['fake', 'retell']).default('fake'),
  RETELL_API_KEY: z.string().min(1).optional(),
  RETELL_FROM_NUMBER: z.string().optional(),
  RETELL_AGENT_ID: z.string().min(1).optional(),
  RETELL_AGENT_OFFER: z.string().min(1).optional(),
  RETELL_AGENT_AT_RISK_CHECK: z.string().min(1).optional(),
  RETELL_AGENT_RELEASE: z.string().min(1).optional(),
  RETELL_AGENT_ESCALATION: z.string().min(1).optional(),
  SIMULATED_OFFER_MS: z.coerce.number().int().min(0).default(4_000),
  /** osrm = refresh ETAs from the public OSRM demo server; off = fixture/straight-line only. */
  ROUTING: z.enum(['osrm', 'off']).default('off'),
  ROUTING_TIMEOUT_MS: z.coerce.number().int().positive().default(1_500),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  if (
    parsed.data.VOICE_MODE === 'retell' &&
    (!parsed.data.RETELL_API_KEY || !parsed.data.RETELL_FROM_NUMBER || !parsed.data.RETELL_AGENT_ID)
  ) {
    throw new Error(
      'VOICE_MODE=retell requires RETELL_API_KEY, RETELL_FROM_NUMBER, and RETELL_AGENT_ID.',
    );
  }
  return parsed.data;
}

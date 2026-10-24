import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  DATABASE_PATH: z.string().min(1).default('reroute.db'),
  HEARTBEAT_MS: z.coerce.number().int().positive().default(15_000),
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
  return parsed.data;
}

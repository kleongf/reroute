import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { Clock } from '../domain/clock.ts';

/** Retell's documented HMAC(raw body + timestamp), with a five-minute replay window. */
export function verifyRetellSignature(
  raw: string,
  key: string,
  signature: string | undefined,
  now: Date,
): boolean {
  const match = /^v=(\d+),d=([a-fA-F0-9]{64})$/.exec(signature ?? '');
  const timestamp = match?.[1];
  const digest = match?.[2];
  if (!timestamp || !digest || Math.abs(now.getTime() - Number(timestamp)) > 300_000) return false;
  const expected = createHmac('sha256', key)
    .update(raw + timestamp)
    .digest();
  return timingSafeEqual(expected, Buffer.from(digest, 'hex'));
}

export function retellAuthentication(key: string, clock: Clock): MiddlewareHandler {
  return async (c, next) => {
    const raw = await c.req.text();
    if (!verifyRetellSignature(raw, key, c.req.header('x-retell-signature'), clock.now())) {
      return c.json({ result: 'Unable to verify this call.' }, 401);
    }
    await next();
    return undefined;
  };
}

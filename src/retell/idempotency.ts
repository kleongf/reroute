import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { MiddlewareHandler } from 'hono';

/** Persists successful tool responses so Retell retries return the original spoken result. */
export function retellIdempotency(db: DatabaseSync): MiddlewareHandler {
  db.exec(
    'CREATE TABLE IF NOT EXISTS retell_tool_results (id TEXT PRIMARY KEY, status INTEGER NOT NULL, body TEXT NOT NULL)',
  );
  const pending = new Map<string, Promise<void>>();
  return async (c, next) => {
    const id = createHash('sha256')
      .update(c.req.path + (await c.req.text()))
      .digest('hex');
    const inFlight = pending.get(id);
    if (inFlight) await inFlight;
    const previous = db
      .prepare('SELECT body, status FROM retell_tool_results WHERE id = ?')
      .get(id);
    if (previous)
      return new Response(String(previous['body']), {
        status: Number(previous['status']),
        headers: { 'content-type': 'application/json' },
      });
    let finish: (() => void) | undefined;
    pending.set(
      id,
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    try {
      await next();
      if (c.res.ok)
        db.prepare(
          'INSERT OR IGNORE INTO retell_tool_results (id, status, body) VALUES (?, ?, ?)',
        ).run(id, c.res.status, await c.res.clone().text());
    } finally {
      pending.delete(id);
      finish?.();
    }
    return undefined;
  };
}

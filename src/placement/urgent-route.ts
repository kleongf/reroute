import type { Hono } from 'hono';
import type { Clock } from '../domain/clock.ts';
import { toSnapshot, type Store } from '../store/store.ts';
import type { Engine } from './engine.ts';
import { formatUrgentJobIssues, urgentJobSchema } from './urgent-job-schema.ts';

export { urgentJobSchema };

/** Registers `POST /api/jobs`: the Dispatcher adds an Urgent Job and queues its Placement. */
export function registerUrgentJobs(
  app: Hono,
  deps: { engine: Engine; store: Store; clock: Clock },
): void {
  app.post('/api/jobs', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json', message: 'Body must be JSON.' }, 400);
    }
    const parsed = urgentJobSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', message: formatUrgentJobIssues(parsed.error) }, 400);
    }
    const { tier, ...input } = parsed.data;
    const result = await deps.engine.addUrgentJob(input, tier);
    return c.json(
      { ...result, state: toSnapshot(deps.store.get(), deps.clock.now()) },
      result.ok ? 201 : 400,
    );
  });
}

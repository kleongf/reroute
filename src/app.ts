import type { DatabaseSync } from 'node:sqlite';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Clock } from './domain/clock.ts';
import type { Engine } from './placement/engine.ts';
import { registerUrgentJobs } from './placement/urgent-route.ts';
import { retellWebhookSchema } from './retell/schemas.ts';
import { registerTools } from './retell/tools.ts';
import { loadScenario, type PhoneBook, type Scenario } from './store/scenario.ts';
import { toSnapshot, type Store } from './store/store.ts';
import type { VoicePort } from './voice/port.ts';

export interface AppDeps {
  readonly db: DatabaseSync;
  readonly clock: Clock;
  readonly heartbeatMs: number;
  /** Directory holding the dashboard's static files. */
  readonly publicDir: string;
  readonly store: Store;
  readonly scenario: Scenario;
  readonly phones: PhoneBook;
  readonly voice: VoicePort;
  readonly engine: Engine;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const row = deps.db.prepare('SELECT 1 AS ok').get();
    const dbOk = row?.['ok'] === 1;
    return c.json(
      { status: dbOk ? 'ok' : 'degraded', db: dbOk, time: deps.clock.now().toISOString() },
      dbOk ? 200 : 503,
    );
  });

  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let id = 0;
      const send = (event: string, data: unknown) =>
        stream.writeSSE({ event, data: JSON.stringify(data), id: String(id++) });

      const sendState = () => send('state', toSnapshot(deps.store.get(), deps.clock.now()));
      const unsubscribe = deps.store.subscribe(() => void sendState());
      stream.onAbort(unsubscribe);

      await send('hello', { time: deps.clock.now().toISOString() });
      await sendState();
      while (!stream.aborted && !stream.closed) {
        await send('heartbeat', { time: deps.clock.now().toISOString() });
        await stream.sleep(deps.heartbeatMs);
      }
    }),
  );

  app.get('/api/state', (c) => c.json(toSnapshot(deps.store.get(), deps.clock.now())));

  app.post('/api/reset', (c) => {
    deps.store.replace(loadScenario(deps.scenario, deps.clock.now(), deps.phones));
    return c.json(toSnapshot(deps.store.get(), deps.clock.now()));
  });

  app.post('/api/traffic/:id', async (c) => {
    const r = await deps.engine.injectTraffic(c.req.param('id'));
    if (!r.ok) return c.json({ error: r.message }, 404);
    return c.json(toSnapshot(deps.store.get(), deps.clock.now()));
  });

  registerTools(app, { engine: deps.engine, store: deps.store });
  registerUrgentJobs(app, { engine: deps.engine, store: deps.store, clock: deps.clock });

  app.post('/webhooks/retell', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const parsed = retellWebhookSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400);
    }
    deps.db
      .prepare(
        'INSERT INTO webhook_events (received_at, source, event, payload) VALUES (?, ?, ?, ?)',
      )
      .run(deps.clock.now().toISOString(), 'retell', parsed.data.event, JSON.stringify(body));
    return c.body(null, 204);
  });

  app.use('/*', serveStatic({ root: deps.publicDir }));

  return app;
}

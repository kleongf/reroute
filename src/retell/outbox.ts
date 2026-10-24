import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Clock } from '../domain/clock.ts';
import type { Store } from '../store/store.ts';
import type { VoicePort } from '../voice/port.ts';

const requestSchema = z.object({
  kind: z.enum(['offer', 'at_risk_check', 'release', 'escalation']),
  to: z.string(),
  vars: z.record(z.string(), z.string()),
});

export interface VoiceOutbox extends VoicePort {
  /** Dispatches waiting calls. Exposed for deterministic testing and server lifecycle. */
  flush(): Promise<void>;
  close(): void;
}

/** Persist before acknowledging a command; Retell calls happen outside tool response time. */
export function createVoiceOutbox(deps: {
  db: DatabaseSync;
  store: Store;
  clock: Clock;
  transport: VoicePort;
}): VoiceOutbox {
  const { db, store, clock, transport } = deps;
  db.exec(`CREATE TABLE IF NOT EXISTS voice_outbox (
    id TEXT PRIMARY KEY, reset_at TEXT NOT NULL, payload TEXT NOT NULL,
    status TEXT NOT NULL, call_id TEXT, attempts INTEGER NOT NULL DEFAULT 0
  )`);
  const lifecycle = { closed: false };
  const isClosed = () => lifecycle.closed;
  let running: Promise<void> | null = null;
  const timers = new Set<NodeJS.Timeout>();

  function schedule(delay = 0): void {
    if (isClosed()) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      void flush();
    }, delay);
    timer.unref();
    timers.add(timer);
  }

  async function deliver(): Promise<void> {
    // A bounded batch also prevents a failing service from monopolising the event loop.
    const rows = db.prepare("SELECT * FROM voice_outbox WHERE status = 'queued' LIMIT 20").all();
    for (const row of rows) {
      if (isClosed()) return;
      const id = String(row['id']);
      const resetAt = String(row['reset_at']);
      const call = requestSchema.parse(JSON.parse(String(row['payload'])) as unknown);
      const offerId = call.vars['offer_id'];
      const world = store.get();
      const offer = world.offers.find((o) => o.id === offerId);
      if (resetAt !== world.resetAt || (call.kind === 'offer' && offer?.status !== 'pending')) {
        db.prepare("UPDATE voice_outbox SET status = 'cancelled' WHERE id = ?").run(id);
        continue;
      }
      try {
        const { callId } = await transport.placeCall(call);
        if (isClosed()) return;
        db.prepare("UPDATE voice_outbox SET status = 'sent', call_id = ? WHERE id = ?").run(
          callId,
          id,
        );
        if (store.get().resetAt === resetAt && offerId) {
          store.update((w) => {
            const current = w.offers.find((o) => o.id === offerId);
            if (current?.callId === id) current.callId = callId;
          });
        }
      } catch {
        if (isClosed()) return;
        const attempts = Number(row['attempts']) + 1;
        db.prepare('UPDATE voice_outbox SET status = ?, attempts = ? WHERE id = ?').run(
          attempts >= 3 ? 'failed' : 'queued',
          attempts,
          id,
        );
        store.update((w) => {
          if (w.resetAt === resetAt)
            w.log.push({
              at: clock.now().toISOString(),
              text:
                attempts >= 3
                  ? `Call ${call.kind} could not be placed; Dispatcher action required`
                  : `Call ${call.kind} is waiting for Retell; retrying`,
            });
        });
        if (attempts < 3) schedule(1000);
      }
    }
  }

  function flush(): Promise<void> {
    if (isClosed()) return Promise.resolve();
    if (running) return running;
    running = deliver().finally(() => {
      running = null;
      if (
        !lifecycle.closed &&
        db.prepare("SELECT id FROM voice_outbox WHERE status = 'queued' LIMIT 1").get()
      )
        schedule(1000);
    });
    return running;
  }
  schedule();
  return {
    placeCall(call) {
      if (isClosed()) return Promise.reject(new Error('Voice outbox is closed.'));
      const id = `reroute_${randomUUID().replaceAll('-', '')}`;
      const resetAt = store.get().resetAt;
      const payload = {
        ...call,
        vars: { ...call.vars, reroute_call_id: id, demo_reset_at: resetAt },
      };
      db.prepare(
        "INSERT INTO voice_outbox (id, reset_at, payload, status) VALUES (?, ?, ?, 'queued')",
      ).run(id, resetAt, JSON.stringify(payload));
      schedule();
      return Promise.resolve({ callId: id });
    },
    flush,
    close() {
      lifecycle.closed = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  };
}

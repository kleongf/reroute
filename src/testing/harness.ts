import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createApp } from '../app.ts';
import { openDatabase } from '../db.ts';
import { createEngine } from '../placement/engine.ts';
import { createManualClock, type ManualClock } from '../domain/clock.ts';
import type { StateSnapshot } from '../domain/types.ts';
import { loadScenario, readScenarioFile, type PhoneBook } from '../store/scenario.ts';
import { createStore, type Store } from '../store/store.ts';
import { createFakeVoice, type FakeVoice } from '../voice/port.ts';

export const HARNESS_START = new Date('2026-10-24T14:00:00.000Z');

export const HARNESS_PHONES: PhoneBook = {
  DRIVER_PHONE_ALEX: '+15550000001',
  DRIVER_PHONE_CASEY: '+15550000002',
  DISPATCHER_PHONE: '+15550000009',
};

export interface Harness {
  app: ReturnType<typeof createApp>;
  db: DatabaseSync;
  clock: ManualClock;
  voice: FakeVoice;
  store: Store;
  /** GET /api/state. */
  state(): Promise<StateSnapshot>;
  /** POST JSON to `path`; returns status and parsed body (null if empty). */
  post(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Runs deferred work (simulated Offer replies) until none is left; returns how many ran. */
  runScheduled(): Promise<number>;
  close(): void;
}

/**
 * Boots the real app in-process: in-memory SQLite, a manual clock at HARNESS_START, the demo
 * scenario, and a FakeVoice that records calls. Test only through HTTP, the snapshot, and
 * `voice.calls`.
 */
export function createHarness(phones: PhoneBook = HARNESS_PHONES): Harness {
  const db = openDatabase(':memory:');
  const clock = createManualClock(HARNESS_START);
  const voice = createFakeVoice();
  const scenario = readScenarioFile(
    fileURLToPath(new URL('../../fixtures/demo.json', import.meta.url)),
  );
  const store = createStore(db, loadScenario(scenario, clock.now(), phones));
  const webDir = mkdtempSync(join(tmpdir(), 'reroute-web-'));
  writeFileSync(join(webDir, 'index.html'), '<h1>Reroute</h1>');
  const scheduled: (() => Promise<void>)[] = [];
  const engine = createEngine({
    store,
    clock,
    voice,
    dispatcherPhone: phones['DISPATCHER_PHONE'] ?? null,
    simulatedOfferMs: 0,
    schedule: (fn) => scheduled.push(fn),
  });
  const app = createApp({
    db,
    clock,
    heartbeatMs: 1_000,
    publicDir: webDir,
    store,
    scenario,
    phones,
    voice,
    engine,
  });

  return {
    app,
    db,
    clock,
    voice,
    store,
    async state() {
      const res = await app.request('/api/state');
      return (await res.json()) as StateSnapshot;
    },
    async post(path, body) {
      const res = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      const text = await res.text();
      return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
    },
    async runScheduled() {
      let ran = 0;
      while (scheduled.length > 0) {
        await scheduled.shift()?.();
        ran += 1;
      }
      return ran;
    },
    close() {
      db.close();
    },
  };
}

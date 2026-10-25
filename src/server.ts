import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { systemClock } from './domain/clock.ts';
import { log } from './log.ts';
import { createEngine } from './placement/engine.ts';
import { createOsrmRouting } from './routing/osrm.ts';
import { createTomTomRouting } from './routing/tomtom.ts';
import { attachRoutedEtas } from './routing/refresh.ts';
import { loadScenario, readScenarioFile } from './store/scenario.ts';
import { createStore } from './store/store.ts';
import { createFakeVoice } from './voice/port.ts';
import { createRetellVoice } from './retell/voice.ts';
import { createVoiceOutbox } from './retell/outbox.ts';

if (existsSync('.env')) {
  // Does not override variables already set in the environment.
  process.loadEnvFile('.env');
}

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
// Resolves to <repo>/public from both src/server.ts (tsx) and dist/server.js (build).
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
// The web/ build (pnpm build); both entry points resolve to <repo>/dist/web.
const webDir = fileURLToPath(new URL('../dist/web/', import.meta.url));

const scenario = readScenarioFile(fileURLToPath(new URL('../fixtures/demo.json', import.meta.url)));
const phones = process.env;
const store = createStore(db, loadScenario(scenario, systemClock.now(), phones));
// ROUTING=osrm: routed ETAs replace fixture ones in the background after each reset / Urgent Job.
if (config.ROUTING === 'osrm') {
  attachRoutedEtas(store, createOsrmRouting({ timeoutMs: config.ROUTING_TIMEOUT_MS }));
}
// ROUTING=tomtom: same, but live-traffic ETAs (source 'traffic') from one TomTom matrix request.
if (config.ROUTING === 'tomtom') {
  if (!config.TOMTOM_API_KEY) throw new Error('ROUTING=tomtom needs TOMTOM_API_KEY');
  attachRoutedEtas(
    store,
    createTomTomRouting({
      apiKey: config.TOMTOM_API_KEY,
      // TomTom's synchronous matrix is slower than OSRM: default 2 s unless set explicitly.
      timeoutMs: process.env['ROUTING_TIMEOUT_MS'] ? config.ROUTING_TIMEOUT_MS : 2_000,
    }),
  );
}
// Persist outbound calls before returning tool results; dispatch through Retell in the background.
const outbox =
  config.VOICE_MODE === 'retell'
    ? createVoiceOutbox({
        db,
        store,
        clock: systemClock,
        onUnanswered: (offerId) => engine.markUnanswered(offerId),
        transport: createRetellVoice({
          apiKey: config.RETELL_API_KEY ?? '',
          fromNumber: config.RETELL_FROM_NUMBER ?? '',
          agentIds: {
            offer: config.RETELL_AGENT_OFFER ?? config.RETELL_AGENT_ID ?? '',
            at_risk_check: config.RETELL_AGENT_AT_RISK_CHECK ?? config.RETELL_AGENT_ID ?? '',
            release: config.RETELL_AGENT_RELEASE ?? config.RETELL_AGENT_ID ?? '',
            escalation: config.RETELL_AGENT_ESCALATION ?? config.RETELL_AGENT_ID ?? '',
          },
          allowedNumbers: new Set(
            [
              phones['DRIVER_PHONE_ALEX'],
              phones['DRIVER_PHONE_CASEY'],
              phones['DISPATCHER_PHONE'],
            ].filter((phone): phone is string => Boolean(phone)),
          ),
        }),
      })
    : null;
const voice = outbox ?? createFakeVoice();
const engine = createEngine({
  store,
  clock: systemClock,
  voice,
  dispatcherPhone: process.env['DISPATCHER_PHONE'] ?? null,
  simulatedOfferMs: config.SIMULATED_OFFER_MS,
});

const app = createApp({
  db,
  clock: systemClock,
  heartbeatMs: config.HEARTBEAT_MS,
  publicDir,
  webDir,
  store,
  scenario,
  phones,
  voice,
  engine,
  ...(config.VOICE_MODE === 'retell' ? { retellApiKey: config.RETELL_API_KEY ?? '' } : {}),
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log('info', 'listening', { port: info.port, url: `http://localhost:${String(info.port)}` });
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  outbox?.close();
  log('info', 'shutting down', { signal });
  setTimeout(() => {
    log('error', 'forced exit after shutdown timeout');
    process.exit(1);
  }, 5_000).unref();
  server.close((err) => {
    db.close();
    if (err) {
      log('error', 'error while closing server', { error: err.message });
      process.exit(1);
    }
    log('info', 'stopped');
    process.exit(0);
  });
  // Long-lived SSE connections would otherwise keep close() waiting.
  if ('closeAllConnections' in server) server.closeAllConnections();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

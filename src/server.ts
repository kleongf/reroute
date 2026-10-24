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

if (existsSync('.env')) {
  // Does not override variables already set in the environment.
  process.loadEnvFile('.env');
}

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
// Resolves to <repo>/public from both src/server.ts (tsx) and dist/server.js (build).
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

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
// Replaced by the Retell implementation in #6.
const voice = createFakeVoice();
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
  store,
  scenario,
  phones,
  voice,
  engine,
});

const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  log('info', 'listening', { port: info.port, url: `http://localhost:${String(info.port)}` });
});

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
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

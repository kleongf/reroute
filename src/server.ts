import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db.ts';
import { systemClock } from './domain/clock.ts';
import { log } from './log.ts';

if (existsSync('.env')) {
  // Does not override variables already set in the environment.
  process.loadEnvFile('.env');
}

const config = loadConfig();
const db = openDatabase(config.DATABASE_PATH);
// Resolves to <repo>/public from both src/server.ts (tsx) and dist/server.js (build).
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

const app = createApp({ db, clock: systemClock, heartbeatMs: config.HEARTBEAT_MS, publicDir });

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

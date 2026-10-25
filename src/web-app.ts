import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Serves the Vite build of `web/` (the dashboard) at `/`. `/next` and `/next/*`, where the app
 * lived before the switchover, redirect to `/`. Register after every API route.
 */
export function registerWebApp(app: Hono, webDir: string): void {
  app.get('/next', (c) => c.redirect('/'));
  app.get('/next/*', (c) => c.redirect('/'));
  app.use('/*', serveStatic({ root: webDir }));
}

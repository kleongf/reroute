import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';

/**
 * Serves the Vite build of `web/` (base `/next/`) at /next. Unknown /next/* paths fall back to
 * index.html so client-side routes work. `/` keeps serving public/ (registered after this).
 */
export function registerNextApp(app: Hono, webDir: string): void {
  const index = serveStatic({ root: webDir, path: 'index.html' });
  app.get('/next', index);
  app.use(
    '/next/*',
    serveStatic({ root: webDir, rewriteRequestPath: (path) => path.replace(/^\/next/, '') }),
  );
  app.get('/next/*', index);
}

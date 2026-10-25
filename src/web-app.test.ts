import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerWebApp } from './web-app.ts';

describe('registerWebApp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reroute-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<h1>web</h1>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const app = new Hono();
  app.get('/api/state', (c) => c.json({ ok: true }));
  registerWebApp(app, dir);

  it('serves index.html at /', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>web</h1>');
  });

  it('serves built assets under /assets', async () => {
    const res = await app.request('/assets/app.js');
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it.each(['/next', '/next/', '/next/some/route'])('redirects %s to /', async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
  });

  it('leaves API routes registered before it alone', async () => {
    expect(await (await app.request('/api/state')).json()).toEqual({ ok: true });
  });
});

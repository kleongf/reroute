import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { registerNextApp } from './next-app.ts';

describe('registerNextApp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reroute-next-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<h1>next</h1>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  const app = new Hono();
  registerNextApp(app, dir);
  app.get('/', (c) => c.text('old dashboard'));

  it.each(['/next', '/next/', '/next/some/route'])('serves index.html at %s', async (path) => {
    const res = await app.request(path);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('<h1>next</h1>');
  });

  it('serves built assets under /next/assets', async () => {
    const res = await app.request('/next/assets/app.js');
    expect(await res.text()).toBe('console.log(1)');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('leaves / alone', async () => {
    expect(await (await app.request('/')).text()).toBe('old dashboard');
  });
});

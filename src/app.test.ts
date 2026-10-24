import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';
import { createHarness, type Harness } from './testing/harness.ts';

describe('createApp', () => {
  let h: Harness;
  let app: Harness['app'];
  let db: DatabaseSync;

  beforeEach(() => {
    h = createHarness();
    app = h.app;
    db = h.db;
  });

  afterEach(() => {
    h.close();
  });

  it('GET /health reports ok with the clock time', async () => {
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: true, time: '2026-10-24T14:00:00.000Z' });
  });

  it('GET / serves the dashboard page', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Reroute');
  });

  it('POST /webhooks/retell rejects malformed bodies', async () => {
    const bad = await app.request('/webhooks/retell', { method: 'POST', body: '{not json' });
    expect(bad.status).toBe(400);
    const invalid = await app.request('/webhooks/retell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'call_started' }),
    });
    expect(invalid.status).toBe(400);
  });

  it('POST /webhooks/retell stores valid events', async () => {
    const res = await app.request('/webhooks/retell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'call_started', call: { call_id: 'c1', extra: true } }),
    });
    expect(res.status).toBe(204);
    const row = db.prepare('SELECT event, payload FROM webhook_events').get();
    expect(row?.['event']).toBe('call_started');
  });
});

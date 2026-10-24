import { readFileSync } from 'node:fs';
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

  it.each([
    { file: 'call_started.json', path: '/webhooks/retell', status: 204 },
    { file: 'transcript_updated.json', path: '/webhooks/retell', status: 204 },
    { file: 'call_ended.json', path: '/webhooks/retell', status: 204 },
    { file: 'tool-call.json', path: '/tools/tracer_ping', status: 200 },
  ])(
    'accepts the redacted live $file capture without dropping fields',
    async ({ file, path, status }) => {
      const body = readFileSync(
        new URL(`../fixtures/retell/tracer-call/${file}`, import.meta.url),
        'utf8',
      );
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(response.status).toBe(status);
      const row = db.prepare('SELECT payload FROM webhook_events').get();
      expect(JSON.parse(String(row?.['payload'])) as unknown).toEqual(JSON.parse(body) as unknown);
    },
  );

  // The inline Retell payloads below are synthetic; the replay test above uses real redacted captures.
  it.each(['/tools/tracer_ping', '/webhooks/retell'])('%s rejects invalid JSON', async (path) => {
    const res = await app.request(path, { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_json' });
    expect(db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
  });

  it('POST /tools/tracer_ping stores the full envelope and returns a speakable result', async () => {
    const body = {
      name: 'tracer_ping',
      call: {
        call_id: 'synthetic-call',
        retell_llm_dynamic_variables: { driver_id: 'alex', job_id: 'J17' },
        future_call_field: { nested: true },
      },
      args: { message: 'Synthetic tracer check', future_arg: ['preserve', 'this'] },
      future_envelope_field: { enabled: true },
    };
    const res = await app.request('/tools/tracer_ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      result: 'Tracer received. The backend connection is working.',
    });
    expect(
      db.prepare('SELECT received_at, source, event, payload FROM webhook_events').all(),
    ).toEqual([
      {
        received_at: '2026-10-24T14:00:00.000Z',
        source: 'retell',
        event: 'tool_call:tracer_ping',
        payload: JSON.stringify(body),
      },
    ]);
  });

  it.each([
    { label: 'null body', body: null },
    { label: 'array body', body: [] },
    { label: 'missing name', body: { call: { call_id: 'synthetic' }, args: { message: 'hi' } } },
    {
      label: 'path/name mismatch',
      body: { name: 'accept_offer', call: { call_id: 'synthetic' }, args: { message: 'hi' } },
    },
    { label: 'missing call', body: { name: 'tracer_ping', args: { message: 'hi' } } },
    { label: 'missing call ID', body: { name: 'tracer_ping', call: {}, args: { message: 'hi' } } },
    {
      label: 'empty call ID',
      body: { name: 'tracer_ping', call: { call_id: '' }, args: { message: 'hi' } },
    },
    { label: 'missing args', body: { name: 'tracer_ping', call: { call_id: 'synthetic' } } },
    {
      label: 'missing message',
      body: { name: 'tracer_ping', call: { call_id: 'synthetic' }, args: {} },
    },
    {
      label: 'non-string message',
      body: { name: 'tracer_ping', call: { call_id: 'synthetic' }, args: { message: 42 } },
    },
  ])('POST /tools/tracer_ping rejects $label without logging', async ({ body }) => {
    const res = await app.request('/tools/tracer_ping', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
  });

  it.each(['arbitrary_tool'])(
    'POST /tools/%s is not exposed as a logging endpoint',
    async (name) => {
      const res = await app.request(`/tools/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, call: { call_id: 'synthetic' }, args: { message: 'hi' } }),
      });
      expect(res.status).toBe(404);
      expect(db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
    },
  );

  it.each([
    { label: 'null body', body: null },
    { label: 'array body', body: [] },
    { label: 'missing call', body: { event: 'call_started' } },
    { label: 'empty event', body: { event: '', call: { call_id: 'synthetic' } } },
    { label: 'non-string event', body: { event: 42, call: { call_id: 'synthetic' } } },
    { label: 'null call', body: { event: 'call_ended', call: null } },
    { label: 'empty call ID', body: { event: 'call_ended', call: { call_id: '' } } },
    { label: 'non-string call ID', body: { event: 'call_ended', call: { call_id: 42 } } },
  ])('POST /webhooks/retell rejects $label without logging', async ({ body }) => {
    const res = await app.request('/webhooks/retell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_body' });
    expect(db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
  });

  it.each(['call_started', 'transcript_updated', 'call_ended', 'future_event'])(
    'POST /webhooks/retell stores the full %s envelope',
    async (event) => {
      const body = {
        event,
        call: {
          call_id: 'synthetic-call',
          transcript: 'Agent: Synthetic tracer check.',
          transcript_with_tool_calls: [{ role: 'agent', content: 'Synthetic tracer check.' }],
          future_call_field: { nested: true },
        },
        future_envelope_field: ['preserve', 'this'],
      };
      const res = await app.request('/webhooks/retell', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect(
        db.prepare('SELECT received_at, source, event, payload FROM webhook_events').all(),
      ).toEqual([
        {
          received_at: '2026-10-24T14:00:00.000Z',
          source: 'retell',
          event,
          payload: JSON.stringify(body),
        },
      ]);
    },
  );

  it('POST /webhooks/retell remains compatible with the minimal call envelope', async () => {
    const res = await app.request('/webhooks/retell', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'call_started', call: { call_id: 'synthetic-call' } }),
    });
    expect(res.status).toBe(204);
    const row = db.prepare('SELECT event, payload FROM webhook_events').get();
    expect(row?.['event']).toBe('call_started');
  });
});

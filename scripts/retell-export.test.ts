import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportRetellCapture, parseExportArgs } from './retell-export.ts';

// Synthetic local SQLite records exercise export behavior; they are not Retell evidence.
describe('Retell exporter (synthetic database)', () => {
  let root: string;
  let database: string;
  let outDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'retell-export-synthetic-'));
    database = join(root, 'synthetic.db');
    outDir = join(root, 'capture');
    db = new DatabaseSync(database);
    db.exec(
      'CREATE TABLE webhook_events (id INTEGER PRIMARY KEY, received_at TEXT, source TEXT, event TEXT, payload TEXT)',
    );
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function insert(event: string, payload: unknown, source = 'retell'): void {
    db.prepare(
      'INSERT INTO webhook_events (received_at, source, event, payload) VALUES (?, ?, ?, ?)',
    ).run('2026-10-24T14:00:00.000Z', source, event, JSON.stringify(payload));
  }
  function capture(callId = 'synthetic-call', overrides: Record<string, unknown> = {}): void {
    const call = {
      call_id: callId,
      call_type: 'phone_call',
      direction: 'outbound',
      from_number: '+14155550100',
      to_number: '+14155550101',
      ...overrides,
    };
    insert('call_started', { event: 'call_started', call });
    insert('transcript_updated', {
      event: 'transcript_updated',
      call: { ...call, transcript: 'Synthetic first update' },
    });
    insert('call_ended', { event: 'call_ended', call: { ...call, call_status: 'ended' } });
    insert('tool_call:tracer_ping', {
      name: 'tracer_ping',
      call,
      args: { message: 'Synthetic ping' },
    });
  }

  it('exports only one selected call with the last transcript and truthful provenance', () => {
    capture();
    capture('different-synthetic-call');
    insert('transcript_updated', {
      event: 'transcript_updated',
      call: {
        call_id: 'synthetic-call',
        call_type: 'phone_call',
        direction: 'outbound',
        from_number: '+14155550100',
        to_number: '+14155550101',
        transcript: 'Synthetic final update +14155550101',
      },
    });
    const options = { database, outDir, callId: 'synthetic-call' };
    expect(exportRetellCapture(options)).toEqual([
      'call_started.json',
      'transcript_updated.json',
      'call_ended.json',
      'tool-call.json',
      'provenance.json',
    ]);
    const content = readdirSync(outDir)
      .map((file) => readFileSync(join(outDir, file), 'utf8'))
      .join('');
    expect(content).toContain('Synthetic final update');
    expect(content).not.toMatch(/different-synthetic-call|synthetic-call|1415555010/);
    expect(content).toContain('not independent proof');
    expect(content).toContain('database_row_id');
    expect(() => exportRetellCapture(options)).toThrow(/existing capture/);
  });

  it('rejects incomplete sets and tool-only records without creating output', () => {
    insert('tool_call:tracer_ping', {
      name: 'tracer_ping',
      call: { call_id: 'synthetic-call' },
      args: { message: 'Synthetic' },
    });
    expect(() => exportRetellCapture({ database, outDir })).toThrow(/missing call_started/);
    expect(readdirSync(root)).toEqual(['synthetic.db']);
  });

  it('exports streamed transcript turns from the envelope root observed in live callbacks', () => {
    capture();
    insert('transcript_updated', {
      event: 'transcript_updated',
      event_timestamp: 1792863000000,
      call: {
        call_id: 'synthetic-call',
        call_type: 'phone_call',
        direction: 'outbound',
        from_number: '+14155550100',
        to_number: '+14155550101',
      },
      transcript_with_tool_calls: [{ role: 'user', content: 'Synthetic yes.' }],
    });
    exportRetellCapture({ database, outDir, callId: 'synthetic-call' });
    const exported = JSON.parse(
      readFileSync(join(outDir, 'transcript_updated.json'), 'utf8'),
    ) as unknown;
    expect(exported).toMatchObject({
      event: 'transcript_updated',
      transcript_with_tool_calls: [{ role: 'user', content: 'Synthetic yes.' }],
    });
  });

  it('requires an explicit selection when multiple calls are present', () => {
    capture();
    capture('another-synthetic-call');
    expect(() => exportRetellCapture({ database, outDir })).toThrow(/--call-id/);
    expect(() => exportRetellCapture({ database, outDir, callId: 'not-present' })).toThrow(
      /Incomplete capture/,
    );
  });

  it.each([{ call_type: 'web_call' }, { direction: 'inbound' }, { to_number: '' }])(
    'rejects unsupported outbound evidence %j',
    (overrides) => {
      capture('synthetic-call', overrides);
      expect(() => exportRetellCapture({ database, outDir })).toThrow(
        /outbound phone-call metadata/,
      );
    },
  );

  it('rejects conflicting lifecycle/tool records but permits identical retries', () => {
    capture();
    const tool = {
      name: 'tracer_ping',
      call: {
        call_id: 'synthetic-call',
        call_type: 'phone_call',
        direction: 'outbound',
        from_number: '+14155550100',
        to_number: '+14155550101',
      },
      args: { message: 'Synthetic ping' },
    };
    insert('tool_call:tracer_ping', tool);
    expect(exportRetellCapture({ database, outDir })).toHaveLength(5);
    insert('tool_call:tracer_ping', {
      ...tool,
      args: { message: 'Conflicting synthetic message' },
    });
    expect(() => exportRetellCapture({ database, outDir: join(root, 'other') })).toThrow(
      /Ambiguous capture/,
    );
  });

  it('validates stored envelopes and never prints raw malformed input', () => {
    capture();
    db.prepare("UPDATE webhook_events SET payload = ? WHERE event = 'call_started'").run(
      '{"event":"call_ended","call":{"call_id":"synthetic-call"}}',
    );
    expect(() => exportRetellCapture({ database, outDir })).toThrow(/disagrees/);
  });

  it('parses options, rejects duplicates and missing values', () => {
    expect(
      parseExportArgs([
        '--',
        '--db',
        'private.db',
        '--call-id',
        'private-id',
        '--out',
        'artifacts/private',
      ]),
    ).toEqual({ database: 'private.db', callId: 'private-id', outDir: 'artifacts/private' });
    for (const args of [['--db'], ['--call-id', '--out'], ['--raw'], ['--out', 'a', '--out', 'b']])
      expect(() => parseExportArgs(args)).toThrow();
  });
});

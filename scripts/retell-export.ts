import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { createRetellRedactor } from '../src/retell/redact.ts';

const events = [
  'call_started',
  'transcript_updated',
  'call_ended',
  'tool_call:tracer_ping',
] as const;
type CaptureEvent = (typeof events)[number];
const files: Record<CaptureEvent, string> = {
  call_started: 'call_started.json',
  transcript_updated: 'transcript_updated.json',
  call_ended: 'call_ended.json',
  'tool_call:tracer_ping': 'tool-call.json',
};
const rowSchema = z.object({
  id: z.number().int(),
  received_at: z.iso.datetime({ offset: true }),
  event: z.enum(events),
  payload: z.string(),
});
const envelopeSchema = z.looseObject({ call: z.looseObject({ call_id: z.string().min(1) }) });
const callEventSchema = envelopeSchema.extend({
  event: z.enum(['call_started', 'transcript_updated', 'call_ended']),
});
const toolSchema = envelopeSchema.extend({
  name: z.literal('tracer_ping'),
  args: z.looseObject({ message: z.string() }),
});
const outboundSchema = z.looseObject({
  call_type: z.literal('phone_call'),
  direction: z.literal('outbound'),
  from_number: z.string().regex(/^\+[1-9]\d{6,14}$/),
  to_number: z.string().regex(/^\+[1-9]\d{6,14}$/),
});

export interface ExportOptions {
  database: string;
  callId?: string;
  outDir: string;
}

export function parseExportArgs(args: string[]): ExportOptions {
  const options: ExportOptions = {
    database: process.env['DATABASE_PATH'] ?? 'reroute.db',
    outDir: 'artifacts/retell-capture',
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--' && index === 0) continue;
    if (flag !== '--db' && flag !== '--call-id' && flag !== '--out')
      throw new Error('Use --db PATH, --call-id ID, and --out DIRECTORY.');
    const value = args[++index];
    if (!value || value.startsWith('--') || seen.has(flag))
      throw new Error('Each export option needs one nonempty value and may appear once.');
    seen.add(flag);
    if (flag === '--db') options.database = value;
    else if (flag === '--call-id') options.callId = value;
    else options.outDir = value;
  }
  return options;
}

/** Reads captured rows only. It never calls Retell, modifies the database, or invents records. */
export function exportRetellCapture(options: ExportOptions): string[] {
  if (!existsSync(options.database))
    throw new Error(
      'Capture database does not exist. Supply --db pointing to the ignored webhook database.',
    );
  const db = new DatabaseSync(options.database, { readOnly: true });
  try {
    // One SELECT gives a consistent snapshot even while a webhook receiver is writing.
    const rows = db
      .prepare(
        `SELECT id, received_at, event, payload FROM webhook_events
      WHERE source = 'retell' AND event IN (?, ?, ?, ?) ORDER BY id`,
      )
      .all(...events);
    const records = rows.map((raw) => {
      const row = rowSchema.safeParse(raw);
      if (!row.success)
        throw new Error(
          'A capture row has an invalid event, timestamp, or payload type; inspect the database privately.',
        );
      let payload: unknown;
      try {
        payload = JSON.parse(row.data.payload) as unknown;
      } catch {
        throw new Error(`Invalid captured JSON in database row ${String(row.data.id)}.`);
      }
      const envelope = envelopeSchema.safeParse(payload);
      if (!envelope.success)
        throw new Error(`Missing call.call_id in database row ${String(row.data.id)}.`);
      return { ...row.data, payload: envelope.data };
    });
    const callIds = new Set(records.map((record) => record.payload.call.call_id));
    const callId = options.callId ?? (callIds.size === 1 ? [...callIds][0] : undefined);
    if (!callId)
      throw new Error(
        'No unambiguous call selected. Supply --call-id from the privately inspected Retell call history.',
      );
    const matching = records.filter((record) => record.payload.call.call_id === callId);
    const selected = events.map((event) => {
      const candidates = matching.filter((record) => record.event === event);
      if (candidates.length === 0)
        throw new Error(
          `Incomplete capture: missing ${event} for the selected call. Wait for delivery or check the webhook subscription/tool configuration.`,
        );
      // Transcript updates are cumulative. Keep the final received update; retries of other
      // events must have identical payloads to avoid silently choosing conflicting evidence.
      if (
        event !== 'transcript_updated' &&
        new Set(candidates.map((record) => JSON.stringify(record.payload))).size > 1
      ) {
        throw new Error(
          `Ambiguous capture: conflicting ${event} records for the selected call; inspect privately.`,
        );
      }
      const record = candidates.at(-1);
      if (!record) throw new Error('Capture selection failed.');
      if (event === 'tool_call:tracer_ping') {
        if (!toolSchema.safeParse(record.payload).success)
          throw new Error('Captured tracer_ping must contain name, call, and args.message.');
      } else {
        const parsed = callEventSchema.safeParse(record.payload);
        if (!parsed.success || parsed.data.event !== event)
          throw new Error(`Captured ${event} envelope disagrees with its database event.`);
      }
      return { ...record, event, deliveries: candidates.length };
    });
    for (const record of selected) {
      // Tool envelopes may contain only basic context, but all lifecycle samples must
      // independently identify this as an outbound phone call, per Retell's call object.
      if (
        record.event !== 'tool_call:tracer_ping' &&
        !outboundSchema.safeParse(record.payload.call).success
      ) {
        throw new Error(
          `Cannot establish outbound phone-call metadata for ${record.event}: require call_type, direction, from_number, and to_number.`,
        );
      }
    }
    const ended = selected.find((record) => record.event === 'call_ended');
    if (ended?.payload.call['call_status'] !== 'ended')
      throw new Error('The selected call_ended record must report call_status=ended.');
    const transcript = selected.find((record) => record.event === 'transcript_updated')?.payload;
    const transcriptText = transcript?.call['transcript'];
    // Live streamed updates carry turns beside `call`; completed call objects may nest them.
    const transcriptTurns =
      transcript?.['transcript_with_tool_calls'] ?? transcript?.call['transcript_with_tool_calls'];
    if (
      !(typeof transcriptText === 'string' && transcriptText.trim().length > 0) &&
      !(Array.isArray(transcriptTurns) && transcriptTurns.length > 0)
    ) {
      throw new Error(
        'The selected transcript_updated record contains no transcript text or transcript_with_tool_calls turns.',
      );
    }
    const redact = createRetellRedactor(selected.map((record) => record.payload));
    const output = selected.map((record) => ({
      name: files[record.event],
      value: redact(record.payload),
    }));
    output.push({
      name: 'provenance.json',
      value: {
        format_version: 1,
        source: 'local webhook_events rows; source=retell',
        call: redact({ call_id: callId }),
        observed_call_type: 'phone_call',
        observed_direction: 'outbound',
        authenticity:
          'Database contents are not independent proof of Retell origin, teammate consent, KYC, billing, or number ownership. Confirm those separately before describing this as a real-call capture.',
        selection:
          'One call; latest received transcript; identical lifecycle/tool retries collapsed.',
        redaction:
          'Export-scoped deterministic aliases; credentials, phone strings, URLs and emails removed. Review remaining text for personal information before committing.',
        records: selected.map((record) => ({
          file: files[record.event],
          event: record.event,
          database_row_id: record.id,
          received_at: record.received_at,
          matching_deliveries: record.deliveries,
        })),
      },
    });
    const directory = resolve(options.outDir);
    // Refuse overwriting a prior capture, and validate the entire set before writing anything.
    if (output.some((file) => existsSync(join(directory, file.name))))
      throw new Error(
        'Output contains an existing capture. Choose a fresh --out directory to avoid mixing calls.',
      );
    mkdirSync(directory, { recursive: true });
    for (const file of output)
      writeFileSync(join(directory, file.name), `${JSON.stringify(file.value, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      });
    return output.map((file) => file.name);
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const written = exportRetellCapture(parseExportArgs(process.argv.slice(2)));
    console.log(
      `Exported ${String(written.length)} redacted files. Review provenance.json and remaining personal information before committing.`,
    );
  } catch (error) {
    // Do not expose SQLite paths, raw payloads, call IDs, or zod input values on stderr.
    const message =
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Cannot read or write capture files; inspect the database schema and output permissions privately.';
    console.error(`Retell export failed: ${message}`);
    process.exitCode = 1;
  }
}

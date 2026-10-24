import { describe, expect, it } from 'vitest';
import { createRetellRedactor, redactRetellPayload } from './redact.ts';

// All values in these tests are synthetic. They are never live-call fixtures.
describe('Retell redaction (synthetic)', () => {
  it('redacts phone strings anywhere, dynamic variables, spoken digits and word fragments', () => {
    const result = redactRetellPayload({
      call: {
        from_number: '+14155550100',
        to_number: '+14155550101',
        retell_llm_dynamic_variables: {
          driver_phone: '+1 (415) 555-0100',
          note: 'Call 415.555.0101 please',
        },
        transcript:
          'My phone is +1 (415) 555-0100. Or four one five five five five zero one zero zero.',
        transcript_object: [
          {
            content: '415 555 0100',
            words: [
              { word: '415', start: 1, end: 2 },
              { word: '555', start: 2, end: 3 },
              { word: '0100', start: 3, end: 4 },
            ],
          },
        ],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/415|555|0100|0101|four one five/);
    expect(serialized).toContain('[phone_1]');
    expect(serialized).toContain('[phone_2]');
    expect(serialized).toContain('[number]');
  });

  it('removes credentials, embedded copies, signatures, URLs, emails and serialized tool arguments', () => {
    const payload = {
      Authorization: 'Bearer synthetic-secret',
      api_key: 'plain-synthetic-key',
      headers: { 'x-retell-signature': 'synthetic-signature' },
      message: 'plain-synthetic-key synthetic-signature Bearer other-token key_abcdefgh1234',
      recording_url: 'https://recordings.example/call-private/audio?access_token=hidden',
      public_log_url: 'https://logs.example/private/log',
      note: 'See https://logs.example/private/log or sip:+14155550100@example.test and test@example.test',
      arguments: JSON.stringify({ accessToken: 'json-secret', note: 'Call +14155550100' }),
    };
    const result = JSON.stringify(redactRetellPayload(payload));
    for (const secret of [
      'synthetic-secret',
      'plain-synthetic-key',
      'synthetic-signature',
      'other-token',
      'abcdefgh1234',
      'json-secret',
      'recordings.example',
      'logs.example',
      '14155550100',
      'test@example.test',
    ])
      expect(result).not.toContain(secret);
    expect(result).toContain('redacted.invalid');
  });

  it('preserves JSON structure, scalar types, timestamps and deterministic correlated IDs', () => {
    const first = {
      event: 'call_started',
      call: {
        call_id: 'private-call-id',
        agent_id: 'private-agent-id',
        start_timestamp: 1792863000000,
        nullable: null,
        enabled: true,
        duration_ms: 0,
      },
      at: '2026-10-24T14:00:00.000Z',
    };
    const second = {
      name: 'tracer_ping',
      call: { call_id: 'private-call-id' },
      args: { message: 'Observed private-call-id' },
    };
    const redact = createRetellRedactor([first, second]);
    expect(redact(first)).toEqual({
      event: 'call_started',
      call: {
        call_id: '[call_1]',
        agent_id: '[agent_1]',
        start_timestamp: 1792863000000,
        nullable: null,
        enabled: true,
        duration_ms: 0,
      },
      at: '2026-10-24T14:00:00.000Z',
    });
    expect(redact(second)).toEqual({
      name: 'tracer_ping',
      call: { call_id: '[call_1]' },
      args: { message: 'Observed [call_1]' },
    });
    expect(createRetellRedactor([first, second])(first)).toEqual(redact(first));
    expect(first.call.call_id).toBe('private-call-id');
  });

  it('retains shapes beneath sensitive objects, including numeric phones', () => {
    expect(
      redactRetellPayload({
        credentials: { token: 'secret', count: 42, flags: [true, null] },
        phone: 14155550100,
        arbitrary: 14155550101,
      }),
    ).toEqual({
      credentials: { token: '[credential]', count: 0, flags: [true, null] },
      phone: 0,
      arbitrary: 0,
    });
  });

  it('redacts phone-valued map keys and spoken word-level digits', () => {
    const result = JSON.stringify(
      redactRetellPayload({
        lookup: { '+14155550100': 'synthetic' },
        words: [{ word: 'four' }, { word: 'one' }, { word: 'five' }],
        note: 'Call 415\n555\t0100',
      }),
    );
    expect(result).not.toMatch(/14155550100|415|555|0100|\b(?:four|one|five)\b/);
  });

  it('does not leak adjacent numbers or numbers embedded in arbitrary strings', () => {
    const result = JSON.stringify(
      redactRetellPayload({
        note: '4155550100 2125550199; label4155550100suffix',
      }),
    );
    expect(result).not.toMatch(/4155550100|2125550199/);
  });
});

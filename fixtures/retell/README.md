# Retell payload captures

[`tracer-call/`](tracer-call/) contains reviewed, redacted payloads captured during a real
outbound phone call on 2026-10-24. Its [capture note](tracer-call/capture-note.md) records the
observed outcome. Inline unit-test data remains synthetic and is separate from these samples.

After coordinating a consenting teammate's outbound tracer call, export its
persisted records from the ignored SQLite database:

```sh
pnpm exec tsx scripts/retell-export.ts --db reroute.db --call-id '<private Retell call ID>'
```

The default output is the ignored `artifacts/retell-capture/` directory. The exporter reads
`webhook_events` in read-only mode, selecting `source='retell'`, and requires all four
records for the same `call.call_id`:

- `call_started` → `call_started.json`
- `transcript_updated` → `transcript_updated.json` (latest received update)
- `call_ended` → `call_ended.json`
- `tool_call:tracer_ping` → `tool-call.json` (`{name, call, args: {message}}`)

All lifecycle records must contain `call_type: "phone_call"`, `direction: "outbound"`,
and E.164 `from_number` and `to_number`; the ended record must have `call_status: "ended"`.
These field names come from [Retell's call object](https://docs.retellai.com/api-references/get-call)
and [webhook documentation](https://docs.retellai.com/features/webhook-overview).
Missing events, mismatched envelopes, conflicting lifecycle/tool deliveries, and ambiguous
call selection fail without producing samples. Identical retries are collapsed. More than
one call in the database requires `--call-id`; an explicit call ID is always recommended.
An existing output capture is never overwritten; choose a fresh directory with `--out`.

The exporter writes `provenance.json` with selected database row IDs, receipt timestamps,
delivery counts, selection rules, and the limits of the evidence. It does not claim that
database contents verify webhook signatures, teammate consent, KYC, billing/card setup,
or phone-number ownership. Confirm and document those observations separately. A tool-only
record or synthetic webhook does not establish a real outbound call.

Exports are always redacted. Export-scoped aliases correlate call/agent IDs and phones;
there is no raw-to-alias map in the output. Object keys, array shapes, scalar types, nulls,
and timing metrics are retained. Phone strings in transcripts/dynamic variables, common
spoken digit sequences and numeric word fragments are masked. Credential fields and their
copies elsewhere, bearer/API-key/JWT patterns, signatures, emails, and entire URLs are
removed (including recording/log paths without access tokens). Serialized JSON strings
are traversed too. Numeric values in phone/credential fields and other phone-length integers
outside timing fields become zero.

Review the ignored export for names, addresses, unusual spoken numbers, and other personal
information before committing any samples. Automated redaction is a review aid, not a
guarantee that arbitrary speech is anonymous. Do not paste the raw database or payloads
into logs, chat, or commits. The CLI prints only generic status/errors and no raw call ID,
phone, database path, or payload.

After confirming the records came from the coordinated real call and reviewing redaction,
an explicit export into a fresh fixtures subdirectory is allowed:

```sh
pnpm exec tsx scripts/retell-export.ts --db reroute.db --call-id '<private Retell call ID>' --out fixtures/retell/tracer-call
```

Review all five files together. Keep a truthful capture note with the actual date, consenting
teammate confirmation, observed tool response and call outcome, plus any missing evidence.
Never replace missing records with synthetic samples or describe local test data as live.

# Retell tracer call

Issue [#3](https://github.com/kleongf/reroute/issues/3) needs a **real** outbound call,
one logged custom function, and redacted backend captures of `call_started`,
`transcript_updated`, and `call_ended` for that same call. A successful API request
alone is not that evidence. Unit-test payloads are synthetic and must never be
presented as live captures.

## External prerequisites

The parent coordinates these live steps. This implementation does not purchase
numbers, enter card details, run setup against an account, or place a call.

1. Select the intended Retell workspace and create an API key there. Keep it only
   in the ignored `.env`; never paste it into logs or commands.
2. Complete the account's KYC. Retell documents automatic verification, Persona
   identity verification from the Phone Numbers page, or manual review. API
   inventory access does **not** prove KYC approval. See
   [Retell KYC](https://docs.retellai.com/accounts/kyc).
3. Add a payment method to that workspace and inspect its balance and billing
   settings privately. Retell requires a payment method before buying a number;
   payment methods and credits are scoped to the workspace. The plan's trial
   credit estimate is not an observed balance. Do not assume it covers a number
   purchase. See [number purchase](https://docs.retellai.com/deploy/purchase-number)
   and [workspace billing](https://docs.retellai.com/accounts/billing).
4. With parent coordination, use Phone Numbers → `+` to purchase one US number
   if none is available. Store it as `RETELL_FROM_NUMBER`. The script never buys
   or binds a phone number. Outbound requests use a one-call Agent override, so
   an existing number's Agent bindings are not changed. See
   [outbound calls](https://docs.retellai.com/deploy/outbound-call) and
   [Create Phone Call](https://docs.retellai.com/api-references/create-phone-call).
5. Arrange a short call with a consenting teammate, including consent to the
   transcript capture. Set their US E.164 number privately as `RETELL_TO_NUMBER`.
   Confirm they are ready immediately before the parent runs `--call`.
6. Install the repository's Node version (currently Node 26+) and dependencies.
   Keep the backend and public tunnel running against the **same** SQLite file
   that will be exported after the call.

## Environment and tunnel

Use the existing ignored `.env`; do not overwrite it. `.env.example` lists these
tracer inputs:

| Variable                 | Used for                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `RETELL_API_KEY`         | All Retell requests; required even for preflight                                                 |
| `PUBLIC_BASE_URL`        | Public HTTPS origin, required for `--setup` / `--call`; no credentials, path, query, or fragment |
| `RETELL_TRACER_AGENT_ID` | Dedicated tracer Agent, printed by setup; required for calling; optional for first setup         |
| `RETELL_FROM_NUMBER`     | Purchased US source number; required for calling                                                 |
| `RETELL_TO_NUMBER`       | Consenting teammate's US destination number; required for calling                                |

`RETELL_AGENT_ID` belongs to the fleet voice integration and is not read by the
tracer. The backend uses `PORT` and `DATABASE_PATH`. Fleet phone inputs are
`DRIVER_PHONE_ALEX`, `DRIVER_PHONE_CASEY`, and `DISPATCHER_PHONE` per the
[contracts](specs/contracts.md); the tracer does not read them.

Start the backend after dependencies and the tracer endpoint are integrated:

```sh
node --env-file-if-exists=.env --import tsx src/server.ts
```

In a second terminal, expose the backend port (3000 below; match `PORT`):

```sh
cloudflared tunnel --url http://localhost:3000
```

Or use the installed ngrok CLI:

```sh
ngrok http 3000
```

Copy the resulting public HTTPS origin privately to `PUBLIC_BASE_URL`. Restarting
an ephemeral tunnel changes that origin; rerun `--setup` before calling. Retell
must be able to reach both `POST /tools/tracer_ping` and
`POST /webhooks/retell` without a browser login or tunnel interstitial.

## Commands and concrete effects

Commands use Node's environment loader directly; importing the script does
nothing. No `.env` is loaded by the test module.
The package alias `pnpm retell:tracer` runs the same command; append `--setup` or
`--call` for the respective explicit action.

```sh
# Help: no environment or network needed.
node scripts/retell-tracer.ts --help

# Default: account access plus complete paginated Agent/number inventory.
node --env-file-if-exists=.env scripts/retell-tracer.ts

# Account mutation: configure the dedicated tracer; no purchase or call.
node --env-file-if-exists=.env scripts/retell-tracer.ts --setup

# Only the parent runs this after coordinating consent and readiness.
# This places ONE REAL OUTBOUND CALL and may incur usage charges.
node --env-file-if-exists=.env scripts/retell-tracer.ts --call
```

Default preflight calls `GET /get-concurrency`, `POST /v2/list-agents` (a read-only
listing with an empty body, filtering voice Agents locally), and `GET /v2/list-phone-numbers`. It follows
`items`, `has_more`, and `pagination_key`, with a 20-page bound. Inventory output
lists numbered entries with tracer/selected/suspended or managed/source flags;
names, resource IDs, phone digits, and raw API objects are withheld. Inspect the
Retell dashboard privately to select a resource. These endpoints do not establish
card validity, credit balance, KYC status, or tunnel reachability. See
[List Agents](https://docs.retellai.com/api-references/list-agents),
[List Phone Numbers](https://docs.retellai.com/api-references/list-phone-numbers),
and [Get Concurrency](https://docs.retellai.com/api-references/get-concurrency).

Setup creates a Retell LLM and a voice Agent named `Reroute tracer (issue 3)`.
It uses the API's default LLM model and documented `retell-Cimo` voice. Save the
printed Agent ID privately as `RETELL_TRACER_AGENT_ID`. Subsequent setup requires
that exact dedicated Agent name, creates a fresh LLM, and PATCHes that Agent;
it does not edit a possibly shared LLM. An existing named tracer without a
selected ID causes setup to stop rather than create a duplicate. Repeated setup
can leave unused LLM resources; inspect/remove those privately after testing.
Setup does not publish or bind the Agent to a number. See
[Create Retell LLM](https://docs.retellai.com/api-references/create-retell-llm),
[Create Agent](https://docs.retellai.com/api-references/create-agent), and
[Update Agent](https://docs.retellai.com/api-references/update-agent).

The dedicated Agent receives these settings:

- `tracer_ping`, a custom `POST` function at
  `PUBLIC_BASE_URL/tools/tracer_ping`, with required `message: string` and
  `args_at_root: false`. Retell sends the `{ name, call, args }` envelope. Tool
  execution has a five-second timeout and zero automatic retries. See
  [custom functions](https://docs.retellai.com/build/single-multi-prompt/custom-function)
  and [LLM tool settings](https://docs.retellai.com/api-references/create-retell-llm).
- Agent webhook at `PUBLIC_BASE_URL/webhooks/retell`, explicitly subscribing to
  `call_started`, `transcript_updated`, and `call_ended`. Transcript updates are
  not included in the API's default subscription. See
  [Agent webhook settings](https://docs.retellai.com/api-references/create-agent).
- A 60-second maximum call length (the documented API minimum), ten seconds of
  silence before hanging up, and voicemail hangup. The prompt asks for a short
  test, a clear yes, one tracer invocation, an acknowledgement, and hangup. A
  refusal, voicemail, silence, or unclear reply does not trigger the function.
  It cannot make an Offer or change any Job, Driver, or Placement.

Before dialing, `--call` checks that the source is in the workspace inventory and
that the selected dedicated Agent and its custom function point to the current
tunnel. It pins `override_agent_version` to the version just fetched, including
draft version zero. String dynamic variables carry synthetic tracer context:
`call_kind=tracer`, `job_id=tracer-job`, `driver_id=tracer-driver`, and
`offer_id=tracer-offer`. These are tracer markers, not real domain records. The
API response's call ID is printed, but transcripts, phone numbers, and raw
responses are never printed. See
[Get Agent](https://docs.retellai.com/api-references/get-agent) and
[Create Phone Call](https://docs.retellai.com/api-references/create-phone-call).

All requests use a ten-second timeout and reject redirects. Error response bodies,
network error messages, and unexpected exceptions are withheld because they can
echo secrets, phone numbers, or authenticated URLs. The CLI never retries a
mutation or call. **After a timeout, invalid response, or interrupted setup/call,
inspect Retell privately before retrying:** the first request may have succeeded.

## Capture and review

The backend/exporter seam is `webhook_events`:

- `source='retell'`, `event='tool_call:tracer_ping'`, `payload` containing the full
  `{ name, call, args }` envelope, including `args.message`.
- `source='retell'`, `event=body.event` for call events, with their original body.
- Correlate all four required samples through `call.call_id` to the actual call
  ID returned by Retell. A call that never connects may have no `call_started`;
  a successful call-creation response is not enough.

After the real call ends, use the separately owned capture exporter against the
backend's SQLite file and review only its redacted output. Commit redacted real
samples for the custom function, `call_started`, `transcript_updated`, and
`call_ended`, with a provenance note recording the date, observed response
statuses, and whether the teammate heard the backend acknowledgement. Do not
commit the SQLite file, `.env`, phone numbers, raw transcripts, recordings, or
authenticated recording/log URLs. A hand-written request can exercise the
endpoint, but belongs in synthetic tests, never the real-capture set.

```sh
# Replace call_ID with the actual call ID; defaults to DATABASE_PATH from .env.
node --env-file-if-exists=.env scripts/retell-export.ts --call-id call_ID --out artifacts/retell-capture
```

The package alias is `pnpm retell:export --call-id call_ID`. The exporter requires
all four captured events and fails on incomplete evidence; it does not call
Retell or manufacture missing events.

## Observations and remaining proof

Official API and account documentation was checked on 2026-10-24. The CLI and its
mocked-fetch tests implement those request shapes. The local `--help` path was
exercised without reading `.env` or contacting Retell.

Live account preflight on 2026-10-24 accepted the API key and returned one Agent and
one phone number. The documented `filter_criteria.channel` request returned HTTP
400; the same endpoint with an empty body returned HTTP 200. The CLI therefore
filters voice Agents locally. The legacy `/list-agents` endpoint explicitly rejected
deprecated API usage. This inventory check does not establish KYC or call success.
All 21 focused mocked tests, repository TypeScript checks, and lint for the
tracer scripts passed in the implementation handoff. These checks establish
local CLI behavior and privacy handling, not live Retell behavior.

**Unverified in this implementation handoff:** account/API-key access, KYC,
payment method and credits, purchased number, live Agent configuration, tunnel
reachability, actual outbound connection, audible acknowledgement, webhook
delivery, and real redacted captures. No real-call evidence has been fabricated.
The parent must run the live sequence, export the four samples, record the actual
observations here, and run `pnpm verify` before calling issue #3 complete.

Mocked checks, after dependencies are installed:

```sh
pnpm exec vitest run scripts/retell-tracer.test.ts
pnpm verify
```

# Retell integration (#6)

The Retell adapter implements VoicePort for Offer, At Risk check, release, and
Escalation calls. The fake port remains the default. Tests never call real phones.

## Configure the server

Use the existing local `.env`; never commit credentials or real phone numbers.

```dotenv
VOICE_MODE=retell
RETELL_API_KEY=<API key for outbound REST calls>
RETELL_WEBHOOK_API_KEY=<API key marked Webhook in the same workspace>
RETELL_FROM_NUMBER=<Retell outbound number>
RETELL_AGENT_ID=<fleet agent, also used for inbound calls>
DRIVER_PHONE_ALEX=<Alex demo phone>
DRIVER_PHONE_CASEY=<Casey demo phone>
DISPATCHER_PHONE=<Dispatcher phone>
PUBLIC_BASE_URL=<public HTTPS tunnel URL>
```

Optional agent IDs per call kind: `RETELL_AGENT_OFFER`,
`RETELL_AGENT_AT_RISK_CHECK`, `RETELL_AGENT_RELEASE`, `RETELL_AGENT_ESCALATION`.
They fall back to `RETELL_AGENT_ID`. Only the three configured demo numbers can be
called. An API key alone does not enable real calling; select `VOICE_MODE=retell`
explicitly. `VOICE_MODE=fake` is the offline development/test mode and has unsigned
local tool endpoints; signed callback verification runs in Retell mode.
`RETELL_WEBHOOK_API_KEY` defaults to `RETELL_API_KEY` when omitted. A key can create
calls successfully while failing callback verification if it is not the key marked
Webhook. Test/explore server helpers force fake mode even when `.env` enables real calls.

Generate the LLM/agent configuration without creating agents or placing calls:

```sh
node --env-file-if-exists=.env scripts/retell-config.ts > artifacts/retell-config.json
```

Apply the generated `llm` fields to a dedicated fleet agent's Retell LLM and the
`agent` fields to that agent. Keep #3's tracer agent separate. Configure the Retell
number's inbound agent to the fleet agent. Keep the custom-function full envelope
(`args_at_root: false`); no API key belongs in the generated configuration.
The prompts are committed in `src/retell/prompts/` and cover all call kinds and
inbound Driver status/Disruption calls. Never treat silence, voicemail, or an
unclear reply after one clarification as acceptance.

Publish the dedicated fleet Agent version before calling: the transport explicitly
selects `latest_published`. For later updates, create a draft from the published
version, update its existing Retell LLM, then publish that draft. Retell rejects
swapping response-engine IDs after versions exist. Keep the same Agent ID in
`.env`. The existing source number's inbound binding points at the fleet Agent's
`latest_published` version.

Generated settings include call-screening identity/purpose, a two-minute call
limit, thirty-second silence allowance, and five-second tool transport timeout.
Backend tool responses still return quickly; the timeout allows network transit.
Automatic voicemail detection is disabled to avoid cutting off screening; the
prompt still treats actual voicemail and unclear replies as Unanswered. Default
string variables permit inbound calls; outbound context overrides them.

## Backend flow

The server verifies `x-retell-signature` against the raw request body before JSON
parsing on both `/tools/:name` and `/webhooks/retell`. Retell requires the API key
marked for webhooks. Modified, unsigned, or expired requests receive 401.
The call envelope and every consumed transcript/context field are validated by
zod. The signed call identifies the Driver; LLM arguments cannot replace its
Driver, Job, or Offer. A previous demo's context cannot accept a new Offer.
Successful tool responses are persisted and replayed verbatim for retries.

The outbound outbox persists calls before acknowledging a tool. A local call ID
returns immediately; background delivery supplies that ID as `reroute_call_id`
and the reset time as `demo_reset_at`, along with the existing string context.
Retell's actual call ID replaces the local Offer call ID after delivery. Retries
use the same provider idempotency key; three unsuccessful attempts are logged for
the Dispatcher. Calls still waiting after Reset demo are cancelled. A call already
accepted by Retell cannot be cancelled by resetting the local scenario.

The event adapter maps `call_ended` to the #5 engine's `markUnanswered(offerId)`
for a matching pending Offer only. An Accepted or Declined Offer is untouched.
`transcript_updated` emits `transcript` SSE events:

```ts
{ callId, kind, driverId, role, text, at, utteranceId }
```

The UI prototype owns transcript rendering. Upsert by `utteranceId` because a
later webhook can revise an existing utterance. The server suppresses duplicate
text, replays its last 200 utterances on SSE reconnect, and clears the transcript
buffer at Reset demo. `call.transcript_object` is preferred, with
`transcript_with_tool_calls` as a fallback; tool entries are not displayed as
speech.

## Verification and remaining live checks

`pnpm verify` runs offline tests, including signed HTTP requests, real HMAC checks,
caller/Offer binding, response replay, reset safety, outbound transport requests,
slow-call queuing, bounded retries, and transcript revisions. No test makes a
Retell API request or places a real call.

The reviewed real payload samples from #3 are in `fixtures/retell/tracer-call`.
They are replayed through signed HTTP, including the streamed transcript at the
envelope root. The capture-only tracer is signature-checked without requiring a
fleet Driver identity and cannot change Jobs; all fleet tools retain identity
binding and replay protection.

The real-phone acceptance criterion of #6 is: Alex reports
a Disruption, Casey receives and accepts an Offer, Alex receives the release call,
and the UI prototype shows the transcript. Do not close #6 on offline tests alone.

## References

- [Retell signature specification](https://docs.retellai.com/features/secure-webhook)
- [Custom-function envelope](https://docs.retellai.com/build/single-multi-prompt/custom-function)
- [Create Phone Call and provider idempotency](https://docs.retellai.com/api-references/create-phone-call)
- [Transcript and call lifecycle webhooks](https://docs.retellai.com/features/webhook-overview)

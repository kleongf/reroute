# Reroute

Voice-first fleet dispatcher, built for a 4-hour hackathon demo. Drivers talk to it only by phone (Retell AI); the Dispatcher watches one dashboard.

- **Vocabulary**: [`GLOSSARY.md`](GLOSSARY.md). Use its terms verbatim in code identifiers, UI labels, and voice-agent prompts.
- **Plan**: [`docs/plan.md`](docs/plan.md). Read before building a feature, changing Placement or Offer behaviour, or touching demo fixtures. It also lists what is out of scope.

## Done

A change is done when `pnpm verify` passes **and** you have exercised the change yourself: for dashboard changes (the React app in `web/`, served at `/`), run `pnpm ui:explore` against `/` and look at the screenshots and console logs; for backend changes, hit the endpoint or send a sample webhook. Usage of both scripts is in [`scripts/README.md`](scripts/README.md).

## Invariants

The voice agent's LLM proposes; the backend authorizes. Every state change goes through a backend tool endpoint that enforces these:

- An assignment changes only on an Accepted Offer that is still the current Offer of the running Placement, after a fresh eligibility recheck, in one transaction.
- Silence, voicemail, or an unclear reply is Unanswered, never Accepted.
- One Placement runs at a time; a Driver with a pending Offer is ineligible elsewhere.
- Every ineligible Driver carries a one-line reason the dashboard can show.
- A Late Job keeps its current Driver until another Driver's Offer is Accepted.

## Retell webhooks

- Retell retries a webhook up to 3 times after a 10 s timeout, so every tool endpoint is idempotent: replaying `accept_offer` or `record_decline` yields the same state.
- Tool endpoints respond fast; slow responses become dead air on the call.
- Call context (Job ID, Driver ID, Offer ID) travels as string dynamic variables and comes back in the tool payload's `call` object.
- Validate every inbound payload with zod before reading it.
- Times spoken by the agent and shown on the dashboard come from the same real clock; fixtures are relative to the last demo reset.

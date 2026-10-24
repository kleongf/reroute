# Real outbound tracer capture

Captured on 2026-10-24 for [issue #3](https://github.com/kleongf/reroute/issues/3).
This is one real outbound phone call, not a generated or replayed request set.

- The recipient joined after call screening and said "Yes" to the tracer test.
- Retell invoked `tracer_ping` with `message: "reroute tracer confirmed"`.
- The backend received the tool request and returned HTTP 200 with
  `{"result":"Tracer received. The backend connection is working."}`.
- Retell recorded the tool result as successful. Its trace spans 29.047 to 29.476
  seconds, approximately 429 ms including transport and backend response.
- The Agent then said the backend acknowledged the test and thanked the recipient.
- The call lasted 33.601 seconds and ended as `agent_hangup`.
- The same call produced one `call_started`, seven `transcript_updated`, one
  `tracer_ping` request, and one `call_ended` in the local capture database. The
  exported transcript is the final received update. No duplicate required
  lifecycle/tool deliveries were observed for this call.

The streamed transcript's `transcript_with_tool_calls` is at the envelope root,
beside `call`. Completed call objects also include transcript fields inside `call`.
This observed difference is covered by an exporter regression test; the HTTP
receiver replays all four real payloads without discarding unknown fields.

The backend was exposed through a temporary Pinggy SSH tunnel. API keys, source
and destination phone numbers, call/Agent/carrier identifiers, recording URLs,
and log URLs were redacted or aliased before these files were reviewed. The raw
database and `.env` remain ignored. Synthetic smoke requests and failed earlier
calls are not included in this set.

`provenance.json` lists the selected database rows and receipt timestamps. A local
database alone does not authenticate Retell origin; the coordinated live call and
Retell's successful tool trace were checked separately. Webhook signature
verification and the fleet voice adapter remain outside this tracer ticket.
Existing workspace KYC and billing settings were not inspected in the dashboard;
the account's existing managed US number successfully placed the call.

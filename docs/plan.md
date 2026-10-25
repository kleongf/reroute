# Reroute — hackathon plan

Status: agreed 2026-10-24. Build window: about 4 hours, team of two. Goal: a strong 3–5 minute live demo.

Pitch: **When plans change, deliveries don't stop.** Drivers never touch a screen; Reroute keeps the delivery plan whole through phone conversations.

Vocabulary is defined in [`GLOSSARY.md`](../GLOSSARY.md); this plan uses those terms exactly.

## Scope

### In

1. **Disruption → Placement.** Two entry points, same outcome:
   - A Driver calls Reroute and reports they can't complete a Job.
   - The Dispatcher injects a simulated traffic event on the dashboard; any Job whose estimated arrival now passes its deadline becomes At Risk, and Reroute makes one check call to its Driver. "I'll make it" clears At Risk (dashboard notes "Driver confirmed"); "I can't" is a Disruption.
2. **Urgent Job.** The Dispatcher adds a Job on the dashboard form with a High/Normal tier; Reroute queues a Placement for it.
3. **Driver status by voice.** Drivers report remaining capacity and availability, either in their own call or as the reason they decline an Offer.

### Stretch goals, in order

1. ETAs from a routing service (OSRM or Mapbox) on the fixture coordinates.
2. Animated vehicle movement along routes, labelled "simulated".

### Out

Phone screen automation, live GPS, notifying anyone outside the fleet (shops, recipients), syncing with an external delivery system, splitting a Job across Drivers, cascading re-Placements, Placement pre-emption, scalability benchmarks, baseline comparisons.

## Behaviour

### Disruption

- The Driver's word decides. Reroute confirms which Job they mean ("the two-parcel Oak Street pickup due by 3?") and records their stated reason.
- If it is unclear whether the parcels are collected, Reroute asks. Collected parcels → skip Placement and escalate straight to the Dispatcher ("needs a physical handoff").
- The Job becomes Late and stays with its current Driver. The call ends with: "Keep going; I'll call you if someone takes it over."

### Placement

- One Placement runs at a time, taken from the Placement Queue by Priority: tier (High/Normal), then earliest deadline, then queued time. Disruption Placements are High. Priority is fixed at queue time; a running Placement always finishes before the next starts.
- Eligibility, all required: availability window covers Pickup through drop-off; free capacity ≥ parcel count; fixture ETA to Pickup + service + trip meets the deadline; no pending Offer elsewhere. Every ineligible Driver gets a one-line reason shown on the dashboard ("off at 3:00", "1 slot < 2 parcels").
- Rank Eligible Drivers by ETA to Pickup; ties by Driver ID.
- Offers go one at a time by outbound call. An Offer states Job, Pickup location, deadline, and parcel count.
- Declined with a reason → update that Driver's record (capacity/availability), then re-rank before the next Offer. Unanswered (voicemail, no pickup, unclear after one clarification) → call the same Driver once more after `OFFER_RETRY_MS` (default 20 s); a second Unanswered → next Driver. A decline is final: each Driver gets at most one answered Offer and two calls per Placement.
- Accepted → recheck eligibility and versions, commit the assignment in one transaction → Placed. Reroute then calls the previous Driver (if any): "Casey has the Oak Street job; you're off it."
- No Eligible Driver left → Escalated: Reroute calls the Dispatcher with one sentence. A Late Job stays with its current Driver.

## Demo

- Fixture data: six Drivers, positions in a real city, ETAs from a fixed table. Only the two Drivers with real phones (Alex, Casey) can ever be Eligible; every other Driver is ineligible for a visible reason. Blair is the exception: a fixture Driver whose Offer is a **simulated Offer**, auto-declined with "my van’s full" (capacity becomes 0) and labelled *simulated* on the dashboard.
- One phone number = one Driver; inbound callers are identified by caller ID.
- All times are relative to the moment "Reset demo" is pressed, on the real clock.
- Map and dashboard label provenance: "simulated positions", "simulated traffic", "fixture ETA".

### “The deadline Job”: one Disruption, start to finish

The title is not a hardcoded 3:00 deadline: the dashboard and voice agent always
use reset + 60 minutes on the real clock, in Pacific time. Reset immediately before
presenting. Target 3–5 minutes including ringing; the beat timings below are a
rehearsal budget, not measured real-phone timings.

Alex is returning from an earlier stop on US-101 north near Cesar Chavez, before
J17's Pickup. An accident blocks **Alex's approach**, adding 40 minutes only to
Alex. Casey is on surface streets near Civic Center; Casey's approach and the
Oak Street → Mission Bay leg are unaffected by this simulated event. The parcels
are still at the Pickup: this is a Placement, not a physical handoff.

Presenter: **“The closure blocks Alex before Pickup. Casey can reach the same
Pickup without that delay.”** Map lines are illustrative connections, not computed
road routes or proof that a real route avoids traffic; fixture ETA and simulated
traffic labels stay visible. Use `ROUTING=off` for this scripted scenario.

| Budget | Action | Audience sees |
|---|---|---|
| 0:00–0:20 | Introduce J17, two parcels, Oak Street Florist → Mission Bay Clinic, held by Alex | Six Drivers; estimated arrival and actual deadline; Alex's simulated marker held near Cesar Chavez |
| 0:20–0:40 | Inject “US-101 north closed at Cesar Chavez” | Short red closure ahead of Alex; old estimate struck through → new estimate; Alex +40 min; J17 At Risk |
| 0:40–1:15 | Check call: Alex says “No, I can’t make it. I’m stuck before Pickup. I haven’t collected the parcels.” | Live transcript; At Risk → Late; Alex still holds J17 |
| 1:15–1:35 | Rank Eligible Drivers; Blair's simulated Offer declines “my van’s full” | All ineligibility reasons; Blair capacity 0; simulated label; dashed Offer line switches to Casey |
| 1:35–2:15 | Casey says “Yes, I’ll take it” to the Offer | Casey's unaffected approach ETA, parcels and deadline; only acceptance makes J17 Placed and its assignment line solid green |
| 2:15–2:45 | Reroute calls Alex: “Casey has the Oak Street Job; you’re off it.” | Before/after arrival against the deadline; Disruption → Placed elapsed time; release notification |
| Optional, through 4:00 | Add the Urgent Job below; Alex accepts | Same Placement engine with a more generous deadline, keeping Alex's +40 minutes |

Closing sequence: **Traffic detected → Driver checked → capacity checked → Offer
Accepted → previous Driver notified.** Only a release-call transcript is evidence
for the final “notified” step; Placed alone does not prove Alex answered. Do not
label the flow a physical handoff or a completed delivery.

### Rehearsal and backup

- Confirm the Pickup is still uncollected. A collected Job goes to the Dispatcher
  for a physical handoff instead of this Placement story.
- Test Alex/Casey speakerphone volume through the venue mic; rehearse three timed
  real-phone runs. Silence, voicemail, or unclear speech stays Unanswered.
- Use the real spoken deadline, never an invented “three o’clock”.
- Keep all simulated labels visible, including Blair's Offer and illustrative map
  lines. Do not imply customer notification; it remains out of scope.
- Record an offline run with a persistent **Recorded demo · simulated calls** label
  as a fallback. It exercises real backend commands with fake VoicePort and scripted
  transcript webhooks; it is not evidence of successful live calls. If live calling
  fails, announce the recorded fallback rather than silently switching.
- A recording can be shortened for a cold open; publish its actual duration and
  speed, and keep the uncut version. Phone rehearsal and call credit still belong
  to #10 and must be reported truthfully.

Urgent Job to type on stage (exactly; covered by `src/demo/demo-story.test.ts`):

| Field | Value |
|---|---|
| Label | Hospital samples |
| Pickup | SF General Lab (37.7557, -122.4048) |
| Drop-off | Mission Bay Clinic (37.7684, -122.3912) |
| Parcels | 2 |
| Deadline | 90 min from now |
| Tier | high |

Why Alex gets it: 2 parcels rules out Casey (1 slot left after J17) and Blair (0 slots after her simulated decline); Dana is off at reset + 20 min, Eli has 0 slots, Fran has no phone. Alex still carries the US-101 +40 min, so the 90-minute deadline is what keeps him in. Typing 1 parcel sends the Offer to Casey instead.

Escalation is covered by tests, not shown live.

## Stack

- Node/TypeScript (strict), Hono, SQLite, zod for webhook payloads, server-sent events to one dashboard page with a Leaflet + OpenStreetMap map that expands to full screen.
- Voice: Retell AI. One US number bought in Retell (needs a card; the $10 trial credit covers call minutes, about 65–75 min). Outbound calls need the account's KYC completed.
- Retell calls the backend from its cloud, so the backend runs behind cloudflared or ngrok.

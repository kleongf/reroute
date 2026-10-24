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
- Declined with a reason → update that Driver's record (capacity/availability), then re-rank before the next Offer. Unanswered (voicemail, no pickup, unclear after one clarification) → next Driver. Each Driver gets one Offer per Placement.
- Accepted → recheck eligibility and versions, commit the assignment in one transaction → Placed. Reroute then calls the previous Driver (if any): "Casey has the Oak Street job; you're off it."
- No Eligible Driver left → Escalated: Reroute calls the Dispatcher with one sentence. A Late Job stays with its current Driver.

## Demo

- Fixture data: six Drivers, positions in a real city, ETAs from a fixed table. Only the two Drivers with real phones (Alex, Casey) can ever be Eligible; every other Driver is ineligible for a visible reason. Blair is the exception: a fixture Driver whose Offer is a **simulated Offer**, auto-declined with "only room for one" and labelled *simulated* on the dashboard.
- One phone number = one Driver; inbound callers are identified by caller ID.
- All times are relative to the moment "Reset demo" is pressed, on the real clock.
- Map and dashboard label provenance: "simulated positions", "simulated traffic", "fixture ETA".

Draft run order (expect revisions):

| Time | Action | Audience sees |
|---|---|---|
| 0:00–0:30 | Dashboard tour | Six Drivers on the map, Alex on J17 |
| 0:30–1:30 | Inject "I-280 closed"; Reroute calls Alex, who can't make it | J17 At Risk → Late; live transcript |
| 1:30–2:30 | Placement: ranking with reasons; Blair's simulated Offer declined; Reroute calls Casey, who accepts | Pending Offer → Placed; Blair's capacity updates |
| 2:30–3:00 | Reroute calls Alex back | Assignment line moves Alex → Casey; elapsed time Disruption → Placed |
| 3:00–4:00 | Dispatcher adds an Urgent Job; Reroute calls Alex, who accepts | Queue, Placement, Placed |

Escalation is covered by tests, not shown live.

## Stack

- Node/TypeScript (strict), Hono, SQLite, zod for webhook payloads, server-sent events to one dashboard page with a Leaflet + OpenStreetMap map that expands to full screen.
- Voice: Retell AI. One US number bought in Retell (needs a card; the $10 trial credit covers call minutes, about 65–75 min). Outbound calls need the account's KYC completed.
- Retell calls the backend from its cloud, so the backend runs behind cloudflared or ngrok.

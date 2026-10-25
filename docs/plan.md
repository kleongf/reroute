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

- Fixture data: six Drivers, positions in a real city, ETAs from a fixed table. Only the two Drivers with real phones (Alex, Casey) can ever be Eligible; every other Driver is ineligible for a visible reason. Blair is the exception: a fixture Driver whose Offer is a **simulated Offer**, auto-declined with "only room for one" and labelled *simulated* on the dashboard.
- One phone number = one Driver; inbound callers are identified by caller ID.
- All times are relative to the moment "Reset demo" is pressed, on the real clock.
- Map and dashboard label provenance: "simulated positions", "simulated traffic", "fixture ETA".

Run of show (timings measured on real calls, 2026-10-24; about 3:30 total, fits a 3–5 minute slot). Roles: **Presenter** drives the laptop and narrates; **Phones** holds Alex's and Casey's phones on speaker next to the mic and answers each call.

| Time | Presenter does / says | Phones | Audience sees |
|---|---|---|---|
| 0:00–0:25 | "Small fleets lose deadlines when one driver gets stuck. Reroute is a dispatcher you only talk to." Point at the map: six Drivers, Alex on the Oak Street pickup, due in an hour. | — | "All Jobs on track"; Drivers moving (simulated movement) |
| 0:25–0:35 | **Inject traffic → I-280 closed.** "A closure just put Alex's pickup at risk. Nobody called anyone yet." | — | Red closure on the map; banner "J17 At Risk · checking with Alex"; Disruption card "Late by N min with Alex" |
| 0:35–0:55 | "Reroute calls Alex first. His word decides." | **Alex** answers (rings ~5 s; call ~16 s): "No, I can't make it." → "Haven't picked them up." | Live transcript in the call card; banner turns Late |
| 0:55–1:10 | "It ranks every Driver and says why the others can't." Point at the crossed-out list. | — | Placement card: Casey ranked; Dana "off at…", Eli "0 slots", Fran "arrives … >"; Blair's **simulated Offer** declines "only room for one" after ~4 s and her capacity drops |
| 1:10–1:35 | "Now it offers the Job to Casey, with what she needs to decide." | **Casey** answers (rings ~5 s; call ~20 s): hears minutes to pickup, drop-off, minutes to spare → "Yes." | Dashed "awaiting acceptance" line → solid green; banner "J17 fixed · Casey has it, on time"; toast "J17 fixed in m:ss"; before → after on the card |
| 1:35–1:45 | "And Alex is told he's off it." | **Alex** release call (~6 s): "It's Reroute. Casey has the Oak Street pickup; you're off it." | Tally "Disruptions fixed: 1 · avg time to fix" |
| 1:45–2:10 | "New work arrives the same way." **+ Urgent Job** (prefilled with the values below) → Add. | — | Urgent Job appears with no Driver; Placement with reasons: Casey and Blair out on capacity |
| 2:10–2:35 | "It goes to the one Driver who can still do it." | **Alex** answers the Offer (~20 s): "Yes." | Hospital samples Placed with Alex |
| 2:35–3:30 | Recap: two phone conversations, no app, every decision explained on screen; the agent proposes, the backend authorizes. Point at the provenance strip: positions, traffic and Blair are simulated; calls are real. | Hold phones up | Final dashboard |

If a phone misses an Offer, Reroute calls the same Driver again after 20 s (`OFFER_RETRY_MS`): keep talking ("it retries once before moving on"). If Casey misses both, J17 escalates; reset and rerun, or play the backup recording.

### Before each recording or live run

1. Phones: **Do Not Disturb / Focus off**, Silence Unknown Callers off, the Retell number saved as a contact, ringer and speaker on, charged.
2. `.env`: `VOICE_MODE=retell`, `ROUTING` unset (the run order assumes fixture ETAs), `DISPATCHER_PHONE` a real person's phone (never the Retell number).
3. Start `ngrok http --url=<static domain> 3000` and the server; `pnpm retell:point` must report 0 changes.
4. Browser: Chrome, its own window, full screen (⌃⌘F), zoom 100% at 1920×1080 (or 1280×800 for the projector), bookmarks bar and extensions hidden, map tiles loaded (needs internet). Mac Do Not Disturb **on** so no notifications appear.
5. Press **Reset demo** last, within a few minutes of starting: deadlines count from the reset.

### Recording

- Record the screen and the room mic together (QuickTime or OBS); the calls are heard through the phone speakers. Optional: an OBS camera source on the two phones in a corner.
- Do one full take; never cut out a call (the timer and toast show real elapsed time). Label the file **"Recorded backup"** and say so if it's played instead of a live run.
- After each take: `pnpm retell:calls --limit 5` (every tool result ✅), then Reset demo before the next take.

Urgent Job to type on stage (exactly; covered by `src/demo/demo-story.test.ts`):

| Field | Value |
|---|---|
| Label | Hospital samples |
| Pickup | SF General Lab (37.7557, -122.4048) |
| Drop-off | Mission Bay Clinic (37.7684, -122.3912) |
| Parcels | 2 |
| Deadline | 90 min from now |
| Tier | high |

Why Alex gets it: 2 parcels rules out Casey (1 slot left after J17) and Blair (1 slot after her simulated decline); Dana is off at reset + 20 min, Eli has 0 slots, Fran has no phone. Alex still carries the I-280 +40 min, so the 90-minute deadline is what keeps him in. Typing 1 parcel sends the Offer to Casey instead.

Escalation is covered by tests, not shown live.

## Stack

- Node/TypeScript (strict), Hono, SQLite, zod for webhook payloads, server-sent events to one dashboard page with a Leaflet + OpenStreetMap map that expands to full screen.
- Voice: Retell AI. One US number bought in Retell (needs a card; the $10 trial credit covers call minutes, about 65–75 min). Outbound calls need the account's KYC completed.
- Retell calls the backend from its cloud, so the backend runs behind cloudflared or ngrok.

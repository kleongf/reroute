# Reroute

Reroute is a voice-first dispatcher for delivery fleets: when a driver can't complete a job, it finds and confirms a replacement through conversation, with no screen required for drivers.

## Language

### People

**Operator**:
The delivery business that runs Reroute as its delivery system.
_Avoid_: Customer, client, fleet owner

**Dispatcher**:
The Operator's human staff member who adds urgent Jobs and is called when Reroute cannot find a Driver.
_Avoid_: Owner, admin, manager

**Driver**:
A person who carries out Jobs and talks to Reroute by voice only, never through a screen.
_Avoid_: Courier, rider

### Work

**Job**:
One unit of delivery work: a pickup location, a drop-off location, a parcel count, and a delivery deadline.
_Avoid_: Order, delivery, task, pickup (when meaning the whole job)

**Pickup**:
The first stop of a Job, where the parcels are collected. A Job is "uncollected" until its Pickup is done.
_Avoid_: Collection

**Disruption**:
A Driver's report that they cannot complete a Job they hold. The Driver's word is authoritative; Reroute does not second-guess whether the Job is still feasible for them.
_Avoid_: Delay report, incident, exception

**At Risk**:
A Job whose Driver, by Reroute's estimate, may miss its deadline (for example after a traffic event). Reroute calls the Driver to check; only the Driver's answer turns it into a Disruption.
_Avoid_: Delayed, flagged

**Late**:
A Job whose current Driver has reported a Disruption but which has not yet been Placed with another Driver; the current Driver keeps it until then.
_Avoid_: Unassigned, orphaned

**Urgent Job**:
A Job the Dispatcher adds that has no Driver yet and needs one now.
_Avoid_: Rush order, new order

### Finding a Driver

**Placement**:
The process of finding a Driver who accepts a Job, by making Offers one at a time. Ends as Placed or Escalated.
_Avoid_: Reassignment (a Placement may have no previous Driver), matching, dispatch

**Priority**:
A Placement's place in line: its tier (High or Normal), then its Job's deadline, then the time it was queued. Fixed when queued. Placements started by a Disruption are always High; the Dispatcher picks the tier for an Urgent Job.
_Avoid_: Urgency, severity

**Placement Queue**:
The waiting line of Placements, ordered by Priority. Only one Placement runs at a time; a higher Priority never interrupts a running one.
_Avoid_: Backlog, pipeline

**Eligible**:
A Driver who can take a Job: available for the whole Job, with enough free capacity, and able to meet the deadline. Every ineligible Driver has a one-line reason.
_Avoid_: Candidate (when meaning any Driver), qualified

**Offer**:
One spoken proposal of one Job to one Driver. Ends as Accepted, Declined, or Unanswered; silence or an unclear reply is never acceptance.
_Avoid_: Request, ask, proposal

**Unanswered**:
An Offer that reached voicemail, was not picked up, or got no clear answer after one clarification. The Driver is called once more after a short delay; a second Unanswered is treated like a Decline without a reason.
_Avoid_: Timeout, missed

**Escalation**:
The end of a Placement in which no eligible Driver accepted, so Reroute calls the Dispatcher with a one-sentence explanation.
_Avoid_: Failure, exception

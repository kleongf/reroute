import { describe, expect, it } from 'vitest';
import type { StateSnapshot } from '@backend/domain/types.ts';
import { banner, disruptionModel } from './model.ts';

const at = (min: number) => new Date(Date.UTC(2026, 9, 24, 14, min)).toISOString();

/** J17 was fixed by Casey at 14:02; the Urgent Job U1 is then offered to Alex. */
function snapshot(u1: { status: 'running' | 'placed'; offer: 'pending' | 'accepted' }) {
  return {
    now: at(5),
    drivers: [
      { id: 'alex', name: 'Alex' },
      { id: 'casey', name: 'Casey' },
    ],
    jobs: [
      { id: 'J17', label: 'Oak Street pickup', status: 'assigned', driverId: 'casey' },
      {
        id: 'U1',
        label: 'Hospital samples',
        status: u1.status === 'placed' ? 'assigned' : 'unassigned',
        driverId: u1.status === 'placed' ? 'alex' : null,
      },
    ],
    placements: [
      {
        id: 'P1',
        jobId: 'J17',
        trigger: 'disruption',
        status: 'placed',
        endedAt: at(2),
        offers: [],
      },
      {
        id: 'P2',
        jobId: 'U1',
        trigger: 'urgent_job',
        status: u1.status,
        endedAt: u1.status === 'placed' ? at(4) : null,
        offers: [{ id: 'O3', driverId: 'alex', status: u1.offer }],
      },
    ],
    disruptions: [
      {
        placementId: 'P1',
        jobId: 'J17',
        status: 'placed',
        endedAt: at(2),
        after: { driverId: 'casey', minutesLate: -30 },
      },
    ],
    forecasts: [],
  } as unknown as StateSnapshot;
}

describe('banner', () => {
  it('announces the running Urgent Job, not the earlier fixed Disruption', () => {
    const b = banner(disruptionModel(snapshot({ status: 'running', offer: 'pending' })));
    expect(b.text).toBe('U1 Hospital samples · offering to Alex');
  });

  it('announces the most recently Placed Urgent Job once it lands', () => {
    const b = banner(disruptionModel(snapshot({ status: 'placed', offer: 'accepted' })));
    expect(b).toMatchObject({ tone: 'fixed', text: 'U1 Hospital samples · Alex has it' });
  });
});

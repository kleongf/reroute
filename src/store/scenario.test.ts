import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../testing/harness.ts';

describe('demo scenario', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(() => {
    h.close();
  });

  it('loads six Drivers with J17 on Alex, due 60 minutes after reset', async () => {
    const s = await h.state();
    expect(s.drivers).toHaveLength(6);
    const j17 = s.jobs.find((j) => j.id === 'J17');
    expect(j17).toMatchObject({ driverId: 'alex', status: 'assigned', parcels: 2 });
    expect(j17?.deadline).toBe('2026-10-24T15:00:00.000Z');
  });

  it('takes phone numbers from the phone book; fixture-only Drivers have none', async () => {
    const s = await h.state();
    const phone = (id: string) => s.drivers.find((d) => d.id === id)?.phone;
    expect(phone('alex')).toBe('+15550000001');
    expect(phone('casey')).toBe('+15550000002');
    expect(phone('dana')).toBeNull();
    expect(s.drivers.find((d) => d.id === 'blair')?.simulated).toBe(true);
  });

  it('reset reloads the scenario relative to the current time', async () => {
    h.clock.advance(30 * 60_000);
    const res = await h.post('/api/reset');
    expect(res.status).toBe(200);
    const s = await h.state();
    expect(s.resetAt).toBe('2026-10-24T14:30:00.000Z');
    expect(s.jobs.find((j) => j.id === 'J17')?.deadline).toBe('2026-10-24T15:30:00.000Z');
  });
});

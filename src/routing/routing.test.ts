import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StateSnapshot } from '../domain/types.ts';
import { createHarness, type Harness } from '../testing/harness.ts';
import { createOsrmRouting } from './osrm.ts';
import { createFakeRouting } from './port.ts';
import { attachRoutedEtas } from './refresh.ts';

const urgent = {
  label: 'Hospital samples',
  pickup: { name: 'SF General Lab' },
  dropoff: { name: 'Mission Bay Clinic' },
  parcels: 1,
  deadlineOffsetMin: 60,
  tier: 'normal',
};

describe('routed ETAs', () => {
  let h: Harness;

  beforeEach(() => {
    h = createHarness();
  });

  afterEach(() => {
    h.close();
  });

  it('labels every ETA fixture when routing is off', async () => {
    const s = await h.state();
    expect(s.etas.minutes['alex']?.['J17']).toBe(10);
    expect(s.etas.source['alex']?.['J17']).toBe('fixture');
    expect(Object.values(s.etas.source).flatMap(Object.values)).not.toContain('routed');
  });

  it('replaces fixture ETAs with routed ones in the background, and again after reset', async () => {
    const routing = createFakeRouting(() => 7);
    const r = attachRoutedEtas(h.store, routing);
    await r.settled();
    let s = await h.state();
    expect(s.etas.minutes['fran']?.['J19']).toBe(7);
    expect(s.etas.source['fran']?.['J19']).toBe('routed');
    expect(routing.calls).toHaveLength(6 * 3);

    h.clock.advance(60_000);
    const reset = await h.post('/api/reset');
    expect((reset.body as StateSnapshot).etas.source['fran']?.['J19']).toBe('fixture');
    await r.settled();
    s = await h.state();
    expect(s.etas.source['fran']?.['J19']).toBe('routed');
    expect(routing.calls).toHaveLength(2 * 6 * 3);
  });

  it('routes a new Urgent Job without delaying its response', async () => {
    const waiting: (() => void)[] = [];
    const release = () => {
      for (const resolve of waiting.splice(0)) resolve();
    };
    const r = attachRoutedEtas(h.store, {
      minutes: async () => {
        await new Promise<void>((resolve) => waiting.push(resolve));
        return 3;
      },
    });
    release();
    await r.settled();
    const res = await h.post('/api/jobs', urgent);
    expect(res.status).toBe(201);
    const jobId = (res.body as { jobId: string }).jobId;
    // Response carries the straight-line ETA; the routed one lands afterwards.
    expect((res.body as { state: StateSnapshot }).state.etas.source['alex']?.[jobId]).toBe(
      'fixture',
    );
    release();
    await r.settled();
    const s = await h.state();
    expect(s.etas.minutes['alex']?.[jobId]).toBe(3);
    expect(s.etas.source['alex']?.[jobId]).toBe('routed');
  });

  it('keeps fixture ETAs when routing fails', async () => {
    const r = attachRoutedEtas(
      h.store,
      createFakeRouting((from) => {
        if (from.lat > 37.77) throw new Error('timeout');
        return 2;
      }),
    );
    await r.settled();
    const s = await h.state();
    // Casey (37.7793) failed → fixture; Alex (37.7599) routed.
    expect(s.etas.minutes['casey']?.['J17']).toBe(9);
    expect(s.etas.source['casey']?.['J17']).toBe('fixture');
    expect(s.etas.source['alex']?.['J17']).toBe('routed');
  });

  it('drops answers that arrive after a reset', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const r = attachRoutedEtas(h.store, {
      minutes: async () => {
        await gate;
        return 99;
      },
    });
    h.clock.advance(60_000);
    await h.post('/api/reset');
    release();
    await r.settled();
    const s = await h.state();
    // Only the post-reset run may write; both resolve to 99 but the stale one is ignored.
    expect(s.etas.source['alex']?.['J17']).toBe('routed');
    expect(s.etas.minutes['alex']?.['J17']).toBe(99);
  });
});

describe('OSRM routing', () => {
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('parses route and table durations into whole minutes', async () => {
    const urls: string[] = [];
    const osrm = createOsrmRouting({
      fetch: (url) => {
        const href = url instanceof Request ? url.url : url.toString();
        urls.push(href);
        return href.includes('/table/')
          ? json({ code: 'Ok', durations: [[61, null]] })
          : json({ code: 'Ok', routes: [{ duration: 600 }] });
      },
    });
    const a = { lat: 37.76, lng: -122.41 };
    const b = { lat: 37.78, lng: -122.42 };
    expect(await osrm.minutes(a, b)).toBe(10);
    expect(await osrm.table?.([a], [b, a])).toEqual([[2, null]]);
    expect(urls[0]).toBe(
      'https://router.project-osrm.org/route/v1/driving/-122.41,37.76;-122.42,37.78?overview=false',
    );
    expect(urls[1]).toContain('sources=0&destinations=1;2');
  });

  it('rejects on HTTP errors and non-Ok codes', async () => {
    const a = { lat: 0, lng: 0 };
    await expect(createOsrmRouting({ fetch: () => json({}, 429) }).minutes(a, a)).rejects.toThrow(
      '429',
    );
    await expect(
      createOsrmRouting({ fetch: () => json({ code: 'NoRoute' }) }).minutes(a, a),
    ).rejects.toThrow('NoRoute');
  });
});

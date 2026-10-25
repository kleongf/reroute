import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { World } from '../domain/types.ts';

const latLng = z.object({ lat: z.number(), lng: z.number() });
const place = latLng.extend({ name: z.string().min(1) });

const scenarioSchema = z.object({
  drivers: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      /** Environment variable holding this Driver's real phone number; null = never callable. */
      phoneEnv: z.string().min(1).nullable(),
      simulated: z.boolean(),
      position: latLng,
      holdPosition: z.boolean().optional(),
      capacity: z.number().int().min(0),
      availableFromOffsetMin: z.number(),
      availableUntilOffsetMin: z.number(),
    }),
  ),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      pickup: place,
      dropoff: place,
      parcels: z.number().int().positive(),
      deadlineOffsetMin: z.number(),
      serviceMinutes: z.number().min(0),
      tripMinutes: z.number().min(0),
      driverId: z.string().min(1).nullable(),
    }),
  ),
  etaMinutes: z.record(z.string(), z.record(z.string(), z.number().min(0))),
  trafficEvents: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      path: z.array(z.tuple([z.number(), z.number()])),
      addedMinutes: z.record(z.string(), z.number()),
    }),
  ),
});

export type Scenario = z.infer<typeof scenarioSchema>;

export function parseScenario(raw: unknown): Scenario {
  return scenarioSchema.parse(raw);
}

export function readScenarioFile(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, 'utf8')));
}

/** Real phone numbers, keyed by the env var names the scenario references. */
export type PhoneBook = Readonly<Record<string, string | undefined>>;

/** Builds a fresh World with every time relative to `now`. */
export function loadScenario(scenario: Scenario, now: Date, phones: PhoneBook): World {
  const at = (offsetMin: number) => new Date(now.getTime() + offsetMin * 60_000).toISOString();
  const nowIso = now.toISOString();
  return {
    resetAt: nowIso,
    drivers: scenario.drivers.map((d) => ({
      id: d.id,
      name: d.name,
      phone: d.phoneEnv === null ? null : (phones[d.phoneEnv] ?? null),
      simulated: d.simulated,
      position: d.position,
      ...(d.holdPosition === undefined ? {} : { holdPosition: d.holdPosition }),
      capacity: d.capacity,
      availableFrom: at(d.availableFromOffsetMin),
      availableUntil: at(d.availableUntilOffsetMin),
      version: 1,
    })),
    jobs: scenario.jobs.map((j) => ({
      id: j.id,
      label: j.label,
      pickup: j.pickup,
      dropoff: j.dropoff,
      parcels: j.parcels,
      deadline: at(j.deadlineOffsetMin),
      serviceMinutes: j.serviceMinutes,
      tripMinutes: j.tripMinutes,
      driverId: j.driverId,
      collected: false,
      status: j.driverId === null ? 'unassigned' : 'assigned',
      note: null,
      version: 1,
    })),
    placements: [],
    offers: [],
    evaluations: {},
    etaMinutes: scenario.etaMinutes,
    trafficEvents: scenario.trafficEvents,
    activeTrafficIds: [],
    log: [{ at: nowIso, text: 'Demo reset' }],
  };
}

import { z } from 'zod';

/**
 * The `POST /api/jobs` body. Schema-only (no server imports) so the `web/` Urgent Job dialog
 * validates with exactly what the backend enforces.
 */

/** Default points when the form gives only a name: central SF, near the fixture. */
const DEFAULT_PICKUP = { lat: 37.7749, lng: -122.4194 };
const DEFAULT_DROPOFF = { lat: 37.7689, lng: -122.4012 };

const place = (fallback: { lat: number; lng: number }) =>
  z
    .object({
      name: z.string().trim().min(1, 'name is required'),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    })
    .transform((p) => ({ name: p.name, lat: p.lat ?? fallback.lat, lng: p.lng ?? fallback.lng }));

export const urgentJobSchema = z.object({
  label: z.string().trim().min(1, 'label is required'),
  pickup: place(DEFAULT_PICKUP),
  dropoff: place(DEFAULT_DROPOFF),
  parcels: z.number().int().min(1, 'parcels must be at least 1').max(50),
  deadlineOffsetMin: z
    .number()
    .int()
    .min(1, 'deadline must be in the future')
    .max(24 * 60),
  tier: z.enum(['high', 'normal']),
});

/** What a client sends (before the place defaults are filled in). */
export type UrgentJobBody = z.input<typeof urgentJobSchema>;

/** One line per issue, e.g. `label: label is required; parcels: ...`. */
export function formatUrgentJobIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

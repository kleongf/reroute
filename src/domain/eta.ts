import type { LatLng } from './types.ts';

/** Fixed city speed for Urgent Job ETAs (labelled "fixture ETA" on the dashboard). */
export const CITY_SPEED_KMH = 20;

/** Straight-line (haversine) distance in kilometres. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Whole minutes (rounded up, at least 1) to cover the straight line at city speed. */
export function etaMinutesBetween(a: LatLng, b: LatLng): number {
  return Math.max(1, Math.ceil((distanceKm(a, b) / CITY_SPEED_KMH) * 60));
}

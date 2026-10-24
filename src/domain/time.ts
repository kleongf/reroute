/** The demo fleet runs in San Francisco; spoken and displayed times use its local time. */
export const DEMO_TIME_ZONE = 'America/Los_Angeles';

/** "3:00 PM": the form the voice agent speaks and the dashboard shows. */
export function spokenTime(iso: string, timeZone: string = DEMO_TIME_ZONE): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  });
}

export function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/**
 * Reads a time a Driver said ("4", "4 PM", "16:30", or ISO) as an ISO time on `now`'s demo
 * day; a bare hour is its next occurrence. Null if unreadable.
 */
export function parseSpokenTime(
  text: string,
  now: Date,
  timeZone: string = DEMO_TIME_ZONE,
): string | null {
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*([ap])?\.?\s*m?\.?\s*$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  const meridiem = m[3]?.toLowerCase();
  if (hour > 23 || minute > 59) return null;
  if (meridiem === 'p' && hour < 12) hour += 12;
  if (meridiem === 'a' && hour === 12) hour = 0;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  // Offset of the demo zone from UTC right now, in minutes.
  const zoneAsUtc = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
  );
  const offsetMin = Math.round((zoneAsUtc - Math.floor(now.getTime() / 60_000) * 60_000) / 60_000);
  const localMidnight = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
  );
  const at = (h: number) => localMidnight + (h * 60 + minute - offsetMin) * 60_000;
  // A bare "4" means the next 4 o'clock: AM if that is still ahead today, else PM.
  const ms = !meridiem && hour < 12 && at(hour) < now.getTime() ? at(hour + 12) : at(hour);
  return new Date(ms).toISOString();
}

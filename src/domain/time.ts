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

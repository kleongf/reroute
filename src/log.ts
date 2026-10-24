type Level = 'info' | 'warn' | 'error';

/** One JSON object per line, so server logs are grep- and agent-friendly. */
export function log(
  level: Level,
  msg: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields });
  if (level === 'info') {
    console.log(line);
  } else {
    console.error(line);
  }
}

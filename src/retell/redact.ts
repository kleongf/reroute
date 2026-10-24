/** JSON-only redaction; aliases are scoped to an export, never persisted as a lookup table. */
export type RedactedJson =
  null | boolean | number | string | RedactedJson[] | { [key: string]: RedactedJson };

const sensitiveKey =
  /(?:authorization|credential|secret|password|passwd|signature|apikey|token|privatekey|cookie)/i;
const phoneKey = /(?:phone|fromnumber|tonumber|transferdestination|callerid)/i;
const urlKey = /(?:url|uri)$/i;
const idKey =
  /^(?:(?:call|agent|llm|conversation|tool_call|tool_call_invocation|account|workspace|session)_id|(?:twilio|telnyx)_[a-z_]*(?:sid|id))$/;
const phonePattern = /\+?\d[\d\s().-]{5,}\d/g;
const spokenPhonePattern =
  /\b(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){6,14}\b/gi;
const urlPattern = /(?:https?:\/\/|s3:\/\/|wss?:\/\/|sip:)[^\s<>"'\\]+/gi;
const emailPattern = /[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

function isPhone(value: string): boolean {
  const count = value.replace(/\D/g, '').length;
  // Preserve ISO dates and timestamps; phone-sensitive fields are handled separately.
  // Also mask runs containing several adjacent numbers, rather than leaking an entire
  // candidate merely because its combined digit count exceeds E.164's limit.
  return count >= 7 && !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value);
}

/**
 * Build once for all samples from a call so identifiers and phones correlate across files.
 * Object keys, arrays, scalar types, nulls, and timing metrics retain their JSON shapes.
 * This is a redaction aid: names, addresses and unusual spoken PII still need human review.
 */
export function createRetellRedactor(
  payloads: readonly unknown[],
): (payload: unknown) => RedactedJson {
  const secrets = new Set<string>();
  const identifiers = new Map<string, string>();
  const aliases = new Map<string, string>();
  const counts = new Map<string, number>();

  function alias(kind: string, value: string): string {
    const lookup = `${kind}:${value}`;
    const existing = aliases.get(lookup);
    if (existing) return existing;
    const next = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, next);
    const replacement = `[${kind}_${String(next)}]`;
    aliases.set(lookup, replacement);
    return replacement;
  }

  function collect(value: unknown, key = '', sensitive = false): void {
    const hidden = sensitive || sensitiveKey.test(normalizedKey(key));
    if (typeof value === 'string') {
      if (hidden && value.length > 0) secrets.add(value);
      if (idKey.test(key) && value.length > 0) {
        identifiers.set(value, alias(key.replace(/_id$/, ''), value));
      }
      // Dynamic variables and tool arguments can contain JSON serialized as a string.
      if (/^\s*[[{]/.test(value)) {
        try {
          collect(JSON.parse(value) as unknown, key, hidden);
        } catch {
          /* Plain text. */
        }
      }
    } else if (Array.isArray(value)) {
      for (const entry of value as unknown[]) collect(entry, key, hidden);
    } else if (value !== null && typeof value === 'object') {
      for (const [childKey, child] of Object.entries(value)) collect(child, childKey, hidden);
    }
  }
  for (const payload of payloads) collect(payload);
  const replacements = [...secrets].sort((a, b) => b.length - a.length);
  const ids = [...identifiers].sort(([a], [b]) => b.length - a.length);

  function text(value: string, key: string): string {
    if (/^\s*[[{]/.test(value)) {
      try {
        return JSON.stringify(visit(JSON.parse(value) as unknown));
      } catch {
        /* Plain text. */
      }
    }
    let result = value;
    for (const secret of replacements) result = result.split(secret).join('[credential]');
    // Remove entire URLs: public recordings/logs can identify a call even without a query.
    result = result.replace(
      urlPattern,
      (url) => `https://redacted.invalid/${alias('url', url).slice(1, -1)}`,
    );
    result = result.replace(
      emailPattern,
      (email) => `${alias('email', email).slice(1, -1)}@redacted.invalid`,
    );
    for (const [id, replacement] of ids) result = result.split(id).join(replacement);
    result = result.replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [credential]');
    result = result.replace(/\b(?:sk|key|rk)[_-][a-z0-9_-]{8,}\b/gi, '[credential]');
    result = result.replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+(?:\.[a-z0-9_-]+)?\b/gi, '[credential]');
    result = result.replace(
      /\b(?:api[_ -]?key|access[_ -]?token|secret|password|signature)\s*[:=]\s*[^\s"',;]+/gi,
      '[credential]',
    );
    if (phoneKey.test(normalizedKey(key)) && value.length > 0)
      return alias('phone', phoneDigits(value));
    if (urlKey.test(normalizedKey(key)) && value.length > 0)
      return `https://redacted.invalid/${alias('url', value).slice(1, -1)}`;
    result = result.replace(phonePattern, (phone) =>
      isPhone(phone) ? alias('phone', phoneDigits(phone)) : phone,
    );
    result = result.replace(spokenPhonePattern, (phone) =>
      alias('spoken_phone', phone.toLowerCase()),
    );
    // Retell word-level transcripts can split a number into short fragments.
    if (
      key === 'word' &&
      (/^\+?[\d\s().-]+$/.test(result) ||
        /^(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)[.,!?]?$/i.test(result.trim()))
    )
      return '[number]';
    return result;
  }

  function visit(value: unknown, key = '', sensitive = false): RedactedJson {
    const hidden = sensitive || sensitiveKey.test(normalizedKey(key));
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') return hidden ? '[credential]' : text(value, key);
    if (typeof value === 'number') {
      if (hidden || phoneKey.test(normalizedKey(key))) return 0;
      if (
        Number.isInteger(value) &&
        /^\d{7,15}$/.test(String(value)) &&
        !/(?:timestamp|duration|latency|milliseconds|^start$|^end$|_ms$)/i.test(key)
      )
        return 0;
      return value;
    }
    if (Array.isArray(value)) return (value as unknown[]).map((entry) => visit(entry, key, hidden));
    if (typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          text(childKey, ''),
          visit(child, childKey, hidden),
        ]),
      );
    }
    throw new Error('Retell redaction requires JSON values.');
  }
  return (payload) => visit(payload);
}

export function redactRetellPayload(payload: unknown): RedactedJson {
  return createRetellRedactor([payload])(payload);
}

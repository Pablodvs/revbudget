const SENSITIVE =
  /^(authorization|cookie|set-cookie|password|token|secret|api[-_]?key|x-webhook-secret|x-api-token)$/i;

export function redact(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE.test(k) ? '[redacted]' : redact(v);
    }
    return out;
  }
  return value;
}

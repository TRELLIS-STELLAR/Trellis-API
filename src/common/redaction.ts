const SENSITIVE_KEYS = /pass(word|phrase)?|secret|token|private.?key|mnemonic|seed|wallet|transaction|tx.?hash/i;

export function redactSensitive<T>(value: T): T {
  return redact(value, new WeakSet()) as T;
}

function redact(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(nested, seen);
  }
  return result;
}

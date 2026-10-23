const SENSITIVE_KEYS = /pass(word|phrase)?|secret|token|private.?key|mnemonic|seed|wallet|transaction|tx.?hash/i;

/** Nesting depth redacted before a subtree collapses to "[MAX_DEPTH]" (#345). */
export const MAX_REDACTION_DEPTH = 32;

export function redactSensitive<T>(value: T): T {
  return redact(value, new WeakSet(), 0) as T;
}

function redact(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value && typeof value === "object" && depth >= MAX_REDACTION_DEPTH)
    return "[MAX_DEPTH]";
  if (Array.isArray(value)) return value.map((item) => redact(item, seen, depth + 1));
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? "[REDACTED]" : redact(nested, seen, depth + 1);
  }
  return result;
}

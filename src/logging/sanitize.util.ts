/**
 * Sanitize utility for structured logging.
 *
 * Ensures that sensitive fields (passwords, tokens, keys, etc.) are never
 * written to any log sink. All sanitisation is depth-limited to prevent
 * performance issues with deeply nested request/response payloads.
 */

// ---------------------------------------------------------------------------
// Sensitive field registry
// ---------------------------------------------------------------------------

/**
 * Case-insensitive set of body / metadata field names that must be redacted.
 * Extend this list with application-specific sensitive fields.
 */
export const SENSITIVE_FIELDS = new Set<string>([
  // Auth / session
  "password",
  "passwordconfirm",
  "oldpassword",
  "newpassword",
  "currentpassword",
  "confirmpassword",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "sessiontoken",
  "bearertoken",
  // API access
  "secret",
  "apikey",
  "api_key",
  "clientsecret",
  "client_secret",
  "clientid",
  // PII
  "ssn",
  "socialsecuritynumber",
  "creditcard",
  "cardnumber",
  "cvv",
  "cvc",
  "pin",
  "dateofbirth",
  "dob",
  // Crypto / wallet
  "privatekey",
  "private_key",
  "mnemonic",
  "seed",
  "seedphrase",
  "walletpassphrase",
  "keystorepassword",
  // Infrastructure
  "databasepassword",
  "db_password",
  "smtppassword",
  "smtp_password",
  "redispassword",
  "redis_password",
]);

/**
 * HTTP request headers that must be redacted in log output.
 */
export const SENSITIVE_HEADERS = new Set<string>([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-refresh-token",
  "proxy-authorization",
  "www-authenticate",
]);

/** Query parameters that carry credentials but are not body field names. */
const SENSITIVE_QUERY_PARAMS = new Set<string>([
  "key",
  "code",
  "signature",
  "sig",
  "ticket",
  "otp",
]);

// ---------------------------------------------------------------------------
// Redaction constants
// ---------------------------------------------------------------------------
export const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;
const MAX_ARRAY_LENGTH = 50;

/*
 * Resource budgets for worst-case log payloads (#345). Each bound caps the work
 * and output of one sanitisation call regardless of input shape; see
 * docs/resource-budget-tests.md.
 */
/** Keys kept per object; the rest collapse into one TRUNCATED_KEYS_FIELD entry. */
export const MAX_OBJECT_KEYS = 100;
/** Characters kept per logged string value. */
export const MAX_STRING_LENGTH = 4096;
/** Characters of an error message scanned for secrets and kept in the output. */
export const MAX_ERROR_MESSAGE_LENGTH = 8192;
export const TRUNCATED_KEYS_FIELD = "[TRUNCATED_KEYS]";

/**
 * Redacts `text` while bounding both the scanned input and the output to
 * `limit` characters. When the input is cut, the token straddling the cut is
 * dropped too, so the visible start of a secret (a JWT, seed or URL password
 * cut in half) can never survive just because the pattern no longer matches.
 * A single unbroken token longer than `limit` is opaque and fully redacted.
 */
export function redactBounded(
  text: string,
  limit: number,
  redact: (value: string) => string,
): string {
  if (text.length <= limit) {
    const out = redact(text);
    return out.length <= limit
      ? out
      : `${out.slice(0, limit)}...[TRUNCATED ${out.length - limit} chars]`;
  }
  const head = text.slice(0, limit);
  const lastBreak = head.search(/\s\S*$/);
  const kept = lastBreak > 0 ? head.slice(0, lastBreak) : REDACTED;
  return `${redact(kept).slice(0, limit)}...[TRUNCATED ${text.length - (lastBreak > 0 ? lastBreak : 0)} chars]`;
}

// ---------------------------------------------------------------------------
// Core sanitisation
// ---------------------------------------------------------------------------

/**
 * Deep-sanitises an arbitrary value, replacing values associated with
 * sensitive field names with [REDACTED].
 *
 * - `depth` is tracked to prevent runaway recursion on circular or very deep
 *   objects.  When the limit is hit the value is replaced with [MAX_DEPTH].
 * - Array items are capped at MAX_ARRAY_LENGTH to bound log size.
 */
export function sanitizeValue(
  value: unknown,
  depth = 0,
  extraSensitiveFields?: Set<string>,
): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_LENGTH)
      .map((item) => sanitizeValue(item, depth + 1, extraSensitiveFields));
  }

  if (typeof value === "object" && !(value instanceof Date)) {
    return sanitizeObject(
      value as Record<string, unknown>,
      depth,
      extraSensitiveFields,
    );
  }

  if (typeof value === "string") {
    return redactBounded(value, MAX_STRING_LENGTH, redactSecretValues);
  }

  return value;
}

/**
 * Sanitises a plain object — the workhorse behind {@link sanitizeValue}.
 */
export function sanitizeObject(
  obj: Record<string, unknown>,
  depth = 0,
  extraSensitiveFields?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let kept = 0;
  let dropped = 0;

  // for...in avoids materialising Object.entries() for very wide objects.
  for (const key in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (kept >= MAX_OBJECT_KEYS) {
      dropped++;
      continue;
    }
    kept++;
    const lower = key.toLowerCase().replace(/[-_\s]/g, "");
    const isSensitive =
      SENSITIVE_FIELDS.has(lower) || extraSensitiveFields?.has(lower);

    out[key] = isSensitive
      ? REDACTED
      : sanitizeValue(obj[key], depth + 1, extraSensitiveFields);
  }

  if (dropped > 0) out[TRUNCATED_KEYS_FIELD] = dropped;
  return out;
}

/**
 * Sanitises HTTP request headers, redacting security-relevant ones.
 */
export function sanitizeHeaders(
  headers: Record<string, unknown>,
  extraSensitiveHeaders?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    const isSensitive =
      SENSITIVE_HEADERS.has(lower) || extraSensitiveHeaders?.has(lower);
    out[key] = isSensitive ? REDACTED : value;
  }

  return out;
}

/**
 * Trims a URL query string, redacting sensitive query parameters.
 * e.g. `?token=abc&page=1` → `?token=[REDACTED]&page=1`
 */
export function sanitizeQuery(
  query: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(query)) {
    const lower = key.toLowerCase().replace(/[-_\s]/g, "");
    out[key] =
      SENSITIVE_FIELDS.has(lower) || SENSITIVE_QUERY_PARAMS.has(lower)
        ? REDACTED
        : value;
  }

  return out;
}

/**
 * Redacts high-confidence secret shapes inside free text: JWTs, bearer/basic
 * credentials, Stellar secret seeds, PEM private keys, credentials embedded in
 * URLs and `password=`-style pairs. Unlike {@link sanitizeErrorMessage} it keeps
 * 64-hex strings, so transaction hashes in client messages and exports survive.
 */
export function redactSecretValues(text: string): string {
  return (
    text
      // PEM private key blocks
      .replace(
        /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
        REDACTED,
      )
      // JWT tokens  (3-part base64url separated by dots)
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED)
      // Stellar secret seeds (StrKey "S" + 55 base32 chars); G... public keys
      // and C... contract IDs are deliberately left visible.
      .replace(/\bS[A-Z2-7]{55}\b/g, REDACTED)
      // user:password@ credentials in URLs (DSNs, webhook targets)
      .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
      // Bearer tokens
      .replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`)
      // Basic auth: requires a digit, "+", "/" or "=" so prose such as
      // "Basic plan" is not mistaken for a credential.
      .replace(
        /\bBasic\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{4,}={0,2}/gi,
        `Basic ${REDACTED}`,
      )
      // password= style inline values
      .replace(/(password|secret|key|token)\s*=\s*\S+/gi, "$1=" + REDACTED)
  );
}

/**
 * Redacts sensitive information from error messages before logging.
 * Replaces common secret patterns (JWT, API keys, hex private keys). Input is
 * capped at MAX_ERROR_MESSAGE_LENGTH first so scan cost is bounded.
 */
export function sanitizeErrorMessage(message: string): string {
  return redactBounded(message, MAX_ERROR_MESSAGE_LENGTH, (text) =>
    redactSecretValues(
      // 32-64 byte hex strings (likely private keys / hashes)
      text.replace(/\b(?:0x)?[0-9a-fA-F]{64,128}\b/g, REDACTED),
    ),
  );
}

/**
 * Sanitises a request URL for logs and error reports: strips embedded
 * credentials and redacts the values of sensitive query parameters.
 */
export function sanitizeUrl(url: string): string {
  const raw = url ?? "";
  let bounded = raw;
  let suffix = "";
  if (raw.length > MAX_STRING_LENGTH) {
    // Cut on a parameter boundary so no half parameter (or half secret) stays.
    const head = raw.slice(0, MAX_STRING_LENGTH);
    const cut = Math.max(head.lastIndexOf("&"), head.indexOf("?"));
    bounded = cut > 0 ? head.slice(0, cut) : REDACTED;
    suffix = `...[TRUNCATED ${raw.length - bounded.length} chars]`;
  }
  const queryStart = bounded.indexOf("?");
  const base = redactSecretValues(
    queryStart === -1 ? bounded : bounded.slice(0, queryStart),
  );
  if (queryStart === -1) return base + suffix;
  const query = bounded
    .slice(queryStart + 1)
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return pair;
      const key = pair.slice(0, eq);
      let decoded = key;
      try {
        decoded = decodeURIComponent(key);
      } catch {
        // keep the raw key
      }
      const lower = decoded.toLowerCase().replace(/[-_\s]/g, "");
      return SENSITIVE_FIELDS.has(lower) || SENSITIVE_QUERY_PARAMS.has(lower)
        ? `${key}=${REDACTED}`
        : `${key}=${redactSecretValues(pair.slice(eq + 1))}`;
    })
    .join("&");
  return `${base}?${query}${suffix}`;
}

/**
 * Formats an Error into a structured log-friendly object. Stack traces are
 * only included in non-production environments.
 */
export function formatError(
  error: unknown,
  includeStack = process.env.NODE_ENV !== "production",
): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { message: sanitizeErrorMessage(String(error)), type: "unknown" };
  }

  const out: Record<string, unknown> = {
    type: error.constructor?.name ?? "Error",
    message: sanitizeErrorMessage(error.message),
  };

  if (includeStack && error.stack) {
    out.stack = sanitizeErrorMessage(error.stack);
  }

  // Preserve any extra enumerable properties added to the error
  for (const key of Object.keys(error)) {
    if (key !== "message" && key !== "stack") {
      out[key] = sanitizeValue((error as any)[key]);
    }
  }

  return out;
}

/**
 * Testable core logic for the contributor diagnostics command.
 *
 * All I/O (filesystem reads, TCP probes, process.env) is injected so unit
 * tests can run without real connections.
 *
 * Issue: #67
 */

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface DiagnosticCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

// ──────────────────────────────────────────────────────────────────────────────
// Environment variable check
// ──────────────────────────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERNS = [/your[-_]?/i, /placeholder/i, /changeme/i];

interface EnvVarSpec {
  key: string;
  required: boolean;
  hint: string;
  remediation: string;
}

export const REQUIRED_ENV_SPECS: EnvVarSpec[] = [
  {
    key: "DATABASE_URL",
    required: true,
    hint: "PostgreSQL connection string",
    remediation:
      "Set DATABASE_URL=postgresql://user:password@localhost:5432/trellis_dev in your .env",
  },
  {
    key: "JWT_SECRET",
    required: true,
    hint: "JWT signing secret (32+ char random string)",
    remediation:
      "Generate: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
  },
  {
    key: "REDIS_URL",
    required: false,
    hint: "Redis connection URL (rate limiting, caching, queues)",
    remediation: "Add REDIS_URL=redis://localhost:6379 to .env",
  },
];

export function checkEnvVars(
  env: Record<string, string | undefined>,
  specs: EnvVarSpec[] = REQUIRED_ENV_SPECS,
): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = [];

  for (const spec of specs) {
    const value = env[spec.key];
    if (!value || value.trim() === "") {
      checks.push({
        name: `env:${spec.key}`,
        status: spec.required ? "fail" : "warn",
        detail: `${spec.key} (${spec.hint}) is not set`,
        remediation: spec.remediation,
      });
    } else if (PLACEHOLDER_PATTERNS.some((p) => p.test(value))) {
      checks.push({
        name: `env:${spec.key}`,
        status: "warn",
        detail: `${spec.key} appears to be a placeholder value`,
        remediation: `Replace the placeholder in your .env with a real value.`,
      });
    } else {
      checks.push({
        name: `env:${spec.key}`,
        status: "pass",
        detail: `${spec.key} is set`,
      });
    }
  }

  return checks;
}

// ──────────────────────────────────────────────────────────────────────────────
// Tool version check
// ──────────────────────────────────────────────────────────────────────────────

export interface ToolSpec {
  name: string;
  version: string | null;
  minMajor?: number;
  required: boolean;
  remediation: string;
}

export function checkToolVersion(spec: ToolSpec): DiagnosticCheck {
  if (!spec.version) {
    return {
      name: `tool:${spec.name}`,
      status: spec.required ? "fail" : "warn",
      detail: `${spec.name} not found`,
      remediation: spec.remediation,
    };
  }

  if (spec.minMajor) {
    const raw = spec.version.replace(/^v/, "").split(".")[0];
    const major = parseInt(raw, 10);
    if (Number.isFinite(major) && major < spec.minMajor) {
      return {
        name: `tool:${spec.name}`,
        status: "fail",
        detail: `${spec.name} ${spec.version} is below minimum major version ${spec.minMajor}`,
        remediation: spec.remediation,
      };
    }
  }

  return {
    name: `tool:${spec.name}`,
    status: "pass",
    detail: `${spec.name} ${spec.version}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// TCP connectivity check (logic only — caller provides probe fn)
// ──────────────────────────────────────────────────────────────────────────────

export async function checkTcpConnectivity(
  label: string,
  host: string,
  port: number,
  probe: (host: string, port: number) => Promise<boolean>,
  remediation: string,
): Promise<DiagnosticCheck> {
  const reachable = await probe(host, port);
  return reachable
    ? { name: label, status: "pass", detail: `Reachable at ${host}:${port}` }
    : { name: label, status: "fail", detail: `Cannot reach ${host}:${port}`, remediation };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTTP endpoint check (logic only)
// ──────────────────────────────────────────────────────────────────────────────

export async function checkHttpEndpoint(
  label: string,
  url: string,
  probe: (url: string) => Promise<{ ok: boolean; status?: number }>,
  remediation: string,
): Promise<DiagnosticCheck> {
  const result = await probe(url);
  if (result.ok && result.status && result.status < 500) {
    return {
      name: label,
      status: "pass",
      detail: `${url} responded with HTTP ${result.status}`,
    };
  }
  return {
    name: label,
    status: "warn",
    detail: `${url} unreachable or returned error`,
    remediation,
  };
}

export function checkBootstrapAdmin(
  email: string | undefined,
  wallet: string | undefined,
  role: string | undefined,
): DiagnosticCheck {
  if (!email && !wallet) {
    return {
      name: "db:bootstrap-admin",
      status: "skip",
      detail: "No bootstrap admin target is configured",
    };
  }

  if (!role) {
    return {
      name: "db:bootstrap-admin",
      status: "warn",
      detail: "The configured bootstrap admin account does not exist",
      remediation:
        "Create the account through the normal registration flow, then restart the API so RoleSeederService can promote it.",
    };
  }

  if (role.toUpperCase() !== "ADMIN") {
    return {
      name: "db:bootstrap-admin",
      status: "warn",
      detail: "The configured bootstrap account is not yet an ADMIN",
      remediation:
        "Restart the API after confirming the bootstrap target is correct; RoleSeederService promotes an existing account on startup.",
    };
  }

  return {
    name: "db:bootstrap-admin",
    status: "pass",
    detail: "The configured bootstrap account has ADMIN role",
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Retry-aware checks (TCP and HTTP with exponential backoff)
// ──────────────────────────────────────────────────────────────────────────────

export interface RetryOptions {
  maxAttempts?: number;
  backoffMs?: number;
  timeoutMs?: number;
  onRetry?: (attempt: number, error?: any) => void;
}

export async function checkTcpConnectivityWithRetry(
  label: string,
  host: string,
  port: number,
  probe: (host: string, port: number) => Promise<boolean>,
  remediation: string,
  options?: RetryOptions,
): Promise<DiagnosticCheck & { attempts: number }> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const backoffMs = options?.backoffMs ?? 200;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const reachable = await probe(host, port);
    if (reachable) {
      const detail =
        attempts === 1
          ? `Reachable at ${host}:${port}`
          : `Reachable at ${host}:${port} (succeeded on retry attempt ${attempts})`;
      return {
        name: label,
        status: "pass",
        detail,
        attempts,
      };
    }
    if (attempts < maxAttempts) {
      options?.onRetry?.(attempts);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempts));
    }
  }

  return {
    name: label,
    status: "fail",
    detail: `Cannot reach ${host}:${port} after ${attempts} attempts`,
    remediation,
    attempts,
  };
}

export async function checkHttpEndpointWithRetry(
  label: string,
  url: string,
  probe: (url: string) => Promise<{ ok: boolean; status?: number }>,
  remediation: string,
  options?: RetryOptions,
): Promise<DiagnosticCheck & { attempts: number }> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const backoffMs = options?.backoffMs ?? 200;
  let attempts = 0;

  while (attempts < maxAttempts) {
    attempts++;
    const result = await probe(url);
    if (result.ok && result.status && result.status < 500) {
      const detail =
        attempts === 1
          ? `${url} responded with HTTP ${result.status}`
          : `${url} responded with HTTP ${result.status} (succeeded on retry attempt ${attempts})`;
      return {
        name: label,
        status: "pass",
        detail,
        attempts,
      };
    }
    if (attempts < maxAttempts) {
      options?.onRetry?.(attempts);
      await new Promise((resolve) => setTimeout(resolve, backoffMs * attempts));
    }
  }

  return {
    name: label,
    status: "warn",
    detail: `${url} unreachable or returned error after ${attempts} attempts`,
    remediation,
    attempts,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Authorization path checks (Database credentials, JWT secret strength, storage permissions)
// ──────────────────────────────────────────────────────────────────────────────

export interface DatabaseProbeResult {
  connected: boolean;
  authenticated: boolean;
  errorCategory?: "auth_failed" | "unreachable" | "db_missing" | "none";
  errorMessage?: string;
}

export function checkDatabaseAuth(
  result: DatabaseProbeResult,
  remediation?: string,
): DiagnosticCheck {
  if (result.errorCategory === "auth_failed") {
    return {
      name: "db:authentication",
      status: "fail",
      detail: "Database authentication failed (invalid username/password)",
      remediation:
        remediation ??
        "Verify username and password in DATABASE_URL. Example: postgresql://user:password@localhost:5432/trellis_dev",
    };
  }

  if (result.errorCategory === "db_missing") {
    return {
      name: "db:authentication",
      status: "fail",
      detail: "Database server connected, but target database does not exist",
      remediation:
        remediation ??
        "Create the target database: createdb -h localhost trellis_dev or via psql: CREATE DATABASE trellis_dev;",
    };
  }

  if (result.authenticated && result.connected) {
    return {
      name: "db:authentication",
      status: "pass",
      detail: "Database credentials and authentication handshake succeeded",
    };
  }

  return {
    name: "db:authentication",
    status: "fail",
    detail: `Database connection error: ${result.errorMessage || "unable to connect"}`,
    remediation:
      remediation ??
      "Ensure PostgreSQL is running and DATABASE_URL host and port are correct.",
  };
}

const WEAK_SECRETS = [
  "secret",
  "changeme",
  "password",
  "12345678",
  "jwtsecret",
  "development",
  "supersecret",
  "trellissecret",
];

export function checkSecretEntropy(
  key: string,
  value: string | undefined,
  minLength = 32,
): DiagnosticCheck {
  if (!value || value.trim() === "") {
    return {
      name: `auth:${key}`,
      status: "fail",
      detail: `${key} is not set`,
      remediation: `Generate a strong cryptographic secret with at least ${minLength} characters.`,
    };
  }

  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    return {
      name: `auth:${key}`,
      status: "fail",
      detail: `${key} length (${trimmed.length}) is below recommended ${minLength} characters`,
      remediation: `Generate a 256-bit secret: node -e "console.log(require('crypto').randomBytes(${minLength}).toString('hex'))"`,
    };
  }

  const lower = trimmed.toLowerCase();
  if (WEAK_SECRETS.some((weak) => lower.includes(weak))) {
    return {
      name: `auth:${key}`,
      status: "warn",
      detail: `${key} contains predictable dictionary words and is vulnerable to brute-force`,
      remediation: `Replace with high-entropy cryptographic random bytes: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    };
  }

  return {
    name: `auth:${key}`,
    status: "pass",
    detail: `${key} meets cryptographic length and entropy standards`,
  };
}

export function checkDirectoryPermissions(
  label: string,
  dirPath: string,
  testWrite: (path: string) => boolean,
  remediation?: string,
): DiagnosticCheck {
  try {
    const writable = testWrite(dirPath);
    if (writable) {
      return {
        name: label,
        status: "pass",
        detail: `Directory ${dirPath} exists with read/write access`,
      };
    }
  } catch (_err) {
    // handled below
  }

  return {
    name: label,
    status: "fail",
    detail: `Directory ${dirPath} is not writable or access is denied`,
    remediation:
      remediation ??
      `Ensure process has write permissions to ${dirPath}: chmod -R u+rwX ${dirPath}`,
  };
}


// ──────────────────────────────────────────────────────────────────────────────
// Local setup failure checks (issue #370): stale .env and port conflicts
// ──────────────────────────────────────────────────────────────────────────────

/** Variable names defined in dotenv-style content. Values are never read. */
export function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/**
 * Compare `.env` with `.env.example`. A contributor who copied the template
 * long ago is missing variables added since, which surfaces as confusing
 * runtime failures. Only variable names are compared and reported.
 */
export function checkEnvTemplateDrift(
  exampleContent: string | null,
  envContent: string | null,
): DiagnosticCheck {
  if (exampleContent === null) {
    return {
      name: "env:template-drift",
      status: "skip",
      detail: ".env.example not found; cannot compare variables",
    };
  }
  if (envContent === null) {
    return {
      name: "env:template-drift",
      status: "skip",
      detail: ".env not found; see the env:.env file check",
    };
  }

  const defined = parseEnvKeys(envContent);
  const missing = [...parseEnvKeys(exampleContent)].filter((k) => !defined.has(k));
  if (missing.length === 0) {
    return {
      name: "env:template-drift",
      status: "pass",
      detail: ".env defines every variable listed in .env.example",
    };
  }

  return {
    name: "env:template-drift",
    status: "warn",
    detail: `.env is missing ${missing.length} variable(s) from .env.example: ${missing.join(", ")}`,
    remediation:
      "Compare .env with .env.example and add the missing names with values for your environment. Optional integrations can stay unset.",
  };
}

/**
 * Report whether the API port is free. A listener already on the port makes
 * `npm run start:dev` fail with EADDRINUSE; the probe is injected so the check
 * stays testable.
 */
export async function checkPortAvailable(
  label: string,
  port: number,
  isPortFree: (port: number) => Promise<boolean>,
  remediation?: string,
): Promise<DiagnosticCheck> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      name: label,
      status: "fail",
      detail: `PORT value ${port} is not a valid TCP port`,
      remediation: "Set PORT to an integer between 1 and 65535 in your .env.",
    };
  }

  let free: boolean;
  try {
    free = await isPortFree(port);
  } catch {
    return {
      name: label,
      status: "warn",
      detail: `Could not determine whether port ${port} is free`,
      remediation: remediation ?? `Check manually with: lsof -i :${port}`,
    };
  }

  return free
    ? { name: label, status: "pass", detail: `Port ${port} is free` }
    : {
        name: label,
        status: "fail",
        detail: `Port ${port} is already in use`,
        remediation:
          remediation ??
          `Stop the process using it (lsof -i :${port}) or set a different PORT in your .env. If it is a previous API run, stop that instance first.`,
      };
}

// ──────────────────────────────────────────────────────────────────────────────
// Report aggregation
// ──────────────────────────────────────────────────────────────────────────────

export interface DiagnosticsReport {
  passed: number;
  failed: number;
  warned: number;
  skipped: number;
  checks: DiagnosticCheck[];
  ok: boolean;
}

export function buildReport(checks: DiagnosticCheck[]): DiagnosticsReport {
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let skipped = 0;

  for (const c of checks) {
    if (c.status === "pass") passed++;
    else if (c.status === "fail") failed++;
    else if (c.status === "warn") warned++;
    else skipped++;
  }

  return { passed, failed, warned, skipped, checks, ok: failed === 0 };
}

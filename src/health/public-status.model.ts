/**
 * Safe public-status model for degraded, paused, or maintenance states.
 *
 * Pure domain logic, secret-redaction boundary, and deterministic state
 * evaluation across UI, API, and background worker paths. Kept free of
 * framework decorators so it can be executed directly by unit tests, the
 * NestJS service/controller layer, and standalone CLI verification scripts.
 */

export const PUBLIC_SYSTEM_STATES = {
  OPERATIONAL: "operational",
  DEGRADED: "degraded",
  PAUSED: "paused",
  MAINTENANCE: "maintenance",
} as const;

export type PublicSystemState =
  (typeof PUBLIC_SYSTEM_STATES)[keyof typeof PUBLIC_SYSTEM_STATES];

export const PUBLIC_STATE_SEVERITY: Record<PublicSystemState, number> = {
  operational: 0,
  degraded: 1,
  paused: 2,
  maintenance: 3,
};

export type PublicComponentId =
  | "api"
  | "database"
  | "cache"
  | "trading"
  | "payments"
  | "withdrawals"
  | "defi"
  | "oracle"
  | "reconciliation"
  | "background_workers";

export const ALL_PUBLIC_COMPONENTS: PublicComponentId[] = [
  "api",
  "database",
  "cache",
  "trading",
  "payments",
  "withdrawals",
  "defi",
  "oracle",
  "reconciliation",
  "background_workers",
];

/**
 * Pausable scopes that halt core financial mutations and therefore elevate
 * the top-level public status to `paused` (or `maintenance` when scheduled).
 */
export const HIGH_IMPACT_PAUSE_SCOPES = new Set<string>([
  "all",
  "trading",
  "payments",
  "withdrawals",
]);

/**
 * Pausable scopes that only affect a subsystem and therefore place the overall
 * platform in `degraded` state while the specific component is `paused`.
 */
export const PARTIAL_PAUSE_SCOPES = new Set<string>([
  "defi",
  "oracle",
  "reconciliation",
]);

export const REDACTED_MARKER = "[REDACTED]";

// ---------------------------------------------------------------------------
// Secret & Internal Detail Redaction Patterns
// ---------------------------------------------------------------------------

const PEM_BLOCK_PATTERN =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi;
const URL_WITH_CREDENTIALS_PATTERN =
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@([^\s"'<>]+)/gi;
const CONNECTION_URL_PATTERN =
  /\b(postgres(?:ql)?|redis(?:s)?|mongodb(?:\+srv)?|amqp(?:s)?|mysql):\/\/[^\s"'<>]+/gi;
const BEARER_OR_BASIC_PATTERN =
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const JWT_TOKEN_PATTERN =
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const STELLAR_SECRET_SEED_PATTERN = /\bS[A-Z2-7]{55}\b/g;
const ETH_PRIVATE_KEY_PATTERN = /\b0x[a-fA-F0-9]{64}\b/g;
const PREFIXED_API_KEY_PATTERN =
  /\b(sk-[A-Za-z0-9_-]{12,}|pk_(?:live|test)_[A-Za-z0-9_-]{12,}|rk_(?:live|test)_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g;
const KEY_VALUE_SECRET_PATTERN =
  /([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_?KEY|ACCESS_KEY|CREDENTIAL|SESSION_KEY|ENCRYPTION_KEY|DSN|SIGNING_KEY|WEBHOOK_URL|DATABASE_URL|REDIS_URL|MNEMONIC|SEED)[A-Za-z0-9_.-]*)(\s*["']?\s*[:=]\s*["']?)([^\s"',;)}\]]+)/gi;
const LONG_OPAQUE_SECRET_PATTERN = /\b[A-Za-z0-9_+/=-]{40,}\b/g;
const INTERNAL_HOST_OR_IP_PATTERN =
  /\b(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|localhost(?::\d+)?|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:internal|local|svc\.cluster\.local)(?::\d+)?)\b/gi;
const SQL_OR_STACK_LEAK_PATTERN =
  /\b(?:select\s+.+\s+from\s+|insert\s+into\s+|update\s+\S+\s+set\s+|delete\s+from\s+|pg_catalog|typeorm|queryfailederror|syntax error at or near|at\s+[A-Za-z0-9_$.<>]+\s*\([^)]*:\d+:\d+\))/i;
const SCRIPT_TAG_PATTERN =
  /<\s*script\b[^>]*>[\s\S]*?<\s*\/\s*script\s*>|<\s*\/?\s*(?:script|iframe|object|embed|style)\b[^>]*>/gi;
const EVENT_HANDLER_ATTR_PATTERN =
  /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_PROTOCOL_PATTERN = /javascript\s*:/gi;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]+/g;

const SENSITIVE_OBJECT_KEY_PATTERN =
  /(password|passwd|secret|private.?key|api.?key|access.?key|token|authorization|bearer|cookie|session.?key|encryption.?key|signing.?key|mnemonic|seed|dsn|database_url|redis_url|webhook_url|ssn|credit.?card)/i;

const MAX_PUBLIC_TEXT_LENGTH = 240;

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ActivePauseRecordInput {
  id?: string;
  scope: string;
  reason: string;
  active?: boolean;
  activatedBy?: string;
  activatedByRole?: string | null;
  activatedAt?: Date | string;
  expiresAt?: Date | string | null;
  environment?: string | null;
}

export interface MaintenanceWindowInput {
  active: boolean;
  reason: string;
  scheduledStartAt?: string;
  estimatedEndAt?: string | null;
  activatedBy?: string;
  activatedByRole?: string;
  activatedAt?: string;
  affectedScopes?: string[];
}

export interface ManualDegradationInput {
  componentId: PublicComponentId;
  reason: string;
  declaredBy: string;
  declaredAt: string;
  estimatedRecoveryAt?: string | null;
}

export interface ReadinessSnapshotInput {
  status: "ok" | "degraded" | "error";
  components?: Record<
    string,
    { status: "up" | "down"; responseTime?: number; message?: string }
  >;
}

export interface DependencyCheckSnapshotInput {
  id: string;
  label: string;
  kind?: string;
  criticality: "critical" | "optional";
  state: "healthy" | "degraded" | "unavailable" | "misconfigured" | "disabled";
  detail?: string;
  latencyMs?: number;
  target?: string;
  configKeys?: Array<{ key: string; configured: boolean }>;
  remediation?: string;
}

export interface DependencyReportSnapshotInput {
  status: "healthy" | "degraded" | "unavailable" | "misconfigured" | "disabled";
  advisory?: "healthy" | "degraded" | "unavailable" | "misconfigured" | "disabled";
  criticalFindings?: string[];
  advisoryFindings?: string[];
  checks?: DependencyCheckSnapshotInput[];
}

export interface StateTransitionEntry {
  id: string;
  fromState: PublicSystemState;
  toState: PublicSystemState;
  trigger:
    | "pause_activated"
    | "pause_resumed"
    | "pause_expired"
    | "maintenance_enabled"
    | "maintenance_cleared"
    | "degradation_declared"
    | "degradation_cleared"
    | "dependency_health_change"
    | "system_init";
  changedAt: string;
  actorId?: string;
  publicSummary: string;
  operatorNote?: string;
}

export interface PublicComponentStatusView {
  id: PublicComponentId;
  label: string;
  state: PublicSystemState;
  message: string;
  updatedAt: string;
}

export interface PublicPausedScopeView {
  scope: string;
  state: "paused" | "maintenance";
  publicReason: string;
  expiresAt?: string;
}

export interface PublicCapabilitiesView {
  readOnly: boolean;
  tradingEnabled: boolean;
  paymentsEnabled: boolean;
  withdrawalsEnabled: boolean;
  defiEnabled: boolean;
  oracleEnabled: boolean;
  reconciliationEnabled: boolean;
  backgroundJobsProcessing: boolean;
}

export interface PublicMaintenanceWindowView {
  active: boolean;
  publicMessage: string;
  scheduledStartAt?: string;
  estimatedEndAt?: string;
  affectedScopes: string[];
}

export interface PublicSystemStatusView {
  state: PublicSystemState;
  httpStatusCode: 200 | 503;
  summary: string;
  generatedAt: string;
  retryAfterSeconds?: number;
  maintenanceWindow: PublicMaintenanceWindowView | null;
  pausedScopes: PublicPausedScopeView[];
  components: Record<PublicComponentId, PublicComponentStatusView>;
  capabilities: PublicCapabilitiesView;
}

export interface OperatorPauseScopeView {
  scope: string;
  reason: string;
  activatedBy: string;
  activatedByRole: string | null;
  activatedAt: string;
  expiresAt: string | null;
  environment: string | null;
}

export interface OperatorDependencyDiagnosticView {
  id: string;
  label: string;
  criticality: "critical" | "optional";
  state: string;
  latencyMs?: number;
  sanitizedTarget?: string;
  configKeys: Array<{ key: string; configured: boolean }>;
  detail: string;
  remediation: string;
}

export interface OperatorRunbookGuidance {
  currentState: PublicSystemState;
  verificationSteps: string[];
  rollbackAndRecoverySteps: string[];
  edgeCaseWarnings: string[];
}

export interface OperatorSystemStatusView extends PublicSystemStatusView {
  rawStateSources: {
    maintenanceOverrideActive: boolean;
    activePauseScopes: string[];
    manualDegradedComponents: PublicComponentId[];
    readinessStatus: string;
    dependencyStatus: string;
    backgroundWorkerMode: "processing" | "throttled" | "deferred";
  };
  activePauses: OperatorPauseScopeView[];
  manualDegradations: ManualDegradationInput[];
  dependencyDiagnostics: OperatorDependencyDiagnosticView[];
  backgroundPath: {
    mode: "processing" | "throttled" | "deferred";
    deferredScopes: string[];
    activeBackoffMultiplier: number;
    reason: string;
  };
  stateHistory: StateTransitionEntry[];
  runbook: OperatorRunbookGuidance;
}

export interface UiStatusBannerContract {
  visible: boolean;
  state: PublicSystemState;
  severity: "none" | "warning" | "error" | "info";
  badgeText: string;
  title: string;
  message: string;
  retryAfterSeconds?: number;
  dismissible: boolean;
  capabilities: PublicCapabilitiesView;
  websocketEvent: {
    event: "system:status:update";
    payload: PublicSystemStatusView;
  };
}

export interface ApiRequestGateContext {
  method: string;
  path: string;
  scope?: string;
  actorRoles?: string[];
}

export interface ApiRequestGateDecision {
  allowed: boolean;
  bypassReason?: "read_only_method" | "status_or_health_route" | "admin_override";
  statusCode: 200 | 503;
  headers: Record<string, string>;
  errorPayload?: {
    type: string;
    title: string;
    status: 503;
    detail: string;
    errorCode: "SERVICE_UNAVAILABLE";
    state: PublicSystemState;
    scope?: string;
    retryable: true;
    retryAfterSeconds?: number;
    remediation: string;
  };
}

export interface BackgroundJobGateContext {
  jobType: string;
  scope?: string;
  priority?: "low" | "normal" | "high" | "critical";
  isEssentialRecovery?: boolean;
}

export interface BackgroundJobGateDecision {
  decision: "execute" | "execute_with_backoff" | "defer";
  jobType: string;
  resolvedScope: string;
  state: PublicSystemState;
  backoffMultiplier: number;
  delayMs: number;
  retryAfterSeconds?: number;
  reason: string;
}

export interface ComputeStatusInput {
  activePauses?: ActivePauseRecordInput[];
  maintenanceWindow?: MaintenanceWindowInput | null;
  manualDegradations?: ManualDegradationInput[];
  readiness?: ReadinessSnapshotInput | null;
  dependencyReport?: DependencyReportSnapshotInput | null;
  stateHistory?: StateTransitionEntry[];
  env?: Record<string, string | undefined>;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Secret Redaction & Sanitization Functions
// ---------------------------------------------------------------------------

/**
 * Checks whether a string contains any raw secret, credential, connection URL,
 * private key, SQL statement, stack trace, or internal IP address.
 */
export function containsSecretOrInternalLeak(input: string): boolean {
  if (!input || typeof input !== "string") return false;
  // Remove already-redacted markers so `API_KEY=[REDACTED]` or `postgresql://[REDACTED]`
  // is recognized as sanitized rather than raw secret material.
  const withoutRedacted = input
    .split(REDACTED_MARKER)
    .join("")
    .split("[internal-host]")
    .join("");

  const patterns = [
    PEM_BLOCK_PATTERN,
    URL_WITH_CREDENTIALS_PATTERN,
    CONNECTION_URL_PATTERN,
    BEARER_OR_BASIC_PATTERN,
    JWT_TOKEN_PATTERN,
    STELLAR_SECRET_SEED_PATTERN,
    ETH_PRIVATE_KEY_PATTERN,
    PREFIXED_API_KEY_PATTERN,
    KEY_VALUE_SECRET_PATTERN,
    INTERNAL_HOST_OR_IP_PATTERN,
    SQL_OR_STACK_LEAK_PATTERN,
  ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(withoutRedacted)) {
      pattern.lastIndex = 0;
      return true;
    }
  }
  return false;
}

/**
 * Escapes HTML special characters and strips script/event-handler injections
 * so status strings are safe to render directly in UI banners and emails.
 */
export function neutralizeHtmlAndXss(input: string): string {
  if (!input || typeof input !== "string") return "";
  return input
    .replace(SCRIPT_TAG_PATTERN, "")
    .replace(EVENT_HANDLER_ATTR_PATTERN, "")
    .replace(JS_PROTOCOL_PATTERN, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Redacts known secret values from `env` as well as structural secret patterns,
 * connection strings, tokens, internal hosts, and control characters.
 */
export function sanitizeStatusText(
  input: unknown,
  options: {
    stripInternalHosts?: boolean;
    escapeHtml?: boolean;
    env?: Record<string, string | undefined>;
    maxLength?: number;
  } = {},
): string {
  if (input === null || input === undefined) return "";
  let text = typeof input === "string" ? input : String(input);

  // 1. Redact any explicit secret values present in the provided environment map
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (
        SENSITIVE_OBJECT_KEY_PATTERN.test(key) &&
        typeof value === "string" &&
        value.trim().length >= 6
      ) {
        text = text.split(value.trim()).join(REDACTED_MARKER);
      }
    }
  }

  // 2. Strip script/XSS tags before pattern redaction
  text = text
    .replace(SCRIPT_TAG_PATTERN, "")
    .replace(EVENT_HANDLER_ATTR_PATTERN, "")
    .replace(JS_PROTOCOL_PATTERN, "");

  // 3. Redact PEM blocks, credentials in URLs, connection URLs, tokens, seeds, keys
  text = text
    .replace(PEM_BLOCK_PATTERN, REDACTED_MARKER)
    .replace(
      URL_WITH_CREDENTIALS_PATTERN,
      (_match, scheme: string, _user: string, _pass: string, rest: string) =>
        `${scheme}${REDACTED_MARKER}@${rest}`,
    )
    .replace(
      CONNECTION_URL_PATTERN,
      (_match, scheme: string) => `${scheme}://${REDACTED_MARKER}`,
    )
    .replace(
      BEARER_OR_BASIC_PATTERN,
      (_match, scheme: string) => `${scheme} ${REDACTED_MARKER}`,
    )
    .replace(JWT_TOKEN_PATTERN, REDACTED_MARKER)
    .replace(STELLAR_SECRET_SEED_PATTERN, REDACTED_MARKER)
    .replace(ETH_PRIVATE_KEY_PATTERN, REDACTED_MARKER)
    .replace(PREFIXED_API_KEY_PATTERN, REDACTED_MARKER)
    .replace(
      KEY_VALUE_SECRET_PATTERN,
      (_match, key: string, sep: string) => `${key}${sep}${REDACTED_MARKER}`,
    )
    .replace(LONG_OPAQUE_SECRET_PATTERN, REDACTED_MARKER);

  // 4. Strip internal IPs/hostnames when producing public-facing text
  if (options.stripInternalHosts !== false) {
    text = text.replace(INTERNAL_HOST_OR_IP_PATTERN, "[internal-host]");
  }

  // 5. Collapse whitespace and remove control characters
  text = text.replace(CONTROL_CHAR_PATTERN, " ").replace(/\s+/g, " ").trim();

  // 6. Optional HTML entity escaping for safe UI rendering
  if (options.escapeHtml) {
    text = neutralizeHtmlAndXss(text);
  }

  const maxLen = options.maxLength ?? MAX_PUBLIC_TEXT_LENGTH;
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen - 1)}…`;
  }

  return text;
}

/**
 * Produces a user-safe public reason string. If the raw operator/driver reason
 * contains SQL queries, stack traces, or predominantly redacted credential dumps,
 * substitutes a clean, non-leaky fallback description for the given state.
 */
export function sanitizePublicReason(
  rawReason: unknown,
  fallbackState: PublicSystemState = "degraded",
  env?: Record<string, string | undefined>,
): string {
  const defaultMessages: Record<PublicSystemState, string> = {
    operational: "All systems are operational.",
    degraded:
      "Some platform services are experiencing elevated latency or partial degradation.",
    paused:
      "Selected platform operations are temporarily paused for safety verification.",
    maintenance:
      "The platform is undergoing scheduled maintenance. Normal operations will resume shortly.",
  };

  if (typeof rawReason !== "string" || !rawReason.trim()) {
    return defaultMessages[fallbackState];
  }

  // If the raw string is a raw SQL error or stack trace dump, never echo it to public users
  if (SQL_OR_STACK_LEAK_PATTERN.test(rawReason)) {
    return defaultMessages[fallbackState];
  }

  const sanitized = sanitizeStatusText(rawReason, {
    stripInternalHosts: true,
    escapeHtml: true,
    env,
  });

  if (!sanitized || sanitized === REDACTED_MARKER) {
    return defaultMessages[fallbackState];
  }

  return sanitized;
}

/**
 * Sanitizes a target URL for operator diagnostics (removes username, password,
 * query parameters, and fragments).
 */
export function sanitizeDiagnosticTarget(targetUrl?: string): string | undefined {
  if (!targetUrl || typeof targetUrl !== "string") return undefined;
  try {
    const parsed = new URL(targetUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return sanitizeStatusText(targetUrl, { stripInternalHosts: false });
  }
}

/**
 * Deeply scrubs an arbitrary metadata/diagnostic object so sensitive keys are
 * removed and string values have secret tokens/credentials redacted.
 */
export function redactStatusObject<T>(
  input: T,
  env?: Record<string, string | undefined>,
): T {
  if (input === null || input === undefined) return input;
  if (typeof input === "string") {
    return sanitizeStatusText(input, { stripInternalHosts: false, env }) as unknown as T;
  }
  if (typeof input !== "object") return input;
  if (input instanceof Date) return input;

  if (Array.isArray(input)) {
    return input.map((item) => redactStatusObject(item, env)) as unknown as T;
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_OBJECT_KEY_PATTERN.test(key)) {
      output[key] = REDACTED_MARKER;
      continue;
    }
    output[key] = redactStatusObject(value, env);
  }
  return output as T;
}

// ---------------------------------------------------------------------------
// Scope & Job Mapping Helpers
// ---------------------------------------------------------------------------

const SCOPE_TO_COMPONENT: Record<string, PublicComponentId[]> = {
  trading: ["trading"],
  payments: ["payments"],
  withdrawals: ["withdrawals"],
  defi: ["defi"],
  oracle: ["oracle"],
  reconciliation: ["reconciliation"],
  all: [
    "trading",
    "payments",
    "withdrawals",
    "defi",
    "oracle",
    "reconciliation",
    "background_workers",
  ],
};

const JOB_TYPE_TO_SCOPE: Record<string, string> = {
  "trading.execute": "trading",
  "trading.order": "trading",
  "payments.settle": "payments",
  "payments.process": "payments",
  "withdrawals.process": "withdrawals",
  "defi.rebalance": "defi",
  "defi.harvest": "defi",
  "oracle.submit": "oracle",
  "oracle.price_feed": "oracle",
  "reconciliation.sync": "reconciliation",
  "webhook.delivery": "webhooks",
  "email.send": "notifications",
  "data.export": "exports",
};

const COMPONENT_LABELS: Record<PublicComponentId, string> = {
  api: "Core API Gateway",
  database: "Primary Database",
  cache: "Distributed Cache & Locks",
  trading: "Trading & Order Execution",
  payments: "Payment Processing",
  withdrawals: "Wallet Withdrawals",
  defi: "DeFi Protocol Adapters",
  oracle: "Stellar Oracle Submissions",
  reconciliation: "Ledger Reconciliation",
  background_workers: "Background Job Workers",
};

export function resolveJobScope(jobType: string, explicitScope?: string): string {
  if (explicitScope && explicitScope.trim()) {
    return explicitScope.trim().toLowerCase();
  }
  const normalized = (jobType || "").trim().toLowerCase();
  if (JOB_TYPE_TO_SCOPE[normalized]) {
    return JOB_TYPE_TO_SCOPE[normalized];
  }
  const prefix = normalized.split(".")[0];
  if (
    prefix &&
    (HIGH_IMPACT_PAUSE_SCOPES.has(prefix) || PARTIAL_PAUSE_SCOPES.has(prefix))
  ) {
    return prefix;
  }
  return "background";
}

function isMaintenanceReason(reason: string): boolean {
  return /\b(maintenance|scheduled upgrade|planned upgrade|migration window)\b/i.test(
    reason || "",
  );
}

function toIsoOrUndefined(dateInput?: Date | string | null): string | undefined {
  if (!dateInput) return undefined;
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function computeRetryAfterSeconds(
  targetIso: string | undefined,
  nowMs: number,
): number | undefined {
  if (!targetIso) return undefined;
  const targetMs = new Date(targetIso).getTime();
  if (Number.isNaN(targetMs)) return undefined;
  const diffSeconds = Math.ceil((targetMs - nowMs) / 1000);
  return diffSeconds > 0 ? diffSeconds : undefined;
}

function elevateState(
  current: PublicSystemState,
  candidate: PublicSystemState,
): PublicSystemState {
  return PUBLIC_STATE_SEVERITY[candidate] > PUBLIC_STATE_SEVERITY[current]
    ? candidate
    : current;
}

// ---------------------------------------------------------------------------
// Core Status Computation
// ---------------------------------------------------------------------------

export function computeSystemStatusSnapshot(input: ComputeStatusInput = {}): {
  publicStatus: PublicSystemStatusView;
  operatorStatus: OperatorSystemStatusView;
} {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const env = input.env;

  // 1. Filter active, non-expired pauses
  const rawPauses = input.activePauses ?? [];
  const activePauses = rawPauses.filter((pause) => {
    if (pause.active === false) return false;
    if (pause.expiresAt) {
      const exp = new Date(pause.expiresAt).getTime();
      if (!Number.isNaN(exp) && exp <= nowMs) {
        return false;
      }
    }
    return true;
  });

  // 2. Check maintenance window (auto-expires if estimatedEndAt is in the past and no active pause holds it)
  let maintenanceWindow: MaintenanceWindowInput | null = null;
  if (input.maintenanceWindow && input.maintenanceWindow.active) {
    const endIso = input.maintenanceWindow.estimatedEndAt ?? undefined;
    const endMs = endIso ? new Date(endIso).getTime() : undefined;
    const expired = endMs !== undefined && !Number.isNaN(endMs) && endMs <= nowMs;
    if (!expired) {
      maintenanceWindow = input.maintenanceWindow;
    }
  }

  // 3. Initialize component map as operational
  const components = {} as Record<PublicComponentId, PublicComponentStatusView>;
  for (const compId of ALL_PUBLIC_COMPONENTS) {
    components[compId] = {
      id: compId,
      label: COMPONENT_LABELS[compId],
      state: "operational",
      message: "Operational",
      updatedAt: nowIso,
    };
  }

  let overallState: PublicSystemState = "operational";
  const retryCandidates: number[] = [];

  // 4. Evaluate readiness (Database & Redis)
  if (input.readiness) {
    const dbComp = input.readiness.components?.database;
    const redisComp = input.readiness.components?.redis;
    if (dbComp?.status === "down") {
      components.database = {
        id: "database",
        label: COMPONENT_LABELS.database,
        state: "degraded",
        message: "Database connectivity is currently degraded.",
        updatedAt: nowIso,
      };
      overallState = elevateState(overallState, "degraded");
    }
    if (redisComp?.status === "down") {
      components.cache = {
        id: "cache",
        label: COMPONENT_LABELS.cache,
        state: "degraded",
        message: "Cache service is operating in fallback mode.",
        updatedAt: nowIso,
      };
      overallState = elevateState(overallState, "degraded");
    }
    if (input.readiness.status === "degraded" || input.readiness.status === "error") {
      overallState = elevateState(overallState, "degraded");
    }
  }

  // 5. Evaluate dependency health report
  const dependencyDiagnostics: OperatorDependencyDiagnosticView[] = [];
  if (input.dependencyReport) {
    const depStatus = input.dependencyReport.status;
    if (
      depStatus === "degraded" ||
      depStatus === "unavailable" ||
      depStatus === "misconfigured"
    ) {
      overallState = elevateState(overallState, "degraded");
    } else if (
      input.dependencyReport.advisory === "degraded" ||
      input.dependencyReport.advisory === "unavailable"
    ) {
      overallState = elevateState(overallState, "degraded");
    }

    for (const check of input.dependencyReport.checks ?? []) {
      const safeDetail = sanitizeStatusText(check.detail ?? "", {
        stripInternalHosts: false,
        env,
      });
      const safeRemediation = sanitizeStatusText(check.remediation ?? "", {
        stripInternalHosts: false,
        env,
      });
      dependencyDiagnostics.push({
        id: check.id,
        label: check.label,
        criticality: check.criticality,
        state: check.state,
        latencyMs: check.latencyMs,
        sanitizedTarget: sanitizeDiagnosticTarget(check.target),
        configKeys: (check.configKeys ?? []).map((ck) => ({
          key: ck.key,
          configured: Boolean(ck.configured),
        })),
        detail: safeDetail,
        remediation: safeRemediation,
      });

      if (
        check.state === "degraded" ||
        check.state === "unavailable" ||
        check.state === "misconfigured"
      ) {
        if (check.id === "database") {
          components.database.state = elevateState(
            components.database.state,
            "degraded",
          );
          components.database.message =
            "Primary database is experiencing elevated latency or connectivity issues.";
        } else if (check.id === "redis") {
          components.cache.state = elevateState(components.cache.state, "degraded");
          components.cache.message =
            "Cache layer is degraded; fallback protections are active.";
        } else if (check.id.includes("stellar") || check.id.includes("horizon")) {
          components.oracle.state = elevateState(
            components.oracle.state,
            "degraded",
          );
          components.oracle.message =
            "Stellar network connectivity is experiencing elevated latency.";
          components.reconciliation.state = elevateState(
            components.reconciliation.state,
            "degraded",
          );
          components.reconciliation.message =
            "Ledger reconciliation is delayed due to upstream network latency.";
        } else if (check.id.includes("eth") || check.id.includes("rpc")) {
          components.defi.state = elevateState(components.defi.state, "degraded");
          components.defi.message =
            "Upstream RPC provider is degraded; DeFi quotes may be delayed.";
        }
      }
    }
  }

  // 6. Evaluate manual component degradations declared by operators
  const manualDegradations = (input.manualDegradations ?? []).map((deg) => ({
    componentId: deg.componentId,
    reason: sanitizeStatusText(deg.reason, { stripInternalHosts: false, env }),
    declaredBy: sanitizeStatusText(deg.declaredBy, {
      stripInternalHosts: false,
      env,
    }),
    declaredAt: deg.declaredAt || nowIso,
    estimatedRecoveryAt: deg.estimatedRecoveryAt ?? null,
  }));

  for (const deg of manualDegradations) {
    const targetComp = components[deg.componentId];
    if (targetComp) {
      targetComp.state = elevateState(targetComp.state, "degraded");
      targetComp.message = sanitizePublicReason(deg.reason, "degraded", env);
      overallState = elevateState(overallState, "degraded");
    }
    const retrySec = computeRetryAfterSeconds(
      deg.estimatedRecoveryAt ?? undefined,
      nowMs,
    );
    if (retrySec !== undefined) retryCandidates.push(retrySec);
  }

  // 7. Evaluate active pauses from PauseControlService
  const publicPausedScopes: PublicPausedScopeView[] = [];
  const operatorPauses: OperatorPauseScopeView[] = [];

  for (const pause of activePauses) {
    const scope = (pause.scope || "").toLowerCase();
    const expiresIso = toIsoOrUndefined(pause.expiresAt);
    const retrySec = computeRetryAfterSeconds(expiresIso, nowMs);
    if (retrySec !== undefined) retryCandidates.push(retrySec);

    const pauseIsMaintenance =
      scope === "all" && isMaintenanceReason(pause.reason);
    const scopeState: "paused" | "maintenance" = pauseIsMaintenance
      ? "maintenance"
      : "paused";

    const publicReason = sanitizePublicReason(
      pause.reason,
      pauseIsMaintenance ? "maintenance" : "paused",
      env,
    );

    publicPausedScopes.push({
      scope,
      state: scopeState,
      publicReason,
      ...(expiresIso ? { expiresAt: expiresIso } : {}),
    });

    operatorPauses.push({
      scope,
      reason: sanitizeStatusText(pause.reason, {
        stripInternalHosts: false,
        env,
      }),
      activatedBy: sanitizeStatusText(pause.activatedBy ?? "system", {
        stripInternalHosts: false,
        env,
      }),
      activatedByRole: pause.activatedByRole ?? null,
      activatedAt: toIsoOrUndefined(pause.activatedAt) ?? nowIso,
      expiresAt: expiresIso ?? null,
      environment: pause.environment ?? null,
    });

    const mappedComponents = SCOPE_TO_COMPONENT[scope] ?? [];
    for (const compId of mappedComponents) {
      components[compId].state = elevateState(
        components[compId].state,
        scopeState,
      );
      components[compId].message = publicReason;
    }

    if (pauseIsMaintenance) {
      overallState = elevateState(overallState, "maintenance");
    } else if (HIGH_IMPACT_PAUSE_SCOPES.has(scope)) {
      overallState = elevateState(overallState, "paused");
    } else {
      overallState = elevateState(overallState, "degraded");
    }
  }

  // 8. Evaluate explicit maintenance window
  let publicMaintenanceWindow: PublicMaintenanceWindowView | null = null;
  if (maintenanceWindow) {
    overallState = elevateState(overallState, "maintenance");
    const safeMsg = sanitizePublicReason(
      maintenanceWindow.reason,
      "maintenance",
      env,
    );
    const endIso = toIsoOrUndefined(maintenanceWindow.estimatedEndAt);
    const startIso = toIsoOrUndefined(maintenanceWindow.scheduledStartAt);
    const retrySec = computeRetryAfterSeconds(endIso, nowMs);
    if (retrySec !== undefined) retryCandidates.push(retrySec);

    const affectedScopes =
      maintenanceWindow.affectedScopes &&
      maintenanceWindow.affectedScopes.length > 0
        ? maintenanceWindow.affectedScopes
        : ["all"];

    publicMaintenanceWindow = {
      active: true,
      publicMessage: safeMsg,
      ...(startIso ? { scheduledStartAt: startIso } : {}),
      ...(endIso ? { estimatedEndAt: endIso } : {}),
      affectedScopes,
    };

    for (const compId of ALL_PUBLIC_COMPONENTS) {
      components[compId].state = "maintenance";
      components[compId].message = safeMsg;
    }
  }

  // 9. Compute capabilities for UI and API consumers
  const isAllPaused = activePauses.some(
    (p) => (p.scope || "").toLowerCase() === "all",
  );
  const isMaintenance = overallState === "maintenance";
  const isScopePaused = (scopeName: string) =>
    isMaintenance ||
    isAllPaused ||
    activePauses.some((p) => (p.scope || "").toLowerCase() === scopeName);

  const capabilities: PublicCapabilitiesView = {
    readOnly: isMaintenance || isAllPaused,
    tradingEnabled: !isScopePaused("trading"),
    paymentsEnabled: !isScopePaused("payments"),
    withdrawalsEnabled: !isScopePaused("withdrawals"),
    defiEnabled: !isScopePaused("defi"),
    oracleEnabled: !isScopePaused("oracle"),
    reconciliationEnabled: !isScopePaused("reconciliation"),
    backgroundJobsProcessing: !isMaintenance && !isAllPaused,
  };

  if (!capabilities.backgroundJobsProcessing) {
    components.background_workers.state = isMaintenance
      ? "maintenance"
      : "paused";
    components.background_workers.message = isMaintenance
      ? "Background workers are deferred during scheduled maintenance."
      : "Background workers are paused while system-wide pause is active.";
  } else if (overallState === "degraded" || activePauses.length > 0) {
    components.background_workers.state = elevateState(
      components.background_workers.state,
      "degraded",
    );
    components.background_workers.message =
      "Background workers are active with scope-aware deferral and adaptive backoff.";
  }

  if (overallState !== "operational") {
    components.api.state = overallState;
    components.api.message =
      overallState === "maintenance"
        ? "API is in maintenance mode (read-only for non-admin requests)."
        : overallState === "paused"
          ? "API write operations are paused for selected scopes."
          : "API is operational with partial service degradation.";
  }

  // 10. Determine top-level summary and HTTP status code
  let summary = "All systems are operational.";
  if (overallState === "maintenance") {
    summary =
      publicMaintenanceWindow?.publicMessage ??
      publicPausedScopes.find((s) => s.state === "maintenance")?.publicReason ??
      "The platform is currently undergoing scheduled maintenance.";
  } else if (overallState === "paused") {
    const firstPaused = publicPausedScopes[0];
    summary = firstPaused
      ? `Operations paused (${firstPaused.scope}): ${firstPaused.publicReason}`
      : "Selected platform operations are temporarily paused.";
  } else if (overallState === "degraded") {
    if (publicPausedScopes.length > 0) {
      summary = `Partial service pause (${publicPausedScopes.map((p) => p.scope).join(", ")}): ${publicPausedScopes[0].publicReason}`;
    } else if (manualDegradations.length > 0) {
      summary = sanitizePublicReason(
        manualDegradations[0].reason,
        "degraded",
        env,
      );
    } else {
      summary =
        "Some platform dependencies are experiencing elevated latency or partial degradation.";
    }
  }

  const retryAfterSeconds =
    retryCandidates.length > 0
      ? Math.min(...retryCandidates)
      : overallState === "maintenance"
        ? 300
        : overallState === "paused"
          ? 60
          : undefined;

  const httpStatusCode: 200 | 503 =
    overallState === "maintenance" || isAllPaused ? 503 : 200;

  const publicStatus: PublicSystemStatusView = {
    state: overallState,
    httpStatusCode,
    summary,
    generatedAt: nowIso,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    maintenanceWindow: publicMaintenanceWindow,
    pausedScopes: publicPausedScopes,
    components,
    capabilities,
  };

  // 11. Build operator-specific background path summary and runbook guidance
  const deferredScopes = isMaintenance || isAllPaused
    ? ["all"]
    : activePauses.map((p) => (p.scope || "").toLowerCase());

  const backgroundMode: "processing" | "throttled" | "deferred" =
    isMaintenance || isAllPaused
      ? "deferred"
      : overallState === "degraded" || activePauses.length > 0
        ? "throttled"
        : "processing";

  const backgroundReason =
    backgroundMode === "deferred"
      ? "All non-recovery background jobs are deferred until maintenance/global pause is lifted."
      : backgroundMode === "throttled"
        ? deferredScopes.length > 0
          ? `Jobs in paused scopes (${deferredScopes.join(", ")}) are deferred; remaining queues apply adaptive backoff.`
          : "Background queues are applying adaptive backoff (2x) due to dependency degradation."
        : "All background queues are processing normally.";

  const sanitizedHistory: StateTransitionEntry[] = (
    input.stateHistory ?? []
  ).map((item) => ({
    ...item,
    publicSummary: sanitizePublicReason(
      item.publicSummary,
      item.toState,
      env,
    ),
    ...(item.operatorNote
      ? {
          operatorNote: sanitizeStatusText(item.operatorNote, {
            stripInternalHosts: false,
            env,
          }),
        }
      : {}),
  }));

  const operatorStatus: OperatorSystemStatusView = {
    ...publicStatus,
    rawStateSources: {
      maintenanceOverrideActive: Boolean(publicMaintenanceWindow?.active),
      activePauseScopes: operatorPauses.map((p) => p.scope),
      manualDegradedComponents: manualDegradations.map((d) => d.componentId),
      readinessStatus: input.readiness?.status ?? "ok",
      dependencyStatus: input.dependencyReport?.status ?? "healthy",
      backgroundWorkerMode: backgroundMode,
    },
    activePauses: operatorPauses,
    manualDegradations,
    dependencyDiagnostics,
    backgroundPath: {
      mode: backgroundMode,
      deferredScopes,
      activeBackoffMultiplier: backgroundMode === "throttled" ? 2 : 1,
      reason: backgroundReason,
    },
    stateHistory: sanitizedHistory,
    runbook: buildRunbookGuidance(overallState),
  };

  return { publicStatus, operatorStatus };
}

export function buildRunbookGuidance(
  state: PublicSystemState,
): OperatorRunbookGuidance {
  switch (state) {
    case "maintenance":
      return {
        currentState: "maintenance",
        verificationSteps: [
          "Verify GET /status and GET /health/status return state='maintenance' and HTTP 503 with Retry-After header.",
          "Confirm non-admin mutating requests receive 503 SERVICE_UNAVAILABLE while read-only GET routes remain accessible.",
          "Verify background workers are deferring non-recovery jobs without incrementing dead-letter counters.",
        ],
        rollbackAndRecoverySteps: [
          "Run database/dependency readiness checks via GET /health/dependencies/diagnostics?refresh=true.",
          "Clear maintenance window via POST /status/maintenance/clear (or resume 'all' scope via POST /pause-control/resume).",
          "Confirm GET /status transitions to 'operational' (or 'degraded' if warm-up is in progress) and WebSocket clients receive system:status:update.",
        ],
        edgeCaseWarnings: [
          "If estimatedEndAt expires while migrations are still running, extend the maintenance window before expiry to prevent premature write resumption.",
          "Admin tokens bypass maintenance write locks for recovery actions; avoid executing user-facing trades with admin credentials during maintenance.",
        ],
      };
    case "paused":
      return {
        currentState: "paused",
        verificationSteps: [
          "Inspect activePauses in GET /status/operator to confirm which scopes are halted and their expiry timestamps.",
          "Verify unaffected scopes continue accepting requests while paused scopes return 503 with Retry-After.",
        ],
        rollbackAndRecoverySteps: [
          "Validate upstream settlement/oracle invariants and confirm root cause is mitigated.",
          "Resume paused scope(s) via POST /pause-control/resume with an audit reason.",
          "Monitor deferred background jobs as they drain with exponential backoff.",
        ],
        edgeCaseWarnings: [
          "Overlapping pause and degradation states resolve to the highest severity ('paused'); resuming a pause while a dependency is still slow will transition the state to 'degraded', not 'operational'.",
        ],
      };
    case "degraded":
      return {
        currentState: "degraded",
        verificationSteps: [
          "Review dependencyDiagnostics and manualDegradations in GET /status/operator.",
          "Verify UI banner shows warning state while core read/write capabilities remain available for unpaused scopes.",
        ],
        rollbackAndRecoverySteps: [
          "Mitigate slow/unavailable dependency or clear manual degradation via POST /status/degradation/clear.",
          "Force a dependency health refresh via GET /health/dependencies/diagnostics?refresh=true.",
        ],
        edgeCaseWarnings: [
          "Optional dependencies (e.g., Elasticsearch, SMTP) surface advisory findings without halting readiness probes.",
        ],
      };
    default:
      return {
        currentState: "operational",
        verificationSteps: [
          "Confirm GET /status returns state='operational' and HTTP 200.",
          "Confirm all capability flags in capabilities are true and readOnly is false.",
        ],
        rollbackAndRecoverySteps: [
          "No active recovery required. Use POST /pause-control/activate or POST /status/maintenance for emergency halts.",
        ],
        edgeCaseWarnings: [
          "Ensure all operator pause and maintenance reasons omit raw credentials; the status boundary automatically scrubs secrets as defense-in-depth.",
        ],
      };
  }
}

// ---------------------------------------------------------------------------
// UI, API, and Background Path Evaluators
// ---------------------------------------------------------------------------

/**
 * Evaluates the UI status banner, capabilities, and real-time WebSocket event
 * contract for a given public status snapshot.
 */
export function evaluateUiStatusContract(
  publicStatus: PublicSystemStatusView,
): UiStatusBannerContract {
  const safeMessage = neutralizeHtmlAndXss(publicStatus.summary);

  if (publicStatus.state === "operational") {
    return {
      visible: false,
      state: "operational",
      severity: "none",
      badgeText: "All Systems Operational",
      title: "Operational",
      message: safeMessage,
      dismissible: true,
      capabilities: publicStatus.capabilities,
      websocketEvent: {
        event: "system:status:update",
        payload: publicStatus,
      },
    };
  }

  if (publicStatus.state === "maintenance") {
    return {
      visible: true,
      state: "maintenance",
      severity: "info",
      badgeText: "Scheduled Maintenance",
      title: "Platform Under Maintenance",
      message: safeMessage,
      retryAfterSeconds: publicStatus.retryAfterSeconds,
      dismissible: false,
      capabilities: publicStatus.capabilities,
      websocketEvent: {
        event: "system:status:update",
        payload: publicStatus,
      },
    };
  }

  if (publicStatus.state === "paused") {
    return {
      visible: true,
      state: "paused",
      severity: "error",
      badgeText: "Operations Paused",
      title: "Selected Operations Temporarily Paused",
      message: safeMessage,
      retryAfterSeconds: publicStatus.retryAfterSeconds,
      dismissible: false,
      capabilities: publicStatus.capabilities,
      websocketEvent: {
        event: "system:status:update",
        payload: publicStatus,
      },
    };
  }

  return {
    visible: true,
    state: "degraded",
    severity: "warning",
    badgeText: "Degraded Performance",
    title: "Partial Service Degradation",
    message: safeMessage,
    retryAfterSeconds: publicStatus.retryAfterSeconds,
    dismissible: true,
    capabilities: publicStatus.capabilities,
    websocketEvent: {
      event: "system:status:update",
      payload: publicStatus,
    },
  };
}

/**
 * Evaluates whether an incoming API request is allowed or rejected under the
 * current public status model, and computes the response headers and safe
 * RFC 7807 Problem Details body when rejected.
 */
export function evaluateApiRequestGate(
  publicStatus: PublicSystemStatusView,
  context: ApiRequestGateContext,
): ApiRequestGateDecision {
  const method = (context.method || "GET").toUpperCase();
  const path = context.path || "/";
  const scope = context.scope?.toLowerCase();
  const roles = (context.actorRoles ?? []).map((r) => r.toUpperCase());

  const headers: Record<string, string> = {
    "X-Trellis-System-Status": publicStatus.state,
  };
  if (publicStatus.retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(publicStatus.retryAfterSeconds);
  }

  // 1. Status and health routes are always accessible
  if (/^\/?(?:api\/v\d+\/)?(?:health|status)\b/i.test(path)) {
    return {
      allowed: true,
      bypassReason: "status_or_health_route",
      statusCode: 200,
      headers,
    };
  }

  // 2. Read-only HTTP methods (GET, HEAD, OPTIONS) remain available so users can view portfolios & status
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return {
      allowed: true,
      bypassReason: "read_only_method",
      statusCode: 200,
      headers,
    };
  }

  // 3. Admin operators bypass write restrictions for recovery & control actions
  if (roles.includes("ADMIN")) {
    return {
      allowed: true,
      bypassReason: "admin_override",
      statusCode: 200,
      headers,
    };
  }

  // 4. Maintenance mode blocks all non-admin mutating requests
  if (publicStatus.state === "maintenance" || publicStatus.capabilities.readOnly) {
    const retryAfter = publicStatus.retryAfterSeconds ?? 300;
    headers["Retry-After"] = String(retryAfter);
    return {
      allowed: false,
      statusCode: 503,
      headers,
      errorPayload: {
        type: "https://trellis-stellar.github.io/Trellis-API/problems/SERVICE_UNAVAILABLE",
        title: "Service temporarily unavailable",
        status: 503,
        detail: publicStatus.summary,
        errorCode: "SERVICE_UNAVAILABLE",
        state: publicStatus.state,
        ...(scope ? { scope } : {}),
        retryable: true,
        retryAfterSeconds: retryAfter,
        remediation:
          "The platform is currently in maintenance or global pause mode. Please retry after the Retry-After window.",
      },
    };
  }

  // 5. Scope-specific pause check for mutating requests
  if (scope) {
    const matchingPause = publicStatus.pausedScopes.find(
      (p) => p.scope === scope || p.scope === "all",
    );
    if (matchingPause) {
      const retryAfter = publicStatus.retryAfterSeconds ?? 60;
      headers["Retry-After"] = String(retryAfter);
      return {
        allowed: false,
        statusCode: 503,
        headers,
        errorPayload: {
          type: "https://trellis-stellar.github.io/Trellis-API/problems/SERVICE_UNAVAILABLE",
          title: "Service temporarily unavailable",
          status: 503,
          detail: matchingPause.publicReason,
          errorCode: "SERVICE_UNAVAILABLE",
          state: publicStatus.state,
          scope,
          retryable: true,
          retryAfterSeconds: retryAfter,
          remediation: `Operations in scope '${scope}' are temporarily paused. Please retry after ${retryAfter} seconds.`,
        },
      };
    }
  }

  return {
    allowed: true,
    statusCode: 200,
    headers,
  };
}

/**
 * Evaluates how background workers and scheduled jobs should behave under the
 * current public status model.
 */
export function evaluateBackgroundJobGate(
  publicStatus: PublicSystemStatusView,
  context: BackgroundJobGateContext,
): BackgroundJobGateDecision {
  const resolvedScope = resolveJobScope(context.jobType, context.scope);

  // Essential operator recovery jobs always execute
  if (context.isEssentialRecovery) {
    return {
      decision: "execute",
      jobType: context.jobType,
      resolvedScope,
      state: publicStatus.state,
      backoffMultiplier: 1,
      delayMs: 0,
      reason: "Essential recovery job permitted to execute across all states.",
    };
  }

  // 1. Maintenance mode or global pause defers all non-essential background jobs
  if (
    publicStatus.state === "maintenance" ||
    !publicStatus.capabilities.backgroundJobsProcessing
  ) {
    const retryAfterSeconds = publicStatus.retryAfterSeconds ?? 300;
    return {
      decision: "defer",
      jobType: context.jobType,
      resolvedScope,
      state: publicStatus.state,
      backoffMultiplier: 1,
      delayMs: retryAfterSeconds * 1000,
      retryAfterSeconds,
      reason:
        "Background job deferred while platform is in maintenance or global pause state.",
    };
  }

  // 2. Scope-specific pause defers jobs targeting that scope
  const scopePaused = publicStatus.pausedScopes.find(
    (p) => p.scope === resolvedScope || p.scope === "all",
  );
  if (scopePaused) {
    const retryAfterSeconds = publicStatus.retryAfterSeconds ?? 60;
    return {
      decision: "defer",
      jobType: context.jobType,
      resolvedScope,
      state: publicStatus.state,
      backoffMultiplier: 1,
      delayMs: retryAfterSeconds * 1000,
      retryAfterSeconds,
      reason: `Background job deferred because scope '${resolvedScope}' is paused.`,
    };
  }

  // 3. Degraded state executes with adaptive backoff to avoid overwhelming slow dependencies
  if (publicStatus.state === "degraded") {
    return {
      decision: "execute_with_backoff",
      jobType: context.jobType,
      resolvedScope,
      state: publicStatus.state,
      backoffMultiplier: 2,
      delayMs: 2000,
      reason:
        "System is in degraded state; executing background job with 2x adaptive backoff.",
    };
  }

  // 4. Operational state
  return {
    decision: "execute",
    jobType: context.jobType,
    resolvedScope,
    state: publicStatus.state,
    backoffMultiplier: 1,
    delayMs: 0,
    reason: "System is operational; executing background job normally.",
  };
}

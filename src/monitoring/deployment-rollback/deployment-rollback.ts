export type RollbackCheckKind =
  | "version"
  | "health"
  | "schema"
  | "dependency"
  | "authorization";

export interface RollbackCheckDefinition {
  name: string;
  kind: RollbackCheckKind;
  required?: boolean;
  expectedVersion?: string;
  requireAuthFailClosed?: boolean;
}

export interface RollbackTarget {
  deploymentId: string;
  fromVersion: string;
  toVersion: string;
  environment: string;
  checks: RollbackCheckDefinition[];
}

export interface RollbackProbeContext {
  target: RollbackTarget;
  attempt: number;
  authorizationProbe: boolean;
}

export interface RollbackProbeResult {
  ok: boolean;
  status?: number;
  observedVersion?: string;
  error?: string;
  retryable?: boolean;
}

export type RollbackProbe = (
  check: RollbackCheckDefinition,
  context: RollbackProbeContext,
) => Promise<RollbackProbeResult>;

export interface RollbackActor {
  id: string;
  roles: string[];
}

export interface RollbackVerificationOptions {
  maxAttempts?: number;
  backoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  probeAuthorization?: boolean;
  actor?: RollbackActor;
  allowedRoles?: string[];
  requireAuthorizedActor?: boolean;
  now?: () => Date;
}

export interface RollbackCheckResult {
  name: string;
  kind: RollbackCheckKind;
  required: boolean;
  ok: boolean;
  attempts: number;
  status?: number;
  observedVersion?: string;
  error?: string;
  authorizationVerified?: boolean;
}

export interface RollbackVerificationReport {
  deploymentId: string;
  fromVersion: string;
  toVersion: string;
  environment: string;
  allPassed: boolean;
  canResumeTraffic: boolean;
  passed: number;
  failed: number;
  warnings: number;
  results: RollbackCheckResult[];
  remediation: string[];
  verifiedAt: string;
}

export class UnauthorizedRollbackVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedRollbackVerificationError";
  }
}

const DEFAULT_ALLOWED_ROLES = ["ADMIN", "RELEASE_MANAGER"];

const DEFAULT_SLEEP = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function validateTarget(target: RollbackTarget): void {
  if (!target.deploymentId?.trim()) {
    throw new Error("Rollback target requires a non-empty deploymentId");
  }
  if (!target.fromVersion?.trim() || !target.toVersion?.trim()) {
    throw new Error("Rollback target requires non-empty fromVersion and toVersion");
  }
  if (target.fromVersion.trim() === target.toVersion.trim()) {
    throw new Error(
      `Rollback target fromVersion and toVersion must differ (both are '${target.toVersion.trim()}')`,
    );
  }
  if (!target.environment?.trim()) {
    throw new Error("Rollback target requires a non-empty environment");
  }
  if (!Array.isArray(target.checks) || target.checks.length === 0) {
    throw new Error("Rollback target requires at least one verification check");
  }

  const names = new Set<string>();
  for (const check of target.checks) {
    if (!check.name?.trim()) {
      throw new Error("Every rollback verification check requires a non-empty name");
    }
    if (names.has(check.name)) {
      throw new Error(`Duplicate rollback verification check name: ${check.name}`);
    }
    names.add(check.name);
  }
}

function authorizeActor(options: RollbackVerificationOptions): void {
  const mustAuthorize =
    options.requireAuthorizedActor === true || options.actor !== undefined;
  if (!mustAuthorize) {
    return;
  }

  const actor = options.actor;
  if (!actor || !actor.id?.trim()) {
    throw new UnauthorizedRollbackVerificationError(
      "Rollback verification requires an authenticated actor",
    );
  }

  const allowed = new Set(
    (options.allowedRoles ?? DEFAULT_ALLOWED_ROLES).map((role) =>
      role.toUpperCase(),
    ),
  );
  const actorRoles = Array.isArray(actor.roles) ? actor.roles : [];
  const hasAllowedRole = actorRoles.some((role) =>
    allowed.has(role.toUpperCase()),
  );

  if (!hasAllowedRole) {
    throw new UnauthorizedRollbackVerificationError(
      `Actor '${actor.id}' lacks required role for rollback verification`,
    );
  }
}

function evaluateVersionExpectation(
  check: RollbackCheckDefinition,
  target: RollbackTarget,
  result: RollbackProbeResult,
): RollbackProbeResult {
  if (!result.ok || check.kind !== "version") {
    return result;
  }

  const expected = (check.expectedVersion ?? target.toVersion).trim();
  const observed = result.observedVersion?.trim();

  if (!observed) {
    return {
      ...result,
      ok: false,
      retryable: false,
      error: `Version check '${check.name}' did not report an observedVersion (expected '${expected}')`,
    };
  }

  if (observed !== expected) {
    return {
      ...result,
      ok: false,
      retryable: false,
      error: `Version mismatch for '${check.name}': expected '${expected}', observed '${observed}'`,
    };
  }

  return result;
}

export async function runDeploymentRollbackVerification(
  target: RollbackTarget,
  probe: RollbackProbe,
  options: RollbackVerificationOptions = {},
): Promise<RollbackVerificationReport> {
  authorizeActor(options);
  validateTarget(target);

  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
  const sleep = options.sleep ?? DEFAULT_SLEEP;
  const now = options.now ?? (() => new Date());
  const results: RollbackCheckResult[] = [];
  const remediation: string[] = [];

  for (const check of target.checks) {
    const required = check.required !== false;
    let last: RollbackProbeResult = { ok: false, error: "No probe result" };
    let attempts = 0;

    while (attempts < maxAttempts) {
      attempts += 1;
      try {
        const raw = await probe(check, {
          target,
          attempt: attempts,
          authorizationProbe: false,
        });
        last = evaluateVersionExpectation(check, target, raw);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        last = { ok: false, error: message, retryable: true };
      }

      if (last.ok || last.retryable === false) {
        break;
      }

      if (attempts < maxAttempts) {
        const delayMs =
          options.backoffMs !== undefined
            ? options.backoffMs
            : 100 * 2 ** (attempts - 1);
        await sleep(delayMs);
      }
    }

    let authorizationVerified: boolean | undefined;
    const shouldProbeAuth =
      options.probeAuthorization === true ||
      check.requireAuthFailClosed === true ||
      check.kind === "authorization";

    if (last.ok && shouldProbeAuth) {
      let authResult: RollbackProbeResult;
      try {
        authResult = await probe(check, {
          target,
          attempt: attempts,
          authorizationProbe: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        authResult = { ok: false, error: message };
      }

      const failedClosed =
        !authResult.ok &&
        (authResult.status === 401 || authResult.status === 403);

      authorizationVerified = failedClosed;
      if (!failedClosed) {
        last = {
          ok: false,
          status: authResult.status,
          observedVersion: last.observedVersion,
          error: "Authorization probe did not fail closed (expected 401 or 403)",
        };
      }
    }

    results.push({
      name: check.name,
      kind: check.kind,
      required,
      ok: last.ok,
      attempts,
      status: last.status,
      observedVersion: last.observedVersion,
      error: last.error,
      authorizationVerified,
    });

    if (!last.ok) {
      if (
        check.kind === "version" &&
        last.observedVersion?.trim() === target.fromVersion.trim()
      ) {
        remediation.push(
          `[${check.name}] Deployment is still running failed version '${target.fromVersion}'. Re-apply rollback artifact '${target.toVersion}' before resuming traffic.`,
        );
      } else if (authorizationVerified === false) {
        remediation.push(
          `[${check.name}] Endpoint failed to reject unauthenticated request. Verify auth guards/middleware before resuming traffic.`,
        );
      } else {
        remediation.push(
          `[${check.name}] Check failed after ${attempts} attempt(s): ${last.error ?? "unknown error"}.`,
        );
      }
    }
  }

  const failed = results.filter((r) => !r.ok && r.required).length;
  const warnings = results.filter((r) => !r.ok && !r.required).length;
  const passed = results.filter((r) => r.ok).length;
  const allPassed = failed === 0;

  return {
    deploymentId: target.deploymentId,
    fromVersion: target.fromVersion,
    toVersion: target.toVersion,
    environment: target.environment,
    allPassed,
    canResumeTraffic: allPassed,
    passed,
    failed,
    warnings,
    results,
    remediation,
    verifiedAt: now().toISOString(),
  };
}

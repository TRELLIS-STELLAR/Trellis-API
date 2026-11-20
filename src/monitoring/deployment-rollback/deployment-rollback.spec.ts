import {
  RollbackTarget,
  UnauthorizedRollbackVerificationError,
  runDeploymentRollbackVerification,
} from "./deployment-rollback";

describe("deployment rollback verification checks", () => {
  const baseTarget: RollbackTarget = {
    deploymentId: "deploy-2026-11-20-01",
    fromVersion: "1.5.0",
    toVersion: "1.4.2",
    environment: "production",
    checks: [
      { name: "api-version", kind: "version" },
      { name: "health-readiness", kind: "health" },
      { name: "db-schema", kind: "schema" },
    ],
  };

  it("passes when all required rollback checks succeed and version matches target", async () => {
    const report = await runDeploymentRollbackVerification(
      baseTarget,
      async (check) =>
        check.kind === "version"
          ? { ok: true, status: 200, observedVersion: "1.4.2" }
          : { ok: true, status: 200 },
      { now: () => new Date("2026-11-20T12:00:00.000Z") },
    );

    expect(report.allPassed).toBe(true);
    expect(report.canResumeTraffic).toBe(true);
    expect(report.passed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.warnings).toBe(0);
    expect(report.remediation).toHaveLength(0);
    expect(report.verifiedAt).toBe("2026-11-20T12:00:00.000Z");
  });

  it("retries transient probe failures and thrown errors with backoff", async () => {
    const attempts = new Map<string, number>();
    const delays: number[] = [];

    const report = await runDeploymentRollbackVerification(
      baseTarget,
      async (check) => {
        const count = (attempts.get(check.name) ?? 0) + 1;
        attempts.set(check.name, count);
        if (check.name === "health-readiness" && count === 1) {
          throw new Error("ECONNRESET");
        }
        if (check.name === "api-version" && count === 1) {
          return { ok: false, status: 503, error: "warming up" };
        }
        return check.kind === "version"
          ? { ok: true, status: 200, observedVersion: "1.4.2" }
          : { ok: true, status: 200 };
      },
      {
        maxAttempts: 3,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(report.allPassed).toBe(true);
    expect(report.canResumeTraffic).toBe(true);
    expect(delays).toEqual([100, 100]);
    expect(report.results.find((r) => r.name === "api-version")?.attempts).toBe(2);
    expect(report.results.find((r) => r.name === "health-readiness")?.attempts).toBe(2);
  });

  it("fails required checks after retry exhaustion and blocks traffic resumption", async () => {
    const report = await runDeploymentRollbackVerification(
      baseTarget,
      async (check) => {
        if (check.name === "db-schema") {
          return { ok: false, status: 500, error: "schema version mismatch" };
        }
        return check.kind === "version"
          ? { ok: true, status: 200, observedVersion: "1.4.2" }
          : { ok: true, status: 200 };
      },
      { maxAttempts: 2, backoffMs: 0, sleep: async () => undefined },
    );

    expect(report.allPassed).toBe(false);
    expect(report.canResumeTraffic).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(2);
    expect(report.results.find((r) => r.name === "db-schema")?.attempts).toBe(2);
    expect(report.remediation[0]).toContain("[db-schema]");
  });

  it("fails fast without retrying when version check observes the old failed version", async () => {
    let calls = 0;
    const report = await runDeploymentRollbackVerification(
      {
        ...baseTarget,
        checks: [{ name: "api-version", kind: "version" }],
      },
      async () => {
        calls += 1;
        return { ok: true, status: 200, observedVersion: "1.5.0" };
      },
      { maxAttempts: 3, backoffMs: 0, sleep: async () => undefined },
    );

    expect(calls).toBe(1);
    expect(report.allPassed).toBe(false);
    expect(report.canResumeTraffic).toBe(false);
    expect(report.results[0].error).toContain("Version mismatch");
    expect(report.remediation[0]).toContain("still running failed version '1.5.0'");
  });

  it("records optional check failures as warnings without blocking traffic", async () => {
    const report = await runDeploymentRollbackVerification(
      {
        ...baseTarget,
        checks: [
          { name: "api-version", kind: "version" },
          { name: "cache-warmup", kind: "dependency", required: false },
        ],
      },
      async (check) => {
        if (check.name === "cache-warmup") {
          return { ok: false, status: 503, error: "cache cold", retryable: false };
        }
        return { ok: true, status: 200, observedVersion: "1.4.2" };
      },
    );

    expect(report.allPassed).toBe(true);
    expect(report.canResumeTraffic).toBe(true);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.warnings).toBe(1);
    expect(report.remediation).toHaveLength(1);
  });

  it("verifies endpoint authorization fails closed with 401 or 403", async () => {
    const passedReport = await runDeploymentRollbackVerification(
      {
        ...baseTarget,
        checks: [{ name: "admin-status", kind: "authorization" }],
      },
      async (_check, ctx) =>
        ctx.authorizationProbe
          ? { ok: false, status: 403 }
          : { ok: true, status: 200 },
    );

    expect(passedReport.allPassed).toBe(true);
    expect(passedReport.results[0].authorizationVerified).toBe(true);

    const failedReport = await runDeploymentRollbackVerification(
      {
        ...baseTarget,
        checks: [{ name: "admin-status", kind: "authorization" }],
      },
      async (_check, ctx) =>
        ctx.authorizationProbe
          ? { ok: true, status: 200 }
          : { ok: true, status: 200 },
    );

    expect(failedReport.allPassed).toBe(false);
    expect(failedReport.canResumeTraffic).toBe(false);
    expect(failedReport.results[0].authorizationVerified).toBe(false);
    expect(failedReport.results[0].error).toContain("did not fail closed");
  });

  it("enforces actor RBAC authorization before executing any probes", async () => {
    let probed = false;
    const probe = async () => {
      probed = true;
      return { ok: true, status: 200, observedVersion: "1.4.2" };
    };

    await expect(
      runDeploymentRollbackVerification(baseTarget, probe, {
        requireAuthorizedActor: true,
      }),
    ).rejects.toThrow(UnauthorizedRollbackVerificationError);
    expect(probed).toBe(false);

    await expect(
      runDeploymentRollbackVerification(baseTarget, probe, {
        actor: { id: "user-1", roles: ["VIEWER"] },
      }),
    ).rejects.toThrow(UnauthorizedRollbackVerificationError);
    expect(probed).toBe(false);

    const allowed = await runDeploymentRollbackVerification(baseTarget, probe, {
      actor: { id: "ops-1", roles: ["RELEASE_MANAGER"] },
    });
    expect(probed).toBe(true);
    expect(allowed.allPassed).toBe(true);
  });

  it("rejects invalid rollback targets and duplicate check names", async () => {
    const noopProbe = async () => ({ ok: true });

    await expect(
      runDeploymentRollbackVerification(
        { ...baseTarget, fromVersion: "1.4.2", toVersion: "1.4.2" },
        noopProbe,
      ),
    ).rejects.toThrow("must differ");

    await expect(
      runDeploymentRollbackVerification(
        { ...baseTarget, checks: [] },
        noopProbe,
      ),
    ).rejects.toThrow("at least one verification check");

    await expect(
      runDeploymentRollbackVerification(
        {
          ...baseTarget,
          checks: [
            { name: "dup", kind: "health" },
            { name: "dup", kind: "schema" },
          ],
        },
        noopProbe,
      ),
    ).rejects.toThrow("Duplicate");
  });
});

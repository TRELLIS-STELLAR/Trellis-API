import { runDeploymentSmokeTests } from "./deployment-smoke";

describe("deployment smoke tests", () => {
  const addresses = [
    { name: "treasury", address: "G" + "A".repeat(55), kind: "account" as const },
    { name: "oracle", address: "C" + "B".repeat(55), kind: "contract" as const },
  ];

  it("probes every initialized address and retries transient failures", async () => {
    const attempts = new Map<string, number>();
    const report = await runDeploymentSmokeTests(addresses, async (entry) => {
      const count = (attempts.get(entry.name) ?? 0) + 1;
      attempts.set(entry.name, count);
      return count === 1 ? { ok: false, status: 503 } : { ok: true, status: 200 };
    }, { backoffMs: 0, sleep: async () => undefined });

    expect(report.allPassed).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.results.every((result) => result.attempts === 2)).toBe(true);
  });

  it("fails required addresses after retry exhaustion", async () => {
    const report = await runDeploymentSmokeTests(addresses, async () => ({ ok: false, status: 500, error: "down" }), {
      maxAttempts: 2,
      backoffMs: 0,
      sleep: async () => undefined,
    });
    expect(report.allPassed).toBe(false);
    expect(report.failed).toBe(2);
  });

  it("requires authorization probes to fail closed", async () => {
    const report = await runDeploymentSmokeTests([addresses[0]], async (_entry, authorization) =>
      authorization ? { ok: false, status: 403 } : { ok: true, status: 200 }, { probeAuthorization: true });
    expect(report.allPassed).toBe(true);
  });

  it("rejects duplicate initialized addresses before probing", async () => {
    await expect(runDeploymentSmokeTests([addresses[0], addresses[0]], async () => ({ ok: true }))).rejects.toThrow("Duplicate");
  });
});

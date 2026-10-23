import {
  checkEnvVars,
  checkToolVersion,
  checkTcpConnectivity,
  checkHttpEndpoint,
  checkBootstrapAdmin,
  buildReport,
  checkTcpConnectivityWithRetry,
  checkHttpEndpointWithRetry,
  checkDatabaseAuth,
  checkSecretEntropy,
  checkDirectoryPermissions,
  parseEnvKeys,
  checkEnvTemplateDrift,
  checkPortAvailable,
  REQUIRED_ENV_SPECS,
  DiagnosticCheck,
} from "./diagnostics-checks";

// ──────────────────────────────────────────────────────────────────────────────
// checkEnvVars
// ──────────────────────────────────────────────────────────────────────────────
describe("checkEnvVars", () => {
  const validEnv: Record<string, string> = {
    DATABASE_URL: "postgresql://user:pass@localhost:5432/trellis",
    JWT_SECRET: "a-very-long-and-random-jwt-secret-that-is-enough-long",
    REDIS_URL: "redis://localhost:6379",
  };

  it("returns pass for all required vars when set with real values", () => {
    const checks = checkEnvVars(validEnv);
    for (const c of checks) {
      expect(c.status).toBe("pass");
    }
  });

  it("fails required vars that are missing", () => {
    const env: Record<string, string | undefined> = { ...validEnv };
    delete env.DATABASE_URL;
    const checks = checkEnvVars(env);
    const dbCheck = checks.find((c) => c.name === "env:DATABASE_URL");
    expect(dbCheck?.status).toBe("fail");
    expect(dbCheck?.remediation).toBeTruthy();
  });

  it("warns for optional vars that are missing", () => {
    const env: Record<string, string | undefined> = { ...validEnv };
    delete env.REDIS_URL;
    const checks = checkEnvVars(env);
    const redisCheck = checks.find((c) => c.name === "env:REDIS_URL");
    expect(redisCheck?.status).toBe("warn");
  });

  it("warns when a value looks like a placeholder", () => {
    const env = { ...validEnv, JWT_SECRET: "your_jwt_secret_here" };
    const checks = checkEnvVars(env);
    const jwtCheck = checks.find((c) => c.name === "env:JWT_SECRET");
    expect(jwtCheck?.status).toBe("warn");
    expect(jwtCheck?.detail).toMatch(/placeholder/i);
  });

  it("detects changeme placeholder", () => {
    const env = { ...validEnv, JWT_SECRET: "changeme_now" };
    const checks = checkEnvVars(env);
    const jwtCheck = checks.find((c) => c.name === "env:JWT_SECRET");
    expect(jwtCheck?.status).toBe("warn");
  });

  it("handles custom specs", () => {
    const checks = checkEnvVars(
      { CUSTOM_KEY: "value" },
      [{ key: "CUSTOM_KEY", required: true, hint: "custom", remediation: "set it" }],
    );
    expect(checks[0].status).toBe("pass");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkToolVersion
// ──────────────────────────────────────────────────────────────────────────────
describe("checkToolVersion", () => {
  it("passes when tool is found with no version constraint", () => {
    const result = checkToolVersion({
      name: "git",
      version: "2.44.0",
      required: true,
      remediation: "install git",
    });
    expect(result.status).toBe("pass");
  });

  it("passes when tool meets minimum major version", () => {
    const result = checkToolVersion({
      name: "node",
      version: "v20.5.1",
      minMajor: 18,
      required: true,
      remediation: "upgrade node",
    });
    expect(result.status).toBe("pass");
  });

  it("fails when tool is below minimum major version", () => {
    const result = checkToolVersion({
      name: "node",
      version: "v16.0.0",
      minMajor: 18,
      required: true,
      remediation: "upgrade node to 18+",
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/below minimum/);
    expect(result.remediation).toBe("upgrade node to 18+");
  });

  it("fails required tool when version is null", () => {
    const result = checkToolVersion({
      name: "psql",
      version: null,
      required: true,
      remediation: "install psql",
    });
    expect(result.status).toBe("fail");
  });

  it("warns optional tool when version is null", () => {
    const result = checkToolVersion({
      name: "docker",
      version: null,
      required: false,
      remediation: "install docker (optional)",
    });
    expect(result.status).toBe("warn");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkTcpConnectivity
// ──────────────────────────────────────────────────────────────────────────────
describe("checkTcpConnectivity", () => {
  it("returns pass when probe succeeds", async () => {
    const probe = jest.fn().mockResolvedValue(true);
    const result = await checkTcpConnectivity(
      "db:tcp",
      "localhost",
      5432,
      probe,
      "start postgres",
    );
    expect(result.status).toBe("pass");
    expect(probe).toHaveBeenCalledWith("localhost", 5432);
  });

  it("returns fail when probe fails", async () => {
    const probe = jest.fn().mockResolvedValue(false);
    const result = await checkTcpConnectivity(
      "db:tcp",
      "localhost",
      5432,
      probe,
      "start postgres",
    );
    expect(result.status).toBe("fail");
    expect(result.remediation).toBe("start postgres");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkHttpEndpoint
// ──────────────────────────────────────────────────────────────────────────────
describe("checkHttpEndpoint", () => {
  it("passes on a 200 response", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://horizon-testnet.stellar.org",
      probe,
      "check internet connection",
    );
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/HTTP 200/);
  });

  it("passes on a 404 (endpoint exists but not root)", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 404 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://example.com",
      probe,
      "fix url",
    );
    expect(result.status).toBe("pass");
  });

  it("warns when probe fails (not blocks)", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: false });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://unreachable.example.com",
      probe,
      "check your internet connection",
    );
    expect(result.status).toBe("warn");
    expect(result.remediation).toBeTruthy();
  });

  it("warns on 500 status", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 500 });
    const result = await checkHttpEndpoint(
      "stellar:horizon",
      "https://down.example.com",
      probe,
      "server error",
    );
    expect(result.status).toBe("warn");
  });
});

describe("checkBootstrapAdmin", () => {
  it("skips when no bootstrap target is configured", () => {
    expect(checkBootstrapAdmin(undefined, undefined, undefined).status).toBe(
      "skip",
    );
  });

  it("warns when the configured account has not been created", () => {
    const result = checkBootstrapAdmin("admin@example.com", undefined, undefined);
    expect(result.status).toBe("warn");
    expect(result.remediation).toMatch(/Create the account/);
    expect(result.detail).not.toContain("admin@example.com");
  });

  it("warns when the configured account still needs promotion", () => {
    expect(checkBootstrapAdmin(undefined, "GABC", "USER").status).toBe(
      "warn",
    );
  });

  it("passes when the configured account is already an admin", () => {
    expect(
      checkBootstrapAdmin("admin@example.com", undefined, "ADMIN").status,
    ).toBe("pass");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// buildReport
// ──────────────────────────────────────────────────────────────────────────────
describe("buildReport", () => {
  const checks: DiagnosticCheck[] = [
    { name: "a", status: "pass", detail: "ok" },
    { name: "b", status: "pass", detail: "ok" },
    { name: "c", status: "warn", detail: "warning", remediation: "fix it" },
    { name: "d", status: "fail", detail: "error", remediation: "required" },
    { name: "e", status: "skip", detail: "skipped" },
  ];

  it("counts all statuses correctly", () => {
    const report = buildReport(checks);
    expect(report.passed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.warned).toBe(1);
    expect(report.skipped).toBe(1);
  });

  it("sets ok=false when any check failed", () => {
    const report = buildReport(checks);
    expect(report.ok).toBe(false);
  });

  it("sets ok=true when there are only passes and warnings", () => {
    const report = buildReport(checks.filter((c) => c.status !== "fail"));
    expect(report.ok).toBe(true);
  });

  it("includes all checks in the report", () => {
    const report = buildReport(checks);
    expect(report.checks).toHaveLength(checks.length);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkTcpConnectivityWithRetry
// ──────────────────────────────────────────────────────────────────────────────
describe("checkTcpConnectivityWithRetry", () => {
  it("passes on first attempt when probe succeeds immediately", async () => {
    const probe = jest.fn().mockResolvedValue(true);
    const result = await checkTcpConnectivityWithRetry("tcp:db", "localhost", 5432, probe, "remediation");
    expect(result.status).toBe("pass");
    expect(result.attempts).toBe(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("succeeds on retry after initial failure", async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const onRetry = jest.fn();
    const result = await checkTcpConnectivityWithRetry(
      "tcp:db",
      "localhost",
      5432,
      probe,
      "remediation",
      { maxAttempts: 3, backoffMs: 10, onRetry },
    );

    expect(result.status).toBe("pass");
    expect(result.attempts).toBe(2);
    expect(result.detail).toMatch(/retry attempt 2/i);
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  it("fails when all retry attempts are exhausted", async () => {
    const probe = jest.fn().mockResolvedValue(false);
    const result = await checkTcpConnectivityWithRetry(
      "tcp:db",
      "localhost",
      5432,
      probe,
      "Start postgres container",
      { maxAttempts: 3, backoffMs: 10 },
    );

    expect(result.status).toBe("fail");
    expect(result.attempts).toBe(3);
    expect(result.detail).toMatch(/after 3 attempts/i);
    expect(result.remediation).toBe("Start postgres container");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkHttpEndpointWithRetry
// ──────────────────────────────────────────────────────────────────────────────
describe("checkHttpEndpointWithRetry", () => {
  it("passes on first attempt on HTTP 200", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkHttpEndpointWithRetry("http:horizon", "https://horizon.stellar.org", probe, "remediation");
    expect(result.status).toBe("pass");
    expect(result.attempts).toBe(1);
  });

  it("retries on temporary error and passes when endpoint recovers", async () => {
    const probe = jest
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await checkHttpEndpointWithRetry(
      "http:horizon",
      "https://horizon.stellar.org",
      probe,
      "remediation",
      { maxAttempts: 2, backoffMs: 10 },
    );

    expect(result.status).toBe("pass");
    expect(result.attempts).toBe(2);
    expect(result.detail).toMatch(/retry attempt 2/i);
  });

  it("warns after exhausting retry attempts without blocking", async () => {
    const probe = jest.fn().mockResolvedValue({ ok: false });
    const result = await checkHttpEndpointWithRetry(
      "http:horizon",
      "https://horizon.stellar.org",
      probe,
      "Check connection",
      { maxAttempts: 3, backoffMs: 10 },
    );

    expect(result.status).toBe("warn");
    expect(result.attempts).toBe(3);
    expect(result.detail).toMatch(/unreachable.*3 attempts/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkDatabaseAuth
// ──────────────────────────────────────────────────────────────────────────────
describe("checkDatabaseAuth", () => {
  it("passes when credentials and connection succeed", () => {
    const result = checkDatabaseAuth({ connected: true, authenticated: true });
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/credentials and authentication handshake succeeded/i);
  });

  it("fails with auth remediation when password or user is rejected", () => {
    const result = checkDatabaseAuth({
      connected: false,
      authenticated: false,
      errorCategory: "auth_failed",
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/authentication failed/i);
    expect(result.remediation).toMatch(/verify username and password in DATABASE_URL/i);
  });

  it("fails with db creation remediation when database does not exist", () => {
    const result = checkDatabaseAuth({
      connected: true,
      authenticated: true,
      errorCategory: "db_missing",
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/target database does not exist/i);
    expect(result.remediation).toMatch(/createdb.*trellis_dev/i);
  });

  it("fails with general connection remediation for generic connection issues", () => {
    const result = checkDatabaseAuth({
      connected: false,
      authenticated: false,
      errorMessage: "ECONNREFUSED",
    });
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/ECONNREFUSED/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkSecretEntropy
// ──────────────────────────────────────────────────────────────────────────────
describe("checkSecretEntropy", () => {
  it("passes for high-entropy secret with at least 32 characters", () => {
    const secret = "4b8e2f019c4d8721fa039b561849a0ce6d5e1284a73f8d91c2b5e709a341f28b";
    const result = checkSecretEntropy("JWT_SECRET", secret);
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/meets cryptographic length and entropy standards/i);
  });

  it("fails when secret is empty or unset", () => {
    const result = checkSecretEntropy("JWT_SECRET", undefined);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/not set/i);
  });

  it("fails when secret is shorter than minLength", () => {
    const result = checkSecretEntropy("JWT_SECRET", "short_secret_123");
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/below recommended 32 characters/i);
  });

  it("warns when secret contains predictable dictionary words", () => {
    const weak = "my_development_supersecret_password_for_jwt_auth_123456";
    const result = checkSecretEntropy("JWT_SECRET", weak);
    expect(result.status).toBe("warn");
    expect(result.detail).toMatch(/predictable dictionary words/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// checkDirectoryPermissions
// ──────────────────────────────────────────────────────────────────────────────
describe("checkDirectoryPermissions", () => {
  it("passes when directory write test succeeds", () => {
    const testWrite = jest.fn().mockReturnValue(true);
    const result = checkDirectoryPermissions("dir:scratch", "/var/trellis/scratch", testWrite);
    expect(result.status).toBe("pass");
    expect(result.detail).toMatch(/read\/write access/i);
  });

  it("fails when directory is not writable or access is denied", () => {
    const testWrite = jest.fn().mockReturnValue(false);
    const result = checkDirectoryPermissions("dir:scratch", "/var/trellis/scratch", testWrite);
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/not writable or access is denied/i);
    expect(result.remediation).toMatch(/chmod/i);
  });
});


// ──────────────────────────────────────────────────────────────────────────────
// Local setup failures (issue #370)
// ──────────────────────────────────────────────────────────────────────────────
describe("parseEnvKeys", () => {
  it("reads variable names only, ignoring comments, blanks, and values", () => {
    const keys = parseEnvKeys("# comment\n\nFOO=bar\nexport BAZ = 1\r\nNOT A KEY\n#X=1\n");
    expect([...keys].sort()).toEqual(["BAZ", "FOO"]);
  });
});

describe("checkEnvTemplateDrift", () => {
  it("passes when .env defines every template variable", () => {
    const result = checkEnvTemplateDrift("A=1\nB=2\n", "B=x\nA=y\nEXTRA=z\n");
    expect(result.status).toBe("pass");
  });

  it("warns with variable names, never values, when variables are missing", () => {
    const result = checkEnvTemplateDrift("A=1\nB=2\nC=3\n", "A=super-secret\n");
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("B, C");
    expect(result.detail).not.toContain("super-secret");
    expect(result.remediation).toMatch(/\.env\.example/);
  });

  it("skips when either file is absent", () => {
    expect(checkEnvTemplateDrift(null, "A=1").status).toBe("skip");
    expect(checkEnvTemplateDrift("A=1", null).status).toBe("skip");
  });
});

describe("checkPortAvailable", () => {
  it("passes when the port is free", async () => {
    const result = await checkPortAvailable("env:PORT", 3001, async () => true);
    expect(result.status).toBe("pass");
  });

  it("fails with remediation when the port is in use", async () => {
    const result = await checkPortAvailable("env:PORT", 3001, async () => false);
    expect(result.status).toBe("fail");
    expect(result.remediation).toMatch(/lsof -i :3001/);
  });

  it("fails on an invalid port without probing", async () => {
    const probe = jest.fn();
    for (const port of [NaN, 0, 70000, 3000.5]) {
      const result = await checkPortAvailable("env:PORT", port, probe);
      expect(result.status).toBe("fail");
    }
    expect(probe).not.toHaveBeenCalled();
  });

  it("warns instead of failing when the probe itself errors", async () => {
    const result = await checkPortAvailable("env:PORT", 3001, async () => {
      throw new Error("EACCES");
    });
    expect(result.status).toBe("warn");
  });
});

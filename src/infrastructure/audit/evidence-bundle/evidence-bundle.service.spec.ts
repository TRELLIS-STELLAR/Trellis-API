import { EvidenceBundleService } from "./evidence-bundle.service";
import { PrivacyPreserverService } from "./privacy-preserver.service";
import { EvidenceCollectors } from "./collectors/evidence-collectors";
import { ExportSigningService } from "../algorithms/export-signing.service";

describe("EvidenceBundleService", () => {
  let service: EvidenceBundleService;
  let preserver: PrivacyPreserverService;
  let collectors: EvidenceCollectors;
  let signingService: ExportSigningService;

  beforeEach(() => {
    process.env.AUDIT_EXPORT_SIGNING_KEY = "test-export-signing-key-hex-safe";
    preserver = new PrivacyPreserverService();
    collectors = new EvidenceCollectors(preserver);
    signingService = new ExportSigningService();

    jest.spyOn(collectors, "collectAuthEvidence").mockResolvedValue([
      {
        id: "auth-1",
        actorHash: "actor_1234567890abcdef",
        action: "LOGIN",
        occurredAt: "2026-10-10T12:00:00.000Z",
        status: "succeeded",
        ipMasked: "192.168.xxx.xxx",
      },
    ]);

    jest.spyOn(collectors, "collectPortfolioEvidence").mockResolvedValue([
      {
        id: "port-1",
        portfolioId: "port-101",
        assetCode: "XLM",
        amount: "150.0000000",
        status: "confirmed",
        occurredAt: "2026-10-10T12:05:00.000Z",
      },
    ]);

    jest.spyOn(collectors, "collectDefiEvidence").mockResolvedValue([
      {
        id: "defi-1",
        protocol: "soroban-dex",
        chain: "stellar",
        transactionType: "swap",
        amount: "50.0000000",
        status: "confirmed",
        occurredAt: "2026-10-10T12:10:00.000Z",
      },
    ]);

    jest.spyOn(collectors, "collectNotificationEvidence").mockResolvedValue([]);
    jest.spyOn(collectors, "collectObservabilityEvidence").mockResolvedValue([]);
    jest.spyOn(collectors, "collectAuditTrailEvidence").mockResolvedValue({
      records: [
        {
          id: "audit-1",
          sequence: "1",
          action: "PORTFOLIO_STATE_TRANSITION",
          occurredAt: "2026-10-10T12:15:00.000Z",
          eventHash: "hash-001",
          previousHash: null,
          redactedPaths: [],
        },
      ],
      chainVerified: true,
      brokenAt: null,
    });

    service = new EvidenceBundleService(
      preserver,
      collectors,
      signingService,
      undefined,
      undefined,
    );
  });

  describe("generateBundle", () => {
    it("generates an evidence bundle with valid manifest, evidence, and HMAC signature", async () => {
      const bundle = await service.generateBundle(
        {
          caseId: "CASE-2026-001",
          subjectUserId: "usr-42",
        },
        {
          actorId: "compliance-officer-1",
          actorRole: "compliance_officer",
        },
      );

      expect(bundle.manifest.caseId).toBe("CASE-2026-001");
      expect(bundle.manifest.schemaVersion).toBe("trellis.audit.evidence-bundle.v1");
      expect(bundle.manifest.totalRecords).toBe(4);
      expect(bundle.evidence.authEvidence).toHaveLength(1);
      expect(bundle.evidence.portfolioEvidence).toHaveLength(1);
      expect(bundle.evidence.defiEvidence).toHaveLength(1);
      expect(bundle.integrity.bundleHash).toBeDefined();
      expect(bundle.integrity.signature).toBeDefined();
      expect(bundle.integrity.signingAlgorithm).toBe("HMAC-SHA256");
    });

    it("throws BadRequestException if caseId is missing", async () => {
      await expect(
        service.generateBundle(
          { caseId: "" },
          { actorId: "operator" },
        ),
      ).rejects.toThrow("caseId is mandatory");
    });
  });

  describe("verifyBundle", () => {
    it("validates an authentic bundle successfully", async () => {
      const bundle = await service.generateBundle(
        {
          caseId: "CASE-2026-002",
          subjectUserId: "usr-99",
        },
        { actorId: "compliance-1" },
      );

      const verification = await service.verifyBundle(bundle);
      expect(verification.valid).toBe(true);
      expect(verification.signatureValid).toBe(true);
      expect(verification.hashChainValid).toBe(true);
      expect(verification.temporalMonotonicityValid).toBe(true);
      expect(verification.errors).toHaveLength(0);
    });

    it("detects tampered payload content", async () => {
      const bundle = await service.generateBundle(
        {
          caseId: "CASE-2026-003",
        },
        { actorId: "compliance-1" },
      );

      // Mutate amount in portfolio evidence
      bundle.evidence.portfolioEvidence[0].amount = "99999999.0000000";

      const verification = await service.verifyBundle(bundle);
      expect(verification.valid).toBe(false);
      expect(verification.signatureValid).toBe(false);
      expect(verification.errors[0]).toContain("Bundle hash mismatch");
    });
  });
});

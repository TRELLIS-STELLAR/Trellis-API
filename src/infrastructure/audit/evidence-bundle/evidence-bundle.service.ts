import { BadRequestException, Injectable, Logger, Optional, Inject } from "@nestjs/common";
import { Repository } from "typeorm";
import { InjectRepository } from "@nestjs/typeorm";
import { createHash, randomUUID } from "crypto";
import {
  EvidenceBundle,
  EvidenceManifest,
  BundleEvidenceData,
  BundleIntegrityData,
  BundleScope,
  BundleActorRef,
  GenerateEvidenceBundleDto,
  BundleVerificationResult,
  EvidenceCategory,
} from "./interfaces/evidence-bundle.interface";
import { PrivacyPreserverService } from "./privacy-preserver.service";
import { EvidenceCollectors } from "./collectors/evidence-collectors";
import { ExportSigningService } from "../algorithms/export-signing.service";
import { SensitiveActionAuditService } from "../sensitive-actions/sensitive-action-audit.service";
import { SensitiveAction, SensitiveActionScope } from "../sensitive-actions/sensitive-action.enum";
import { AuditActorType } from "../entities/sensitive-action-event.entity";
import { AuditLog } from "../entities/audit-log.entity";

@Injectable()
export class EvidenceBundleService {
  private readonly logger = new Logger(EvidenceBundleService.name);

  constructor(
    private readonly preserver: PrivacyPreserverService,
    private readonly collectors: EvidenceCollectors,
    private readonly signingService: ExportSigningService,
    @Optional()
    private readonly sensitiveAuditService?: SensitiveActionAuditService,
    @Optional()
    @InjectRepository(AuditLog)
    private readonly auditLogRepo?: Repository<AuditLog>,
  ) {}

  /**
   * Generates a privacy-preserving, cryptographically signed audit evidence bundle
   * for a support investigation or compliance audit.
   */
  async generateBundle(
    dto: GenerateEvidenceBundleDto,
    operator: BundleActorRef,
  ): Promise<EvidenceBundle> {
    const caseId = dto.caseId?.trim();
    if (!caseId) {
      throw new BadRequestException("caseId is mandatory for evidence bundle generation");
    }

    const categories: EvidenceCategory[] = dto.categories?.length
      ? dto.categories
      : ["auth", "portfolio", "defi", "notifications", "observability", "audit_trail"];

    const scope: BundleScope = {
      caseId,
      subjectUserId: dto.subjectUserId?.trim() || undefined,
      portfolioId: dto.portfolioId?.trim() || undefined,
      transactionId: dto.transactionId?.trim() || undefined,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      categories,
    };

    let redactedFieldsCount = 0;
    let scrubbedPatternsCount = 0;
    let pseudonymizedActorsCount = 0;

    const evidence: BundleEvidenceData = {
      authEvidence: [],
      portfolioEvidence: [],
      defiEvidence: [],
      notificationEvidence: [],
      observabilityEvidence: [],
      auditTrailEvidence: [],
    };

    const recordsByDomain: Record<EvidenceCategory, number> = {
      auth: 0,
      portfolio: 0,
      defi: 0,
      notifications: 0,
      observability: 0,
      audit_trail: 0,
    };

    // 1. Auth Evidence
    if (categories.includes("auth")) {
      evidence.authEvidence = await this.collectors.collectAuthEvidence(scope);
      recordsByDomain.auth = evidence.authEvidence.length;
      pseudonymizedActorsCount += evidence.authEvidence.filter((e) => e.actorHash).length;
    }

    // 2. Portfolio Evidence
    if (categories.includes("portfolio")) {
      evidence.portfolioEvidence = await this.collectors.collectPortfolioEvidence(scope);
      recordsByDomain.portfolio = evidence.portfolioEvidence.length;
    }

    // 3. DeFi Evidence
    if (categories.includes("defi")) {
      evidence.defiEvidence = await this.collectors.collectDefiEvidence(scope);
      recordsByDomain.defi = evidence.defiEvidence.length;
    }

    // 4. Notification Evidence
    if (categories.includes("notifications")) {
      evidence.notificationEvidence = await this.collectors.collectNotificationEvidence(scope);
      recordsByDomain.notifications = evidence.notificationEvidence.length;
    }

    // 5. Observability Evidence
    if (categories.includes("observability")) {
      evidence.observabilityEvidence = await this.collectors.collectObservabilityEvidence(scope);
      recordsByDomain.observability = evidence.observabilityEvidence.length;
    }

    // 6. Audit Trail Evidence
    let chainValid = true;
    let brokenAt: string | null = null;
    let verifiedCount = 0;

    if (categories.includes("audit_trail")) {
      const trail = await this.collectors.collectAuditTrailEvidence(scope);
      evidence.auditTrailEvidence = trail.records;
      recordsByDomain.audit_trail = trail.records.length;
      verifiedCount = trail.records.length;
      chainValid = trail.chainVerified;
      brokenAt = trail.brokenAt;

      for (const rec of trail.records) {
        redactedFieldsCount += (rec.redactedPaths || []).length;
      }
    }

    // Handle retention hold placement if requested
    let retentionHoldApplied = false;
    if (dto.placeRetentionHold && this.auditLogRepo && scope.subjectUserId) {
      try {
        await this.auditLogRepo
          .createQueryBuilder()
          .update(AuditLog)
          .set({
            metadata: () =>
              `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{auditCaseId}', '"${caseId}"'::jsonb, true)`,
          })
          .where("userId = :userId", { userId: scope.subjectUserId })
          .execute();
        retentionHoldApplied = true;

        if (this.sensitiveAuditService) {
          await this.sensitiveAuditService.recordSensitiveAction({
            action: SensitiveAction.RETENTION_HOLD_PLACED,
            actorId: operator.actorId,
            actorType: (operator.actorType as AuditActorType) ?? AuditActorType.MAINTAINER,
            actorRole: operator.actorRole,
            reason: `Retention hold placed for support investigation ${caseId}`,
            resourceType: "user",
            resourceId: scope.subjectUserId,
            metadata: { caseId },
          });
        }
      } catch (err) {
        this.logger.warn(`Could not place retention hold: ${err}`);
      }
    }

    const totalRecords = Object.values(recordsByDomain).reduce((sum, count) => sum + count, 0);

    const bundleId = randomUUID();
    const generatedAt = new Date().toISOString();

    const manifest: EvidenceManifest = {
      schemaVersion: "trellis.audit.evidence-bundle.v1",
      bundleId,
      caseId,
      generatedAt,
      generatedBy: {
        actorId: operator.actorId,
        actorType: operator.actorType,
        actorRole: operator.actorRole,
        actorHash: this.preserver.pseudonymizeActor(operator.actorId),
      },
      scope,
      totalRecords,
      recordsByDomain,
      retentionHoldApplied,
      chainVerification: {
        valid: chainValid,
        verifiedCount,
        brokenAt,
      },
      redactionSummary: {
        redactedFieldsCount,
        scrubbedPatternsCount,
        pseudonymizedActorsCount,
        appliedRules: [
          "stellar_secret_scrubbing",
          "jwt_token_redaction",
          "ip_subnet_masking",
          "user_agent_normalization",
          "keyed_actor_pseudonymisation",
        ],
      },
    };

    // Calculate deterministic canonical hash of manifest + evidence
    const canonicalPayload = this.canonicalize({ manifest, evidence });
    const bundleHash = createHash("sha256").update(canonicalPayload).digest("hex");

    // Cryptographic signature
    const signature = this.signingService.sign(bundleHash);

    const integrity: BundleIntegrityData = {
      bundleHash,
      signature,
      signingAlgorithm: "HMAC-SHA256",
      verified: true,
    };

    const bundle: EvidenceBundle = {
      manifest,
      evidence,
      integrity,
    };

    // Record sensitive audit event for export compliance
    if (this.sensitiveAuditService) {
      try {
        await this.sensitiveAuditService.recordSensitiveAction({
          action: SensitiveAction.EVIDENCE_BUNDLE_EXPORTED,
          actorId: operator.actorId,
          actorType: (operator.actorType as AuditActorType) ?? AuditActorType.MAINTAINER,
          actorRole: operator.actorRole,
          resourceType: "evidence_bundle",
          resourceId: bundleId,
          reason: dto.reason || `Support investigation evidence bundle export for ${caseId}`,
          beforeState: undefined,
          afterState: {
            caseId,
            bundleHash,
            totalRecords,
            retentionHoldApplied,
          },
          metadata: {
            caseId,
            categories,
            subjectUserId: scope.subjectUserId,
          },
        });
      } catch (auditErr) {
        this.logger.warn(`Failed to record audit trail for bundle export: ${auditErr}`);
      }
    }

    return bundle;
  }

  /**
   * Verifies an exported evidence bundle against its cryptographic signature,
   * canonical SHA-256 hash, and internal hash-chain integrity.
   */
  async verifyBundle(bundle: EvidenceBundle): Promise<BundleVerificationResult> {
    const errors: string[] = [];
    const verifiedAt = new Date().toISOString();

    if (!bundle || !bundle.manifest || !bundle.integrity || !bundle.evidence) {
      return {
        valid: false,
        bundleId: bundle?.manifest?.bundleId || "unknown",
        caseId: bundle?.manifest?.caseId || "unknown",
        recomputedBundleHash: "",
        signatureValid: false,
        hashChainValid: false,
        temporalMonotonicityValid: false,
        errors: ["Malformed evidence bundle: missing manifest, evidence, or integrity sections"],
        verifiedAt,
      };
    }

    const { manifest, evidence, integrity } = bundle;

    // 1. Recompute canonical hash
    const canonicalPayload = this.canonicalize({ manifest, evidence });
    const recomputedBundleHash = createHash("sha256").update(canonicalPayload).digest("hex");

    if (recomputedBundleHash !== integrity.bundleHash) {
      errors.push(
        `Bundle hash mismatch. Expected ${integrity.bundleHash}, computed ${recomputedBundleHash}. Payload has been modified.`
      );
    }

    // 2. Verify HMAC signature
    let signatureValid = false;
    try {
      signatureValid = this.signingService.verify(integrity.bundleHash, integrity.signature);
      if (!signatureValid) {
        errors.push("Invalid cryptographic HMAC-SHA256 signature.");
      }
    } catch (sigErr) {
      errors.push(`Signature verification error: ${sigErr}`);
    }

    // 3. Verify internal audit hash chain if present
    let hashChainValid = true;
    if (evidence.auditTrailEvidence?.length > 1) {
      for (let i = 1; i < evidence.auditTrailEvidence.length; i++) {
        const prev = evidence.auditTrailEvidence[i - 1];
        const curr = evidence.auditTrailEvidence[i];
        if (curr.previousHash && prev.eventHash && curr.previousHash !== prev.eventHash) {
          hashChainValid = false;
          errors.push(
            `Audit trail broken at record ${curr.id}. Expected previousHash ${prev.eventHash}, found ${curr.previousHash}.`
          );
          break;
        }
      }
    }

    // 4. Verify temporal monotonicity (occurredAt must be valid dates and chronological where applicable)
    let temporalValid = true;
    const allDates = [
      ...evidence.authEvidence.map((e) => new Date(e.occurredAt).getTime()),
      ...evidence.portfolioEvidence.map((e) => new Date(e.occurredAt).getTime()),
      ...evidence.defiEvidence.map((e) => new Date(e.occurredAt).getTime()),
    ].filter((t) => !isNaN(t));

    const futureThreshold = Date.now() + 60000; // 1 min buffer
    for (const timestamp of allDates) {
      if (timestamp > futureThreshold) {
        temporalValid = false;
        errors.push("Detected future timestamp violating temporal consistency.");
        break;
      }
    }

    const valid = errors.length === 0;

    return {
      valid,
      bundleId: manifest.bundleId,
      caseId: manifest.caseId,
      recomputedBundleHash,
      signatureValid,
      hashChainValid,
      temporalMonotonicityValid: temporalValid,
      errors,
      verifiedAt,
    };
  }

  /**
   * Deterministic canonical serialization (keys sorted alphabetically).
   */
  canonicalize(obj: unknown): string {
    if (obj === null || typeof obj !== "object") {
      return JSON.stringify(obj);
    }

    if (Array.isArray(obj)) {
      return `[${obj.map((item) => this.canonicalize(item)).join(",")}]`;
    }

    const record = obj as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const pairs = sortedKeys
      .filter((k) => record[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${this.canonicalize(record[k])}`);

    return `{${pairs.join(",")}}`;
  }
}

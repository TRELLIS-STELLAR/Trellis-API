/**
 * Privacy-Preserving Audit Evidence Bundle Types & Schema
 *
 * Defines the canonical data structures for exportable evidence bundles
 * used during support investigations, disputes, and compliance reviews.
 */

export interface BundleActorRef {
  actorId: string;
  actorType?: string;
  actorRole?: string;
  actorHash?: string;
}

export interface BundleScope {
  caseId: string;
  subjectUserId?: string;
  portfolioId?: string;
  transactionId?: string;
  fromDate?: string;
  toDate?: string;
  categories: EvidenceCategory[];
}

export type EvidenceCategory =
  | "auth"
  | "portfolio"
  | "defi"
  | "notifications"
  | "observability"
  | "audit_trail";

export interface RedactionSummary {
  redactedFieldsCount: number;
  scrubbedPatternsCount: number;
  pseudonymizedActorsCount: number;
  appliedRules: string[];
}

export interface ChainVerificationSummary {
  valid: boolean;
  verifiedCount: number;
  brokenAt: string | null;
  reason?: string | null;
}

export interface EvidenceManifest {
  schemaVersion: "trellis.audit.evidence-bundle.v1";
  bundleId: string;
  caseId: string;
  generatedAt: string;
  generatedBy: BundleActorRef;
  scope: BundleScope;
  totalRecords: number;
  recordsByDomain: Record<EvidenceCategory, number>;
  retentionHoldApplied: boolean;
  chainVerification: ChainVerificationSummary;
  redactionSummary: RedactionSummary;
}

export interface AuthEvidenceRecord {
  id: string;
  actorHash: string;
  action: string;
  occurredAt: string;
  status: "succeeded" | "failed" | string;
  ipMasked?: string;
  ipHash?: string;
  clientType?: string;
  detailsMasked?: string;
  metadata?: Record<string, unknown>;
}

export interface PortfolioEvidenceRecord {
  id: string;
  portfolioId: string;
  assetCode: string;
  transactionType?: string;
  amount: string;
  balanceAfter?: string;
  status: string;
  occurredAt: string;
  externalRefHash?: string;
  txHash?: string;
}

export interface DefiEvidenceRecord {
  id: string;
  positionId?: string;
  protocol: string;
  chain: string;
  transactionType: string;
  amount: string;
  status: string;
  txHash?: string;
  occurredAt: string;
  riskScore?: number;
  gasUsed?: number;
}

export interface NotificationEvidenceRecord {
  id: string;
  channel: string;
  category: string;
  priority: string;
  status: string;
  deduplicationKey?: string;
  deepLink?: string;
  deliveredAt?: string;
  createdAt: string;
}

export interface ObservabilityEvidenceRecord {
  requestId: string;
  correlationId: string;
  route: string;
  method: string;
  statusCode: number;
  statusCategory: string;
  errorCategory?: string;
  latencyMs: number;
  timestamp: string;
}

export interface AuditTrailEvidenceRecord {
  id: string;
  sequence?: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  eventHash?: string;
  previousHash?: string | null;
  occurredAt: string;
  redactedPaths: string[];
}

export interface BundleEvidenceData {
  authEvidence: AuthEvidenceRecord[];
  portfolioEvidence: PortfolioEvidenceRecord[];
  defiEvidence: DefiEvidenceRecord[];
  notificationEvidence: NotificationEvidenceRecord[];
  observabilityEvidence: ObservabilityEvidenceRecord[];
  auditTrailEvidence: AuditTrailEvidenceRecord[];
}

export interface BundleIntegrityData {
  bundleHash: string;
  signature: string;
  signingAlgorithm: "HMAC-SHA256";
  verified: boolean;
}

export interface EvidenceBundle {
  manifest: EvidenceManifest;
  evidence: BundleEvidenceData;
  integrity: BundleIntegrityData;
}

export interface GenerateEvidenceBundleDto {
  caseId: string;
  subjectUserId?: string;
  portfolioId?: string;
  transactionId?: string;
  fromDate?: string;
  toDate?: string;
  categories?: EvidenceCategory[];
  placeRetentionHold?: boolean;
  reason?: string;
}

export interface VerifyEvidenceBundleDto {
  bundle: EvidenceBundle;
}

export interface BundleVerificationResult {
  valid: boolean;
  bundleId: string;
  caseId: string;
  recomputedBundleHash: string;
  signatureValid: boolean;
  hashChainValid: boolean;
  temporalMonotonicityValid: boolean;
  errors: string[];
  verifiedAt: string;
}

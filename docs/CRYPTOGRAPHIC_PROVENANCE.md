# Cryptographic Provenance for Imported Records

## Overview

The cryptographic provenance system provides comprehensive tracking and verification of all imported records through cryptographic signatures, immutable chain of custody, and authorization controls. Built on the evidence verification framework, it ensures data integrity, authenticity, and auditability for imported records.

## Purpose

Provide cryptographically verifiable provenance for:
- External data imports with Ed25519 signatures
- Internal record creation and modifications
- System migrations and batch imports
- Chain of custody tracking
- Authorization auditing
- Compliance and forensic investigation

## Architecture

### Core Components

#### 1. Provenance Record

```typescript
interface ProvenanceRecord {
  id: string;                          // Unique provenance identifier
  recordId: string;                    // ID of the imported record
  recordType: string;                  // Record classification
  contentDigest: string;               // SHA-256 digest of content
  evidence?: ExternalEvidence;         // Optional external evidence
  importedBy: {                        // Import actor information
    actorId: string;
    roles: Role[];
    timestamp: string;
  };
  source: {                            // Source information
    issuer: string;
    keyId?: string;
    verified: boolean;
    verificationTimestamp?: string;
  };
  chain: ProvenanceChainEntry[];       // Complete history
  metadata: {                          // Additional metadata
    importMethod: "external" | "internal" | "migration" | "system";
    version: string;
    tags?: string[];
  };
}
```

#### 2. Chain Entry

```typescript
interface ProvenanceChainEntry {
  sequence: number;                    // Position in chain
  action: "imported" | "verified" | "modified" | "archived" | "restored";
  actor: string;                       // Actor who performed action
  timestamp: string;                   // ISO-8601 timestamp
  contentDigest: string;               // Content hash at this point
  signature?: string;                  // Optional entry signature
  metadata?: Record<string, unknown>;  // Additional data
}
```

### Cryptographic Guarantees

#### Content Integrity

```
contentDigest = SHA-256(canonicalJson(content))
```

- Deterministic serialization ensures consistent hashing
- Any content modification produces a different digest
- Digests stored in each chain entry for point-in-time verification

#### Chain Integrity

```
chainSignature = SHA-256(canonicalJson({
  sequence,
  action,
  actor,
  timestamp,
  contentDigest
}))
```

- Each entry can be independently signed
- Sequential integrity verified via sequence numbers
- Temporal integrity verified via monotonic timestamps

#### Evidence Verification

Uses the existing evidence verifier:
- Ed25519 signature verification
- Payload digest binding
- Issuer and key trust validation
- Temporal validity windows
- Revocation support

## Test Coverage

### 1. Normal Path: Record Import

**Scenarios:**
- ✅ Import without external evidence
- ✅ Import with verified external evidence
- ✅ Safe retry of identical import
- ✅ Chain entry addition for modifications
- ✅ Complete chain of custody tracking

**Example:**
```typescript
const provenance = service.importRecord(
  adminActor,
  "record-1",
  "transaction",
  { amount: 100, currency: "USD" }
);

expect(provenance.recordId).toBe("record-1");
expect(provenance.source.verified).toBe(false);
expect(provenance.chain).toHaveLength(1);
```

### 2. Failure Path: Validation and Rejection

**Scenarios:**
- ✅ Duplicate record ID with different content
- ✅ Non-existent record for chain entry
- ✅ Evidence verification failures
- ✅ Tampered payload digests
- ✅ Chain integrity violations
- ✅ Missing record verification

**Example:**
```typescript
service.importRecord(adminActor, "record-1", "type", content1);

expect(() => {
  service.importRecord(adminActor, "record-1", "type", content2);
}).toThrow(ConflictException);
```

### 3. Retry Path: Conflict Resolution

**Scenarios:**
- ✅ Duplicate evidence IDs in strict mode
- ✅ Safe retries with same content
- ✅ Multiple sequential modifications
- ✅ Chain consistency after retries

**Example:**
```typescript
const first = service.importRecord(actor, "rec", "type", content);
const second = service.importRecord(actor, "rec", "type", content);

expect(second.id).toBe(first.id); // Safe retry
```

### 4. Authorization Path: Permission Enforcement

**Scenarios:**
- ✅ Unauthorized import blocking
- ✅ Unauthorized modification blocking
- ✅ Operator import permissions
- ✅ Role tracking in provenance

**Example:**
```typescript
expect(() => {
  service.importRecord(unauthorizedActor, "rec", "type", content);
}).toThrow(ForbiddenException);
```

### 5. Querying and Statistics

**Scenarios:**
- ✅ Query by record type
- ✅ Query by issuer
- ✅ Query by import actor
- ✅ Query verified records only
- ✅ Comprehensive statistics
- ✅ Audit export
- ✅ Batch verification

### 6. Edge Cases

**Scenarios:**
- ✅ Empty content handling
- ✅ Large chain histories
- ✅ Chronological order maintenance
- ✅ Metadata tags
- ✅ Concurrent imports
- ✅ Detailed verification issues

## Usage Examples

### Import External Record with Evidence

```typescript
import { CryptographicProvenanceService } from './cryptographic-provenance';
import { generateKeyPairSync, sign } from 'crypto';

// Setup service with trusted keys
const service = new CryptographicProvenanceService([trustedKey], {
  autoSignChain: true,
  strictMode: true,
});

// Prepare content and evidence
const content = { amount: 100, currency: "USD" };
const payloadDigest = computePayloadDigest(content);

const evidence: ExternalEvidence = {
  id: "txn-001",
  type: "transaction",
  issuer: "payment-processor",
  keyId: "key-2024",
  issuedAt: new Date().toISOString(),
  payload: content,
  payloadDigest,
  signature: signEvidence(evidence, privateKey),
};

// Import with provenance
const provenance = service.importRecord(
  adminActor,
  "record-001",
  "transaction",
  content,
  evidence,
  { tags: ["urgent", "high-value"] }
);

console.log(`Imported: ${provenance.recordId}`);
console.log(`Verified: ${provenance.source.verified}`);
console.log(`Digest: ${provenance.contentDigest}`);
```

### Track Modifications

```typescript
// Initial import
service.importRecord(adminActor, "doc-001", "document", originalContent);

// Record modification
service.addChainEntry(
  adminActor,
  "doc-001",
  "modified",
  updatedContent,
  { reason: "price correction", approvedBy: "supervisor-123" }
);

// Get complete history
const history = service.getProvenanceHistory("doc-001");

history.forEach(entry => {
  console.log(`[${entry.sequence}] ${entry.action} by ${entry.actor}`);
  console.log(`  Timestamp: ${entry.timestamp}`);
  console.log(`  Digest: ${entry.contentDigest}`);
});
```

### Verify Provenance

```typescript
const verification = service.verifyProvenance("record-001");

if (verification.valid) {
  console.log("✓ Provenance is valid");
  console.log(`  Chain: ${verification.chainValid ? "valid" : "invalid"}`);
  console.log(`  Evidence: ${verification.evidenceValid ? "valid" : "invalid"}`);
} else {
  console.error("✗ Provenance verification failed");
  verification.issues.forEach(issue => {
    console.error(`  [${issue.severity}] ${issue.type}: ${issue.message}`);
  });
}
```

### Query Records

```typescript
// Find all verified transactions
const verifiedTxns = service.queryProvenance({
  recordType: "transaction",
  verified: true,
});

// Find records from specific issuer
const fromIssuer = service.queryProvenance({
  issuer: "payment-processor",
});

// Find records imported in date range
const recentImports = service.queryProvenance({
  fromDate: "2024-01-01T00:00:00Z",
  toDate: "2024-12-31T23:59:59Z",
  importedBy: "admin-001",
});

// Find tagged records
const urgentRecords = service.queryProvenance({
  tags: ["urgent", "review-required"],
});
```

### Generate Statistics

```typescript
const stats = service.getStatistics();

console.log(`Total Records: ${stats.totalRecords}`);
console.log(`Verified: ${stats.verifiedRecords}`);
console.log(`Unverified: ${stats.unverifiedRecords}`);

console.log("\nBy Source:");
Object.entries(stats.bySource).forEach(([source, count]) => {
  console.log(`  ${source}: ${count}`);
});

console.log("\nBy Type:");
Object.entries(stats.byType).forEach(([type, count]) => {
  console.log(`  ${type}: ${count}`);
});

if (stats.failedVerifications > 0) {
  console.warn(`⚠️  ${stats.failedVerifications} failed verifications`);
}

if (stats.chainIntegrityIssues > 0) {
  console.warn(`⚠️  ${stats.chainIntegrityIssues} chain integrity issues`);
}
```

### Batch Verification

```typescript
const recordIds = ["rec-1", "rec-2", "rec-3", "rec-4", "rec-5"];

const results = service.batchVerify(recordIds);

const valid = Array.from(results.values()).filter(r => r.valid).length;
const invalid = results.size - valid;

console.log(`Verified ${valid}/${results.size} records`);

// Report issues
results.forEach((verification, recordId) => {
  if (!verification.valid) {
    console.error(`✗ ${recordId}: ${verification.issues.map(i => i.message).join(", ")}`);
  }
});
```

### Export for Auditing

```typescript
// Export individual record
const exported = service.exportProvenance("record-001");

// Save to file
fs.writeFileSync(`audit-record-001.json`, exported);

// Parse and analyze
const provenance = JSON.parse(exported);

console.log("Audit Trail:");
provenance.chain.forEach(entry => {
  console.log(`${entry.timestamp}: ${entry.action} by ${entry.actor}`);
});
```

## Configuration Options

### Service Options

```typescript
interface ProvenanceOptions {
  autoSignChain?: boolean;         // Sign chain entries automatically
  signingKey?: string;             // Key for signing chain entries
  strictMode?: boolean;            // Enforce strict validation
  maxChainLength?: number;         // Max entries before archival
  autoArchive?: boolean;           // Enable automatic archival
}
```

**Example:**
```typescript
const service = new CryptographicProvenanceService(trustedKeys, {
  autoSignChain: true,              // Sign all chain entries
  strictMode: true,                 // Strict evidence validation
  maxChainLength: 1000,             // Archive after 1000 entries
  autoArchive: true,                // Automatic archival
});
```

## Integration Points

### With Evidence Verifier

```typescript
import { EvidenceVerifier } from '../../common/evidence/evidence-verifier';

// Evidence verification is automatic
const provenance = service.importRecord(
  actor,
  recordId,
  recordType,
  content,
  evidence  // Automatically verified
);
```

### With Authorization System

```typescript
import { Permission, Role, hasPermission } from '../../common/guard/roles.enum';

// Permission checks are automatic
const actor: EvidenceActor = {
  id: "user-123",
  roles: [Role.OPERATOR],
};

service.importRecord(actor, ...); // Checks IMPORT_EXECUTE permission
service.addChainEntry(actor, ...); // Checks modification permissions
```

## Verification Process

### Chain Integrity Verification

1. **Sequence Validation**: Verify sequence numbers are consecutive (0, 1, 2, ...)
2. **Signature Validation**: Verify each signed entry's signature
3. **Temporal Validation**: Verify timestamps are monotonically increasing
4. **Content Validation**: Verify content digests are properly computed

### Evidence Verification

1. **Well-formedness**: All required fields present and valid types
2. **Key Trust**: Key is trusted for this issuer and evidence type
3. **Temporal Validity**: Evidence issued within key validity window
4. **Not Revoked**: Evidence issued before key revocation
5. **Not Stale**: Evidence not older than max age (if configured)
6. **Digest Match**: Payload digest matches computed digest
7. **Signature Valid**: Ed25519 signature verification passes

## Security Considerations

### Threat Model

**Mitigated Threats:**
- ✅ Content tampering (detected via digest mismatch)
- ✅ Replay attacks (via strict mode duplicate detection)
- ✅ Unauthorized imports (via permission checks)
- ✅ Backdating (via timestamp validation)
- ✅ Chain manipulation (via signature verification)
- ✅ Issuer impersonation (via signature verification)

**Out of Scope:**
- ⚠️ Compromised signing keys (requires key rotation)
- ⚠️ Side-channel attacks on verification
- ⚠️ DoS via excessive imports (rate limiting needed)

### Key Management

**Best Practices:**
1. Store trusted keys securely (HSM, KMS)
2. Rotate keys regularly
3. Set appropriate validity windows
4. Monitor for compromise
5. Revoke compromised keys immediately
6. Keep old keys for historical verification

### Replay Protection

**In-Memory (Current):**
- Accepted IDs stored in process memory
- Resets on restart
- Not shared across replicas

**Durable (Recommended for Production):**
```typescript
// Persist (id, payloadDigest) in database
await db.provenanceRecords.create({
  id: provenance.id,
  recordId: provenance.recordId,
  contentDigest: provenance.contentDigest,
  // ... other fields
});

// Add unique constraint on recordId
```

## Performance Characteristics

### Time Complexity

- Import: O(1) for verification + O(1) for storage
- Query: O(n) where n = total records (can be optimized with indexes)
- Verification: O(m) where m = chain length
- Statistics: O(n) where n = total records

### Space Complexity

- Per Record: ~1-5 KB (without evidence)
- With Evidence: ~2-10 KB (includes signature)
- Per Chain Entry: ~200-500 bytes

### Optimization Strategies

1. **Indexing**: Index by type, issuer, actor for faster queries
2. **Archival**: Move old chain entries to cold storage
3. **Caching**: Cache verification results
4. **Batching**: Batch verify related records
5. **Async**: Process non-critical verifications asynchronously

## Monitoring and Observability

### Key Metrics

```typescript
// Collect metrics
const stats = service.getStatistics();

metrics.gauge("provenance.total_records", stats.totalRecords);
metrics.gauge("provenance.verified_records", stats.verifiedRecords);
metrics.gauge("provenance.failed_verifications", stats.failedVerifications);
metrics.gauge("provenance.chain_integrity_issues", stats.chainIntegrityIssues);
```

### Logging

```typescript
logger.info("Record imported with provenance", {
  recordId: provenance.recordId,
  recordType: provenance.recordType,
  verified: provenance.source.verified,
  issuer: provenance.source.issuer,
  actor: provenance.importedBy.actorId,
});

logger.warn("Chain integrity issue detected", {
  recordId,
  issues: verification.issues.map(i => i.message),
});
```

### Alerting

Set up alerts for:
- Failed verifications exceeding threshold
- Chain integrity issues
- Unauthorized access attempts
- Evidence from revoked keys
- Unusual import patterns

## Edge Cases and Recovery

### Key Rotation

```typescript
// Add new key
const newKey: TrustedEvidenceKey = {
  keyId: "key-2025",
  issuer: "payment-processor",
  publicKeyPem: newPublicKeyPem,
  allowedTypes: ["transaction"],
  notBefore: "2025-01-01T00:00:00Z",
  // No notAfter yet
};

// Keep old key with expiry
const oldKey: TrustedEvidenceKey = {
  keyId: "key-2024",
  // ... existing config
  notAfter: "2025-01-31T23:59:59Z", // Grace period
};

// Service accepts both keys
const service = new CryptographicProvenanceService([oldKey, newKey]);
```

### Key Compromise

```typescript
// Revoke compromised key
const compromisedKey: TrustedEvidenceKey = {
  keyId: "key-compromised",
  // ... existing config
  revokedAt: "2024-06-15T14:30:00Z", // Compromise time
};

// Evidence issued after this time is rejected
// Re-verify historical evidence manually
const suspicious = service.queryProvenance({
  issuer: "affected-issuer",
  fromDate: "2024-06-15T14:30:00Z",
});

suspicious.forEach(record => {
  const verification = service.verifyProvenance(record.recordId);
  if (!verification.valid) {
    handleCompromisedRecord(record);
  }
});
```

### Large Chain Archival

```typescript
// Automatic archival at max length
const service = new CryptographicProvenanceService(keys, {
  maxChainLength: 1000,
  autoArchive: true,
});

// Manual archival
function archiveOldRecords() {
  const old = service.queryProvenance({
    toDate: oneYearAgo,
  });

  old.forEach(record => {
    const exported = service.exportProvenance(record.recordId);
    saveToArchive(exported);
  });
}
```

## Compliance and Auditing

### Audit Trail Requirements

✅ **Who**: Actor ID and roles tracked
✅ **What**: Action and content digest recorded
✅ **When**: ISO-8601 timestamps
✅ **Why**: Optional metadata for context
✅ **How**: Import method and source tracked
✅ **Verification**: Cryptographic signatures

### Regulatory Compliance

**GDPR:**
- Export functionality for data subject access requests
- Provenance metadata for processing records
- Audit trail for demonstrating compliance

**SOC 2:**
- Cryptographic verification for data integrity
- Authorization tracking for access controls
- Immutable audit trail for compliance evidence

**HIPAA:**
- Chain of custody for protected health information
- Access logging via provenance records
- Verification of data authenticity

## Migration and Rollback

### Adding Provenance to Existing System

```typescript
// Phase 1: Add provenance (opt-in)
if (PROVENANCE_ENABLED) {
  service.importRecord(actor, id, type, content);
} else {
  // Existing import logic
}

// Phase 2: Backfill existing records
const existingRecords = await db.records.findAll();

for (const record of existingRecords) {
  service.importRecord(
    systemActor,
    record.id,
    record.type,
    record.content,
    undefined,
    { importMethod: "migration" }
  );
}
```

### Rollback Strategy

1. **Stop using provenance service** (no code changes to imports)
2. **Existing provenance records remain** (for audit purposes)
3. **No schema changes** (all in-memory or separate tables)
4. **Evidence verification still works** (independent module)

## References

- [Evidence Verification](./EVIDENCE_VERIFICATION.md) - Base cryptographic verification
- [Authorization System](./RBAC.md) - Role-based access control
- [Canonical Serialization](../src/common/serialization/canonical-json.ts) - Deterministic JSON

## Compliance Checklist

- ✅ Covers normal, failure, retry, and authorization paths
- ✅ Automated tests with executable verification
- ✅ Edge cases documented with recovery behavior
- ✅ No contract changes (opt-in feature)
- ✅ Focused vertical slice of cryptographic provenance

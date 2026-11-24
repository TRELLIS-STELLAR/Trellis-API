# Privacy Redaction Tests for Logs and Exports

## Overview

This document describes the comprehensive privacy redaction testing framework that ensures sensitive data is never exposed through logs, exports, or error responses. The framework covers all critical paths with automated verification and executable tests.

## Purpose

Privacy redaction is a critical security feature that:
- Prevents credential leaks in logs and error messages
- Protects user PII (Personally Identifiable Information) in exports
- Ensures compliance with data protection regulations (GDPR, CCPA)
- Maintains audit trails without exposing secrets

## Test Coverage

### 1. Normal Path Tests

Tests that verify redaction works correctly under normal operating conditions.

#### Log Redaction

**Test File:** `src/logging/privacy-redaction-comprehensive.spec.ts`

**Coverage:**
- JWT tokens in log messages
- API keys and secrets in structured logs
- Bearer and Basic auth tokens in headers
- Stellar secret seeds
- Private keys (PEM format and hex)
- Database connection strings with credentials
- URL-embedded passwords
- Inline `password=value` patterns

**Example:**
```typescript
const logEntry = {
  message: "Auth failed",
  token: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
  apiKey: "sk_live_123456"
};

const sanitized = sanitizeValue(logEntry);
// Result: { message: "Auth failed", token: "[REDACTED]", apiKey: "[REDACTED]" }
```

#### Export Redaction

**Test File:** `src/infrastructure/export/privacy-redaction-integration.spec.ts`

**Coverage:**
- Forbidden secrets (passwords, keys, tokens) completely stripped
- PII fields (email, phone, IP address) masked based on role
- Financial data (balance, fees) redacted for non-owners
- Nested objects and arrays handled correctly
- Public data (account IDs, transaction hashes) preserved

**Example:**
```typescript
const record = {
  id: "user_1",
  email: "alice@example.com",
  password: "secret123",
  balance: "1000.00"
};

const exported = authorizer.filterRecord(record, {
  role: "user",
  isOwner: false
});
// Result: { id: "user_1", email: "a***e@example.com", balance: "[CONFIDENTIAL]" }
// Note: password is completely removed
```

### 2. Failure Path Tests

Tests that verify redaction works when errors occur.

#### Error Message Redaction

**Coverage:**
- Secrets in exception messages
- Stack traces with sensitive data
- Database error messages with credentials
- HTTP error responses with leaked tokens
- Sentry/monitoring integration

**Example:**
```typescript
const error = new Error("DB connection failed: postgres://user:p@ss@host/db");
const sanitized = sanitizeErrorMessage(error.message);
// Result: "DB connection failed: postgres://[REDACTED]@host/db"
```

#### Export Failures

**Coverage:**
- Failed exports log redacted error reasons
- Retry attempts maintain redaction
- Partial export failures don't leak data
- Timeout/cancellation scenarios

**Example:**
```typescript
try {
  await exportService.process(id);
} catch (error) {
  // Error logged with redacted message
  // Stored failure reason does not contain secrets
}
```

### 3. Retry Path Tests

Tests that verify consistent redaction across multiple attempts.

#### Idempotency

**Coverage:**
- Multiple redaction passes produce identical results
- Original data remains unmodified
- Retried exports have consistent output
- Re-filtering already filtered data is safe

**Example:**
```typescript
const original = { password: "secret" };
const pass1 = sanitizeValue(original);
const pass2 = sanitizeValue(original);
const pass3 = sanitizeValue(pass1); // Re-filter already filtered

expect(pass2).toEqual(pass1);
expect(pass3).toEqual(pass1);
expect(original.password).toBe("secret"); // Unchanged
```

### 4. Authorization Path Tests

Tests that verify role-based redaction and access control.

#### Role-Based Filtering

**Roles and Permissions:**

| Role | Secrets | PII | Financial | Notes |
|------|---------|-----|-----------|-------|
| User (non-owner) | ❌ Stripped | 🔒 Masked | ❌ Confidential | Minimal access |
| User (owner, no consent) | ❌ Stripped | 🔒 Masked | ✅ Visible | Owns data but no PII consent |
| User (owner, with consent) | ❌ Stripped | ✅ Visible | ✅ Visible | Full access to own data |
| Auditor | ❌ Stripped | 🔒 Masked | ✅ Visible | Can audit financials |
| Compliance Officer | ❌ Stripped | ✅ Visible | ✅ Visible | PII for investigations |
| Admin | ❌ Stripped | ✅ Visible | ✅ Visible | Full access except secrets |

**Key Principle:** Secrets are NEVER exported for any role, including admins.

**Examples:**

```typescript
// Non-owner: Minimal access
authorizer.filterRecord(record, { role: "user", isOwner: false });
// PII masked, financials hidden

// Owner without consent: No PII
authorizer.filterRecord(record, { role: "user", isOwner: true, includePiiConsent: false });
// PII masked, financials visible

// Owner with consent: Full access (no secrets)
authorizer.filterRecord(record, { role: "user", isOwner: true, includePiiConsent: true });
// PII visible, financials visible, secrets stripped

// Compliance officer: Investigation access
authorizer.filterRecord(record, { role: "compliance_officer", isOwner: false });
// Full PII and financials, no secrets
```

#### PII Masking Patterns

| Field Type | Example Input | Masked Output | Notes |
|------------|---------------|---------------|-------|
| Email | alice@example.com | a***e@example.com | First and last char preserved |
| Phone | +15551234567 | ***-***-4567 | Last 4 digits visible |
| IP Address | 192.168.1.100 | 192.168.1.xxx | Last octet masked |
| Name | Alice Smith | A***h | First and last char preserved |
| Short values | Jo | ** | Generic mask for short strings |

### 5. Edge Cases and Boundary Conditions

#### String Length Limits

**Coverage:**
- Very long strings truncated safely
- Long error messages don't cause performance issues
- Truncation preserves redaction (no partial secrets)

**Constants:**
```typescript
MAX_STRING_LENGTH = 4096        // Per logged string
MAX_ERROR_MESSAGE_LENGTH = 8192 // Per error message
MAX_ARRAY_LENGTH = 50           // Array items kept
MAX_OBJECT_KEYS = 100           // Object keys kept
MAX_DEPTH = 8                   // Recursion limit
```

#### Special Characters

**Coverage:**
- Unicode characters in PII fields
- URL-encoded secrets
- Null and undefined values
- Circular references

**Examples:**
```typescript
// Unicode email
{ email: "user@例え.jp" } → { email: "u***r@例え.jp" }

// URL-encoded token
"/callback?token=eyJhbGci%3D%3D" → "/callback?token=[REDACTED]"

// Null handling
{ email: null, password: "secret" } → { email: null }
```

#### Field Naming Conventions

All variations are correctly classified:

```typescript
// Case variations
password, Password, PASSWORD → All classified as FORBIDDEN_SECRET

// Snake case
api_key, user_password, date_of_birth → Correct classification

// Camel case
apiKey, userPassword, dateOfBirth → Correct classification

// Kebab case (in headers)
x-api-key, x-auth-token → Correct classification
```

#### Multi-Value Fields

Arrays of PII are handled correctly:

```typescript
{
  emails: ["alice@example.com", "bob@test.com"],
  phoneNumbers: ["+15551234567", "+15559876543"]
}

// Filtered (non-owner):
{
  emails: ["a***e@example.com", "b***b@test.com"],
  phoneNumbers: ["***-***-4567", "***-***-6543"]
}

// Ensures no unmasked values leak in JSON output
```

## Running Tests

### Unit Tests

Test individual redaction functions:

```bash
# All privacy redaction tests
npm test -- privacy-redaction

# Specific test suites
npm test -- sanitize.util.spec.ts
npm test -- privacy-redaction-comprehensive.spec.ts
npm test -- privacy-export.spec.ts
```

### Integration Tests

Test complete export flow:

```bash
npm test -- privacy-redaction-integration.spec.ts
npm test -- redaction-surfaces.spec.ts
```

### Coverage Report

Generate coverage report for redaction code:

```bash
npm run test:cov -- --testPathPattern=privacy
```

Expected coverage: **>95%** for all redaction utilities.

## Verification Checklist

Before deploying changes to redaction logic, verify:

- [ ] All tests pass: `npm test -- privacy`
- [ ] New secret patterns added to `SENSITIVE_FIELDS` registry
- [ ] Export role matrix documented and tested
- [ ] Edge cases covered (unicode, long strings, null values)
- [ ] Performance acceptable for large datasets (>1000 records)
- [ ] Idempotency verified (multiple redactions = same result)
- [ ] No secrets in test fixtures or snapshots

## Recovery and Rollback

### If Secrets Are Leaked in Logs

**Immediate Actions:**
1. Rotate all potentially leaked credentials
2. Review log retention policy
3. Purge affected log entries if possible
4. Notify security team and affected users

**Root Cause Analysis:**
1. Identify which redaction rule failed
2. Add test case reproducing the leak
3. Fix redaction logic
4. Deploy fix with regression test

### If Secrets Are Leaked in Exports

**Immediate Actions:**
1. Invalidate all exports from affected timeframe
2. Notify affected users
3. Rotate leaked credentials
4. Review export authorization logic

**Rollback Strategy:**
1. Revert to previous version
2. Re-process exports with fixed redaction
3. Notify users of corrected exports

### Testing After Rollback

```bash
# Run full redaction test suite
npm test -- privacy-redaction

# Verify specific leak scenario
npm test -- privacy-redaction-comprehensive.spec.ts -t "should redact <specific pattern>"

# Integration test
npm test -- privacy-redaction-integration.spec.ts
```

## Documentation Updates

When adding new sensitive field patterns:

1. **Update registry:**
   ```typescript
   // src/logging/sanitize.util.ts
   export const SENSITIVE_FIELDS = new Set<string>([
     // ... existing fields
     "newSensitiveField",
   ]);
   ```

2. **Add test case:**
   ```typescript
   it("should redact newSensitiveField", () => {
     const data = { newSensitiveField: "secret" };
     expect(sanitizeValue(data).newSensitiveField).toBe(REDACTED);
   });
   ```

3. **Update this document** with the new pattern

4. **Document in code review** why the field is sensitive

## Performance Considerations

### Benchmarks

Redaction performance targets:

| Operation | Dataset Size | Max Duration | Notes |
|-----------|--------------|--------------|-------|
| Log sanitization | 1 KB message | < 1ms | Typical log entry |
| Export filtering | 1000 records | < 1s | Large user export |
| Error redaction | 8 KB message | < 5ms | Stack trace |
| Deep object (10 levels) | Any size | < 10ms | Nested structures |

### Optimization Notes

- Redaction uses regex for pattern matching (compiled once)
- Object traversal is depth-limited to prevent stack overflow
- Arrays and objects are capped to prevent memory issues
- String operations are bounded to prevent runaway scanning

### When to Optimize

Consider optimization if:
- Log throughput > 10,000 messages/sec affected by latency
- Export generation takes > 2 seconds for 1000 records
- Memory usage spikes during large exports

## Related Documentation

- [Sanitize Utility](../src/logging/sanitize.util.ts) - Core redaction logic
- [Privacy Export Authorizer](../src/infrastructure/export/privacy-export-authorizer.ts) - Role-based filtering
- [Redaction Surfaces](../src/logging/redaction-surfaces.spec.ts) - Cross-surface tests
- [Data Export API](DATA_EXPORT_API.md) - Export endpoints and flows
- [Security Audit](../SECURITY_AUDIT.md) - Security checklist

## Compliance

This redaction framework supports compliance with:

- **GDPR Article 32:** Security of processing
- **GDPR Article 5(1)(f):** Integrity and confidentiality
- **CCPA Section 1798.100:** Consumer rights to know
- **PCI DSS 3.4:** Rendering PAN unreadable
- **HIPAA Security Rule:** Access controls and audit

Regular audits should verify:
1. No PII in logs without user consent
2. No credentials in any export or log
3. Role-based access properly enforced
4. Audit trail maintains non-sensitive data

## Migration Plan

This feature extends existing redaction with no breaking changes:

- ✅ Existing `sanitizeValue()` unchanged
- ✅ New comprehensive tests added
- ✅ No database migrations required
- ✅ No API changes required
- ✅ Backward compatible with existing logs

### Deployment Steps

1. Deploy new test files
2. Run full test suite to verify
3. Monitor error rates for 24 hours
4. Review sample logs for proper redaction
5. Audit exports for secret leaks

### Verification

```bash
# Pre-deployment verification
npm test -- privacy-redaction-comprehensive
npm test -- privacy-redaction-integration

# Post-deployment verification
# 1. Check logs for REDACTED markers
# 2. Generate test export and verify no secrets
# 3. Trigger test error and verify redacted stack trace
```

## Contact

For questions about privacy redaction:
- Security team: security@trellis.example
- Privacy officer: privacy@trellis.example
- Engineering: eng@trellis.example

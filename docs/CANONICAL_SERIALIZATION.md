# Canonical Serialization for Signed, Hashed, and Replay-Protected Payloads

This document describes the canonical serialization layer used by the Trellis API for any payload that is signed, hashed, or replay-protected (nonce-based).

## Motivation

When a payload is hashed or signed, the bytes that are hashed must be deterministic. Two semantically equivalent objects that differ only in key order, number formatting, or normalization of addresses would otherwise produce different hashes. This layer guarantees that equivalent payloads produce identical bytes.

## Components

- `src/common/serialization/canonical-json.ts` - deterministic JSON encoding.
- `src/common/serialization/canonical-payload.ts` - normalization + hashing entry point.
- `src/common/serialization/canonical-payload.spec.ts` - regression tests for equivalent payloads.

## Canonical JSON Rules

1. Object keys are sorted by code point (lexicographically) using `Array.prototype.sort` default ordering.
2. Arrays preserve insertion order and must be dense (no holes).
3. Only plain objects (`prototype === Object.prototype` or `null`) are allowed. Class instances, `Map`, `Set`, `Date`, `BigInt`, and functions are rejected.
4. Numbers must be finite. Integers must be safe integers; larger values must be encoded as strings. `-0` normalizes to `0`.
5. `undefined` and circular references are rejected.
6. Strings are encoded with `JSON.stringify`, which produces UTF-8 safe escapes.

## Payload Normalization

Before hashing, a payload is normalized:

- **Addresses** are lowercased. This matches the nonce management layer, which keys records by lowercase address.
- **Nonces** are normalized to base-10 strings without leading zeros.
- **Chain IDs** are normalized to base-10 strings.
- **Timestamps** are normalized to UTC ISO 8601 strings with millisecond precision.
- **Decimal amounts** are normalized to strings with a single canonical decimal representation.

## Hashing

The canonical hash is `Keccak256(canonicalJson(normalizedPayload))`, returned as a `0x...` hex string. This matches the convention used by EVM tooling and by the Stellar oracle adapter.

## Operational Edge Cases

- **Large integers**: values outside `Number.MAX_SAFE_INTEGER` must be passed as strings. The normalizer accepts string integers and preserves them verbatim.
- **Mixed-case addresses**: normalized to lowercase. Checksum addresses are not preserved in the hash input.
- **Undefined optional fields**: must be omitted before hashing. Passing `undefined` throws.
- **Numeric strings vs numbers**: the normalizer coerces decimal amounts to strings so `1.0` and `1` hash identically.
- **Circular references**: rejected with `TypeError`.

## Failure Modes

- If a payload contains a non-plain object (e.g. a TypeORM entity), `normalizePayload` throws. Callers must convert entities to plain objects first.
- If a nonce is not a base-10 integer string, normalization throws. This prevents silent replay-protection bypasses.
- If a timestamp is not a valid date, normalization throws.

## Rollback / Recovery

The canonical serialization layer is pure and stateless. Rollback is a deployment revert. Because the layer is only used for hashing/signing, reverting it does not affect stored data. However, any signatures produced with the new layer will not verify against the old layer. Operators should ensure that in-flight signed payloads are drained before rolling back.

## Testing

Run the regression tests with:

```bash
echo "npm test -- ..."

```

The tests cover key order independence, address casing, nonce normalization, timestamp normalization, decimal amount normalization, and rejection of invalid inputs.

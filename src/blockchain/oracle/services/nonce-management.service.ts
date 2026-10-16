import {
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository, LessThan } from "typeorm";
import { SubmissionNonce } from "../entities/submission-nonce.entity";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";

/**
 * Canonical serialization layer for signed, hashed, or replay-protected payloads.
 *
 * Signed/hashed inputs must use a stable field order, encoding, and
 * normalization so that equivalent payloads produce identical digests.
 * This module is deliberately dependency-free and deterministic.
 */

export type CanonicalPrimitive =
  | string
  | number
  | boolean
  | null
  | undefined
  | bigint;

export type CanonicalValue =
  | CanonicalPrimitive
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

export interface CanonicalizeOptions {
  /** When true, undefined object fields are kept as `null` instead of being dropped. */
  keepUndefined?: boolean;
  /** When true, numeric strings are normalized to their canonical decimal form. */
  normalizeNumericStrings?: boolean;
}

const DEFAULT_OPTIONS: Required<CanonicalizeOptions> = {
  keepUndefined: false,
  normalizeNumericStrings: true,
};

/**
 * Normalize a string for canonical serialization:
 * - NFC normalization (UNICODE) so visually identical strings hash identically.
 * - Trim outer whitespace.
 * - Optionally normalize numeric strings (e.g. "0001" -> "1").
 */
export function normalizeString(
  value: string,
  options: CanonicalizeOptions = DEFAULT_OPTIONS,
): string {
  const normalized = value.normalize("NFC").trim();
  if (options.normalizeNumericStrings && /^-?\d+$/.test(normalized)) {
    // Strip leading zeros while preserving sign and zero itself.
    const negative = normalized.startsWith("-");
    const digits = negative ? normalized.slice(1) : normalized;
    const stripped = digits.replace(/^0+(.)/, "$1") || "0";
    return (negative ? "-" : "") + stripped;
  }
  return normalized;
}

/**
 * Recursively normalize a value into a canonical form.
 * Object keys are sorted lexicographically and array order is preserved.
 */
export function canonicalizeValue(
  value: unknown,
  options: CanonicalizeOptions = DEFAULT_OPTIONS,
): CanonicalValue {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return options.keepUndefined ? null : null;
  }
  if (typeof value === "string") {
    return normalizeString(value, options);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(
        `Cannot canonicalize non-finite number: ${String(value)}`,
      );
    }
    return value;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item, options));
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined || options.keepUndefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: { [key: string]: CanonicalValue } = {};
    for (const [key, v] of entries) {
      out[key] = canonicalizeValue(v, options);
    }
    return out;
  }
  throw new Error(
    `Cannot canonicalize unsupported type: ${typeof value}`,
  );
}

/**
 * Serialize a value to a canonical JSON string.
 * Keys in objects are sorted and strings are NFC normalized.
 */
export function canonicalizeToJSON(
  value: unknown,
  options: CanonicalizeOptions = DEFAULT_OPTIONS,
): string {
  return JSON.stringify(canonicalizeValue(value, options));
}

/**
 * Compute a canonical keccak256 digest of a payload.
 * Equivalent payloads (key order, whitespace, NFC form) produce the same digest.
 */
export function canonicalHash(
  value: unknown,
  options: CanonicalizeOptions = DEFAULT_OPTIONS,
): string {
  return keccak256(toUtf8Bytes(canonicalizeToJSON(value, options)));
}

/**
 * Service for managing nonces to prevent replay attacks
 * Each address has a monotonically increasing nonce
 */
@Injectable()
export class NonceManagementService {
  private readonly logger = new Logger(NonceManagementService.name);

  // In-memory cache for nonces to reduce database queries
  private nonceCache = new Map<string, { nonce: bigint; lastFetch: number }>();
  private readonly CACHE_TTL = 60000; // 1 minute cache TTL

  constructor(
    @InjectRepository(SubmissionNonce)
    private nonceRepository: Repository<SubmissionNonce>,
  ) {}

  /**
   * Get the current nonce for an address
   * Returns 0 if address has never submitted before
   */
  async getCurrentNonce(address: string): Promise<string> {
    const checksumAddress = getAddress(address);

    // Check cache first
    const cached = this.nonceCache.get(checksumAddress.toLowerCase());
    if (cached && Date.now() - cached.lastFetch < this.CACHE_TTL) {
      this.logger.debug(
        `Returning cached nonce ${cached.nonce} for ${checksumAddress}`,
      );
      return cached.nonce.toString();
    }

    // Fetch from database
    let nonceEntity = await this.nonceRepository.findOne({
      where: { address: checksumAddress.toLowerCase() },
    });

    if (!nonceEntity) {
      // Create new nonce entry for this address
      nonceEntity = this.nonceRepository.create({
        address: checksumAddress.toLowerCase(),
        nonce: "0",
      });
      await this.nonceRepository.save(nonceEntity);
      this.logger.log(`Created new nonce entry for ${checksumAddress}`);
    }

    // Update cache
    this.nonceCache.set(checksumAddress.toLowerCase(), {
      nonce: BigInt(nonceEntity.nonce),
      lastFetch: Date.now(),
    });

    return nonceEntity.nonce;
  }

  /**
   * Get and increment nonce atomically
   * This ensures no two submissions get the same nonce
   */
  async getAndIncrementNonce(address: string): Promise<string> {
    const checksumAddress = getAddress(address);

    // Use database transaction for atomicity
    const result = await this.nonceRepository.manager.transaction(
      async (transactionalEntityManager) => {
        // Lock the row for update
        let nonceEntity = await transactionalEntityManager.findOne(
          SubmissionNonce,
          {
            where: { address: checksumAddress.toLowerCase() },
            lock: { mode: "pessimistic_write" },
          },
        );

        if (!nonceEntity) {
          // Create new nonce entry
          nonceEntity = transactionalEntityManager.create(SubmissionNonce, {
            address: checksumAddress.toLowerCase(),
            nonce: "0",
          });
        }

        const currentNonce = nonceEntity.nonce;
        const nextNonce = (BigInt(currentNonce) + BigInt(1)).toString();

        // Increment nonce
        nonceEntity.nonce = nextNonce;
        nonceEntity.lastUsedAt = new Date();

        await transactionalEntityManager.save(SubmissionNonce, nonceEntity);

        return currentNonce;
      },
    );

    // Invalidate cache
    this.nonceCache.delete(checksumAddress.toLowerCase());

    this.logger.log(
      `Incremented nonce for ${checksumAddress}: ${result} -> ${BigInt(result) + BigInt(1)}`,
    );

    return result;
  }

  /**
   * Validate that a nonce is the next expected nonce for an address
   * Useful for validation before accepting a signed payload
   */
  async validateNonce(address: string, nonce: string): Promise<boolean> {
    const checksumAddress = getAddress(address);
    const currentNonce = await this.getCurrentNonce(checksumAddress);

    const isValid = nonce === currentNonce;

    if (!isValid) {
      this.logger.warn(
        `Nonce validation failed for ${checksumAddress}. Expected: ${currentNonce}, Got: ${nonce}`,
      );
    }

    return isValid;
  }

  /**
   * Manually set nonce for an address (admin operation)
   * Use with caution - can cause issues if set incorrectly
   */
  async setNonce(address: string, nonce: string): Promise<void> {
    const checksumAddress = getAddress(address);

    let nonceEntity = await this.nonceRepository.findOne({
      where: { address: checksumAddress.toLowerCase() },
    });

    if (!nonceEntity) {
      nonceEntity = this.nonceRepository.create({
        address: checksumAddress.toLowerCase(),
        nonce: nonce,
      });
    } else {
      nonceEntity.nonce = nonce;
    }

    await this.nonceRepository.save(nonceEntity);

    // Invalidate cache
    this.nonceCache.delete(checksumAddress.toLowerCase());

    this.logger.warn(`Manually set nonce for ${checksumAddress} to ${nonce}`);
  }

  /**
   * Reset nonce for an address (admin operation)
   */
  async resetNonce(address: string): Promise<void> {
    await this.setNonce(address, "0");
    this.logger.warn(`Reset nonce for ${address} to 0`);
  }

  /**
   * Get nonce information for multiple addresses
   */
  async getNoncesForAddresses(
    addresses: string[],
  ): Promise<Map<string, string>> {
    const checksumAddresses = addresses.map((addr) => getAddress(addr));

    const nonceEntities = await this.nonceRepository.find({
      where: checksumAddresses.map((addr) => ({
        address: addr.toLowerCase(),
      })),
    });

    const nonceMap = new Map<string, string>();

    checksumAddresses.forEach((addr) => {
      const entity = nonceEntities.find(
        (e) => e.address === addr.toLowerCase(),
      );
      nonceMap.set(addr, entity?.nonce || "0");
    });

    return nonceMap;
  }

  /**
   * Clear stale cache entries
   * Should be called periodically
   */
  clearStaleCache(): void {
    const now = Date.now();
    let cleared = 0;

    for (const [address, cached] of this.nonceCache.entries()) {
      if (now - cached.lastFetch > this.CACHE_TTL) {
        this.nonceCache.delete(address);
        cleared++;
      }
    }

    if (cleared > 0) {
      this.logger.debug(`Cleared ${cleared} stale cache entries`);
    }
  }

  /**
   * Get statistics about nonce usage
   */
  async getNonceStats(): Promise<{
    totalAddresses: number;
    totalNonces: bigint;
    averageNonce: number;
  }> {
    const result = await this.nonceRepository
      .createQueryBuilder("nonce")
      .select("COUNT(*)", "totalAddresses")
      .addSelect("SUM(CAST(nonce AS BIGINT))", "totalNonces")
      .getRawOne();

    const totalAddresses = parseInt(result.totalAddresses) || 0;
    const totalNonces = BigInt(result.totalNonces || 0);
    const averageNonce =
      totalAddresses > 0 ? Number(totalNonces) / totalAddresses : 0;

    return {
      totalAddresses,
      totalNonces,
      averageNonce,
    };
  }

  /**
   * Clean up old nonce records (optional maintenance)
   * Remove nonces for addresses that haven't been used in a long time
   */
  async cleanupOldNonces(daysInactive: number = 90): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysInactive);

    const result = await this.nonceRepository.delete({
      lastUsedAt: LessThan(cutoffDate),
      nonce: "0", // Only delete unused addresses
    });

    const deletedCount = result.affected || 0;

    if (deletedCount > 0) {
      this.logger.log(
        `Cleaned up ${deletedCount} inactive nonce records older than ${daysInactive} days`,
      );
    }

    return deletedCount;
  }
}

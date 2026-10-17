import { Injectable } from "@nestjs/common";
import { createHmac, createHash } from "crypto";

export interface SanitizeOptions {
  maxDepth?: number;
  maxStringLength?: number;
  saltSeed?: string;
}

export interface SanitizationReport {
  sanitized: Record<string, unknown> | null;
  redactedPaths: string[];
  scrubbedPatternsCount: number;
}

@Injectable()
export class PrivacyPreserverService {
  private readonly defaultSaltSeed =
    process.env.AUDIT_EVIDENCE_SALT_SEED || "trellis-evidence-preserver-seed-v1";

  private readonly emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
  private readonly stellarSecretRegex = /\bS[A-Z2-7]{55}\b/g;
  private readonly jwtRegex = /\beyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;
  private readonly bearerRegex = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
  private readonly sensitiveKeyPattern =
    /(secret|token|password|passwd|authorization|auth[-_]?header|api[-_]?key|apikey|private[-_]?key|secret[-_]?key|seed|mnemonic|signature|cookie|session[-_]?id|otp|totp|pin|card[-_]?number|cvv|cvc|iban|ssn|routing[-_]?number|refresh[-_]?token|webhook[-_]?secret)/i;

  /**
   * Generates a deterministic daily salt for actor pseudonymisation.
   */
  getDailySalt(date: Date = new Date(), seed: string = this.defaultSaltSeed): string {
    const dayKey = date.toISOString().slice(0, 10);
    return createHmac("sha256", seed).update(dayKey).digest("hex");
  }

  /**
   * Pseudonymizes actor identifiers (e.g. user IDs) using daily keyed HMAC.
   * Produces a consistent, verifiable pseudonym for correlation during the day,
   * but prevents cross-day deanonymization.
   */
  pseudonymizeActor(actorId?: string | null, date: Date = new Date()): string {
    if (!actorId) return "anonymous";
    const salt = this.getDailySalt(date);
    const hash = createHmac("sha256", salt)
      .update(actorId.trim().toLowerCase())
      .digest("hex");
    return `actor_${hash.slice(0, 16)}`;
  }

  /**
   * Masks IP addresses to prevent physical geo-tracking while maintaining
   * an HMAC hash for session correlation within an investigation.
   */
  maskIpAddress(ip?: string | null): { masked: string; ipHash: string } {
    if (!ip || typeof ip !== "string") {
      return { masked: "unknown", ipHash: "unknown" };
    }
    const cleanIp = ip.trim();
    const ipHash = createHmac("sha256", this.defaultSaltSeed)
      .update(cleanIp)
      .digest("hex")
      .slice(0, 16);

    // IPv4 Subnet Masking (keep first two octets)
    if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp)) {
      const parts = cleanIp.split(".");
      return {
        masked: `${parts[0]}.${parts[1]}.xxx.xxx`,
        ipHash: `ip_${ipHash}`,
      };
    }

    // IPv6 Masking (keep first 3 segments)
    if (cleanIp.includes(":")) {
      const parts = cleanIp.split(":");
      const prefix = parts.slice(0, 3).join(":");
      return {
        masked: `${prefix}:xxxx:xxxx:xxxx`,
        ipHash: `ip_${ipHash}`,
      };
    }

    return { masked: "masked-ip", ipHash: `ip_${ipHash}` };
  }

  /**
   * Classifies user-agents into high-level categories to eliminate device fingerprinting.
   */
  classifyUserAgent(ua?: string | null): string {
    if (!ua || typeof ua !== "string") return "unknown";
    const lower = ua.toLowerCase();
    if (lower.includes("curl") || lower.includes("postman") || lower.includes("insomnia") || lower.includes("python")) {
      return "api-client";
    }
    if (lower.includes("bot") || lower.includes("crawl") || lower.includes("spider")) {
      return "automated-bot";
    }
    if (lower.includes("mobile") || lower.includes("android") || lower.includes("iphone")) {
      return "mobile-browser";
    }
    return "desktop-browser";
  }

  /**
   * Normalizes URLs/routes to bound cardinality and strip embedded secrets/parameters.
   */
  normalizeRoute(route?: string | null): string {
    if (!route || typeof route !== "string") return "/unmatched";
    const pathOnly = route.split("?")[0].trim();
    if (!pathOnly || pathOnly === "/") return "/";

    return pathOnly
      .replace(/\/G[A-Z2-7]{55}(\/|$)/g, "/:stellarAddress$1")
      .replace(/\/0x[0-9a-fA-F]{40}(\/|$)/g, "/:ethAddress$1")
      .replace(/\/[0-9a-fA-F]{64}(\/|$)/g, "/:txHash$1")
      .replace(
        /\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(\/|$)/g,
        "/:uuid$1"
      )
      .replace(/\/\d+(\/|$)/g, "/:id$1");
  }

  /**
   * Scrubs raw text fields (logs, error messages, descriptions) of inline secrets and PII.
   */
  scrubText(text?: string | null): { scrubbed: string; matchCount: number } {
    if (!text || typeof text !== "string") {
      return { scrubbed: "", matchCount: 0 };
    }

    let count = 0;
    let result = text;

    result = result.replace(this.stellarSecretRegex, () => {
      count++;
      return "[REDACTED_STELLAR_SECRET]";
    });

    result = result.replace(this.bearerRegex, () => {
      count++;
      return "Bearer [REDACTED_TOKEN]";
    });

    result = result.replace(this.jwtRegex, () => {
      count++;
      return "[REDACTED_JWT]";
    });

    result = result.replace(this.emailRegex, () => {
      count++;
      return "[email]";
    });

    return { scrubbed: result, matchCount: count };
  }

  /**
   * Deeply sanitizes arbitrary nested objects/arrays for inclusion in an evidence bundle.
   * Redacts sensitive key names, scrubs strings, caps depth, and breaks circular references.
   */
  sanitizePayload(input: unknown, options: SanitizeOptions = {}): SanitizationReport {
    const maxDepth = options.maxDepth ?? 5;
    const maxStringLength = options.maxStringLength ?? 300;
    const redactedPaths: string[] = [];
    let scrubbedPatternsCount = 0;
    const seen = new WeakSet<object>();

    const walk = (val: unknown, path: string, depth: number): unknown => {
      if (val === null || val === undefined) return null;

      if (typeof val === "string") {
        const { scrubbed, matchCount } = this.scrubText(val);
        scrubbedPatternsCount += matchCount;
        if (scrubbed.length > maxStringLength) {
          return `${scrubbed.slice(0, maxStringLength)}...[truncated]`;
        }
        return scrubbed;
      }

      if (typeof val === "number" || typeof val === "boolean") return val;
      if (typeof val === "bigint") return val.toString();
      if (val instanceof Date) return val.toISOString();

      if (typeof val !== "object") return undefined;

      if (seen.has(val as object)) return "[Circular]";
      if (depth >= maxDepth) return "[MaxDepthReached]";

      seen.add(val as object);

      if (Array.isArray(val)) {
        return val
          .slice(0, 50)
          .map((item, idx) => walk(item, `${path}[${idx}]`, depth + 1))
          .filter((item) => item !== undefined);
      }

      const obj = val as Record<string, unknown>;
      const sanitizedObj: Record<string, unknown> = {};

      for (const [key, propVal] of Object.entries(obj)) {
        const currentPath = path ? `${path}.${key}` : key;
        if (this.sensitiveKeyPattern.test(key)) {
          sanitizedObj[key] = "[REDACTED]";
          redactedPaths.push(currentPath);
          continue;
        }

        const walked = walk(propVal, currentPath, depth + 1);
        if (walked !== undefined) {
          sanitizedObj[key] = walked;
        }
      }

      return sanitizedObj;
    };

    const sanitized = walk(input, "", 0);
    return {
      sanitized: typeof sanitized === "object" && sanitized !== null && !Array.isArray(sanitized)
        ? (sanitized as Record<string, unknown>)
        : null,
      redactedPaths,
      scrubbedPatternsCount,
    };
  }
}

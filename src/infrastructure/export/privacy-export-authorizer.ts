import { Injectable, Logger } from "@nestjs/common";

export enum FieldSensitivity {
  PUBLIC = "public",
  CONFIDENTIAL_FINANCIAL = "confidential_financial",
  RESTRICTED_PII = "restricted_pii",
  FORBIDDEN_SECRET = "forbidden_secret",
}

export type ExportRole = "user" | "auditor" | "compliance_officer" | "admin";

export interface FieldAuthorizationContext {
  role: ExportRole;
  isOwner: boolean;
  authorizedScopes?: string[];
  includePiiConsent?: boolean;
}

const FORBIDDEN_SECRET_PATTERNS = [
  /password/i,
  /secret/i,
  /private_?key/i,
  /privateKey/i,
  /mnemonic/i,
  /seed/i,
  /apiKey/i,
  /api_?key/i,
  /jwt/i,
  /token/i,
  /hash_?salt/i,
];

const RESTRICTED_PII_PATTERNS = [
  /email/i,
  /phone/i,
  /full_?name/i,
  /fullName/i,
  /firstName/i,
  /lastName/i,
  /address_?line/i,
  /ip_?address/i,
  /ipAddress/i,
  /tax_?id/i,
  /ssn/i,
  /dob/i,
  /birth_?date/i,
];

const CONFIDENTIAL_FINANCIAL_PATTERNS = [
  /balance/i,
  /memo_?text/i,
  /counterparty_?detail/i,
  /internal_?fee/i,
];

@Injectable()
export class PrivacyExportAuthorizer {
  private readonly logger = new Logger(PrivacyExportAuthorizer.name);

  /**
   * Determine the classification tier of a field name.
   */
  classifyField(fieldName: string): FieldSensitivity {
    for (const pattern of FORBIDDEN_SECRET_PATTERNS) {
      if (pattern.test(fieldName)) {
        return FieldSensitivity.FORBIDDEN_SECRET;
      }
    }

    for (const pattern of RESTRICTED_PII_PATTERNS) {
      if (pattern.test(fieldName)) {
        return FieldSensitivity.RESTRICTED_PII;
      }
    }

    for (const pattern of CONFIDENTIAL_FINANCIAL_PATTERNS) {
      if (pattern.test(fieldName)) {
        return FieldSensitivity.CONFIDENTIAL_FINANCIAL;
      }
    }

    return FieldSensitivity.PUBLIC;
  }

  /**
   * Apply field-level authorization and privacy masking to an export payload.
   */
  filterRecord<T = unknown>(record: T, context: FieldAuthorizationContext): T {
    return this.sanitizeNode(record, context) as T;
  }

  private sanitizeNode(node: unknown, context: FieldAuthorizationContext): unknown {
    if (Array.isArray(node)) {
      return node.map((item) => this.sanitizeNode(item, context));
    }

    if (node !== null && typeof node === "object") {
      const sanitized: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(node)) {
        const classification = this.classifyField(key);

        // Invariant 1: Secrets are NEVER exported for any role
        if (classification === FieldSensitivity.FORBIDDEN_SECRET) {
          continue;
        }

        // Invariant 2: Restricted PII authorization
        if (classification === FieldSensitivity.RESTRICTED_PII) {
          const canViewPii =
            context.role === "admin" ||
            context.role === "compliance_officer" ||
            (context.isOwner && context.includePiiConsent === true);

          if (canViewPii) {
            sanitized[key] = this.sanitizeNode(value, context);
          } else {
            sanitized[key] = this.maskPiiValue(key, value);
          }
          continue;
        }

        // Invariant 3: Confidential financial authorization
        if (classification === FieldSensitivity.CONFIDENTIAL_FINANCIAL) {
          const canViewFinancial =
            context.isOwner ||
            context.role === "admin" ||
            context.role === "auditor" ||
            context.role === "compliance_officer";

          if (canViewFinancial) {
            sanitized[key] = this.sanitizeNode(value, context);
          } else {
            sanitized[key] = "[CONFIDENTIAL]";
          }
          continue;
        }

        // Public / non-sensitive fields
        sanitized[key] = this.sanitizeNode(value, context);
      }

      return sanitized;
    }

    return node;
  }

  /**
   * Mask PII fields based on type heuristics.
   */
  maskPiiValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return "";
    const str = String(value);

    if (/email/i.test(key) && str.includes("@")) {
      const [name, domain] = str.split("@");
      const maskedName =
        name.length > 2 ? `${name[0]}***${name[name.length - 1]}` : `${name[0]}***`;
      return `${maskedName}@${domain}`;
    }

    if (/phone/i.test(key)) {
      return str.length > 4 ? `***-***-${str.slice(-4)}` : "***";
    }

    if (/ip/i.test(key)) {
      // Mask last octet for IPv4
      const parts = str.split(".");
      if (parts.length === 4) {
        return `${parts[0]}.${parts[1]}.${parts[2]}.xxx`;
      }
      return "***";
    }

    // Generic string mask
    if (str.length <= 2) return "**";
    return `${str[0]}***${str[str.length - 1]}`;
  }
}

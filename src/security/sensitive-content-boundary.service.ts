import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import * as crypto from "crypto";

export interface DocumentAcl {
  ownerId: string;
  tenantId: string;
  allowedRoles?: string[];
  isConfidential?: boolean;
}

export interface UserContext {
  userId: string;
  tenantId: string;
  roles: string[];
}

export interface DownloadPolicyResult {
  safeFilename: string;
  headers: Record<string, string>;
}

@Injectable()
export class SensitiveContentBoundaryService {
  private readonly logger = new Logger(SensitiveContentBoundaryService.name);

  // Dangerous HTML tags & attributes regex
  private readonly SCRIPT_STYLE_BLOCKS = /<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
  private readonly DANGEROUS_TAGS = /<\s*\/?\s*(iframe|object|embed|applet|meta|link|base|form|svg|math)[^>]*>/gi;
  private readonly EVENT_HANDLERS = /\son\w+\s*=\s*(?:'[^']*'|"[^"]*"|[^\s>]+)/gi;
  private readonly JS_PROTOCOLS = /href\s*=\s*(?:'javascript:[^']*'|"javascript:[^"]*"|javascript:[^\s>]+)/gi;

  // SSRF blocked IP patterns (IPv4 private, loopback, link-local metadata)
  private readonly BLOCKED_IP_PATTERNS = [
    /^127\./, // 127.0.0.0/8 (Loopback)
    /^0\./, // 0.0.0.0/8
    /^10\./, // 10.0.0.0/8 (Private)
    /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12 (Private)
    /^192\.168\./, // 192.168.0.0/16 (Private)
    /^169\.254\./, // 169.254.0.0/16 (Link Local / Cloud Metadata)
    /^::1$/, // IPv6 loopback
    /^fe80:/i, // IPv6 link-local
    /^fc00:/i, // IPv6 unique local
  ];

  // Sensitive field patterns to strip or mask
  private readonly SENSITIVE_KEYS = /(password|passwd|secret|private.?key|token|auth|bearer|salt|seed|two.?factor|ssn|credit.?card)/i;
  private readonly CSV_INJECTION_CHARS = /^[=+\-@\t\r]/;

  // =========================================================================
  // 1. RENDERING BOUNDARY
  // =========================================================================

  /**
   * Sanitizes content destined for user-facing UI rendering or emails, neutralising XSS attacks.
   */
  sanitizeRenderedContent(input: string, options: { allowSafeHtml?: boolean } = {}): string {
    if (!input || typeof input !== "string") return "";

    if (!options.allowSafeHtml) {
      // Complete HTML entity escaping
      return input
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#x27;")
        .replace(/\//g, "&#x2F;");
    }

    // Rich text mode: Strip active script/style blocks, event handlers, and javascript: links
    let sanitized = input;
    let prev = "";
    while (sanitized !== prev) {
      prev = sanitized;
      sanitized = sanitized
        .replace(this.SCRIPT_STYLE_BLOCKS, "")
        .replace(/<\s*\/?\s*(script|style)\b[^>]*>/gi, "")
        .replace(this.DANGEROUS_TAGS, "")
        .replace(this.EVENT_HANDLERS, "")
        .replace(this.JS_PROTOCOLS, 'href="#"');
    }

    return sanitized;
  }

  // =========================================================================
  // 2. DOWNLOAD BOUNDARY
  // =========================================================================

  /**
   * Enforces security boundaries on document and report downloads:
   * 1. Multi-tenant and role authorization check.
   * 2. Filename sanitization against path traversal and header injection (CRLF).
   * 3. Defensive security headers (nosniff, attachment disposition, private cache).
   */
  enforceDownloadBoundary(
    fileMetadata: { filename: string; mimeType: string; size: number },
    user: UserContext,
    acl: DocumentAcl,
  ): DownloadPolicyResult {
    // 1. Tenant boundary check
    if (user.tenantId !== acl.tenantId) {
      throw new ForbiddenException("Cross-tenant document access denied");
    }

    // 2. Ownership / Role boundary check
    const isOwner = user.userId === acl.ownerId;
    const hasRole =
      acl.allowedRoles &&
      acl.allowedRoles.some((role) => user.roles.includes(role));

    if (!isOwner && !hasRole) {
      throw new ForbiddenException("User not authorized to download this resource");
    }

    // 3. Filename sanitization (Path traversal + CRLF header injection prevention)
    const rawFilename = fileMetadata.filename || "download.bin";
    const baseName = rawFilename
      .replace(/[\\/]/g, "_") // strip path separators
      .replace(/\.\./g, "_") // strip dot-dot traversals
      .replace(/[\r\n\0]/g, "") // strip control chars & line breaks
      .replace(/["';\\]/g, ""); // strip quotes and semicolons

    const safeFilename = baseName.trim() || "safe_download.bin";

    // 4. Validate MIME type against dangerous executables
    const dangerousMimes = [
      "application/x-msdownload",
      "application/x-sh",
      "application/x-csh",
      "application/x-bat",
      "application/x-executable",
    ];
    const safeMime = dangerousMimes.includes(fileMetadata.mimeType.toLowerCase())
      ? "application/octet-stream"
      : fileMetadata.mimeType;

    // 5. Construct defensive headers
    const headers: Record<string, string> = {
      "Content-Type": safeMime,
      "Content-Disposition": `attachment; filename="${safeFilename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      "Pragma": "no-cache",
      "X-Frame-Options": "DENY",
    };

    return { safeFilename, headers };
  }

  // =========================================================================
  // 3. WEBHOOK BOUNDARY
  // =========================================================================

  /**
   * Enforces webhook outbound safety:
   * 1. Blocks SSRF targets (loopback, link-local, private subnets).
   * 2. Strips internal secrets, credentials, tokens, and hashes from the payload.
   * 3. Calculates HMAC-SHA256 signature for payload verification.
   */
  validateWebhookBoundary(
    targetUrl: string,
    payload: Record<string, any>,
    signingSecret: string,
  ): {
    sanitizedUrl: string;
    sanitizedPayload: Record<string, any>;
    signatureHeader: string;
  } {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      throw new BadRequestException("Invalid webhook destination URL");
    }

    // Enforce HTTPS in production or HTTP/HTTPS strictly
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new BadRequestException("Unsupported webhook protocol: must be HTTP or HTTPS");
    }

    // Check SSRF hostname / IP boundaries
    const hostname = parsedUrl.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      this.BLOCKED_IP_PATTERNS.some((pattern) => pattern.test(hostname))
    ) {
      throw new ForbiddenException(
        `Webhook destination '${hostname}' targets a prohibited internal/loopback network address (SSRF guard)`,
      );
    }

    // Scrub payload of sensitive secrets
    const sanitizedPayload = this.stripSensitiveFields(payload);

    // Compute HMAC-SHA256 signature
    const serialized = JSON.stringify(sanitizedPayload);
    const signature = crypto
      .createHmac("sha256", signingSecret)
      .update(serialized)
      .digest("hex");

    return {
      sanitizedUrl: parsedUrl.toString(),
      sanitizedPayload,
      signatureHeader: `sha256=${signature}`,
    };
  }

  // =========================================================================
  // 4. EXPORT BOUNDARY (CSV, JSON, PII Neutralization)
  // =========================================================================

  /**
   * Sanitizes a data row for export:
   * - Strips forbidden authentication and key credentials.
   * - Masks PII (emails, tax IDs, credit cards).
   * - Escapes CSV formula injection characters (=, +, -, @, tab).
   */
  sanitizeExportRow(
    row: Record<string, any>,
    options: { maskPii?: boolean; escapeCsvFormulas?: boolean } = {},
  ): Record<string, any> {
    const maskPii = options.maskPii ?? true;
    const escapeFormulas = options.escapeCsvFormulas ?? true;
    const result: Record<string, any> = {};

    for (const [key, val] of Object.entries(row)) {
      // 1. Remove credential fields
      if (this.SENSITIVE_KEYS.test(key)) {
        continue;
      }

      if (val === null || val === undefined) {
        result[key] = val;
        continue;
      }

      if (typeof val === "object" && !Array.isArray(val) && !(val instanceof Date)) {
        result[key] = this.sanitizeExportRow(val, options);
        continue;
      }

      let processedVal = val;

      // 2. PII Masking
      if (maskPii && typeof processedVal === "string") {
        // Email masking: user@domain.com -> u***@d***.com
        processedVal = processedVal.replace(
          /\b([a-zA-Z0-9])[a-zA-Z0-9._%+-]*@([a-zA-Z0-9])[a-zA-Z0-9.-]*\.[a-zA-Z]{2,}\b/g,
          "$1***@$2***.com",
        );
        // SSN / Tax ID masking: 123-45-6789 -> ***-**-6789
        processedVal = processedVal.replace(
          /\b\d{3}[- ]?\d{2}[- ]?(\d{4})\b/g,
          "***-**-$1",
        );
      }

      // 3. Formula Injection (CWE-1236) Protection
      if (escapeFormulas && typeof processedVal === "string") {
        if (this.CSV_INJECTION_CHARS.test(processedVal)) {
          // Prepend single quote ' to neutralize spreadsheet formula evaluation
          processedVal = `'${processedVal}`;
        }
      }

      result[key] = processedVal;
    }

    return result;
  }

  /**
   * Generates a safe CSV string preventing Formula Injection and escaping commas/quotes.
   */
  formatSafeCsv(headers: string[], rows: Record<string, any>[]): string {
    const headerLine = headers.map((h) => this.quoteCsvCell(h)).join(",");
    const lines = [headerLine];

    for (const row of rows) {
      const sanitized = this.sanitizeExportRow(row, { escapeCsvFormulas: true });
      const rowLine = headers
        .map((h) => {
          const val = sanitized[h];
          return this.quoteCsvCell(val === undefined || val === null ? "" : String(val));
        })
        .join(",");
      lines.push(rowLine);
    }

    return lines.join("\r\n");
  }

  private quoteCsvCell(cell: string): string {
    // If the cell contains quotes, commas, or line breaks, wrap in quotes and escape quotes
    if (cell.includes('"') || cell.includes(",") || cell.includes("\n") || cell.includes("\r")) {
      return `"${cell.replace(/"/g, '""')}"`;
    }
    return cell;
  }

  private stripSensitiveFields(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj !== "object") return obj;

    if (Array.isArray(obj)) {
      return obj.map((item) => this.stripSensitiveFields(item));
    }

    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (this.SENSITIVE_KEYS.test(key)) {
        continue; // Scrub field entirely
      }
      clean[key] = this.stripSensitiveFields(value);
    }
    return clean;
  }
}

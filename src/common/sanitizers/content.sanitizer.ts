import { Injectable, BadRequestException, Logger } from "@nestjs/common";

@Injectable()
export class ContentSanitizerService {
  private readonly logger = new Logger(ContentSanitizerService.name);

  /**
   * SQL keywords that are dangerous when they appear in raw filter input.
   * Matched case-insensitively as word boundaries.
   */
  private readonly sqlKeywordPattern =
    /\b(union|select|insert|update|delete|drop|truncate|alter|create|exec|execute|declare|cast|convert|merge|call|executeimmediate|waitfor|benchmark|information_schema|sys|master|bulk|openrowset|xpcmshell|sp_executesql|shell)\b/gi;

  /**
   * SQL comment delimiters and tautology patterns.
   */
  private readonly sqlCommentPattern = /(--|#|\/\*)|(\*\/)/g;
  private readonly sqlTautologyPattern = /\b(\d+\s*=\s*\d+|'[^']*'\s*=\s*'[^']*'|[^\s=]+\s*=\s*[^\s=]+)/gi;

  /**
   * Decode HTML entities, including double-encoded entities (e.g. `&amp;lt;` -> `<`).
   */
  private decodeHtmlEntities(input: string): string {
    let decoded = input;

    // Decode up to two passes to handle double-encoding.
    for (let pass = 0; pass < 2; pass++) {
      const before = decoded;
      decoded = decoded
        .replace(/&amp;lt;/gi, "<")
        .replace(/&amp;gt;/gi, ">")
        .replace(/&amp;quot;/gi, '"')
        .replace(/&amp;#x27;/gi, "'")
        .replace(/&amp;apos;/gi, "'")
        .replace(/&amp;amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#x27;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/&#x003B;/gi, ";")
        .replace(/&#x002D;/gi, "-")
        .replace(/&#x2F;/gi, "/")
        .replace(/&#39;/gi, "'")
        .replace(/&#47;/gi, "/")
        .replace(/&#60;/gi, "<")
        .replace(/&#62;/gi, ">")
        .replace(/&#34;/gi, '"')
        .replace(/&#38;/gi, "&");

      if (decoded === before) {
        break;
      }
    }

    return decoded;
  }

  /**
   * Strip dangerous SQL keywords, comment delimiters, and tautology patterns.
   */
  sanitizeSqlInjection(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    let sanitized = this.decodeHtmlEntities(input);

    // Remove SQL comment delimiters (--,#, /* */)
    sanitized = sanitized.replace(this.sqlCommentPattern, " ");

    // Remove dangerous SQL keywords
    sanitized = sanitized.replace(this.sqlKeywordPattern, " ");

    // Neutralize tautology patterns (1(1), 'or'='or', etc.)
    sanitized = sanitized.replace(this.sqlTautologyPattern, " ");

    // Collapse repeated whitespace introduced by removal
    sanitized = sanitized.replace(/\s+/g, " ");

    return sanitized.trim();
  }

  sanitizeHtml(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    // Decode any double-encoded entities before sanitizing so attackers cannot
    // bypass the filters by double encoding.
    let sanitized = this.decodeHtmlEntities(input);

    // Remove script tags and their content
    sanitized = sanitized.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "");

    // Remove event handlers
    sanitized = sanitized.replace(/on\w+\s*=\s*["'][^"']*["']/gi, "");
    sanitized = sanitized.replace(/on\w+\s*=\s*[^\s>]+/gi, "");

    // Remove javascript: and data: URIs
    sanitized = sanitized.replace(/javascript\s*:/gi, "");
    sanitized = sanitized.replace(/data\s*:\s*text\/html/gi, "");

    // Remove iframe, object, embed tags
    sanitized = sanitized.replace(/<(iframe|object|embed)[\s\S]*?>[\s\S]*?<\/\1>/gi, "");

    // Remove form tags
    sanitized = sanitized.replace(/<form[\s\S]*?>[\s\S]*?<\/form>/gi, "");

    // Encode HTML special characters
    sanitized = sanitized
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;")
      .replace(/\//g, "&#x2F;");

    return sanitized.trim();
  }

  sanitizeMarkdown(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    let sanitized = input;

    // Remove HTML tags first
    sanitized = this.sanitizeHtml(sanitized);

    // Remove markdown image syntax (potential XSS via URLs)
    sanitized = sanitized.replace(/!\[([^\]]*)\]\(([^)]+)\)/gi, "[IMAGE_REMOVED]");

    // Remove markdown link syntax with javascript: URLs
    sanitized = sanitized.replace(/\[([^\]]+)\]\(javascript:[^)]+\)/gi, "[LINK_REMOVED]");

    // Remove raw HTML entities that could be used for XSS
    sanitized = sanitized.replace(/&[a-zA-Z0-9#]+;/g, "");

    return sanitized.trim();
  }

  sanitizeFilter(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    // Decode HTML entities first to normalize double-encoded payloads.
    const decoded = this.decodeHtmlEntities(input);

    // Strip SQL injection patterns.
    return this.sanitizeSqlInjection(decoded);
  }

  sanitizeMetadata(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    let sanitized = input;

    // Remove control characters
    sanitized = sanitized.replace(/[\x00-\x1F\x7F]/g, "");

    // Limit length
    const maxLength = 1000;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }

    // Remove potential injection patterns
    sanitized = sanitized.replace(/\$\{.*?\}/g, "");
    sanitized = sanitized.replace(/<%.*?%>/g, "");

    return sanitized.trim();
  }

  validateContentType(contentType: string | undefined): void {
    if (!contentType) return;

    const allowedTypes = [
      "text/plain",
      "text/markdown",
      "application/json",
      "application/javascript",
    ];

    const baseType = contentType.split(";")[0].trim().toLowerCase();
    if (!allowedTypes.includes(baseType) && !baseType.startsWith("text/")) {
      throw new BadRequestException(`Content type ${contentType} is not allowed`);
    }
  }
}

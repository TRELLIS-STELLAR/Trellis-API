import { Injectable, BadRequestException, Logger } from "@nestjs/common";

@Injectable()
export class ContentSanitizerService {
  private readonly logger = new Logger(ContentSanitizerService.name);

  sanitizeHtml(input: string): string {
    if (!input || typeof input !== "string") {
      return "";
    }

    let sanitized = input;

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

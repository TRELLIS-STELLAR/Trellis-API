import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import * as url from "url";

@Injectable()
export class UrlValidatorService {
  private readonly logger = new Logger(UrlValidatorService.name);
  private readonly allowedProtocols = new Set(["https", "http"]);
  private readonly blockedHosts = new Set([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "169.254.169.254",
    "metadata.google.internal",
  ]);

  validateUrl(input: string, allowRelative = false): string {
    if (!input || typeof input !== "string") {
      throw new BadRequestException("URL is required");
    }

    let parsed: url.UrlWithParsedQuery;
    try {
      parsed = url.parse(input, true) as url.UrlWithParsedQuery;
    } catch {
      throw new BadRequestException("Invalid URL format");
    }

    if (!parsed.protocol) {
      if (allowRelative && input.startsWith("/")) {
        return input;
      }
      throw new BadRequestException("URL must include a protocol");
    }

    const protocol = parsed.protocol.replace(":", "");
    if (!this.allowedProtocols.has(protocol)) {
      throw new BadRequestException(`Protocol ${protocol} is not allowed. Only https and http are permitted.`);
    }

    if (parsed.hostname && this.blockedHosts.has(parsed.hostname)) {
      throw new BadRequestException("URL points to a blocked internal host");
    }

    if (parsed.hostname && parsed.hostname.includes(":")) {
      // Block URLs with explicit ports to prevent SSRF to internal services
      if (!this.isAllowedPort(parsed.port)) {
        throw new BadRequestException("URL includes a blocked port");
      }
    }

    return input;
  }

  sanitizeUrl(input: string): string {
    try {
      const validated = this.validateUrl(input);
      const parsed = url.parse(validated, true) as url.UrlWithParsedQuery;
      const sanitized = url.format({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port,
        pathname: parsed.pathname,
        query: parsed.query,
      });
      return sanitized;
    } catch {
      return "";
    }
  }

  isExternalUrl(input: string): boolean {
    try {
      const parsed = url.parse(input, true) as url.UrlWithParsedQuery;
      return !!parsed.protocol && !!parsed.hostname;
    } catch {
      return false;
    }
  }

  private isAllowedPort(port: string | undefined): boolean {
    if (!port) return true;
    const allowedPorts = new Set(["80", "443", "8080", "3000", "3001"]);
    return allowedPorts.has(port);
  }
}

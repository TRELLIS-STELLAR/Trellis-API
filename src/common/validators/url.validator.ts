import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import * as url from "url";
import * as dns from "dns";
import * as net from "net";

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
    "instance-data",
  ]);

  async validateUrl(input: string, allowRelative = false): Promise<string> {
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

    const rawHostname = parsed.hostname;
    if (!rawHostname) {
      throw new BadRequestException("URL must include a valid hostname");
    }

    // Strip IPv6 brackets if present (e.g. [::1])
    const hostname = rawHostname.startsWith("[") && rawHostname.endsWith("]")
      ? rawHostname.slice(1, -1)
      : rawHostname.toLowerCase();

    // Check against blocked hosts set
    if (this.blockedHosts.has(hostname)) {
      throw new BadRequestException("URL points to a blocked internal host");
    }

    // Block typical internal / local domain suffixes
    if (
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".lan") ||
      hostname.endsWith(".home.arpa")
    ) {
      throw new BadRequestException("URL points to a blocked internal host");
    }

    if (parsed.port && !this.isAllowedPort(parsed.port)) {
      throw new BadRequestException("URL includes a blocked port");
    }

    // If hostname is directly an IP address (IPv4 or IPv6), check it
    if (this.isIpAddress(hostname)) {
      if (this.isPrivateOrReservedIp(hostname)) {
        throw new BadRequestException("URL points to a private, loopback, or reserved IP address");
      }
      return input;
    }

    // Resolve DNS records for domain names
    await this.validateDnsResolution(hostname);

    return input;
  }

  async sanitizeUrl(input: string): Promise<string> {
    try {
      const validated = await this.validateUrl(input);
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

  protected async resolveHostname(hostname: string): Promise<{ address: string; family: number }[]> {
    try {
      const records = await dns.promises.lookup(hostname, { all: true });
      return records;
    } catch (error: any) {
      this.logger.warn(`Failed to resolve DNS for hostname ${hostname}: ${error?.message || error}`);
      throw new BadRequestException(`Unable to resolve domain: ${hostname}`);
    }
  }

  private async validateDnsResolution(hostname: string): Promise<void> {
    const addresses = await this.resolveHostname(hostname);
    if (!addresses || addresses.length === 0) {
      throw new BadRequestException(`Unable to resolve domain: ${hostname}`);
    }

    for (const record of addresses) {
      if (this.isPrivateOrReservedIp(record.address)) {
        throw new BadRequestException("URL resolves to a private, loopback, or reserved IP address");
      }
    }
  }

  private isAllowedPort(port: string | undefined): boolean {
    if (!port) return true;
    const allowedPorts = new Set(["80", "443", "8080", "3000", "3001"]);
    return allowedPorts.has(port);
  }

  isIpAddress(host: string): boolean {
    return net.isIP(host) !== 0;
  }

  isPrivateOrReservedIp(ip: string): boolean {
    const family = net.isIP(ip);
    if (family === 4) {
      return this.isPrivateOrReservedIpv4(ip);
    } else if (family === 6) {
      return this.isPrivateOrReservedIpv6(ip);
    }
    return false;
  }

  isPrivateOrReservedIpv4(ip: string): boolean {
    const num = this.parseIpv4ToNumber(ip);
    if (num === null) {
      return true;
    }

    // 0.0.0.0/8 (Current network)
    if (this.matchesIpv4Cidr(num, "0.0.0.0", 8)) return true;

    // 10.0.0.0/8 (RFC 1918 Private)
    if (this.matchesIpv4Cidr(num, "10.0.0.0", 8)) return true;

    // 100.64.0.0/10 (Carrier-grade NAT / RFC 6598)
    if (this.matchesIpv4Cidr(num, "100.64.0.0", 10)) return true;

    // 127.0.0.0/8 (Loopback)
    if (this.matchesIpv4Cidr(num, "127.0.0.0", 8)) return true;

    // 169.254.0.0/16 (Link-Local & Cloud Metadata e.g. 169.254.169.254)
    if (this.matchesIpv4Cidr(num, "169.254.0.0", 16)) return true;

    // 172.16.0.0/12 (RFC 1918 Private: 172.16.0.0 - 172.31.255.255)
    if (this.matchesIpv4Cidr(num, "172.16.0.0", 12)) return true;

    // 192.0.0.0/24 (IETF Protocol Assignments)
    if (this.matchesIpv4Cidr(num, "192.0.0.0", 24)) return true;

    // 192.0.2.0/24 (TEST-NET-1)
    if (this.matchesIpv4Cidr(num, "192.0.2.0", 24)) return true;

    // 192.88.99.0/24 (6to4 Relay Anycast)
    if (this.matchesIpv4Cidr(num, "192.88.99.0", 24)) return true;

    // 192.168.0.0/16 (RFC 1918 Private)
    if (this.matchesIpv4Cidr(num, "192.168.0.0", 16)) return true;

    // 198.18.0.0/15 (Network Benchmark Testing)
    if (this.matchesIpv4Cidr(num, "198.18.0.0", 15)) return true;

    // 198.51.100.0/24 (TEST-NET-2)
    if (this.matchesIpv4Cidr(num, "198.51.100.0", 24)) return true;

    // 203.0.113.0/24 (TEST-NET-3)
    if (this.matchesIpv4Cidr(num, "203.0.113.0", 24)) return true;

    // 224.0.0.0/4 (Multicast: 224.0.0.0 - 239.255.255.255)
    if ((num >>> 28) === 14) return true;

    // 240.0.0.0/4 (Reserved for future use: 240.0.0.0 - 255.255.255.254)
    if ((num >>> 28) === 15) return true;

    // 255.255.255.255 (Broadcast)
    if (num === 0xffffffff) return true;

    return false;
  }

  isPrivateOrReservedIpv6(ip: string): boolean {
    const normalized = ip.toLowerCase();

    // Check loopback and unspecified
    if (normalized === "::1" || normalized === "::") {
      return true;
    }

    // IPv4-mapped IPv6 addresses, e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1
    const ipv4MappedMatch = normalized.match(/^(?:0*:)*ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/);
    if (ipv4MappedMatch) {
      return this.isPrivateOrReservedIpv4(ipv4MappedMatch[1]);
    }

    const words = this.parseIpv6ToWords(normalized);
    if (!words) {
      return true;
    }

    // Check if IPv4-mapped represented in hex, e.g. ::ffff:7f00:0001
    const isMappedHex =
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0xffff;

    if (isMappedHex) {
      const mappedNum = ((words[6] << 16) | words[7]) >>> 0;
      const mappedIp = [
        (mappedNum >>> 24) & 255,
        (mappedNum >>> 16) & 255,
        (mappedNum >>> 8) & 255,
        mappedNum & 255,
      ].join(".");
      return this.isPrivateOrReservedIpv4(mappedIp);
    }

    // fc00::/7 (Unique Local Address - ULA, private RFC 4193)
    if ((words[0] & 0xfe00) === 0xfc00) {
      return true;
    }

    // fe80::/10 (Link-Local Unicast RFC 4291)
    if ((words[0] & 0xffc0) === 0xfe80) {
      return true;
    }

    // ff00::/8 (Multicast)
    if ((words[0] & 0xff00) === 0xff00) {
      return true;
    }

    // 2001:db8::/32 (Documentation)
    if (words[0] === 0x2001 && words[1] === 0x0db8) {
      return true;
    }

    // 100::/64 (Discard-only)
    if (words[0] === 0x0100 && words[1] === 0 && words[2] === 0 && words[3] === 0) {
      return true;
    }

    // Loopback ::1 check via words
    if (
      words[0] === 0 &&
      words[1] === 0 &&
      words[2] === 0 &&
      words[3] === 0 &&
      words[4] === 0 &&
      words[5] === 0 &&
      words[6] === 0 &&
      (words[7] === 1 || words[7] === 0)
    ) {
      return true;
    }

    return false;
  }

  private parseIpv4ToNumber(ip: string): number | null {
    const parts = ip.split(".");
    if (parts.length !== 4) return null;
    let num = 0;
    for (let i = 0; i < 4; i++) {
      const part = parts[i];
      if (!/^\d+$/.test(part)) return null;
      const n = Number(part);
      if (n < 0 || n > 255) return null;
      if (part.length > 1 && part.startsWith("0")) return null;
      num = (num << 8) | n;
    }
    return num >>> 0;
  }

  private matchesIpv4Cidr(ipNum: number, cidrBaseStr: string, prefixLen: number): boolean {
    const base = this.parseIpv4ToNumber(cidrBaseStr);
    if (base === null) return false;
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return (ipNum & mask) === (base & mask);
  }

  private parseIpv6ToWords(ip: string): number[] | null {
    let formatted = ip;
    const lastColon = formatted.lastIndexOf(":");
    if (lastColon !== -1) {
      const afterLastColon = formatted.slice(lastColon + 1);
      if (afterLastColon.includes(".")) {
        const ipv4Parts = afterLastColon.split(".");
        if (ipv4Parts.length === 4) {
          const num = this.parseIpv4ToNumber(afterLastColon);
          if (num === null) return null;
          const high = ((num >>> 16) & 0xffff).toString(16);
          const low = (num & 0xffff).toString(16);
          formatted = `${formatted.slice(0, lastColon)}:${high}:${low}`;
        }
      }
    }

    const doubleColonCount = (formatted.match(/::/g) || []).length;
    if (doubleColonCount > 1) return null;

    let parts: string[];
    if (doubleColonCount === 1) {
      const [left, right] = formatted.split("::");
      const leftParts = left ? left.split(":") : [];
      const rightParts = right ? right.split(":") : [];
      const missing = 8 - (leftParts.length + rightParts.length);
      if (missing < 0) return null;
      const zeros = new Array(missing).fill("0");
      parts = [...leftParts, ...zeros, ...rightParts];
    } else {
      parts = formatted.split(":");
    }

    if (parts.length !== 8) return null;

    const words: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
      words.push(parseInt(part, 16));
    }
    return words;
  }
}

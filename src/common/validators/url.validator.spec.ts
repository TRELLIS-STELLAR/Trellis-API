import { Test, TestingModule } from "@nestjs/testing";
import { UrlValidatorService } from "../validators/url.validator";
import { BadRequestException } from "@nestjs/common";
import * as dns from "dns";

describe("UrlValidatorService", () => {
  let service: UrlValidatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UrlValidatorService],
    }).compile();

    service = module.get<UrlValidatorService>(UrlValidatorService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("validateUrl", () => {
    it("should accept valid HTTPS URLs with public resolved IP", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "93.184.215.14", family: 4 },
      ] as any);

      const result = await service.validateUrl("https://example.com/path");
      expect(result).toBe("https://example.com/path");
    });

    it("should accept valid HTTP URLs with public resolved IP", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "93.184.215.14", family: 4 },
      ] as any);

      const result = await service.validateUrl("http://example.com/path");
      expect(result).toBe("http://example.com/path");
    });

    it("should reject javascript: protocol", async () => {
      await expect(service.validateUrl("javascript:alert(1)")).rejects.toThrow(BadRequestException);
    });

    it("should reject data: protocol", async () => {
      await expect(service.validateUrl("data:text/html,<script>alert(1)</script>")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject file protocol", async () => {
      await expect(service.validateUrl("file:///etc/passwd")).rejects.toThrow(BadRequestException);
    });

    it("should allow relative URLs when allowRelative is true", async () => {
      const result = await service.validateUrl("/api/v1/users", true);
      expect(result).toBe("/api/v1/users");
    });

    it("should reject relative URLs when allowRelative is false", async () => {
      await expect(service.validateUrl("/api/v1/users")).rejects.toThrow(BadRequestException);
    });

    it("should throw for empty string", async () => {
      await expect(service.validateUrl("")).rejects.toThrow(BadRequestException);
    });

    it("should throw for null/undefined", async () => {
      await expect(service.validateUrl(null as any)).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl(undefined as any)).rejects.toThrow(BadRequestException);
    });

    it("should reject malformed URLs", async () => {
      await expect(service.validateUrl("ht tp://example.com")).rejects.toThrow(BadRequestException);
    });

    it("should reject blocked internal hosts and loopback IPs", async () => {
      await expect(service.validateUrl("http://localhost/admin")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://127.0.0.1/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://127.0.1.1/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://0.0.0.0/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject RFC 1918 private IPv4 subnets", async () => {
      // 10.0.0.0/8
      await expect(service.validateUrl("http://10.0.0.1/status")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://10.255.255.255/status")).rejects.toThrow(
        BadRequestException,
      );

      // 172.16.0.0/12
      await expect(service.validateUrl("http://172.16.0.1/metrics")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://172.31.255.255/metrics")).rejects.toThrow(
        BadRequestException,
      );

      // 192.168.0.0/16
      await expect(service.validateUrl("http://192.168.1.1/router")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://192.168.254.254/api")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject link-local and CGNAT IPv4 subnets", async () => {
      // 169.254.0.0/16
      await expect(service.validateUrl("http://169.254.1.1/")).rejects.toThrow(BadRequestException);
      // 100.64.0.0/10
      await expect(service.validateUrl("http://100.64.0.1/")).rejects.toThrow(BadRequestException);
    });

    it("should reject IPv6 loopback, link-local, and ULA addresses", async () => {
      // Loopback ::1
      await expect(service.validateUrl("http://[::1]/")).rejects.toThrow(BadRequestException);
      // Unspecified ::
      await expect(service.validateUrl("http://[::]/")).rejects.toThrow(BadRequestException);
      // Link-local fe80::/10
      await expect(service.validateUrl("http://[fe80::1]/")).rejects.toThrow(BadRequestException);
      // Unique Local Address fc00::/7
      await expect(service.validateUrl("http://[fc00::1]/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://[fd12:3456:789a::1]/")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject IPv4-mapped IPv6 addresses pointing to internal IPs", async () => {
      // Dotted decimal mapped
      await expect(service.validateUrl("http://[::ffff:127.0.0.1]/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://[::ffff:169.254.169.254]/")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validateUrl("http://[::ffff:10.0.0.1]/")).rejects.toThrow(BadRequestException);
      // Hex mapped (::ffff:7f00:1 == 127.0.0.1)
      await expect(service.validateUrl("http://[::ffff:7f00:1]/")).rejects.toThrow(BadRequestException);
    });

    it("should reject domains with internal suffixes", async () => {
      await expect(service.validateUrl("http://service.internal/api")).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.validateUrl("http://app.local/status")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://database.lan/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://dev.localhost/")).rejects.toThrow(BadRequestException);
    });

    it("should resolve domain DNS and reject hostnames resolving to private IPs", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "10.0.0.5", family: 4 },
      ] as any);

      await expect(service.validateUrl("http://internal-host.com/service")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should resolve domain DNS and reject hostnames resolving to cloud metadata IP", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "169.254.169.254", family: 4 },
      ] as any);

      await expect(service.validateUrl("http://metadata-proxy.com/latest/meta-data")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should resolve domain DNS and reject hostnames resolving to loopback", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "127.0.0.1", family: 4 },
      ] as any);

      await expect(service.validateUrl("http://spoofed-domain.com/secret")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject domains where any resolved address is in a private range (dual-homed DNS rebinding)", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "93.184.215.14", family: 4 },
        { address: "192.168.1.100", family: 4 },
      ] as any);

      await expect(service.validateUrl("http://rebinding.evil.com/")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject URLs when DNS resolution fails", async () => {
      jest.spyOn(dns.promises, "lookup").mockRejectedValueOnce(new Error("ENOTFOUND"));

      await expect(service.validateUrl("http://non-existent-domain.xyz/")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("should reject URLs with blocked explicit ports", async () => {
      await expect(service.validateUrl("http://example.com:22/")).rejects.toThrow(BadRequestException);
      await expect(service.validateUrl("http://example.com:6379/")).rejects.toThrow(BadRequestException);
    });
  });

  describe("sanitizeUrl", () => {
    it("should return empty string for invalid URLs", async () => {
      const result = await service.sanitizeUrl("javascript:alert(1)");
      expect(result).toBe("");
    });

    it("should return empty string for internal URLs", async () => {
      const result = await service.sanitizeUrl("http://127.0.0.1/admin");
      expect(result).toBe("");
    });

    it("should return sanitized URL for valid input", async () => {
      jest.spyOn(dns.promises, "lookup").mockResolvedValueOnce([
        { address: "93.184.215.14", family: 4 },
      ] as any);

      const result = await service.sanitizeUrl("https://example.com/path?foo=bar");
      expect(result).toBe("https://example.com/path?foo=bar");
    });
  });

  describe("isExternalUrl", () => {
    it("should return true for absolute URLs", () => {
      expect(service.isExternalUrl("https://example.com")).toBe(true);
      expect(service.isExternalUrl("http://example.com")).toBe(true);
    });

    it("should return false for relative URLs", () => {
      expect(service.isExternalUrl("/api/v1")).toBe(false);
      expect(service.isExternalUrl("api/v1")).toBe(false);
    });

    it("should return false for invalid URLs", () => {
      expect(service.isExternalUrl("not-a-url")).toBe(false);
    });
  });
});

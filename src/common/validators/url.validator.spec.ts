import { Test, TestingModule } from "@nestjs/testing";
import { UrlValidatorService } from "../validators/url.validator";
import { BadRequestException } from "@nestjs/common";

describe("UrlValidatorService", () => {
  let service: UrlValidatorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [UrlValidatorService],
    }).compile();

    service = module.get<UrlValidatorService>(UrlValidatorService);
  });

  describe("validateUrl", () => {
    it("should accept valid HTTPS URLs", () => {
      const result = service.validateUrl("https://example.com/path");
      expect(result).toBe("https://example.com/path");
    });

    it("should accept valid HTTP URLs", () => {
      const result = service.validateUrl("http://example.com/path");
      expect(result).toBe("http://example.com/path");
    });

    it("should reject javascript: protocol", () => {
      expect(() => service.validateUrl("javascript:alert(1)")).toThrow(BadRequestException);
    });

    it("should reject data: protocol", () => {
      expect(() => service.validateUrl("data:text/html,<script>alert(1)</script>")).toThrow(BadRequestException);
    });

    it("should reject blocked internal hosts", () => {
      expect(() => service.validateUrl("http://localhost/admin")).toThrow(BadRequestException);
      expect(() => service.validateUrl("http://127.0.0.1/")).toThrow(BadRequestException);
      expect(() => service.validateUrl("http://169.254.169.254/latest/meta-data/")).toThrow(BadRequestException);
    });

    it("should reject file protocol", () => {
      expect(() => service.validateUrl("file:///etc/passwd")).toThrow(BadRequestException);
    });

    it("should allow relative URLs when allowRelative is true", () => {
      const result = service.validateUrl("/api/v1/users", true);
      expect(result).toBe("/api/v1/users");
    });

    it("should reject relative URLs when allowRelative is false", () => {
      expect(() => service.validateUrl("/api/v1/users")).toThrow(BadRequestException);
    });

    it("should throw for empty string", () => {
      expect(() => service.validateUrl("")).toThrow(BadRequestException);
    });

    it("should throw for null/undefined", () => {
      expect(() => service.validateUrl(null as any)).toThrow(BadRequestException);
      expect(() => service.validateUrl(undefined as any)).toThrow(BadRequestException);
    });

    it("should reject malformed URLs", () => {
      expect(() => service.validateUrl("ht tp://example.com")).toThrow(BadRequestException);
    });
  });

  describe("sanitizeUrl", () => {
    it("should return empty string for invalid URLs", () => {
      const result = service.sanitizeUrl("javascript:alert(1)");
      expect(result).toBe("");
    });

    it("should return sanitized URL for valid input", () => {
      const result = service.sanitizeUrl("https://example.com/path?foo=bar");
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

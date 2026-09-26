import { Test, TestingModule } from "@nestjs/testing";
import { ContentSanitizerService } from "../sanitizers/content.sanitizer";
import { BadRequestException } from "@nestjs/common";

describe("ContentSanitizerService", () => {
  let service: ContentSanitizerService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ContentSanitizerService],
    }).compile();

    service = module.get<ContentSanitizerService>(ContentSanitizerService);
  });

  describe("sanitizeHtml", () => {
    it("should remove script tags", () => {
      const input = '<p>Hello</p><script>alert("xss")</script>';
      const result = service.sanitizeHtml(input);
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("alert");
    });

    it("should remove event handlers", () => {
      const input = '<div onclick="alert(1)">Hello</div>';
      const result = service.sanitizeHtml(input);
      expect(result).not.toContain("onclick");
    });

    it("should remove iframe tags", () => {
      const input = '<iframe src="evil.com"></iframe>';
      const result = service.sanitizeHtml(input);
      expect(result).not.toContain("<iframe");
    });

    it("should encode HTML special characters", () => {
      const input = '<div class="test">Hello & World</div>';
      const result = service.sanitizeHtml(input);
      expect(result).toContain("&lt;");
      expect(result).toContain("&gt;");
      expect(result).toContain("&amp;");
    });

    it("should handle empty input", () => {
      expect(service.sanitizeHtml("")).toBe("");
      expect(service.sanitizeHtml(null as any)).toBe("");
    });
  });

  describe("sanitizeMarkdown", () => {
    it("should remove HTML from markdown", () => {
      const input = "# Hello\n<script>alert(1)</script>";
      const result = service.sanitizeMarkdown(input);
      expect(result).not.toContain("<script>");
    });

    it("should remove image syntax", () => {
      const input = "![alt](https://example.com/image.jpg)";
      const result = service.sanitizeMarkdown(input);
      expect(result).toContain("[IMAGE_REMOVED]");
    });

    it("should remove links with javascript: URLs", () => {
      const input = "[click](javascript:alert(1))";
      const result = service.sanitizeMarkdown(input);
      expect(result).toContain("[LINK_REMOVED]");
    });

    it("should preserve safe markdown", () => {
      const input = "# Hello\n\nThis is **bold** text.";
      const result = service.sanitizeMarkdown(input);
      expect(result).toContain("Hello");
      expect(result).toContain("bold");
    });
  });

  describe("sanitizeMetadata", () => {
    it("should remove control characters", () => {
      const input = "Hello\x00World\x1F";
      const result = service.sanitizeMetadata(input);
      expect(result).not.toContain("\x00");
      expect(result).not.toContain("\x1F");
    });

    it("should limit length", () => {
      const input = "a".repeat(2000);
      const result = service.sanitizeMetadata(input);
      expect(result.length).toBeLessThanOrEqual(1000);
    });

    it("should remove template injection patterns", () => {
      const input = 'Hello ${username} <% print(x) %>';
      const result = service.sanitizeMetadata(input);
      expect(result).not.toContain("${");
      expect(result).not.toContain("<%");
    });
  });

  describe("validateContentType", () => {
    it("should accept allowed content types", () => {
      expect(() => service.validateContentType("text/plain")).not.toThrow();
      expect(() => service.validateContentType("text/markdown")).not.toThrow();
      expect(() => service.validateContentType("application/json")).not.toThrow();
    });

    it("should reject disallowed content types", () => {
      expect(() => service.validateContentType("text/html")).toThrow(BadRequestException);
      expect(() => service.validateContentType("application/xml")).toThrow(BadRequestException);
    });

    it("should not throw for undefined", () => {
      expect(() => service.validateContentType(undefined)).not.toThrow();
    });
  });
});

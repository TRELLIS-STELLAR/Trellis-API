import { Test, TestingModule } from "@nestjs/testing";
import { ContentSanitizerService } from "./content.sanitizer";
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

    it("should decode double-encoded HTML entities before sanitizing", () => {
      const input = "&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;";
      const result = service.sanitizeHtml(input);
      expect(result).not.toContain("script");
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

  describe("sanitizeFilter", () => {
    it("should strip UNION SELECT injection patterns", () => {
      const input = "name UNION SELECT username, password FROM users";
      const result = service.sanitizeFilter(input);
      expect(result.toUpperCase()).not.toContain("UNION");
      expect(result.toUpperCase()).not.toContain("SELECT");
      expect(result).toContain("name");
    });

    it("should strip SQL comment delimiters", () => {
      const input = "admin'--";
      const result = service.sanitizeFilter(input);
      expect(result).not.toContain("--");
    });

    it("should neutralize tautology patterns", () => {
      const input = "admin or 1=1";
      const result = service.sanitizeFilter(input);
      expect(result).not.toContain("1=1");
    });

    it("should strip OWASP SQL injection test strings", () => {
      const vectors = [
        "' or '1'='1",
        "' or 1=1--",
        "' or '1'='1'--",
        "' UNION SELECT NULL--",
        "' UNION SELECT username, password FROM users--",
        "1; DROP TABLE users",
        "'; EXEC xp_cmshell 'dir \\\\'",
        "1' AND SLEEP(5)--",
        "admin'--",
        "' OR 'a'='a",
      ];

      for (const vector of vectors) {
        const result = service.sanitizeFilter(vector);
        const upper = result.toUpperCase();
        expect(upper).not.toContain("UNION");
        expect(upper).not.toContain("SELECT");
        expect(upper).not.toContain("DROP");
        expect(upper).not.toContain("XP_CMSHELL");
        expect(upper).not.toContain("SLEEP");
        expect(result).not.toContain("--");
        expect(result).not.toContain("='");
      }
    });

    it("should decode double-encoded HTML entities before sanitizing", () => {
      const input = "&amp;lt;script&amp;gat;alert(1)&amp;lt;/script&amp;gt;";
      const result = service.sanitizeFilter(input);
      expect(result).not.toContain("script");
    });

    it("should preserve legitimate search text", () => {
      const input = "red shoes for running";
      const result = service.sanitizeFilter(input);
      expect(result).toBeTruthy();
      expect(result).toContain("red");
      expect(result).toContain("shoes");
      expect(result).toContain("running");
    });

    it("should handle empty input", () => {
      expect(service.sanitizeFilter("")).toBe("");
      expect(service.sanitizeFilter(null as any)).toBe("");
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

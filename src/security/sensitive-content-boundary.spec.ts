import { SensitiveContentBoundaryService } from "./sensitive-content-boundary.service";
import { ForbiddenException, BadRequestException } from "@nestjs/common";
import * as crypto from "crypto";

describe("SensitiveContentBoundaryService (#241 Sensitive-Content Boundary Tests)", () => {
  let service: SensitiveContentBoundaryService;

  beforeEach(() => {
    service = new SensitiveContentBoundaryService();
  });

  // =========================================================================
  // 1. RENDERING BOUNDARY TESTS
  // =========================================================================
  describe("Rendering Boundary", () => {
    it("escapes raw HTML tags to prevent XSS in text rendering mode", () => {
      const malicious = `<script>alert("XSS")</script><img src="x" onerror="evil()" />`;
      const result = service.sanitizeRenderedContent(malicious, { allowSafeHtml: false });

      expect(result).not.toContain("<script>");
      expect(result).not.toContain("<img");
      expect(result).toContain("&lt;script&gt;");
      expect(result).toContain("&lt;img");
    });

    it("strips script tags, onerror handlers, and javascript: links in rich-text mode", () => {
      const htmlPayload = `
        <p>Hello <b>World</b></p>
        <script>stealTokens();</script>
        <a href="javascript:doSomethingBad()">Click Here</a>
        <img src="valid.png" onerror="alert(document.cookie)" />
      `;

      const result = service.sanitizeRenderedContent(htmlPayload, { allowSafeHtml: true });

      expect(result).toContain("<p>Hello <b>World</b></p>");
      expect(result).not.toContain("<script>");
      expect(result).not.toContain("stealTokens()");
      expect(result).not.toContain("onerror=");
      expect(result).not.toContain("javascript:");
      expect(result).toContain('href="#"');
    });

    it("neutralizes nested tag bypass attempts such as <<script>script>", () => {
      const nestedAttack = `<<script>script>alert(1)<</script>/script>`;
      const result = service.sanitizeRenderedContent(nestedAttack, { allowSafeHtml: true });

      expect(result).not.toContain("<script");
      expect(result).not.toContain("</script");
    });
  });

  // =========================================================================
  // 2. DOWNLOAD BOUNDARY TESTS
  // =========================================================================
  describe("Download Boundary", () => {
    const defaultUser = {
      userId: "user-123",
      tenantId: "tenant-alpha",
      roles: ["OPERATOR"],
    };

    const defaultAcl = {
      ownerId: "user-123",
      tenantId: "tenant-alpha",
      allowedRoles: ["OPERATOR", "ADMIN"],
    };

    it("allows download when user matches owner and tenant", () => {
      const file = {
        filename: "monthly_statement_2026.pdf",
        mimeType: "application/pdf",
        size: 1024,
      };

      const result = service.enforceDownloadBoundary(file, defaultUser, defaultAcl);

      expect(result.safeFilename).toBe("monthly_statement_2026.pdf");
      expect(result.headers["Content-Disposition"]).toContain("attachment; filename=");
      expect(result.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(result.headers["Cache-Control"]).toBe("no-store, no-cache, must-revalidate, private");
    });

    it("rejects cross-tenant download requests with ForbiddenException", () => {
      const crossTenantUser = {
        userId: "user-attacker",
        tenantId: "tenant-beta",
        roles: ["ADMIN"],
      };
      const file = { filename: "secret.pdf", mimeType: "application/pdf", size: 500 };

      expect(() =>
        service.enforceDownloadBoundary(file, crossTenantUser, defaultAcl),
      ).toThrow(ForbiddenException);
    });

    it("rejects non-owner users lacking required roles", () => {
      const unauthorizedUser = {
        userId: "user-456",
        tenantId: "tenant-alpha",
        roles: ["GUEST"],
      };
      const file = { filename: "restricted.pdf", mimeType: "application/pdf", size: 500 };

      expect(() =>
        service.enforceDownloadBoundary(file, unauthorizedUser, defaultAcl),
      ).toThrow(ForbiddenException);
    });

    it("sanitizes filename against path traversal and CRLF header injection", () => {
      const dangerousFile = {
        filename: "../../etc/passwd\r\nSet-Cookie: pwned=true",
        mimeType: "text/plain",
        size: 200,
      };

      const result = service.enforceDownloadBoundary(dangerousFile, defaultUser, defaultAcl);

      expect(result.safeFilename).not.toContain("..");
      expect(result.safeFilename).not.toContain("/");
      expect(result.safeFilename).not.toContain("\r");
      expect(result.safeFilename).not.toContain("\n");
      expect(result.headers["Content-Disposition"]).toBe(
        `attachment; filename="${result.safeFilename}"`,
      );
    });
  });

  // =========================================================================
  // 3. WEBHOOK BOUNDARY TESTS
  // =========================================================================
  describe("Webhook Boundary", () => {
    const signingKey = "test-webhook-secret-key-123456";

    it("blocks SSRF loopback, internal IPs, and AWS metadata IP", () => {
      const forbiddenUrls = [
        "http://localhost:8080/hook",
        "http://127.0.0.1:3000/callback",
        "http://169.254.169.254/latest/meta-data/",
        "http://10.0.1.5/internal/receiver",
        "http://192.168.1.100/admin",
        "http://172.20.0.5/api",
      ];

      for (const url of forbiddenUrls) {
        expect(() =>
          service.validateWebhookBoundary(url, { event: "ping" }, signingKey),
        ).toThrow(ForbiddenException);
      }
    });

    it("strips sensitive credentials, tokens, and private keys from webhook payloads", () => {
      const payload = {
        event: "PAYMENT_PROCESSED",
        transactionId: "tx-789",
        accountNumber: "acc-100",
        password: "SuperSecretPassword123",
        privateKey: "S-TELLAR-SECRET-SEED-XYZ",
        nested: {
          accessToken: "jwt-token-value",
          salt: "random-salt",
          safeData: "visible-content",
        },
      };

      const result = service.validateWebhookBoundary(
        "https://api.external-partner.com/webhooks",
        payload,
        signingKey,
      );

      expect(result.sanitizedPayload.password).toBeUndefined();
      expect(result.sanitizedPayload.privateKey).toBeUndefined();
      expect(result.sanitizedPayload.nested.accessToken).toBeUndefined();
      expect(result.sanitizedPayload.nested.salt).toBeUndefined();
      expect(result.sanitizedPayload.nested.safeData).toBe("visible-content");
      expect(result.sanitizedPayload.event).toBe("PAYMENT_PROCESSED");
    });

    it("generates a valid verifiable HMAC-SHA256 signature header", () => {
      const payload = { event: "TRANSFER", amount: "500.00" };
      const result = service.validateWebhookBoundary(
        "https://webhook.site/test",
        payload,
        signingKey,
      );

      expect(result.signatureHeader).toMatch(/^sha256=[a-f0-9]{64}$/);

      // Verify signature manually
      const expectedHash = crypto
        .createHmac("sha256", signingKey)
        .update(JSON.stringify(result.sanitizedPayload))
        .digest("hex");

      expect(result.signatureHeader).toBe(`sha256=${expectedHash}`);
    });
  });

  // =========================================================================
  // 4. EXPORT BOUNDARY TESTS (CSV, JSON, PII MASKING)
  // =========================================================================
  describe("Export Boundary", () => {
    it("escapes CSV formula injection triggers (=, +, -, @, tab) with leading single quote", () => {
      const rows = [
        { name: "=cmd|'/C calc'!A0", role: "Manager" },
        { name: "+2+5", role: "Lead" },
        { name: "@SUM(1,2)", role: "Analyst" },
        { name: "-10", role: "Dev" },
      ];

      const csv = service.formatSafeCsv(["name", "role"], rows);

      expect(csv).toContain("'=cmd|'/C calc'!A0");
      expect(csv).toContain("'+2+5");
      expect(csv).toContain("'@SUM(1,2)");
      expect(csv).toContain("'-10");
    });

    it("masks PII emails and SSNs and strips password/token fields", () => {
      const rawRow = {
        id: "cust-1",
        email: "alice.smith@trellis.com",
        taxId: "123-45-6789",
        passwordHash: "bcrypt-hash-xyz",
        token: "bearer-token-123",
        balance: 1500.5,
      };

      const sanitized = service.sanitizeExportRow(rawRow, { maskPii: true });

      expect(sanitized.passwordHash).toBeUndefined();
      expect(sanitized.token).toBeUndefined();
      expect(sanitized.email).toBe("a***@t***.com");
      expect(sanitized.taxId).toBe("***-**-6789");
      expect(sanitized.balance).toBe(1500.5);
    });

    it("formats standard compliant CSV with properly escaped commas and quotes", () => {
      const rows = [
        { id: "1", note: 'Hello, "world"' },
        { id: "2", note: "Simple text" },
      ];

      const csv = service.formatSafeCsv(["id", "note"], rows);

      expect(csv).toContain('"Hello, ""world"""');
      expect(csv).toContain("Simple text");
    });
  });
});

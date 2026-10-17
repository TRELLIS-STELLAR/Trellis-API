import { PrivacyPreserverService } from "./privacy-preserver.service";

describe("PrivacyPreserverService", () => {
  let service: PrivacyPreserverService;

  beforeEach(() => {
    service = new PrivacyPreserverService();
  });

  describe("scrubText", () => {
    it("redacts Stellar secret seeds, bearer tokens, JWTs, and email addresses", () => {
      const stellarSecret = "SCV3Z6W7D5K7V6H4B2F5M6P7Q2R3T4U5V2W3X4Y5Z6A7B2C3D4E5F2GA";
      const sampleJwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozsmw_p5ptcqeH";
      const input = `Alert: user support@trellis.finance failed with secret ${stellarSecret} and header Bearer ${sampleJwt}`;

      const { scrubbed, matchCount } = service.scrubText(input);

      expect(scrubbed).not.toContain(stellarSecret);
      expect(scrubbed).not.toContain("support@trellis.finance");
      expect(scrubbed).not.toContain(sampleJwt);
      expect(scrubbed).toContain("[REDACTED_STELLAR_SECRET]");
      expect(scrubbed).toContain("Bearer [REDACTED_TOKEN]");
      expect(scrubbed).toContain("[email]");
      expect(matchCount).toBeGreaterThanOrEqual(3);
    });

    it("preserves Stellar public addresses and 64-character transaction hashes", () => {
      const pubKey = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
      const txHash = "d3f28b7e9a014c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
      const input = `Confirmed tx ${txHash} for account ${pubKey}`;

      const { scrubbed } = service.scrubText(input);

      expect(scrubbed).toContain(pubKey);
      expect(scrubbed).toContain(txHash);
    });
  });

  describe("maskIpAddress", () => {
    it("masks IPv4 subnet and generates keyed ipHash", () => {
      const { masked, ipHash } = service.maskIpAddress("198.51.100.42");
      expect(masked).toBe("198.51.xxx.xxx");
      expect(ipHash).toMatch(/^ip_[a-f0-9]{16}$/);
    });

    it("masks IPv6 prefix", () => {
      const { masked, ipHash } = service.maskIpAddress("2001:db8:85a3:0000:0000:8a2e:370:7334");
      expect(masked).toBe("2001:db8:85a3:xxxx:xxxx:xxxx");
      expect(ipHash).toMatch(/^ip_[a-f0-9]{16}$/);
    });
  });

  describe("classifyUserAgent", () => {
    it("normalizes client types without device details", () => {
      expect(service.classifyUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("mobile-browser");
      expect(service.classifyUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0")).toBe("desktop-browser");
      expect(service.classifyUserAgent("curl/7.88.1")).toBe("api-client");
      expect(service.classifyUserAgent("Googlebot/2.1")).toBe("automated-bot");
    });
  });

  describe("sanitizePayload", () => {
    it("deeply scrubs sensitive dictionary keys", () => {
      const payload = {
        userId: "u-100",
        apiKey: "live_sec_998877",
        nested: {
          password: "my-super-secret",
          balance: "100.5000000",
        },
      };

      const result = service.sanitizePayload(payload);
      expect(result.sanitized).toEqual({
        userId: "u-100",
        apiKey: "[REDACTED]",
        nested: {
          password: "[REDACTED]",
          balance: "100.5000000",
        },
      });
      expect(result.redactedPaths).toContain("apiKey");
      expect(result.redactedPaths).toContain("nested.password");
    });
  });
});

import helmet from "helmet";
import { IncomingMessage, ServerResponse } from "http";
import { createHelmetConfig } from "./helmet.config";

describe("Helmet Security Headers (#174)", () => {
  it("should configure strict CSP, X-Frame-Options: DENY, and HSTS preload", () => {
    const config = createHelmetConfig();

    expect(config.contentSecurityPolicy).toBeDefined();
    const csp = config.contentSecurityPolicy as any;
    expect(csp.directives.scriptSrc).toEqual(["'self'"]);
    expect(csp.directives.styleSrc).toEqual(["'self'"]);
    expect(csp.directives.frameAncestors).toEqual(["'none'"]);

    expect(config.xFrameOptions).toEqual({ action: "deny" });

    expect(config.hsts).toEqual({
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
  });

  it("should set strict security headers on HTTP responses", (done) => {
    const helmetMiddleware = (helmet as any).default || helmet;
    const middleware = helmetMiddleware(createHelmetConfig());

    const headers: Record<string, string> = {};
    const req = {
      headers: {},
    } as unknown as IncomingMessage;

    const res = {
      setHeader: (name: string, value: string) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
      removeHeader: (name: string) => {
        delete headers[name.toLowerCase()];
      },
    } as unknown as ServerResponse;

    middleware(req, res, (err?: any) => {
      expect(err).toBeUndefined();

      // Content-Security-Policy checks
      const cspHeader = headers["content-security-policy"];
      expect(cspHeader).toBeDefined();
      expect(cspHeader).toContain("script-src 'self'");
      expect(cspHeader).toContain("style-src 'self'");
      expect(cspHeader).toContain("frame-ancestors 'none'");
      expect(cspHeader).not.toContain("'unsafe-inline'");

      // X-Frame-Options check
      expect(headers["x-frame-options"]).toBe("DENY");

      // Strict-Transport-Security check
      expect(headers["strict-transport-security"]).toBe(
        "max-age=31536000; includeSubDomains; preload",
      );

      done();
    });
  });
});

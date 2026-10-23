import { HelmetOptions } from "helmet";

export function createHelmetConfig(): HelmetOptions {
  return {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        workerSrc: ["'self'", "blob:"],
        frameSrc: ["'none'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    xFrameOptions: {
      action: "deny",
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  };
}

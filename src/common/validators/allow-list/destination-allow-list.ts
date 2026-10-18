import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as dns from "dns";
import * as net from "net";
import { UrlValidatorService } from "../url.validator";

/**
 * Strict allow-list validation for outbound destinations (#279).
 *
 * The existing `UrlValidatorService` is a deny-list: anything not known to be
 * internal is accepted, plain HTTP is allowed and several development ports are
 * open. Outbound requests to caller-supplied URLs (webhooks today) need the
 * inverse: a destination is accepted only if every property is explicitly
 * allowed.
 *
 *   protocol    — `https` only (`http` only when explicitly enabled)
 *   credentials — never (`https://user:pass@host` is rejected)
 *   port        — an explicit allow-list (default 443 / 80 when http is allowed)
 *   host        — when an allow-list is configured, an exact host or a
 *                 `*.domain` wildcard (label-boundary match); IP literals are
 *                 rejected unless explicitly allowed
 *   address     — every DNS answer must be public (no loopback, RFC 1918,
 *                 link-local / cloud metadata, CGNAT, multicast, ...)
 *
 * Violations carry a stable `code` and a `retryable` flag: policy violations
 * are permanent, a DNS lookup failure is transient. Delivery code uses this to
 * decide between retrying later and dead-lettering immediately.
 */

export type DestinationViolationCode =
  | "DESTINATION_INVALID"
  | "DESTINATION_TOO_LONG"
  | "DESTINATION_PROTOCOL_NOT_ALLOWED"
  | "DESTINATION_CREDENTIALS_NOT_ALLOWED"
  | "DESTINATION_PORT_NOT_ALLOWED"
  | "DESTINATION_IP_LITERAL_NOT_ALLOWED"
  | "DESTINATION_HOST_NOT_ALLOWED"
  | "DESTINATION_PRIVATE_ADDRESS"
  | "DESTINATION_DNS_FAILED";

export class DestinationNotAllowedError extends BadRequestException {
  constructor(
    public readonly code: DestinationViolationCode,
    message: string,
    /** True when the same destination may pass later (e.g. DNS hiccup). */
    public readonly retryable = false,
  ) {
    super({ statusCode: 400, error: "Bad Request", code, message });
    this.name = "DestinationNotAllowedError";
  }
}

export interface DestinationPolicy {
  /** Allowed URL schemes, lowercase, without `:`. */
  protocols: string[];
  /** Allowed ports. The scheme's default port counts when none is given. */
  ports: number[];
  /**
   * Allowed hosts: `example.com` (exact) or `*.example.com` (any subdomain,
   * not the apex). Empty means any *public* host.
   */
  hosts: string[];
  /** Accept IP-literal hosts (still subject to the public-address check). */
  allowIpLiterals: boolean;
  /** Resolve the host and require every address to be public. */
  resolveDns: boolean;
  maxLength: number;
}

export interface ValidatedDestination {
  /** Normalized URL (WHATWG serialization, no fragment). */
  url: string;
  hostname: string;
  port: number;
  /** Addresses the host resolved to at validation time (empty when not resolved). */
  addresses: string[];
}

const DEFAULT_PORT: Record<string, number> = { https: 443, http: 80 };

/** Suffixes that only ever name internal infrastructure. */
const INTERNAL_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".intranet",
  ".corp",
];
const INTERNAL_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "instance-data",
  "metadata",
]);

function splitList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function readBool(value: unknown): boolean | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * Policy for webhook destinations, from environment:
 * - `WEBHOOK_DESTINATION_ALLOWED_HOSTS` — comma-separated hosts / `*.domain`
 * - `WEBHOOK_DESTINATION_ALLOWED_PORTS` — comma-separated (default `443`)
 * - `WEBHOOK_DESTINATION_ALLOW_HTTP`    — `true` to also allow `http` (port 80)
 */
export function webhookDestinationPolicy(
  get: (key: string) => unknown = (key) => process.env[key],
): DestinationPolicy {
  const allowHttp = readBool(get("WEBHOOK_DESTINATION_ALLOW_HTTP")) ?? false;
  const configuredPorts = splitList(get("WEBHOOK_DESTINATION_ALLOWED_PORTS"))
    .map((p) => Number(p))
    .filter((p) => Number.isInteger(p) && p > 0 && p < 65536);
  return {
    protocols: allowHttp ? ["https", "http"] : ["https"],
    ports:
      configuredPorts.length > 0
        ? configuredPorts
        : allowHttp
          ? [443, 80]
          : [443],
    hosts: splitList(get("WEBHOOK_DESTINATION_ALLOWED_HOSTS")),
    allowIpLiterals: false,
    resolveDns: true,
    maxLength: 2048,
  };
}

/** `*.example.com` matches `a.example.com` and `a.b.example.com`, never `example.com` or `badexample.com`. */
export function hostMatchesPattern(hostname: string, pattern: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const p = pattern.toLowerCase().replace(/\.$/, "");
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return host.length > suffix.length && host.endsWith(suffix);
  }
  return host === p;
}

@Injectable()
export class DestinationAllowListService {
  private readonly logger = new Logger(DestinationAllowListService.name);
  private readonly ipClassifier = new UrlValidatorService();
  readonly webhookPolicy: DestinationPolicy;

  constructor(@Optional() configService?: ConfigService) {
    this.webhookPolicy = webhookDestinationPolicy(
      (key) => configService?.get(key) ?? process.env[key],
    );
  }

  /** Validates `input` against `policy` (the webhook policy by default). */
  async validate(
    input: string,
    policy: DestinationPolicy = this.webhookPolicy,
  ): Promise<ValidatedDestination> {
    if (typeof input !== "string" || input.trim() === "") {
      throw new DestinationNotAllowedError(
        "DESTINATION_INVALID",
        "Destination URL is required",
      );
    }
    if (input.length > policy.maxLength) {
      throw new DestinationNotAllowedError(
        "DESTINATION_TOO_LONG",
        `Destination URL exceeds ${policy.maxLength} characters`,
      );
    }

    let parsed: URL;
    try {
      // WHATWG parsing normalizes hostnames (case, IDN, and integer/hex/octal
      // IPv4 spellings such as http://2130706433/ → 127.0.0.1).
      parsed = new URL(input.trim());
    } catch {
      throw new DestinationNotAllowedError(
        "DESTINATION_INVALID",
        "Destination is not a valid absolute URL",
      );
    }

    const protocol = parsed.protocol.replace(/:$/, "").toLowerCase();
    if (!policy.protocols.includes(protocol)) {
      throw new DestinationNotAllowedError(
        "DESTINATION_PROTOCOL_NOT_ALLOWED",
        `Scheme '${protocol}' is not allowed; use ${policy.protocols.join(" or ")}`,
      );
    }

    if (parsed.username || parsed.password) {
      throw new DestinationNotAllowedError(
        "DESTINATION_CREDENTIALS_NOT_ALLOWED",
        "Destination URLs must not embed credentials",
      );
    }

    const port = parsed.port ? Number(parsed.port) : DEFAULT_PORT[protocol];
    if (!policy.ports.includes(port)) {
      throw new DestinationNotAllowedError(
        "DESTINATION_PORT_NOT_ALLOWED",
        `Port ${port} is not allowed; allowed: ${policy.ports.join(", ")}`,
      );
    }

    const hostname = parsed.hostname
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "")
      .toLowerCase();
    if (!hostname) {
      throw new DestinationNotAllowedError(
        "DESTINATION_INVALID",
        "Destination must include a host",
      );
    }

    const isIp = net.isIP(hostname) !== 0;
    if (isIp) {
      if (!policy.allowIpLiterals) {
        throw new DestinationNotAllowedError(
          "DESTINATION_IP_LITERAL_NOT_ALLOWED",
          "Destinations must use a hostname, not an IP address",
        );
      }
      if (this.ipClassifier.isPrivateOrReservedIp(hostname)) {
        throw new DestinationNotAllowedError(
          "DESTINATION_PRIVATE_ADDRESS",
          "Destination is a private, loopback or reserved address",
        );
      }
    } else {
      if (
        INTERNAL_HOSTS.has(hostname) ||
        INTERNAL_SUFFIXES.some((s) => hostname.endsWith(s))
      ) {
        throw new DestinationNotAllowedError(
          "DESTINATION_HOST_NOT_ALLOWED",
          "Destination is an internal host",
        );
      }
      if (!hostname.includes(".")) {
        throw new DestinationNotAllowedError(
          "DESTINATION_HOST_NOT_ALLOWED",
          "Destination must be a fully qualified domain name",
        );
      }
    }

    if (
      policy.hosts.length > 0 &&
      !policy.hosts.some((p) => hostMatchesPattern(hostname, p))
    ) {
      throw new DestinationNotAllowedError(
        "DESTINATION_HOST_NOT_ALLOWED",
        `Host '${hostname}' is not on the destination allow-list`,
      );
    }

    let addresses: string[] = [];
    if (!isIp && policy.resolveDns) {
      addresses = await this.resolve(hostname);
      const blocked = addresses.find((address) =>
        this.ipClassifier.isPrivateOrReservedIp(address),
      );
      if (blocked) {
        throw new DestinationNotAllowedError(
          "DESTINATION_PRIVATE_ADDRESS",
          `Host '${hostname}' resolves to a private, loopback or reserved address`,
        );
      }
    }

    parsed.hash = "";
    return { url: parsed.toString(), hostname, port, addresses };
  }

  /** DNS seam for tests. A failed lookup is transient, so it is retryable. */
  protected async resolve(hostname: string): Promise<string[]> {
    try {
      const records = await dns.promises.lookup(hostname, {
        all: true,
        verbatim: true,
      });
      if (records.length === 0) throw new Error("no records");
      return records.map((r) => r.address);
    } catch (error) {
      this.logger.warn(
        `destination DNS lookup failed for ${hostname}: ${(error as Error)?.message ?? error}`,
      );
      throw new DestinationNotAllowedError(
        "DESTINATION_DNS_FAILED",
        `Unable to resolve '${hostname}'`,
        true,
      );
    }
  }
}

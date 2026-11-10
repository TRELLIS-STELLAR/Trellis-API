import {
  CanActivate,
  ExecutionContext,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { CapabilityTokenService } from "./capability-token.service";
import { CapabilityConstraintValue } from "./capability-token.types";
import {
  REQUIRE_CAPABILITY_METADATA_KEY,
  RequireCapabilityMetadata,
} from "./require-capability.decorator";

export const CAPABILITY_TOKEN_HEADER = "x-capability-token";
export const IDEMPOTENCY_KEY_HEADER = "x-idempotency-key";

@Injectable()
export class CapabilityTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly capabilityTokenService: CapabilityTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<RequireCapabilityMetadata | undefined>(
      REQUIRE_CAPABILITY_METADATA_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!metadata) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const token = this.extractCapabilityToken(request);
    const expectedSubject = this.extractActorId(request);
    const resourceId = this.extractResourceId(request, metadata);
    const idempotencyKey = this.extractIdempotencyKey(request);
    const operationParams = this.extractOperationParams(request, metadata);

    const verification = await this.capabilityTokenService.verifyOrThrow(token, {
      expectedSubject,
      requiredAction: metadata.action,
      resourceType: metadata.resourceType,
      resourceId,
      operationParams,
      consume: metadata.consume ?? true,
      idempotencyKey,
    });

    request.capabilityClaims = verification.claims;
    request.capabilityVerification = verification;
    return true;
  }

  private extractCapabilityToken(request: any): string | undefined {
    const headers = request?.headers ?? {};
    const direct =
      headers[CAPABILITY_TOKEN_HEADER] ??
      headers[CAPABILITY_TOKEN_HEADER.toUpperCase()];

    if (typeof direct === "string" && direct.trim()) {
      return direct.trim();
    }

    const authHeader = headers.authorization ?? headers.Authorization;
    if (typeof authHeader === "string") {
      const match = /^Capability\s+(.+)$/i.exec(authHeader.trim());
      if (match?.[1]) {
        return match[1].trim();
      }
    }

    return undefined;
  }

  private extractActorId(request: any): string | undefined {
    const user = request?.user;
    if (!user) return undefined;
    const candidate = user.id ?? user.sub ?? user.userId;
    return typeof candidate === "string" && candidate.trim()
      ? candidate.trim()
      : undefined;
  }

  private extractResourceId(
    request: any,
    metadata: RequireCapabilityMetadata,
  ): string | undefined {
    if (metadata.resourceIdParam && request?.params?.[metadata.resourceIdParam] !== undefined) {
      return String(request.params[metadata.resourceIdParam]);
    }
    if (
      metadata.resourceIdBodyField &&
      request?.body &&
      request.body[metadata.resourceIdBodyField] !== undefined
    ) {
      return String(request.body[metadata.resourceIdBodyField]);
    }
    if (metadata.resourceIdHeader && request?.headers) {
      const headerVal =
        request.headers[metadata.resourceIdHeader.toLowerCase()] ??
        request.headers[metadata.resourceIdHeader];
      if (typeof headerVal === "string" && headerVal.trim()) {
        return headerVal.trim();
      }
    }
    return undefined;
  }

  private extractIdempotencyKey(request: any): string | undefined {
    const headers = request?.headers ?? {};
    const raw =
      headers[IDEMPOTENCY_KEY_HEADER] ??
      headers["idempotency-key"] ??
      request?.body?.idempotencyKey;
    return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
  }

  private extractOperationParams(
    request: any,
    metadata: RequireCapabilityMetadata,
  ): Record<string, CapabilityConstraintValue> | undefined {
    const body = request?.body;
    if (!body || typeof body !== "object") {
      return undefined;
    }

    const fields = metadata.constraintBodyFields;
    const params: Record<string, CapabilityConstraintValue> = {};

    const keys = fields && fields.length > 0 ? fields : Object.keys(body);
    for (const key of keys) {
      const value = body[key];
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        params[key] = value;
      }
    }

    return Object.keys(params).length > 0 ? params : undefined;
  }
}

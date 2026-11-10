import {
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SensitiveAction } from "../../../infrastructure/audit/sensitive-actions/sensitive-action.enum";
import { CapabilityTokenGuard } from "./capability-token.guard";
import { CapabilityTokenService } from "./capability-token.service";
import { RequireCapabilityMetadata } from "./require-capability.decorator";

describe("CapabilityTokenGuard (issue #273)", () => {
  function createSetup(metadata?: RequireCapabilityMetadata) {
    const service = new CapabilityTokenService(undefined, undefined, {
      activeKeyId: "k1",
      keys: { k1: "guard-test-secret" },
    });
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(metadata),
    } as unknown as Reflector;
    const guard = new CapabilityTokenGuard(reflector, service);
    return { service, guard };
  }

  function makeContext(request: Record<string, any>): ExecutionContext {
    return {
      getHandler: () => ({}),
      getClass: () => ({}),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  }

  it("allows routes without @RequireCapability metadata", async () => {
    const { guard } = createSetup(undefined);
    const ctx = makeContext({ headers: {} });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it("validates x-capability-token header, route param resourceId, and body constraints", async () => {
    const { service, guard } = createSetup({
      action: SensitiveAction.WITHDRAWAL_APPROVED,
      resourceType: "withdrawal",
      resourceIdParam: "id",
      constraintBodyFields: ["amount", "asset"],
    });

    const issued = service.issueToken({
      subject: "actor-42",
      scope: {
        action: SensitiveAction.WITHDRAWAL_APPROVED,
        resourceType: "withdrawal",
        resourceId: "wd-42",
        constraints: {
          maxAmount: 500,
          asset: "XLM",
        },
      },
    });

    const request: Record<string, any> = {
      user: { id: "actor-42" },
      params: { id: "wd-42" },
      headers: {
        "x-capability-token": issued.token,
        "x-idempotency-key": "idem-42",
      },
      body: {
        amount: 250,
        asset: "XLM",
      },
    };

    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.capabilityClaims?.jti).toBe(issued.jti);

    // Retry with same idempotency key succeeds without throwing ConflictException
    await expect(guard.canActivate(makeContext(request))).resolves.toBe(true);
    expect(request.capabilityVerification?.idempotentReplay).toBe(true);

    // Replay with a different idempotency key throws ConflictException
    const replayRequest = {
      ...request,
      headers: {
        "x-capability-token": issued.token,
        "x-idempotency-key": "idem-99",
      },
    };
    await expect(guard.canActivate(makeContext(replayRequest))).rejects.toThrow(
      ConflictException,
    );
  });

  it("supports Authorization: Capability <token> header and rejects mismatched scope", async () => {
    const { service, guard } = createSetup({
      action: SensitiveAction.PORTFOLIO_RECORD_CHANGED,
      resourceType: "portfolio",
      resourceIdBodyField: "portfolioId",
    });

    const issued = service.issueToken({
      subject: "actor-7",
      scope: {
        action: SensitiveAction.PORTFOLIO_RECORD_CHANGED,
        resourceType: "portfolio",
        resourceId: "pf-1",
      },
    });

    const forbiddenReq = {
      user: { id: "actor-7" },
      headers: {
        authorization: `Capability ${issued.token}`,
      },
      body: {
        portfolioId: "pf-other",
      },
    };

    await expect(guard.canActivate(makeContext(forbiddenReq))).rejects.toThrow(
      ForbiddenException,
    );

    await expect(
      guard.canActivate(makeContext({ user: { id: "actor-7" }, headers: {} })),
    ).rejects.toThrow(UnauthorizedException);
  });
});

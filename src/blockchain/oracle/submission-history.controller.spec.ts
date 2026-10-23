import {
  BadGatewayException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PermissionsGuard } from "src/common/guard/permissions.guard";
import { Role } from "src/common/guard/roles.enum";
import { SubmissionHistoryController } from "./submission-history.controller";
import { OracleVerificationError } from "./services/stellar-oracle.adapter";

describe("SubmissionHistoryController", () => {
  const guard = new PermissionsGuard(new Reflector());
  const allowed = (handler: keyof SubmissionHistoryController, role: Role) => {
    const context: any = {
      getHandler: () => SubmissionHistoryController.prototype[handler],
      getClass: () => SubmissionHistoryController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: "u", role } }) }),
    };
    try {
      return guard.canActivate(context);
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  };

  it.each([
    ["recordBatch", Role.SERVICE_ACTOR, true],
    ["recordBatch", Role.OPERATOR, false],
    ["ledgerState", Role.OPERATOR, true],
    ["ledgerState", Role.USER, false],
    ["verifierStatus", Role.OPERATOR, true],
    ["verifierStatus", Role.USER, false],
    ["startVerifier", Role.MAINTAINER, true],
    ["startVerifier", Role.OPERATOR, false],
    ["startVerifier", Role.SERVICE_ACTOR, false],
  ] as const)("authorizes %s for %s: %s", (handler, role, expected) => {
    expect(allowed(handler, role)).toBe(expected);
  });

  describe("ledgerState", () => {
    const adapter = { getOracleLedgerState: jest.fn() };
    const controller = new SubmissionHistoryController(
      {} as any,
      adapter as any,
      {} as any,
    );

    it.each([
      [
        new OracleVerificationError("RPC_UNAVAILABLE", "x", true),
        ServiceUnavailableException,
      ],
      [
        new OracleVerificationError("NOT_CONFIGURED", "x"),
        ServiceUnavailableException,
      ],
      [new OracleVerificationError("RPC_ERROR", "x"), BadGatewayException],
    ])("maps %s to an HTTP error", async (error, expected) => {
      adapter.getOracleLedgerState.mockRejectedValue(error);
      await expect(controller.ledgerState()).rejects.toBeInstanceOf(expected);
    });
  });
});

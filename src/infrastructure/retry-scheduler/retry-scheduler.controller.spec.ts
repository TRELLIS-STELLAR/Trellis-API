import { ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "src/common/guard/roles.guard";
import { Role } from "src/common/guard/roles.enum";
import { RetrySchedulerController } from "./retry-scheduler.controller";

describe("RetrySchedulerController dead-letter tooling", () => {
  const guard = new RolesGuard(new Reflector());
  const allowed = (handler: keyof RetrySchedulerController, role: Role) => {
    const context: any = {
      getHandler: () => RetrySchedulerController.prototype[handler],
      getClass: () => RetrySchedulerController,
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
    ["getDeadLetters", Role.MAINTAINER, true],
    ["getDeadLetters", Role.OPERATOR, false],
    ["retryDeadLetter", Role.ADMIN, true],
    ["retryDeadLetter", Role.MAINTAINER, false],
    ["retryDeadLetters", Role.ADMIN, true],
    ["retryDeadLetters", Role.MAINTAINER, false],
  ] as const)("authorizes %s for %s: %s", (handler, role, expected) => {
    expect(allowed(handler, role)).toBe(expected);
  });

  it("passes the operator, reason and force flag to the service", async () => {
    const service = { retryDeadLetter: jest.fn().mockResolvedValue({}) };
    const controller = new RetrySchedulerController(service as any);
    await controller.retryDeadLetter(
      "op-1",
      { maxAttempts: 2, reason: "fixed", force: true },
      { user: { id: "admin-1" } },
    );
    expect(service.retryDeadLetter).toHaveBeenCalledWith("op-1", 2, {
      actor: "admin-1",
      reason: "fixed",
      force: true,
    });
  });
});

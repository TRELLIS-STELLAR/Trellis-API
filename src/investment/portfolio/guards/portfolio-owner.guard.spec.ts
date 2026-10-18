import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { PortfolioOwnerGuard } from "./portfolio-owner.guard";

function makeContext(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("PortfolioOwnerGuard", () => {
  const portfolio = { id: "portfolio-1", userId: "user-1" };
  let findOne: jest.Mock;
  let guard: PortfolioOwnerGuard;

  beforeEach(() => {
    findOne = jest.fn().mockResolvedValue(portfolio);
    guard = new PortfolioOwnerGuard({ findOne } as any);
  });

  it("allows the persisted owner", async () => {
    await expect(
      guard.canActivate(
        makeContext({
          user: { id: "user-1" },
          params: { id: "portfolio-1" },
        }),
      ),
    ).resolves.toBe(true);

    expect(findOne).toHaveBeenCalledWith({
      where: { id: "portfolio-1" },
      select: ["id", "userId"],
    });
  });

  it("denies a different user from accessing the portfolio", async () => {
    await expect(
      guard.canActivate(
        makeContext({
          user: { id: "user-2" },
          params: { id: "portfolio-1" },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects requests missing the authenticated user or portfolio ID", async () => {
    await expect(
      guard.canActivate(makeContext({ params: { id: "portfolio-1" } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(
        makeContext({ user: { id: "user-1" }, params: {} }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("returns not found when the requested portfolio does not exist", async () => {
    findOne.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        makeContext({
          user: { id: "user-1" },
          params: { portfolioId: "missing-portfolio" },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

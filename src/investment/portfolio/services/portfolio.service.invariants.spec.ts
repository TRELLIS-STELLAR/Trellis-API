import { GUARDS_METADATA } from "@nestjs/common/constants";
import { UnprocessableEntityException } from "@nestjs/common";
import { PortfolioService } from "./portfolio.service";
import { PortfolioController } from "../portfolio.controller";
import { PortfolioOwnerGuard } from "../guards/portfolio-owner.guard";

describe("PortfolioService balance and ownership transitions", () => {
  let service: PortfolioService;
  let portfolios: any;
  let assets: any;
  let portfolio: any;
  let holding: any;

  beforeEach(() => {
    holding = { id: "h1", portfolioId: "p1", ticker: "XLM", quantity: 10 };
    portfolio = {
      id: "p1",
      userId: "owner-1",
      name: "Main",
      status: "active",
      assets: [holding],
    };
    portfolios = {
      findOne: jest.fn(async () => portfolio),
      save: jest.fn(async (value) => value),
    };
    assets = {
      findOne: jest.fn(async () => ({ ...holding })),
      find: jest.fn(async () => [holding]),
      save: jest.fn(async (value) => value),
    };
    service = new PortfolioService(
      portfolios,
      assets,
      {} as any,
      {} as any,
      {} as any,
      {
        evaluatePortfolio: () => ({
          valid: true,
          violations: [],
          warnings: [],
        }),
      } as any,
      { recordVerification: jest.fn() } as any,
      { recordSensitiveAction: jest.fn() } as any,
    );
  });

  it("applies a valid holding quantity change", async () => {
    const updated = await service.updateHolding("p1", "h1", { quantity: 4 });
    expect(updated.quantity).toBe(4);
  });

  it("rejects a holding quantity that would go negative and saves nothing", async () => {
    const error = await service
      .updateHolding("p1", "h1", { quantity: -1 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect(error.getResponse()).toMatchObject({
      invariantCode: "NEGATIVE_BALANCE",
    });
    expect(assets.save).not.toHaveBeenCalled();
  });

  it("blocks an update that would reassign portfolio ownership", async () => {
    const error = await service
      .updatePortfolio("p1", { userId: "attacker" } as any)
      .catch((e) => e);
    expect(error.getResponse()).toMatchObject({
      invariantCode: "OWNERSHIP_REASSIGNMENT_BLOCKED",
    });
    expect(portfolios.save).not.toHaveBeenCalled();
  });

  it("keeps ownership on an ordinary update", async () => {
    const saved = await service.updatePortfolio("p1", { name: "Renamed" });
    expect(saved).toMatchObject({ userId: "owner-1", name: "Renamed" });
  });

  it.each(["updatePortfolio", "updateHolding"] as const)(
    "guards %s with the portfolio owner check",
    (handler) => {
      expect(
        Reflect.getMetadata(
          GUARDS_METADATA,
          PortfolioController.prototype[handler],
        ),
      ).toContain(PortfolioOwnerGuard);
    },
  );
});

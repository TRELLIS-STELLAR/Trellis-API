import {
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { MLPredictionService } from "./ml-prediction.service";

describe("MLPredictionService portfolio weights", () => {
  const portfolioRepository = { findOne: jest.fn() };
  const service = new MLPredictionService(
    {} as any,
    portfolioRepository as any,
  );
  const data = new Map([
    ["AAA", { price: 10, historicalPrices: [8, 9, 10] }],
    ["BBB", { price: 20, historicalPrices: [18, 19, 20] }],
  ]);

  beforeEach(() => {
    jest.clearAllMocks();
    jest
      .spyOn(service, "predictAssetReturns")
      .mockImplementation(async (ticker) => ({
        predictedReturn: ticker === "AAA" ? 0.2 : -0.1,
        confidence: 1,
        predictions: [],
      }));
  });

  function setValues(a: number | null, b: number | null) {
    portfolioRepository.findOne.mockResolvedValue({
      assets: [
        { ticker: "AAA", value: a },
        { ticker: "BBB", value: b },
      ],
    });
  }

  it("changes the prediction with the actual value distribution", async () => {
    setValues(75, 25);
    const first = await service.predictPortfolioReturns("portfolio", data);
    setValues(25, 75);
    const second = await service.predictPortfolioReturns("portfolio", data);
    expect(first.portfolioExpectedReturn).toBeCloseTo(0.125);
    expect(second.portfolioExpectedReturn).toBeCloseTo(-0.025);
    expect(portfolioRepository.findOne).toHaveBeenCalledWith({
      where: { id: "portfolio" },
      relations: { assets: true },
    });
  });

  it("supports a zero-value asset and a single asset", async () => {
    setValues(100, 0);
    expect(
      (await service.predictPortfolioReturns("portfolio", data))
        .portfolioExpectedReturn,
    ).toBeCloseTo(0.2);
    portfolioRepository.findOne.mockResolvedValue({
      assets: [{ ticker: "AAA", value: 100 }],
    });
    expect(
      (
        await service.predictPortfolioReturns(
          "portfolio",
          new Map([["AAA", data.get("AAA")!]]),
        )
      ).portfolioExpectedReturn,
    ).toBeCloseTo(0.2);
  });

  it("fails explicitly when the portfolio or weights are unavailable", async () => {
    portfolioRepository.findOne.mockResolvedValue(null);
    await expect(
      service.predictPortfolioReturns("missing", data),
    ).rejects.toThrow(NotFoundException);
    portfolioRepository.findOne.mockResolvedValue({ assets: [] });
    await expect(
      service.predictPortfolioReturns("empty", data),
    ).rejects.toThrow(UnprocessableEntityException);
    setValues(0, 0);
    await expect(service.predictPortfolioReturns("zero", data)).rejects.toThrow(
      "total asset value is zero",
    );
    setValues(null, 100);
    await expect(
      service.predictPortfolioReturns("unknown", data),
    ).rejects.toThrow("Unavailable or ambiguous weight");
  });
});

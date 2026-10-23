import { PortfolioAsset } from "../investment/portfolio/entities/portfolio-asset.entity";
import {
  AssetSearchService,
  ASSET_SEARCH_CANDIDATE_WINDOW,
} from "./asset-search.service";
import {
  MAX_ASSET_SEARCH_LIMIT,
  AssetSearchQueryDto,
} from "./dto/asset-search-query.dto";

type QueryBuilder = {
  take: jest.Mock;
  getMany: jest.Mock;
  getRawAndEntities: jest.Mock;
  where: jest.Mock;
  andWhere: jest.Mock;
  innerJoin: jest.Mock;
  addSelect: jest.Mock;
  setParameters: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
};

const makeBuilder = (rows: PortfolioAsset[]) => {
  let rowLimit = 0;
  let rowsRead = 0;
  const builder: QueryBuilder = {
    take: jest.fn((limit: number) => {
      rowLimit = limit;
      return builder;
    }),
    getMany: jest.fn(async () => {
      const page = rows.slice(0, rowLimit);
      rowsRead = page.length;
      return page;
    }),
    getRawAndEntities: jest.fn(async () => ({
      entities: rows.slice(0, rowLimit),
      raw: [],
    })),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    setParameters: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
  };
  return { builder, rowsRead: () => rowsRead };
};

const assets = (count: number, ticker: (index: number) => string, name: string) =>
  Array.from(
    { length: count },
    (_, index) =>
      ({
        id: `asset-${index}`,
        ticker: ticker(index),
        name,
        chain: "stellar",
        type: "cryptocurrency",
        portfolioId: "portfolio-high-cardinality",
      }) as PortfolioAsset,
  );

describe("AssetSearchService resource budgets", () => {
  it("bounds a full-page search for a user with 10,000 matching assets", async () => {
    const highCardinalityRows = assets(10_000, (index) => `TOKEN${index}`, "Token");
    const structured = makeBuilder(highCardinalityRows);
    const repository = {
      createQueryBuilder: jest.fn().mockReturnValue(structured.builder),
      query: jest.fn(),
    };
    const service = new AssetSearchService(repository as any);

    const response = await service.search(
      { q: "token", limit: 10_000, exactOnly: true } as AssetSearchQueryDto,
      "high-cardinality-user",
    );

    expect(structured.builder.take).toHaveBeenCalledWith(MAX_ASSET_SEARCH_LIMIT);
    expect(structured.rowsRead()).toBe(MAX_ASSET_SEARCH_LIMIT);
    expect(response.results).toHaveLength(MAX_ASSET_SEARCH_LIMIT);
    expect(repository.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(repository.query).not.toHaveBeenCalled();
  });

  it("caps in-process typo ranking at 250 rows before returning a 50-result page", async () => {
    const structured = makeBuilder([]);
    const candidates = assets(5_000, (index) => `S${index}`, "Stellar");
    const fallback = makeBuilder(candidates);
    const repository = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(structured.builder)
        .mockReturnValueOnce(fallback.builder),
      query: jest.fn().mockRejectedValue(
        Object.assign(new Error("extensions unavailable"), { code: "42501" }),
      ),
    };
    const service = new AssetSearchService(repository as any);

    const response = await service.search(
      { q: "stelar", limit: 500 } as AssetSearchQueryDto,
      "high-cardinality-user",
    );

    expect(structured.builder.take).toHaveBeenCalledWith(
      MAX_ASSET_SEARCH_LIMIT,
    );
    expect(fallback.builder.take).toHaveBeenCalledWith(
      ASSET_SEARCH_CANDIDATE_WINDOW,
    );
    expect(fallback.rowsRead()).toBe(ASSET_SEARCH_CANDIDATE_WINDOW);
    expect(response.results).toHaveLength(MAX_ASSET_SEARCH_LIMIT);
    expect(response.results.every((hit) => hit.match === "levenshtein")).toBe(
      true,
    );
  });
});

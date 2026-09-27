import { Module } from "@nestjs/common";
import { ElasticsearchModule } from "@nestjs/elasticsearch";
import { TypeOrmModule } from "@nestjs/typeorm";
import { PortfolioAsset } from "../investment/portfolio/entities/portfolio-asset.entity";
import { AssetSearchService } from "./asset-search.service";
import { SearchService } from "./search.service";
import { SearchController } from "./search.controller";

@Module({
  imports: [
    ElasticsearchModule.register({
      node: "http://localhost:9200",
    }),
    // Asset lookup reads the portfolio_assets table directly: the trigram /
    // edit-distance ranking has to happen in PostgreSQL to use the GIN indexes.
    TypeOrmModule.forFeature([PortfolioAsset]),
  ],
  providers: [SearchService, AssetSearchService],
  controllers: [SearchController],
})
export class SearchModule {}

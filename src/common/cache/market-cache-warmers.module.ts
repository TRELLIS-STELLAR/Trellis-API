import { Module } from "@nestjs/common";
import { OracleModule } from "../../blockchain/oracle/oracle.module";
import { DeFiModule } from "../../defi/defi.module";
import { MarketCacheWarmersService } from "./market-cache-warmers.service";

@Module({
  imports: [OracleModule, DeFiModule],
  providers: [MarketCacheWarmersService],
})
export class MarketCacheWarmersModule {}

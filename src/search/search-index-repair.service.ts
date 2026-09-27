import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { SearchService } from "./search.service";

@Injectable()
export class SearchIndexRepairService {
  private readonly logger = new Logger(SearchIndexRepairService.name);

  constructor(private readonly searchService: SearchService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async repair(): Promise<void> {
    try {
      const result = await this.searchService.repairIndex();
      this.logger.log(
        `Search index repaired: ${result.indexed} indexed, ${result.removed} stale entries removed`,
      );
    } catch (error) {
      this.logger.error(
        "Search index repair failed",
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

import { Controller, Get, Post, Body, Query } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import { AssetSearchService } from "./asset-search.service";
import { AssetSearchQueryDto } from "./dto/asset-search-query.dto";
import { AssetSearchResponse } from "./dto/asset-search-response.dto";
import { SearchService } from "./search.service";

@ApiTags("search")
@Controller("search")
export class SearchController {
  constructor(
    private readonly searchService: SearchService,
    private readonly assetSearchService: AssetSearchService,
  ) {}

  @Post("index")
  @ApiOperation({ summary: "Index a document in the posts index" })
  async indexPost(@Body() post: any) {
    return this.searchService.indexPost(post);
  }

  @Get()
  @ApiOperation({ summary: "Full-text search across indexed documents" })
  @ApiQuery({ name: "q", required: true, description: "Search query" })
  async search(@Query("q") query: string) {
    return this.searchService.search(query);
  }

  @Get("assets")
  @ApiOperation({
    summary: "Typo-tolerant portfolio asset lookup",
    description:
      "Exact, prefix and substring matches first, then a similarity-ranked fallback so 1-2 character typos still resolve. Every hit carries `relevance` (0..1) and the strategy that matched it.",
  })
  @ApiOkResponse({
    description:
      "Ranked asset matches. `fuzzyMode` reports which tolerant stage ran (`trigram`, `levenshtein` or `none`).",
  })
  async searchAssets(
    @Query() query: AssetSearchQueryDto,
  ): Promise<AssetSearchResponse> {
    return this.assetSearchService.search(query);
  }
}

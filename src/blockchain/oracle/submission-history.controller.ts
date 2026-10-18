import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  UseGuards,
} from "@nestjs/common";
import { IsString, Matches } from "class-validator";
import { SubmissionHistoryService } from "./services/submission-history.service";
import { PermissionsGuard } from "src/common/guard/permissions.guard";
import { RequirePermissions } from "src/common/guard/permissions.decorator";
import { Permission } from "src/common/guard/roles.enum";

export class RecordSubmissionDto {
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  payloadHash: string;

  @IsString()
  @Matches(/^[GC][A-Z2-7]{55}$/)
  submitter: string;

  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  transactionHash: string;
}

@Controller("oracle/submissions")
@UseGuards(PermissionsGuard)
export class SubmissionHistoryController {
  constructor(private readonly historyService: SubmissionHistoryService) {}

  @Post()
  @RequirePermissions(Permission.ORACLE_SUBMIT)
  record(@Body() input: RecordSubmissionDto) {
    return this.historyService.record(input);
  }

  @Get()
  @RequirePermissions(Permission.ORACLE_VERIFY)
  history(
    @Query("limit", new DefaultValuePipe(100), ParseIntPipe) limit: number,
    @Query("offset", new DefaultValuePipe(0), ParseIntPipe) offset: number,
  ) {
    return this.historyService.history(limit, offset);
  }
}

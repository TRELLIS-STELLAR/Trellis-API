import {
  BadGatewayException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  Matches,
} from "class-validator";
import {
  MAX_SUBMISSION_BATCH,
  SubmissionHistoryService,
} from "./services/submission-history.service";
import {
  OracleVerificationError,
  StellarOracleAdapter,
} from "./services/stellar-oracle.adapter";
import { SubmissionVerifierService } from "./submission-verifier.service";
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

/** Items are validated individually so one bad item is reported, not fatal. */
export class RecordSubmissionBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SUBMISSION_BATCH)
  submissions: RecordSubmissionDto[];
}

@Controller("oracle/submissions")
@UseGuards(PermissionsGuard)
export class SubmissionHistoryController {
  constructor(
    private readonly historyService: SubmissionHistoryService,
    private readonly adapter: StellarOracleAdapter,
    private readonly verifier: SubmissionVerifierService,
  ) {}

  @Post()
  @RequirePermissions(Permission.ORACLE_SUBMIT)
  record(@Body() input: RecordSubmissionDto) {
    return this.historyService.record(input);
  }

  @Post("batch")
  @HttpCode(200)
  @RequirePermissions(Permission.ORACLE_SUBMIT)
  recordBatch(@Body() input: RecordSubmissionBatchDto) {
    return this.historyService.recordBatch(input.submissions);
  }

  @Get("ledger-state")
  @RequirePermissions(Permission.ORACLE_VERIFY)
  async ledgerState() {
    try {
      return await this.adapter.getOracleLedgerState();
    } catch (error) {
      if (!(error instanceof OracleVerificationError)) throw error;
      throw error.retryable || error.code === "NOT_CONFIGURED"
        ? new ServiceUnavailableException(error.message)
        : new BadGatewayException(error.message);
    }
  }

  @Get("verifier")
  @RequirePermissions(Permission.ORACLE_VERIFY)
  verifierStatus() {
    return this.verifier.getStatus();
  }

  /** Retries a failed initialization; a no-op while the verifier is running. */
  @Post("verifier/start")
  @HttpCode(200)
  @RequirePermissions(Permission.SYSTEM_MAINTENANCE)
  startVerifier() {
    return this.verifier.start();
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

import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  HttpStatus,
  HttpCode,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "../auth/jwt.guard";
import { OwnershipTransferService } from "./ownership-transfer.service";
import { OwnershipTransfer } from "./entities/ownership-transfer.entity";

export class CreateTransferRequestDto {
  resourceType!: string;
  resourceId!: string;
  proposedOwnerId!: string;
  expiresInHours?: number;
}

export class ReasonDto {
  reason?: string;
}

@ApiTags("Ownership Transfers")
@ApiBearerAuth()
@Controller("ownership/transfers")
@UseGuards(JwtAuthGuard)
export class OwnershipTransferController {
  constructor(private readonly transferService: OwnershipTransferService) {}

  @Post()
  @ApiOperation({ summary: "Initiate safe ownership transfer with pending acceptance and expiry" })
  @ApiResponse({ status: 201, description: "Ownership transfer initiated" })
  async initiate(
    @Req() req: any,
    @Body() dto: CreateTransferRequestDto,
  ): Promise<OwnershipTransfer> {
    const userId = req.user?.id ?? req.user?.sub;
    return await this.transferService.initiateTransfer({
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      currentOwnerId: userId,
      proposedOwnerId: dto.proposedOwnerId,
      expiresInHours: dto.expiresInHours,
    });
  }

  @Post(":id/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Accept pending ownership transfer before expiry" })
  @ApiParam({ name: "id", description: "Transfer request ID" })
  @ApiResponse({ status: 200, description: "Ownership transfer accepted and completed" })
  async accept(
    @Param("id") id: string,
    @Req() req: any,
  ): Promise<OwnershipTransfer> {
    const userId = req.user?.id ?? req.user?.sub;
    return await this.transferService.acceptTransfer(id, userId);
  }

  @Post(":id/reject")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reject pending ownership transfer" })
  @ApiParam({ name: "id", description: "Transfer request ID" })
  @ApiResponse({ status: 200, description: "Ownership transfer rejected" })
  async reject(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body?: ReasonDto,
  ): Promise<OwnershipTransfer> {
    const userId = req.user?.id ?? req.user?.sub;
    return await this.transferService.rejectTransfer(id, userId, body?.reason);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel pending ownership transfer by current owner" })
  @ApiParam({ name: "id", description: "Transfer request ID" })
  @ApiResponse({ status: 200, description: "Ownership transfer cancelled" })
  async cancel(
    @Param("id") id: string,
    @Req() req: any,
    @Body() body?: ReasonDto,
  ): Promise<OwnershipTransfer> {
    const userId = req.user?.id ?? req.user?.sub;
    return await this.transferService.cancelTransfer(id, userId, body?.reason);
  }

  @Get(":id")
  @ApiOperation({ summary: "Get ownership transfer details" })
  @ApiParam({ name: "id", description: "Transfer request ID" })
  @ApiResponse({ status: 200, description: "Ownership transfer status" })
  async get(@Param("id") id: string): Promise<OwnershipTransfer> {
    return await this.transferService.getTransfer(id);
  }

  @Get()
  @ApiOperation({ summary: "List ownership transfers for current user" })
  @ApiQuery({ name: "direction", enum: ["incoming", "outgoing", "all"], required: false })
  @ApiResponse({ status: 200, description: "List of transfers" })
  async list(
    @Req() req: any,
    @Query("direction") direction?: "incoming" | "outgoing" | "all",
  ): Promise<OwnershipTransfer[]> {
    const userId = req.user?.id ?? req.user?.sub;
    return await this.transferService.listTransfers(userId, direction ?? "all");
  }
}

import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Request } from "express";
import { JwtAuthGuard } from "../../../core/auth/jwt.guard";
import { RolesGuard } from "../../../common/guard/roles.guard";
import { Roles } from "../../../common/guard/roles.decorator";
import { Role } from "../../../common/guard/roles.enum";
import { EventDeadLetterService } from "./event-dead-letter.service";
import {
  DeadLetterAuthorizationError,
  DeadLetterNotFoundError,
  DomainEventHandlerNotFoundError,
} from "./event-dead-letter.errors";
import { DeadLetterOperator } from "./event-dead-letter.types";
import {
  DiscardDeadLetterDto,
  ListDeadLettersQueryDto,
  ReplayDeadLettersDto,
} from "./dto/event-dead-letter.dto";

/**
 * Operator surface for dead-letter recovery (issue #354).
 *
 * Inspection and replay are available to ADMIN/MAINTAINER; discarding an event
 * is destructive and ADMIN-only. Payloads are never returned by the list
 * endpoints — only by `GET /:id`, which is operator-gated.
 */
@ApiTags("Event dead letters")
@ApiBearerAuth()
@Controller("api/v1/event-dead-letters")
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN, Role.MAINTAINER)
export class EventDeadLetterController {
  constructor(private readonly service: EventDeadLetterService) {}

  @Get()
  @ApiOperation({ summary: "List dead-lettered domain events (payload-free)" })
  @ApiResponse({ status: 200, description: "Dead-letter summaries" })
  list(@Query() query: ListDeadLettersQueryDto) {
    return this.service.list(query);
  }

  @Get("stats")
  @ApiOperation({ summary: "Dead-letter queue depth by status" })
  stats() {
    return this.service.stats();
  }

  @Get(":id")
  @ApiOperation({ summary: "Inspect a dead letter, including its payload" })
  @ApiResponse({ status: 404, description: "Dead letter not found" })
  get(@Param("id") id: string) {
    try {
      return this.service.get(id);
    } catch (error) {
      if (error instanceof DeadLetterNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Post("replay")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replay every pending dead letter matching the filter" })
  async replayAll(
    @Body() dto: ReplayDeadLettersDto,
    @Req() req: Request,
  ) {
    try {
      return await this.service.replayAll(dto, this.operator(req));
    } catch (error) {
      if (error instanceof DeadLetterAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  @Post(":id/replay")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replay a single dead letter after fixing the handler" })
  @ApiResponse({ status: 404, description: "Dead letter or handler not found" })
  async replay(@Param("id") id: string, @Req() req: Request) {
    try {
      return await this.service.replay(id, this.operator(req));
    } catch (error) {
      if (
        error instanceof DeadLetterNotFoundError ||
        error instanceof DomainEventHandlerNotFoundError
      ) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof DeadLetterAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  @Post(":id/discard")
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Discard a dead letter with a reason (ADMIN only)" })
  @ApiResponse({ status: 404, description: "Dead letter not found" })
  discard(
    @Param("id") id: string,
    @Body() dto: DiscardDeadLetterDto,
    @Req() req: Request,
  ) {
    try {
      return this.service.discard(id, dto.reason, this.operator(req));
    } catch (error) {
      if (error instanceof DeadLetterNotFoundError) {
        throw new NotFoundException(error.message);
      }
      if (error instanceof DeadLetterAuthorizationError) {
        throw new ForbiddenException(error.message);
      }
      throw error;
    }
  }

  private operator(req: Request): DeadLetterOperator {
    const user = (req as any).user ?? {};
    const role = user.role ?? (Array.isArray(user.roles) ? user.roles[0] : undefined);
    return { id: String(user.id ?? user.sub ?? "anonymous"), role: String(role ?? "") };
  }
}

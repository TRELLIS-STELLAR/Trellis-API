import {
  Controller,
  Post,
  UseGuards,
  Req,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { JwtAuthGuard } from "src/core/auth/jwt.guard";
import { WsTicketService } from "../services/ws-ticket.service";

@ApiTags("WebSocket")
@ApiBearerAuth()
@Controller(["ws", "api/ws"])
export class WsTicketController {
  constructor(private readonly wsTicketService: WsTicketService) {}

  @Post(["ticket", "ws/ticket"])
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Issue short-lived single-use ticket for WebSocket authentication",
    description:
      "Issues a single-use ticket valid for 30 seconds. Pass this ticket when connecting to WebSocket instead of long-lived access tokens.",
  })
  @ApiResponse({
    status: 200,
    description: "Ticket issued successfully",
    schema: {
      properties: {
        ticket: { type: "string", example: "wst_abc123..." },
        expiresIn: { type: "number", example: 30 },
      },
    },
  })
  async issueTicket(@Req() req: any) {
    const user = req.user;
    const userId = user?.userId || user?.sub || user?.id || "unknown";
    const ticket = await this.wsTicketService.createTicket(userId, user);
    return {
      ticket,
      expiresIn: WsTicketService.TICKET_TTL_SECONDS,
    };
  }
}

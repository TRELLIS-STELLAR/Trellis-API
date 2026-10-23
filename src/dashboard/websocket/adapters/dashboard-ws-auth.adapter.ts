import { INestApplicationContext, Injectable, Logger, Optional } from "@nestjs/common";
import { AuthService } from "src/core/auth/auth.service";
import { JwtService } from "@nestjs/jwt";
import { WsTicketService } from "../services/ws-ticket.service";

/**
 * Custom Socket.io adapter for WebSocket authentication with ticket-based auth support.
 */
@Injectable()
export class DashboardWebSocketAuthAdapter {
  private readonly logger = new Logger(DashboardWebSocketAuthAdapter.name);
  private authService: AuthService | null = null;
  private jwtService: JwtService | null = null;
  private ticketService: WsTicketService | null = null;

  constructor(
    @Optional() private readonly appContext?: INestApplicationContext,
    @Optional() ticketService?: WsTicketService,
  ) {
    if (ticketService) {
      this.ticketService = ticketService;
    }

    if (this.appContext) {
      // Get services from app context
      try {
        this.authService = this.appContext.get(AuthService, { strict: false });
        this.jwtService = this.appContext.get(JwtService, { strict: false });
        if (!this.ticketService) {
          this.ticketService = this.appContext.get(WsTicketService, {
            strict: false,
          });
        }
      } catch (error) {
        this.logger.warn("Auth services not available in WebSocket adapter");
      }
    }
  }

  /**
   * Set or override WsTicketService
   */
  setTicketService(ticketService: WsTicketService) {
    this.ticketService = ticketService;
  }

  /**
   * Verify authentication for a socket connection
   */
  async authenticate(socket: any): Promise<boolean> {
    try {
      // 1. Check for single-use ticket first (recommended and secure)
      const ticket = this.extractTicket(socket);
      if (ticket) {
        if (!this.ticketService) {
          this.logger.error(
            "TicketService not available to authenticate WebSocket ticket",
          );
          return false;
        }

        const ticketData = await this.ticketService.validateAndConsumeTicket(
          ticket,
        );
        if (!ticketData || !ticketData.userId) {
          this.logger.warn(
            `Single-use ticket invalid or already consumed for socket ${socket.id}`,
          );
          return false;
        }

        socket.user = {
          id: ticketData.userId,
          ...ticketData,
        };
        return true;
      }

      // 2. Prohibit long-lived tokens in query parameters to prevent log leakage
      const queryToken = socket.handshake?.query?.token;
      if (queryToken && typeof queryToken === "string") {
        this.logger.warn(
          `Connection rejected for socket ${socket.id}: Long-lived JWT tokens in query parameters are disabled. Use single-use tickets via POST /api/ws/ticket.`,
        );
        return false;
      }

      // 3. Fallback: Authenticate via Authorization header or auth payload
      const token = this.extractToken(socket);
      if (!token) {
        this.logger.warn(`No valid ticket or token provided for socket ${socket.id}`);
        return false;
      }

      // Verify JWT token
      if (this.jwtService) {
        const payload = this.jwtService.verify(token);

        // Check if user exists and is valid
        if (payload.sub || payload.userId) {
          const userId = payload.sub || payload.userId;

          // Attach user info to socket
          socket.user = {
            id: userId,
            ...payload,
          };

          return true;
        }
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Authentication failed for socket ${socket.id}: ${error.message}`,
      );
      return false;
    }
  }

  /**
   * Extract single-use ticket from socket handshake
   */
  extractTicket(socket: any): string | null {
    // 1. Try query parameter: ?ticket=...
    const queryTicket = socket.handshake?.query?.ticket;
    if (typeof queryTicket === "string" && queryTicket.trim()) {
      return queryTicket.trim();
    }

    // 2. Try auth object: auth: { ticket: ... }
    const authTicket = socket.handshake?.auth?.ticket;
    if (typeof authTicket === "string" && authTicket.trim()) {
      return authTicket.trim();
    }

    // 3. Try custom header
    const headerTicket = socket.handshake?.headers?.["x-ws-ticket"];
    if (typeof headerTicket === "string" && headerTicket.trim()) {
      return headerTicket.trim();
    }

    // 4. Try query.token if formatted as ticket (starts with wst_ or ticket_)
    const queryToken = socket.handshake?.query?.token;
    if (
      typeof queryToken === "string" &&
      (queryToken.startsWith("wst_") || queryToken.startsWith("ticket_"))
    ) {
      return queryToken.trim();
    }

    return null;
  }

  /**
   * Extract JWT token from socket handshake (excluding URL query parameters)
   */
  private extractToken(socket: any): string | null {
    // Try authorization header
    const authHeader = socket.handshake?.headers?.authorization;
    if (authHeader && authHeader.startsWith("Bearer ")) {
      return authHeader.substring(7);
    }

    // Try auth object
    const authToken = socket.handshake?.auth?.token;
    if (authToken && typeof authToken === "string") {
      return authToken;
    }

    // Disallow query parameter tokens
    return null;
  }

  /**
   * Get user ID from socket
   */
  getUserId(socket: any): string | null {
    return socket.user?.id || null;
  }

  /**
   * Check if socket is authenticated
   */
  isAuthenticated(socket: any): boolean {
    return socket.user !== undefined;
  }
}

// Export a static method for Socket.io adapter pattern
export function createWsAuthAdapter(appContext: INestApplicationContext) {
  return new DashboardWebSocketAuthAdapter(appContext);
}

// Monkey-patch the Server to use the adapter
export function setupAdapter(
  server: any,
  adapter: DashboardWebSocketAuthAdapter,
) {
  server.adapter = adapter;
}

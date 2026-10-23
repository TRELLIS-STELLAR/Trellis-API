import { Module, forwardRef } from "@nestjs/common";
import { DashboardController } from "./dashboard.controller";
import { DashboardService } from "./dashboard.service";
import { PortfolioModule } from "src/investment/portfolio/portfolio.module";
import { RiskManagementModule } from "src/investment/risk-management/risk-management.module";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";

// WebSocket Gateway, Controller and related services
import { DashboardGateway } from "./websocket/dashboard.gateway";
import { WsTicketController } from "./websocket/controllers/ws-ticket.controller";
import { WsTicketService } from "./websocket/services/ws-ticket.service";
import { DashboardWebSocketAuthAdapter } from "./websocket/adapters/dashboard-ws-auth.adapter";
import { ConnectionManagerService } from "./websocket/services/connection-manager.service";
import { EventBufferService } from "./websocket/services/event-buffer.service";
import { ConnectionPoolService } from "./websocket/services/connection-pool.service";
import { DashboardMetricsService } from "./websocket/services/dashboard-metrics.service";
import {
  ReconnectionService,
  WebSocketClientManager,
} from "./websocket/services/reconnection.service";
import { WebSocketHealthService } from "./websocket/services/websocket-health.service";
import { WsExceptionFilter } from "./websocket/filters/ws-exception.filter";

@Module({
  imports: [
    forwardRef(() => PortfolioModule),
    RiskManagementModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret:
          configService.get<string>("JWT_SECRET") ||
          "default-secret-change-in-production",
        signOptions: { expiresIn: "24h" },
      }),
    }),
  ],
  controllers: [DashboardController, WsTicketController],
  providers: [
    DashboardService,

    // WebSocket Gateway & Auth
    DashboardGateway,
    DashboardWebSocketAuthAdapter,
    WsTicketService,

    // WebSocket Services
    ConnectionManagerService,
    EventBufferService,
    ConnectionPoolService,
    DashboardMetricsService,
    ReconnectionService,
    WebSocketClientManager,
    WebSocketHealthService,

    // Filters
    WsExceptionFilter,
  ],
  exports: [
    DashboardGateway,
    DashboardWebSocketAuthAdapter,
    WsTicketService,
    ConnectionManagerService,
    EventBufferService,
    ConnectionPoolService,
    WebSocketHealthService,
  ],
})
export class DashboardModule {}

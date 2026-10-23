// WebSocket Gateway exports
export { DashboardGateway } from "./dashboard.gateway";

// Service exports
export { ConnectionManagerService } from "./services/connection-manager.service";
export { EventBufferService } from "./services/event-buffer.service";
export { WsTicketService, WsTicketData } from "./services/ws-ticket.service";
export { WsTicketController } from "./controllers/ws-ticket.controller";
export { ConnectionPoolService } from "./services/connection-pool.service";
export { DashboardMetricsService } from "./services/dashboard-metrics.service";
export {
  ReconnectionService,
  WebSocketClientManager,
} from "./services/reconnection.service";
export { WebSocketHealthService } from "./services/websocket-health.service";
export {
  DashboardClientService,
  createDashboardClient,
} from "./services/dashboard-client.service";

// Filter exports
export { WsExceptionFilter } from "./filters/ws-exception.filter";

// Adapter exports
export {
  DashboardWebSocketAuthAdapter,
  createWsAuthAdapter,
  setupAdapter,
} from "./adapters/dashboard-ws-auth.adapter";

// Interface exports
export {
  DashboardEvent,
  ConnectionInfo,
  BufferedEvent,
  ClientMessage,
  DashboardPayload,
  HeartbeatMessage,
  ReconnectionPayload,
  PortfolioUpdatePayload,
  PerformanceUpdatePayload,
  AllocationUpdatePayload,
  RiskUpdatePayload,
  WsErrorResponse,
  ConnectionStats,
  HealthCheckResult,
  ReconnectionConfig,
  EventBufferConfig,
} from "./interfaces/websocket.interfaces";

// Upstream connection types from connection pool
export {
  UpstreamConnection,
  PoolConfig,
  PoolStats,
} from "./services/connection-pool.service";

// Client config and state types
export {
  ClientConfig,
  ConnectionState,
  EventHandler,
} from "./services/dashboard-client.service";

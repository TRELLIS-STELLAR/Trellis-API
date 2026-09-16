import { Injectable, Logger } from "@nestjs/common";
import { Counter, Gauge, Histogram, Registry } from "prom-client";
import { register } from "src/config/metrics";

// WebSocket-specific metrics

// Connection metrics
export const wsConnectionsTotal = new Counter({
  name: "trellis_ws_connections_total",
  help: "Total number of WebSocket connections",
  labelNames: ["namespace", "type"], // type: connect, disconnect, error, stale_cleanup
  registers: [register],
});

export const wsActiveConnections = new Gauge({
  name: "trellis_ws_active_connections",
  help: "Number of active WebSocket connections",
  labelNames: ["namespace"],
  registers: [register],
});

export const wsConnectionsByUser = new Gauge({
  name: "trellis_ws_connections_by_user",
  help: "Number of WebSocket connections per user",
  labelNames: ["namespace", "user_id"],
  registers: [register],
});

// Subscription metrics
export const wsSubscriptionsTotal = new Counter({
  name: "trellis_ws_subscriptions_total",
  help: "Total number of WebSocket subscriptions",
  labelNames: ["namespace", "channel"],
  registers: [register],
});

export const wsActiveSubscriptions = new Gauge({
  name: "trellis_ws_active_subscriptions",
  help: "Number of active WebSocket subscriptions",
  labelNames: ["namespace", "channel"],
  registers: [register],
});

// Heartbeat metrics
export const wsHeartbeatsSent = new Counter({
  name: "trellis_ws_heartbeats_sent_total",
  help: "Total number of heartbeat messages sent",
  labelNames: ["namespace"],
  registers: [register],
});

export const wsHeartbeatsReceived = new Counter({
  name: "trellis_ws_heartbeats_received_total",
  help: "Total number of heartbeat responses received",
  labelNames: ["namespace"],
  registers: [register],
});

export const wsHeartbeatLatency = new Histogram({
  name: "trellis_ws_heartbeat_latency_seconds",
  help: "Heartbeat response latency in seconds",
  labelNames: ["namespace"],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Event metrics
export const wsEventsBuffered = new Gauge({
  name: "trellis_ws_events_buffered",
  help: "Number of events currently buffered",
  labelNames: ["namespace", "user_id"],
  registers: [register],
});

export const wsEventsSent = new Counter({
  name: "trellis_ws_events_sent_total",
  help: "Total number of events sent to clients",
  labelNames: ["namespace", "event_type"],
  registers: [register],
});

export const wsEventsReceived = new Counter({
  name: "trellis_ws_events_received_total",
  help: "Total number of events received from clients",
  labelNames: ["namespace", "event_type"],
  registers: [register],
});

// Reconnection metrics
export const wsReconnectionsTotal = new Counter({
  name: "trellis_ws_reconnections_total",
  help: "Total number of client reconnection attempts",
  labelNames: ["namespace", "status"], // status: success, failed
  registers: [register],
});

export const wsReconnectionDelay = new Histogram({
  name: "trellis_ws_reconnection_delay_seconds",
  help: "Reconnection delay in seconds",
  labelNames: ["namespace"],
  buckets: [1, 2, 5, 10, 15, 20, 25, 30],
  registers: [register],
});

// Error metrics
export const wsErrorsTotal = new Counter({
  name: "trellis_ws_errors_total",
  help: "Total number of WebSocket errors",
  labelNames: ["namespace", "error_type"],
  registers: [register],
});

// Upstream connection pool metrics
export const upstreamPoolConnectionsTotal = new Gauge({
  name: "trellis_upstream_pool_connections_total",
  help: "Total connections in upstream connection pool",
  labelNames: ["pool_name"],
  registers: [register],
});

export const upstreamPoolActiveConnections = new Gauge({
  name: "trellis_upstream_pool_active_connections",
  help: "Active connections in upstream connection pool",
  labelNames: ["pool_name"],
  registers: [register],
});

export const upstreamPoolUtilization = new Gauge({
  name: "trellis_upstream_pool_utilization_percent",
  help: "Utilization percentage of upstream connection pool",
  labelNames: ["pool_name"],
  registers: [register],
});

export const upstreamPoolRequestsTotal = new Counter({
  name: "trellis_upstream_pool_requests_total",
  help: "Total requests sent through upstream connection pool",
  labelNames: ["pool_name", "status"], // status: success, failure
  registers: [register],
});

// Latency metrics
export const wsMessageLatency = new Histogram({
  name: "trellis_ws_message_latency_seconds",
  help: "WebSocket message processing latency in seconds",
  labelNames: ["namespace", "event_type"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

@Injectable()
export class DashboardMetricsService {
  private readonly logger = new Logger(DashboardMetricsService.name);

  /**
   * Increment connection counter
   */
  incrementConnection(
    namespace: string,
    type: "connect" | "disconnect" | "error" | "stale_cleanup",
  ): void {
    wsConnectionsTotal.labels(namespace, type).inc();
  }

  /**
   * Set active connections gauge
   */
  setActiveConnections(namespace: string, count: number): void {
    wsActiveConnections.labels(namespace).set(count);
  }

  /**
   * Record heartbeat
   */
  recordHeartbeat(namespace: string): void {
    wsHeartbeatsSent.labels(namespace).inc();
  }

  /**
   * Record heartbeat response
   */
  recordHeartbeatResponse(namespace: string, latencyMs: number): void {
    wsHeartbeatsReceived.labels(namespace).inc();
    wsHeartbeatLatency.labels(namespace).observe(latencyMs / 1000);
  }

  /**
   * Record reconnection
   */
  recordReconnection(
    namespace: string,
    status: "success" | "failed",
    delayMs: number,
  ): void {
    wsReconnectionsTotal.labels(namespace, status).inc();
    if (status === "success") {
      wsReconnectionDelay.labels(namespace).observe(delayMs / 1000);
    }
  }

  /**
   * Record event sent
   */
  recordEventSent(namespace: string, eventType: string): void {
    wsEventsSent.labels(namespace, eventType).inc();
  }

  /**
   * Record event received
   */
  recordEventReceived(namespace: string, eventType: string): void {
    wsEventsReceived.labels(namespace, eventType).inc();
  }

  /**
   * Increment subscription counter
   */
  incrementSubscription(namespace: string, channel: string): void {
    wsSubscriptionsTotal.labels(namespace, channel).inc();
  }

  /**
   * Set active subscriptions gauge
   */
  setActiveSubscriptions(
    namespace: string,
    channel: string,
    count: number,
  ): void {
    wsActiveSubscriptions.labels(namespace, channel).set(count);
  }

  /**
   * Set buffered events gauge
   */
  setBufferedEvents(namespace: string, userId: string, count: number): void {
    wsEventsBuffered.labels(namespace, userId).set(count);
  }

  /**
   * Record error
   */
  recordError(namespace: string, errorType: string): void {
    wsErrorsTotal.labels(namespace, errorType).inc();
  }

  /**
   * Record message latency
   */
  recordMessageLatency(
    namespace: string,
    eventType: string,
    latencyMs: number,
  ): void {
    wsMessageLatency.labels(namespace, eventType).observe(latencyMs / 1000);
  }

  /**
   * Update upstream pool metrics
   */
  updateUpstreamPoolMetrics(
    poolName: string,
    stats: {
      total: number;
      active: number;
      utilization: number;
    },
  ): void {
    upstreamPoolConnectionsTotal.labels(poolName).set(stats.total);
    upstreamPoolActiveConnections.labels(poolName).set(stats.active);
    upstreamPoolUtilization.labels(poolName).set(stats.utilization);
  }

  /**
   * Record upstream request
   */
  recordUpstreamRequest(poolName: string, status: "success" | "failure"): void {
    upstreamPoolRequestsTotal.labels(poolName, status).inc();
  }

  /**
   * Get all metrics for debugging
   */
  async getMetrics(): Promise<string> {
    return register.metrics();
  }

  /**
   * Get metrics content type
   */
  getContentType(): string {
    return register.contentType;
  }
}

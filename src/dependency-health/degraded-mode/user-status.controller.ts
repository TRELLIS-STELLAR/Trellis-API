import { Controller, Get, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { DependencyDegradedModeService } from "./degraded-mode.service";
import { RecoveryDetectorService } from "./recovery-detector.service";
import { FallbackHandlerService } from "./fallback-handler.service";
import { DegradedModeLevel } from "./degraded-mode.types";

export interface UserStatusResponse {
  status: "operational" | "degraded" | "outage";
  level: DegradedModeLevel;
  message: string;
  affectedServices: Array<{
    service: string;
    status: "operational" | "degraded" | "unavailable";
    message: string;
  }>;
  estimatedRecovery?: string;
  lastUpdate: string;
}

/**
 * Public-facing status endpoint for users to check service availability.
 * Does not require authentication.
 * 
 * Provides user-friendly status information:
 * - Overall system status
 * - Affected services with descriptions
 * - Recovery estimates when available
 * - Helpful guidance for users
 * 
 * Issue #355: Dependency outage fallback and recovery UX
 */
@ApiTags("Status")
@Controller("api/v1/status")
export class UserStatusController {
  constructor(
    private readonly degradedModeService: DependencyDegradedModeService,
    private readonly recoveryDetector: RecoveryDetectorService,
    private readonly fallbackHandler: FallbackHandlerService,
  ) {}

  @Get()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get current system status (public endpoint)",
    description:
      "Returns user-friendly system status without sensitive internal details",
  })
  @ApiResponse({ status: 200, description: "System status" })
  async getStatus(): Promise<UserStatusResponse> {
    const decision = await this.degradedModeService.getMode();
    const capabilities = this.degradedModeService.listCapabilities(decision);

    // Determine overall status
    let overallStatus: "operational" | "degraded" | "outage";
    let message: string;

    if (decision.level === "normal") {
      overallStatus = "operational";
      message = "All systems operational";
    } else if (decision.level === "degraded") {
      overallStatus = "degraded";
      message = "Some services are experiencing degraded performance";
    } else if (decision.level === "restricted") {
      overallStatus = "outage";
      message = "Some services are temporarily unavailable";
    } else {
      overallStatus = "outage";
      message = "System is in maintenance mode";
    }

    // Build affected services list
    const affectedServices = capabilities
      .filter((cap) => cap.state !== "available")
      .map((cap) => ({
        service: this.humanizeCapability(cap.capability),
        status:
          cap.state === "disabled"
            ? ("unavailable" as const)
            : ("degraded" as const),
        message: this.getCapabilityMessage(cap.capability, cap.state, cap.reason),
      }));

    // Get recovery metrics
    const metrics = this.recoveryDetector.getMetrics();
    const pendingCount = Object.values(metrics.pendingOperations).reduce(
      (sum, count) => sum + count,
      0,
    );

    // Add recovery information if available
    let estimatedRecovery: string | undefined;
    if (decision.manualOverride) {
      estimatedRecovery = "Recovery time depends on manual administrator action";
    } else if (pendingCount > 0) {
      estimatedRecovery = `${pendingCount} operations queued for automatic processing upon recovery`;
    }

    return {
      status: overallStatus,
      level: decision.level,
      message,
      affectedServices,
      estimatedRecovery,
      lastUpdate: decision.generatedAt,
    };
  }

  @Get("health")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Simple health check endpoint",
    description: "Returns 200 if system can serve requests, 503 if in restricted/maintenance",
  })
  async getHealth(): Promise<{ status: string }> {
    const decision = await this.degradedModeService.getMode();
    
    // Return 503 if system cannot serve user traffic
    if (decision.level === "restricted" || decision.level === "maintenance") {
      throw new Error("Service unavailable");
    }

    return { status: "ok" };
  }

  @Get("pending")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get count of pending operations awaiting recovery",
    description: "Shows how many operations are queued for processing after service recovery",
  })
  async getPendingOperations(): Promise<{
    total: number;
    byService: Record<string, number>;
  }> {
    const metrics = this.recoveryDetector.getMetrics();
    const byService: Record<string, number> = {};
    let total = 0;

    for (const [capability, count] of Object.entries(metrics.pendingOperations)) {
      const serviceName = this.humanizeCapability(capability as any);
      byService[serviceName] = count;
      total += count;
    }

    return { total, byService };
  }

  /**
   * Convert technical capability name to user-friendly service name.
   */
  private humanizeCapability(capability: string): string {
    const names: Record<string, string> = {
      payments: "Payment Processing",
      trades: "Trading",
      oracle: "Price Oracle",
      imports: "Data Import",
      exports: "Data Export",
      search: "Search",
      notifications: "Notifications",
      webhooks: "Webhooks",
      admin: "Administration",
    };
    return names[capability] || capability;
  }

  /**
   * Generate user-friendly message for capability state.
   */
  private getCapabilityMessage(
    capability: string,
    state: "available" | "degraded" | "disabled",
    reason?: string,
  ): string {
    const serviceName = this.humanizeCapability(capability);

    if (state === "disabled") {
      return `${serviceName} is temporarily unavailable. ${
        reason || "Our team is working to restore service."
      }`;
    }

    if (state === "degraded") {
      return `${serviceName} is experiencing slower than normal performance. ${
        reason || "Service remains functional but may take longer to respond."
      }`;
    }

    return `${serviceName} is operational`;
  }
}

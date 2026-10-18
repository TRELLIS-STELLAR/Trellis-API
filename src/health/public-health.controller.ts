import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import {
  ApiExtraModels,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import {
  PublicHealthCheckDto,
  PublicHealthResponseDto,
} from "./dto/public-health.dto";
import { httpStatusForHealth } from "./public-health.model";
import { PublicHealthService } from "./public-health.service";

/**
 * `GET /health` — single public, dependency-aware health verdict (#281).
 *
 * Audiences:
 * - Load balancers, uptime monitors and status pages use this route. It is
 *   unauthenticated, rate limited, cached for a few seconds and exposes check
 *   names and coarse states only.
 * - Operators who need causes, latencies and remediation use the authenticated
 *   views instead: `GET /health/dependencies/diagnostics` and
 *   `GET /status/operator` (ADMIN/MAINTAINER + 2FA).
 *
 * The Kubernetes probes (`/health/live`, `/health/ready`, `/health/startup`)
 * are unchanged.
 */
@ApiTags("Health")
@Controller("health")
@Public()
@ApiExtraModels(PublicHealthResponseDto, PublicHealthCheckDto)
export class PublicHealthController {
  constructor(private readonly publicHealthService: PublicHealthService) {}

  @Get()
  @RateLimit({ level: "public-health", limit: 60, windowMs: 60_000 })
  @ApiOperation({
    summary: "Public dependency-aware health",
    description:
      "Overall API health derived from the database, cache (when configured) and the local " +
      "dependency-health summary. Returns 200 for `ok` and `degraded`, 503 with `Retry-After` " +
      "when a critical dependency is down. Never includes error messages, hosts or configuration.",
    operationId: "getPublicHealth",
  })
  @ApiResponse({
    status: 200,
    description: "Healthy or degraded",
    type: PublicHealthResponseDto,
  })
  @ApiResponse({
    status: 503,
    description: "A critical dependency is down",
    type: PublicHealthResponseDto,
  })
  async getHealth(
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicHealthResponseDto> {
    const { view, cached, retryAfterSeconds } =
      await this.publicHealthService.getHealth();

    if (res?.setHeader) {
      // Health must reflect the server's current view, not an intermediary's.
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Trellis-Health", view.status);
      res.setHeader("X-Trellis-Health-Cached", cached ? "true" : "false");
    }

    if (httpStatusForHealth(view.status) === 503) {
      res?.setHeader?.("Retry-After", String(retryAfterSeconds));
      res?.status?.(HttpStatus.SERVICE_UNAVAILABLE);
    }

    return view;
  }
}

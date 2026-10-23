import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import type Redis from "ioredis";
import {
  ComponentStatusDto,
  HealthResponseDto,
} from "./dto/health-response.dto";
import { HEALTH_REDIS_CLIENT } from "./health.constants";

@Injectable()
export class HealthService {
  private readonly timeoutMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(HEALTH_REDIS_CLIENT)
    private readonly redis: Redis | null,
  ) {
    this.timeoutMs =
      this.configService.get<number>("HEALTH_CHECK_TIMEOUT_MS") ?? 5000;
  }

  getLiveness(): HealthResponseDto {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components: {
        application: { status: "up" },
      },
    };
  }

  async getReadiness(): Promise<HealthResponseDto> {
    const [dbStatus, redisStatus] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    const components: Record<string, ComponentStatusDto> = {
      database: dbStatus,
      redis: redisStatus,
    };

    const allUp = Object.values(components).every((c) => c.status === "up");
    const anyUp = Object.values(components).some((c) => c.status === "up");

    return {
      status: allUp ? "ok" : anyUp ? "degraded" : "error",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components,
    };
  }

  async getStartup(): Promise<HealthResponseDto> {
    const dbStatus = await this.checkDatabase();

    const components: Record<string, ComponentStatusDto> = {
      database: dbStatus,
      orm: {
        status: this.dataSource.isInitialized ? "up" : "down",
        ...(this.dataSource.isInitialized
          ? {}
          : { message: "TypeORM DataSource not initialized" }),
      },
    };

    if (this.redis) {
      components.redis = await this.checkRedis();
    }

    const allUp = Object.values(components).every((c) => c.status === "up");

    return {
      status: allUp ? "ok" : "error",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      components,
    };
  }

  /**
   * Core probes for the public `/health` endpoint (#281). Unlike readiness, an
   * unconfigured Redis is reported as `null` (not wired up) rather than `down`,
   * so a deployment that does not use Redis is not reported as unhealthy.
   */
  async checkCoreComponents(): Promise<{
    database: ComponentStatusDto;
    redis: ComponentStatusDto | null;
  }> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.redis ? this.checkRedis() : Promise.resolve(null),
    ]);
    return { database, redis };
  }

  private async checkDatabase(): Promise<ComponentStatusDto> {
    const start = Date.now();
    try {
      await Promise.race([
        this.dataSource.query("SELECT 1"),
        this.rejectAfterTimeout("database"),
      ]);
      return { status: "up", responseTime: Date.now() - start };
    } catch (err: any) {
      return {
        status: "down",
        responseTime: Date.now() - start,
        message: err.message,
      };
    }
  }

  private async checkRedis(): Promise<ComponentStatusDto> {
    if (!this.redis) {
      return {
        status: "down",
        message: "Redis not configured (REDIS_URL missing)",
      };
    }
    const start = Date.now();
    try {
      await Promise.race([this.redis.ping(), this.rejectAfterTimeout("redis")]);
      return { status: "up", responseTime: Date.now() - start };
    } catch (err: any) {
      return {
        status: "down",
        responseTime: Date.now() - start,
        message: err.message,
      };
    }
  }

  private rejectAfterTimeout(component: string): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `${component} health check timed out after ${this.timeoutMs}ms`,
            ),
          ),
        this.timeoutMs,
      ),
    );
  }
}

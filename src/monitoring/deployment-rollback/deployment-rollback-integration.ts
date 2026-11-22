/**
 * Deployment rollback verification integration service.
 * 
 * Executes automated rollback safety checks before resuming production traffic.
 * 
 * Edge cases:
 * - Network partitions during version check trigger retry
 * - Stale cached responses from load balancer are detected
 * - Partial rollout states (some pods old version, some new) are flagged
 * - Authorization bypass vulnerabilities are detected via fail-closed probes
 * 
 * Recovery behavior:
 * - Failed verification blocks traffic resumption
 * - Verification report provides remediation steps
 * - Manual override requires RELEASE_MANAGER role
 * - Rollback can be re-triggered with updated target version
 */

import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timeout } from 'rxjs';
import {
  runDeploymentRollbackVerification,
  RollbackTarget,
  RollbackProbe,
  RollbackVerificationReport,
  RollbackActor,
} from './deployment-rollback';

export interface DeploymentEnvironmentConfig {
  name: string;
  apiBaseUrl: string;
  healthEndpoint: string;
  versionEndpoint: string;
  adminEndpoint: string;
  dbMigrationCheckUrl: string;
  requestTimeoutMs: number;
}

@Injectable()
export class DeploymentRollbackIntegrationService {
  private readonly logger = new Logger(DeploymentRollbackIntegrationService.name);

  constructor(private readonly httpService: HttpService) {}

  /**
   * Run comprehensive rollback verification for a deployment.
   * 
   * @param target - Rollback target with deployment metadata
   * @param envConfig - Environment-specific configuration
   * @param actor - Actor initiating verification (requires RELEASE_MANAGER role)
   * @returns Verification report with pass/fail status and remediation steps
   */
  async verifyRollback(
    target: RollbackTarget,
    envConfig: DeploymentEnvironmentConfig,
    actor: RollbackActor,
  ): Promise<RollbackVerificationReport> {
    this.logger.log(
      `Starting rollback verification for deployment ${target.deploymentId} ` +
        `(${target.fromVersion} → ${target.toVersion}) in ${target.environment}`,
    );

    const probe: RollbackProbe = async (check, context) => {
      const url = this.buildCheckUrl(check.name, check.kind, envConfig);
      const headers = context.authorizationProbe
        ? {} // No auth header for fail-closed verification
        : { Authorization: `Bearer ${this.getSystemToken(envConfig)}` };

      try {
        const response = await firstValueFrom(
          this.httpService
            .get(url, { headers, timeout: envConfig.requestTimeoutMs })
            .pipe(timeout(envConfig.requestTimeoutMs)),
        );

        if (check.kind === 'version') {
          const version = this.extractVersion(response.data);
          return {
            ok: response.status === 200,
            status: response.status,
            observedVersion: version,
          };
        }

        return {
          ok: response.status >= 200 && response.status < 300,
          status: response.status,
        };
      } catch (error: any) {
        if (error.response) {
          return {
            ok: false,
            status: error.response.status,
            error: error.response.data?.message || error.message,
            retryable: error.response.status >= 500,
          };
        }

        if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
          return {
            ok: false,
            error: `Connection failed: ${error.message}`,
            retryable: true,
          };
        }

        return {
          ok: false,
          error: error.message,
          retryable: true,
        };
      }
    };

    const report = await runDeploymentRollbackVerification(target, probe, {
      actor,
      maxAttempts: 3,
      backoffMs: 100,
      probeAuthorization: true,
    });

    if (report.allPassed) {
      this.logger.log(
        `✓ Rollback verification PASSED for ${target.deploymentId}. Safe to resume traffic.`,
      );
    } else {
      this.logger.error(
        `✗ Rollback verification FAILED for ${target.deploymentId}. ` +
          `${report.failed} check(s) failed. Traffic should NOT be resumed.`,
      );
      report.remediation.forEach((r) => this.logger.error(`  ${r}`));
    }

    return report;
  }

  /**
   * Build standard production rollback target for common checks.
   */
  buildStandardProductionTarget(
    deploymentId: string,
    fromVersion: string,
    toVersion: string,
  ): RollbackTarget {
    return {
      deploymentId,
      fromVersion,
      toVersion,
      environment: 'production',
      checks: [
        { name: 'api-version', kind: 'version' },
        { name: 'health-check', kind: 'health' },
        { name: 'db-schema-version', kind: 'schema' },
        { name: 'stellar-horizon-connectivity', kind: 'dependency' },
        { name: 'redis-connectivity', kind: 'dependency' },
        { name: 'admin-authorization', kind: 'authorization', requireAuthFailClosed: true },
        { name: 'cache-warmup', kind: 'dependency', required: false },
      ],
    };
  }

  /**
   * Build staging environment rollback target with relaxed checks.
   */
  buildStagingRollbackTarget(
    deploymentId: string,
    fromVersion: string,
    toVersion: string,
  ): RollbackTarget {
    return {
      deploymentId,
      fromVersion,
      toVersion,
      environment: 'staging',
      checks: [
        { name: 'api-version', kind: 'version' },
        { name: 'health-check', kind: 'health' },
        { name: 'db-schema-version', kind: 'schema' },
      ],
    };
  }

  private buildCheckUrl(
    checkName: string,
    kind: string,
    config: DeploymentEnvironmentConfig,
  ): string {
    switch (checkName) {
      case 'api-version':
        return `${config.apiBaseUrl}${config.versionEndpoint}`;
      case 'health-check':
        return `${config.apiBaseUrl}${config.healthEndpoint}`;
      case 'db-schema-version':
        return `${config.apiBaseUrl}${config.dbMigrationCheckUrl}`;
      case 'admin-authorization':
        return `${config.apiBaseUrl}${config.adminEndpoint}`;
      case 'stellar-horizon-connectivity':
        return `${config.apiBaseUrl}/health/stellar`;
      case 'redis-connectivity':
        return `${config.apiBaseUrl}/health/redis`;
      case 'cache-warmup':
        return `${config.apiBaseUrl}/health/cache`;
      default:
        return `${config.apiBaseUrl}/health/${checkName}`;
    }
  }

  private extractVersion(data: any): string | undefined {
    if (typeof data === 'string') {
      const match = data.match(/(\d+\.\d+\.\d+)/);
      return match?.[1];
    }
    return data?.version || data?.appVersion || data?.apiVersion;
  }

  private getSystemToken(config: DeploymentEnvironmentConfig): string {
    // In production, retrieve from secure secret store
    // For now, return placeholder that should be injected via config
    return process.env[`SYSTEM_TOKEN_${config.name.toUpperCase()}`] || 'system-token';
  }
}

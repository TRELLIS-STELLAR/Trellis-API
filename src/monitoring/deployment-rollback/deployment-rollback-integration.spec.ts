import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import { DeploymentRollbackIntegrationService } from './deployment-rollback-integration';
import { RollbackTarget, RollbackActor } from './deployment-rollback';

describe('DeploymentRollbackIntegrationService', () => {
  let service: DeploymentRollbackIntegrationService;
  let httpService: HttpService;

  const mockEnvConfig = {
    name: 'production',
    apiBaseUrl: 'https://api.trellis.example',
    healthEndpoint: '/health',
    versionEndpoint: '/version',
    adminEndpoint: '/admin/status',
    dbMigrationCheckUrl: '/health/db',
    requestTimeoutMs: 5000,
  };

  const mockActor: RollbackActor = {
    id: 'ops-user-1',
    roles: ['RELEASE_MANAGER'],
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        DeploymentRollbackIntegrationService,
        {
          provide: HttpService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(DeploymentRollbackIntegrationService);
    httpService = module.get(HttpService);
  });

  describe('Normal path - Successful rollback verification', () => {
    it('passes when all checks succeed and version matches', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string, options: any) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        if (url.includes('/admin') && !options.headers.Authorization) {
          return throwError(() => ({ response: { status: 403 } }));
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(true);
      expect(report.canResumeTraffic).toBe(true);
      expect(report.toVersion).toBe('1.9.5');
    });

    it('builds standard production target with all required checks', () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      expect(target.checks).toHaveLength(7);
      expect(target.checks.map((c) => c.name)).toContain('api-version');
      expect(target.checks.map((c) => c.name)).toContain('health-check');
      expect(target.checks.map((c) => c.name)).toContain('admin-authorization');
    });

    it('builds staging target with relaxed checks', () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');

      expect(target.checks).toHaveLength(3);
      expect(target.environment).toBe('staging');
    });
  });

  describe('Failure path - Check failures', () => {
    it('fails when version does not match expected rollback target', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '2.0.0' }, status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(false);
      expect(report.canResumeTraffic).toBe(false);
      expect(report.remediation.some((r) => r.includes('still running failed version'))).toBe(
        true,
      );
    });

    it('fails when health check returns non-200', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        if (url.includes('/health')) {
          return throwError(() => ({ response: { status: 503 } }));
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(false);
      expect(report.failed).toBeGreaterThan(0);
    });

    it('fails when authorization check does not fail closed', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string, options: any) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        // Authorization endpoint returns 200 even without auth header - SECURITY ISSUE
        if (url.includes('/admin')) {
          return of({ data: { status: 'ok' }, status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(false);
      expect(
        report.remediation.some((r) => r.includes('failed to reject unauthenticated')),
      ).toBe(true);
    });
  });

  describe('Retry path - Transient failures', () => {
    it('retries transient network errors', async () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');
      let healthAttempts = 0;

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        if (url.includes('/health')) {
          healthAttempts++;
          if (healthAttempts === 1) {
            return throwError(() => ({ code: 'ETIMEDOUT', message: 'Timeout' }));
          }
          return of({ data: { status: 'ok' }, status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(true);
      expect(healthAttempts).toBe(2);
    });

    it('marks 5xx errors as retryable', async () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');
      let dbCheckAttempts = 0;

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        if (url.includes('/health/db')) {
          dbCheckAttempts++;
          if (dbCheckAttempts === 1) {
            return throwError(() => ({
              response: { status: 503, data: { message: 'DB warming up' } },
            }));
          }
          return of({ data: { status: 'ok' }, status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(true);
      expect(dbCheckAttempts).toBe(2);
    });
  });

  describe('Authorization path', () => {
    it('requires RELEASE_MANAGER role', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');
      const unauthorizedActor: RollbackActor = {
        id: 'dev-user-1',
        roles: ['DEVELOPER'],
      };

      await expect(
        service.verifyRollback(target, mockEnvConfig, unauthorizedActor),
      ).rejects.toThrow('lacks required role');
    });

    it('allows ADMIN role', async () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');
      const adminActor: RollbackActor = {
        id: 'admin-1',
        roles: ['ADMIN'],
      };

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, adminActor);

      expect(report.allPassed).toBe(true);
    });
  });

  describe('Edge cases', () => {
    it('handles version extraction from string responses', async () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: 'Trellis API v1.9.5', status: 200 });
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(true);
    });

    it('handles optional checks that fail as warnings', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string, options: any) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        if (url.includes('/cache')) {
          return throwError(() => ({ response: { status: 503 } }));
        }
        if (url.includes('/admin') && !options.headers.Authorization) {
          return throwError(() => ({ response: { status: 403 } }));
        }
        return of({ data: { status: 'ok' }, status: 200 });
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.allPassed).toBe(true);
      expect(report.warnings).toBe(1);
    });

    it('includes remediation steps for all failures', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation(() => {
        return throwError(() => ({ response: { status: 500 } }));
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report.remediation.length).toBeGreaterThan(0);
      expect(report.remediation.every((r) => r.includes('['))).toBe(true);
    });
  });

  describe('Recovery behavior', () => {
    it('logs detailed failure information', async () => {
      const target = service.buildStagingRollbackTarget('deploy-123', '2.0.0', '1.9.5');
      const loggerSpy = jest.spyOn(service['logger'], 'error');

      (httpService.get as jest.Mock).mockImplementation(() => {
        return throwError(() => ({ response: { status: 500 } }));
      });

      await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('verification FAILED'),
      );
    });

    it('provides structured report for automated decisions', async () => {
      const target = service.buildStandardProductionTarget('deploy-123', '2.0.0', '1.9.5');

      (httpService.get as jest.Mock).mockImplementation((url: string) => {
        if (url.includes('/version')) {
          return of({ data: { version: '1.9.5' }, status: 200 });
        }
        return throwError(() => ({ response: { status: 503 } }));
      });

      const report = await service.verifyRollback(target, mockEnvConfig, mockActor);

      expect(report).toHaveProperty('allPassed');
      expect(report).toHaveProperty('canResumeTraffic');
      expect(report).toHaveProperty('passed');
      expect(report).toHaveProperty('failed');
      expect(report).toHaveProperty('results');
      expect(report).toHaveProperty('remediation');
      expect(report).toHaveProperty('verifiedAt');
    });
  });
});

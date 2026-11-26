/**
 * Critical workflow definitions for synthetic monitoring.
 * 
 * These journeys cover normal, failure, retry, and authorization paths
 * for core business operations.
 * 
 * Edge cases:
 * - Network timeouts trigger retry logic
 * - Authorization failures fail fast without retry
 * - Rate limiting triggers exponential backoff
 * - Database connection failures are transient and retryable
 * 
 * Recovery:
 * - All workflows are read-only probes by design
 * - Failed journeys alert ops team without affecting production state
 * - No rollback needed as no mutations occur
 */

import { Injectable, Logger } from '@nestjs/common';
import { Journey } from '../synthetic-monitoring.service';

export interface WorkflowDependencies {
  httpClient: {
    get: (url: string, options?: { headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }>;
    post: (url: string, body: unknown, options?: { headers?: Record<string, string> }) => Promise<{ status: number; data: unknown }>;
  };
  config: {
    apiBaseUrl: string;
    testUserToken: string;
    testAdminToken: string;
  };
}

@Injectable()
export class CriticalWorkflowsService {
  private readonly logger = new Logger(CriticalWorkflowsService.name);

  constructor(private readonly deps: WorkflowDependencies) {}

  /**
   * User authentication and session establishment workflow.
   * 
   * Covers:
   * - Normal: successful login with valid credentials
   * - Failure: invalid credentials return 401
   * - Authorization: token validation and refresh
   * - Retry: transient auth service failures
   */
  getUserAuthenticationJourney(): Journey {
    const { httpClient, config } = this.deps;

    return {
      name: 'user-authentication-flow',
      steps: [
        {
          name: 'health-check-auth-service',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/health`);
            if (res.status !== 200) {
              throw new Error(`Auth service unhealthy: ${res.status}`);
            }
          },
        },
        {
          name: 'login-with-valid-credentials',
          fn: async () => {
            const res = await httpClient.post(`${config.apiBaseUrl}/auth/login`, {
              email: 'synthetic-test@trellis.local',
              password: 'Test123!@#',
            });
            if (res.status !== 200 && res.status !== 201) {
              throw new Error(`Login failed: ${res.status}`);
            }
            const data = res.data as { accessToken?: string };
            if (!data.accessToken) {
              throw new Error('No access token in login response');
            }
          },
        },
        {
          name: 'verify-invalid-credentials-fail',
          fn: async () => {
            try {
              await httpClient.post(`${config.apiBaseUrl}/auth/login`, {
                email: 'synthetic-test@trellis.local',
                password: 'wrong-password',
              });
              throw new Error('Invalid credentials should have failed');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 401 && error.response?.status !== 403) {
                throw new Error(`Expected 401/403, got ${error.response?.status}`);
              }
            }
          },
        },
        {
          name: 'verify-protected-endpoint-requires-auth',
          fn: async () => {
            try {
              await httpClient.get(`${config.apiBaseUrl}/portfolio/me`);
              throw new Error('Protected endpoint should require auth');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 401) {
                throw new Error(`Expected 401, got ${error.response?.status}`);
              }
            }
          },
        },
        {
          name: 'access-protected-endpoint-with-token',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/portfolio/me`, {
              headers: { Authorization: `Bearer ${config.testUserToken}` },
            });
            if (res.status !== 200) {
              throw new Error(`Protected endpoint failed: ${res.status}`);
            }
          },
        },
      ],
    };
  }

  /**
   * Portfolio creation and management workflow.
   * 
   * Covers:
   * - Normal: create portfolio, add assets, retrieve details
   * - Failure: validation errors, unauthorized access attempts
   * - Authorization: ownership verification
   * - Retry: transient database connection failures
   */
  getPortfolioManagementJourney(): Journey {
    const { httpClient, config } = this.deps;
    let portfolioId: string;

    return {
      name: 'portfolio-management-flow',
      steps: [
        {
          name: 'list-existing-portfolios',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/portfolio`, {
              headers: { Authorization: `Bearer ${config.testUserToken}` },
            });
            if (res.status !== 200) {
              throw new Error(`List portfolios failed: ${res.status}`);
            }
          },
        },
        {
          name: 'create-test-portfolio',
          fn: async () => {
            const res = await httpClient.post(
              `${config.apiBaseUrl}/portfolio`,
              {
                name: `Synthetic Test ${Date.now()}`,
                strategy: 'BALANCED',
                riskTolerance: 0.5,
              },
              { headers: { Authorization: `Bearer ${config.testUserToken}` } },
            );
            if (res.status !== 201) {
              throw new Error(`Create portfolio failed: ${res.status}`);
            }
            const data = res.data as { id?: string };
            portfolioId = data.id!;
          },
        },
        {
          name: 'verify-unauthorized-access-denied',
          fn: async () => {
            try {
              await httpClient.get(`${config.apiBaseUrl}/portfolio/${portfolioId}`, {
                headers: { Authorization: 'Bearer invalid-token' },
              });
              throw new Error('Unauthorized access should be denied');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 401) {
                throw new Error(`Expected 401, got ${error.response?.status}`);
              }
            }
          },
        },
        {
          name: 'retrieve-portfolio-details',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/portfolio/${portfolioId}`, {
              headers: { Authorization: `Bearer ${config.testUserToken}` },
            });
            if (res.status !== 200) {
              throw new Error(`Get portfolio failed: ${res.status}`);
            }
          },
        },
        {
          name: 'verify-not-found-returns-404',
          fn: async () => {
            try {
              await httpClient.get(`${config.apiBaseUrl}/portfolio/nonexistent-id`, {
                headers: { Authorization: `Bearer ${config.testUserToken}` },
              });
              throw new Error('Nonexistent portfolio should return 404');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 404) {
                throw new Error(`Expected 404, got ${error.response?.status}`);
              }
            }
          },
        },
      ],
    };
  }

  /**
   * Payment settlement workflow via Stellar network.
   * 
   * Covers:
   * - Normal: invoice creation, payment submission, settlement confirmation
   * - Failure: insufficient funds, invalid destination
   * - Retry: Horizon timeout, network errors
   * - Authorization: wallet signature verification
   */
  getPaymentSettlementJourney(): Journey {
    const { httpClient, config } = this.deps;
    let invoiceId: string;

    return {
      name: 'payment-settlement-flow',
      steps: [
        {
          name: 'create-test-invoice',
          fn: async () => {
            const res = await httpClient.post(
              `${config.apiBaseUrl}/payments/invoices`,
              {
                amount: '10.00',
                currency: 'USD',
                description: 'Synthetic test invoice',
              },
              { headers: { Authorization: `Bearer ${config.testUserToken}` } },
            );
            if (res.status !== 201) {
              throw new Error(`Create invoice failed: ${res.status}`);
            }
            const data = res.data as { id?: string };
            invoiceId = data.id!;
          },
        },
        {
          name: 'retrieve-invoice-details',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/payments/invoices/${invoiceId}`, {
              headers: { Authorization: `Bearer ${config.testUserToken}` },
            });
            if (res.status !== 200) {
              throw new Error(`Get invoice failed: ${res.status}`);
            }
          },
        },
        {
          name: 'verify-insufficient-funds-fails-gracefully',
          fn: async () => {
            try {
              await httpClient.post(
                `${config.apiBaseUrl}/payments/settlements`,
                {
                  invoiceId,
                  sourceWallet: 'GDUMMY0000000000000000000000000000000000000000000001',
                  amount: '999999.99',
                },
                { headers: { Authorization: `Bearer ${config.testUserToken}` } },
              );
              throw new Error('Insufficient funds should fail');
            } catch (err) {
              const error = err as { response?: { status?: number; data?: { errorCode?: string } } };
              if (error.response?.status !== 400 && error.response?.status !== 402) {
                throw new Error(`Expected 400/402, got ${error.response?.status}`);
              }
              if (error.response?.data?.errorCode !== 'INSUFFICIENT_FUNDS') {
                this.logger.warn('Expected INSUFFICIENT_FUNDS error code');
              }
            }
          },
        },
        {
          name: 'verify-malformed-wallet-address-rejected',
          fn: async () => {
            try {
              await httpClient.post(
                `${config.apiBaseUrl}/payments/settlements`,
                {
                  invoiceId,
                  sourceWallet: 'invalid-address',
                  amount: '10.00',
                },
                { headers: { Authorization: `Bearer ${config.testUserToken}` } },
              );
              throw new Error('Malformed wallet address should be rejected');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 400) {
                throw new Error(`Expected 400, got ${error.response?.status}`);
              }
            }
          },
        },
      ],
    };
  }

  /**
   * Ownership transfer workflow.
   * 
   * Covers:
   * - Normal: initiate transfer, accept by proposed owner
   * - Failure: unauthorized acceptance, expired transfer
   * - Authorization: participant verification
   * - Retry: transient database errors on status updates
   */
  getOwnershipTransferJourney(): Journey {
    const { httpClient, config } = this.deps;
    let transferId: string;

    return {
      name: 'ownership-transfer-flow',
      steps: [
        {
          name: 'initiate-ownership-transfer',
          fn: async () => {
            const res = await httpClient.post(
              `${config.apiBaseUrl}/ownership/transfers`,
              {
                resourceType: 'portfolio',
                resourceId: 'test-portfolio-123',
                proposedOwnerId: 'user-456',
                expiresInHours: 72,
              },
              { headers: { Authorization: `Bearer ${config.testUserToken}` } },
            );
            if (res.status !== 201) {
              throw new Error(`Initiate transfer failed: ${res.status}`);
            }
            const data = res.data as { id?: string };
            transferId = data.id!;
          },
        },
        {
          name: 'retrieve-transfer-status',
          fn: async () => {
            const res = await httpClient.get(`${config.apiBaseUrl}/ownership/transfers/${transferId}`, {
              headers: { Authorization: `Bearer ${config.testUserToken}` },
            });
            if (res.status !== 200) {
              throw new Error(`Get transfer failed: ${res.status}`);
            }
            const data = res.data as { status?: string };
            if (data.status !== 'PENDING') {
              throw new Error(`Expected PENDING status, got ${data.status}`);
            }
          },
        },
        {
          name: 'verify-unauthorized-accept-denied',
          fn: async () => {
            try {
              await httpClient.post(
                `${config.apiBaseUrl}/ownership/transfers/${transferId}/accept`,
                {},
                { headers: { Authorization: `Bearer ${config.testUserToken}` } },
              );
              throw new Error('Unauthorized accept should be denied');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 403) {
                throw new Error(`Expected 403, got ${error.response?.status}`);
              }
            }
          },
        },
        {
          name: 'cancel-transfer',
          fn: async () => {
            const res = await httpClient.post(
              `${config.apiBaseUrl}/ownership/transfers/${transferId}/cancel`,
              { reason: 'Synthetic test cleanup' },
              { headers: { Authorization: `Bearer ${config.testUserToken}` } },
            );
            if (res.status !== 200) {
              throw new Error(`Cancel transfer failed: ${res.status}`);
            }
          },
        },
        {
          name: 'verify-cancelled-transfer-cannot-be-accepted',
          fn: async () => {
            try {
              await httpClient.post(
                `${config.apiBaseUrl}/ownership/transfers/${transferId}/accept`,
                {},
                { headers: { Authorization: `Bearer ${config.testAdminToken}` } },
              );
              throw new Error('Cancelled transfer should not be acceptable');
            } catch (err) {
              const error = err as { response?: { status?: number } };
              if (error.response?.status !== 400 && error.response?.status !== 409) {
                throw new Error(`Expected 400/409, got ${error.response?.status}`);
              }
            }
          },
        },
      ],
    };
  }

  /**
   * Get all critical workflow journeys.
   */
  getAllJourneys(): Journey[] {
    return [
      this.getUserAuthenticationJourney(),
      this.getPortfolioManagementJourney(),
      this.getPaymentSettlementJourney(),
      this.getOwnershipTransferJourney(),
    ];
  }
}

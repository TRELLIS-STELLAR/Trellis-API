import { CriticalWorkflowsService, WorkflowDependencies } from './critical-workflows';
import { SyntheticMonitoringService } from '../synthetic-monitoring.service';

describe('CriticalWorkflowsService', () => {
  let mockHttpClient: WorkflowDependencies['httpClient'];
  let mockConfig: WorkflowDependencies['config'];
  let service: CriticalWorkflowsService;
  let monitoringService: SyntheticMonitoringService;

  beforeEach(() => {
    mockHttpClient = {
      get: jest.fn(),
      post: jest.fn(),
    };
    mockConfig = {
      apiBaseUrl: 'http://localhost:3000',
      testUserToken: 'test-user-token',
      testAdminToken: 'test-admin-token',
    };
    service = new CriticalWorkflowsService({ httpClient: mockHttpClient, config: mockConfig });
    monitoringService = new SyntheticMonitoringService();
  });

  describe('User Authentication Journey', () => {
    it('passes when all authentication steps succeed', async () => {
      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 200 });
      (mockHttpClient.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { accessToken: 'valid-token' } })
        .mockRejectedValueOnce({ response: { status: 401 } })
        .mockRejectedValueOnce({ response: { status: 401 } })
        .mockResolvedValueOnce({ status: 200, data: {} });

      const journey = service.getUserAuthenticationJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('user-authentication-flow');

      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(5);
      expect(result.steps.every((s) => s.status === 'pass')).toBe(true);
    });

    it('fails when health check returns non-200', async () => {
      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 503 });

      const journey = service.getUserAuthenticationJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('user-authentication-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[0].status).toBe('fail');
      expect(result.steps[0].error).toContain('Auth service unhealthy');
    });

    it('fails when login does not return access token', async () => {
      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 200 });
      (mockHttpClient.post as jest.Mock).mockResolvedValue({ status: 200, data: {} });

      const journey = service.getUserAuthenticationJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('user-authentication-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[1].status).toBe('fail');
      expect(result.steps[1].error).toContain('No access token');
    });

    it('fails when invalid credentials do not return 401/403', async () => {
      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 200 });
      (mockHttpClient.post as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: { accessToken: 'valid' } })
        .mockResolvedValueOnce({ status: 200, data: {} });

      const journey = service.getUserAuthenticationJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('user-authentication-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[2].error).toContain('should have failed');
    });
  });

  describe('Portfolio Management Journey', () => {
    it('passes when portfolio operations succeed with proper authorization', async () => {
      (mockHttpClient.get as jest.Mock)
        .mockResolvedValueOnce({ status: 200, data: [] })
        .mockRejectedValueOnce({ response: { status: 401 } })
        .mockResolvedValueOnce({ status: 200, data: { id: 'portfolio-123' } })
        .mockRejectedValueOnce({ response: { status: 404 } });

      (mockHttpClient.post as jest.Mock).mockResolvedValue({
        status: 201,
        data: { id: 'portfolio-123' },
      });

      const journey = service.getPortfolioManagementJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('portfolio-management-flow');

      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(5);
    });

    it('fails when unauthorized access is not denied', async () => {
      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 200, data: [] });
      (mockHttpClient.post as jest.Mock).mockResolvedValue({
        status: 201,
        data: { id: 'portfolio-123' },
      });

      const journey = service.getPortfolioManagementJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('portfolio-management-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[2].error).toContain('should be denied');
    });
  });

  describe('Payment Settlement Journey', () => {
    it('passes when payment validations work correctly', async () => {
      (mockHttpClient.post as jest.Mock)
        .mockResolvedValueOnce({ status: 201, data: { id: 'invoice-123' } })
        .mockRejectedValueOnce({
          response: { status: 400, data: { errorCode: 'INSUFFICIENT_FUNDS' } },
        })
        .mockRejectedValueOnce({ response: { status: 400 } });

      (mockHttpClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        data: { id: 'invoice-123', status: 'PENDING' },
      });

      const journey = service.getPaymentSettlementJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('payment-settlement-flow');

      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(4);
    });

    it('fails when insufficient funds check does not fail appropriately', async () => {
      (mockHttpClient.post as jest.Mock)
        .mockResolvedValueOnce({ status: 201, data: { id: 'invoice-123' } })
        .mockResolvedValueOnce({ status: 200, data: {} });

      (mockHttpClient.get as jest.Mock).mockResolvedValue({ status: 200, data: {} });

      const journey = service.getPaymentSettlementJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('payment-settlement-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[2].error).toContain('should fail');
    });
  });

  describe('Ownership Transfer Journey', () => {
    it('passes when transfer lifecycle and authorization work correctly', async () => {
      (mockHttpClient.post as jest.Mock)
        .mockResolvedValueOnce({ status: 201, data: { id: 'transfer-123' } })
        .mockRejectedValueOnce({ response: { status: 403 } })
        .mockResolvedValueOnce({ status: 200, data: {} })
        .mockRejectedValueOnce({ response: { status: 400 } });

      (mockHttpClient.get as jest.Mock).mockResolvedValue({
        status: 200,
        data: { id: 'transfer-123', status: 'PENDING' },
      });

      const journey = service.getOwnershipTransferJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('ownership-transfer-flow');

      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(5);
    });

    it('skips remaining steps when transfer initiation fails', async () => {
      (mockHttpClient.post as jest.Mock).mockResolvedValue({ status: 500 });

      const journey = service.getOwnershipTransferJourney();
      monitoringService.register(journey);
      const result = await monitoringService.run('ownership-transfer-flow');

      expect(result.passed).toBe(false);
      expect(result.steps[0].status).toBe('fail');
      expect(result.steps.slice(1).every((s) => s.status === 'skip')).toBe(true);
    });
  });

  describe('getAllJourneys', () => {
    it('returns all critical workflows', () => {
      const journeys = service.getAllJourneys();
      expect(journeys).toHaveLength(4);
      expect(journeys.map((j) => j.name)).toEqual([
        'user-authentication-flow',
        'portfolio-management-flow',
        'payment-settlement-flow',
        'ownership-transfer-flow',
      ]);
    });
  });
});

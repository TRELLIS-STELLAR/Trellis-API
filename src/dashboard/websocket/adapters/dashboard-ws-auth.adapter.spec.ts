import { DashboardWebSocketAuthAdapter } from "./dashboard-ws-auth.adapter";
import { WsTicketService } from "../services/ws-ticket.service";
import { WsTicketController } from "../controllers/ws-ticket.controller";
import { JwtService } from "@nestjs/jwt";

describe("WebSocket Ticket-based Authentication (#169)", () => {
  let ticketService: WsTicketService;
  let adapter: DashboardWebSocketAuthAdapter;
  let mockRedis: any;
  let redisStore: Map<string, { value: string; ttl: number }>;
  let jwtService: JwtService;

  beforeEach(() => {
    redisStore = new Map();

    // Mock Redis instance mimicking ioredis
    mockRedis = {
      set: jest.fn(async (key: string, value: string, mode: string, ttl: number) => {
        redisStore.set(key, { value, ttl });
        return "OK";
      }),
      setex: jest.fn(async (key: string, ttl: number, value: string) => {
        redisStore.set(key, { value, ttl });
        return "OK";
      }),
      get: jest.fn(async (key: string) => {
        const item = redisStore.get(key);
        return item ? item.value : null;
      }),
      del: jest.fn(async (key: string) => {
        const existed = redisStore.delete(key);
        return existed ? 1 : 0;
      }),
      eval: jest.fn(async (script: string, numKeys: number, key: string) => {
        const item = redisStore.get(key);
        if (item) {
          redisStore.delete(key);
          return item.value;
        }
        return null;
      }),
    };

    ticketService = new WsTicketService(mockRedis);

    jwtService = new JwtService({
      secret: "test-secret-key-12345",
    });

    adapter = new DashboardWebSocketAuthAdapter(undefined, ticketService);
    // Inject jwtService for fallback testing
    (adapter as any).jwtService = jwtService;
  });

  afterEach(() => {
    ticketService.onModuleDestroy();
  });

  function createMockSocket(handshake: any = {}) {
    return {
      id: "socket-test-1",
      handshake: {
        headers: {},
        query: {},
        auth: {},
        ...handshake,
      },
      user: undefined,
    };
  }

  describe("WsTicketService", () => {
    it("should issue a short-lived ticket with 30s TTL in Redis", async () => {
      const ticket = await ticketService.createTicket("user-123", { role: "admin" });

      expect(ticket).toBeDefined();
      expect(ticket.startsWith("wst_")).toBe(true);

      const redisKey = `${WsTicketService.TICKET_PREFIX}${ticket}`;
      expect(mockRedis.set).toHaveBeenCalledWith(
        redisKey,
        expect.stringContaining('"userId":"user-123"'),
        "EX",
        30,
      );
    });

    it("should invalidate the ticket immediately upon consumption", async () => {
      const ticket = await ticketService.createTicket("user-123");

      // First consumption succeeds
      const consumed = await ticketService.validateAndConsumeTicket(ticket);
      expect(consumed).toBeDefined();
      expect(consumed?.userId).toBe("user-123");

      // Second consumption fails because it was immediately invalidated
      const secondAttempt = await ticketService.validateAndConsumeTicket(ticket);
      expect(secondAttempt).toBeNull();
    });
  });

  describe("DashboardWebSocketAuthAdapter", () => {
    it("should authenticate connection using single-use ticket in query parameter", async () => {
      const ticket = await ticketService.createTicket("user-456");

      const socket = createMockSocket({
        query: { ticket },
      });

      const authenticated = await adapter.authenticate(socket);
      expect(authenticated).toBe(true);
      expect(socket.user).toBeDefined();
      expect(socket.user?.id).toBe("user-456");
    });

    it("should authenticate connection using single-use ticket in auth object", async () => {
      const ticket = await ticketService.createTicket("user-789");

      const socket = createMockSocket({
        auth: { ticket },
      });

      const authenticated = await adapter.authenticate(socket);
      expect(authenticated).toBe(true);
      expect(socket.user?.id).toBe("user-789");
    });

    it("should verify tickets cannot be reused to connect twice", async () => {
      const ticket = await ticketService.createTicket("user-multi-connect");

      const firstSocket = createMockSocket({
        query: { ticket },
      });

      // First connection succeeds
      const firstResult = await adapter.authenticate(firstSocket);
      expect(firstResult).toBe(true);
      expect(firstSocket.user?.id).toBe("user-multi-connect");

      // Second connection with the same ticket MUST FAIL
      const secondSocket = createMockSocket({
        id: "socket-test-2",
        query: { ticket },
      });

      const secondResult = await adapter.authenticate(secondSocket);
      expect(secondResult).toBe(false);
      expect(secondSocket.user).toBeUndefined();
    });

    it("should reject connection when ticket is expired", async () => {
      const now = Date.now();
      const jestSpy = jest.spyOn(Date, "now");

      // Create ticket at T=0
      jestSpy.mockReturnValue(now);
      const ticket = await ticketService.createTicket("user-expired");

      // Advance time past 30 seconds TTL (T = 31 seconds)
      jestSpy.mockReturnValue(now + 31000);

      // Simulate Redis TTL expiry
      const redisKey = `${WsTicketService.TICKET_PREFIX}${ticket}`;
      redisStore.delete(redisKey);

      const socket = createMockSocket({
        query: { ticket },
      });

      const authenticated = await adapter.authenticate(socket);
      expect(authenticated).toBe(false);

      jestSpy.mockRestore();
    });

    it("should reject WebSocket connections attempting to use long-lived query parameter tokens", async () => {
      const validJwt = jwtService.sign({ sub: "user-attacker" });

      const socket = createMockSocket({
        query: { token: validJwt },
      });

      // Long-lived tokens in query parameters must be rejected to prevent log leakage
      const authenticated = await adapter.authenticate(socket);
      expect(authenticated).toBe(false);
      expect(socket.user).toBeUndefined();
    });

    it("should still allow authentication via authorization header", async () => {
      const validJwt = jwtService.sign({ sub: "user-legit" });

      const socket = createMockSocket({
        headers: {
          authorization: `Bearer ${validJwt}`,
        },
      });

      const authenticated = await adapter.authenticate(socket);
      expect(authenticated).toBe(true);
      expect(socket.user?.id).toBe("user-legit");
    });
  });

  describe("WsTicketController", () => {
    it("should issue a single-use ticket with 30s expiry for authenticated requests", async () => {
      const controller = new WsTicketController(ticketService);

      const mockReq = {
        user: { userId: "user-controller-test", email: "user@test.com" },
      };

      const response = await controller.issueTicket(mockReq);

      expect(response).toBeDefined();
      expect(response.ticket).toBeDefined();
      expect(typeof response.ticket).toBe("string");
      expect(response.expiresIn).toBe(30);

      // Verify the issued ticket can be consumed
      const validated = await ticketService.validateAndConsumeTicket(response.ticket);
      expect(validated?.userId).toBe("user-controller-test");
    });
  });
});

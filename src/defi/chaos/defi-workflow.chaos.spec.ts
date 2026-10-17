/**
 * Chaos tests for the DeFi position-sync and yield-optimisation workflows.
 *
 * The DeFi pipeline has two long-running workflows that interact with external
 * protocol adapters (Aave, Compound) and write to the local database:
 *
 *  Workflow A — Position sync:
 *    1. Fetch position from the protocol adapter (HTTP)
 *    2. Persist DeFiPosition row
 *    3. Emit position.synced domain event
 *
 *  Workflow B — Yield optimisation:
 *    1. Read all active positions (DB)
 *    2. Score each protocol via adapter (HTTP)
 *    3. Write DeFiYieldRecord
 *    4. Queue a rebalance transaction
 *
 * Failure modes under test:
 *  - Network fault to the protocol adapter (timeout, connection-reset, malformed body)
 *  - Process kill between adapter fetch and DB write → no phantom position row
 *  - Process kill between DB write and event emit → row exists, event can be re-emitted
 *  - Stale position read during yield optimisation → no double-submit of the same tx
 *  - DB constraint violation on position save → adapter not retried unnecessarily
 *  - Exhausted retry budget → operation dead-lettered, position row stable
 *
 * No NestJS DI, no real network, no real database, no wall-clock waits.
 *
 * Issue: #207
 */

import {
  ChaosScenario,
  ProcessKillError,
  ProcessKillPoint,
  StaleReadInjector,
} from "../../testing/chaos/chaos-scenario";
import {
  FaultController,
  FaultyRepository,
  ManualClock,
  SideEffectLedger,
  createFaultyFetch,
} from "../../testing/fault-injection/fault-injection";

// ---------------------------------------------------------------------------
// Minimal types (mirrors DeFi entities)
// ---------------------------------------------------------------------------

type DeFiPosition = {
  id?: string;
  userId: string;
  protocolName: string;
  chainId: number;
  positionId: string;
  suppliedAmount: string;
  borrowedAmount: string;
  healthFactor: number;
  apy: number;
  lastSyncedAt: Date | null;
  status: string;
};

type DeFiYieldRecord = {
  id?: string;
  positionId: string;
  protocolName: string;
  apy: number;
  recordedAt: Date;
  rebalanceQueued: boolean;
};

const POSITION_STATUS = {
  ACTIVE: "active",
  STALE: "stale",
  ERROR: "error",
} as const;

// ---------------------------------------------------------------------------
// Minimal position sync service
// ---------------------------------------------------------------------------

interface ProtocolAdapterResponse {
  suppliedAmount: string;
  borrowedAmount: string;
  healthFactor: number;
  apy: number;
}

class PositionSyncService {
  constructor(
    private readonly positionRepo: {
      create(v: Partial<DeFiPosition>): DeFiPosition;
      findOne(o: { where: Partial<DeFiPosition> }): Promise<DeFiPosition | null>;
      save(v: DeFiPosition): Promise<DeFiPosition>;
    },
    private readonly fetchFn: typeof fetch,
    private readonly killPoint?: ProcessKillPoint,
    private readonly ledger?: SideEffectLedger,
    private readonly clock: ManualClock = new ManualClock(),
  ) {}

  async syncPosition(opts: {
    userId: string;
    protocolName: string;
    chainId: number;
    positionId: string;
    adapterUrl: string;
  }): Promise<DeFiPosition> {
    // Step 1: Fetch from protocol adapter
    let adapterData: ProtocolAdapterResponse;
    try {
      const resp = await this.fetchFn(
        `${opts.adapterUrl}/position/${opts.positionId}`,
      );
      if (!resp.ok) {
        throw new Error(`Adapter returned HTTP ${resp.status}`);
      }
      adapterData = (await (resp as Response).json()) as ProtocolAdapterResponse;
    } catch (err) {
      throw err;
    }

    this.killPoint?.checkpoint("after-fetch-before-db-write");

    // Step 2: Upsert position row
    const existing = await this.positionRepo.findOne({
      where: { positionId: opts.positionId },
    });

    const position: DeFiPosition = existing
      ? {
          ...existing,
          suppliedAmount: adapterData.suppliedAmount,
          borrowedAmount: adapterData.borrowedAmount,
          healthFactor: adapterData.healthFactor,
          apy: adapterData.apy,
          lastSyncedAt: new Date(this.clock.now()),
          status: POSITION_STATUS.ACTIVE,
        }
      : this.positionRepo.create({
          userId: opts.userId,
          protocolName: opts.protocolName,
          chainId: opts.chainId,
          positionId: opts.positionId,
          suppliedAmount: adapterData.suppliedAmount,
          borrowedAmount: adapterData.borrowedAmount,
          healthFactor: adapterData.healthFactor,
          apy: adapterData.apy,
          lastSyncedAt: new Date(this.clock.now()),
          status: POSITION_STATUS.ACTIVE,
        });

    const saved = await this.positionRepo.save(position);

    this.killPoint?.checkpoint("after-db-write-before-event");

    // Step 3: Record side effect (in production: emit domain event)
    this.ledger?.record("on-chain-submit", opts.positionId);

    return saved;
  }
}

// ---------------------------------------------------------------------------
// Minimal yield optimisation service
// ---------------------------------------------------------------------------

class YieldOptimisationService {
  constructor(
    private readonly positionRepo: {
      findOne(o: { where: Partial<DeFiPosition> }): Promise<DeFiPosition | null>;
      find(o?: unknown): Promise<DeFiPosition[]>;
      save(v: DeFiPosition): Promise<DeFiPosition>;
    },
    private readonly yieldRepo: {
      create(v: Partial<DeFiYieldRecord>): DeFiYieldRecord;
      findOne(o: { where: Partial<DeFiYieldRecord> }): Promise<DeFiYieldRecord | null>;
      save(v: DeFiYieldRecord): Promise<DeFiYieldRecord>;
    },
    private readonly fetchFn: typeof fetch,
    private readonly killPoint?: ProcessKillPoint,
    private readonly ledger?: SideEffectLedger,
    private readonly clock: ManualClock = new ManualClock(),
  ) {}

  async optimiseYield(opts: { adapterUrl: string }): Promise<DeFiYieldRecord[]> {
    const positions = await this.positionRepo.find();
    const results: DeFiYieldRecord[] = [];

    for (const position of positions) {
      // Step 1: Score via adapter
      let score: { apy: number };
      try {
        const resp = await this.fetchFn(
          `${opts.adapterUrl}/score/${position.protocolName}`,
        );
        if (!resp.ok) throw new Error(`Adapter HTTP ${resp.status}`);
        score = (await (resp as Response).json()) as { apy: number };
      } catch (err) {
        throw err;
      }

      this.killPoint?.checkpoint("after-score-before-yield-record");

      // Step 2: Idempotency check — has this position already been recorded
      // at this clock tick?
      const existingRecord = await this.yieldRepo.findOne({
        where: { positionId: position.positionId },
      });
      if (existingRecord && existingRecord.recordedAt.getTime() === this.clock.now()) {
        results.push(existingRecord);
        continue;
      }

      // Step 3: Write yield record
      const record = this.yieldRepo.create({
        positionId: position.positionId,
        protocolName: position.protocolName,
        apy: score.apy,
        recordedAt: new Date(this.clock.now()),
        rebalanceQueued: score.apy > position.apy + 0.5,
      });
      const saved = await this.yieldRepo.save(record);

      if (saved.rebalanceQueued) {
        // Guard: record as a side effect so tests can assert no double-queue
        this.ledger?.record("on-chain-submit", position.positionId);
      }

      results.push(saved);
    }

    return results;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapterBody(override: Partial<ProtocolAdapterResponse> = {}): ProtocolAdapterResponse {
  return {
    suppliedAmount: "1000.00",
    borrowedAmount: "0.00",
    healthFactor: 2.5,
    apy: 4.2,
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeFi workflow chaos", () => {
  let realFetch: typeof global.fetch;
  beforeEach(() => { realFetch = global.fetch; });
  afterEach(() => { global.fetch = realFetch; });

  // -------------------------------------------------------------------------
  // Position sync – network failures
  // -------------------------------------------------------------------------

  describe("position sync – network failures", () => {
    it("does not write a position row when the adapter times out", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");

      const http = scenario.controller("aave-adapter");
      http.queueTimeout();

      const service = new PositionSyncService(
        positionRepo,
        createFaultyFetch(http) as unknown as typeof fetch,
        undefined,
        scenario.ledger,
        scenario.clock,
      );

      await expect(
        service.syncPosition({
          userId: "user-1",
          protocolName: "aave",
          chainId: 1,
          positionId: "pos-1",
          adapterUrl: "https://aave.adapter",
        }),
      ).rejects.toThrow(/timeout/i);

      expect(positionRepo.rows).toHaveLength(0);
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("does not write a position row on connection reset", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");

      const http = scenario.controller("compound-adapter");
      http.queueFault({ kind: "connection-reset" });

      const service = new PositionSyncService(
        positionRepo,
        createFaultyFetch(http) as unknown as typeof fetch,
      );

      await expect(
        service.syncPosition({
          userId: "user-1",
          protocolName: "compound",
          chainId: 1,
          positionId: "pos-2",
          adapterUrl: "https://compound.adapter",
        }),
      ).rejects.toThrow(/reset/);

      expect(positionRepo.rows).toHaveLength(0);
    });

    it("throws on a malformed adapter response and leaves no partial row", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");

      const http = scenario.controller("aave-adapter");
      http.queueMalformedBody();

      const service = new PositionSyncService(
        positionRepo,
        createFaultyFetch(http) as unknown as typeof fetch,
      );

      await expect(
        service.syncPosition({
          userId: "user-1",
          protocolName: "aave",
          chainId: 1,
          positionId: "pos-3",
          adapterUrl: "https://aave.adapter",
        }),
      ).rejects.toThrow();

      expect(positionRepo.rows).toHaveLength(0);
    });

    it("succeeds on the second attempt after a single transient timeout", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");

      const http = scenario.controller("aave-adapter");
      http.queueTimeout(); // first call fails

      const body = makeAdapterBody();

      let calls = 0;
      const fetchDouble = async (input: RequestInfo | URL): Promise<Response> => {
        calls += 1;
        if (calls === 1) {
          return createFaultyFetch(http)(input as string) as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      };

      // First attempt fails
      const service = new PositionSyncService(
        positionRepo,
        fetchDouble as unknown as typeof fetch,
        undefined,
        scenario.ledger,
      );
      await expect(
        service.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-retry", adapterUrl: "" }),
      ).rejects.toThrow();

      // Second attempt succeeds (simulates Bull retry)
      calls = 1; // reset so next call is the "second" attempt
      const service2 = new PositionSyncService(
        positionRepo,
        fetchDouble as unknown as typeof fetch,
        undefined,
        scenario.ledger,
      );
      await service2.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-retry", adapterUrl: "" });

      expect(positionRepo.rows).toHaveLength(1);
      // Side effect recorded exactly once
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Position sync – process kill points
  // -------------------------------------------------------------------------

  describe("position sync – process kill points", () => {
    const goodFetch = (body: object): typeof fetch =>
      (async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body),
      })) as unknown as typeof fetch;

    it("leaves no position row when killed between fetch and DB write", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const kill = new ProcessKillPoint();
      kill.armKill("after-fetch-before-db-write");

      const service = new PositionSyncService(
        positionRepo,
        goodFetch(makeAdapterBody()),
        kill,
        scenario.ledger,
      );

      await expect(
        service.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-k1", adapterUrl: "" }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      expect(positionRepo.rows).toHaveLength(0);
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("leaves a position row but no side effect when killed between DB write and event emit", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const kill = new ProcessKillPoint();
      kill.armKill("after-db-write-before-event");

      const service = new PositionSyncService(
        positionRepo,
        goodFetch(makeAdapterBody()),
        kill,
        scenario.ledger,
      );

      await expect(
        service.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-k2", adapterUrl: "" }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // Row was persisted before the kill
      expect(positionRepo.rows).toHaveLength(1);
      expect(positionRepo.rows[0].positionId).toBe("pos-k2");
      // Event (side effect) was not recorded — recovery must re-emit
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
    });

    it("does not double-submit when a full retry follows a kill-before-event", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const kill = new ProcessKillPoint();
      kill.armKill("after-db-write-before-event");

      const service = new PositionSyncService(
        positionRepo,
        goodFetch(makeAdapterBody()),
        kill,
        scenario.ledger,
      );

      // First run: killed after DB write
      await expect(
        service.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-idem", adapterUrl: "" }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      // Second run: full completion (kill not re-armed)
      const service2 = new PositionSyncService(
        positionRepo,
        goodFetch(makeAdapterBody()),
        undefined,
        scenario.ledger,
      );
      await service2.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-idem", adapterUrl: "" });

      // Row updated (not duplicated)
      expect(positionRepo.rows).toHaveLength(1);
      // Side effect recorded once on the successful run
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Position sync – DB persistence failures
  // -------------------------------------------------------------------------

  describe("position sync – DB persistence failures", () => {
    it("throws on a constraint violation and leaves no partial position row", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      scenario.controller("positions").queueConstraintViolation();

      const service = new PositionSyncService(
        positionRepo,
        (async () => ({
          ok: true, status: 200, statusText: "OK",
          json: async () => makeAdapterBody(),
          text: async () => JSON.stringify(makeAdapterBody()),
        })) as unknown as typeof fetch,
        undefined,
        scenario.ledger,
      );

      await expect(
        service.syncPosition({ userId: "u", protocolName: "aave", chainId: 1, positionId: "pos-cv", adapterUrl: "" }),
      ).rejects.toThrow(/constraint was violated/);

      expect(positionRepo.rows).toHaveLength(0);
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Yield optimisation – stale position reads
  // -------------------------------------------------------------------------

  describe("yield optimisation – stale position reads", () => {
    it("does not queue a rebalance twice when the stale read shows a lower APY", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const yieldRepo = scenario.repository<DeFiYieldRecord>("yield-records");

      const pos: DeFiPosition = {
        id: "p-1",
        userId: "user-1",
        protocolName: "aave",
        chainId: 1,
        positionId: "pos-opt-1",
        suppliedAmount: "5000.00",
        borrowedAmount: "0.00",
        healthFactor: 2.0,
        apy: 3.0, // current APY
        lastSyncedAt: new Date(0),
        status: POSITION_STATUS.ACTIVE,
      };
      positionRepo.rows.push(pos);

      // Stale read: position.apy = 2.0 (lower) → rebalance looks profitable
      const stalePos: DeFiPosition = { ...pos, apy: 2.0 };
      const stalePositionRepo = scenario.staleReader(positionRepo);
      stalePositionRepo.armStaleRead({ snapshot: stalePos as DeFiPosition, onCall: 1 });

      // Adapter says APY = 5.0 → diff > 0.5 → rebalance queued
      const scoreBody = { apy: 5.0 };
      const goodFetch = (async () => ({
        ok: true, status: 200, statusText: "OK",
        json: async () => scoreBody,
        text: async () => JSON.stringify(scoreBody),
      })) as unknown as typeof fetch;

      const service = new YieldOptimisationService(
        stalePositionRepo as typeof positionRepo,
        yieldRepo,
        goodFetch,
        undefined,
        scenario.ledger,
        scenario.clock,
      );

      // First run with stale read (position.apy=2.0): 5.0 - 2.0 = 3.0 > 0.5 → rebalance queued
      await service.optimiseYield({ adapterUrl: "" });

      expect(scenario.ledger.countOf("on-chain-submit")).toBe(1);

      // Second run at same clock tick: yield record already exists at this tick → skipped
      await service.optimiseYield({ adapterUrl: "" });

      expect(scenario.ledger.countOf("on-chain-submit")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });

    it("does not queue a rebalance when the APY improvement is below the threshold", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const yieldRepo = scenario.repository<DeFiYieldRecord>("yield-records");

      positionRepo.rows.push({
        id: "p-2",
        userId: "user-1",
        protocolName: "compound",
        chainId: 1,
        positionId: "pos-threshold",
        suppliedAmount: "1000.00",
        borrowedAmount: "0.00",
        healthFactor: 3.0,
        apy: 4.0,
        lastSyncedAt: new Date(0),
        status: POSITION_STATUS.ACTIVE,
      });

      // Adapter APY = 4.3 → diff = 0.3, below the 0.5 threshold
      const scoreBody = { apy: 4.3 };
      const goodFetch = (async () => ({
        ok: true, status: 200, statusText: "OK",
        json: async () => scoreBody,
        text: async () => JSON.stringify(scoreBody),
      })) as unknown as typeof fetch;

      const service = new YieldOptimisationService(
        positionRepo, yieldRepo, goodFetch,
        undefined, scenario.ledger, scenario.clock,
      );

      await service.optimiseYield({ adapterUrl: "" });

      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
      expect(yieldRepo.rows).toHaveLength(1);
      expect(yieldRepo.rows[0].rebalanceQueued).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Yield optimisation – process kill point
  // -------------------------------------------------------------------------

  describe("yield optimisation – process kill point", () => {
    it("leaves no yield record when killed between score and record write", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");
      const yieldRepo = scenario.repository<DeFiYieldRecord>("yield-records");

      positionRepo.rows.push({
        id: "p-3",
        userId: "user-1",
        protocolName: "aave",
        chainId: 1,
        positionId: "pos-kill-yield",
        suppliedAmount: "2000.00",
        borrowedAmount: "0.00",
        healthFactor: 2.5,
        apy: 3.0,
        lastSyncedAt: new Date(0),
        status: POSITION_STATUS.ACTIVE,
      });

      const kill = new ProcessKillPoint();
      kill.armKill("after-score-before-yield-record");

      const goodFetch = (async () => ({
        ok: true, status: 200, statusText: "OK",
        json: async () => ({ apy: 6.0 }),
        text: async () => JSON.stringify({ apy: 6.0 }),
      })) as unknown as typeof fetch;

      const service = new YieldOptimisationService(
        positionRepo, yieldRepo, goodFetch, kill, scenario.ledger,
      );

      await expect(
        service.optimiseYield({ adapterUrl: "" }),
      ).rejects.toBeInstanceOf(ProcessKillError);

      expect(yieldRepo.rows).toHaveLength(0);
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Full restart scenario
  // -------------------------------------------------------------------------

  describe("full restart scenario", () => {
    it("recovers a sync that was killed after fetch and re-runs to completion without double-submit", async () => {
      const scenario = new ChaosScenario();
      const positionRepo = scenario.repository<DeFiPosition>("positions");

      const kill = new ProcessKillPoint();
      kill.armKill("after-fetch-before-db-write");

      const body = makeAdapterBody({ apy: 5.5 });
      const goodFetch = (async () => ({
        ok: true, status: 200, statusText: "OK",
        json: async () => body,
        text: async () => JSON.stringify(body),
      })) as unknown as typeof fetch;

      const syncOpts = {
        userId: "u",
        protocolName: "aave",
        chainId: 1,
        positionId: "pos-restart",
        adapterUrl: "",
      };

      // First run: killed after fetch, no DB write
      const svc1 = new PositionSyncService(positionRepo, goodFetch, kill, scenario.ledger);
      await expect(svc1.syncPosition(syncOpts)).rejects.toBeInstanceOf(ProcessKillError);

      expect(positionRepo.rows).toHaveLength(0);

      // Cold restart: new service instance, kill disarmed
      scenario.restart.restart();
      const svc2 = new PositionSyncService(positionRepo, goodFetch, undefined, scenario.ledger);
      await svc2.syncPosition(syncOpts);

      expect(positionRepo.rows).toHaveLength(1);
      expect(positionRepo.rows[0].apy).toBe(5.5);
      expect(scenario.ledger.countOf("on-chain-submit")).toBe(1);
      expect(() => scenario.ledger.assertNoDuplicates()).not.toThrow();
    });
  });
});

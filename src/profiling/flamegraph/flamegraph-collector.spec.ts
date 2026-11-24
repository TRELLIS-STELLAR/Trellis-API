import { ConflictException, ForbiddenException } from "@nestjs/common";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Role } from "../../common/guard/roles.enum";
import { CpuProfile } from "./flamegraph";
import {
  FlamegraphCollector,
  FlamegraphCollectorOptions,
  ProfileSource,
} from "./flamegraph-collector";
import { MemoryThresholdTrigger } from "./memory-threshold-trigger";

const admin = { id: "admin-1", roles: [Role.ADMIN] };
const user = { id: "u-1", roles: [Role.USER] };

const profile: CpuProfile = {
  startTime: 0,
  endTime: 1000,
  nodes: [
    { id: 1, callFrame: { functionName: "(root)" }, children: [2] },
    { id: 2, callFrame: { functionName: "hot" } },
  ],
  samples: [2, 2, 2, 2],
};

const silentLogger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe("FlamegraphCollector (#527)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flamegraph-"));
    silentLogger.log.mockClear();
    silentLogger.warn.mockClear();
    silentLogger.error.mockClear();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const build = (overrides: Partial<FlamegraphCollectorOptions> = {}) => {
    const profileSource: jest.MockedFunction<ProfileSource> = jest
      .fn<Promise<CpuProfile>, [number]>()
      .mockResolvedValue(profile);
    const collector = new FlamegraphCollector({
      outputDir: dir,
      profileSource,
      isEnabled: () => true,
      sleep: async () => undefined,
      retryDelayMs: 0,
      logger: silentLogger,
      ...overrides,
    });
    return { collector, profileSource };
  };

  describe("normal path", () => {
    it("captures for an admin and writes JSON and folded artifacts", async () => {
      const { collector, profileSource } = build({ durationMs: 1234 });

      const artifact = await collector.collect(admin);

      expect(profileSource).toHaveBeenCalledWith(1234);
      expect(artifact).toMatchObject({
        reason: "manual",
        durationMs: 1234,
        attempts: 1,
        totalSamples: 4,
        topFrames: [{ name: "hot", self: 4 }],
      });
      expect(fs.readFileSync(artifact.files.folded, "utf8")).toBe(
        "(root);hot 4\n",
      );
      const json = JSON.parse(fs.readFileSync(artifact.files.json, "utf8"));
      expect(json.root.name).toBe("(root)");
      expect(json.artifact.id).toBe(artifact.id);
    });

    it("leaves no temp files behind after a successful capture", async () => {
      const { collector } = build();
      await collector.collect(admin);
      expect(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });
  });

  describe("authorization path", () => {
    it("refuses a non-admin before any profile is started", async () => {
      const { collector, profileSource } = build();

      await expect(collector.collect(user)).rejects.toBeInstanceOf(
        ForbiddenException,
      );

      expect(profileSource).not.toHaveBeenCalled();
      expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
    });
  });

  describe("feature gate", () => {
    it("refuses capture when profiling is disabled, even for an admin", async () => {
      const { collector, profileSource } = build({ isEnabled: () => false });

      await expect(collector.collect(admin)).rejects.toThrow(
        /Profiling is disabled/,
      );
      expect(profileSource).not.toHaveBeenCalled();
    });
  });

  describe("concurrency", () => {
    it("rejects a second capture while one is in progress, and recovers after it finishes", async () => {
      let release: (p: CpuProfile) => void = () => undefined;
      const profileSource = jest.fn(
        () => new Promise<CpuProfile>((resolve) => (release = resolve)),
      );
      const { collector } = build({ profileSource });

      const first = collector.collect(admin);
      await expect(collector.collect(admin)).rejects.toBeInstanceOf(
        ConflictException,
      );

      release(profile);
      await expect(first).resolves.toMatchObject({ reason: "manual" });

      profileSource.mockImplementation(async () => profile);
      await expect(collector.collect(admin)).resolves.toBeDefined();
    });
  });

  describe("failure and retry paths", () => {
    it("retries a failing profile source and succeeds on the second attempt", async () => {
      const profileSource = jest
        .fn<Promise<CpuProfile>, [number]>()
        .mockRejectedValueOnce(new Error("inspector busy"))
        .mockResolvedValueOnce(profile);
      const sleeps: number[] = [];
      const { collector } = build({
        profileSource,
        maxAttempts: 3,
        retryDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      });

      const artifact = await collector.collect(admin);

      expect(artifact.attempts).toBe(2);
      expect(sleeps).toEqual([100]);
    });

    it("fails after exhausting attempts, writes nothing, and releases the in-flight lock", async () => {
      const profileSource = jest
        .fn<Promise<CpuProfile>, [number]>()
        .mockRejectedValue(new Error("inspector unavailable"));
      const { collector } = build({ profileSource, maxAttempts: 2 });

      await expect(collector.collect(admin)).rejects.toThrow(
        "inspector unavailable",
      );
      expect(profileSource).toHaveBeenCalledTimes(2);
      expect(fs.readdirSync(dir)).toEqual([]);

      // The lock is released, so the next request is not blocked by the failure.
      profileSource.mockResolvedValueOnce(profile);
      await expect(collector.collect(admin)).resolves.toBeDefined();
    });

    it("rejects a malformed profile and writes no artifact", async () => {
      const { collector } = build({
        profileSource: async () => ({ startTime: 0, endTime: 1, nodes: [] }),
      });
      await expect(collector.collect(admin)).rejects.toThrow(/no nodes/);
      expect(fs.readdirSync(dir)).toEqual([]);
    });
  });

  describe("memory threshold trigger", () => {
    const hot = { usedHeapSize: 90, heapSizeLimit: 100 };
    const cool = { usedHeapSize: 10, heapSizeLimit: 100 };

    it("captures automatically when the trigger fires, tagged as memory-threshold", async () => {
      const trigger = new MemoryThresholdTrigger({
        threshold: 0.8,
        cooldownMs: 0,
      });
      const { collector, profileSource } = build({ trigger });

      const artifact = await collector.onMemorySample(hot);

      expect(artifact?.reason).toBe("memory-threshold");
      expect(profileSource).toHaveBeenCalledTimes(1);
    });

    it("does nothing while usage is below the threshold", async () => {
      const trigger = new MemoryThresholdTrigger({ threshold: 0.8 });
      const { collector, profileSource } = build({ trigger });

      expect(await collector.onMemorySample(cool)).toBeNull();
      expect(profileSource).not.toHaveBeenCalled();
    });

    it("does nothing when no trigger is configured", async () => {
      const { collector, profileSource } = build();
      expect(await collector.onMemorySample(hot)).toBeNull();
      expect(profileSource).not.toHaveBeenCalled();
    });

    it("never throws from the monitoring loop when an automatic capture fails", async () => {
      const trigger = new MemoryThresholdTrigger({ threshold: 0.8 });
      const { collector } = build({
        trigger,
        maxAttempts: 1,
        profileSource: async () => {
          throw new Error("boom");
        },
      });

      await expect(collector.onMemorySample(hot)).resolves.toBeNull();
      expect(silentLogger.error).toHaveBeenCalledWith(
        expect.stringMatching(/capture failed: boom/),
      );
    });

    it("does not capture when profiling is disabled, even though the threshold was crossed", async () => {
      const trigger = new MemoryThresholdTrigger({ threshold: 0.8 });
      const { collector, profileSource } = build({
        trigger,
        isEnabled: () => false,
      });

      expect(await collector.onMemorySample(hot)).toBeNull();
      expect(profileSource).not.toHaveBeenCalled();
    });
  });
});

/**
 * Behaviour of the protocol changelog read model and its HTTP surface.
 *
 * Covers normal, failure, retry (reload) and authorization paths per issue #352.
 *
 * Issue: #126 / #352
 */

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";
import { ExecutionContext } from "@nestjs/common";
import { join } from "path";
import { ProtocolChangelogService } from "./protocol-changelog.service";
import { ChangelogController } from "./changelog.controller";
import { IS_PUBLIC_KEY } from "../common/decorators/public.decorator";

const REPO_ROOT = join(__dirname, "..", "..");

function buildService(changelogPath?: string): ProtocolChangelogService {
  return new ProtocolChangelogService(
    new ConfigService(changelogPath ? { CHANGELOG_PATH: changelogPath } : {}),
  );
}

describe("ProtocolChangelogService", () => {
  describe("query", () => {
    it("returns every entry, newest first, when unfiltered", () => {
      const view = buildService().query();

      expect(view.project).toBe("trellis-api");
      expect(view.schemaVersion).toBe("1.0.0");
      expect(view.entries.length).toBeGreaterThan(0);
      expect(view.latestVersion).toBe("0.2.0");
    });

    it("returns only entries newer than the caller's version", () => {
      const view = buildService().query({ since: "0.1.0" });

      expect(view.entries.length).toBeGreaterThan(0);
      expect(
        view.entries.every((entry) => entry.version === "0.2.0"),
      ).toBe(true);
    });

    it("returns nothing when the caller is already on the newest version", () => {
      const view = buildService().query({ since: "99.0.0" });

      expect(view.entries).toEqual([]);
      expect(view.highestImpact).toBeNull();
      expect(view.migrationRequired).toBe(false);
      expect(view.affectedPaths).toEqual([]);
      expect(view.latestVersion).toBe("0.2.0");
    });

    it("filters by impact", () => {
      const view = buildService().query({ impact: ["breaking"] });

      expect(view.entries.every((entry) => entry.impact === "breaking")).toBe(
        true,
      );
    });

    it("filters by release status", () => {
      const view = buildService().query({ status: "released" });

      expect(view.entries.every((entry) => entry.status === "released")).toBe(
        true,
      );
    });

    it("reports the worst impact and whether the caller must act", () => {
      const view = buildService().query();

      expect(view.highestImpact).toBe("compatible");
      expect(view.migrationRequired).toBe(false);
      expect(view.affectedPaths).toEqual(
        expect.arrayContaining([
          "/changelog/protocol",
          "/health/dependencies",
          "/reconcile/stellar/transactions",
        ]),
      );
    });

    it("flags a migration for a breaking change between the versions", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/breaking-entry.json"),
      );
      const view = service.query();

      expect(view.highestImpact).toBe("breaking");
      expect(view.migrationRequired).toBe(true);
      expect(view.entries[0].migration.steps).toEqual([
        "Send ?details=standard to opt into the new response envelope.",
      ]);
    });
  });

  describe("failures", () => {
    it("refuses to serve a changelog that violates the rules", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/invalid-entry.json"),
      );

      expect(() => service.getDocument()).toThrow(/is invalid/);
    });

    it("refuses to serve a file that is not JSON", () => {
      const service = buildService(
        join(REPO_ROOT, "changelog/__fixtures__/not-json.json"),
      );

      expect(() => service.getDocument()).toThrow(/is not valid JSON/);
    });

    it("explains that a missing file cannot be read", () => {
      const service = buildService(join(REPO_ROOT, "changelog/nope.json"));

      expect(() => service.getDocument()).toThrow(/Unable to read/);
    });
  });

  describe("getSchema", () => {
    it("serves the JSON Schema that consumers can validate against", () => {
      const schema = buildService().getSchema() as {
        $defs: Record<string, unknown>;
      };

      expect(schema.$defs).toHaveProperty("entry");
      expect(schema.$defs).toHaveProperty("migration");
    });
  });
});

describe("ChangelogController", () => {
  it("returns the changelog for a public caller", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChangelogController],
      providers: [
        ProtocolChangelogService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();

    const body = moduleRef
      .get(ChangelogController)
      .getProtocolChangelog({ since: "0.1.0" });

    expect(body.schemaVersion).toBe("1.0.0");
    expect(body.entries.length).toBeGreaterThan(0);
    expect(body.affectedPaths).toContain("/changelog/protocol");
  });
});

describe("ProtocolChangelogService – retry / reload path", () => {
  it("reloads and returns a fresh document when the file is valid", () => {
    const service = buildService();
    // Warm the cache once.
    const first = service.getDocument();
    expect(first.entries.length).toBeGreaterThan(0);

    // Reload must succeed and return the same content (file has not changed).
    const second = service.reload();
    expect(second.project).toBe(first.project);
    expect(second.entries).toHaveLength(first.entries.length);
  });

  it("preserves the previous document when the reloaded file is invalid", () => {
    // Start from a known-good changelog.
    const service = buildService();
    const goodDoc = service.getDocument();
    expect(goodDoc.entries.length).toBeGreaterThan(0);

    // Swap to a bad path – reload must throw and NOT wipe the cache.
    (service as unknown as { configService: ConfigService }).configService =
      new ConfigService({ CHANGELOG_PATH: join(REPO_ROOT, "changelog/__fixtures__/invalid-entry.json") });

    expect(() => service.reload()).toThrow(/is invalid/);

    // The service must still answer queries from the old cache.
    const fallback = service.getDocument();
    expect(fallback.entries).toHaveLength(goodDoc.entries.length);
  });

  it("preserves the previous document when the reloaded file is missing", () => {
    const service = buildService();
    const goodDoc = service.getDocument();

    (service as unknown as { configService: ConfigService }).configService =
      new ConfigService({ CHANGELOG_PATH: join(REPO_ROOT, "changelog/does-not-exist.json") });

    expect(() => service.reload()).toThrow(/Unable to read/);

    expect(service.getDocument().entries).toHaveLength(goodDoc.entries.length);
  });

  it("recovers after a failed initial load once the path is corrected", () => {
    // Service starts with a broken path so onModuleInit logging fires.
    const service = buildService(join(REPO_ROOT, "changelog/nope.json"));
    // document is null – getDocument throws.
    expect(() => service.getDocument()).toThrow(/Unable to read/);

    // Swap to the real file and reload.
    (service as unknown as { configService: ConfigService }).configService =
      new ConfigService({});

    const recovered = service.reload();
    expect(recovered.entries.length).toBeGreaterThan(0);
    // Subsequent queries now work.
    expect(service.query().entries.length).toBeGreaterThan(0);
  });
});

describe("ChangelogController – authorization path", () => {
  it("the controller class is decorated with @Public so unauthenticated callers are allowed", () => {
    // The StrategyAuthGuard reads IS_PUBLIC_KEY from the class or handler
    // metadata. This test confirms the metadata is present, which means the
    // guard will return true without checking a token.
    const reflector = new Reflector();
    const meta = Reflect.getMetadata(IS_PUBLIC_KEY, ChangelogController);
    expect(meta).toBe(true);
  });

  it("the strategy auth guard grants access to a public route without a token", async () => {
    // Simulate what StrategyAuthGuard.canActivate() does for an unauthenticated
    // caller hitting GET /changelog/protocol.
    const reflector = new Reflector();
    const isPublic = reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      // handler metadata (getProtocolChangelog method)
      Reflect.getMetadata("method", ChangelogController.prototype, "getProtocolChangelog") ?? {},
      // class metadata
      ChangelogController,
    ]);

    // The class-level @Public() sets the flag; the guard returns true.
    expect(isPublic).toBe(true);
  });

  it("returns 200 with empty query params – no auth token supplied", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChangelogController],
      providers: [
        ProtocolChangelogService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();

    // Direct controller call with no auth context – mirrors the guard allowing
    // through because IS_PUBLIC_KEY is set.
    const body = moduleRef
      .get(ChangelogController)
      .getProtocolChangelog({});

    expect(body.schemaVersion).toBe("1.0.0");
    expect(body.migrationRequired).toBe(false);
  });

  it("returns only breaking entries when the impact filter is applied", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChangelogController],
      providers: [
        ProtocolChangelogService,
        { provide: ConfigService, useValue: new ConfigService({}) },
      ],
    }).compile();

    // Main changelog has no breaking entries; result set is empty but valid.
    const body = moduleRef
      .get(ChangelogController)
      .getProtocolChangelog({ impact: ["breaking"] });

    expect(body.entries.every((e) => e.impact === "breaking")).toBe(true);
    expect(body.highestImpact).toBeNull();
  });
});

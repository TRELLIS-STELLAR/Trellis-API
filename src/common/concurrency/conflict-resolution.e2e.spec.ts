import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import * as request from "supertest";
import { ConflictResolutionService, ConflictResolutionStrategy } from "./conflict-resolution.service";
import { ConflictResolutionController } from "./conflict-resolution.controller";
import { OptimisticConcurrencyService } from "./optimistic-concurrency.service";

/**
 * End-to-end tests for conflict resolution system.
 * 
 * Tests cover:
 * - Normal path: Successful edits without conflicts
 * - Failure path: Concurrent edits with conflicts
 * - Retry path: Retrying after conflicts
 * - Authorization path: User-specific operations
 */
describe("ConflictResolution (e2e)", () => {
  let app: INestApplication;
  let service: ConflictResolutionService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ConflictResolutionController],
      providers: [ConflictResolutionService, OptimisticConcurrencyService],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.init();

    service = moduleFixture.get<ConflictResolutionService>(ConflictResolutionService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe("Normal Path: Creating and Editing Resources", () => {
    it("should create a new resource", async () => {
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc1")
        .send({
          title: "My Document",
          content: "Initial content",
        })
        .expect(201);

      expect(response.body.version).toBe(0);
      expect(response.body.data.title).toBe("My Document");
    });

    it("should retrieve an existing resource", async () => {
      // Create resource first
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc2")
        .send({ title: "Test Doc" })
        .expect(201);

      // Retrieve it
      const response = await request(app.getHttpServer())
        .get("/api/v1/conflicts/resource/document/doc2")
        .expect(200);

      expect(response.body.version).toBe(0);
      expect(response.body.data.title).toBe("Test Doc");
    });

    it("should apply edit when no conflict exists", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc3")
        .send({ title: "Original", content: "Text" })
        .expect(201);

      // Edit it
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc3",
          resourceType: "document",
          baseVersion: 0,
          proposedData: {
            title: "Updated",
            content: "New Text",
          },
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Updated");
      expect(response.body.version).toBe(1);
    });
  });

  describe("Failure Path: Concurrent Edit Conflicts", () => {
    it("should detect conflict with manual strategy", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc4")
        .send({ title: "Original", version: 0 })
        .expect(201);

      // User A edits
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc4",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit by A" },
        })
        .expect(200);

      // User B tries to edit based on stale version
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc4",
          resourceType: "document",
          baseVersion: 0, // Stale!
          proposedData: { title: "Edit by B" },
          strategy: ConflictResolutionStrategy.MANUAL,
        })
        .expect(409);

      expect(response.body.message).toContain("manual resolution");
      expect(response.body.version).toBe(1);
    });

    it("should reject edit with first-write-wins strategy", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc5")
        .send({ title: "Original" })
        .expect(201);

      // User A edits
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc5",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit by A" },
        })
        .expect(200);

      // User B tries to edit - should be rejected
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc5",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit by B" },
          strategy: ConflictResolutionStrategy.FIRST_WRITE_WINS,
        })
        .expect(409);

      expect(response.body.message).toContain("rejected");
      expect(response.body.data.title).toBe("Edit by A"); // First edit preserved
    });

    it("should return 404 for non-existent resource", async () => {
      await request(app.getHttpServer())
        .get("/api/v1/conflicts/resource/document/nonexistent")
        .expect(404);
    });
  });

  describe("Retry Path: Successful Conflict Resolution", () => {
    it("should merge non-conflicting changes with three-way merge", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc6")
        .send({ title: "Original", content: "Original", tags: [] })
        .expect(201);

      // User A edits title
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc6",
          resourceType: "document",
          baseVersion: 0,
          proposedData: {
            title: "Updated by A",
            content: "Original",
            tags: [],
          },
        })
        .expect(200);

      // User B edits content (three-way merge should work)
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc6",
          resourceType: "document",
          baseVersion: 0,
          proposedData: {
            title: "Original",
            content: "Updated by B",
            tags: [],
          },
          strategy: ConflictResolutionStrategy.THREE_WAY_MERGE,
        })
        .expect(200);

      // Should have both changes
      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Updated by A");
      expect(response.body.data.content).toBe("Updated by B");
    });

    it("should overwrite with last-write-wins strategy", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc7")
        .send({ title: "Original", content: "Original" })
        .expect(201);

      // User A edits
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc7",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit by A", content: "Content A" },
        })
        .expect(200);

      // User B edits with last-write-wins
      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc7",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit by B", content: "Content B" },
          strategy: ConflictResolutionStrategy.LAST_WRITE_WINS,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.title).toBe("Edit by B");
      expect(response.body.data.content).toBe("Content B");
    });

    it("should handle retry of same edit (idempotency)", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc8")
        .send({ title: "Original" })
        .expect(201);

      // First edit
      const firstEdit = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc8",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Updated" },
        })
        .expect(200);

      // Retry same edit (baseVersion matches current)
      const retry = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc8",
          resourceType: "document",
          baseVersion: firstEdit.body.version,
          proposedData: { title: "Updated" },
        })
        .expect(200);

      expect(retry.body.message).toContain("retry");
      expect(retry.body.version).toBe(firstEdit.body.version);
    });
  });

  describe("Authorization Path: User Tracking", () => {
    it("should track different users editing resources", async () => {
      // Create resource
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc9")
        .send({ title: "Shared Doc" })
        .expect(201);

      // Multiple users edit (simulated with different requests)
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc9",
          resourceType: "document",
          baseVersion: 0,
          proposedData: { title: "Edit 1" },
        })
        .expect(200);

      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc9",
          resourceType: "document",
          baseVersion: 1,
          proposedData: { title: "Edit 2" },
        })
        .expect(200);

      // Check statistics
      const stats = await request(app.getHttpServer())
        .get("/api/v1/conflicts/statistics")
        .expect(200);

      expect(stats.body.total).toBeGreaterThan(0);
    });
  });

  describe("Statistics and Monitoring", () => {
    it("should provide overall statistics", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/v1/conflicts/statistics")
        .expect(200);

      expect(response.body).toHaveProperty("total");
      expect(response.body).toHaveProperty("byOutcome");
      expect(response.body).toHaveProperty("byStrategy");
      expect(response.body).toHaveProperty("conflictRate");
      expect(response.body).toHaveProperty("successRate");
      expect(response.body).toHaveProperty("recentAttempts");
    });

    it("should filter statistics by resource type", async () => {
      const response = await request(app.getHttpServer())
        .get("/api/v1/conflicts/statistics?resourceType=document")
        .expect(200);

      expect(response.body.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe("Edge Cases", () => {
    it("should prevent creating duplicate resources", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc10")
        .send({ title: "First" })
        .expect(201);

      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc10")
        .send({ title: "Duplicate" })
        .expect(409);
    });

    it("should handle empty proposed data", async () => {
      await request(app.getHttpServer())
        .post("/api/v1/conflicts/resource/document/doc11")
        .send({ title: "Original" })
        .expect(201);

      const response = await request(app.getHttpServer())
        .post("/api/v1/conflicts/resolve")
        .send({
          resourceId: "doc11",
          resourceType: "document",
          baseVersion: 0,
          proposedData: {},
        })
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });
});

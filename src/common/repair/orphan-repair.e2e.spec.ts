import { Test, TestingModule } from "@nestjs/testing";
import { DataSource } from "typeorm";
import { OrphanRepairAdapter, OrphanRepairConfig } from "./orphan-repair-adapter";
import { RepairJob } from "./repair-job";
import { FileRepairCheckpointStore } from "./file-repair-checkpoint-store";
import { Role } from "../guard/roles.enum";
import * as fs from "fs";
import * as path from "path";

describe("Orphan Repair with Checkpoints (e2e)", () => {
  let dataSource: DataSource;
  let adapter: OrphanRepairAdapter;
  let job: RepairJob<any>;
  let store: FileRepairCheckpointStore;
  const testCheckpointDir = path.join(__dirname, ".test-repair");

  const operator = {
    id: "test-operator",
    roles: [Role.MAINTAINER],
  };

  beforeAll(async () => {
    // Create test checkpoint directory
    if (!fs.existsSync(testCheckpointDir)) {
      fs.mkdirSync(testCheckpointDir, { recursive: true });
    }

    // Initialize in-memory SQLite database
    dataSource = new DataSource({
      type: "sqlite",
      database: ":memory:",
      synchronize: true,
      logging: false,
      entities: [],
    });

    await dataSource.initialize();

    // Create test tables
    await dataSource.query(`
      CREATE TABLE test_parents (
        id INTEGER PRIMARY KEY,
        name TEXT
      )
    `);

    await dataSource.query(`
      CREATE TABLE test_children (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER,
        value TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);

    // Insert test data
    await dataSource.query(`INSERT INTO test_parents (id, name) VALUES (1, 'parent-1')`);
    await dataSource.query(`INSERT INTO test_parents (id, name) VALUES (2, 'parent-2')`);

    // Create some valid children
    await dataSource.query(
      `INSERT INTO test_children (id, parent_id, value) VALUES (1, 1, 'valid-1')`,
    );
    await dataSource.query(
      `INSERT INTO test_children (id, parent_id, value) VALUES (2, 2, 'valid-2')`,
    );

    // Create orphaned children (parent_id points to non-existent parents)
    await dataSource.query(
      `INSERT INTO test_children (id, parent_id, value) VALUES (3, 999, 'orphan-1')`,
    );
    await dataSource.query(
      `INSERT INTO test_children (id, parent_id, value) VALUES (4, 998, 'orphan-2')`,
    );
    await dataSource.query(
      `INSERT INTO test_children (id, parent_id, value) VALUES (5, 997, 'orphan-3')`,
    );
  });

  afterAll(async () => {
    await dataSource.destroy();
    
    // Cleanup test checkpoint directory
    if (fs.existsSync(testCheckpointDir)) {
      const files = fs.readdirSync(testCheckpointDir);
      for (const file of files) {
        fs.unlinkSync(path.join(testCheckpointDir, file));
      }
      fs.rmdirSync(testCheckpointDir);
    }
  });

  beforeEach(() => {
    store = new FileRepairCheckpointStore(testCheckpointDir);
  });

  afterEach(async () => {
    // Clean up checkpoints after each test
    const checkpoints = store.list();
    for (const id of checkpoints) {
      await store.delete(id);
    }
  });

  describe("Normal Path - Dry Run", () => {
    it("should detect orphans without making changes", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const result = await job.run(operator, "dry-run-test", {
        dryRun: true,
        batchSize: 10,
      });

      expect(result.status).toBe("completed");
      expect(result.dryRun).toBe(true);
      expect(result.scanned).toBe(5); // All children scanned
      expect(result.detected).toBe(3); // 3 orphans detected
      expect(result.repaired).toBe(0); // No repairs in dry-run
      expect(result.journal.length).toBe(0); // No journal in dry-run
      expect(result.failures.length).toBe(0);

      // Verify no changes made
      const orphans = await dataSource.query(
        `SELECT * FROM test_children WHERE parent_id IN (997, 998, 999)`,
      );
      expect(orphans.length).toBe(3); // Still orphaned
    });
  });

  describe("Apply Path - SET NULL Strategy", () => {
    it("should repair orphans by setting FK to NULL", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const result = await job.run(operator, "set-null-test", {
        dryRun: false,
        batchSize: 10,
      });

      expect(result.status).toBe("completed");
      expect(result.dryRun).toBe(false);
      expect(result.scanned).toBe(5);
      expect(result.repaired).toBe(3); // 3 orphans repaired
      expect(result.journal.length).toBe(3); // 3 before-images journaled
      expect(result.failures.length).toBe(0);

      // Verify repairs applied
      const repaired = await dataSource.query(
        `SELECT * FROM test_children WHERE id IN (3, 4, 5)`,
      );
      expect(repaired.every((r: any) => r.parent_id === null)).toBe(true);

      // Verify valid records untouched
      const valid = await dataSource.query(
        `SELECT * FROM test_children WHERE id IN (1, 2)`,
      );
      expect(valid[0].parent_id).toBe(1);
      expect(valid[1].parent_id).toBe(2);
    });
  });

  describe("Apply Path - DELETE Strategy", () => {
    it("should repair orphans by deleting records", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "delete",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const result = await job.run(operator, "delete-test", {
        dryRun: false,
        batchSize: 10,
      });

      expect(result.status).toBe("completed");
      expect(result.repaired).toBe(3);
      expect(result.journal.length).toBe(3);

      // Verify orphans deleted
      const remaining = await dataSource.query(`SELECT * FROM test_children`);
      expect(remaining.length).toBe(2); // Only valid records remain
      expect(remaining.every((r: any) => [1, 2].includes(r.id))).toBe(true);
    });
  });

  describe("Rollback Path", () => {
    it("should rollback SET NULL repairs", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      // Apply repairs
      await job.run(operator, "rollback-set-null-test", {
        dryRun: false,
        batchSize: 10,
      });

      // Verify repairs applied
      let repaired = await dataSource.query(
        `SELECT * FROM test_children WHERE id IN (3, 4, 5)`,
      );
      expect(repaired.every((r: any) => r.parent_id === null)).toBe(true);

      // Rollback
      const rolledBack = await job.rollback(operator, "rollback-set-null-test");

      expect(rolledBack.status).toBe("rolled_back");
      expect(rolledBack.journal.length).toBe(0); // Journal cleared
      expect(rolledBack.repaired).toBe(0); // Repair count reset

      // Verify rollback restored original values
      const restored = await dataSource.query(
        `SELECT * FROM test_children WHERE id IN (3, 4, 5)`,
      );
      expect(restored.find((r: any) => r.id === 3).parent_id).toBe(999);
      expect(restored.find((r: any) => r.id === 4).parent_id).toBe(998);
      expect(restored.find((r: any) => r.id === 5).parent_id).toBe(997);
    });

    it("should rollback DELETE repairs by re-inserting", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "delete",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      // Apply repairs (delete orphans)
      await job.run(operator, "rollback-delete-test", {
        dryRun: false,
        batchSize: 10,
      });

      // Verify orphans deleted
      let remaining = await dataSource.query(`SELECT * FROM test_children`);
      expect(remaining.length).toBe(2);

      // Rollback (re-insert deleted records)
      await job.rollback(operator, "rollback-delete-test");

      // Verify records re-inserted
      const restored = await dataSource.query(`SELECT * FROM test_children`);
      expect(restored.length).toBe(5); // All records back
      expect(restored.find((r: any) => r.id === 3).parent_id).toBe(999);
      expect(restored.find((r: any) => r.id === 4).parent_id).toBe(998);
      expect(restored.find((r: any) => r.id === 5).parent_id).toBe(997);
    });
  });

  describe("Retry Path - Resumability", () => {
    it("should resume from checkpoint after interruption", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      // Start repair with small batch size (simulates interruption)
      const firstRun = await job.run(operator, "resume-test", {
        dryRun: false,
        batchSize: 2, // Process only 2 at a time
      });

      expect(firstRun.status).toBe("completed");

      // Verify checkpoint saved
      const checkpoint = await store.load("resume-test");
      expect(checkpoint).not.toBeNull();
      expect(checkpoint!.cursor).toBeNull(); // Completed
      expect(checkpoint!.repaired).toBeGreaterThan(0);

      // Run again (should be no-op as completed)
      const secondRun = await job.run(operator, "resume-test", {
        dryRun: false,
        batchSize: 2,
      });

      expect(secondRun.status).toBe("completed");
      expect(secondRun.repaired).toBe(firstRun.repaired); // Same count
    });
  });

  describe("Failure Path", () => {
    it("should handle repair failures gracefully", async () => {
      // Create a bad config that will cause failures
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "non_existent_table",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      // Expect failure
      await expect(
        job.run(operator, "failure-test", {
          dryRun: false,
          batchSize: 10,
        }),
      ).rejects.toThrow();

      // Verify checkpoint marked as failed
      const checkpoint = await store.load("failure-test");
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toBeDefined();
    });
  });

  describe("Authorization Path", () => {
    it("should reject non-maintainer users", async () => {
      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const nonMaintainer = {
        id: "user",
        roles: [Role.USER],
      };

      await expect(
        job.run(nonMaintainer, "auth-test", { dryRun: true }),
      ).rejects.toThrow("Not allowed");
    });
  });

  describe("Edge Cases", () => {
    it("should handle empty result set", async () => {
      // Delete all orphans first
      await dataSource.query(`DELETE FROM test_children WHERE id IN (3, 4, 5)`);

      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const result = await job.run(operator, "empty-test", { dryRun: true });

      expect(result.status).toBe("completed");
      expect(result.scanned).toBe(2); // Only valid records
      expect(result.detected).toBe(0); // No orphans
      expect(result.repaired).toBe(0);
    });

    it("should handle multiple relationships in config", async () => {
      // Create second parent/child tables
      await dataSource.query(`
        CREATE TABLE test_parents_2 (
          id INTEGER PRIMARY KEY,
          name TEXT
        )
      `);

      await dataSource.query(`
        CREATE TABLE test_children_2 (
          id INTEGER PRIMARY KEY,
          parent_id INTEGER,
          value TEXT
        )
      `);

      await dataSource.query(`INSERT INTO test_parents_2 (id, name) VALUES (1, 'parent-1')`);
      await dataSource.query(
        `INSERT INTO test_children_2 (id, parent_id, value) VALUES (1, 999, 'orphan')`,
      );

      const config: OrphanRepairConfig = {
        relationships: [
          {
            table: "test_children",
            fk: "parent_id",
            references: "test_parents",
          },
          {
            table: "test_children_2",
            fk: "parent_id",
            references: "test_parents_2",
          },
        ],
        strategy: "set_null",
      };

      adapter = new OrphanRepairAdapter(dataSource, config);
      job = new RepairJob(adapter, store);

      const result = await job.run(operator, "multi-rel-test", {
        dryRun: true,
        batchSize: 10,
      });

      expect(result.status).toBe("completed");
      expect(result.detected).toBeGreaterThan(0); // Found orphans in both tables
    });
  });
});

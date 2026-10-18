import { DataSource } from "typeorm";
import {
  MigrationHistoryUnavailableError,
  checkStorageSchemaCompatibility,
  evaluateMigrationCompatibility,
  readAppliedMigrations,
  type MigrationVersion,
} from "./storage-schema-compatibility";

const known: MigrationVersion[] = [
  { timestamp: 1000, id: "1000-create-base" },
  { timestamp: 2000, id: "2000-add-index" },
  { timestamp: 3000, id: "3000-next-storage-version" },
];

function dataSourceWithQuery(query: jest.Mock): DataSource {
  return {
    options: {},
    query,
  } as unknown as DataSource;
}

describe("storage schema migration compatibility", () => {
  it("reports up-to-date when applied history exactly matches the known chain", () => {
    const report = evaluateMigrationCompatibility(known, [
      { timestamp: 1000, name: "CreateBase1000" },
      { timestamp: 2000, name: "AddIndex2000" },
      { timestamp: 3000, name: "NextStorageVersion3000" },
    ]);

    expect(report.status).toBe("up-to-date");
    expect(report.compatible).toBe(true);
    expect(report.currentVersion).toBe("3000-next-storage-version");
    expect(report.nextVersion).toBeNull();
    expect(report.pendingVersions).toEqual([]);
  });

  it("reports upgrade-ready and identifies the next storage version", () => {
    const report = evaluateMigrationCompatibility(known, [
      { timestamp: 1000, name: "CreateBase1000" },
      { timestamp: 2000, name: "AddIndex2000" },
    ]);

    expect(report.status).toBe("upgrade-ready");
    expect(report.compatible).toBe(true);
    expect(report.currentVersion).toBe("2000-add-index");
    expect(report.nextVersion).toBe("3000-next-storage-version");
    expect(report.pendingVersions).toEqual(["3000-next-storage-version"]);
  });

  it("treats an empty but readable migration history as upgrade-ready", () => {
    const report = evaluateMigrationCompatibility(known, []);

    expect(report.status).toBe("upgrade-ready");
    expect(report.currentVersion).toBeNull();
    expect(report.nextVersion).toBe("1000-create-base");
  });

  it("fails closed when the database history is ahead or unknown", () => {
    const report = evaluateMigrationCompatibility(known, [
      { timestamp: 1000, name: "CreateBase1000" },
      { timestamp: 9999, name: "UnknownFuture9999" },
    ]);

    expect(report.status).toBe("incompatible");
    expect(report.compatible).toBe(false);
    expect(report.reason).toContain("diverges");
  });

  it("fails closed when a migration is skipped or applied out of order", () => {
    const report = evaluateMigrationCompatibility(known, [
      { timestamp: 1000, name: "CreateBase1000" },
      { timestamp: 3000, name: "NextStorageVersion3000" },
    ]);

    expect(report.status).toBe("incompatible");
    expect(report.reason).toContain("expected 2000-add-index");
  });

  it("fails closed when no application migration manifest can be discovered", () => {
    const report = evaluateMigrationCompatibility([], []);

    expect(report.status).toBe("incompatible");
    expect(report.reason).toContain("No application migrations");
  });

  it("retries transient database failures and succeeds", async () => {
    const query = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("connection reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce([{ timestamp: "1000", name: "CreateBase1000" }]);
    const sleep = jest.fn().mockResolvedValue(undefined);

    const rows = await readAppliedMigrations(dataSourceWithQuery(query), 3, sleep);

    expect(rows).toEqual([{ timestamp: 1000, name: "CreateBase1000" }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("does not retry permanent migration-history errors", async () => {
    const query = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error("relation does not exist"), { code: "42P01" }));
    const sleep = jest.fn().mockResolvedValue(undefined);

    await expect(
      readAppliedMigrations(dataSourceWithQuery(query), 3, sleep),
    ).rejects.toMatchObject({
      name: "MigrationHistoryUnavailableError",
      attempts: 1,
      errorCode: "42P01",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("returns a compatibility report through the persistence-backed check", async () => {
    const query = jest.fn().mockResolvedValue([
      { timestamp: 1000, name: "CreateBase1000" },
      { timestamp: 2000, name: "AddIndex2000" },
    ]);

    const report = await checkStorageSchemaCompatibility(dataSourceWithQuery(query), {
      knownMigrations: known,
      sleep: async () => undefined,
    });

    expect(report.status).toBe("upgrade-ready");
    expect(report.nextVersion).toBe("3000-next-storage-version");
    expect(query).toHaveBeenCalledWith(
      'SELECT "timestamp", "name" FROM "migrations" ORDER BY "id" ASC',
    );
  });
});

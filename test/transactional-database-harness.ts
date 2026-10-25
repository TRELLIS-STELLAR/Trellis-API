import type { DataSource, EntityManager, QueryRunner } from "typeorm";

export interface TransactionHooks {
  beforeEach: (callback: () => Promise<void>) => void;
  afterEach: (callback: () => Promise<void>) => void;
}

/** Run a spec body in a transaction that is always rolled back. */
export async function withDatabaseTransaction<T>(
  dataSource: DataSource,
  body: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  await queryRunner.startTransaction("READ COMMITTED");
  try {
    return await body(queryRunner.manager);
  } finally {
    if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    await queryRunner.release();
  }
}

/**
 * Install per-spec isolation for E2E suites. Repositories used by the spec
 * must be obtained from `manager()` so writes stay inside this query runner.
 */
export function installTransactionIsolation(
  dataSource: DataSource,
  hooks: TransactionHooks,
): () => EntityManager {
  let queryRunner: QueryRunner | undefined;
  hooks.beforeEach(async () => {
    queryRunner = dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction("READ COMMITTED");
  });
  hooks.afterEach(async () => {
    if (!queryRunner) return;
    try {
      if (queryRunner.isTransactionActive) await queryRunner.rollbackTransaction();
    } finally {
      await queryRunner.release();
      queryRunner = undefined;
    }
  });
  return () => {
    if (!queryRunner) throw new Error("Database transaction has not been started");
    return queryRunner.manager;
  };
}

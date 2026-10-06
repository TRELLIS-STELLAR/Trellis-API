import { MigrationInterface, QueryRunner } from "typeorm";

export class TargetAllocationVersions1790630400000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE TABLE "target_allocation_versions" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "portfolioId" uuid NOT NULL REFERENCES "portfolios"("id") ON DELETE RESTRICT,
      "version" integer NOT NULL CHECK ("version" > 0),
      "allocations" jsonb NOT NULL CHECK (jsonb_typeof("allocations") = 'array'),
      "updatedAt" timestamp NOT NULL DEFAULT now(),
      CONSTRAINT "UQ_target_allocation_version" UNIQUE ("portfolioId", "version")
    )`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "target_allocation_versions"`);
  }
}

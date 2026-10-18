import { MigrationInterface, QueryRunner } from "typeorm";

export class UserApiKeys1790630402000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE TABLE "api_keys" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "keyHash" varchar(64) NOT NULL,
      "userId" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
      "name" varchar(100) NOT NULL,
      "permissions" jsonb NOT NULL,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "lastUsedAt" timestamp,
      "expiresAt" timestamp,
      "revoked" boolean NOT NULL DEFAULT false
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_api_keys_hash" ON "api_keys" ("keyHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_api_keys_owner" ON "api_keys" ("userId")`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}

import { MigrationInterface, QueryRunner } from "typeorm";

export class OracleSubmissionHistory1790630401000 implements MigrationInterface {
  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);
    await queryRunner.query(`CREATE TABLE "oracle_submission_history" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "payloadHash" varchar(64) NOT NULL,
      "submitter" varchar(56) NOT NULL,
      "transactionHash" varchar(64) NOT NULL,
      "verificationStatus" varchar(16) NOT NULL DEFAULT 'pending'
        CHECK ("verificationStatus" IN ('pending', 'verified', 'rejected')),
      "verificationError" text,
      "createdAt" timestamp NOT NULL DEFAULT now(),
      "updatedAt" timestamp NOT NULL DEFAULT now()
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_oracle_history_payload" ON "oracle_submission_history" ("payloadHash")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_oracle_history_transaction" ON "oracle_submission_history" ("transactionHash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_oracle_history_pending" ON "oracle_submission_history" ("verificationStatus", "updatedAt")`,
    );
  }
  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "oracle_submission_history"`);
  }
}

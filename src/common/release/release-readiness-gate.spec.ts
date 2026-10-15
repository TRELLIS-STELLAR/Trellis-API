import * as fs from 'fs';
import * as path from 'path';
import {
  ReleaseReadinessGateService,
  createMockQueryRunner,
} from '../../../scripts/release-readiness-gate';

describe('ReleaseReadinessGateService', () => {
  const repoRoot = path.resolve(__dirname, '../../..');
  let gateService: ReleaseReadinessGateService;

  beforeEach(() => {
    gateService = new ReleaseReadinessGateService(repoRoot);
  });

  describe('createMockQueryRunner', () => {
    it('records executed queries in memory without throwing', async () => {
      const runner = createMockQueryRunner();
      await runner.query('CREATE TABLE test_table (id INT);');
      await runner.query('DROP TABLE test_table;');

      expect(runner.queries).toHaveLength(2);
      expect(runner.queries[0]).toBe('CREATE TABLE test_table (id INT);');
      expect(runner.queries[1]).toBe('DROP TABLE test_table;');
    });
  });

  describe('checkMigrations', () => {
    it('verifies existing production migrations have reversible down() methods', async () => {
      const results = await gateService.checkMigrations();

      const downHookCheck = results.find(
        (r) => r.code === 'MIG_REVERSIBLE_DOWN',
      );
      expect(downHookCheck).toBeDefined();
      expect(downHookCheck?.passed).toBe(true);
      expect(downHookCheck?.severity).toBe('critical');
    });

    it('flags temporary fixtures with missing or stubbed down() hooks', async () => {
      const tempDir = path.join(__dirname, 'fixtures-temp-gate');
      const tempMigDir = path.join(tempDir, 'src', 'migrations');
      fs.mkdirSync(tempMigDir, { recursive: true });

      const badMigration = `
        import { MigrationInterface, QueryRunner } from "typeorm";
        export class BadMigration implements MigrationInterface {
          public async up(queryRunner: QueryRunner): Promise<void> {
            await queryRunner.query('CREATE TABLE "foo"');
          }
          public async down(queryRunner: QueryRunner): Promise<void> {
            // not reversible
            throw new Error("not reversible");
          }
        }
      `;
      fs.writeFileSync(
        path.join(tempMigDir, '1000000000000-bad-migration.ts'),
        badMigration,
      );

      const customGate = new ReleaseReadinessGateService(tempDir);
      const results = await customGate.checkMigrations();

      const downCheck = results.find((r) => r.code === 'MIG_REVERSIBLE_DOWN');
      expect(downCheck?.passed).toBe(false);
      expect(downCheck?.details?.some((d) => d.includes('bad-migration'))).toBe(
        true,
      );

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('checkRollbackRehearsal', () => {
    it('passes simulated dry-run across existing migrations', async () => {
      const results = await gateService.checkRollbackRehearsal();

      const simCheck = results.find(
        (r) => r.code === 'ROLLBACK_REHEARSAL_SIMULATION',
      );
      expect(simCheck).toBeDefined();
      expect(simCheck?.passed).toBe(true);
    });

    it('detects schema asymmetry when up() creates a table missing in down()', async () => {
      const tempDir = path.join(__dirname, 'fixtures-asymmetry-gate');
      const tempMigDir = path.join(tempDir, 'src', 'migrations');
      fs.mkdirSync(tempMigDir, { recursive: true });

      const asymmetricMig = `
        import { MigrationInterface, QueryRunner } from "typeorm";
        export class AsymmetricMig implements MigrationInterface {
          public async up(queryRunner: QueryRunner): Promise<void> {
            await queryRunner.query('CREATE TABLE "orphaned_table" ("id" serial);');
          }
          public async down(queryRunner: QueryRunner): Promise<void> {
            await queryRunner.query('SELECT 1;');
          }
        }
      `;
      fs.writeFileSync(
        path.join(tempMigDir, '2000000000000-asym.ts'),
        asymmetricMig,
      );

      const customGate = new ReleaseReadinessGateService(tempDir);
      const results = await customGate.checkRollbackRehearsal();

      const asymCheck = results.find(
        (r) => r.code === 'ROLLBACK_SCHEMA_ASYMMETRY',
      );
      expect(asymCheck?.passed).toBe(false);
      expect(
        asymCheck?.details?.some((d) => d.includes('orphaned_table')),
      ).toBe(true);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('checkSecurity', () => {
    it('confirms absence of committed private keys and Stellar secret seeds', async () => {
      const results = await gateService.checkSecurity();

      const secretCheck = results.find(
        (r) => r.code === 'SEC_NO_HARDCODED_SECRETS',
      );
      expect(secretCheck).toBeDefined();
      expect(secretCheck?.passed).toBe(true);
    });

    it('detects exposed Stellar secret seeds in monitored directories', async () => {
      const tempDir = path.join(__dirname, 'fixtures-secret-gate');
      const tempSrc = path.join(tempDir, 'src');
      fs.mkdirSync(tempSrc, { recursive: true });

      const mockSecret = 'S' + 'A'.repeat(55);
      fs.writeFileSync(
        path.join(tempSrc, 'leaky.service.ts'),
        `const signingKey = "${mockSecret}";`,
      );

      const customGate = new ReleaseReadinessGateService(tempDir);
      const results = await customGate.checkSecurity();

      const secretCheck = results.find(
        (r) => r.code === 'SEC_NO_HARDCODED_SECRETS',
      );
      expect(secretCheck?.passed).toBe(false);
      expect(secretCheck?.details?.length).toBeGreaterThan(0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it('verifies global KycGuard configuration in AppModule', async () => {
      const results = await gateService.checkSecurity();

      const kycCheck = results.find(
        (r) => r.code === 'SEC_GLOBAL_KYC_GUARD',
      );
      expect(kycCheck).toBeDefined();
      expect(kycCheck?.passed).toBe(true);
    });
  });

  describe('checkSmokeAndHealth', () => {
    it('verifies health probes and DR invariant engine are intact', async () => {
      const results = await gateService.checkSmokeAndHealth();

      const healthCheck = results.find(
        (r) => r.code === 'SMOKE_HEALTH_PROBES',
      );
      const drCheck = results.find((r) => r.code === 'SMOKE_DR_INVARIANTS');

      expect(healthCheck).toBeDefined();
      expect(healthCheck?.passed).toBe(true);
      expect(drCheck).toBeDefined();
      expect(drCheck?.passed).toBe(true);
    });
  });

  describe('checkDocumentation', () => {
    it('verifies presence and completeness of RELEASE_READINESS_GATE.md', async () => {
      const results = await gateService.checkDocumentation();

      const docCheck = results.find(
        (r) => r.code === 'DOC_RUNBOOK_COMPREHENSIVE',
      );
      expect(docCheck).toBeDefined();
      expect(docCheck?.passed).toBe(true);
    });
  });

  describe('evaluateAll', () => {
    it('evaluates all checks and confirms PASSED status for release', async () => {
      const report = await gateService.evaluateAll();

      expect(report.totalChecks).toBeGreaterThanOrEqual(7);
      expect(report.criticalFailures).toBe(0);
      expect(report.errorFailures).toBe(0);
      expect(report.status).toBe('PASSED');
      expect(report.durationMs).toBeGreaterThan(0);
    });
  });
});

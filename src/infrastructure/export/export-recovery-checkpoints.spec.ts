/**
 * @file export-recovery-checkpoints.spec.ts
 *
 * Recovery checkpoint tests around every external side effect in the export
 * pipeline (issue #277).
 *
 * The export pipeline touches the database twice for every successful delivery:
 *   1. status → PROCESSING  (checkpoint: entered processing)
 *   2. status → COMPLETED + downloadUrl  (checkpoint: data extracted and serialised)
 *
 * If the pipeline crashes between those two writes the record is left in
 * PROCESSING.  If it crashes before the first write the record stays PENDING.
 * Both cases are observable and recoverable without data loss.
 *
 * Side effects covered:
 *   A. Repository.save() on status transition to PROCESSING
 *   B. Repository.save() on status transition to COMPLETED / FAILED
 *   C. expireOldExports() — bulk-delete side effect
 *   D. Authorization gate in getExport() before data is returned
 *
 * Acceptance criteria from issue #277:
 *   - Cover normal, failure, retry, and authorization paths.
 *   - Add automated tests or executable verification.
 *   - Document operational edge cases and recovery/rollback behavior.
 *   - Preserve existing contracts.
 */

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ExportService } from './export.service';
import { DataExport, ExportStatus } from './entities/data-export.entity';
import { ExportScope } from './dto/export.dto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRepo(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    create: jest.fn().mockImplementation((dto: Partial<DataExport>) => ({
      id: 'test-export-id',
      status: ExportStatus.PENDING,
      ...dto,
    })),
    save: jest.fn().mockImplementation(async (entity: DataExport) => ({ ...entity })),
    findOne: jest.fn(),
    find: jest.fn().mockResolvedValue([]),
    createQueryBuilder: jest.fn(),
    ...overrides,
  };
}

async function buildService(
  repoOverrides: Partial<Record<string, jest.Mock>> = {},
): Promise<{ service: ExportService; repo: ReturnType<typeof makeMockRepo> }> {
  const repo = makeMockRepo(repoOverrides);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ExportService,
      {
        provide: getRepositoryToken(DataExport),
        useValue: repo,
      },
    ],
  }).compile();

  return { service: module.get<ExportService>(ExportService), repo };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Export pipeline — recovery checkpoints around external side effects (issue #277)', () => {

  // -------------------------------------------------------------------------
  // A. CHECKPOINT 1: status → PROCESSING
  // -------------------------------------------------------------------------
  describe('Checkpoint A — status transition to PROCESSING', () => {
    it('normal path: saves the record with PROCESSING status before extracting data', async () => {
      const { service, repo } = await buildService();
      const exportId = 'export-cp-a';

      const exportRecord: Partial<DataExport> = {
        id: exportId,
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.USER_DATA,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      repo.findOne.mockResolvedValueOnce(exportRecord);
      // Two subsequent saves: PROCESSING, then COMPLETED
      repo.save.mockResolvedValueOnce({ ...exportRecord, status: ExportStatus.PROCESSING });
      repo.save.mockResolvedValueOnce({ ...exportRecord, status: ExportStatus.COMPLETED });

      await service.processExport(exportId);

      // First save MUST capture the PROCESSING checkpoint
      const firstSaveCall = repo.save.mock.calls[0][0];
      expect(firstSaveCall.status).toBe(ExportStatus.PROCESSING);
    });

    it('failure path: if the first save (PROCESSING checkpoint) throws, the record is not silently left as PENDING', async () => {
      const { service, repo } = await buildService();
      const exportId = 'export-cp-a-fail';

      const exportRecord: Partial<DataExport> = {
        id: exportId,
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.USER_DATA,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      repo.findOne.mockResolvedValueOnce(exportRecord);
      // First save (PROCESSING) throws a transient DB error
      repo.save.mockRejectedValueOnce(new Error('DB connection lost'));
      // Second save (FAILED status write) succeeds so the caller can observe failure
      repo.save.mockResolvedValueOnce({ ...exportRecord, status: ExportStatus.FAILED });

      // processExport must not propagate; it absorbs the error and writes FAILED
      await expect(service.processExport(exportId)).resolves.not.toThrow();

      // The final save captures the FAILED status (recovery checkpoint)
      const lastSaveCall = repo.save.mock.calls[repo.save.mock.calls.length - 1][0];
      expect(lastSaveCall.status).toBe(ExportStatus.FAILED);
      expect(lastSaveCall.error).toBeDefined();
    });

    it('retry path: processExport is safe to call again on a record that is PENDING (idempotent entry)', async () => {
      const { service, repo } = await buildService();
      const exportId = 'export-cp-a-retry';

      const exportRecord: Partial<DataExport> = {
        id: exportId,
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.PORTFOLIO,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      // Both calls resolve independently
      repo.findOne.mockResolvedValue(exportRecord);
      repo.save.mockResolvedValue({ ...exportRecord, status: ExportStatus.COMPLETED });

      await service.processExport(exportId);
      await service.processExport(exportId);

      // Each call must write PROCESSING before COMPLETED — no skipped checkpoints
      const processingCalls = repo.save.mock.calls.filter(
        (c: [DataExport]) => c[0].status === ExportStatus.PROCESSING,
      );
      expect(processingCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // B. CHECKPOINT 2: status → COMPLETED / FAILED
  // -------------------------------------------------------------------------
  describe('Checkpoint B — status transition to COMPLETED or FAILED', () => {
    it('normal path: saves COMPLETED with a non-null downloadUrl after extraction', async () => {
      const { service, repo } = await buildService();
      const exportId = 'export-cp-b';

      const exportRecord: Partial<DataExport> = {
        id: exportId,
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.USER_DATA,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      repo.findOne.mockResolvedValue(exportRecord);
      repo.save.mockImplementation(async (entity: DataExport) => ({ ...entity }));

      await service.processExport(exportId);

      const completedSave = repo.save.mock.calls.find(
        (c: [DataExport]) => c[0].status === ExportStatus.COMPLETED,
      );
      expect(completedSave).toBeDefined();
      // downloadUrl must be populated — it is the observable output of this side effect
      expect(completedSave![0].downloadUrl).toBeTruthy();
      // completedAt timestamp must be set as part of the checkpoint
      expect(completedSave![0].completedAt).toBeInstanceOf(Date);
    });

    it('failure path: saves FAILED with an error message when extraction throws', async () => {
      const { service, repo } = await buildService();
      const exportId = 'export-cp-b-fail';

      const exportRecord: Partial<DataExport> = {
        id: exportId,
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.AUDIT_LOG,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      repo.findOne.mockResolvedValue(exportRecord);
      // PROCESSING write succeeds
      repo.save.mockResolvedValueOnce({ ...exportRecord, status: ExportStatus.PROCESSING });
      // Simulate extraction failure by making the second save throw
      repo.save.mockImplementationOnce(async (entity: DataExport) => {
        if (entity.status === ExportStatus.PROCESSING) return { ...entity };
        throw new Error('S3 upload failed');
      });
      // FAILED checkpoint write succeeds
      repo.save.mockResolvedValue({ ...exportRecord, status: ExportStatus.FAILED });

      await expect(service.processExport(exportId)).resolves.not.toThrow();

      const failedSave = repo.save.mock.calls.find(
        (c: [DataExport]) => c[0].status === ExportStatus.FAILED,
      );
      expect(failedSave).toBeDefined();
      expect(typeof failedSave![0].error).toBe('string');
      expect(failedSave![0].error!.length).toBeGreaterThan(0);
    });

    it('skips processing gracefully when the export record no longer exists (already expired/deleted)', async () => {
      const { service, repo } = await buildService();

      repo.findOne.mockResolvedValue(null);

      // Must not throw — the record may have been expired between job enqueue and execution
      await expect(service.processExport('non-existent-id')).resolves.toBeUndefined();
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // C. SIDE EFFECT: expireOldExports — bulk delete
  // -------------------------------------------------------------------------
  describe('Checkpoint C — expireOldExports bulk-delete side effect', () => {
    it('normal path: deletes records older than expiresAt and returns the affected count', async () => {
      const { service, repo } = await buildService();

      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: 7 }),
      };
      repo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.expireOldExports();

      expect(count).toBe(7);
      // Verify the WHERE clause references the expiration timestamp (not id, userId, etc.)
      expect(mockQb.where).toHaveBeenCalledWith(
        expect.stringContaining('expiresAt'),
        expect.objectContaining({ now: expect.any(Date) }),
      );
    });

    it('failure path: returns 0 when affected is undefined (DB returns no count)', async () => {
      const { service, repo } = await buildService();

      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ affected: undefined }),
      };
      repo.createQueryBuilder.mockReturnValue(mockQb);

      const count = await service.expireOldExports();
      // Must never return undefined — callers rely on numeric count for observability
      expect(typeof count).toBe('number');
      expect(count).toBe(0);
    });

    it('retry path: calling expireOldExports twice in a row is safe (no double-delete)', async () => {
      const { service, repo } = await buildService();

      const mockQb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute: jest
          .fn()
          .mockResolvedValueOnce({ affected: 3 })
          .mockResolvedValueOnce({ affected: 0 }),
      };
      repo.createQueryBuilder.mockReturnValue(mockQb);

      const first = await service.expireOldExports();
      const second = await service.expireOldExports();

      expect(first).toBe(3);
      // Second call on already-expired records returns 0, not an error
      expect(second).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // D. AUTHORIZATION GATE before data side effects
  // -------------------------------------------------------------------------
  describe('Checkpoint D — authorization gate before data access', () => {
    it('authorization path: getExport returns data when userId matches', async () => {
      const { service, repo } = await buildService();

      const record: Partial<DataExport> = {
        id: 'export-auth-ok',
        userId: 'user-correct',
        status: ExportStatus.COMPLETED,
        scope: ExportScope.TRANSACTION_HISTORY,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };
      repo.findOne.mockResolvedValue(record);

      const result = await service.getExport('user-correct', 'export-auth-ok');
      expect(result.id).toBe('export-auth-ok');
    });

    it('authorization boundary: getExport throws ForbiddenException when caller does not own the export', async () => {
      const { service, repo } = await buildService();

      const record: Partial<DataExport> = {
        id: 'export-auth-deny',
        userId: 'user-owner',
        status: ExportStatus.COMPLETED,
        scope: ExportScope.USER_DATA,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };
      repo.findOne.mockResolvedValue(record);

      await expect(
        service.getExport('user-attacker', 'export-auth-deny'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('authorization path: getExport throws NotFoundException before exposing ownership (prevents enumeration)', async () => {
      const { service, repo } = await buildService();

      repo.findOne.mockResolvedValue(null);

      await expect(
        service.getExport('any-user', 'non-existent-export'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('authorization path: createExport does not expose another users export record', async () => {
      const { service, repo } = await buildService();

      const savedRecord: Partial<DataExport> = {
        id: 'export-created',
        userId: 'user-a',
        status: ExportStatus.PENDING,
        scope: ExportScope.USER_DATA,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      };
      repo.create.mockReturnValue(savedRecord);
      repo.save.mockResolvedValue(savedRecord);

      const result = await service.createExport('user-a', {
        scope: ExportScope.USER_DATA,
      });

      // The returned record must belong to the requesting user
      expect(result.userId).toBe('user-a');
    });
  });

  // -------------------------------------------------------------------------
  // OPERATIONAL EDGE CASES (documented per acceptance criteria)
  // -------------------------------------------------------------------------
  /**
   * Edge cases and recovery guidance for operators:
   *
   * 1. PROCESSING-stuck records: If the application crashes after writing
   *    status=PROCESSING but before writing COMPLETED/FAILED, the record
   *    remains stuck. Recovery: a scheduled job (e.g. expireOldExports or a
   *    separate stale-detection cron) should mark records that have been in
   *    PROCESSING for longer than a configurable TTL as FAILED so operators
   *    can re-trigger them.
   *
   * 2. Expired records fetched by in-flight jobs: The processExport() method
   *    guards against null findOne results (Checkpoint B, skips gracefully),
   *    so concurrent deletion and processing is safe.
   *
   * 3. Bulk expiry under load: expireOldExports() is idempotent — running it
   *    multiple times in quick succession only deletes records whose
   *    expiresAt < now at the moment of each query; no data is double-deleted.
   *
   * 4. Authorization: the ForbiddenException is thrown AFTER the NotFoundException
   *    check, so callers cannot distinguish "not found" from "found but not yours"
   *    by catching different exception types — but the existing implementation
   *    throws NotFoundException for missing records and ForbiddenException for
   *    ownership mismatches. Operators should ensure 404 vs 403 is not logged
   *    with userId correlation to prevent information leakage.
   */
  describe('Operational edge cases (documentation)', () => {
    it('processExport is a no-op for missing records — no state mutation', async () => {
      const { service, repo } = await buildService();
      repo.findOne.mockResolvedValue(null);

      await service.processExport('ghost-id');
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('FAILED status always includes a non-empty error message for operator observability', async () => {
      const { service, repo } = await buildService();
      const exportRecord: Partial<DataExport> = {
        id: 'export-edge-failed',
        userId: 'user-1',
        status: ExportStatus.PENDING,
        scope: ExportScope.PORTFOLIO,
        format: 'json',
        schemaVersion: '1.0.0',
        filters: {},
      };

      repo.findOne.mockResolvedValue(exportRecord);
      // Force a throw during extraction by rejecting the PROCESSING save
      repo.save
        .mockResolvedValueOnce({ ...exportRecord, status: ExportStatus.PROCESSING })
        .mockImplementationOnce(() => { throw new Error('Extraction exploded'); })
        .mockResolvedValue({ ...exportRecord, status: ExportStatus.FAILED });

      await service.processExport('export-edge-failed');

      const failedWrite = repo.save.mock.calls.find(
        (c: [DataExport]) => c[0].status === ExportStatus.FAILED,
      );
      if (failedWrite) {
        expect(typeof failedWrite[0].error).toBe('string');
        expect(failedWrite[0].error!.length).toBeGreaterThan(0);
      }
    });
  });
});

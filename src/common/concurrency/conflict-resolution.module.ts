import { Module } from "@nestjs/common";
import { ConflictResolutionService } from "./conflict-resolution.service";
import { ConflictResolutionController } from "./conflict-resolution.controller";
import { OptimisticConcurrencyService } from "./optimistic-concurrency.service";

/**
 * Module for conflict resolution in concurrent edits.
 * 
 * Provides:
 * - Three-way merge for intelligent conflict detection
 * - Multiple resolution strategies (last-write-wins, first-write-wins, manual)
 * - Conflict tracking and statistics
 * - REST API for conflict resolution
 */
@Module({
  controllers: [ConflictResolutionController],
  providers: [ConflictResolutionService, OptimisticConcurrencyService],
  exports: [ConflictResolutionService, OptimisticConcurrencyService],
})
export class ConflictResolutionModule {}

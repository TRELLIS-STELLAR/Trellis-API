import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../core/auth/auth.module";
import { SnapshotModule } from "../snapshot.module";
import { SnapshotExportController } from "./snapshot-export.controller";
import { SnapshotExportService } from "./snapshot-export.service";
import { snapshotExportSigningKeyProvider } from "./snapshot-export.signing";

/**
 * Signed state snapshot export (issue #356).
 *
 * Builds on the existing {@link SnapshotModule}: it reads a stored snapshot
 * and emits a portable, HMAC-signed document that can be verified without the
 * originating service.
 */
@Module({
  imports: [ConfigModule, AuthModule, SnapshotModule],
  controllers: [SnapshotExportController],
  providers: [SnapshotExportService, snapshotExportSigningKeyProvider()],
  exports: [SnapshotExportService],
})
export class SnapshotExportModule {}

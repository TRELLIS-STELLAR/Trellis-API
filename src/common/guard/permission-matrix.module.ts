import { Module } from "@nestjs/common";
import { PermissionMatrixController } from "./permission-matrix.controller";
import { PermissionMatrixGuard } from "./permission-matrix.guard";
import { PermissionDiffService } from "./permission-diff.service";

@Module({
  controllers: [PermissionMatrixController],
  providers: [PermissionMatrixGuard, PermissionDiffService],
  exports: [PermissionMatrixGuard, PermissionDiffService],
})
export class PermissionMatrixModule {}

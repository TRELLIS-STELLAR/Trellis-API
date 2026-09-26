import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ExportController } from "./export.controller";
import { ExportService } from "./export.service";
import { DataExport } from "./entities/data-export.entity";

@Module({
  imports: [TypeOrmModule.forFeature([DataExport])],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}

import { Module, Global } from "@nestjs/common";
import { SemanticValidatorService } from "./semantic-validator.service";
import { ImportPipelineService } from "./import-pipeline.service";
import { ImportQuarantineService } from "./import-quarantine.service";
import { ImportRollbackService } from "./import-rollback.service";

/**
 * Global validation module providing semantic validation services and decorators.
 *
 * Exports:
 * - SemanticValidatorService: Service for semantic business-rule validation
 * - ImportPipelineService: Secure import preview pipeline (validation + quarantine)
 * - ImportQuarantineService: Quarantine storage for unsafe import rows
 * - ImportRollbackService: Traceability and rollback/retry guidance
 *
 * @example
 *   // In app.module.ts
 *   import { ValidationModule } from './common/validation/validation.module';
 *
 *   @Module({ imports: [ValidationModule] })
 *   export class AppModule {}
 *
 *   // In a service
 *   @Injectable()
 *   export class MyService {
 *     constructor(private readonly validator: SemanticValidatorService) {}
 *
 *     async process(dto: MyDto) {
 *       this.validator.validateDateRange(dto.startDate, dto.endDate);
 *       // ... rest of logic
 *     }
 *   }
 */
@Global()
@Module({
  providers: [
    SemanticValidatorService,
    ImportQuarantineService,
    ImportPipelineService,
    ImportRollbackService,
  ],
  exports: [
    SemanticValidatorService,
    ImportQuarantineService,
    ImportPipelineService,
    ImportRollbackService,
  ],
})
export class ValidationModule {}

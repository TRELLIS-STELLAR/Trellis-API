import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../core/auth/auth.module";
import { CrossRepoController } from "./cross-repo.controller";
import { CrossRepoRequestValidationService } from "./cross-repo.service";
import { crossRepoSchemaProviderProvider } from "./cross-repo.schema-registry";

/**
 * API request validation for cross-repo clients (issue #353).
 *
 * The contract schema registry is provided behind the
 * `CROSS_REPO_SCHEMA_PROVIDER` token so the in-memory implementation can be
 * swapped for a persisted one without changing the service or controller.
 */
@Module({
  imports: [ConfigModule, AuthModule],
  controllers: [CrossRepoController],
  providers: [CrossRepoRequestValidationService, crossRepoSchemaProviderProvider()],
  exports: [CrossRepoRequestValidationService],
})
export class CrossRepoModule {}

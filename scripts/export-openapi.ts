/**
 * Standalone script that boots the NestJS app just long enough to generate
 * and write the OpenAPI JSON document to docs/openapi.json, then exits.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register scripts/export-openapi.ts
 *   npm run openapi:export
 */

import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AppModule } from "../src/app.module";

async function exportOpenApi() {
  // Silence NestJS bootstrap logs — we only want the artefact output
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });

  const config = new DocumentBuilder()
    .setTitle("Trellis Backend API")
    .setDescription(
      "Comprehensive API documentation for Trellis backend services including " +
      "agent management, oracle submissions, compute operations, and audit trails.",
    )
    .setVersion("1.0.0")
    .setContact("Trellis Team", "https://trellis.example", "api@trellis.example")
    .setLicense("Apache 2.0", "https://www.apache.org/licenses/LICENSE-2.0")
    .addServer("http://localhost:3001", "Development Server")
    .addServer("https://api.trellis.example", "Production Server")
    .addBearerAuth(
      { type: "http", scheme: "bearer", bearerFormat: "JWT", name: "JWT", description: "Enter JWT token", in: "header" },
      "JWT-auth",
    )
    .addApiKey(
      { type: "apiKey", name: "X-API-Key", in: "header", description: "API key for service-to-service communication" },
      "api-key",
    )
    .addTag("Health", "Liveness, readiness, and startup probes for Kubernetes orchestration")
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Enhanced Authentication & KYC", "Enhanced auth with 2FA and KYC flows")
    .addTag("Users", "User management operations")
    .addTag("Oracle", "Oracle data submissions and payload management")
    .addTag("Price Feed", "Aggregated on-chain price data")
    .addTag("Audit", "Audit trail and logging")
    .addTag("Profile", "User profile management")
    .addTag("Info", "API health and meta-information")
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
    operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
  });

  // Write JSON
  const outDir = join(__dirname, "..", "docs");
  mkdirSync(outDir, { recursive: true });

  const jsonPath = join(outDir, "openapi.json");
  writeFileSync(jsonPath, JSON.stringify(document, null, 2), "utf8");
  console.log(`✅  OpenAPI JSON written to ${jsonPath}`);

  await app.close();
  process.exit(0);
}

exportOpenApi().catch((err) => {
  console.error("Failed to export OpenAPI spec:", err);
  process.exit(1);
});

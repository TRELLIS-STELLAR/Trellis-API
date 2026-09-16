import { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, OpenAPIObject } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";

// Trellis mark on a vine tile, inlined so Swagger UI needs no static asset route.
const TRELLIS_MARK_B64 =
  "PHN2ZyB3aWR0aD0iNTAiIGhlaWdodD0iNTAiIHZpZXdCb3g9IjAgMCA2NCA2NCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iNjQiIGhlaWdodD0iNjQiIHJ4PSIxNCIgZmlsbD0iIzFDNkI1NSIvPjxnIHRyYW5zZm9ybT0idHJhbnNsYXRlKDUuNzYgNS43Nikgc2NhbGUoMC44MikiPjxwYXRoIGQ9Ik0xMSAxMyBMNTMgMTMiIHN0cm9rZT0iI0Y3RjVGMCIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48cGF0aCBkPSJNMzIgMTMgTDMyIDUwIiBzdHJva2U9IiNGN0Y1RjAiIHN0cm9rZS13aWR0aD0iNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PHBhdGggZD0iTTE5IDI4IEw0NSAyOCIgc3Ryb2tlPSIjRjdGNUYwIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxwYXRoIGQ9Ik0yNiA0MSBMMzggNDEiIHN0cm9rZT0iI0YwQjQ2MCIgc3Ryb2tlLXdpZHRoPSI2IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L2c+PC9zdmc+";

export function setupSwagger(app: INestApplication): OpenAPIObject | null {
  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>("NODE_ENV", "development");

  // Swagger is opt-in in production — set SWAGGER_ENABLED=true to expose it.
  const swaggerEnabled =
    nodeEnv !== "production" ||
    configService.get<string>("SWAGGER_ENABLED") === "true";

  if (!swaggerEnabled) {
    return null;
  }

  const port = Number(process.env.PORT || configService.get("PORT", 3001));

  const config = new DocumentBuilder()
    .setTitle("Trellis Backend API")
    .setDescription(
      "Comprehensive API documentation for Trellis backend services including agent management, oracle submissions, compute operations, and audit trails",
    )
    .setVersion("1.0.0")
    .setContact(
      "Trellis Team",
      "https://trellis.example",
      "api@trellis.example",
    )
    .setLicense("Apache 2.0", "https://www.apache.org/licenses/LICENSE-2.0")
    .addServer(`http://localhost:${port}`, "Development Server")
    .addServer("https://api.trellis.example", "Production Server")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        name: "JWT",
        description: "Enter JWT token",
        in: "header",
      },
      "JWT-auth",
    )
    .addApiKey(
      {
        type: "apiKey",
        name: "X-API-Key",
        in: "header",
        description: "API key for service-to-service communication",
      },
      "api-key",
    )
    .addTag(
      "Health",
      "Liveness, readiness, and startup probes for Kubernetes orchestration",
    )
    .addTag("Authentication", "User authentication and authorization")
    .addTag("Users", "User management operations")
    .addTag("Oracle", "Oracle data submissions")
    .addTag("Audit", "Audit trail and logging")
    .addTag("Profile", "User profile management")
    .build();

  const document = SwaggerModule.createDocument(app, config, {
    deepScanRoutes: true,
    operationIdFactory: (controllerKey: string, methodKey: string) => methodKey,
  });

  SwaggerModule.setup("api/docs", app, document, {
    customSiteTitle: "Trellis API Documentation",
    customfavIcon: `data:image/svg+xml;base64,${TRELLIS_MARK_B64}`,
    customCss: `
      .topbar-wrapper img { content: url('data:image/svg+xml;base64,${TRELLIS_MARK_B64}'); }
      .swagger-ui .topbar { background-color: #1C6B55; }
      .swagger-ui .topbar-wrapper .link { color: #F7F5F0; }
      .swagger-ui .info .title { color: #14201C; }
      .swagger-ui .btn.authorize { border-color: #1C6B55; color: #1C6B55; }
      .swagger-ui .btn.authorize svg { fill: #1C6B55; }
      .swagger-ui .btn.execute { background-color: #1C6B55; border-color: #1C6B55; }
      .swagger-ui .opblock.opblock-post { border-color: #1C6B55; background: rgba(28, 107, 85, 0.06); }
      .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #1C6B55; }
      .swagger-ui .opblock.opblock-get { border-color: #2F9E7E; background: rgba(47, 158, 126, 0.06); }
      .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #2F9E7E; }
      .swagger-ui .opblock.opblock-patch .opblock-summary-method,
      .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #E39A3C; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      showExtensions: true,
      showCommonExtensions: true,
      docExpansion: "none",
      defaultModelsExpandDepth: 2,
      defaultModelExpandDepth: 2,
      tryItOutEnabled: true,
    },
  });

  return document;
}

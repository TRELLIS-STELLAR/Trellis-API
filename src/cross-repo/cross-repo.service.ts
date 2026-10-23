import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import {
  CrossRepoClient,
  CrossRepoClientSummary,
  CrossRepoContractSchema,
  CrossRepoRequestEnvelope,
  CrossRepoValidationError,
  CrossRepoValidationResult,
} from "./cross-repo.types";
import {
  CROSS_REPO_SCHEMA_PROVIDER,
  ContractSchemaUnavailableError,
  CrossRepoSchemaProvider,
} from "./cross-repo.schema-registry";
import {
  buildCrossRepoSigningPayload,
  verifyCrossRepoSignature,
} from "./cross-repo.signing";

/**
 * Validates requests that arrive from the other Trellis repositories
 * (frontend, contracts) against the shared cross-repo contract.
 *
 * Four paths are covered deliberately:
 *
 * - **Normal** — a registered, active client sends a correctly signed request
 *   whose payload matches the contract. Returns `valid: true`.
 * - **Failure** — the payload breaks the contract (missing/ mistyped fields,
 *   failed pattern, out-of-range values) or the request is malformed. Returns
 *   `valid: false` with per-field codes.
 * - **Retry** — the contract schema provider is temporarily unavailable. The
 *   service retries with a short backoff and, if it is still unavailable,
 *   returns `valid: false, retryable: true` with a `retryAfterSeconds` hint.
 * - **Authorization** — the client is unknown, suspended, revoked, is not
 *   allowed to use the requested contract version, or the signature does not
 *   verify. Returns `valid: false` with an authorization code.
 *
 * The client secret is held in memory and never serialised.
 *
 * Issue: #353
 */
@Injectable()
export class CrossRepoRequestValidationService {
  private readonly logger = new Logger(CrossRepoRequestValidationService.name);
  private readonly clients = new Map<string, CrossRepoClient>();
  private readonly schemaRetryDelayMs: number;
  private readonly schemaMaxAttempts: number;

  constructor(
    private readonly configService: ConfigService,
    @Inject(CROSS_REPO_SCHEMA_PROVIDER)
    private readonly schemaProvider: CrossRepoSchemaProvider,
  ) {
    this.schemaRetryDelayMs =
      Number(this.configService.get("CROSS_REPO_SCHEMA_RETRY_DELAY_MS")) || 25;
    this.schemaMaxAttempts =
      Number(this.configService.get("CROSS_REPO_SCHEMA_MAX_ATTEMPTS")) || 3;
    this.seedDefaults();
  }

  async validate(
    envelope: CrossRepoRequestEnvelope,
    correlationId: string = randomUUID(),
  ): Promise<CrossRepoValidationResult> {
    const validatedAt = new Date().toISOString();

    // Authorization first: an unknown or disabled client never reaches the
    // contract checks, so its payload shape is not leaked back to it.
    const client = this.clients.get(envelope.clientId);
    if (!client) {
      return this.result(envelope, false, correlationId, validatedAt, [
        { field: "clientId", code: "UNKNOWN_CLIENT", message: "Client is not registered" },
      ]);
    }
    if (client.status !== "active") {
      return this.result(envelope, false, correlationId, validatedAt, [
        {
          field: "clientId",
          code: "CLIENT_NOT_ACTIVE",
          message: `Client status '${client.status}' is not allowed to submit requests`,
        },
      ]);
    }
    if (!client.contractVersions.includes(envelope.contractVersion)) {
      return this.result(envelope, false, correlationId, validatedAt, [
        {
          field: "contractVersion",
          code: "CONTRACT_VERSION_NOT_ALLOWED",
          message: `Client is not permitted to use contract version '${envelope.contractVersion}'`,
        },
      ]);
    }

    const signingPayload = buildCrossRepoSigningPayload(envelope);
    if (!verifyCrossRepoSignature(client.secret, signingPayload, envelope.signature)) {
      return this.result(envelope, false, correlationId, validatedAt, [
        { field: "signature", code: "INVALID_SIGNATURE", message: "Request signature did not verify" },
      ]);
    }

    // Contract resolution is the one step that can be transiently unavailable.
    const schema = await this.resolveSchemaWithRetry(
      envelope.requestType,
      envelope.contractVersion,
    );
    if (schema instanceof ContractSchemaUnavailableError) {
      this.logger.warn(
        `cross-repo schema provider unavailable for ${envelope.requestType}@${envelope.contractVersion}`,
      );
      return this.result(
        envelope,
        false,
        correlationId,
        validatedAt,
        [
          {
            field: "requestType",
            code: "SCHEMA_UNAVAILABLE",
            message: "Contract schema provider is temporarily unavailable",
          },
        ],
        { retryable: true, retryAfterSeconds: Math.max(1, Math.ceil(this.schemaRetryDelayMs / 1000)) },
      );
    }
    if (!schema) {
      return this.result(envelope, false, correlationId, validatedAt, [
        {
          field: "requestType",
          code: "UNKNOWN_CONTRACT",
          message: `No schema registered for '${envelope.requestType}@${envelope.contractVersion}'`,
        },
      ]);
    }

    const errors = this.validatePayload(envelope.payload, schema);
    client.lastUsedAt = validatedAt;
    return this.result(envelope, errors.length === 0, correlationId, validatedAt, errors);
  }

  // ---------------------------------------------------------------------------
  // Client administration (admin-only at the controller layer)
  // ---------------------------------------------------------------------------

  registerClient(input: {
    clientId: string;
    clientName: string;
    secret: string;
    scopes?: string[];
    contractVersions?: string[];
  }): CrossRepoClientSummary {
    if (this.clients.has(input.clientId)) {
      throw new Error(`Client '${input.clientId}' is already registered`);
    }
    const client: CrossRepoClient = {
      clientId: input.clientId,
      clientName: input.clientName,
      secret: input.secret,
      scopes: input.scopes ?? [],
      contractVersions: input.contractVersions ?? ["1.0"],
      status: "active",
      createdAt: new Date().toISOString(),
    };
    this.clients.set(client.clientId, client);
    this.logger.log(`Cross-repo client registered: ${client.clientId}`);
    return this.toSummary(client);
  }

  listClients(): CrossRepoClientSummary[] {
    return [...this.clients.values()].map((client) => this.toSummary(client));
  }

  updateClientStatus(clientId: string, status: CrossRepoClient["status"]): CrossRepoClientSummary {
    const client = this.clients.get(clientId);
    if (!client) throw new Error(`Client '${clientId}' is not registered`);
    client.status = status;
    this.logger.log(`Cross-repo client ${clientId} status -> ${status}`);
    return this.toSummary(client);
  }

  registerSchema(schema: CrossRepoContractSchema): CrossRepoContractSchema {
    if (!this.schemaProvider || typeof (this.schemaProvider as any).register !== "function") {
      throw new Error("Configured schema provider does not support registration");
    }
    (this.schemaProvider as any).register(schema);
    this.logger.log(`Cross-repo schema registered: ${schema.requestType}@${schema.contractVersion}`);
    return schema;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async resolveSchemaWithRetry(
    requestType: string,
    contractVersion: string,
  ): Promise<CrossRepoContractSchema | undefined | ContractSchemaUnavailableError> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.schemaMaxAttempts; attempt++) {
      try {
        return await this.schemaProvider.resolve(requestType, contractVersion);
      } catch (error) {
        lastError = error;
        if (!(error instanceof ContractSchemaUnavailableError)) throw error;
        if (attempt < this.schemaMaxAttempts) {
          await this.delay(this.schemaRetryDelayMs * attempt);
        }
      }
    }
    return lastError instanceof ContractSchemaUnavailableError
      ? lastError
      : undefined;
  }

  private validatePayload(
    payload: Record<string, unknown>,
    schema: CrossRepoContractSchema,
  ): CrossRepoValidationError[] {
    const errors: CrossRepoValidationError[] = [];

    for (const field of schema.fields) {
      const value = payload[field.name];
      const missing = value === undefined || value === null || value === "";

      if (missing) {
        if (field.required) {
          errors.push({ field: field.name, code: "REQUIRED_FIELD_MISSING", message: `Field '${field.name}' is required` });
        }
        continue;
      }

      if (field.type === "string" && typeof value !== "string") {
        errors.push({ field: field.name, code: "INVALID_TYPE", message: `Field '${field.name}' must be a string` });
        continue;
      }
      if (field.type === "number" && typeof value !== "number") {
        errors.push({ field: field.name, code: "INVALID_TYPE", message: `Field '${field.name}' must be a number` });
        continue;
      }
      if (field.type === "boolean" && typeof value !== "boolean") {
        errors.push({ field: field.name, code: "INVALID_TYPE", message: `Field '${field.name}' must be a boolean` });
        continue;
      }
      if (field.type === "array" && !Array.isArray(value)) {
        errors.push({ field: field.name, code: "INVALID_TYPE", message: `Field '${field.name}' must be an array` });
        continue;
      }
      if (field.type === "object" && (typeof value !== "object" || Array.isArray(value) || value === null)) {
        errors.push({ field: field.name, code: "INVALID_TYPE", message: `Field '${field.name}' must be an object` });
        continue;
      }

      if (typeof value === "string" && field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(value)) {
            errors.push({ field: field.name, code: "PATTERN_MISMATCH", message: `Field '${field.name}' does not match the required pattern` });
          }
        } catch {
          errors.push({ field: field.name, code: "INVALID_PATTERN", message: `Field '${field.name}' has an invalid pattern configured` });
        }
      }

      if (typeof value === "number") {
        if (field.min !== undefined && value < field.min) {
          errors.push({ field: field.name, code: "VALUE_BELOW_MINIMUM", message: `Field '${field.name}' must be >= ${field.min}` });
        }
        if (field.max !== undefined && value > field.max) {
          errors.push({ field: field.name, code: "VALUE_ABOVE_MAXIMUM", message: `Field '${field.name}' must be <= ${field.max}` });
        }
      }

      if (field.allowed && field.allowed.length > 0 && !field.allowed.includes(value as string)) {
        errors.push({ field: field.name, code: "VALUE_NOT_ALLOWED", message: `Field '${field.name}' must be one of: ${field.allowed.join(", ")}` });
      }
    }

    return errors;
  }

  private result(
    envelope: CrossRepoRequestEnvelope,
    valid: boolean,
    correlationId: string,
    validatedAt: string,
    errors: CrossRepoValidationError[],
    extras: { retryable?: boolean; retryAfterSeconds?: number } = {},
  ): CrossRepoValidationResult {
    return {
      valid,
      clientId: envelope.clientId,
      requestType: envelope.requestType,
      contractVersion: envelope.contractVersion,
      errors,
      retryable: extras.retryable ?? false,
      retryAfterSeconds: extras.retryAfterSeconds,
      validatedAt,
      correlationId,
    };
  }

  private toSummary(client: CrossRepoClient): CrossRepoClientSummary {
    return {
      clientId: client.clientId,
      clientName: client.clientName,
      scopes: client.scopes,
      status: client.status,
      contractVersions: client.contractVersions,
      createdAt: client.createdAt,
      lastUsedAt: client.lastUsedAt,
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private seedDefaults(): void {
    this.registerClient({
      clientId: "trellis-frontend",
      clientName: "Trellis Frontend",
      secret: this.configService.get<string>("CROSS_REPO_FRONTEND_SECRET") ?? "cross-repo-frontend-dev-secret",
      scopes: ["oracle:submit", "portfolio:import"],
      contractVersions: ["1.0"],
    });
    this.registerClient({
      clientId: "trellis-contracts",
      clientName: "Trellis Contracts Adapter",
      secret: this.configService.get<string>("CROSS_REPO_CONTRACTS_SECRET") ?? "cross-repo-contracts-dev-secret",
      scopes: ["oracle:submit"],
      contractVersions: ["1.0"],
    });
  }
}

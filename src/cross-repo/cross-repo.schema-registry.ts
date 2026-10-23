import { Injectable } from "@nestjs/common";
import {
  CrossRepoContractSchema,
  CrossRepoFieldSchema,
} from "./cross-repo.types";

/** Injection token for the contract schema provider seam. */
export const CROSS_REPO_SCHEMA_PROVIDER = Symbol("CROSS_REPO_SCHEMA_PROVIDER");

/**
 * Provider seam for the cross-repo contract schemas. Kept separate from the
 * registry so the validation service can be unit-tested against a fake that
 * fails transiently, and so a database-backed registry can replace the
 * in-memory one without touching the service.
 */
export interface CrossRepoSchemaProvider {
  resolve(
    requestType: string,
    contractVersion: string,
  ): Promise<CrossRepoContractSchema | undefined>;
  list(): CrossRepoContractSchema[];
}

/** Raised when the schema source cannot be read; the caller should retry. */
export class ContractSchemaUnavailableError extends Error {
  constructor(message = "Contract schema provider temporarily unavailable") {
    super(message);
    this.name = "ContractSchemaUnavailableError";
  }
}

/**
 * In-memory registry of the cross-repo request contracts.
 *
 * Defaults mirror the shared contract in
 * `src/common/contract/types/trellis-contract.types.ts` (issue #120) for the
 * request types that cross repository boundaries: auth challenges, oracle
 * submissions and portfolio imports. Additional schemas are additive and do
 * not change existing verdicts.
 */
@Injectable()
export class CrossRepoContractSchemaRegistry implements CrossRepoSchemaProvider {
  private readonly schemas = new Map<string, CrossRepoContractSchema>();

  constructor() {
    this.registerDefaults();
  }

  register(schema: CrossRepoContractSchema): void {
    this.schemas.set(this.key(schema.requestType, schema.contractVersion), schema);
  }

  list(): CrossRepoContractSchema[] {
    return [...this.schemas.values()].map((schema) => ({
      ...schema,
      fields: schema.fields.map((field) => ({ ...field })),
    }));
  }

  async resolve(
    requestType: string,
    contractVersion: string,
  ): Promise<CrossRepoContractSchema | undefined> {
    const schema = this.schemas.get(this.key(requestType, contractVersion));
    return schema
      ? { ...schema, fields: schema.fields.map((field) => ({ ...field })) }
      : undefined;
  }

  private key(requestType: string, contractVersion: string): string {
    return `${requestType}@${contractVersion}`;
  }

  private registerDefaults(): void {
    const authChallenge: CrossRepoFieldSchema[] = [
      { name: "walletAddress", type: "string", required: true, pattern: "^G[A-Z2-7]{55}$" },
    ];

    const oracleSubmission: CrossRepoFieldSchema[] = [
      { name: "payloadHash", type: "string", required: true, pattern: "^[a-f0-9]{64}$" },
      { name: "signer", type: "string", required: true },
      { name: "fee", type: "string", required: true, pattern: "^\\d+(\\.\\d+)?$" },
    ];

    const portfolioImport: CrossRepoFieldSchema[] = [
      { name: "source", type: "string", required: true, allowed: ["csv", "json", "xlsx"] },
      { name: "rows", type: "array", required: true },
      { name: "dryRun", type: "boolean", required: false },
    ];

    this.register({ requestType: "auth.challenge", contractVersion: "1.0", fields: authChallenge });
    this.register({ requestType: "oracle.submission", contractVersion: "1.0", fields: oracleSubmission });
    this.register({ requestType: "portfolio.import", contractVersion: "1.0", fields: portfolioImport });
  }
}

/** Helper so modules can provide the registry against the provider token. */
export function crossRepoSchemaProviderProvider() {
  return {
    provide: CROSS_REPO_SCHEMA_PROVIDER,
    useClass: CrossRepoContractSchemaRegistry,
  };
}

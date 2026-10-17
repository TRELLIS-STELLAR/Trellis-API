import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  MigrationHistoryUnavailableError,
  checkStorageSchemaCompatibility,
  type StorageSchemaCompatibilityReport,
} from "./storage-compatibility/storage-schema-compatibility";

@Injectable()
export class AppService {
  constructor(private readonly dataSource: DataSource) {}

  getHealth(): { status: string; timestamp: string } {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }

  getInfo(): {
    name: string;
    version: string;
    description: string;
    modules: string[];
  } {
    return {
      name: "Trellis Backend",
      version: "0.1.0",
      description: "Off-chain services + API layer for Trellis agents",
      modules: [
        "AI Compute Bridge",
        "Real-time Dashboard (WebSocket)",
        "User Authentication",
        "Agent Discovery",
        "Price Oracles",
      ],
    };
  }

  async getStorageMigrationCompatibility(): Promise<StorageSchemaCompatibilityReport> {
    try {
      return await checkStorageSchemaCompatibility(this.dataSource);
    } catch (error) {
      if (error instanceof MigrationHistoryUnavailableError) {
        throw new ServiceUnavailableException(
          "Migration history is unavailable; storage compatibility cannot be verified safely.",
        );
      }
      throw error;
    }
  }
}

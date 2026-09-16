import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
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
}

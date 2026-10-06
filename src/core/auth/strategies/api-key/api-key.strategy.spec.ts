import { JwtService } from "@nestjs/jwt";
import { ApiKeyStrategy } from "./api-key.strategy";

describe("ApiKeyStrategy", () => {
  const user = {
    id: "owner",
    email: "owner@example.com",
    username: "owner",
    role: "USER",
  };
  it("keeps configured static keys working and includes their scopes", async () => {
    const jwt = new JwtService({ secret: "test-secret" });
    const strategy = new ApiKeyStrategy(
      {
        get: (key, fallback) =>
          key === "SYSTEM_API_KEYS"
            ? JSON.stringify([
                {
                  key: "static",
                  userId: "owner",
                  name: "legacy",
                  permissions: ["read"],
                },
              ])
            : fallback,
      } as any,
      jwt,
      { findOne: async () => user } as any,
      {} as any,
    );
    const result = await strategy.authenticate({ apiKey: "static" });
    expect(await strategy.validateToken(result.token)).toMatchObject({
      type: "api-key",
      permissions: ["read"],
    });
    expect(result.token).not.toContain("static");
  });
  it("authenticates stored keys and binds JWTs to their persisted ID", async () => {
    const stored = {
      id: "key-id",
      userId: "owner",
      name: "worker",
      permissions: ["read"],
    };
    const keys: any = {
      validate: jest.fn().mockResolvedValue(stored),
      validateTokenKey: jest.fn().mockResolvedValue(stored),
    };
    const strategy = new ApiKeyStrategy(
      { get: (_, fallback) => fallback } as any,
      new JwtService({ secret: "test-secret" }),
      { findOne: async () => user } as any,
      keys,
    );
    const result = await strategy.authenticate({ apiKey: "persisted" });
    expect(await strategy.validateToken(result.token)).toMatchObject({
      apiKeyId: "key-id",
    });
    keys.validateTokenKey.mockRejectedValue(new Error("revoked"));
    expect(await strategy.validateToken(result.token)).toBeNull();
    keys.validate.mockResolvedValue(null);
    await expect(strategy.authenticate({ apiKey: "unknown" })).rejects.toThrow(
      "Invalid API key",
    );
  });
});

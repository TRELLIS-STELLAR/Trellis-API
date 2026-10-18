import { UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtStrategy } from "./jwt.strategy";
import { TokenBlacklistService } from "./token-blacklist.service";

/**
 * Issue #369: the strategy must refuse revoked jtis and stale sessions, and
 * keep accepting valid tokens.
 */
describe("JwtStrategy session validation", () => {
  let blacklist: TokenBlacklistService;
  let strategy: JwtStrategy;

  beforeEach(() => {
    blacklist = new TokenBlacklistService();
    const config = {
      get: jest.fn().mockReturnValue("test-secret-test-secret-test-secret"),
    } as unknown as ConfigService;
    strategy = new JwtStrategy(config, blacklist);
  });

  afterEach(async () => {
    await blacklist.onModuleDestroy();
  });

  it("accepts a token issued after the subject cutoff", async () => {
    await blacklist.revokeSubjectSessions("user-1", 1000);

    const user = await strategy.validate({ sub: "user-1", iat: 1001, jti: "a" });

    expect(user.id).toBe("user-1");
  });

  it("rejects a token issued before the subject cutoff", async () => {
    await blacklist.revokeSubjectSessions("user-1", 1000);

    await expect(
      strategy.validate({ sub: "user-1", iat: 900, jti: "a" }),
    ).rejects.toThrow(new UnauthorizedException("Session is no longer valid"));
  });

  it("rejects a wallet session issued before the subject cutoff", async () => {
    await blacklist.revokeSubjectSessions("GWALLET", 1000);

    await expect(
      strategy.validate({ address: "GWALLET", iat: 1000 }),
    ).rejects.toThrow("Session is no longer valid");
  });

  it("still rejects an individually revoked jti", async () => {
    await blacklist.revoke("revoked-jti", Date.now() + 60_000);

    await expect(
      strategy.validate({ sub: "user-1", iat: 5000, jti: "revoked-jti" }),
    ).rejects.toThrow("Token has been revoked");
  });

  it("does not affect other subjects", async () => {
    await blacklist.revokeSubjectSessions("user-1", 1000);

    const user = await strategy.validate({ sub: "user-2", iat: 10 });

    expect(user.id).toBe("user-2");
  });
});

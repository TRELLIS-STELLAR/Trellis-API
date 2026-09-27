import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { AdminTwoFactorGuard } from "./admin-two-factor.guard";

describe("AdminTwoFactorGuard", () => {
  let guard: AdminTwoFactorGuard;
  let isTwoFactorEnabled: jest.Mock;
  let userRepository: { findOne: jest.Mock };

  const contextWith = (user: unknown): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    }) as unknown as ExecutionContext;

  beforeEach(() => {
    isTwoFactorEnabled = jest.fn();
    userRepository = { findOne: jest.fn() };
    guard = new AdminTwoFactorGuard(
      { isTwoFactorEnabled } as never,
      userRepository as never,
    );
  });

  it("allows non-admin users through without checking 2FA", async () => {
    await expect(
      guard.canActivate(contextWith({ id: "u1", role: "user" })),
    ).resolves.toBe(true);
    expect(isTwoFactorEnabled).not.toHaveBeenCalled();
  });

  it("blocks an admin who has not enabled 2FA", async () => {
    isTwoFactorEnabled.mockResolvedValue(false);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: true }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("blocks an admin with 2FA enabled but an unverified session", async () => {
    isTwoFactorEnabled.mockResolvedValue(true);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: false }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows an admin with 2FA enabled and a verified session", async () => {
    isTwoFactorEnabled.mockResolvedValue(true);
    await expect(
      guard.canActivate(
        contextWith({ id: "admin-1", role: "admin", twoFactorVerified: true }),
      ),
    ).resolves.toBe(true);
  });

  it("resolves a wallet admin's user id from the wallet address", async () => {
    userRepository.findOne.mockResolvedValue({ id: "admin-2" });
    isTwoFactorEnabled.mockResolvedValue(true);

    await expect(
      guard.canActivate(
        contextWith({
          address: "0xABC",
          role: "admin",
          twoFactorVerified: true,
        }),
      ),
    ).resolves.toBe(true);

    expect(userRepository.findOne).toHaveBeenCalledWith({
      where: { walletAddress: "0xabc" },
    });
    expect(isTwoFactorEnabled).toHaveBeenCalledWith("admin-2");
  });
});

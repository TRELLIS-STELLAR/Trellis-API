import { Test, TestingModule } from "@nestjs/testing";
import { getRepositoryToken } from "@nestjs/typeorm";
import { JwtService } from "@nestjs/jwt";
import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import * as speakeasy from "speakeasy";
import { EnhancedAuthService } from "./enhanced-auth.service";
import { EmailService } from "./email.service";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { User } from "../user/entities/user.entity";
import {
  RefreshToken,
  TwoFactorAuth,
  TwoFactorStatus,
} from "./entities/auth.entity";

// bcrypt is mocked so password checks are deterministic
jest.mock("bcrypt", () => ({
  hash: jest.fn().mockResolvedValue("hashed"),
  compare: jest.fn(),
}));
import * as bcrypt from "bcrypt";

// qrcode does real work; stub it to keep the test fast and offline
jest.mock("qrcode", () => ({
  toDataURL: jest.fn().mockResolvedValue("data:image/png;base64,stub"),
}));

describe("EnhancedAuthService — 2FA", () => {
  let service: EnhancedAuthService;
  let twoFactorRecord: Partial<TwoFactorAuth> | null;

  const user: Partial<User> = {
    id: "user-1",
    email: "user@example.com",
    username: "user",
    password: "hashed-pw",
    role: undefined as never,
  };

  const userRepository = {
    findOne: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
  };

  const refreshTokenRepository = {
    create: jest.fn((v) => v),
    save: jest.fn((v) => Promise.resolve(v)),
    update: jest.fn(),
    findOne: jest.fn(),
  };

  // Backed by `twoFactorRecord` so mutations persist across calls within a test
  const twoFactorRepository = {
    findOne: jest.fn(() => Promise.resolve(twoFactorRecord)),
    find: jest.fn(() =>
      Promise.resolve(twoFactorRecord ? [twoFactorRecord] : []),
    ),
    create: jest.fn((v) => v),
    save: jest.fn((v) => {
      twoFactorRecord = { ...twoFactorRecord, ...v };
      return Promise.resolve(twoFactorRecord);
    }),
    update: jest.fn((_where, patch) => {
      if (twoFactorRecord) twoFactorRecord = { ...twoFactorRecord, ...patch };
      return Promise.resolve({ affected: 1 });
    }),
    delete: jest.fn(() => Promise.resolve({ affected: 1 })),
  };

  const jwtService = { sign: jest.fn().mockReturnValue("signed.jwt.token") };

  const emailService = {
    send2faChangeNotification: jest.fn().mockResolvedValue({ messageId: "m" }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    twoFactorRecord = null;
    (bcrypt.compare as jest.Mock).mockResolvedValue(true);
    userRepository.findOne.mockResolvedValue(user);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EnhancedAuthService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: getRepositoryToken(RefreshToken),
          useValue: refreshTokenRepository,
        },
        {
          provide: getRepositoryToken(TwoFactorAuth),
          useValue: twoFactorRepository,
        },
        { provide: JwtService, useValue: jwtService },
        { provide: EmailService, useValue: emailService },
        {
          provide: EventEmitter2,
          useValue: { emitAsync: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();

    service = module.get(EnhancedAuthService);
  });

  describe("setupTwoFactor", () => {
    it("returns a secret, QR code and 10 plaintext backup codes, persisting only hashes", async () => {
      const result = await service.setupTwoFactor(user.id!, {
        type: "totp",
      } as never);

      expect(result.secret).toBeDefined();
      expect(result.qrCodeUrl).toContain("data:image/png");
      expect(result.backupCodes).toHaveLength(10);

      // Persisted codes must be hashes, never the plaintext shown to the user
      const stored = JSON.parse(
        (twoFactorRepository.create.mock.calls[0][0] as TwoFactorAuth)
          .backupCodes,
      );
      expect(stored).toHaveLength(10);
      expect(stored).not.toEqual(expect.arrayContaining(result.backupCodes));
      expect(stored[0]).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    });

    it("rejects setup when 2FA is already enabled", async () => {
      twoFactorRecord = { isEnabled: true } as TwoFactorAuth;
      await expect(
        service.setupTwoFactor(user.id!, { type: "totp" } as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("verifyTwoFactorSetup", () => {
    it("enables 2FA on a valid TOTP and emails the user", async () => {
      const secret = speakeasy.generateSecret();
      twoFactorRecord = {
        id: "2fa-1",
        userId: user.id,
        secret: secret.base32,
        status: TwoFactorStatus.PENDING,
        isEnabled: false,
      } as TwoFactorAuth;

      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });

      const result = await service.verifyTwoFactorSetup(user.id!, token);

      expect(result.success).toBe(true);
      expect(twoFactorRecord.isEnabled).toBe(true);
      expect(emailService.send2faChangeNotification).toHaveBeenCalledWith(
        user.email,
        "enabled",
      );
    });

    it("does not enable on an invalid code", async () => {
      const secret = speakeasy.generateSecret();
      twoFactorRecord = {
        id: "2fa-1",
        userId: user.id,
        secret: secret.base32,
        status: TwoFactorStatus.PENDING,
        isEnabled: false,
      } as TwoFactorAuth;

      const result = await service.verifyTwoFactorSetup(user.id!, "000000");
      expect(result.success).toBe(false);
      expect(emailService.send2faChangeNotification).not.toHaveBeenCalled();
    });
  });

  describe("verifyTwoFactorLogin", () => {
    let secret: speakeasy.GeneratedSecret;

    beforeEach(() => {
      secret = speakeasy.generateSecret();
      twoFactorRecord = {
        id: "2fa-1",
        userId: user.id,
        secret: secret.base32,
        isEnabled: true,
        failedAttempts: 0,
        lockedUntil: null,
        backupCodes: "[]",
      } as TwoFactorAuth;
    });

    it("issues tokens on a valid TOTP code", async () => {
      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });
      const result = await service.verifyTwoFactorLogin(user.id!, {
        code: token,
      });
      expect(result.accessToken).toBeDefined();
      expect(result.refreshToken).toBeDefined();
      // token should be marked 2FA-verified
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ twoFactorVerified: true }),
      );
      expect(twoFactorRecord!.failedAttempts).toBe(0);
    });

    it("accepts a single-use backup code and consumes it", async () => {
      // Seed one known backup code by regenerating via setup helper path:
      const setup = await service.regenerateBackupCodes(user.id!, "pw");
      const aCode = setup.backupCodes[0];

      const result = await service.verifyTwoFactorLogin(user.id!, {
        backupCode: aCode,
      });
      expect(result.accessToken).toBeDefined();

      // Re-using the same backup code must now fail
      await expect(
        service.verifyTwoFactorLogin(user.id!, { backupCode: aCode }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("increments failedAttempts and locks the account after 5 failures", async () => {
      for (let i = 0; i < 4; i++) {
        await expect(
          service.verifyTwoFactorLogin(user.id!, { code: "000000" }),
        ).rejects.toBeInstanceOf(UnauthorizedException);
      }
      expect(twoFactorRecord!.failedAttempts).toBe(4);

      // 5th failure triggers the lockout
      await expect(
        service.verifyTwoFactorLogin(user.id!, { code: "000000" }),
      ).rejects.toThrow(/locked/i);
      expect(twoFactorRecord!.lockedUntil).toBeInstanceOf(Date);
      expect(twoFactorRecord!.lockedUntil!.getTime()).toBeGreaterThan(
        Date.now(),
      );
    });

    it("rejects verification while locked out, even with a valid code", async () => {
      twoFactorRecord!.lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      const token = speakeasy.totp({
        secret: secret.base32,
        encoding: "base32",
      });
      await expect(
        service.verifyTwoFactorLogin(user.id!, { code: token }),
      ).rejects.toThrow(/locked/i);
    });

    it("throws when 2FA is not enabled", async () => {
      twoFactorRecord = null;
      await expect(
        service.verifyTwoFactorLogin(user.id!, { code: "123456" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("disableTwoFactor", () => {
    beforeEach(() => {
      twoFactorRecord = {
        id: "2fa-1",
        userId: user.id,
        isEnabled: true,
      } as TwoFactorAuth;
    });

    it("disables 2FA with a valid password and emails the user", async () => {
      const result = await service.disableTwoFactor(user.id!, "pw");
      expect(result.success).toBe(true);
      expect(twoFactorRecord!.isEnabled).toBe(false);
      expect(emailService.send2faChangeNotification).toHaveBeenCalledWith(
        user.email,
        "disabled",
      );
    });

    it("rejects an invalid password", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(
        service.disableTwoFactor(user.id!, "wrong"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("regenerateBackupCodes", () => {
    beforeEach(() => {
      twoFactorRecord = {
        id: "2fa-1",
        userId: user.id,
        isEnabled: true,
        backupCodes: "[]",
      } as TwoFactorAuth;
    });

    it("returns 10 new codes and emails the user", async () => {
      const result = await service.regenerateBackupCodes(user.id!, "pw");
      expect(result.backupCodes).toHaveLength(10);
      expect(emailService.send2faChangeNotification).toHaveBeenCalledWith(
        user.email,
        "backup-codes-regenerated",
      );
    });

    it("rejects an invalid password", async () => {
      (bcrypt.compare as jest.Mock).mockResolvedValue(false);
      await expect(
        service.regenerateBackupCodes(user.id!, "wrong"),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("throws when 2FA is not enabled", async () => {
      twoFactorRecord = null;
      await expect(
        service.regenerateBackupCodes(user.id!, "pw"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("getTwoFactorStatus", () => {
    it("reports enabled status and remaining backup codes", async () => {
      twoFactorRecord = {
        userId: user.id,
        isEnabled: true,
        status: TwoFactorStatus.VERIFIED,
        backupCodes: JSON.stringify(["a", "b", "c"]),
        lockedUntil: null,
      } as TwoFactorAuth;

      const status = await service.getTwoFactorStatus(user.id!);
      expect(status.enabled).toBe(true);
      expect(status.remainingBackupCodes).toBe(3);
      expect(status.lockedUntil).toBeNull();
    });

    it("reports disabled status when no record exists", async () => {
      twoFactorRecord = null;
      const status = await service.getTwoFactorStatus(user.id!);
      expect(status.enabled).toBe(false);
      expect(status.remainingBackupCodes).toBe(0);
    });
  });

  describe("isTwoFactorEnabled", () => {
    it("returns false when no enabled record exists", async () => {
      twoFactorRecord = null;
      await expect(service.isTwoFactorEnabled(user.id!)).resolves.toBe(false);
    });
  });
});

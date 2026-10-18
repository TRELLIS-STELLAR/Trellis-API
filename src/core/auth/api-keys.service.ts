import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { createHash, randomBytes } from "crypto";
import { ApiKey } from "./entities/api-key.entity";
import { Permission } from "src/common/guard/roles.enum";

export function hashApiKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

@Injectable()
export class ApiKeysService {
  // Cache only metadata. Every use still checks mutable validity atomically in the DB.
  private readonly cache = new Map<
    string,
    { metadata: ApiKey; until: number }
  >();
  constructor(
    @InjectRepository(ApiKey) private readonly repository: Repository<ApiKey>,
  ) {}

  async create(
    userId: string,
    name: string,
    permissions: string[] = ["read"],
    expiresInDays?: number,
  ) {
    const supported: string[] = ["read", "write", ...Object.values(Permission)];
    if (
      !userId ||
      typeof name !== "string" ||
      !name.trim() ||
      name.length > 100 ||
      !Array.isArray(permissions) ||
      !permissions.length ||
      permissions.some((scope) => !supported.includes(scope)) ||
      (expiresInDays !== undefined &&
        (!Number.isInteger(expiresInDays) ||
          expiresInDays < 1 ||
          expiresInDays > 365))
    ) {
      throw new BadRequestException(
        "Provide a name, supported scopes, and an optional expiry of 1–365 days",
      );
    }
    const key = `sk_${randomBytes(32).toString("hex")}`;
    const saved = await this.repository.save(
      this.repository.create({
        keyHash: hashApiKey(key),
        userId,
        name: name.trim(),
        permissions: [...new Set(permissions)],
        expiresAt: expiresInDays
          ? new Date(Date.now() + expiresInDays * 86400000)
          : null,
        revoked: false,
      }),
    );
    // The plaintext exists only in this response; list and logs never contain it.
    return { ...this.metadata(saved), key };
  }

  private metadata(value: ApiKey) {
    const { id, name, permissions, createdAt, lastUsedAt, expiresAt, revoked } =
      value;
    return { id, name, permissions, createdAt, lastUsedAt, expiresAt, revoked };
  }

  async list(userId: string) {
    return (
      await this.repository.find({
        where: { userId },
        order: { createdAt: "DESC" },
      })
    ).map((key) => this.metadata(key));
  }

  async revoke(userId: string, id: string) {
    const result = await this.repository.update(
      { id, userId },
      { revoked: true },
    );
    if (!result.affected) throw new NotFoundException("API key not found");
    for (const [hash, entry] of this.cache)
      if (entry.metadata.id === id) this.cache.delete(hash);
  }

  async touch(id: string): Promise<boolean> {
    // Database time and a conditional update provide immediate cross-process revocation.
    const result = await this.repository
      .createQueryBuilder()
      .update(ApiKey)
      .set({ lastUsedAt: () => "CURRENT_TIMESTAMP" })
      .where(
        '"id" = :id AND "revoked" = false AND ("expiresAt" IS NULL OR "expiresAt" > CURRENT_TIMESTAMP)',
        { id },
      )
      .execute();
    return result.affected === 1;
  }

  async validate(key: string): Promise<ApiKey | null> {
    if (typeof key !== "string" || key.length > 256) return null;
    const hash = hashApiKey(key);
    let entry = this.cache.get(hash);
    if (!entry || entry.until <= Date.now()) {
      const metadata = await this.repository.findOne({
        where: { keyHash: hash },
      });
      if (!metadata) return null;
      if (this.cache.size >= 1000)
        this.cache.delete(this.cache.keys().next().value);
      entry = { metadata, until: Date.now() + 30000 };
      this.cache.set(hash, entry);
    }
    if (!(await this.touch(entry.metadata.id))) {
      this.cache.delete(hash);
      return null;
    }
    return entry.metadata;
  }

  async validateTokenKey(id: string, userId: string) {
    const metadata = await this.repository.findOne({ where: { id, userId } });
    if (!metadata || !(await this.touch(id)))
      throw new UnauthorizedException("API key is revoked or expired");
    return metadata;
  }
}

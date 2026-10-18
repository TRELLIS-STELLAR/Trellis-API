import { ApiKeysService, hashApiKey } from "./api-keys.service";

describe("ApiKeysService", () => {
  let service: ApiKeysService;
  let repository: any;
  let stored: any[];
  beforeEach(() => {
    stored = [];
    let currentId: string;
    const builder: any = {
      update: () => builder,
      set: () => builder,
      where: jest.fn((_, { id }) => {
        currentId = id;
        return builder;
      }),
      execute: async () => {
        const key = stored.find(
          (entry) =>
            entry.id === currentId &&
            !entry.revoked &&
            (!entry.expiresAt || entry.expiresAt > new Date()),
        );
        if (key) key.lastUsedAt = new Date();
        return { affected: key ? 1 : 0 };
      },
    };
    repository = {
      create: (value) => value,
      save: jest.fn(async (value) => {
        const entry = {
          ...value,
          id: String(stored.length + 1),
          createdAt: new Date(),
        };
        stored.push(entry);
        return entry;
      }),
      find: async ({ where }) =>
        stored.filter((entry) => entry.userId === where.userId),
      findOne: jest.fn(
        async ({ where }) =>
          stored.find((entry) =>
            Object.entries(where).every(([key, value]) => entry[key] === value),
          ) ?? null,
      ),
      update: jest.fn(async (where, value) => {
        const entry = stored.find(
          (row) => row.id === where.id && row.userId === where.userId,
        );
        if (entry) Object.assign(entry, value);
        return { affected: entry ? 1 : 0 };
      }),
      createQueryBuilder: () => builder,
    };
    service = new ApiKeysService(repository);
  });
  it("shows a random plaintext key once and stores only its hash", async () => {
    const result = await service.create("owner", "integration", ["read"]);
    expect(result.key).toMatch(/^sk_[0-9a-f]{64}$/);
    expect(stored[0].keyHash).toEqual(hashApiKey(result.key));
    expect(stored[0].key).toBeUndefined();
    expect(result).not.toHaveProperty("keyHash");
    expect(await service.list("owner")).toEqual([
      expect.objectContaining({ id: result.id, permissions: ["read"] }),
    ]);
    expect(JSON.stringify(await service.list("owner"))).not.toContain(
      result.key,
    );
    expect(JSON.stringify(await service.list("owner"))).not.toContain(
      stored[0].keyHash,
    );
  });
  it("accepts a valid key, caches metadata, and records last use", async () => {
    const { key } = await service.create("owner", "worker");
    expect(await service.validate(key)).toBeDefined();
    expect(await service.validate(key)).toBeDefined();
    expect(repository.findOne).toHaveBeenCalledTimes(1);
    expect(stored[0].lastUsedAt).toBeInstanceOf(Date);
  });
  it("rejects unknown keys", async () => {
    expect(await service.validate("unknown")).toBeNull();
  });
  it("rejects expired keys", async () => {
    const { key } = await service.create("owner", "worker");
    stored[0].expiresAt = new Date(Date.now() - 1000);
    expect(await service.validate(key)).toBeNull();
  });
  it("revokes immediately through a populated cache and another process", async () => {
    const { key, id } = await service.create("owner", "worker");
    await service.validate(key);
    await new ApiKeysService(repository).revoke("owner", id);
    expect(await service.validate(key)).toBeNull();
    await expect(service.validateTokenKey(id, "owner")).rejects.toThrow(
      "revoked or expired",
    );
  });
  it("limits listing and revocation to the owner", async () => {
    const { id } = await service.create("owner", "worker");
    expect(await service.list("other")).toEqual([]);
    await expect(service.revoke("other", id)).rejects.toThrow("not found");
    expect(stored[0].revoked).toBe(false);
  });
  it("rejects invalid scopes, names and expiration", async () => {
    await expect(
      service.create("owner", "worker", ["unknown"]),
    ).rejects.toThrow("supported scopes");
    await expect(service.create("owner", " ")).rejects.toThrow();
    await expect(
      service.create("owner", "worker", ["read"], -1),
    ).rejects.toThrow();
    expect(repository.save).not.toHaveBeenCalled();
  });
});

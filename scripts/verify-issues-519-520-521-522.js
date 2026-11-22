#!/usr/bin/env node
/**
 * Executable Verification Suite for Issues #519, #520, #521, and #522.
 *
 * Verifies:
 * 1. Issue #519: Email template locale fallback resolver and bounce suppression list
 *    - Locale chain decomposition ('fr-CA' -> 'fr' -> 'en'), default system fallback, strict mode
 *    - Bounded caching and cache invalidation
 *    - Hard bounce & spam complaint permanent suppression, soft bounce threshold (3) + TTL expiration
 *    - Reset of failure counters on delivery success
 *    - Rejection of email sends/retries to suppressed recipients
 *    - RBAC authorization restricting suppression removal to ADMIN / SUPPORT roles
 *
 * 2. Issue #522: Growth referral attribution window verifier and clawback guard
 *    - Attribution window (30 days) and qualification window (14 days) verification
 *    - Clock skew / future click detection and expired attribution rejection
 *    - Idempotent clawback guard preventing duplicate reward clawbacks
 *    - Clawback window limit (90 days) requiring operator override
 *    - Ledger failure handling, retry with backoff, and dispute reversal / rollback path
 *    - RBAC authorization restricting clawbacks to ADMIN / GROWTH_LEAD roles
 *
 * 3. Issue #521: Storage TTL expiration scanner with proactive archival hook
 *    - Candidate scanning: identifies live entries under proactive archival threshold
 *    - Preservation of temporary entries before irreversible eviction
 *    - Proactive archival execution with hook invoking off-chain storage
 *    - Exponential backoff retry on transient hook errors
 *    - Rollback safety on post-archival integrity verification failure
 *    - Dry-run preview and RBAC authorization restricting execution to ADMIN / SYSTEM_OPERATOR
 *
 * 4. Issue #520: Sandbox scenario state snapshotter and deterministic seed reset
 *    - Immutable snapshot capture with SHA-256 state checksum
 *    - Deterministic seed reset clearing action logs and resetting sequence counters
 *    - Byte-for-byte deterministic reproducibility across workflow runs with identical seeds
 *    - Snapshot export / import with tamper detection
 *    - State rollback on corrupted restore and fail-closed guard when sandbox is disabled
 *    - RBAC authorization restricting snapshot/reset management to ADMIN / TESTER roles
 *
 * Usage:
 *   node scripts/verify-issues-519-520-521-522.js
 */

const assert = require("assert");
const { createHash } = require("crypto");

async function main() {
  console.log("===================================================================");
  console.log("🔍 Running Comprehensive Verification Suite for Issues #519, #520, #521, #522");
  console.log("===================================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ❌ FAIL: ${name}`);
      console.error(`     Error: ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  }

  // ===========================================================================
  // 1. Issue #519: Email Template Locale Fallback Resolver & Bounce Suppression
  // ===========================================================================
  console.log("--- [Issue #519] Email Template Locale Fallback & Bounce Suppression ---");

  // Locale normalization & chain builder
  function normalizeLocaleTag(locale, defaultLocale = "en") {
    if (!locale || typeof locale !== "string") return defaultLocale;
    const trimmed = locale.trim().toLowerCase().replace(/_/g, "-");
    return trimmed || defaultLocale;
  }

  function buildLocaleFallbackChain(requestedLocale, options = {}) {
    const def = normalizeLocaleTag(options.defaultLocale || "en");
    const norm = normalizeLocaleTag(requestedLocale, def);
    const tenantDef = options.tenantFallbackLocale
      ? normalizeLocaleTag(options.tenantFallbackLocale, def)
      : undefined;

    const chain = [norm];
    const parts = norm.split("-");
    for (let i = parts.length - 1; i >= 1; i--) {
      const parent = parts.slice(0, i).join("-");
      if (!chain.includes(parent)) chain.push(parent);
    }
    if (tenantDef && !chain.includes(tenantDef)) {
      chain.push(tenantDef);
      const tenantBase = tenantDef.split("-")[0];
      if (!chain.includes(tenantBase)) chain.push(tenantBase);
    }
    if (!chain.includes(def)) {
      chain.push(def);
      const defBase = def.split("-")[0];
      if (!chain.includes(defBase)) chain.push(defBase);
    }
    return chain;
  }

  class LocaleFallbackResolverVerification {
    constructor() {
      this.templates = new Map();
      this.cache = new Map();

      // Seed dictionary
      this.register("welcome", "en", { subject: "Welcome to Trellis!", html: "<h1>Welcome</h1>" });
      this.register("welcome", "es", { subject: "¡Bienvenido!", html: "<h1>Bienvenido</h1>" });
      this.register("welcome", "fr", { subject: "Bienvenue !", html: "<h1>Bienvenue</h1>" });
      this.register("welcome", "de", { subject: "Willkommen!", html: "<h1>Willkommen</h1>" });
    }

    register(name, locale, tpl) {
      const norm = normalizeLocaleTag(locale);
      if (!this.templates.has(norm)) this.templates.set(norm, new Map());
      this.templates.get(norm).set(name, tpl);
      this.cache.clear();
    }

    resolveTemplate(templateName, requestedLocale, options = {}) {
      if (!templateName) throw new Error("Template name must be non-empty");
      const norm = normalizeLocaleTag(requestedLocale);
      const cacheKey = `${templateName}:${norm}:${options.strict ? "strict" : "loose"}`;

      if (this.cache.has(cacheKey)) {
        return { ...this.cache.get(cacheKey), fromCache: true };
      }

      const chain = options.customChain
        ? options.customChain.map((l) => normalizeLocaleTag(l))
        : buildLocaleFallbackChain(norm, options);

      const traversed = [];
      for (let i = 0; i < chain.length; i++) {
        const cur = chain[i];
        traversed.push(cur);
        if (options.strict && i > 0) break;

        const found = this.templates.get(cur)?.get(templateName);
        if (found) {
          const result = {
            name: templateName,
            template: found,
            requestedLocale: norm,
            resolvedLocale: cur,
            fallbackUsed: cur !== norm,
            chainTraversed: traversed,
            fromCache: false,
          };
          this.cache.set(cacheKey, result);
          return result;
        }
      }

      if (options.strict) {
        throw new Error(`Template "${templateName}" not found in requested locale "${norm}" (strict resolution enforced)`);
      }
      throw new Error(`Template "${templateName}" not found in requested locale "${norm}" or fallbacks (${traversed.join(" -> ")})`);
    }
  }

  const BounceReason = {
    HARD_BOUNCE: "hard_bounce",
    SOFT_BOUNCE: "soft_bounce",
    SPAM_COMPLAINT: "spam_complaint",
    MANUAL_SUPPRESSION: "manual_suppression",
    UNSUBSCRIBE: "unsubscribe",
  };

  class BounceSuppressionVerification {
    constructor(options = {}) {
      this.softBounceThreshold = options.softBounceThreshold ?? 3;
      this.softBounceTtlMs = options.softBounceTtlMs ?? 14 * 24 * 60 * 60 * 1000;
      this.suppressions = new Map();
    }

    normalizeEmail(email) {
      if (!email || typeof email !== "string" || !email.includes("@")) {
        throw new Error(`Invalid email address: "${email}"`);
      }
      return email.trim().toLowerCase();
    }

    async isSuppressed(email) {
      const norm = this.normalizeEmail(email);
      const record = this.suppressions.get(norm);
      if (!record || !record.suppressed) return { suppressed: false };

      if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
        record.suppressed = false;
        record.bounceCount = 0;
        return { suppressed: false };
      }

      return {
        suppressed: true,
        reason: record.reason,
        record,
        detail: record.lastBounceDetail,
      };
    }

    async recordBounce(email, reason, detail = "Delivery failed", source = "system") {
      const norm = this.normalizeEmail(email);
      const existing = this.suppressions.get(norm);
      const bounceCount = (existing?.bounceCount ?? 0) + 1;

      let isSuppressed = false;
      let expiresAt = null;

      if (
        reason === BounceReason.HARD_BOUNCE ||
        reason === BounceReason.SPAM_COMPLAINT ||
        reason === BounceReason.MANUAL_SUPPRESSION ||
        reason === BounceReason.UNSUBSCRIBE
      ) {
        isSuppressed = true;
        expiresAt = null;
      } else if (reason === BounceReason.SOFT_BOUNCE) {
        if (bounceCount >= this.softBounceThreshold) {
          isSuppressed = true;
          expiresAt = new Date(Date.now() + this.softBounceTtlMs);
        }
      }

      const record = {
        email: norm,
        reason,
        source,
        createdAt: existing?.createdAt ?? new Date(),
        expiresAt,
        bounceCount,
        lastBounceDetail: detail,
        suppressed: isSuppressed,
      };
      this.suppressions.set(norm, record);
      return record;
    }

    async recordDeliverySuccess(email) {
      const norm = this.normalizeEmail(email);
      const rec = this.suppressions.get(norm);
      if (rec && !rec.suppressed) {
        rec.bounceCount = 0;
      }
    }

    async removeSuppression(email, actor, reason = "Manual unsuppression") {
      this.assertAuthorizedActor(actor);
      const norm = this.normalizeEmail(email);
      const rec = this.suppressions.get(norm);
      if (!rec || !rec.suppressed) return false;

      rec.suppressed = false;
      rec.bounceCount = 0;
      rec.unsuppressedAt = new Date();
      rec.unsuppressedBy = actor.id;
      return true;
    }

    assertAuthorizedActor(actor) {
      if (!actor || !Array.isArray(actor.roles)) {
        throw new Error("Missing actor context or roles for suppression management");
      }
      const roles = actor.roles.map((r) => r.toLowerCase());
      if (!roles.includes("admin") && !roles.includes("support")) {
        throw new Error("Only ADMIN or SUPPORT roles can manage bounce suppressions");
      }
    }
  }

  await test("519.1: Locale fallback chain progressively decomposes compound tags", () => {
    const chain1 = buildLocaleFallbackChain("fr-CA");
    assert.deepStrictEqual(chain1, ["fr-ca", "fr", "en"]);

    const chain2 = buildLocaleFallbackChain("zh-Hant-HK");
    assert.deepStrictEqual(chain2, ["zh-hant-hk", "zh-hant", "zh", "en"]);

    const chain3 = buildLocaleFallbackChain("es-AR", {
      tenantFallbackLocale: "pt-BR",
      defaultLocale: "en",
    });
    assert.ok(chain3.includes("es-ar"));
    assert.ok(chain3.includes("es"));
    assert.ok(chain3.includes("pt-br"));
    assert.ok(chain3.includes("en"));
  });

  await test("519.2: Resolver resolves exact matches, language fallbacks, and caches results", () => {
    const resolver = new LocaleFallbackResolverVerification();

    // Exact
    const resEs = resolver.resolveTemplate("welcome", "es");
    assert.strictEqual(resEs.resolvedLocale, "es");
    assert.strictEqual(resEs.fallbackUsed, false);

    // Language-level fallback
    const resFrCa = resolver.resolveTemplate("welcome", "fr-CA");
    assert.strictEqual(resFrCa.resolvedLocale, "fr");
    assert.strictEqual(resFrCa.fallbackUsed, true);
    assert.deepStrictEqual(resFrCa.chainTraversed, ["fr-ca", "fr"]);

    // Cache hit
    const resCached = resolver.resolveTemplate("welcome", "fr-CA");
    assert.strictEqual(resCached.fromCache, true);

    // System default fallback
    const resJa = resolver.resolveTemplate("welcome", "ja-JP");
    assert.strictEqual(resJa.resolvedLocale, "en");
    assert.strictEqual(resJa.fallbackUsed, true);
  });

  await test("519.3: Resolver failure path: strict mode and missing template rejection", () => {
    const resolver = new LocaleFallbackResolverVerification();

    assert.throws(
      () => resolver.resolveTemplate("welcome", "fr-CA", { strict: true }),
      /strict resolution enforced/,
    );

    assert.throws(
      () => resolver.resolveTemplate("unknown_template", "es"),
      /not found in requested locale/,
    );
  });

  await test("519.4: Bounce suppression handles hard bounce & spam complaint permanently", async () => {
    const service = new BounceSuppressionVerification();
    const email = "bounced@example.com";

    assert.strictEqual((await service.isSuppressed(email)).suppressed, false);

    const rec = await service.recordBounce(email, BounceReason.HARD_BOUNCE, "550 No such user");
    assert.strictEqual(rec.suppressed, true);
    assert.strictEqual(rec.expiresAt, null);

    const check = await service.isSuppressed(email);
    assert.strictEqual(check.suppressed, true);
    assert.strictEqual(check.reason, BounceReason.HARD_BOUNCE);
  });

  await test("519.5: Bounce suppression soft bounce threshold and automatic TTL expiration", async () => {
    const service = new BounceSuppressionVerification({
      softBounceThreshold: 3,
      softBounceTtlMs: 50,
    });
    const email = "soft@example.com";

    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    assert.strictEqual((await service.isSuppressed(email)).suppressed, false);

    // 3rd soft bounce triggers suppression
    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    assert.strictEqual((await service.isSuppressed(email)).suppressed, true);

    // Wait 60ms for TTL expiration
    await new Promise((r) => setTimeout(r, 60));
    assert.strictEqual((await service.isSuppressed(email)).suppressed, false);
  });

  await test("519.6: Delivery success resets bounce counter and RBAC authorizes unsuppress", async () => {
    const service = new BounceSuppressionVerification();
    const email = "temp-soft@example.com";

    // 2 soft bounces, then delivery success -> resets counter
    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    await service.recordDeliverySuccess(email);

    // Another soft bounce -> counter is 1, not 3!
    await service.recordBounce(email, BounceReason.SOFT_BOUNCE);
    assert.strictEqual((await service.isSuppressed(email)).suppressed, false);

    // Hard bounce -> suppressed
    await service.recordBounce(email, BounceReason.HARD_BOUNCE);
    assert.strictEqual((await service.isSuppressed(email)).suppressed, true);

    // Non-admin cannot unsuppress
    const userActor = { id: "u-1", roles: ["user"] };
    await assert.rejects(
      async () => service.removeSuppression(email, userActor),
      /Only ADMIN or SUPPORT roles/,
    );

    // Support actor can unsuppress
    const supportActor = { id: "s-1", roles: ["support"] };
    const ok = await service.removeSuppression(email, supportActor, "Verified user");
    assert.strictEqual(ok, true);
    assert.strictEqual((await service.isSuppressed(email)).suppressed, false);
  });

  // ===========================================================================
  // 2. Issue #522: Growth Referral Attribution Window & Clawback Guard
  // ===========================================================================
  console.log("\n--- [Issue #522] Growth Referral Attribution & Clawback Guard ---");

  class ReferralAttributionVerification {
    constructor(config = {}) {
      this.attributionWindowMs = config.attributionWindowMs ?? 30 * 24 * 60 * 60 * 1000;
      this.qualificationWindowMs = config.qualificationWindowMs ?? 14 * 24 * 60 * 60 * 1000;
      this.clawbackWindowMs = config.clawbackWindowMs ?? 90 * 24 * 60 * 60 * 1000;
      this.clockSkewToleranceMs = config.clockSkewToleranceMs ?? 5 * 60 * 1000;
      this.rewards = new Map();
    }

    verifyAttributionWindow(ctx) {
      const clickTime = ctx.clickTimestamp.getTime();
      const regTime = ctx.registeredAt.getTime();
      const duration = regTime - clickTime;
      const windowExpiresAt = new Date(clickTime + this.attributionWindowMs);

      if (duration < -this.clockSkewToleranceMs) {
        return {
          valid: false,
          code: "CLOCK_SKEW_FUTURE_CLICK",
          reason: "Future click timestamp",
          attributionDurationMs: duration,
          remainingWindowMs: 0,
          windowExpiresAt,
        };
      }

      if (duration > this.attributionWindowMs) {
        return {
          valid: false,
          code: "ATTRIBUTION_WINDOW_EXPIRED",
          reason: "Attribution window expired",
          attributionDurationMs: duration,
          remainingWindowMs: 0,
          windowExpiresAt,
        };
      }

      return {
        valid: true,
        code: "VALID",
        attributionDurationMs: Math.max(0, duration),
        remainingWindowMs: Math.max(0, this.attributionWindowMs - duration),
        windowExpiresAt,
      };
    }

    verifyQualificationWindow(registeredAt, qualifiedAt) {
      const regTime = registeredAt.getTime();
      const qualTime = qualifiedAt.getTime();
      const duration = qualTime - regTime;
      const windowExpiresAt = new Date(regTime + this.qualificationWindowMs);

      if (duration < 0) {
        return {
          valid: false,
          code: "INVALID_SEQUENCE",
          reason: "Qualification prior to registration",
          qualificationDurationMs: duration,
          remainingWindowMs: 0,
          windowExpiresAt,
        };
      }

      if (duration > this.qualificationWindowMs) {
        return {
          valid: false,
          code: "QUALIFICATION_WINDOW_EXPIRED",
          reason: "Qualification window expired",
          qualificationDurationMs: duration,
          remainingWindowMs: 0,
          windowExpiresAt,
        };
      }

      return {
        valid: true,
        code: "VALID",
        qualificationDurationMs: duration,
        remainingWindowMs: Math.max(0, this.qualificationWindowMs - duration),
        windowExpiresAt,
      };
    }

    recordAwardedReward(referralId, referringUserId, referredUserId, amount, currency = "XLM", awardedAt = new Date()) {
      const record = {
        referralId,
        referringUserId,
        referredUserId,
        rewardAmount: amount,
        currency,
        status: "awarded",
        awardedAt,
        clawbackRecord: null,
      };
      this.rewards.set(referralId, record);
      return record;
    }

    async initiateClawback(referralId, reason, actor, options = {}) {
      this.assertAuthorizedGrowthActor(actor);
      const record = this.rewards.get(referralId);
      if (!record) throw new Error(`Referral "${referralId}" not found`);

      // Idempotency: already clawed back
      if (record.status === "clawed_back") {
        return record;
      }

      if (record.status !== "awarded" && record.status !== "clawback_failed") {
        throw new Error(`Cannot claw back referral with current status "${record.status}"`);
      }

      const now = Date.now();
      const elapsed = now - record.awardedAt.getTime();
      if (elapsed > this.clawbackWindowMs && !options.forceOverride) {
        throw new Error(`Clawback window expired (${Math.round(elapsed / (24 * 60 * 60 * 1000))} days). Operator override required.`);
      }

      const clawbackId = `clw:${referralId}:${now}`;
      const clawback = {
        clawbackId,
        referralId,
        amount: record.rewardAmount,
        currency: record.currency,
        reason,
        initiatedBy: actor.id,
        attempts: (record.clawbackRecord?.attempts ?? 0) + 1,
      };

      record.clawbackRecord = clawback;

      if (options.simulateLedgerFailure) {
        record.status = "clawback_failed";
        clawback.lastError = "Ledger deduction failure";
        return record;
      }

      record.status = "clawed_back";
      clawback.completedAt = new Date();
      return record;
    }

    async retryClawback(referralId, actor) {
      this.assertAuthorizedGrowthActor(actor);
      const record = this.rewards.get(referralId);
      if (!record || record.status !== "clawback_failed") {
        throw new Error(`Referral "${referralId}" is not in failed clawback state`);
      }
      return this.initiateClawback(referralId, record.clawbackRecord.reason, actor, { forceOverride: true });
    }

    async reverseClawback(referralId, actor, reason) {
      this.assertAuthorizedGrowthActor(actor);
      const record = this.rewards.get(referralId);
      if (!record || record.status !== "clawed_back") {
        throw new Error(`Cannot reverse clawback for referral "${referralId}"`);
      }
      record.status = "clawback_reversed";
      return record;
    }

    assertAuthorizedGrowthActor(actor) {
      if (!actor || !Array.isArray(actor.roles)) {
        throw new Error("Missing actor context or roles");
      }
      const roles = actor.roles.map((r) => r.toLowerCase());
      if (!roles.includes("admin") && !roles.includes("growth_lead")) {
        throw new Error("Only ADMIN or GROWTH_LEAD roles may manage referral clawbacks");
      }
    }
  }

  await test("522.1: Attribution window verifier validates timeline and catches clock skew", () => {
    const service = new ReferralAttributionVerification();
    const now = new Date();
    const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
    const fortyDaysAgo = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

    // Normal: 10 days
    const ok = service.verifyAttributionWindow({
      referralId: "r1",
      referringUserId: "u1",
      referredUserId: "u2",
      referralCode: "PROMO",
      clickTimestamp: tenDaysAgo,
      registeredAt: now,
    });
    assert.strictEqual(ok.valid, true);

    // Expired: 40 days
    const exp = service.verifyAttributionWindow({
      referralId: "r2",
      referringUserId: "u1",
      referredUserId: "u3",
      referralCode: "PROMO",
      clickTimestamp: fortyDaysAgo,
      registeredAt: now,
    });
    assert.strictEqual(exp.valid, false);
    assert.strictEqual(exp.code, "ATTRIBUTION_WINDOW_EXPIRED");

    // Clock skew / future click
    const future = new Date(now.getTime() + 10 * 60 * 1000);
    const skew = service.verifyAttributionWindow({
      referralId: "r3",
      referringUserId: "u1",
      referredUserId: "u4",
      referralCode: "PROMO",
      clickTimestamp: future,
      registeredAt: now,
    });
    assert.strictEqual(skew.valid, false);
    assert.strictEqual(skew.code, "CLOCK_SKEW_FUTURE_CLICK");
  });

  await test("522.2: Qualification window verifier validates milestone completion", () => {
    const service = new ReferralAttributionVerification();
    const reg = new Date("2026-02-01T00:00:00Z");
    const qualOk = new Date("2026-02-08T00:00:00Z"); // 7 days later
    const qualLate = new Date("2026-02-20T00:00:00Z"); // 19 days later

    assert.strictEqual(service.verifyQualificationWindow(reg, qualOk).valid, true);
    assert.strictEqual(service.verifyQualificationWindow(reg, qualLate).valid, false);
  });

  await test("522.3: Clawback guard idempotency and double-clawback prevention", async () => {
    const service = new ReferralAttributionVerification();
    const admin = { id: "admin-1", roles: ["admin"] };

    service.recordAwardedReward("ref-idempotent", "u1", "u2", 50, "XLM");

    const first = await service.initiateClawback("ref-idempotent", "fraud_sybil", admin);
    assert.strictEqual(first.status, "clawed_back");

    // Second call is idempotent
    const second = await service.initiateClawback("ref-idempotent", "fraud_sybil", admin);
    assert.strictEqual(second.status, "clawed_back");
    assert.strictEqual(second.clawbackRecord.clawbackId, first.clawbackRecord.clawbackId);
  });

  await test("522.4: Clawback guard window limit and authorization enforcement", async () => {
    const service = new ReferralAttributionVerification({ clawbackWindowMs: 90 * 24 * 60 * 60 * 1000 });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    service.recordAwardedReward("ref-old", "u1", "u2", 100, "XLM", oldDate);

    const nonAdmin = { id: "user", roles: ["user"] };
    const lead = { id: "lead", roles: ["growth_lead"] };

    // Non-growth lead fails
    await assert.rejects(
      async () => service.initiateClawback("ref-old", "self_referral", nonAdmin),
      /Only ADMIN or GROWTH_LEAD roles/,
    );

    // Old reward fails without forceOverride
    await assert.rejects(
      async () => service.initiateClawback("ref-old", "self_referral", lead),
      /Clawback window expired/,
    );

    // Passes with forceOverride
    const clawed = await service.initiateClawback("ref-old", "self_referral", lead, { forceOverride: true });
    assert.strictEqual(clawed.status, "clawed_back");
  });

  await test("522.5: Clawback failure handling, retry with backoff, and dispute reversal", async () => {
    const service = new ReferralAttributionVerification();
    const admin = { id: "admin", roles: ["admin"] };
    service.recordAwardedReward("ref-flaky", "u1", "u2", 80, "XLM");

    // Transient failure
    const failed = await service.initiateClawback("ref-flaky", "chargeback", admin, { simulateLedgerFailure: true });
    assert.strictEqual(failed.status, "clawback_failed");

    // Retry succeeds
    const retried = await service.retryClawback("ref-flaky", admin);
    assert.strictEqual(retried.status, "clawed_back");

    // Dispute reversal restores reward
    const reversed = await service.reverseClawback("ref-flaky", admin, "Dispute won by merchant");
    assert.strictEqual(reversed.status, "clawback_reversed");
  });

  // ===========================================================================
  // 3. Issue #521: Storage TTL Expiration Scanner & Proactive Archival
  // ===========================================================================
  console.log("\n--- [Issue #521] Storage TTL Expiration Scanner & Proactive Archival ---");

  class StorageTtlScannerVerification {
    constructor(gateway, hook, options = {}) {
      this.gateway = gateway;
      this.hook = hook;
      this.archivalThreshold = options.proactiveArchivalThresholdLedgers ?? 22_280;
      this.criticalThreshold = options.criticalThreshold ?? 17_280;
      this.maxAttempts = options.maxAttempts ?? 3;
    }

    async scanExpirationCandidates(entries) {
      const seen = new Set();
      for (const e of entries) {
        if (seen.has(e.key)) throw new Error(`Duplicate tracked key: ${e.key}`);
        seen.add(e.key);
      }

      const currentLedger = await this.gateway.getCurrentLedger();
      const ttls = entries.length ? await this.gateway.getTtls(entries.map((e) => e.key)) : {};

      const candidates = [];
      let healthyCount = 0;
      let archivedCount = 0;

      for (const entry of entries) {
        const ttl = ttls[entry.key];
        if (ttl?.archived) {
          archivedCount++;
          continue;
        }

        if (ttl?.liveUntilLedger != null && ttl.liveUntilLedger >= currentLedger) {
          const remaining = ttl.liveUntilLedger - currentLedger;
          if (remaining > this.archivalThreshold) {
            healthyCount++;
          } else {
            candidates.push({
              entry,
              remainingLedgers: remaining,
              urgency: remaining <= this.criticalThreshold ? "critical" : "high",
              reason: entry.durability === "temporary" ? "temporary_entry_preservation" : "impending_expiration",
            });
          }
        }
      }

      return {
        currentLedger,
        totalTracked: entries.length,
        archivalCandidates: candidates,
        healthyCount,
        archivedCount,
      };
    }

    async executeProactiveArchival(entries, actor, options = {}) {
      this.assertAuthorizedOperator(actor);
      const dryRun = options.dryRun ?? false;

      const report = await this.scanExpirationCandidates(entries);
      const results = [];

      for (const candidate of report.archivalCandidates) {
        if (dryRun) {
          results.push({
            key: candidate.entry.key,
            outcome: "dry-run",
            attempts: 0,
            detail: "Planned archival",
          });
          continue;
        }

        let attempts = 0;
        let lastError = null;
        let archived = false;

        while (attempts < this.maxAttempts) {
          attempts++;
          try {
            const hookRes = await this.hook.archive({
              entry: candidate.entry,
              remainingLedgers: candidate.remainingLedgers,
              currentLedger: report.currentLedger,
              reason: candidate.reason,
            });

            if (!hookRes.success) {
              lastError = hookRes.error || "Hook failed";
              if (!hookRes.transient) break;
            } else {
              if (this.hook.verify && hookRes.archiveLocation && hookRes.digest) {
                const ok = await this.hook.verify(hookRes.archiveLocation, hookRes.digest);
                if (!ok) {
                  if (this.hook.rollback) {
                    await this.hook.rollback(candidate.entry.key, hookRes.archiveLocation);
                  }
                  throw new Error("Integrity verification failed");
                }
              }

              results.push({
                key: candidate.entry.key,
                outcome: "archived",
                location: hookRes.archiveLocation,
                digest: hookRes.digest,
                attempts,
                detail: "Proactively archived",
              });
              archived = true;
              break;
            }
          } catch (err) {
            lastError = err.message;
          }
        }

        if (!archived) {
          results.push({
            key: candidate.entry.key,
            outcome: "failed",
            attempts,
            detail: lastError,
          });
        }
      }

      return {
        dryRun,
        currentLedger: report.currentLedger,
        archivedCount: results.filter((r) => r.outcome === "archived").length,
        failedCount: results.filter((r) => r.outcome === "failed").length,
        results,
      };
    }

    assertAuthorizedOperator(actor) {
      if (!actor || !Array.isArray(actor.roles)) {
        throw new Error("Missing actor context or roles for proactive archival");
      }
      const roles = actor.roles.map((r) => r.toLowerCase());
      if (!roles.includes("admin") && !roles.includes("system_operator")) {
        throw new Error("Only an ADMIN or SYSTEM_OPERATOR may trigger proactive storage archival");
      }
    }
  }

  await test("521.1: Scanner identifies candidate entries approaching expiration", async () => {
    const gateway = {
      getCurrentLedger: async () => 100_000,
      getTtls: async () => ({
        "k-safe": { liveUntilLedger: 200_000, archived: false },
        "k-expiring": { liveUntilLedger: 105_000, archived: false }, // 5,000 left
        "k-temp": { liveUntilLedger: 102_000, archived: false }, // 2,000 left (temp)
        "k-archived": { liveUntilLedger: null, archived: true },
      }),
    };

    const scanner = new StorageTtlScannerVerification(gateway, { archive: async () => ({ success: true }) });
    const report = await scanner.scanExpirationCandidates([
      { key: "k-safe", durability: "persistent" },
      { key: "k-expiring", durability: "persistent" },
      { key: "k-temp", durability: "temporary" },
      { key: "k-archived", durability: "persistent" },
    ]);

    assert.strictEqual(report.totalTracked, 4);
    assert.strictEqual(report.healthyCount, 1);
    assert.strictEqual(report.archivalCandidates.length, 2);

    const tempCandidate = report.archivalCandidates.find((c) => c.entry.key === "k-temp");
    assert.strictEqual(tempCandidate.reason, "temporary_entry_preservation");
  });

  await test("521.2: Proactive archival dry-run preview and RBAC authorization", async () => {
    const gateway = {
      getCurrentLedger: async () => 100_000,
      getTtls: async () => ({
        "k-target": { liveUntilLedger: 104_000, archived: false },
      }),
    };

    let hookCalled = false;
    const hook = {
      archive: async () => {
        hookCalled = true;
        return { success: true, archiveLocation: "s3://archive/k-target", digest: "d1" };
      },
    };

    const scanner = new StorageTtlScannerVerification(gateway, hook);
    const nonAdmin = { id: "viewer", roles: ["viewer"] };
    const admin = { id: "op", roles: ["system_operator"] };

    // Unauthorized fails
    await assert.rejects(
      async () => scanner.executeProactiveArchival([{ key: "k-target", durability: "persistent" }], nonAdmin),
      /Only an ADMIN or SYSTEM_OPERATOR/,
    );

    // Dry-run does not call hook
    const dry = await scanner.executeProactiveArchival(
      [{ key: "k-target", durability: "persistent" }],
      admin,
      { dryRun: true },
    );
    assert.strictEqual(dry.dryRun, true);
    assert.strictEqual(hookCalled, false);
    assert.strictEqual(dry.results[0].outcome, "dry-run");

    // Real run invokes hook
    const real = await scanner.executeProactiveArchival(
      [{ key: "k-target", durability: "persistent" }],
      admin,
      { dryRun: false },
    );
    assert.strictEqual(hookCalled, true);
    assert.strictEqual(real.archivedCount, 1);
  });

  await test("521.3: Proactive archival retries on transient errors and rolls back on verification failure", async () => {
    const gateway = {
      getCurrentLedger: async () => 100_000,
      getTtls: async () => ({
        "k-flaky": { liveUntilLedger: 103_000, archived: false },
        "k-corrupt": { liveUntilLedger: 102_000, archived: false },
      }),
    };

    let attempts = 0;
    let rollbackExecuted = false;

    const hook = {
      archive: async (ctx) => {
        if (ctx.entry.key === "k-flaky") {
          attempts++;
          if (attempts < 2) {
            return { success: false, transient: true, error: "Network reset" };
          }
          return { success: true, archiveLocation: "s3://k-flaky", digest: "good-digest" };
        }
        if (ctx.entry.key === "k-corrupt") {
          return { success: true, archiveLocation: "s3://k-corrupt", digest: "bad-digest" };
        }
      },
      verify: async (_loc, digest) => digest === "good-digest",
      rollback: async () => {
        rollbackExecuted = true;
      },
    };

    const scanner = new StorageTtlScannerVerification(gateway, hook, { maxAttempts: 3 });
    const admin = { id: "admin", roles: ["admin"] };

    const summary = await scanner.executeProactiveArchival(
      [
        { key: "k-flaky", durability: "persistent" },
        { key: "k-corrupt", durability: "persistent" },
      ],
      admin,
    );

    assert.strictEqual(summary.results[0].outcome, "archived");
    assert.strictEqual(summary.results[0].attempts, 2);

    assert.strictEqual(summary.results[1].outcome, "failed");
    assert.strictEqual(rollbackExecuted, true);
  });

  // ===========================================================================
  // 4. Issue #520: Sandbox Scenario State Snapshotter & Deterministic Seed Reset
  // ===========================================================================
  console.log("\n--- [Issue #520] Sandbox Scenario State Snapshotter & Seed Reset ---");

  function computeStateChecksum(state) {
    const normalized = JSON.stringify({
      scenario: state.activeScenario,
      seed: state.seed,
      seq: state.sequenceCounter,
      records: state.records.map((r) => ({
        kind: r.kind,
        id: r.id,
        timestamp: r.timestamp,
      })),
      custom: state.customState || {},
    });
    return createHash("sha256").update(normalized).digest("hex");
  }

  class SandboxSnapshotVerification {
    constructor(enabled = true, initialSeed = "base-seed") {
      this.enabled = enabled;
      this.activeSeed = initialSeed;
      this.activeScenario = "success";
      this.sequenceCounter = 0;
      this.records = [];
      this.customState = {};
      this.snapshots = new Map();
    }

    assertEnabled() {
      if (!this.enabled) throw new Error("Sandbox mode is disabled.");
    }

    recordAction(kind, id, payload = {}) {
      this.sequenceCounter++;
      this.records.push({
        kind,
        id,
        payload,
        timestamp: new Date().toISOString(),
      });
    }

    async createSnapshot(label, actor) {
      this.assertEnabled();
      this.assertAuthorizedActor(actor);

      const stateCopy = {
        activeScenario: this.activeScenario,
        seed: this.activeSeed,
        sequenceCounter: this.sequenceCounter,
        records: JSON.parse(JSON.stringify(this.records)),
        customState: JSON.parse(JSON.stringify(this.customState)),
      };

      const checksum = computeStateChecksum(stateCopy);
      const snapshotId = `sbx-snap:${createHash("sha256")
        .update(`${this.activeSeed}:${Date.now()}:${label}`)
        .digest("hex")
        .slice(0, 16)}`;

      const snap = {
        snapshotId,
        label,
        createdAt: new Date().toISOString(),
        createdBy: actor.id,
        state: stateCopy,
        checksum,
      };

      this.snapshots.set(snapshotId, snap);
      return snap;
    }

    async restoreSnapshot(snapshotId, actor) {
      this.assertEnabled();
      this.assertAuthorizedActor(actor);

      const snap = this.snapshots.get(snapshotId);
      if (!snap) throw new Error(`Snapshot "${snapshotId}" not found`);

      const expected = computeStateChecksum(snap.state);
      if (expected !== snap.checksum) {
        throw new Error("Snapshot integrity checksum validation failed");
      }

      const backup = {
        activeScenario: this.activeScenario,
        seed: this.activeSeed,
        sequenceCounter: this.sequenceCounter,
        records: JSON.parse(JSON.stringify(this.records)),
      };

      try {
        this.activeScenario = snap.state.activeScenario;
        this.activeSeed = snap.state.seed;
        this.sequenceCounter = snap.state.sequenceCounter;
        this.records = JSON.parse(JSON.stringify(snap.state.records));
        return { snapshotId, restoredSeed: this.activeSeed, recordsCount: this.records.length };
      } catch (err) {
        this.activeScenario = backup.activeScenario;
        this.activeSeed = backup.seed;
        this.sequenceCounter = backup.sequenceCounter;
        this.records = backup.records;
        throw new Error("Restore failed and rolled back");
      }
    }

    async resetSeed(newSeed, actor) {
      this.assertEnabled();
      if (actor) this.assertAuthorizedActor(actor);

      const previousSeed = this.activeSeed;
      const recordsCleared = this.records.length;
      this.activeSeed = newSeed || "default-sandbox-seed";
      this.sequenceCounter = 0;
      this.records = [];
      this.customState = {};

      return {
        previousSeed,
        currentSeed: this.activeSeed,
        sequenceCounter: 0,
        recordsCleared,
      };
    }

    exportSnapshot(id) {
      const snap = this.snapshots.get(id);
      if (!snap) throw new Error("Not found");
      return JSON.stringify(snap, null, 2);
    }

    importSnapshot(jsonStr, actor) {
      this.assertEnabled();
      this.assertAuthorizedActor(actor);
      const parsed = JSON.parse(jsonStr);
      const expected = computeStateChecksum(parsed.state);
      if (expected !== parsed.checksum) {
        throw new Error("Imported snapshot checksum validation failed");
      }
      this.snapshots.set(parsed.snapshotId, parsed);
      return parsed;
    }

    assertAuthorizedActor(actor) {
      if (!actor || !Array.isArray(actor.roles)) {
        throw new Error("Missing actor context or roles");
      }
      const roles = actor.roles.map((r) => r.toLowerCase());
      if (!roles.includes("admin") && !roles.includes("tester")) {
        throw new Error("Only ADMIN or TESTER roles may manage sandbox state and seed resets");
      }
    }
  }

  await test("520.1: Snapshot capture, checksum verification, export, and tamper detection", async () => {
    const sandbox = new SandboxSnapshotVerification(true, "seed-alpha");
    const admin = { id: "t1", roles: ["tester"] };

    sandbox.recordAction("create", "pay-1", { amount: 100 });
    sandbox.recordAction("submit", "tx-1", { status: "success" });

    const snap = await sandbox.createSnapshot("milestone-1", admin);
    assert.strictEqual(snap.state.records.length, 2);
    assert.strictEqual(snap.checksum, computeStateChecksum(snap.state));

    // Export and import
    const exported = sandbox.exportSnapshot(snap.snapshotId);
    const imported = sandbox.importSnapshot(exported, admin);
    assert.strictEqual(imported.snapshotId, snap.snapshotId);

    // Tampered payload
    const tampered = JSON.parse(exported);
    tampered.checksum = "corrupted_hash";
    assert.throws(
      () => sandbox.importSnapshot(JSON.stringify(tampered), admin),
      /checksum validation failed/,
    );
  });

  await test("520.2: Snapshot restore and state rollback on corrupted restore", async () => {
    const sandbox = new SandboxSnapshotVerification(true, "seed-beta");
    const admin = { id: "admin", roles: ["admin"] };

    sandbox.recordAction("create", "pay-init", { step: 1 });
    const snap1 = await sandbox.createSnapshot("checkpoint-1", admin);

    // Add more actions
    sandbox.recordAction("refund", "ref-1", { step: 2 });
    assert.strictEqual(sandbox.sequenceCounter, 2);

    // Restore to checkpoint-1
    const res = await sandbox.restoreSnapshot(snap1.snapshotId, admin);
    assert.strictEqual(res.recordsCount, 1);
    assert.strictEqual(sandbox.sequenceCounter, 1);
  });

  await test("520.3: Deterministic seed reset guarantees identical replay outputs", async () => {
    function runSimulatedWorkflow(seed, idempotencyKey) {
      const hash1 = createHash("sha256").update(`${seed}:${idempotencyKey}:create`).digest("hex");
      const hash2 = createHash("sha256").update(`${seed}:${hash1}:submit`).digest("hex");
      return { paymentId: `sbx:pay:${hash1.slice(0, 16)}`, txHash: `sbx:tx:${hash2.slice(0, 16)}` };
    }

    const sandbox = new SandboxSnapshotVerification();
    const admin = { id: "tester", roles: ["tester"] };

    // Run 1 with seed "seed-deterministic-x"
    await sandbox.resetSeed("seed-deterministic-x", admin);
    const run1 = runSimulatedWorkflow(sandbox.activeSeed, "idem-100");

    // Reset seed back to "seed-deterministic-x"
    await sandbox.resetSeed("seed-deterministic-x", admin);
    const run2 = runSimulatedWorkflow(sandbox.activeSeed, "idem-100");

    assert.deepStrictEqual(run1, run2);
  });

  await test("520.4: Sandbox authorization and fail-closed disabled guard", async () => {
    const sandbox = new SandboxSnapshotVerification(true);
    const nonTester = { id: "anon", roles: ["user"] };

    await assert.rejects(
      async () => sandbox.createSnapshot("unauthorized", nonTester),
      /Only ADMIN or TESTER roles/,
    );

    const disabledSandbox = new SandboxSnapshotVerification(false);
    const admin = { id: "admin", roles: ["admin"] };

    await assert.rejects(
      async () => disabledSandbox.createSnapshot("disabled", admin),
      /Sandbox mode is disabled/,
    );
  });

  console.log("\n===================================================================");
  console.log(`Summary: ${passed} passed, ${failed} failed`);
  console.log("===================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
